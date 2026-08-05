// src/orchestrator/autoGenerator.js
const mongo = require("../db/mongo");
const Planner = require("../agents/planner");
const { runModule } = require("./moduleRunner");
const { log, err } = require("../utils/logger");
const { broadcast } = require("../realtime/wsServer");

// in-memory controllers for running jobs (simple)
const runningJobs = new Map();

/**
 * estimateTokensForPlan(plan) - very rough estimate:
 * tokens ~= chars / 4, cost uses TOKEN_COST_USD_PER_1K env
 */
function estimateTokensForPlan(plan, charsPerLine = 40) {
  let totalLines = 0;
  for (const m of plan) totalLines += (m.targetLines || 500);
  const approxChars = totalLines * charsPerLine;
  const tokens = Math.ceil(approxChars / 4);
  const costPer1k = Number(process.env.TOKEN_COST_USD_PER_1K || 0.03);
  const cost = (tokens / 1000) * costPer1k;
  return { tokens, cost, totalLines };
}

/**
 * internal runner loop - processes modules from provided indices or start index
 */
async function runModulesLoop(taskId, plan, opts = {}, startIndex = 0, moduleIndices = null) {
  const jobController = { stopped: false, taskId, currentIndex: startIndex };
  runningJobs.set(taskId, jobController);

  try {
    const maxPerRun = opts.maxModulesPerRun || 3;
    let processed = 0;

    // helper to iterate indices to process
    const indicesToProcess = [];
    if (Array.isArray(moduleIndices) && moduleIndices.length) {
      for (const idx of moduleIndices) {
        if (idx >= 0 && idx < plan.length) indicesToProcess.push(idx);
      }
    } else {
      for (let i = startIndex; i < plan.length; i++) indicesToProcess.push(i);
    }

    for (const i of indicesToProcess) {
      if (jobController.stopped) {
        log(`Auto-generator for ${taskId} stopped by request`);
        break;
      }

      // Check current status; skip succeeded
      const planInfo = await mongo.getModulePlan(taskId);
      const statuses = planInfo.statuses || [];
      if (statuses[i] && statuses[i].status === "succeeded") continue;

      const moduleSpec = plan[i];
      broadcast({ type: "module.start", taskId, index: i, module: moduleSpec });

      const res = await runModule(taskId, moduleSpec, {
        testCommand: opts.testCommand,
        sandboxImage: opts.sandboxImage,
        gitleaksEnabled: opts.gitleaksEnabled,
        failOnSecrets: opts.failOnSecrets,
        runLint: opts.runLint,
        lintCommand: opts.lintCommand,
        failOnLint: opts.failOnLint,
        dryRun: false,
        timeoutSeconds: opts.timeoutSeconds,
        cpus: opts.cpus,
        memory: opts.memory
      });

      processed++;
      jobController.currentIndex = i;

      if (!res.success) {
        await mongo.pushTaskStep(taskId, { name: "auto:pause", timestamp: new Date(), success: false, output: `Module ${moduleSpec.name} failed; pausing auto-generator`, metadata: { moduleIndex: i } });
        break;
      }

      if (processed >= maxPerRun) {
        log(`Auto-generator processed ${processed} modules for ${taskId}; stopping run (can be resumed)`);
        break;
      }
    }
  } catch (e) {
    err("autoGenerator run failed", e);
    await mongo.pushTaskStep(taskId, { name: "auto:error", timestamp: new Date(), success: false, output: String(e) });
  } finally {
    runningJobs.delete(taskId);
    broadcast({ type: "auto.finished", taskId });
  }
}

/**
 * start(taskId, opts)
 * opts: { maxModulesPerRun, dryRun, testCommand, sandboxImage, gitleaksEnabled, failOnSecrets, runLint, lintCommand, failOnLint }
 */
async function start(taskId, opts = {}) {
  if (runningJobs.has(taskId)) {
    return { success: false, error: "job already running" };
  }
  const task = await mongo.findTaskById(taskId);
  if (!task) throw new Error("task not found");

  const planner = new Planner();
  const planRes = await planner.run(task);
  // planner should set modulePlan in metadata or return plan array
  const plan = planRes.metadata && planRes.metadata.modulePlan ? planRes.metadata.modulePlan : (planRes.plan || planRes.modules || []);
  if (!Array.isArray(plan)) {
    throw new Error("Planner did not return a module plan array");
  }

  await mongo.setModulePlan(taskId, plan);
  await mongo.pushTaskStep(taskId, { name: "plan", timestamp: new Date(), success: true, output: `Planner produced ${plan.length} modules`, metadata: { count: plan.length } });

  const estimate = estimateTokensForPlan(plan);

  if (opts.dryRun) {
    return { success: true, dryRun: true, plan, estimate };
  }

  // start processing from beginning (skip already succeeded modules inside loop)
  const planInfo = await mongo.getModulePlan(taskId);
  const startIndex = 0;
  runModulesLoop(taskId, plan, opts, startIndex, null);
  return { success: true, started: true, planCount: plan.length, estimate };
}

/**
 * resume(taskId, opts)
 * - If opts.moduleIndices provided: retries those module indices in order.
 * - Else: find first module with status 'failed' or 'pending' and resume from there.
 * opts same as start.
 */
async function resume(taskId, opts = {}) {
  if (runningJobs.has(taskId)) {
    return { success: false, error: "job already running" };
  }
  const task = await mongo.findTaskById(taskId);
  if (!task) throw new Error("task not found");

  const planInfo = await mongo.getModulePlan(taskId);
  const plan = planInfo.plan || [];
  const statuses = planInfo.statuses || [];

  if (!plan || !plan.length) {
    return { success: false, error: "no module plan found for task" };
  }

  // If moduleIndices explicitly provided, validate and run those
  if (Array.isArray(opts.moduleIndices) && opts.moduleIndices.length) {
    const validIndices = opts.moduleIndices.filter(i => Number.isInteger(i) && i >= 0 && i < plan.length);
    if (!validIndices.length) return { success: false, error: "no valid module indices provided" };
    runModulesLoop(taskId, plan, opts, validIndices[0], validIndices);
    return { success: true, resumed: true, indices: validIndices };
  }

  // Otherwise find first failed or pending module
  let startIndex = -1;
  for (let i = 0; i < plan.length; i++) {
    const s = statuses[i] || {};
    if (!s.status || s.status === "pending" || s.status === "failed") {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    // nothing to resume
    return { success: false, message: "No failed or pending modules to resume" };
  }

  runModulesLoop(taskId, plan, opts, startIndex, null);
  return { success: true, resumed: true, startIndex };
}

async function stop(taskId) {
  const job = runningJobs.get(taskId);
  if (!job) return { success: false, error: "no running job" };
  job.stopped = true;
  runningJobs.delete(taskId);
  return { success: true, stopped: true };
}

async function status(taskId) {
  const job = runningJobs.get(taskId);
  const planInfo = await mongo.getModulePlan(taskId);
  return { running: !!job, plan: planInfo.plan, statuses: planInfo.statuses || [], current: job ? job.currentIndex : null };
}

module.exports = { start, stop, status, resume, estimateTokensForPlan };
