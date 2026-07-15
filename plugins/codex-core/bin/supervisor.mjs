#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendEvent, createJob, recoverJobs } from "./lib/job-store.mjs";
import { JobScheduler } from "./lib/job-scheduler.mjs";
import {
  acquireStartupLock,
  createRuntimeServer,
  releaseStartupLock,
} from "./lib/runtime-ipc.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const JOB_WORKER = resolve(SELF_DIR, "job-worker.mjs");

function configuredConcurrency() {
  const value = Number(process.env.CODEX_REVIEW_CONCURRENCY || 3);
  return Number.isInteger(value) && value > 0 ? value : 3;
}

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

  const workerProcesses = new Map();
  let recoveredJobs = recoverJobs(runtimeDir);
  let refreshTimer = null;
  let server;
  let closing = false;
  const stateFor = params => {
    const states = recoverJobs(runtimeDir);
    if (params?.jobId) return states.find(job => job.jobId === params.jobId) || null;
    if (params?.sessionId) {
      return states
        .filter(job => job.sessionId === params.sessionId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] || null;
    }
    return null;
  };

  let scheduler;
  const refreshScheduler = () => {
    recoveredJobs = recoverJobs(runtimeDir);
    const activeIds = new Set(scheduler.snapshot().active.map(job => job.jobId));
    for (const state of recoveredJobs) {
      if (!activeIds.has(state.jobId)) continue;
      if (["completed", "cancelled", "failed"].includes(state.status)) {
        scheduler.complete(state.jobId, state.status);
        workerProcesses.delete(state.jobId);
      }
    }
  };

  const spawnJob = job => {
    const generation = (Number(job.generation) || 0) + 1;
    const workerNonce = randomBytes(16).toString("hex");
    const child = spawn(process.execPath, [
      JOB_WORKER,
      "--runtime", runtimeDir,
      "--job", job.jobId,
      "--generation", String(generation),
      "--nonce", workerNonce,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    workerProcesses.set(job.jobId, { child, generation, nonce: workerNonce });
    appendEvent(job.supervisorEventsPath, {
      type: "dispatched",
      generation,
      pid: child.pid,
      nonce: workerNonce,
    });
    child.on("exit", () => setTimeout(refreshScheduler, 10));
    child.on("error", () => setTimeout(refreshScheduler, 10));
    child.unref();
  };

  scheduler = new JobScheduler({ concurrency: configuredConcurrency(), spawnJob });
  scheduler.restore(recoveredJobs);
  refreshTimer = setInterval(refreshScheduler, 100);
  refreshTimer.unref?.();

  const close = async () => {
    if (closing) return;
    closing = true;
    if (refreshTimer) clearInterval(refreshTimer);
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
        case "submit": {
          const request = { ...message.params };
          if (request.command === "follow-up" && !request.threadId) {
            const previous = stateFor({ sessionId: request.sessionId });
            if (!previous?.threadId || previous.status !== "completed") {
              const error = new Error(`No completed v3 session to follow up: ${request.sessionId}`);
              error.code = "THREAD_NOT_READY";
              throw error;
            }
            request.threadId = previous.threadId;
          }
          const record = createJob(runtimeDir, request);
          const state = stateFor({ jobId: record.jobId });
          scheduler.enqueue(state);
          return { ...state, status: "queued" };
        }
        case "status": {
          const state = stateFor(message.params);
          if (!state) {
            const error = new Error("Job not found");
            error.code = "JOB_NOT_FOUND";
            throw error;
          }
          return state;
        }
        case "list":
          refreshScheduler();
          return scheduler.snapshot();
        case "shutdown-if-idle": {
          refreshScheduler();
          const snapshot = scheduler.snapshot();
          if (snapshot.active.length || snapshot.queued.length) return { shuttingDown: false };
          setImmediate(() => { void close().then(() => process.exit(0)); });
          return { shuttingDown: true };
        }
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
