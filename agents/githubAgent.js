const { createPullRequest } = require("../tools/github");
const { log } = require("../utils/logger");

/**
 * Simple github agent wrapper
 * expects task.meta.owner and task.meta.repo
 */
class GithubAgent {
  async run(task = {}) {
    const meta = task.meta || {};
    const owner = meta.owner;
    const repo = meta.repo;
    const head = meta.head || task.branch;
    const base = meta.base || process.env.DEFAULT_BRANCH || "main";
    const title = meta.title || task.commitMessage || "AI proposed change";
    const body = meta.body || "Automated PR created by AI Devin";

    if (!owner || !repo) return { success: false, output: "owner/repo required in task.meta" };
    try {
      const pr = await createPullRequest(owner, repo, head, base, title, body);
      log("Created PR", pr.html_url);
      return { success: true, output: pr.html_url, metadata: { pr } };
    } catch (e) {
      return { success: false, output: e.message || String(e) };
    }
  }
}

module.exports = GithubAgent;
