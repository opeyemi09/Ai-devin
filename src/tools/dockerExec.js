const { spawn } = require("child_process");
const path = require("path");
const { log, err } = require("../utils/logger");

/**
 * Run a command inside Docker sandbox with resource constraints.
 * - image: docker image to run (e.g., node:18)
 * - workspacePath: host path to mount into /workspace
 * - cmd: command string to run inside container
 * - opts: { timeoutSeconds, cpus, memory, network }
 */
function runInDocker(image, workspacePath, cmd, opts = {}) {
  return new Promise((resolve) => {
    const args = ["run", "--rm", "-v", `${path.resolve(workspacePath)}:/workspace`, "-w", "/workspace"];
    if (opts.cpus) args.unshift("--cpus", opts.cpus);
    if (opts.memory) args.unshift("--memory", opts.memory);
    if (opts.network === false) args.unshift("--network", "none");
    args.push(image, "bash", "-lc", cmd);

    log("docker", args.join(" "));
    const proc = spawn("docker", args);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      log(`docker exited ${code}`);
      resolve({ code, stdout, stderr });
    });

    if (opts.timeoutSeconds) {
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch (e) {
          err("Failed to kill docker process", e);
        }
      }, opts.timeoutSeconds * 1000);
    }
  });
}

module.exports = { runInDocker };
