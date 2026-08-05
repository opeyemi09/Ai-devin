const fs = require("fs").promises;
const path = require("path");
const { complete } = require("../utils/llm");
const { log } = require("../utils/logger");

/**
 * DocAgent: uses LLM to add comments/documentation to code files.
 * It writes a new file next to the original with suffix ".commented.<ext>".
 * To limit cost, it will process at most `maxFiles` (default 5).
 */
class DocAgent {
  constructor(config = {}) {
    this.config = Object.assign({ maxFiles: 5, fileExtensions: [".js", ".ts", ".py", ".jsx", ".tsx"], suffix: ".commented" }, config);
    this.name = "doc-agent";
  }

  async run(task = {}) {
    const workspace = task.workspace || process.env.WORKSPACE_ROOT || "./workspace";
    const maxFiles = this.config.maxFiles;
    try {
      const allFiles = await this._walk(workspace);
      // filter relevant files
      const files = allFiles.filter((f) => this.config.fileExtensions.includes(path.extname(f))).slice(0, maxFiles);
      const artifacts = [];
      for (const filePath of files) {
        try {
          const content = await fs.readFile(filePath, "utf8");
          const prompt = `Add clear, concise inline comments and (where helpful) short docstrings to the following code. Preserve original code; return the full file contents including comments. Do not add extraneous text or explanations beyond the code.\n\n---\nFILE PATH: ${path.relative(workspace, filePath)}\n---\n${content}\n\nReturn only the new file contents.`;
          const resp = await complete(prompt, { maxTokens: 1200 });
          const newContent = resp.text || "";
          // write new file: originalname + .commented + ext
          const dir = path.dirname(filePath);
          const base = path.basename(filePath, path.extname(filePath));
          const newName = `${base}${this.config.suffix}${path.extname(filePath)}`;
          const target = path.join(dir, newName);
          await fs.writeFile(target, newContent, "utf8");
          artifacts.push({ original: filePath, commented: target });
          log("DocAgent wrote", target);
        } catch (e) {
          log("DocAgent failed for file", filePath, e.message || e);
        }
      }
      return { success: true, output: `Processed ${artifacts.length} files`, artifacts };
    } catch (e) {
      return { success: false, output: e.message || String(e) };
    }
  }

  // recursively walk directory, return file paths
  async _walk(dir) {
    let results = [];
    const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of list) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this._walk(full);
        results = results.concat(sub);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
    return results;
  }
}

module.exports = DocAgent;
