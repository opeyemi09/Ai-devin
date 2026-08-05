const { exec } = require("child_process");
const { log } = require("../utils/logger");

function runCmd(cmd, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, stdout: stdout || "", stderr: stderr || err.message, code: err.code || 1 });
      } else {
        resolve({ success: true, stdout: stdout || "", stderr: stderr || "" });
      }
    });
  });
}

module.exports = { runCmd };
