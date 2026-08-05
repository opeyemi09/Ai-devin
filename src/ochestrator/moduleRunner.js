const path = require("path");
const fs = require("fs").promises;
const { runGit } = require("../tools/git");
const { runInDocker } = require("../tools/dockerExec");
const mongo = require("../db/mongo");
const { log, err } = require("../utils/logger");
const { broadcast } = require("../realtime/wsServer");
const Coder = require("../agents/coder"); // expects coder.run to accept a task with moduleSpec
const { scanTextForSecrets } = require("../utils/security");
const { notifySlack, notifyEmail } = require("../utils/notifier");

/**
 * runModule(taskId, moduleSpec, opts)
 * - moduleSpec: { name, path, description, files?: [{ path, content }], tests?: { command } }
 * - opts: { testCommand, sandboxImage, gitleaksEnabled, dryRun }
 *
 * Returns: { success, output, metadata }
 */
async function runModule(taskId, moduleSpec, opts = {}) {
  const task = await mongo.findTaskById(taskId);
  if (!task) throw new Error("task not found");
  const workspace = task.workspace;
  const coder = new Coder();

  const moduleIndex = (task.modulePlan || []).findIndex(m => m.name === moduleSpec.name);
  await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "running", updatedAt: new Date(), info: null });

  try {
    // 1) Generate files using coder agent (pass moduleSpec in task)
    const tWithModule = Object.assign({}, task, { moduleSpec });
    const genRes = await coder.run(tWithModule); // coder should honor moduleSpec; returns { success, files: [{path,content}], output, metadata }
    await mongo.pushTaskStep(taskId, { name: `coder:${moduleSpec.name}`, timestamp: new Date(), success: !!genRes.success, output: genRes.output || "", metadata: genRes.metadata || {} });
    if (!genRes.success) {
      await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "failed", updatedAt: new Date(), info: "coder failed" });
      broadcast({ type: "module.update", taskId, moduleIndex, status: "failed" });
      return { success: false, output: "Coder failed", metadata: genRes };
    }

    if (opts.dryRun) {
      await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "dry", updatedAt: new Date(), info: "dry-run, not writing files" });
      broadcast({ type: "module.update", taskId, moduleIndex, status: "dry" });
      return { success: true, output: "dry-run success", metadata: { gen: genRes } };
    }

    // 2) Write files
    const files = genRes.files || [];
    for (const f of files) {
      const full = path.resolve(workspace, f.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content || "", "utf8");
    }
    await mongo.pushTaskStep(taskId, { name: `write:${moduleSpec.name}`, timestamp: new Date(), success: true, output: `Wrote ${files.length} files`, metadata: { files: files.map(f => f.path) } });

    // 3) Git add & commit
    try {
      const commitMsg = `AI Devin: add/modify module ${moduleSpec.name}`;
      await runGit(["add", "."], workspace);
      await runGit(["commit", "-m", commitMsg], workspace).catch(() => {}); // commit may be empty
      await mongo.pushTaskStep(taskId, { name: `git:${moduleSpec.name}`, timestamp: new Date(), success: true, output: `Committed changes for ${moduleSpec.name}`, metadata: {} });
    } catch (e) {
      log("git commit error", e);
    }

    // 4) Module-level CI: run tests in Docker
    const testCmd = (moduleSpec.tests && moduleSpec.tests.command) || opts.testCommand || task.testCommand || "npm ci && npm test";
    const image = opts.sandboxImage || task.sandboxImage || "node:18-slim";
    const dockerRes = await runInDocker(image, workspace, testCmd, { timeoutSeconds: opts.timeoutSeconds || 300, cpus: opts.cpus || "0.5", memory: opts.memory || "1024m", network: opts.network === undefined ? true : opts.network });
    const stdout = dockerRes.stdout || "";
    const stderr = dockerRes.stderr || "";
    const success = dockerRes.code === 0;

    // store artifacts
    const artifactsDir = path.join(workspace, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true }).catch(()=>{});
    const logFile = path.join(artifactsDir, `${moduleSpec.name.replace(/[\/\\]/g,"_")}.log`);
    await fs.writeFile(logFile, `exit=${dockerRes.code}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`, "utf8");

    // push step
    await mongo.pushTaskStep(taskId, {
      name: `ci:${moduleSpec.name}`,
      timestamp: new Date(),
      success,
      output: `exit=${dockerRes.code}\n\nstdout excerpt:\n${stdout.slice(0,2000)}`,
      metadata: { exitCode: dockerRes.code, logFile }
    });

    // 5) Run lint/ts checks if requested (optional via opts)
    if (opts.runLint) {
      try {
        const lintCmd = opts.lintCommand || "npm run lint --silent";
        const lintRes = await runInDocker(image, workspace, lintCmd, { timeoutSeconds: 120, cpus: opts.cpus || "0.5", memory: opts.memory || "1024m", network: false });
        await mongo.pushTaskStep(taskId, {
          name: `lint:${moduleSpec.name}`,
          timestamp: new Date(),
          success: lintRes.code === 0,
          output: `lint exit=${lintRes.code}\n${(lintRes.stdout||"").slice(0,2000)}`,
          metadata: {}
        });
        if (lintRes.code !== 0 && opts.failOnLint) {
          await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "failed", updatedAt: new Date(), info: "lint failed" });
          broadcast({ type: "module.update", taskId, moduleIndex, status: "failed" });
          return { success: false, output: "lint failed", metadata: lintRes };
        }
      } catch (e) {
        log("lint run failed", e);
      }
    }

    // 6) Secret scan via gitleaks if enabled
    if (opts.gitleaksEnabled) {
      try {
        const gitleaks = require("../tools/gitleaks");
        const findings = await gitleaks.scanPath(workspace);
        if (findings && findings.length) {
          await mongo.pushTaskStep(taskId, {
            name: `gitleaks:${moduleSpec.name}`,
            timestamp: new Date(),
            success: false,
            output: `Secrets detected: ${JSON.stringify(findings.slice(0,10))}`,
            metadata: { findings }
          });
          if (opts.failOnSecrets) {
            await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "failed", updatedAt: new Date(), info: "secrets detected" });
            broadcast({ type: "module.update", taskId, moduleIndex, status: "failed" });
            return { success: false, output: "secrets detected", metadata: { findings } };
          }
        } else {
          await mongo.pushTaskStep(taskId, { name: `gitleaks:${moduleSpec.name}`, timestamp: new Date(), success: true, output: "No secrets detected", metadata: {} });
        }
      } catch (e) {
        log("gitleaks check failed", e);
      }
    }

    // 7) Success path: mark module succeeded
    await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "succeeded", updatedAt: new Date(), info: null });
    broadcast({ type: "module.update", taskId, moduleIndex, status: "succeeded" });

    return { success: true, output: `Module ${moduleSpec.name} completed`, metadata: { docker: dockerRes, filesWritten: files.length } };
  } catch (e) {
    err("moduleRunner error", e);
    await mongo.pushTaskStep(taskId, { name: `module-error:${moduleSpec.name}`, timestamp: new Date(), success: false, output: String(e), metadata: {} });
    await mongo.updateModuleStatus(taskId, moduleIndex, { name: moduleSpec.name, status: "failed", updatedAt: new Date(), info: String(e) });
    broadcast({ type: "module.update", taskId, moduleIndex, status: "failed" });
    // notify
    try {
      const slack = process.env.SLACK_WEBHOOK_URL;
      if (slack) await notifySlack(slack, `Task ${taskId} module ${moduleSpec.name} failed: ${String(e)}`);
    } catch (nerr) { log("notify failed", nerr); }
    return { success: false, output: String(e), metadata: {} };
  }
}

module.exports = { runModule };
