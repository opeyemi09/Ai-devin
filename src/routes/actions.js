const express = require("express");
const router = express.Router();
const mongo = require("../db/mongo");
const { runGit } = require("../tools/git");
const { createPullRequest } = require("../tools/github");
const { log, err } = require("../utils/logger");
const path = require("path");
const { start: startAuto, stop: stopAuto, status: statusAuto, resume: resumeAuto } = require("../orchestrator/autoGenerator");
const { scanPath } = require("../tools/gitleaks");
const fs = require("fs").promises;

const DEFAULT_BASE = process.env.DEFAULT_BRANCH || "main";

/**
 * GET /api/actions/diff?taskId=<id>&base=<branch>
 * Returns the git diff between base...taskBranch for the task workspace.
 */
router.get("/diff", async (req, res) => {
  try {
    const taskId = req.query.taskId;
    const base = req.query.base || DEFAULT_BASE;
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    const task = await mongo.findTaskById(taskId);
    if (!task) return res.status(404).json({ success: false, error: "task not found" });
    const workspace = task.workspace;
    if (!workspace) return res.status(400).json({ success: false, error: "task workspace not set" });

    const branch = task.branch;
    if (!branch) return res.status(400).json({ success: false, error: "task branch not found; make some edits/commit first" });

    try { await runGit(["checkout", branch], workspace); } catch (e) {}
    try { await runGit(["fetch", "origin", base], workspace); } catch (e) {}

    const diffResult = await runGit(["diff", "--no-color", `${base}...${branch}`], workspace).catch(async () => {
      return await runGit(["diff", "--no-color", branch], workspace);
    });
    const diffText = (diffResult && (diffResult.stdout || diffResult.stderr)) || "";

    res.json({ success: true, diff: diffText, branch, base });
  } catch (e) {
    err("actions:diff error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * GET /api/actions/file-diff?taskId=&filePath=&base=
 * Returns baseContent and currentContent for a file (so UI can render side-by-side diff).
 */
router.get("/file-diff", async (req, res) => {
  try {
    const { taskId, filePath } = req.query;
    const base = req.query.base || DEFAULT_BASE;
    if (!taskId || !filePath) return res.status(400).json({ success: false, error: "taskId and filePath required" });

    const task = await mongo.findTaskById(taskId);
    if (!task) return res.status(404).json({ success: false, error: "task not found" });
    const workspace = task.workspace;
    if (!workspace) return res.status(400).json({ success: false, error: "task workspace not set" });

    const branch = task.branch;
    if (!branch) return res.status(400).json({ success: false, error: "task branch not found; commit changes first" });

    let baseContent = "";
    try {
      const showRes = await runGit(["show", `${base}:${filePath}`], workspace);
      baseContent = showRes.stdout || showRes.stderr || "";
    } catch (e) {
      baseContent = "";
    }

    let currentContent = "";
    try {
      const full = path.join(workspace, filePath);
      currentContent = await fs.readFile(full, "utf8");
    } catch (e) {
      currentContent = "";
    }

    res.json({ success: true, baseContent, currentContent, filePath, branch, base });
  } catch (e) {
    err("actions:file-diff error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * GET /api/actions/scan?taskId=&base=
 * Scans the diff for secrets (simple) and also runs gitleaks if available.
 */
router.get("/scan", async (req, res) => {
  try {
    const taskId = req.query.taskId;
    const base = req.query.base || DEFAULT_BASE;
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    const task = await mongo.findTaskById(taskId);
    if (!task) return res.status(404).json({ success: false, error: "task not found" });
    const workspace = task.workspace;
    if (!workspace) return res.status(400).json({ success: false, error: "task workspace not set" });

    const branch = task.branch;
    if (!branch) return res.status(400).json({ success: false, error: "task branch not found; commit changes first" });

    let diff = "";
    try {
      const d = await runGit(["diff", "--no-color", `${base}...${branch}`], workspace);
      diff = d.stdout || d.stderr || "";
    } catch (e) {
      diff = "";
    }

    let gitleaksFindings = [];
    try {
      gitleaksFindings = await scanPath(workspace).catch(() => []);
    } catch (e) {
      log("gitleaks scan error", e);
    }

    res.json({ success: true, diff, gitleaksFindings, branch, base });
  } catch (e) {
    err("actions:scan error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * POST /api/actions/approve
 * Body: { taskId, title, body, base?, overrideSecrets:false }
 * Pushes the task branch to origin and creates a PR via Octokit.
 */
router.post("/approve", async (req, res) => {
  try {
    const { taskId, title, body: prBody, overrideSecrets } = req.body || {};
    const base = req.body.base || DEFAULT_BASE;
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    const task = await mongo.findTaskById(taskId);
    if (!task) return res.status(404).json({ success: false, error: "task not found" });
    const workspace = task.workspace;
    if (!workspace) return res.status(400).json({ success: false, error: "task workspace not set" });

    const branch = task.branch;
    if (!branch) return res.status(400).json({ success: false, error: "task branch not found; commit changes first" });

    // Determine owner/repo
    const meta = task.meta || {};
    const repoUrl = meta.repoUrl || null;
    if (!meta.owner || !meta.repo) {
      if (repoUrl) {
        const m = repoUrl.match(/github\.com[:\/]([^\/]+)\/(.+?)(\.git)?$/);
        if (m) { meta.owner = m[1]; meta.repo = m[2]; }
      }
    }
    const finalOwner = meta.owner;
    const finalRepo = meta.repo;
    if (!finalOwner || !finalRepo) {
      return res.status(400).json({ success: false, error: "task.meta.owner and task.meta.repo required to push and create PR" });
    }

    // run gitleaks before push
    const ghToken = process.env.GH_PAT;
    if (!ghToken) {
      return res.status(500).json({ success: false, error: "Server GH_PAT not configured; cannot push" });
    }

    // tokenized remote (used for push)
    const remoteUrl = `https://${encodeURIComponent(ghToken)}@github.com/${finalOwner}/${finalRepo}.git`;

    // ensure remote
    try {
      await runGit(["remote", "remove", "origin"], workspace).catch(() => {});
      await runGit(["remote", "add", "origin", remoteUrl], workspace);
    } catch (e) {
      log("warning: remote setup error", e.message || e);
    }

    // run gitleaks to double-check
    try {
      const findings = await scanPath(workspace).catch(() => []);
      if (findings && findings.length && !overrideSecrets) {
        return res.status(400).json({ success: false, error: "Secrets detected by gitleaks, aborting push", findings });
      }
    } catch (e) {
      log("gitleaks pre-push failed", e);
      // proceed cautiously; do not block push solely because gitleaks failed to run
    }

    // push branch
    try {
      await runGit(["push", "-u", "origin", branch], workspace);
    } catch (e) {
      err("git push failed", e);
      return res.status(500).json({ success: false, error: "git push failed: " + (e.message || String(e)) });
    }

    // create PR via Octokit
    try {
      const prTitle = title || (task.commitMessage || `AI Devin: changes from task ${taskId}`);
      const prBodyFinal = prBody || `This PR was created by AI Devin for task ${taskId}`;
      const pr = await createPullRequest(finalOwner, finalRepo, branch, base, prTitle, prBodyFinal);
      await mongo.updateTask(taskId, { status: "pr_created", finishedAt: new Date(), result: { prUrl: pr.html_url } });
      return res.json({ success: true, prUrl: pr.html_url, pr });
    } catch (e) {
      err("create PR failed", e);
      return res.status(500).json({ success: false, error: "create PR failed: " + (e.message || String(e)) });
    }
  } catch (e) {
    err("actions:approve error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * POST /api/actions/undo
 * Body: { taskId, base? }
 * Creates a backup branch, then resets the task branch to base and cleans untracked files.
 */
router.post("/undo", async (req, res) => {
  try {
    const { taskId } = req.body || {};
    const base = req.body.base || DEFAULT_BASE;
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    const task = await mongo.findTaskById(taskId);
    if (!task) return res.status(404).json({ success: false, error: "task not found" });
    const workspace = task.workspace;
    if (!workspace) return res.status(400).json({ success: false, error: "task workspace not set" });

    let branch = task.branch;
    if (!branch) return res.status(400).json({ success: false, error: "task branch not found" });

    const ts = Date.now();
    const backupBranch = `backup/${branch.replace(/\//g, "_")}-${ts}`;
    try {
      await runGit(["checkout", branch], workspace);
      await runGit(["checkout", "-b", backupBranch], workspace);
      await runGit(["checkout", branch], workspace);
      await runGit(["reset", "--hard", base], workspace);
      await runGit(["clean", "-fd"], workspace);
      await mongo.pushTaskStep(taskId, { name: "undo", timestamp: new Date(), success: true, output: `Reset ${branch} to ${base}, backup: ${backupBranch}` });
      await mongo.updateTask(taskId, { status: "reverted", lastError: null });
      return res.json({ success: true, message: `Reverted ${branch} to ${base}`, backupBranch });
    } catch (e) {
      err("undo failed", e);
      await mongo.pushTaskStep(taskId, { name: "undo", timestamp: new Date(), success: false, output: String(e) });
      return res.status(500).json({ success: false, error: String(e) });
    }
  } catch (e) {
    err("actions:undo error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/* Automated generation endpoints */

/**
 * POST /api/actions/start-auto
 * Body: { taskId, maxModulesPerRun?, dryRun?, testCommand?, sandboxImage?, gitleaksEnabled?, failOnSecrets?, runLint?, lintCommand?, failOnLint?, invokedBy? }
 */
router.post("/start-auto", async (req, res) => {
  try {
    const { taskId, dryRun } = req.body || {};
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    const opts = {
      maxModulesPerRun: req.body.maxModulesPerRun,
      dryRun: !!dryRun,
      testCommand: req.body.testCommand,
      sandboxImage: req.body.sandboxImage,
      gitleaksEnabled: !!req.body.gitleaksEnabled,
      failOnSecrets: !!req.body.failOnSecrets,
      runLint: !!req.body.runLint,
      lintCommand: req.body.lintCommand,
      failOnLint: !!req.body.failOnLint
    };

    // Audit insert for start-auto
    try {
      const invoker = req.body.invokedBy || req.headers["x-api-user"] || "api";
      await mongo.insertAudit({
        taskId,
        type: "auto",
        action: "start",
        actor: invoker,
        details: { opts },
        timestamp: new Date()
      });
    } catch (auditErr) {
      log("start-auto audit failed", auditErr);
    }

    const result = await startAuto(taskId, opts);
    return res.json(result);
  } catch (e) {
    err("start-auto error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * POST /api/actions/stop-auto
 * Body: { taskId, invokedBy? }
 */
router.post("/stop-auto", async (req, res) => {
  try {
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    // Audit insert for stop-auto
    try {
      const invoker = req.body.invokedBy || req.headers["x-api-user"] || "api";
      await mongo.insertAudit({
        taskId,
        type: "auto",
        action: "stop",
        actor: invoker,
        details: {},
        timestamp: new Date()
      });
    } catch (auditErr) {
      log("stop-auto audit failed", auditErr);
    }

    const result = await stopAuto(taskId);
    return res.json(result);
  } catch (e) {
    err("stop-auto error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * POST /api/actions/resume-auto
 * Body: { taskId, moduleIndices?: [int], maxModulesPerRun?, gitleaksEnabled?, runLint?, failOnSecrets?, lintCommand?, failOnLint?, invokedBy? }
 */
router.post("/resume-auto", async (req, res) => {
  try {
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });

    const opts = {
      moduleIndices: Array.isArray(req.body.moduleIndices) ? req.body.moduleIndices.map(Number) : undefined,
      maxModulesPerRun: req.body.maxModulesPerRun,
      testCommand: req.body.testCommand,
      sandboxImage: req.body.sandboxImage,
      gitleaksEnabled: !!req.body.gitleaksEnabled,
      failOnSecrets: !!req.body.failOnSecrets,
      runLint: !!req.body.runLint,
      lintCommand: req.body.lintCommand,
      failOnLint: !!req.body.failOnLint
    };

    // Structured audit log entry
    try {
      const invoker = req.body.invokedBy || req.headers["x-api-user"] || "api";
      await mongo.insertAudit({
        taskId,
        type: "auto",
        action: "resume",
        actor: invoker,
        details: { moduleIndices: opts.moduleIndices || null, opts },
        timestamp: new Date()
      });
    } catch (auditErr) {
      log("resume-auto audit failed", auditErr);
    }

    // Also append an append-only task step for human-readable trace (backwards compatibility)
    try {
      const invokerStep = req.body.invokedBy || req.headers["x-api-user"] || "api";
      await mongo.pushTaskStep(taskId, {
        name: "resume-invoked",
        timestamp: new Date(),
        success: true,
        output: `Resume requested by ${invokerStep}`,
        metadata: { moduleIndices: opts.moduleIndices || null }
      });
    } catch (auditStepErr) {
      log("Failed to write resume-invoked step", auditStepErr);
    }

    const result = await resumeAuto(taskId, opts);
    return res.json(result);
  } catch (e) {
    err("resume-auto error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

/**
 * GET /api/actions/auto-status?taskId=
 */
router.get("/auto-status", async (req, res) => {
  try {
    const taskId = req.query.taskId;
    if (!taskId) return res.status(400).json({ success: false, error: "taskId required" });
    const result = await statusAuto(taskId);
    return res.json({ success: true, status: result });
  } catch (e) {
    err("auto-status error", e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

module.exports = router;
