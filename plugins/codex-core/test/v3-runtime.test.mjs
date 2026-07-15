import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { requestRuntime, runtimePaths } from "../bin/lib/runtime-ipc.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(TEST_DIR, "../bin/supervisor.mjs");
const FAKE_CODEX = resolve(TEST_DIR, "fake-codex.mjs");

function tempRuntime() {
  return mkdtempSync(join(tmpdir(), "codex-v3-runtime-"));
}

async function waitUntil(read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    try { value = await read(); } catch { /* supervisor may still be starting */ }
    if (predicate(value)) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`condition timed out; last value: ${JSON.stringify(value)}`);
}

function startSupervisor(runtimeDir, env = {}) {
  return spawn(process.execPath, [SUPERVISOR, "--runtime", runtimeDir], {
    env: {
      ...process.env,
      CODEX_BINARY: FAKE_CODEX,
      CODEX_REVIEW_CONCURRENCY: "2",
      FAKE_TURN_DELAY_MS: "300",
      FAKE_DELTA_INTERVAL_MS: "5",
      ...env,
    },
    stdio: "ignore",
    windowsHide: true,
  });
}

function submission(sessionId, outputPath) {
  return {
    command: "start",
    sessionId,
    prompt: `Review ${sessionId}`,
    outputPath,
    model: "gpt-5.6-terra",
    effort: "high",
    timeoutMs: 10_000,
    projectRoot: process.cwd(),
    ownerSessionId: sessionId,
  };
}

test("the supervisor dispatches isolated jobs with FIFO overflow", async t => {
  const runtimeDir = tempRuntime();
  const supervisor = startSupervisor(runtimeDir);
  t.after(async () => {
    try { await requestRuntime("shutdown-if-idle", {}, { runtimeDir }); } catch { /* already gone */ }
    if (supervisor.exitCode === null) supervisor.kill();
  });
  await waitUntil(
    async () => existsSync(runtimePaths(runtimeDir).endpointFile),
    Boolean,
  );

  const outputs = [1, 2, 3].map(index => join(runtimeDir, `result-${index}.txt`));
  const submitted = [];
  for (let index = 0; index < outputs.length; index += 1) {
    submitted.push(await requestRuntime("submit", submission(`claude-${index + 1}`, outputs[index]), { runtimeDir }));
  }

  const listed = await requestRuntime("list", {}, { runtimeDir });
  assert.equal(listed.active.length, 2);
  assert.equal(listed.queued.length, 1);
  assert.equal(listed.queued[0].jobId, submitted[2].jobId);

  for (let index = 0; index < submitted.length; index += 1) {
    const terminal = await waitUntil(
      () => requestRuntime("status", { jobId: submitted[index].jobId }, { runtimeDir }),
      value => value?.status === "completed",
    );
    assert.match(terminal.threadId, /^fake-thread-/);
    assert.equal(readFileSync(outputs[index], "utf8").includes(`Review claude-${index + 1}`), false);
  }
  assert.equal(existsSync(join(runtimeDir, "broker.port")), false);
});

test("the supervisor rejects a second active start for the same session", async t => {
  const runtimeDir = tempRuntime();
  const supervisor = startSupervisor(runtimeDir, { FAKE_TURN_DELAY_MS: "2000" });
  t.after(async () => {
    try {
      const jobs = await requestRuntime("list", {}, { runtimeDir });
      for (const job of [...jobs.active, ...jobs.queued]) {
        await requestRuntime("cancel", { jobId: job.jobId }, { runtimeDir });
      }
    } catch { /* already gone */ }
    if (supervisor.exitCode === null) supervisor.kill();
  });
  await waitUntil(async () => existsSync(runtimePaths(runtimeDir).endpointFile), Boolean);

  await requestRuntime("submit", submission("same-session", join(runtimeDir, "first.txt")), { runtimeDir });
  await assert.rejects(
    requestRuntime("submit", submission("same-session", join(runtimeDir, "second.txt")), { runtimeDir }),
    error => error.code === "SESSION_BUSY",
  );
});
