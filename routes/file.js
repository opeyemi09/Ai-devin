const express = require("express");
const router = express.Router();
const fs = require("fs").promises;
const path = require("path");
const { log, err } = require("../utils/logger");

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "./workspace");

// Ensure a user-provided path resolves inside the workspace root
function safePath(relPath = "") {
  const p = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, ""); // basic strip leading ..
  const full = path.resolve(WORKSPACE_ROOT, p);
  if (!full.startsWith(WORKSPACE_ROOT)) {
    throw new Error("Invalid path");
  }
  return full;
}

// List files in a directory (non-recursive)
router.get("/files", async (req, res) => {
  try {
    const rel = req.query.path || "";
    const full = safePath(rel);
    const items = await fs.readdir(full, { withFileTypes: true });
    const list = items.map((it) => ({
      name: it.name,
      type: it.isDirectory() ? "dir" : "file"
    }));
    res.json({ success: true, path: rel, list });
  } catch (e) {
    err("files:list error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Read a file
router.get("/file", async (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const full = safePath(rel);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) return res.status(400).json({ success: false, error: "path is a directory" });
    const content = await fs.readFile(full, "utf8");
    res.json({ success: true, path: rel, content });
  } catch (e) {
    err("file:read error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Write/save a file (creates directories as needed)
router.post("/file", async (req, res) => {
  try {
    const { path: rel, content } = req.body || {};
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const full = safePath(rel);
    const dir = path.dirname(full);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(full, content || "", "utf8");
    log("file:write", rel);
    res.json({ success: true, path: rel });
  } catch (e) {
    err("file:write error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Create a folder
router.post("/folder", async (req, res) => {
  try {
    const { path: rel } = req.body || {};
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const full = safePath(rel);
    await fs.mkdir(full, { recursive: true });
    log("folder:create", rel);
    res.json({ success: true, path: rel });
  } catch (e) {
    err("folder:create error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

// Delete file or folder (careful)
router.delete("/file", async (req, res) => {
  try {
    const rel = req.query.path || (req.body && req.body.path);
    if (!rel) return res.status(400).json({ success: false, error: "path required" });
    const full = safePath(rel);
    // remove recursively for safety flag; use with caution
    await fs.rm(full, { recursive: true, force: true });
    log("file:delete", rel);
    res.json({ success: true, path: rel });
  } catch (e) {
    err("file:delete error", e.message || e);
    res.status(400).json({ success: false, error: e.message || String(e) });
  }
});

module.exports = router;
