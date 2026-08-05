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
  // plan: array of module specs with targetLines
  let totalLines = 0;
  for (const m of plan) totalLines += (m.targetLines || 500);
  const approxChars = totalLines * charsPerLine;
  const tokens = Math.ceil(approxChars / 4);
  const costPer1k = Number(process.env.TOKEN_COST_USD_PER_1K || 0.03);
  const cost = (tokens / 1000) * costPer1k;
  return { tokens, cost, totalLines };
}

/**
 * start(taskId, opts)
 * opts: { maxModulesPerRun, dryRun, testCommand, sandboxImage, gitleaksEnabled, failOnSecrets, failOnLint, runLint }
 */
async function start(taskId, opts = {}) {
  if (runningJobs.has(taskId)) {
    return { success: false, error: "job already running" };
  }
  const task = await mongo.findTaskById(taskId);
  if (!task) throw new Error("task not found");

  const planner = new Planner();
  const planRes = await planner.run(task);
  const plan = planRes.metadata && planRes.metadata.modulePlan ? planRes.metadata.modulePlan : (planRes.plan || planRes.modules || []);
  // Normalize plan items if necessary. Expect plan to be array of {name,path,description,targetLines,tests}
  if (!Array.isArray(plan)) {
    throw new Error("Planner did not return a module plan array");
  }

  // store plan in task
  await mongo.setModulePlan(taskId, plan);
  await mongo.pushTaskStep(taskId, { name: "plan", timestamp: new Date(), success: true, output: `Planner produced ${plan.length} modules`, metadata: { count: plan.length } });

  const estimate = estimateTokensForPlan(plan);

  if (opts.dryRun) {
    // return plan + estimate without running modules
    return { success: true, dryRun: true, plan, estimate };
  }

  // Start running modules (limited to maxModulesPerRun per invocation)
  const maxPerRun = opts.maxModulesPerRun || 3;
  const startIndex = 0;
  const jobController = { stopped: false, taskId, currentIndex: startIndex };
  runningJobs.set(taskId, jobController);

  (async () => {
    try {
      for (let i = startIndex; i < plan.length; i++) {
        if (jobController.stopped) {
          log(`Auto-generator for ${taskId} stopped by request`);
          break;
        }
        // check status in DB to skip completed modules
        const statusObj = (await mongo.getModulePlan(taskId)).statuses || [];
        if (statusObj[i] && statusObj[i].status === "succeeded") continue;

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
          dryRun: false
        });

        if (!res.success) {
          // pause on failure
          await mongo.pushTaskStep(taskId, { name: "auto:pause", timestamp: new Date(), success: false, output: `Module ${moduleSpec.name} failed; pausing auto-generator`, metadata: { moduleIndex: i } });
          break;
        }

        // continue until maxPerRun reached in this invocation
        if ((i - startIndex + 1) >= maxPerRun) {
          log(`Auto-generator processed ${maxPerRun} modules for ${taskId}; stopping run (can be resumed)`);
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
  })();

  return { success: true, started: true, planCount: plan.length, estimate };
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

module.exports = { start, stop, status, estimateTokensForPlan };
