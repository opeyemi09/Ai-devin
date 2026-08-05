require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");
const { taskQueue } = require("./src/queue/queue");
const { log, err } = require("./src/utils/logger");
const mongo = require("./src/db/mongo");
const filesRouter = require("./src/routes/files");

const app = express();
app.use(bodyParser.json());

// mount file manager endpoints
app.use("/api", filesRouter);

const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/ai_devin";
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "./workspace");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function start() {
  await mongo.connect(MONGO_URL);

  // ensure workspace root exists
  await ensureDir(WORKSPACE_ROOT);

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // create a task (persist in mongo, then enqueue)
  app.post("/run", async (req, res) => {
    const body = req.body || {};
    try {
      // Insert task into Mongo
      const taskDoc = {
        prompt: body.prompt || "",
        createdBy: body.createdBy || "local",
        // placeholder workspace; will be updated after task row created
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

      // If a repo URL was provided, try to git clone into the workspace; otherwise init git
      const repoUrl = (body.meta && body.meta.repoUrl) || body.repoUrl || null;
      const { runGit } = require("./src/tools/git");
      try {
        if (repoUrl) {
          // clone into the workspace path
          await runGit(["clone", repoUrl, taskWorkspace], process.cwd());
          log("Cloned repo into", taskWorkspace);
        } else {
          // initialize empty git repo
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
