const { complete } = require("../utils/llm");
const { write, ensureDir } = require("../tools/file");
const { log } = require("../utils/logger");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs").promises;

/**
 * Very small coder agent prototype:
 * - ask LLM for file content and write files into workspace
 */
class CoderAgent {
  constructor(config = {}) {
    this.config = config;
    this.name = "coder";
  }

  async run(task = {}) {
    const prompt = task.prompt || "Make a minimal change";
    const workspace = task.workspace || process.env.WORKSPACE_ROOT || "./workspace";
    try {
      // ensure workspace
      await ensureDir(workspace);

      const resp = await complete(`Provide a file change in this format:\n---\npath: <path>\ncontent:\n\`\`\`\n<file content>\n\`\`\`\n---\nYou may return multiple sections. Task: ${prompt}`, { maxTokens: 800 });
      const text = resp.text || "";

      // parse simple sections: path: <path> then code block ```
      const fileWrites = [];
      const sectionRe = /path:\s*([^\n]+)\s*content:\s*```([\s\S]*?)```/g;
      let m;
      while ((m = sectionRe.exec(text)) !== null) {
        const p = m[1].trim();
        const content = m[2];
        const target = path.join(workspace, p);
        await ensureDir(path.dirname(target));
        await write(target, content);
        fileWrites.push({ path: target });
        log("Coder wrote", target);
      }

      // If no matches, write fallback file with content
      if (fileWrites.length === 0) {
        const id = uuidv4().slice(0, 8);
        const target = path.join(workspace, `ai_autogen_${id}.txt`);
        await write(target, text);
        fileWrites.push({ path: target });
        log("Coder wrote fallback file", target);
      }

      return { success: true, output: "Wrote files", artifacts: { files: fileWrites } };
    } catch (e) {
      return { success: false, output: e.message || String(e) };
    }
  }
}

module.exports = CoderAgent;
