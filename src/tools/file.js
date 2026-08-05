const fs = require("fs").promises;
const path = require("path");
const { log } = require("../utils/logger");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function write(filePath, content) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.writeFile(filePath, content, "utf8");
  log("Wrote file", filePath);
}

async function read(filePath) {
  return fs.readFile(filePath, "utf8");
}

module.exports = { write, read, ensureDir };
