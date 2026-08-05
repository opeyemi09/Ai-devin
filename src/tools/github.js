const { Octokit } = require("@octokit/rest");
const { log } = require("../utils/logger");

const token = process.env.GH_PAT;
let octokit = null;

if (token) {
  octokit = new Octokit({ auth: token });
} else {
  log("GH_PAT not set — GitHub operations will fail until configured.");
}

/**
 * Create a pull request using Octokit.
 */
async function createPullRequest(owner, repo, head, base, title, body) {
  if (!octokit) throw new Error("Octokit not configured. Set GH_PAT in environment.");
  const resp = await octokit.pulls.create({ owner, repo, head, base, title, body });
  return resp.data;
}

module.exports = { createPullRequest };
