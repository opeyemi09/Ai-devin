// src/orchestrator/loop.js
const Planner = require("../agents/planner");
const Coder = require("../agents/coder");
const Executor = require("../agents/executor");
const Reviewer = require("../agents/reviewer");
const GithubAgent = require("../agents/githubAgent");
const DocAgent = require("../agents/docAgent");
const mongo = require("../db/mongo");
const { log, err } = require("../utils/logger");
const { notifySlack, notifyEmail } = require("../utils/notifier");
const { broadcast } = require("../realtime/wsServer");
const { complete } = require("../utils/llm");

/**
 * orchestrator(taskId) - retrieves the task from Mongo, runs pipeline,
 * and stores step outputs back to Mongo (append-only steps array).
 * This version broadcasts step events over WebSocket and notifies on failures.
 */
async function orchestrator(taskId) {
  const task = await mongo.findTaskById(taskId);
  if (!task) throw new Error("task not found " + taskId);

  const taskUpdate = async (fields) => {
    return mongo.updateTask(taskId, fields);
  };

  const pushStep = async (name, result) => {
    const step = {
      name,
      timestamp: new Date(),
      success: !!result?.success,
      output: result?.output || "",
      metadata: result?.metadata || {}
    };
    const updated = await mongo.pushTaskStep(taskId, step);
    // broadcast to realtime clients
    try {
      broadcast({ type: "task.step", taskId, step });
    } catch (e) {
      log("broadcast failed", e.message || e);
    }
    return updated;
  };

  // helper: notify on failure (Slack + email)
  async function notifyOnFailure(taskDoc, stepName, result, findings) {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    const adminEmail = process.env.ADMIN_EMAIL;
    const smtp = process.env.SMTP_HOST ? {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: (process.env.SMTP_SECURE === "true"),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    } : null;

    const shortId = (taskDoc._id && (taskDoc._id.$oid || taskDoc._id.toString())) || taskId;
    const msg = `Task ${shortId} failed at step ${stepName}\n\nOutput:\n${result.output || "(no output)"}\n\nMetadata:\n${JSON.stringify(result.metadata || {}, null, 2)}\n\nWorkspace: ${taskDoc.workspace}\n\nPlease inspect the task.`;
    try {
      if (slackWebhook) await notifySlack(slackWebhook, msg, findings);
      if (smtp && adminEmail) await notifyEmail(smtp, adminEmail, `AI Devin: Task ${shortId} failed`, msg, findings);
    } catch (e) {
      log("notifyOnFailure error", e);
    }
  }

  // optional LLM diagnostic: produce quick suggestions based on stderr/excerpt
  async function llmDiagnosticIfPossible(taskDoc, stepName, result) {
    try {
      if (result?.metadata?.summary?.excerpt) {
        const excerpt = result.metadata.summary.excerpt.slice(0, 1500);
        const prompt = `You are a debugging assistant. Given the following failing test output or stack trace, give: 1) likely root cause in one sentence, 2) three debugging steps, 3) a suggested code change or hint (if obvious). Output as a short bullet list.\n\n${excerpt}`;
        const resp = await complete(prompt, { maxTokens: 300 });
        const text = resp.text || "";
        await pushStep("llm_diagnostic", { success: true, output: text, metadata: { raw: resp.raw } });
      }
    } catch (e) {
      log("llmDiagnostic failed", e);
    }
  }

  try {
    await taskUpdate({ status: "running", startedAt: new Date() });

    // 1) Planner
    const planner = new Planner();
    const planRes = await planner.run(task);
    await pushStep("planner", planRes);
    if (!planRes.success) {
      await taskUpdate({ status: "failed", finishedAt: new Date(), lastError: "planner failed" });
      await notifyOnFailure(task, "planner", planRes);
      return { success: false, step: "planner", result: planRes };
    }

    // 2) Coder
    const coder = new Coder();
    const coderRes = await coder.run(task);
    await pushStep("coder", coderRes);
    if (!coderRes.success) {
      await taskUpdate({ status: "failed", finishedAt: new Date(), lastError: "coder failed" });
      await notifyOnFailure(task, "coder", coderRes);
      return { success: false, step: "coder", result: coderRes };
    }

    // 2b) DocAgent - add comments & docs (optional)
    const docAgent = new DocAgent();
    const docRes = await docAgent.run(task);
    await pushStep("docgen", docRes);
    if (!docRes.success) {
      await pushStep("docgen-failure", { success: false, output: docRes.output || "docgen failed" });
    }

    // 3) Execute (tests)
    const executor = new Executor();
    const execRes = await executor.run(task);
    await pushStep("executor", execRes);
    if (!execRes.success) {
      await taskUpdate({ status: "needs-review", finishedAt: new Date(), lastError: "tests failed" });
      // run LLM diagnosis and notify
      await llmDiagnosticIfPossible(task, "executor", execRes);
      await notifyOnFailure(task, "executor", execRes);
      return { success: false, step: "executor", result: execRes };
    }

    // 4) Reviewer
    const reviewer = new Reviewer();
    const reviewRes = await reviewer.run(task);
    await pushStep("reviewer", reviewRes);
    if (!reviewRes.success) {
      await taskUpdate({ status: "needs-review", finishedAt: new Date(), lastError: "reviewer found issues" });
      await notifyOnFailure(task, "reviewer", reviewRes);
      return { success: false, step: "reviewer", result: reviewRes };
    }

    // 5) Optionally create PR
    let ghRes = null;
    if (task.autoCreatePR) {
      const ghAgent = new GithubAgent();
      ghRes = await ghAgent.run(task);
      await pushStep("github", ghRes);
      if (!ghRes.success) {
        await taskUpdate({ status: "failed", finishedAt: new Date(), lastError: "github failed" });
        await notifyOnFailure(task, "github", ghRes);
        return { success: false, step: "github", result: ghRes };
      }
      await taskUpdate({ status: "completed", finishedAt: new Date(), result: { prUrl: ghRes.output } });
      return { success: true, step: "github", result: ghRes };
    }

    await taskUpdate({ status: "completed", finishedAt: new Date(), result: { coder: coderRes, exec: execRes, review: reviewRes } });
    return { success: true, step: "done", result: { coder: coderRes, exec: execRes, review: reviewRes } };

  } catch (e) {
    err("Orchestrator error", e);
    await mongo.updateTask(taskId, { status: "failed", finishedAt: new Date(), lastError: e.message || String(e) });
    await pushStep("orchestrator-error", { success: false, output: e.message || String(e) });
    await notifyOnFailure(task, "orchestrator", { success: false, output: e.message || String(e) });
    return { success: false, step: "orchestrator", result: { success: false, output: e.message || String(e) } };
  }
}

module.exports = { orchestrator };
