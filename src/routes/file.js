const express = require("express");
const router = express.Router();
const fs = require("fs").promises;
const path = require("path");
const { log, err } = require("../utils/logger");
const mongo = require("../db/mongo");
const { runGit } = require("../tools/git");

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "./workspace");

// helper: get workspace path for a request (task-specific if taskId provided)
async function resolveWorkspace(taskId) {
  if (!taskId) return WORKSPACE_ROOT;
  const task = await mongo.findTaskById(taskId);
  if (!task) throw new Error("task not found");
  if (!task.workspace) throw new Error("task workspace not set");
  return task.workspace;
}

// Ensure a user-provided path resolves inside the chosen workspace
function safeFullPath(workspaceRoot, relPath = "") {
  const p = path.normalize(relPath || "").replace(/^(\.\.(\/|\\|$))+/, ""); // basic strip leading ..
  const full = path.resolve(workspaceRoot, p);
  if (!full.startsWith(workspaceRoot)) {
    throw new Error("Invalid path");
  }
  return full;
}

// List files in a directory (non-recursive)
router.get("/files", async (req, res) => {
  try {
    const rel = req.query.path || "";
    const taskId = req.query.taskId || null;
    const workspace = await resolveWorkspace(taskId);
    const full = safeFullPath(workspace, rel);
    const items = await fs.readdir(full, { withFileTypes: true }).catch(() => []);
    const list = items.map((it) => ({
      name: it.name,
      type: it.isDirectory() ? "dir" : "file"
    }));
    res.json({ success: true, path: rel, list, workspace, taskId });
  } catch (e) {
    err("files:list error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Read a file
router.get("/file", async (req, res) => {
  try {
    const rel = req.query.path;
    const taskId = req.query.taskId || null;
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const workspace = await resolveWorkspace(taskId);
    const full = safeFullPath(workspace, rel);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) return res.status(400).json({ success: false, error: "path is a directory" });
    const content = await fs.readFile(full, "utf8");
    res.json({ success: true, path: rel, content, workspace, taskId });
  } catch (e) {
    err("file:read error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Write/save a file (creates directories as needed). If taskId provided, create/checkout branch and commit.
router.post("/file", async (req, res) => {
  try {
    const { path: rel, content, taskId, commitMessage } = req.body || {};
    if (!rel) return res.status(400).json({ success: false, error: "path required" });

    const workspace = await resolveWorkspace(taskId);
    const full = safeFullPath(workspace, rel);
    const dir = path.dirname(full);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    await fs.writeFile(full, content || "", "utf8");
    log("file:write", rel, "workspace", workspace);

    // If taskId provided, create/checkout branch and commit
    if (taskId) {
      const task = await mongo.findTaskById(taskId);
      if (!task) throw new Error("task not found");
      let branch = task.branch;
      if (!branch) {
        const short = task._id.toString().slice(-8);
        branch = `ai/task-${short}`;
        // attempt to create branch
        try {
          await runGit(["checkout", "-b", branch], workspace);
        } catch (e) {
          // if branch exists, checkout it
          await runGit(["checkout", branch], workspace).catch(() => { /* ignore */ });
        }
        // save branch name into task
        await mongo.updateTask(taskId, { branch });
      } else {
        // ensure we're on branch
        try { await runGit(["checkout", branch], workspace); } catch (e) { /* ignore */ }
      }

      // git add & commit the file
      try {
        await runGit(["add", rel], workspace);
        const message = commitMessage || `AI Devin: update ${rel}`;
        await runGit(["commit", "-m", message], workspace);
        log("Committed", rel, "on branch", branch);
      } catch (e) {
        // if nothing to commit or error, still return success for file write but include message
        log("git add/commit error", e.message || e);
        return res.json({ success: true, path: rel, workspace, taskId, git: { success: false, error: e.message || String(e) } });
      }

      return res.json({ success: true, path: rel, workspace, taskId, branch });
    }

    return res.json({ success: true, path: rel, workspace, taskId: null });
  } catch (e) {
    err("file:write error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Create a folder
router.post("/folder", async (req, res) => {
  try {
    const { path: rel, taskId } = req.body || {};
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const workspace = await resolveWorkspace(taskId);
    const full = safeFullPath(workspace, rel);
    await fs.mkdir(full, { recursive: true });
    log("folder:create", rel);
    res.json({ success: true, path: rel, workspace, taskId });
  } catch (e) {
    err("folder:create error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Delete file or folder (careful). If taskId provided, try to git rm and commit.
router.delete("/file", async (req, res) => {
  try {
    const rel = req.query.path || (req.body && req.body.path);
    const taskId = req.query.taskId || (req.body && req.body.taskId) || null;
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const workspace = await resolveWorkspace(taskId);
    const full = safeFullPath(workspace, rel);
    await fs.rm(full, { recursive: true, force: true });
    log("file:delete", rel);

    if (taskId) {
      // git rm & commit
      try {
        const task = await mongo.findTaskById(taskId);
        let branch = task.branch;
        if (!branch) {
          const short = task._id.toString().slice(-8);
          branch = `ai/task-${short}`;
          try { await runGit(["checkout", "-b", branch], workspace); } catch (e) { await runGit(["checkout", branch], workspace).catch(()=>{}); }
          await mongo.updateTask(taskId, { branch });
        } else {
          try { await runGit(["checkout", branch], workspace); } catch (e) {}
        }
        await runGit(["rm", "-rf", rel], workspace);
        await runGit(["commit", "-m", `AI Devin: remove ${rel}`], workspace);
      } catch (e) {
        log("git rm/commit failed", e.message || e);
        // proceed, return success for delete
      }
    }

    res.json({ success: true, path: rel, workspace, taskId });
  } catch (e) {
    err("file:delete error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

module.exports = router;
