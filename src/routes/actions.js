// src/routes/actions.js
const express = require("express");
const router = express.Router();
const mongo = require("../db/mongo");
const { runGit } = require("../tools/git");
const { createPullRequest } = require("../tools/github");
const { log, err } = require("../utils/logger");
const path = require("path");

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

    // Ensure we are on the branch
    try { await runGit(["checkout", branch], workspace); } catch (e) { /* ignore */ }

    // Try to fetch base from origin if possible
    try { await runGit(["fetch", "origin", base], workspace); } catch (e) { /* ignore */ }

    // Produce diff: base...branch
    const diffResult = await runGit(["diff", "--no-color", `${base}...${branch}`], workspace).catch(async (e) => {
      // Fallback: diff HEAD
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
 * POST /api/actions/approve
 * Body: { taskId, title, body, base? }
 * Pushes the task branch to origin and creates a PR via Octokit.
 */
router.post("/approve", async (req, res) => {
  try {
    const { taskId, title, body: prBody } = req.body || {};
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
    const owner = meta.owner;
    const repo = meta.repo;
    const repoUrl = meta.repoUrl || null;

    if (!owner || !repo) {
      // try to infer from repoUrl if present: https://github.com/owner/repo.git
      if (repoUrl) {
        const m = repoUrl.match(/github\.com[:\/]([^\/]+)\/(.+?)(\.git)?$/);
        if (m) {
          // override owner/repo
          meta.owner = m[1];
          meta.repo = m[2];
        }
      }
    }

    const finalOwner = meta.owner;
    const finalRepo = meta.repo;
    if (!finalOwner || !finalRepo) {
      return res.status(400).json({ success: false, error: "task.meta.owner and task.meta.repo required to push and create PR" });
    }

    // Ensure remote 'origin' is set to an HTTPS URL using GH_PAT (so push works non-interactively)
    const ghToken = process.env.GH_PAT;
    if (!ghToken) {
      return res.status(500).json({ success: false, error: "Server GH_PAT not configured; cannot push" });
    }

    const remoteUrl = `https://${encodeURIComponent(ghToken)}@github.com/${finalOwner}/${finalRepo}.git`;

    // Remove any existing origin, then add ours (safe to override for task workspace)
    try {
      await runGit(["remote", "remove", "origin"], workspace).catch(() => {});
      await runGit(["remote", "add", "origin", remoteUrl], workspace);
    } catch (e) {
      log("warning: remote setup error", e.message || e);
    }

    // Push branch
    try {
      await runGit(["push", "-u", "origin", branch], workspace);
    } catch (e) {
      err("git push failed", e);
      return res.status(500).json({ success: false, error: "git push failed: " + (e.message || String(e)) });
    }

    // Create PR via Octokit
    try {
      const prTitle = title || (task.commitMessage || `AI Devin: changes from task ${taskId}`);
      const prBodyFinal = prBody || `This PR was created by AI Devin for task ${taskId}`;
      const pr = await createPullRequest(finalOwner, finalRepo, branch, base, prTitle, prBodyFinal);
      // update task with PR link and status
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

module.exports = router;
