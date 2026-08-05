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

function templatesCollection() {
  return getDb().collection("templates");
}

function auditsCollection() {
  return getDb().collection("audits");
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

/* Template helpers */

async function insertTemplate(template) {
  const col = templatesCollection();
  const now = new Date();
  const doc = Object.assign({ createdAt: now, updatedAt: now }, template);
  const res = await col.insertOne(doc);
  return res.insertedId;
}

async function findTemplates(filter = {}, limit = 100) {
  const col = templatesCollection();
  return col.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray();
}

async function findTemplateById(id) {
  const col = templatesCollection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  return col.findOne({ _id });
}

async function updateTemplate(id, update) {
  const col = templatesCollection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  update.updatedAt = new Date();
  const res = await col.findOneAndUpdate({ _id }, { $set: update }, { returnDocument: "after" });
  return res.value;
}

async function deleteTemplate(id) {
  const col = templatesCollection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const res = await col.deleteOne({ _id });
  return res.deletedCount === 1;
}

/* Module plan helpers (existing) */

async function setModulePlan(taskId, plan) {
  const col = tasksCollection();
  const _id = typeof taskId === "string" ? new ObjectId(taskId) : taskId;
  const statuses = (plan || []).map((m) => ({ name: m.name, status: "pending", updatedAt: new Date(0), info: null }));
  const res = await col.findOneAndUpdate({ _id }, { $set: { modulePlan: plan, moduleStatuses: statuses } }, { returnDocument: "after" });
  return res.value;
}

async function getModulePlan(taskId) {
  const task = await findTaskById(taskId);
  return { plan: task && task.modulePlan, statuses: task && task.moduleStatuses };
}

async function updateModuleStatus(taskId, moduleIndex, update) {
  const col = tasksCollection();
  const _id = typeof taskId === "string" ? new ObjectId(taskId) : taskId;
  const key = `moduleStatuses.${moduleIndex}`;
  update.updatedAt = new Date();
  const res = await col.findOneAndUpdate({ _id }, { $set: { [key]: update } }, { returnDocument: "after" });
  return res.value;
}

/* Audit collection helpers (new) */

async function insertAudit(audit) {
  // audit: { taskId, type, action, actor, details, timestamp }
  const col = auditsCollection();
  const now = new Date();
  const doc = Object.assign({ timestamp: now }, audit);
  // normalize taskId to ObjectId if present and looks like string
  if (doc.taskId && typeof doc.taskId === "string") {
    try { doc.taskId = new ObjectId(doc.taskId); } catch (_) { /* leave as-is */ }
  }
  const res = await col.insertOne(doc);
  return res.insertedId;
}

async function findAudits(filter = {}, limit = 200) {
  const col = auditsCollection();
  return col.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
}

module.exports = {
  connect,
  getDb,
  insertTask,
  findTasks,
  findTaskById,
  updateTask,
  pushTaskStep,
  insertTemplate,
  findTemplates,
  findTemplateById,
  updateTemplate,
  deleteTemplate,
  setModulePlan,
  getModulePlan,
  updateModuleStatus,
  insertAudit,
  findAudits,
  ObjectId
};
