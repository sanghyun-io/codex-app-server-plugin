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
  return mkdtempSync(join(tmpdir(), "codex-v3-recovery-"));
}

function launch(runtimeDir, env = {}) {
  return spawn(process.execPath, [SUPERVISOR, "--runtime", runtimeDir], {
    env: {
      ...process.env,
      CODEX_BINARY: FAKE_CODEX,
      CODEX_REVIEW_RETRY_DELAYS_MS: "50,100,150",
      FAKE_TURN_DELAY_MS: "100",
      FAKE_DELTA_INTERVAL_MS: "10",
      ...env,
    },
    stdio: "ignore",
    windowsHide: true,
  });
}

async function waitUntil(read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    try { value = await read(); } catch { /* runtime replacement window */ }
    if (predicate(value)) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`condition timed out; last value: ${JSON.stringify(value)}`);
}

async function ready(runtimeDir) {
  await waitUntil(async () => existsSync(runtimePaths(runtimeDir).endpointFile), Boolean);
}

function request(sessionId, outputPath) {
  return {
    command: "start",
    sessionId,
    prompt: "Recover this long turn.",
    outputPath,
    model: "gpt-5.6-terra",
    effort: "high",
    timeoutMs: 10_000,
    projectRoot: process.cwd(),
    ownerSessionId: sessionId,
  };
}

test("an app-server crash replays only the current turn in a new generation", async t => {
  const runtimeDir = tempRuntime();
  const exitOnceFile = join(runtimeDir, "exit-once.marker");
  const outputPath = join(runtimeDir, "result.txt");
  const supervisor = launch(runtimeDir, {
    FAKE_EXIT_ONCE_FILE: exitOnceFile,
    FAKE_TURN_TEXT: "complete after recovery",
  });
  t.after(() => { if (supervisor.exitCode === null) supervisor.kill(); });
  await ready(runtimeDir);

  const submitted = await requestRuntime("submit", request("recovery-session", outputPath), { runtimeDir });
  const terminal = await waitUntil(
    () => requestRuntime("status", { jobId: submitted.jobId }, { runtimeDir }),
    value => value?.status === "completed",
  );

  assert.equal(terminal.generation, 2);
  assert.equal(readFileSync(outputPath, "utf8"), "complete after recovery");
});

test("a worker continues while the supervisor is replaced", async t => {
  const runtimeDir = tempRuntime();
  const outputPath = join(runtimeDir, "survived.txt");
  let supervisor = launch(runtimeDir, {
    FAKE_TURN_DELAY_MS: "800",
    FAKE_TURN_TEXT: "survived supervisor replacement",
  });
  t.after(() => { if (supervisor.exitCode === null) supervisor.kill(); });
  await ready(runtimeDir);
  const submitted = await requestRuntime("submit", request("replacement-session", outputPath), { runtimeDir });
  await waitUntil(
    () => requestRuntime("status", { jobId: submitted.jobId }, { runtimeDir }),
    value => value?.status === "running",
  );

  supervisor.kill();
  await waitUntil(async () => supervisor.exitCode !== null, Boolean);
  supervisor = launch(runtimeDir);
  await ready(runtimeDir);

  const terminal = await waitUntil(
    () => requestRuntime("status", { jobId: submitted.jobId }, { runtimeDir }),
    value => value?.status === "completed",
  );
  assert.equal(terminal.generation, 1);
  assert.equal(readFileSync(outputPath, "utf8"), "survived supervisor replacement");
});
