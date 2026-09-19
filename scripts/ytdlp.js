import { spawn } from "node:child_process";

const JS_RUNTIME = ["--js-runtimes", "node"];

export function runYtDlp(args, { stderr = "ignore", allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      ["--no-warnings", ...JS_RUNTIME, ...args],
      { stdio: ["ignore", "pipe", stderr] },
    );

    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (code === 0 || allowFailure) {
        resolve({ success: code === 0, code, stdout });
      } else {
        reject(new Error(`yt-dlp a échoué (code ${code}) : ${args.join(" ")}`));
      }
    });
  });
}
