#!/usr/bin/env node

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = process.env.LIFECYCLE_SCRIPT
  || resolve(__dirname, "../scripts/session-lifecycle.mjs");
const homes = [];
const children = [];

function makeHome() {
  const home = mkdtempSync(resolve(tmpdir(), "codex-lifecycle-"));
  mkdirSync(resolve(home, ".claude", "tmp"), { recursive: true });
  homes.push(home);
  return home;
}

function runHook(event, { home, envFile, input = {} }) {
  return execFileSync(process.execPath, [LIFECYCLE, event], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_SESSION_ID: "",
      CLAUDE_ENV_FILE: envFile || "",
    },
    input: JSON.stringify(input),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function tmp(home, name) {
  return resolve(home, ".claude", "tmp", name);
}

function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(resolveP => setTimeout(resolveP, 25));
  }
}

function writePid(home, sessionName, pid, ownerSessionId) {
  writeFileSync(
    tmp(home, `${sessionName}_pid`),
    JSON.stringify({
      pid,
      nonce: `nonce-${sessionName}`,
      ...(ownerSessionId ? { ownerSessionId } : {}),
    }),
    "utf8",
  );
}

function writeBrokerPort(home, pid) {
  writeFileSync(
    tmp(home, "broker.port"),
    JSON.stringify({ port: 43123, pid }),
    "utf8",
  );
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    if (child.pid) await waitForExit(child.pid);
  }
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("session lifecycle hook", () => {
  it("reads session_id from hook stdin and exports review ownership", () => {
    const home = makeHome();
    const envFile = resolve(home, "claude-env.sh");

    runHook("start", {
      home,
      envFile,
      input: { session_id: "claude-A", hook_event_name: "SessionStart" },
    });

    assert.ok(existsSync(envFile), "CLAUDE_ENV_FILE should be written");
    assert.match(
      readFileSync(envFile, "utf8"),
      /export CODEX_REVIEW_OWNER_SESSION='claude-A'/,
    );
    assert.ok(existsSync(resolve(home, ".claude", "tmp", "session_claude-A.env")));
    assert.ok(!existsSync(resolve(home, ".claude", "tmp", "session_.env")));
  });

  it("ends only workers owned by the ending Claude session", async () => {
    const home = makeHome();
    const owned = spawnSleeper();
    const foreign = spawnSleeper();
    writePid(home, "rr_owned", owned.pid, "claude-A");
    writePid(home, "rr_foreign", foreign.pid, "claude-B");

    runHook("end", { home, input: { session_id: "claude-A" } });

    await waitForExit(owned.pid);
    assert.equal(isAlive(owned.pid), false, "owned worker should exit");
    assert.equal(isAlive(foreign.pid), true, "foreign worker must stay alive");
    assert.ok(existsSync(tmp(home, "rr_owned_cancel")));
    assert.ok(existsSync(tmp(home, "rr_owned_pid")));
    assert.ok(existsSync(tmp(home, "rr_foreign_pid")));
  });

  it("preserves the shared broker and unowned legacy workers", () => {
    const home = makeHome();
    const broker = spawnSleeper();
    const legacy = spawnSleeper();
    writeBrokerPort(home, broker.pid);
    writePid(home, "rr_legacy", legacy.pid, null);

    runHook("end", { home, input: { session_id: "claude-A" } });

    assert.equal(isAlive(broker.pid), true, "shared broker must stay alive");
    assert.equal(isAlive(legacy.pid), true, "unowned worker must stay alive");
    assert.ok(existsSync(tmp(home, "broker.port")));
    assert.ok(existsSync(tmp(home, "rr_legacy_pid")));
  });

  it("does no destructive cleanup without a session identity", () => {
    const home = makeHome();
    const worker = spawnSleeper();
    writePid(home, "rr_unknown", worker.pid, "claude-A");

    runHook("end", { home, input: {} });

    assert.equal(isAlive(worker.pid), true, "worker must stay alive without hook identity");
    assert.ok(existsSync(tmp(home, "rr_unknown_pid")));
  });
});
