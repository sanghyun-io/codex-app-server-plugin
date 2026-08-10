#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendEvent, createJob, recoverJobs } from "./lib/job-store.mjs";
import { JobScheduler } from "./lib/job-scheduler.mjs";
import { planFollowUp } from "./lib/follow-up.mjs";
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

function configuredRetryDelays() {
  const parsed = String(process.env.CODEX_REVIEW_RETRY_DELAYS_MS || "1000,3000,10000")
    .split(",")
    .map(value => Number(value.trim()));
  return parsed.length === 3 && parsed.every(value => Number.isFinite(value) && value >= 0)
    ? parsed
    : [1_000, 3_000, 10_000];
}

function configuredCancelGrace() {
  const value = Number(process.env.CODEX_REVIEW_CANCEL_GRACE_MS || 5_000);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 30_000) : 5_000;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommandLine(pid) {
  if (!isProcessAlive(pid)) return null;
  if (process.platform === "win32") {
    const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        return execFileSync(executable, [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
        ], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2_000,
          windowsHide: true,
        });
      } catch { /* try the other PowerShell host */ }
    }
    return null;
  }
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { return null; }
  }
}

function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
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
  const retryTimers = new Map();
  const cancelTimers = new Map();
  const retryDelays = configuredRetryDelays();
  let recoveredJobs = recoverJobs(runtimeDir);
  let refreshTimer = null;
  let server;
  let closing = false;
  let scheduleCancelEscalation = () => {};
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
      const scheduledRetry = retryTimers.get(state.jobId);
      if (scheduledRetry && state.generation > scheduledRetry.fromGeneration) {
        if (scheduledRetry.timer) clearTimeout(scheduledRetry.timer);
        retryTimers.delete(state.jobId);
      }
      if (["completed", "cancelled", "failed"].includes(state.status)) {
        const retryTimer = retryTimers.get(state.jobId)?.timer;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimers.delete(state.jobId);
        const cancelTimer = cancelTimers.get(state.jobId);
        if (cancelTimer) clearTimeout(cancelTimer);
        cancelTimers.delete(state.jobId);
        scheduler.complete(state.jobId, state.status);
        workerProcesses.delete(state.jobId);
        continue;
      }
      const workerLost = ["starting", "running"].includes(state.status)
        && state.pid
        && !isProcessAlive(Number(state.pid));
      if (state.cancelRequested
        && ["starting", "running"].includes(state.status)
        && state.pid
        && isProcessAlive(Number(state.pid))) {
        scheduleCancelEscalation(state);
      }
      if ((state.status === "recovering" || workerLost) && !retryTimers.has(state.jobId)) {
        if (state.cancelRequested) {
          appendEvent(state.supervisorEventsPath, { type: "cancelled" });
          scheduler.complete(state.jobId, "cancelled");
          continue;
        }
        if (state.generation > retryDelays.length) {
          appendEvent(state.supervisorEventsPath, {
            type: "failed",
            error: `Automatic recovery exhausted after ${state.generation} attempts`,
          });
          scheduler.complete(state.jobId, "failed");
          continue;
        }
        const delayMs = retryDelays[Math.max(0, state.generation - 1)];
        const timer = setTimeout(() => {
          const latest = stateFor({ jobId: state.jobId });
          if (!latest || ["completed", "cancelled", "failed"].includes(latest.status)) {
            retryTimers.delete(state.jobId);
            return;
          }
          spawnJob(latest);
        }, delayMs);
        retryTimers.set(state.jobId, { timer, fromGeneration: state.generation });
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

  scheduleCancelEscalation = state => {
    if (cancelTimers.has(state.jobId)) return;
    const identity = {
      generation: Number(state.generation),
      pid: Number(state.pid),
      nonce: state.nonce,
    };
    if (!identity.pid || !identity.nonce) return;
    const timer = setTimeout(() => {
      cancelTimers.delete(state.jobId);
      const latest = stateFor({ jobId: state.jobId });
      if (!latest || ["completed", "cancelled", "failed"].includes(latest.status)) return;
      if (Number(latest.generation) !== identity.generation
        || Number(latest.pid) !== identity.pid
        || latest.nonce !== identity.nonce) return;
      const managed = workerProcesses.get(state.jobId);
      const managedIdentityMatches = managed
        && managed.generation === identity.generation
        && managed.nonce === identity.nonce
        && managed.child.pid === identity.pid
        && managed.child.exitCode === null;
      const commandLine = managedIdentityMatches ? identity.nonce : readProcessCommandLine(identity.pid);
      if (!commandLine?.includes(identity.nonce)) return;
      try { terminateProcessTree(identity.pid); } catch { /* refresh records cancellation if it exited */ }
      setTimeout(refreshScheduler, 50);
    }, configuredCancelGrace());
    cancelTimers.set(state.jobId, timer);
  };

  scheduler = new JobScheduler({ concurrency: configuredConcurrency(), spawnJob });
  scheduler.restore(recoveredJobs);
  refreshTimer = setInterval(refreshScheduler, 100);
  refreshTimer.unref?.();

  const close = async () => {
    if (closing) return;
    closing = true;
    if (refreshTimer) clearInterval(refreshTimer);
    for (const retry of retryTimers.values()) {
      if (retry.timer) clearTimeout(retry.timer);
    }
    retryTimers.clear();
    for (const timer of cancelTimers.values()) clearTimeout(timer);
    cancelTimers.clear();
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
          const sessionJobs = recoverJobs(runtimeDir)
            .filter(job => job.sessionId === request.sessionId)
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
          const activeSessionJob = sessionJobs.find(job =>
            !["completed", "cancelled", "failed"].includes(job.status));
          // A turn already in flight owns the thread; neither a fresh start nor a
          // resume can run concurrently with it.
          if (activeSessionJob) {
            const error = new Error(
              `Session ${request.sessionId} already has active job ${activeSessionJob.jobId}`,
            );
            error.code = "SESSION_BUSY";
            throw error;
          }
          if (request.command === "follow-up" && !request.threadId) {
            const plan = planFollowUp(sessionJobs, request);
            if (plan.error) {
              const error = new Error(plan.error.message);
              error.code = plan.error.code;
              throw error;
            }
            request.threadId = plan.threadId;
            request.model = plan.model;
            request.effort = plan.effort;
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
        case "cancel": {
          const state = stateFor(message.params);
          if (!state) {
            const error = new Error("Job not found");
            error.code = "JOB_NOT_FOUND";
            throw error;
          }
          if (["completed", "cancelled", "failed"].includes(state.status)) return state;
          const disposition = scheduler.cancel(state.jobId);
          writeFileSync(resolve(state.jobDir, "cancel.requested"), `${new Date().toISOString()}\n`, "utf8");
          appendEvent(state.supervisorEventsPath, {
            type: disposition === "queued" ? "cancelled" : "cancel_requested",
          });
          if (disposition === "active") scheduleCancelEscalation(state);
          return { ...state, status: "cancelled", cancelRequested: true };
        }
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
