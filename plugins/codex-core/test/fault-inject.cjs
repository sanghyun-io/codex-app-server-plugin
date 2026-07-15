const fs = require("node:fs");
const readline = require("node:readline");
const { syncBuiltinESMExports } = require("node:module");

const isReviewWorker = process.argv.includes("--worker");
let remainingProgressRenameFailures = Number.parseInt(
  process.env.CODEX_TEST_PROGRESS_RENAME_FAILURES || "0",
  10,
);

const originalRenameSync = fs.renameSync;
fs.renameSync = function injectedRenameSync(source, destination) {
  if (
    isReviewWorker
    && remainingProgressRenameFailures > 0
    && String(destination).endsWith("_progress.json")
  ) {
    remainingProgressRenameFailures -= 1;
    const error = new Error(
      `EPERM: operation not permitted, rename '${source}' -> '${destination}'`,
    );
    Object.assign(error, {
      errno: -4048,
      code: "EPERM",
      syscall: "rename",
      path: source,
      dest: destination,
    });
    throw error;
  }
  return originalRenameSync.apply(this, arguments);
};

const originalCreateInterface = readline.createInterface;
let readlineErrorSignal = isReviewWorker
  ? process.env.CODEX_TEST_READLINE_ERROR_SIGNAL || ""
  : "";

readline.createInterface = function injectedCreateInterface(...args) {
  const rl = originalCreateInterface.apply(this, args);
  if (!readlineErrorSignal) return rl;

  const signalPath = readlineErrorSignal;
  readlineErrorSignal = "";
  const timer = setInterval(() => {
    if (!fs.existsSync(signalPath)) return;
    clearInterval(timer);
    const error = new Error("read ECONNRESET");
    Object.assign(error, {
      errno: -4077,
      code: "ECONNRESET",
      syscall: "read",
    });
    rl.emit("error", error);
  }, 10);
  timer.unref();
  rl.once("close", () => clearInterval(timer));
  return rl;
};

syncBuiltinESMExports();
