#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { recoverJobs } from "./lib/job-store.mjs";
import {
  acquireStartupLock,
  createRuntimeServer,
  releaseStartupLock,
} from "./lib/runtime-ipc.mjs";

function parseRuntime(argv) {
  const index = argv.indexOf("--runtime");
  if (index >= 0 && argv[index + 1]) return resolve(argv[index + 1]);
  return resolve(process.env.CODEX_REVIEW_RUNTIME_DIR || homedir(), ".claude", "codex-runtime", "v3");
}

async function main() {
  const runtimeDir = parseRuntime(process.argv.slice(2));
  const nonce = randomBytes(16).toString("hex");
  const lock = acquireStartupLock(runtimeDir, { pid: process.pid, nonce });
  if (!lock.acquired) process.exit(0);

  const recoveredJobs = recoverJobs(runtimeDir);
  let server;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (server) await server.close();
    releaseStartupLock(runtimeDir, nonce);
  };

  server = await createRuntimeServer({
    runtimeDir,
    onRequest: async message => {
      switch (message.action) {
        case "ping":
          return {
            schemaVersion: 3,
            pid: process.pid,
            recoveredJobs: recoveredJobs.length,
          };
        case "shutdown-if-idle":
          setImmediate(() => { void close().then(() => process.exit(0)); });
          return { shuttingDown: true };
        default: {
          const error = new Error(`Unsupported runtime action: ${message.action}`);
          error.code = "UNSUPPORTED_ACTION";
          throw error;
        }
      }
    },
  });

  process.on("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.on("SIGINT", () => { void close().then(() => process.exit(0)); });
}

main().catch(error => {
  console.error(`[supervisor] ${error?.stack || error}`);
  process.exit(1);
});
