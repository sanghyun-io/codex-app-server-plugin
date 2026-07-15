import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { requestRuntime, runtimePaths } from "../bin/lib/runtime-ipc.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(TEST_DIR, "../bin/codex-review.mjs");
const FAKE_CODEX = resolve(TEST_DIR, "fake-codex.mjs");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codex-v3-cli-home-"));
  const reviewDir = join(home, "reviews");
  const runtimeDir = join(home, ".claude", "codex-runtime", "v3");
  return {
    home,
    reviewDir,
    runtimeDir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_BINARY: FAKE_CODEX,
      CODEX_REVIEW_RUNTIME_DIR: runtimeDir,
      CODEX_REVIEW_NO_BROKER: "1",
      FAKE_TURN_DELAY_MS: "50",
      FAKE_DELTA_INTERVAL_MS: "5",
      FAKE_TURN_TEXT: "v3 cli result",
    },
  };
}

function cli(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function poll(sessionId, reviewDir, env, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    result = cli(["status", "--session", sessionId, "--review-dir", reviewDir], env);
    if (result.exit !== 7) return result;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`poll timed out: ${JSON.stringify(result)}`);
}

test("background CLI commands use the v3 supervisor by default", async t => {
  const fx = fixture();
  t.after(async () => {
    try { await requestRuntime("shutdown-if-idle", {}, { runtimeDir: fx.runtimeDir }); } catch { /* already stopped */ }
  });
  const prompt = join(fx.home, "prompt.txt");
  const output = join(fx.home, "output.txt");
  writeFileSync(prompt, "Review through v3.", "utf8");

  const started = cli([
    "start", prompt, output,
    "--session", "cli-session",
    "--review-dir", fx.reviewDir,
    "--cwd", process.cwd(),
  ], fx.env);

  assert.equal(started.exit, 0, started.stderr);
  assert.equal(existsSync(runtimePaths(fx.runtimeDir).endpointFile), true);
  assert.equal(existsSync(join(fx.home, ".claude", "tmp", "broker.port")), false);
  const terminal = await poll("cli-session", fx.reviewDir, fx.env);
  assert.equal(terminal.exit, 0, terminal.stderr);
  const status = JSON.parse(terminal.stdout);
  assert.equal(status.status, "completed");
  assert.equal(status.schemaVersion, 3);
  assert.equal(readFileSync(output, "utf8"), "v3 cli result");

  const listed = cli(["list", "--review-dir", fx.reviewDir], fx.env);
  assert.equal(listed.exit, 0, listed.stderr);
  const jobs = JSON.parse(listed.stdout).jobs;
  assert.equal(jobs.some(job => job.sessionId === "cli-session" && job.status === "completed"), true);
});

test("follow-up preserves the v3 thread and project binding", async t => {
  const fx = fixture();
  t.after(async () => {
    try { await requestRuntime("shutdown-if-idle", {}, { runtimeDir: fx.runtimeDir }); } catch { /* already stopped */ }
  });
  const firstPrompt = join(fx.home, "first.txt");
  const secondPrompt = join(fx.home, "second.txt");
  const firstOutput = join(fx.home, "first.out");
  const secondOutput = join(fx.home, "second.out");
  writeFileSync(firstPrompt, "First turn", "utf8");
  writeFileSync(secondPrompt, "Second turn", "utf8");

  assert.equal(cli(["start", firstPrompt, firstOutput, "--session", "thread-session", "--review-dir", fx.reviewDir, "--model", "gpt-5.6-sol"], fx.env).exit, 0);
  const first = JSON.parse((await poll("thread-session", fx.reviewDir, fx.env)).stdout);
  assert.equal(cli(["follow-up", secondPrompt, secondOutput, "--session", "thread-session", "--review-dir", fx.reviewDir], fx.env).exit, 0);
  const second = JSON.parse((await poll("thread-session", fx.reviewDir, fx.env)).stdout);

  assert.equal(second.threadId, first.threadId);
  assert.equal(second.model, "gpt-5.6-sol");
  assert.equal(second.status, "completed");
  assert.equal(readFileSync(secondOutput, "utf8"), "v3 cli result");
});
