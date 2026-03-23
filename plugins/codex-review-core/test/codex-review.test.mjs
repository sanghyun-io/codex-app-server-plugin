#!/usr/bin/env node

/**
 * Integration tests for codex-review.mjs v2.
 *
 * Uses a fake codex app-server injected via PATH override.
 * Run: node --test test/codex-review.test.mjs
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "../bin/codex-review.mjs");
const FAKE_DIR = __dirname;
const PATH_WITH_FAKE = `${FAKE_DIR}:${process.env.PATH}`;
const TEST_DIR = resolve(__dirname, ".test-tmp");

let sessionCounter = 0;
function newSid() { return `test_${Date.now()}_${++sessionCounter}`; }

function cli(args, opts = {}) {
  const env = {
    ...process.env,
    PATH: PATH_WITH_FAKE,
    FAKE_TURN_DELAY_MS: String(opts.turnDelay ?? 100),
    FAKE_TURN_TEXT: opts.turnText ?? "Test output.\n\n[VERDICT] - APPROVE",
    ...(opts.turnFail ? { FAKE_TURN_FAIL: opts.turnFail } : {}),
    ...(opts.authFail ? { FAKE_AUTH_FAIL: "1" } : {}),
  };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env, timeout: opts.timeout ?? 15_000, encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exit: 0, stdout, stderr: "" };
  } catch (err) {
    return { exit: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Setup ----

before(() => {
  const link = resolve(FAKE_DIR, "codex");
  if (!existsSync(link)) symlinkSync(resolve(FAKE_DIR, "fake-codex.sh"), link);
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---- Tests ----

describe("foreground mode", () => {
  let sid, prompt, output;
  beforeEach(() => {
    sid = newSid();
    prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "Review this code.", "utf8");
  });

  it("completes a turn and writes output", () => {
    const r = cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground"]);
    assert.equal(r.exit, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(output));
    assert.ok(readFileSync(output, "utf8").includes("APPROVE"));
  });

  it("saves thread state with turnCount", () => {
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground"]);
    const state = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    assert.ok(state.threadId);
    assert.equal(state.turnCount, 1);
  });

  it("follow-up reuses thread and increments turnCount", () => {
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground"]);
    const fu_p = resolve(TEST_DIR, `${sid}_fu_p.txt`);
    const fu_o = resolve(TEST_DIR, `${sid}_fu_o.txt`);
    writeFileSync(fu_p, "Follow-up prompt.", "utf8");

    const r = cli(["follow-up", fu_p, fu_o, "--session", sid, "--review-dir", TEST_DIR, "--foreground"]);
    assert.equal(r.exit, 0, `stderr: ${r.stderr}`);
    const state = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    assert.equal(state.turnCount, 2);
  });

  it("close removes state file", () => {
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground"]);
    cli(["close", "--session", sid, "--review-dir", TEST_DIR]);
    assert.ok(!existsSync(resolve(TEST_DIR, `${sid}_state.json`)));
  });
});

describe("background mode", () => {
  let sid, prompt, output;
  beforeEach(() => {
    sid = newSid();
    prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "Review this code.", "utf8");
  });

  it("start returns immediately and creates PID + progress files", () => {
    const r = cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR]);
    assert.equal(r.exit, 0);
    // Progress file should exist
    assert.ok(existsSync(resolve(TEST_DIR, `${sid}_progress.json`)));
  });

  it("PID file contains pid and nonce", () => {
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR]);
    const pidPath = resolve(TEST_DIR, `${sid}_pid`);
    assert.ok(existsSync(pidPath));
    const data = readJson(pidPath);
    assert.ok(data.pid > 0);
    assert.equal(typeof data.nonce, "string");
    assert.equal(data.nonce.length, 16);
  });

  it("status → polling → completed", async () => {
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR], { turnDelay: 300 });

    let completed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const r = cli(["status", "--session", sid, "--review-dir", TEST_DIR]);
      if (r.exit === 0) {
        const progress = JSON.parse(r.stdout);
        assert.equal(progress.status, "completed");
        completed = true;
        break;
      }
      assert.ok([7].includes(r.exit), `Unexpected exit ${r.exit}: ${r.stderr}`);
    }
    assert.ok(completed, "Should complete within 15s");
    assert.ok(existsSync(output));
    assert.ok(readFileSync(output, "utf8").includes("APPROVE"));
  });

  it("cancel stops running worker", async () => {
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR], { turnDelay: 10000 });
    await sleep(500);

    const r = cli(["cancel", "--session", sid, "--review-dir", TEST_DIR]);
    assert.equal(r.exit, 0);

    // PID file should be cleaned up
    await sleep(500);
    assert.ok(!existsSync(resolve(TEST_DIR, `${sid}_pid`)));
  });
});

describe("error handling", () => {
  it("exit 6 for missing prompt file", () => {
    const r = cli(["start", "/no/such/file.txt", "/tmp/out.txt", "--session", "x", "--review-dir", TEST_DIR]);
    assert.equal(r.exit, 6);
  });

  it("status exit 6 for unknown session", () => {
    const r = cli(["status", "--session", "nonexistent", "--review-dir", TEST_DIR]);
    assert.equal(r.exit, 6);
  });

  it("foreground exits 2 for auth failure", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "test", "utf8");
    const r = cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground"], { authFail: true });
    assert.equal(r.exit, 2);
  });
});

describe("model reuse fix (#2)", () => {
  it("follow-up without --model preserves state.model", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "test", "utf8");

    // Start with explicit model
    cli(["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground", "--model", "custom-model"]);
    const state1 = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    assert.equal(state1.model, "custom-model");

    // Follow-up without --model
    const fu_p = resolve(TEST_DIR, `${sid}_fu.txt`);
    const fu_o = resolve(TEST_DIR, `${sid}_fuo.txt`);
    writeFileSync(fu_p, "follow-up", "utf8");
    cli(["follow-up", fu_p, fu_o, "--session", sid, "--review-dir", TEST_DIR, "--foreground"]);

    // State model should remain custom-model (not overwritten by default)
    const state2 = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    assert.equal(state2.model, "custom-model", "Model should be preserved from initial start");
  });
});
