import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createJob, readEvents, recoverJobs } from "../bin/lib/job-store.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(TEST_DIR, "../bin/job-worker.mjs");
const FAKE_CODEX = resolve(TEST_DIR, "fake-codex.mjs");

function tempRuntime() {
  return mkdtempSync(join(tmpdir(), "codex-v3-worker-"));
}

function runWorker(runtimeDir, jobId, env = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [
      WORKER,
      "--runtime", runtimeDir,
      "--job", jobId,
      "--generation", "1",
      "--nonce", "worker-test-nonce",
    ], {
      env: {
        ...process.env,
        CODEX_BINARY: FAKE_CODEX,
        FAKE_TURN_DELAY_MS: "30",
        FAKE_DELTA_INTERVAL_MS: "5",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

test("a job worker completes through its own Codex app-server", async () => {
  const runtimeDir = tempRuntime();
  const job = createJob(runtimeDir, {
    command: "start",
    prompt: "Review this isolated job.",
    model: "gpt-5.6-terra",
    effort: "high",
    timeoutMs: 10_000,
    projectRoot: process.cwd(),
    ownerSessionId: "claude-a",
  }, { jobId: "job_worker_success" });

  const result = await runWorker(runtimeDir, job.jobId, {
    FAKE_TURN_TEXT: "isolated worker result",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(job.jobDir, "result.txt"), "utf8"), "isolated worker result");
  const recovered = recoverJobs(runtimeDir)[0];
  assert.equal(recovered.status, "completed");
  assert.match(recovered.threadId, /^fake-thread-/);
  assert.match(recovered.turnId, /^fake-turn-/);
  assert.equal(existsSync(join(runtimeDir, ".claude", "tmp", "broker.port")), false);
});

test("a worker records lifecycle checkpoints without writing one per delta", async () => {
  const runtimeDir = tempRuntime();
  const text = "x".repeat(600);
  const job = createJob(runtimeDir, {
    command: "start",
    prompt: "Produce many chunks.",
    model: "gpt-5.6-terra",
    effort: "high",
    timeoutMs: 10_000,
    projectRoot: process.cwd(),
  }, { jobId: "job_worker_checkpoints" });

  const result = await runWorker(runtimeDir, job.jobId, {
    FAKE_TURN_TEXT: text,
    FAKE_DELTA_INTERVAL_MS: "1",
  });

  assert.equal(result.code, 0, result.stderr);
  const events = readEvents(join(job.jobDir, "attempts", "0001", "events.jsonl"));
  assert.deepEqual(events.map(event => event.type), ["starting", "running", "completed"]);
  assert.equal(events.at(-1).charsReceived, text.length);
});
