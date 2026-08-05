const { runCmd } = require("../tools/terminal");
const { log } = require("../utils/logger");

/**
 * Very small reviewer: runs linters (if present) and summarises.
 */
class ReviewerAgent {
  async run(task = {}) {
    const workspace = task.workspace || process.env.WORKSPACE_ROOT || "./workspace";
    // Try eslint if present, else say no linter
    try {
      const res = await runCmd("npx eslint . || true", workspace, 30000);
      return { success: true, output: res.stdout + "\n" + res.stderr };
    } catch (e) {
      log("Reviewer error", e);
      return { success: false, output: String(e) };
    }
  }
}

module.exports = ReviewerAgent;
