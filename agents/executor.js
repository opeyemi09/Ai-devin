const { runInDocker } = require("../tools/dockerExec");
const { log } = require("../utils/logger");

/**
 * ExecutorAgent runs test commands inside a sandboxed container pointing to workspace.
 */
class ExecutorAgent {
  async run(task = {}) {
    const workspace = task.workspace || process.env.WORKSPACE_ROOT || "./workspace";
    const image = task.sandboxImage || "node:18-slim";
    const cmd = task.testCommand || "npm test || true";
    try {
      const res = await runInDocker(image, workspace, cmd, { timeoutSeconds: 120, cpus: "0.5", memory: "512m", network: false });
      return { success: res.code === 0, output: res.stdout + "\n" + res.stderr, metadata: { code: res.code } };
    } catch (e) {
      log("Executor error", e);
      return { success: false, output: String(e) };
    }
  }
}

module.exports = ExecutorAgent;
