require("dotenv").config();
const { Worker } = require("bullmq");
const mongo = require("../db/mongo");
const { log, err } = require("../utils/logger");
const { orchestrator } = require("../orchestrator/loop");

const connection = { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT || "6379") };

async function startWorker() {
  await mongo.connect(process.env.MONGO_URL || "mongodb://localhost:27017/ai_devin");

  const worker = new Worker("ai-tasks", async (job) => {
    log("Worker processing job:", job.id, job.data);
    const taskId = job.data.taskId;
    if (!taskId) throw new Error("job missing taskId");
    const res = await orchestrator(taskId); // orchestrator will fetch and update the task
    return res;
  }, { connection });

  worker.on("completed", (job) => log("Job completed", job.id));
  worker.on("failed", (job, e) => err("Job failed", job?.id, e));
}

startWorker().catch((e) => {
  err("Worker failed to start", e);
  process.exit(1);
});
