const { exec } = require("child_process");
const { log } = require("../utils/logger");

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const cmd = `git ${args.join(" ")}`;
    exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) {
        log("git err:", stderr || err.message);
        return reject(err);
      }
      if (stderr) log("git stderr:", stderr);
      resolve({ stdout, stderr });
    });
  });
}

module.exports = { runGit };
