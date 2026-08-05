const { Queue } = require("bullmq");
const connection = { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT || "6379") };
const taskQueue = new Queue("ai-tasks", { connection });
module.exports = { taskQueue };
