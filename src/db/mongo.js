const { MongoClient, ObjectId } = require("mongodb");
const { log, err } = require("../utils/logger");

let _client = null;
let _db = null;

async function connect(uri, dbName = "ai_devin") {
  if (_db) return _db;
  _client = new MongoClient(uri, { useUnifiedTopology: true });
  await _client.connect();
  _db = _client.db(dbName);
  log("Connected to MongoDB", uri, dbName);
  return _db;
}

function getDb() {
  if (!_db) throw new Error("MongoDB not connected - call connect first");
  return _db;
}

function tasksCollection() {
  return getDb().collection("tasks");
}

async function insertTask(task) {
  const col = tasksCollection();
  const now = new Date();
  const doc = Object.assign({ status: "queued", createdAt: now, steps: [] }, task);
  const res = await col.insertOne(doc);
  return res.insertedId;
}

async function findTasks(filter = {}, limit = 100) {
  const col = tasksCollection();
  return col.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
}

async function findTaskById(id) {
  const col = tasksCollection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  return col.findOne({ _id });
}

async function updateTask(id, update) {
  const col = tasksCollection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const res = await col.findOneAndUpdate({ _id }, { $set: update }, { returnDocument: "after" });
  return res.value;
}

async function pushTaskStep(id, step) {
  // step: { name, success, output, metadata, timestamp }
  const col = tasksCollection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const res = await col.findOneAndUpdate({ _id }, { $push: { steps: step } }, { returnDocument: "after" });
  return res.value;
}

module.exports = { connect, getDb, insertTask, findTasks, findTaskById, updateTask, pushTaskStep, ObjectId };
