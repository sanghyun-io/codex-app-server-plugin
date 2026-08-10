import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerClient } from "../bin/lib/app-server-client.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = resolve(TEST_DIR, "fake-codex.mjs");

test("initialization RPC timeouts are recoverable", async t => {
  const previousBinary = process.env.CODEX_BINARY;
  const previousHang = process.env.FAKE_HANG_METHOD;
  process.env.CODEX_BINARY = FAKE_CODEX;
  process.env.FAKE_HANG_METHOD = "initialize";
  t.after(() => {
    if (previousBinary == null) delete process.env.CODEX_BINARY;
    else process.env.CODEX_BINARY = previousBinary;
    if (previousHang == null) delete process.env.FAKE_HANG_METHOD;
    else process.env.FAKE_HANG_METHOD = previousHang;
  });

  const client = new AppServerClient();
  t.after(() => client.close());
  await client.spawn();

  await assert.rejects(
    client.request("initialize", {}, 20),
    error => error.exitCode === 5 && error.retryable === true,
  );
});

async function connectedClient(t, env) {
  const saved = {};
  for (const [key, value] of Object.entries({ CODEX_BINARY: FAKE_CODEX, ...env })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const client = new AppServerClient();
  t.after(() => client.close());
  await client.spawn();
  await client.initialize();
  return client;
}

test("a transient thread resume failure is retryable", async t => {
  const client = await connectedClient(t, { FAKE_RESUME_FAIL: "temporary upstream glitch" });
  await assert.rejects(
    client.resumeThread("thr-x"),
    error => error.exitCode === 4 && error.retryable === true,
  );
});

test("a missing-rollout thread resume failure is permanent", async t => {
  const client = await connectedClient(t, { FAKE_RESUME_FAIL: "no rollout found for thread thr-x" });
  await assert.rejects(
    client.resumeThread("thr-x"),
    error => error.exitCode === 4 && error.retryable === false,
  );
});

test("startTurn honors an explicit opt-in turn timeout", async t => {
  const client = await connectedClient(t, { FAKE_TURN_DELAY_MS: "5000" });
  const thread = await client.startThread({ model: "gpt-5.6-terra", cwd: process.cwd() });
  await assert.rejects(
    client.startTurn(thread.thread.id, "hello", { model: "gpt-5.6-terra", timeoutMs: 200 }),
    error => error.exitCode === 5,
  );
});

test("startTurn without a timeout imposes no turn-duration cap", async t => {
  // A turn that stays silent past any tiny default still completes — there is no
  // implicit cap; only an explicit options.timeoutMs > 0 arms the timer.
  const client = await connectedClient(t, { FAKE_TURN_DELAY_MS: "600", FAKE_TURN_TEXT: "done" });
  const thread = await client.startThread({ model: "gpt-5.6-terra", cwd: process.cwd() });
  const result = await client.startTurn(thread.thread.id, "hello", { model: "gpt-5.6-terra" });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "done");
});
