require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { taskQueue } = require("./src/queue/queue");
const { log, err } = require("./src/utils/logger");
const mongo = require("./src/db/mongo");

const app = express();
app.use(bodyParser.json());

const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/ai_devin";

async function start() {
  await mongo.connect(MONGO_URL);

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // create a task (persist in mongo, then enqueue)
  app.post("/run", async (req, res) => {
    const body = req.body || {};
    try {
      // Insert task into Mongo
      const taskDoc = {
        prompt: body.prompt || "",
        createdBy: body.createdBy || "local",
        workspace: body.workspace || process.env.WORKSPACE_ROOT || "./workspace",
        autoCreatePR: !!body.autoCreatePR,
        meta: body.meta || {},
        branch: body.branch || null,
        commitMessage: body.commitMessage || null,
        status: "queued"
      };
      const insertedId = await mongo.insertTask(taskDoc);
      await taskQueue.add("task", { taskId: insertedId.toString() });
      log("Created task", insertedId.toString());
      res.json({ success: true, taskId: insertedId.toString() });
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
