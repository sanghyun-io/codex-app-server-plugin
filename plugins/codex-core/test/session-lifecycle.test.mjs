#!/usr/bin/env node

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = process.env.LIFECYCLE_SCRIPT
  || resolve(__dirname, "../scripts/session-lifecycle.mjs");
const homes = [];

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

afterEach(() => {
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
});
