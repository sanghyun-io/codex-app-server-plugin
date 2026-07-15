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
