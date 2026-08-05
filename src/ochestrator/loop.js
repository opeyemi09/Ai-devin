const Planner = require("../agents/planner");
const Coder = require("../agents/coder");
const Executor = require("../agents/executor");
const Reviewer = require("../agents/reviewer");
const GithubAgent = require("../agents/githubAgent");
const DocAgent = require("../agents/docAgent");
const mongo = require("../db/mongo");
const { log, err } = require("../utils/logger");

/**
 * orchestrator(taskId) - retrieves the task from Mongo, runs pipeline,
 * and stores step outputs back to Mongo (append-only steps array).
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
    await mongo.pushTaskStep(taskId, step);
  };

  try {
    await taskUpdate({ status: "running", startedAt: new Date() });
    // 1) Planner
    const planner = new Planner();
    const planRes = await planner.run(task);
    await pushStep("planner", planRes);
    if (!planRes.success) {
      await taskUpdate({ status: "failed", finishedAt: new Date(), lastError: "planner failed" });
      return { success: false, step: "planner", result: planRes };
    }

    // 2) Coder
    const coder = new Coder();
    const coderRes = await coder.run(task);
    await pushStep("coder", coderRes);
    if (!coderRes.success) {
      await taskUpdate({ status: "failed", finishedAt: new Date(), lastError: "coder failed" });
      return { success: false, step: "coder", result: coderRes };
    }

    // 2b) DocAgent - add comments & docs (optional)
    const docAgent = new DocAgent();
    const docRes = await docAgent.run(task);
    await pushStep("docgen", docRes);
    // docgen failure shouldn't necessarily fail whole pipeline; log and continue
    if (!docRes.success) {
      await pushStep("docgen-failure", { success: false, output: docRes.output || "docgen failed" });
    }

    // 3) Execute (tests)
    const executor = new Executor();
    const execRes = await executor.run(task);
    await pushStep("executor", execRes);
    if (!execRes.success) {
      await taskUpdate({ status: "needs-review", finishedAt: new Date(), lastError: "tests failed" });
      return { success: false, step: "executor", result: execRes };
    }

    // 4) Reviewer
    const reviewer = new Reviewer();
    const reviewRes = await reviewer.run(task);
    await pushStep("reviewer", reviewRes);
    if (!reviewRes.success) {
      await taskUpdate({ status: "needs-review", finishedAt: new Date(), lastError: "reviewer found issues" });
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
    return { success: false, step: "orchestrator", result: { success: false, output: e.message || String(e) } };
  }
}

module.exports = { orchestrator };
