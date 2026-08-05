require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { taskQueue } = require("./src/queue/queue");
const { log, err } = require("./src/utils/logger");
const mongo = require("./src/db/mongo");
const filesRouter = require("./src/routes/files");
const actionsRouter = require("./src/routes/actions");

const app = express();
app.use(helmet());
app.use(bodyParser.json());

// simple API key auth middleware
const API_KEY = process.env.API_KEY || null;
function apiKeyMiddleware(req, res, next) {
  if (!API_KEY) return next(); // if not set, do not enforce
  const key = req.headers["x-api-key"] || req.query.api_key || req.headers["authorization"];
  if (!key) return res.status(401).json({ success: false, error: "API key required" });
  // accept "Bearer <key>" or raw key
  const normalized = (key || "").toString().replace(/^Bearer\s+/i, "");
  if (normalized !== API_KEY) return res.status(403).json({ success: false, error: "invalid API key" });
  next();
}

// global rate limiter for API routes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, slow down" }
});

// apply auth + limiter to /api
app.use("/api", apiKeyMiddleware, limiter, filesRouter);
// apply auth + limiter to actions explicitly
app.use("/api/actions", apiKeyMiddleware, limiter, actionsRouter);

// non-API endpoints still available (e.g., /run, /tasks)
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "./workspace");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function start() {
  const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/ai_devin";
  await mongo.connect(MONGO_URL);

  // ensure workspace root exists
  await ensureDir(WORKSPACE_ROOT);

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // create a task (persist in mongo, then enqueue)
  app.post("/run", async (req, res) => {
    const body = req.body || {};
    try {
      const taskDoc = {
        prompt: body.prompt || "",
        createdBy: body.createdBy || "local",
        workspace: null,
        autoCreatePR: !!body.autoCreatePR,
        meta: body.meta || {},
        branch: null,
        commitMessage: body.commitMessage || null,
        status: "queued"
      };
      const insertedId = await mongo.insertTask(taskDoc);
      const taskId = insertedId.toString();

      // create per-task workspace directory: WORKSPACE_ROOT/tasks/<taskId>
      const taskWorkspace = path.join(WORKSPACE_ROOT, "tasks", taskId);
      await ensureDir(taskWorkspace);

      // If repo URL provided, clone; else init git
      const repoUrl = (body.meta && body.meta.repoUrl) || body.repoUrl || null;
      const { runGit } = require("./src/tools/git");
      try {
        if (repoUrl) {
          await runGit(["clone", repoUrl, taskWorkspace], process.cwd());
          log("Cloned repo into", taskWorkspace);
        } else {
          await runGit(["init"], taskWorkspace);
          log("Initialized empty git repo in", taskWorkspace);
        }
      } catch (e) {
        log("Git setup failed, initializing empty repo instead", e.message || e);
        try { await runGit(["init"], taskWorkspace); } catch (e2) { log("git init also failed", e2.message || e2); }
      }

      // update task doc with workspace path
      await mongo.updateTask(taskId, { workspace: taskWorkspace });

      // enqueue a job referring to the taskId
      await taskQueue.add("task", { taskId });
      log("Created task", taskId, "workspace", taskWorkspace);
      res.json({ success: true, taskId });
    } catch (e) {
      err("Failed to create task", e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // list tasks
  app.get("/tasks", async (req, res) => {
    try {
      const tasks = await mongo.findTasks({}, 200);
      res.json({ success: true, tasks });
    } catch (e) {
      err("Failed to list tasks", e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // get task by id
  app.get("/tasks/:id", async (req, res) => {
    try {
      const task = await mongo.findTaskById(req.params.id);
      if (!task) return res.status(404).json({ success: false, error: "not found" });
      res.json({ success: true, task });
    } catch (e) {
      err("Failed to get task", e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => log(`Server listening on ${PORT}`));
}

start().catch((e) => {
  err("Failed to start server", e);
  process.exit(1);
});
