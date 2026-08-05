// src/agents/executor.js
const { runInDocker } = require("../tools/dockerExec");
const { log } = require("../utils/logger");

// Basic test-summary helper (naive)
function summarizeTestOutput(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const failed = (combined.match(/fail(ed|ure)|error|FAILED|Traceback/gi) || []).length;
  const passed = (combined.match(/pass(ed)?|OK\b/gi) || []).length;
  return { passed, failed, excerpt: combined.slice(0, 2000) };
}

class ExecutorAgent {
  async run(task = {}) {
    const workspace = task.workspace || process.env.WORKSPACE_ROOT || "./workspace";
    const image = task.sandboxImage || "node:18-slim";
    const cmd = task.testCommand || "npm test || true";
    try {
      const res = await runInDocker(image, workspace, cmd, { timeoutSeconds: 120, cpus: "0.5", memory: "512m", network: false });
      const stdout = res.stdout || "";
      const stderr = res.stderr || "";
      const summary = summarizeTestOutput(stdout, stderr);
      return {
        success: res.code === 0,
        output: `exit=${res.code}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
        metadata: { exitCode: res.code, summary }
      };
    } catch (e) {
      return { success: false, output: String(e), metadata: { error: true } };
    }
  }
}

module.exports = ExecutorAgent;
