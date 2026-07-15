import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { test } from "node:test";

import {
  acquireStartupLock,
  createRuntimeServer,
  releaseStartupLock,
  requestRuntime,
  runtimePaths,
} from "../bin/lib/runtime-ipc.mjs";

function tempRuntime() {
  return mkdtempSync(join(tmpdir(), "codex-v3-ipc-"));
}

function openClient(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint, () => resolve(socket));
    socket.once("error", reject);
  });
}

test("runtimePaths creates a platform-local IPC endpoint", () => {
  const paths = runtimePaths(tempRuntime());

  if (process.platform === "win32") {
    assert.match(paths.endpoint, /^\\\\\.\\pipe\\codex-review-v3-/);
  } else {
    assert.equal(paths.endpoint.endsWith("supervisor.sock"), true);
  }
  assert.equal(paths.endpointFile.endsWith("endpoint.json"), true);
  assert.equal(paths.lockFile.endsWith("startup.lock"), true);
});

test("authenticated requests receive correlated responses", async t => {
  const runtimeDir = tempRuntime();
  const server = await createRuntimeServer({
    runtimeDir,
    token: "correct-token",
    onRequest: async message => ({ echoed: message.params.value }),
  });
  t.after(() => server.close());

  const response = await requestRuntime("echo", { value: 42 }, {
    runtimeDir,
    token: "correct-token",
  });

  assert.deepEqual(response, { echoed: 42 });
});

test("an invalid runtime token is rejected without terminating the server", async t => {
  const runtimeDir = tempRuntime();
  const server = await createRuntimeServer({
    runtimeDir,
    token: "correct-token",
    onRequest: async () => ({ ok: true }),
  });
  t.after(() => server.close());

  await assert.rejects(
    requestRuntime("ping", {}, { runtimeDir, token: "wrong-token" }),
    /Unauthorized runtime client/,
  );
  assert.deepEqual(
    await requestRuntime("ping", {}, { runtimeDir, token: "correct-token" }),
    { ok: true },
  );
});

test("malformed frames and reset clients do not crash the runtime server", async t => {
  const runtimeDir = tempRuntime();
  const server = await createRuntimeServer({
    runtimeDir,
    token: "token",
    onRequest: async () => ({ alive: true }),
  });
  t.after(() => server.close());

  const malformed = await openClient(server.endpoint);
  malformed.end('{"broken\n');
  const reset = await openClient(server.endpoint);
  reset.write('{"partial":true');
  reset.resetAndDestroy();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.deepEqual(
    await requestRuntime("ping", {}, { runtimeDir, token: "token" }),
    { alive: true },
  );
});

test("only one caller owns the supervisor startup lock", () => {
  const runtimeDir = tempRuntime();
  const first = acquireStartupLock(runtimeDir, { nonce: "first", pid: process.pid });
  const second = acquireStartupLock(runtimeDir, { nonce: "second", pid: process.pid });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(releaseStartupLock(runtimeDir, "second"), false);
  assert.equal(releaseStartupLock(runtimeDir, "first"), true);
});

test("a stale startup lock can be replaced", () => {
  const runtimeDir = tempRuntime();
  const paths = runtimePaths(runtimeDir);
  writeFileSync(paths.lockFile, JSON.stringify({ pid: 99999999, nonce: "stale" }), "utf8");

  const lock = acquireStartupLock(runtimeDir, { nonce: "fresh", pid: process.pid });

  assert.equal(lock.acquired, true);
  assert.equal(releaseStartupLock(runtimeDir, "fresh"), true);
});
