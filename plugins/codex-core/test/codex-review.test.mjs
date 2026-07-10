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
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "../bin/codex-review.mjs");
const FAKE_DIR = __dirname;
const FAKE_CODEX = resolve(FAKE_DIR, "fake-codex.mjs");
const TEST_DIR = resolve(__dirname, ".test-tmp");

let sessionCounter = 0;
function newSid() { return `test_${Date.now()}_${++sessionCounter}`; }

function cli(args, opts = {}) {
  const baseEnv = opts.home
    ? { ...process.env, HOME: opts.home, USERPROFILE: opts.home }
    : { ...process.env };
  const env = {
    ...baseEnv,
    CODEX_BINARY: FAKE_CODEX,
    CODEX_REVIEW_MODEL: opts.envModel ?? "",
    FAKE_TURN_DELAY_MS: String(opts.turnDelay ?? 100),
    FAKE_TURN_TEXT: opts.turnText ?? "Test output.\n\n[VERDICT] - APPROVE",
    FAKE_DELTA_INTERVAL_MS: String(opts.deltaInterval ?? 20),
    FAKE_REQUEST_LOG: opts.requestLog ?? "",
    FAKE_MODELS: opts.models !== undefined ? JSON.stringify(opts.models) : "",
    FAKE_MODEL_PAGES: opts.modelPages ? JSON.stringify(opts.modelPages) : "",
    FAKE_MODEL_LIST_UNSUPPORTED: opts.modelListUnsupported ? "1" : "",
    FAKE_TURN_START_REJECT: opts.turnStartReject ?? "",
    FAKE_INTERRUPT_LOG: opts.interruptLog ?? "",
    FAKE_FOREIGN_DELTA: opts.foreignDelta ? "1" : "",
    CODEX_REVIEW_TEST_MODE: opts.testMode ? "1" : "",
    ...(opts.broker ? {} : { CODEX_REVIEW_NO_BROKER: "1" }),
    ...(opts.tagThread ? { FAKE_TAG_THREAD: "1" } : {}),
    ...(opts.turnFail ? { FAKE_TURN_FAIL: opts.turnFail } : {}),
    ...(opts.authFail ? { FAKE_AUTH_FAIL: "1" } : {}),
  };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env, cwd: opts.cwd, timeout: opts.timeout ?? 15_000, encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return { exit: 0, stdout, stderr: "" };
  } catch (err) {
    return { exit: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function readRequests(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
function requestsByMethod(path, method) {
  return readRequests(path).filter(request => request.method === method);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function brokerControl(home, action, params = {}) {
  const portFile = resolve(home, ".claude", "tmp", "broker.port");
  const { port } = readJson(portFile);
  return await new Promise((resolveP, rejectP) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const rl = createInterface({ input: socket });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectP(new Error(`Broker control timed out: ${action}`));
    }, 5000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ action, id: 1, ...params }) + "\n");
    });
    socket.on("error", rejectP);
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.end();
      message.error ? rejectP(message.error) : resolveP(message.result);
    });
  });
}

// ---- Setup ----

before(() => {
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

describe("project binding", () => {
  let repoA, repoB, reviewDir;

  beforeEach(() => {
    const root = resolve(TEST_DIR, `projects_${Date.now()}_${++sessionCounter}`);
    repoA = resolve(root, "repo-a");
    repoB = resolve(root, "repo-b");
    reviewDir = resolve(root, "reviews");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: repo, windowsHide: true });
    }
    mkdirSync(reviewDir, { recursive: true });
  });

  it("sends the canonical project root to thread and turn and persists it", () => {
    const sid = newSid();
    const prompt = resolve(reviewDir, `${sid}_prompt.txt`);
    const output = resolve(reviewDir, `${sid}_output.txt`);
    const requestLog = resolve(reviewDir, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "Review this project.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", reviewDir,
      "--foreground",
    ], { cwd: repoA, requestLog });

    assert.equal(result.exit, 0, result.stderr);
    const expectedRoot = realpathSync.native(repoA);
    assert.equal(requestsByMethod(requestLog, "thread/start")[0]?.params?.cwd, expectedRoot);
    assert.equal(requestsByMethod(requestLog, "turn/start")[0]?.params?.cwd, expectedRoot);
    assert.equal(readJson(resolve(reviewDir, `${sid}_state.json`)).projectRoot, expectedRoot);
  });

  it("rejects follow-up from a different project before thread resume", () => {
    const sid = newSid();
    const prompt = resolve(reviewDir, `${sid}_prompt.txt`);
    const output = resolve(reviewDir, `${sid}_output.txt`);
    writeFileSync(prompt, "Start in repo A.", "utf8");
    const started = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", reviewDir,
      "--foreground",
    ], { cwd: repoA });
    assert.equal(started.exit, 0, started.stderr);

    const followPrompt = resolve(reviewDir, `${sid}_follow_prompt.txt`);
    const followOutput = resolve(reviewDir, `${sid}_follow_output.txt`);
    const requestLog = resolve(reviewDir, `${sid}_follow_requests.jsonl`);
    writeFileSync(followPrompt, "Continue from repo B.", "utf8");
    const followed = cli([
      "follow-up", followPrompt, followOutput,
      "--session", sid,
      "--review-dir", reviewDir,
      "--foreground",
    ], { cwd: repoB, requestLog });

    assert.equal(followed.exit, 6);
    assert.match(followed.stderr, /different project/i);
    assert.equal(requestsByMethod(requestLog, "thread/resume").length, 0);
  });

  it("rejects legacy state without a project root before thread resume", () => {
    const sid = newSid();
    const prompt = resolve(reviewDir, `${sid}_prompt.txt`);
    const output = resolve(reviewDir, `${sid}_output.txt`);
    const requestLog = resolve(reviewDir, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "Continue legacy state.", "utf8");
    writeFileSync(resolve(reviewDir, `${sid}_state.json`), JSON.stringify({
      threadId: "legacy-thread",
      model: "gpt-5.6-terra",
      turnCount: 1,
    }), "utf8");

    const result = cli([
      "follow-up", prompt, output,
      "--session", sid,
      "--review-dir", reviewDir,
      "--foreground",
    ], { cwd: repoA, requestLog });

    assert.equal(result.exit, 6);
    assert.match(result.stderr, /predates project binding/i);
    assert.equal(requestsByMethod(requestLog, "thread/resume").length, 0);
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

  it("explains an unsupported ChatGPT model and lists alternatives", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "test unsupported account routing", "utf8");
    const upstreamError = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      },
    });

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "gpt-5.6-sol",
    ], {
      turnFail: upstreamError,
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    });

    assert.equal(result.exit, 6);
    assert.match(result.stderr, /gpt-5\.6-sol/);
    assert.match(result.stderr, /not supported/i);
    assert.match(result.stderr, /No fallback was performed/);
    assert.match(result.stderr, /gpt-5\.6-terra/);
  });

  it("reports a message-less structured turn rejection without recursion", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "test a structured rejection", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "gpt-5.6-sol",
    ], {
      turnStartReject: JSON.stringify({ code: -32000, data: { reason: "opaque" } }),
      models: ["gpt-5.6-sol"],
    });

    assert.equal(result.exit, 6);
    assert.match(result.stderr, /"code":-32000/);
    assert.doesNotMatch(result.stderr, /call stack/i);
  });
});

describe("broker model error handling", () => {
  const ERROR_BROKER_HOME = resolve(TEST_DIR, "error_broker_home");
  const ERROR_BROKER_TMP = resolve(ERROR_BROKER_HOME, ".claude", "tmp");
  const ERROR_BROKER_PORT_FILE = resolve(ERROR_BROKER_TMP, "broker.port");

  before(() => {
    mkdirSync(ERROR_BROKER_TMP, { recursive: true });
  });

  after(() => {
    if (!existsSync(ERROR_BROKER_PORT_FILE)) return;
    try {
      const data = readJson(ERROR_BROKER_PORT_FILE);
      if (data?.pid) process.kill(data.pid, "SIGTERM");
    } catch { /* already stopped */ }
  });

  it("preserves nested turn/start errors and lists model alternatives", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "test broker rejection handling", "utf8");
    const upstreamError = {
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      },
    };

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "gpt-5.6-sol",
    ], {
      broker: true,
      home: ERROR_BROKER_HOME,
      turnStartReject: JSON.stringify(upstreamError),
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    });

    assert.equal(result.exit, 6);
    assert.match(result.stderr, /not supported/i);
    assert.match(result.stderr, /No fallback was performed/);
    assert.match(result.stderr, /gpt-5\.6-terra/);
    assert.doesNotMatch(result.stderr, /\[object Object\]/);
  });
});

describe("broker turn multiplexing", () => {
  const BROKER_HOME = resolve(TEST_DIR, "broker_home");
  const BROKER_TMP = resolve(BROKER_HOME, ".claude", "tmp");
  const BROKER_PORT_FILE = resolve(BROKER_TMP, "broker.port");

  before(() => {
    if (existsSync(BROKER_PORT_FILE)) {
      try {
        const stale = readJson(BROKER_PORT_FILE);
        if (stale?.pid) process.kill(stale.pid, "SIGTERM");
      } catch { /* already stopped */ }
    }
    rmSync(BROKER_HOME, { recursive: true, force: true });
    mkdirSync(BROKER_TMP, { recursive: true });
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_broker_warmup_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_broker_warmup_o.txt`);
    writeFileSync(prompt, "Warm the broker for concurrency timing.", "utf8");
    const warmed = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
    ], {
      broker: true,
      home: BROKER_HOME,
      tagThread: true,
      turnDelay: 900,
      turnText: "Warm broker output.\n\n[VERDICT] - APPROVE",
    });
    assert.equal(warmed.exit, 0, warmed.stderr);
  });

  after(() => {
    // Kill any broker we started so it doesn't linger between runs
    if (existsSync(BROKER_PORT_FILE)) {
      try {
        const data = JSON.parse(readFileSync(BROKER_PORT_FILE, "utf8"));
        if (data?.pid) {
          try { process.kill(data.pid, "SIGTERM"); } catch { /* already dead */ }
        }
      } catch { /* ignore */ }
    }
  });

  async function pollToComplete(sid, timeoutMs = 30_000, home = BROKER_HOME) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      const r = cli(
        ["status", "--session", sid, "--review-dir", TEST_DIR],
        { broker: true, home }
      );
      if (r.exit === 0) return JSON.parse(r.stdout);
      if (![7].includes(r.exit)) throw new Error(`status exit ${r.exit}: ${r.stderr || r.stdout}`);
    }
    throw new Error(`Session ${sid} did not complete within ${timeoutMs}ms`);
  }

  it("does not mix deltas between concurrent turns", async () => {
    // Two concurrent sessions share the same broker/upstream. Each emits
    // deltas tagged with its threadId. If the broker routed notifications
    // to the wrong subscriber, one session's output would contain the
    // other's threadId tag.
    const mkSession = (marker) => {
      const sid = newSid();
      const promptPath = resolve(TEST_DIR, `${sid}_p.txt`);
      const outputPath = resolve(TEST_DIR, `${sid}_o.txt`);
      writeFileSync(promptPath, `Prompt for ${marker}.`, "utf8");
      return { sid, promptPath, outputPath, marker };
    };

    const sessions = [mkSession("AAA"), mkSession("BBB")];

    // Start both sessions back-to-back so their turns overlap on the broker
    for (const s of sessions) {
      const r = cli(
        ["start", s.promptPath, s.outputPath, "--session", s.sid, "--review-dir", TEST_DIR],
        {
          broker: true,
          home: BROKER_HOME,
          tagThread: true,
          turnDelay: 500,
          turnText: `Turn output for ${s.marker}.\n\n[VERDICT] - APPROVE`,
        }
      );
      assert.equal(r.exit, 0, `start failed for ${s.marker}: ${r.stderr}`);
    }

    // Wait for both to complete
    for (const s of sessions) {
      const progress = await pollToComplete(s.sid);
      assert.equal(progress.status, "completed", `session ${s.marker} status`);
      assert.ok(existsSync(s.outputPath), `output missing for ${s.marker}`);
    }

    // Each output should contain exactly one threadId tag, and the two
    // sessions must have different tags.
    const tag1 = readFileSync(sessions[0].outputPath, "utf8").match(/\[fake-thread-\d+\]/g) || [];
    const tag2 = readFileSync(sessions[1].outputPath, "utf8").match(/\[fake-thread-\d+\]/g) || [];
    assert.equal(tag1.length, 1, `session AAA has ${tag1.length} thread tags: ${tag1}`);
    assert.equal(tag2.length, 1, `session BBB has ${tag2.length} thread tags: ${tag2}`);
    assert.notEqual(tag1[0], tag2[0], "concurrent sessions leaked into each other");
  });

  it("runs three isolated turn-starts in parallel", async () => {
    const sessions = Array.from({ length: 3 }, (_, i) => {
      const sid = newSid();
      const promptPath = resolve(TEST_DIR, `${sid}_p.txt`);
      const outputPath = resolve(TEST_DIR, `${sid}_o.txt`);
      writeFileSync(promptPath, `Prompt ${i}.`, "utf8");
      return { sid, promptPath, outputPath, idx: i };
    });

    const startedAt = Date.now();
    for (const s of sessions) {
      const r = cli(
        ["start", s.promptPath, s.outputPath, "--session", s.sid, "--review-dir", TEST_DIR],
        {
          broker: true,
          home: BROKER_HOME,
          tagThread: true,
          turnDelay: 900,
          turnText: `Content ${s.idx}.\n\n[VERDICT] - APPROVE`,
        }
      );
      assert.equal(r.exit, 0, `start ${s.idx} failed: ${r.stderr}`);
    }

    for (const s of sessions) {
      const progress = await pollToComplete(s.sid, 45_000);
      assert.equal(progress.status, "completed", `session ${s.idx} status`);
    }

    const tags = sessions.map((s) => {
      const content = readFileSync(s.outputPath, "utf8");
      const match = content.match(/\[fake-thread-\d+\]/g) || [];
      assert.equal(match.length, 1, `session ${s.idx} has ${match.length} thread tags: ${match}`);
      return match[0];
    });

    // All three tags must be distinct — no session received another's deltas.
    const unique = new Set(tags);
    assert.equal(unique.size, tags.length, `concurrent sessions leaked: ${tags}`);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2300, `turns were serialized: ${elapsedMs}ms`);
  });

  it("direct mode ignores notifications for a foreign thread and turn", () => {
    const sid = newSid();
    const promptPath = resolve(TEST_DIR, `${sid}_foreign_p.txt`);
    const outputPath = resolve(TEST_DIR, `${sid}_foreign_o.txt`);
    writeFileSync(promptPath, "Ignore foreign notifications.", "utf8");

    const result = cli([
      "start", promptPath, outputPath,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
    ], {
      foreignDelta: true,
      turnText: "Expected output.\n\n[VERDICT] - APPROVE",
    });

    assert.equal(result.exit, 0, result.stderr);
    assert.doesNotMatch(readFileSync(outputPath, "utf8"), /FOREIGN_NOTIFICATION/);
  });

  it("reattaches after a broker disconnect without duplicating output", async () => {
    const reconnectHome = resolve(TEST_DIR, `reconnect_home_${Date.now()}`);
    mkdirSync(resolve(reconnectHome, ".claude", "tmp"), { recursive: true });
    const sid = newSid();
    const promptPath = resolve(TEST_DIR, `${sid}_reattach_p.txt`);
    const outputPath = resolve(TEST_DIR, `${sid}_reattach_o.txt`);
    const markers = Array.from({ length: 8 }, (_, index) =>
      `CHUNK_${index}_${String(index).repeat(40)}`
    );
    writeFileSync(promptPath, "Keep streaming after a local disconnect.", "utf8");

    const started = cli([
      "start", promptPath, outputPath,
      "--session", sid,
      "--review-dir", TEST_DIR,
    ], {
      broker: true,
      home: reconnectHome,
      turnDelay: 250,
      deltaInterval: 250,
      turnText: `${markers.join("")}\n\n[VERDICT] - APPROVE`,
      testMode: true,
    });
    assert.equal(started.exit, 0, started.stderr);

    let progress;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const status = cli(
        ["status", "--session", sid, "--review-dir", TEST_DIR],
        { broker: true, home: reconnectHome }
      );
      progress = JSON.parse(status.stdout);
      if (progress.turnId) break;
    }
    assert.ok(progress?.turnId, "turn id was not published to progress");

    await brokerControl(reconnectHome, "test/disconnect-turn", {
      threadId: progress.threadId,
      turnId: progress.turnId,
    });

    const completed = await pollToComplete(sid, 30_000, reconnectHome);
    assert.equal(completed.status, "completed");
    assert.equal(completed.reconnectCount, 1);
    const output = readFileSync(outputPath, "utf8");
    for (const marker of markers) {
      assert.equal(output.split(marker).length - 1, 1, `${marker} was duplicated or missing`);
    }
    const reconnectPort = readJson(resolve(reconnectHome, ".claude", "tmp", "broker.port"));
    if (reconnectPort?.pid) {
      try { process.kill(reconnectPort.pid, "SIGTERM"); } catch { /* already stopped */ }
    }
  });

  it("fails promptly with partial output and no replay after app server exit", async () => {
    const crashHome = resolve(TEST_DIR, `crash_home_${Date.now()}`);
    mkdirSync(resolve(crashHome, ".claude", "tmp"), { recursive: true });
    const sid = newSid();
    const promptPath = resolve(TEST_DIR, `${sid}_crash_p.txt`);
    const outputPath = resolve(TEST_DIR, `${sid}_crash_o.txt`);
    const requestLog = resolve(TEST_DIR, `${sid}_crash_requests.jsonl`);
    const longText = Array.from({ length: 30 }, (_, index) =>
      `PART_${index}_${String(index % 10).repeat(40)}`
    ).join("");
    writeFileSync(promptPath, "Preserve partial output after server exit.", "utf8");

    const started = cli([
      "start", promptPath, outputPath,
      "--session", sid,
      "--review-dir", TEST_DIR,
    ], {
      broker: true,
      home: crashHome,
      turnDelay: 100,
      deltaInterval: 300,
      turnText: `${longText}\n\n[VERDICT] - APPROVE`,
      requestLog,
      testMode: true,
    });
    assert.equal(started.exit, 0, started.stderr);

    let progress;
    const streamDeadline = Date.now() + 10_000;
    while (Date.now() < streamDeadline) {
      await sleep(150);
      const status = cli(
        ["status", "--session", sid, "--review-dir", TEST_DIR],
        { broker: true, home: crashHome }
      );
      progress = JSON.parse(status.stdout);
      if (progress.turnId && progress.charsReceived > 0) break;
    }
    assert.ok(progress?.turnId, "turn id was not published");
    assert.ok(progress?.charsReceived > 0, "no partial output was observed");

    await brokerControl(crashHome, "test/kill-app-server");

    let failed;
    const failDeadline = Date.now() + 10_000;
    while (Date.now() < failDeadline) {
      await sleep(150);
      const status = cli(
        ["status", "--session", sid, "--review-dir", TEST_DIR],
        { broker: true, home: crashHome }
      );
      if (status.exit === 6) {
        failed = JSON.parse(status.stdout);
        break;
      }
    }
    assert.equal(failed?.status, "failed");
    assert.ok(existsSync(outputPath), "partial output file was not written");
    assert.ok(readFileSync(outputPath, "utf8").length > 0, "partial output was empty");
    assert.equal(requestsByMethod(requestLog, "turn/start").length, 1);
  });

  it("cancel interrupts the upstream turn exactly once", async () => {
    const home = resolve(TEST_DIR, `cancel_home_${Date.now()}`);
    mkdirSync(resolve(home, ".claude", "tmp"), { recursive: true });
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_interrupt_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_interrupt_o.txt`);
    const interruptLog = resolve(TEST_DIR, `${sid}_interrupt.jsonl`);
    writeFileSync(prompt, "Run until cancelled.", "utf8");
    const started = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
    ], {
      broker: true,
      home,
      turnDelay: 5000,
      interruptLog,
    });
    assert.equal(started.exit, 0, started.stderr);

    let running;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const status = cli(["status", "--session", sid, "--review-dir", TEST_DIR], { broker: true, home });
      running = JSON.parse(status.stdout);
      if (running.turnId) break;
    }
    assert.ok(running?.turnId, "turn id was not published");

    const cancelled = cli(["cancel", "--session", sid, "--review-dir", TEST_DIR], { broker: true, home });
    assert.equal(cancelled.exit, 0, cancelled.stderr);
    const interrupts = readRequests(interruptLog);
    assert.deepEqual(interrupts, [{ threadId: running.threadId, turnId: running.turnId }]);
  });
});

describe("upstream timeout interruption", () => {
  it("hard timeout interrupts the upstream turn exactly once", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_timeout_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_timeout_o.txt`);
    const interruptLog = resolve(TEST_DIR, `${sid}_timeout_interrupt.jsonl`);
    writeFileSync(prompt, "Produce one partial chunk, then time out.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--timeout", "250",
    ], {
      turnDelay: 100,
      deltaInterval: 1000,
      turnText: `${"P".repeat(120)}\n\n[VERDICT] - APPROVE`,
      interruptLog,
    });

    assert.equal(result.exit, 5, result.stderr);
    const state = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    const interrupts = readRequests(interruptLog);
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].threadId, state.threadId);
    assert.ok(interrupts[0].turnId);
    assert.ok(existsSync(output));
  });
});

describe("model payload consistency", () => {
  const MODEL_BROKER_HOME = resolve(TEST_DIR, "model_broker_home");
  const MODEL_BROKER_TMP = resolve(MODEL_BROKER_HOME, ".claude", "tmp");
  const MODEL_BROKER_PORT_FILE = resolve(MODEL_BROKER_TMP, "broker.port");
  const MODEL_BROKER_REQUEST_LOG = resolve(TEST_DIR, "model_broker_requests.jsonl");

  before(() => {
    mkdirSync(MODEL_BROKER_TMP, { recursive: true });
    rmSync(MODEL_BROKER_REQUEST_LOG, { force: true });
  });

  after(() => {
    if (!existsSync(MODEL_BROKER_PORT_FILE)) return;
    try {
      const data = readJson(MODEL_BROKER_PORT_FILE);
      if (data?.pid) process.kill(data.pid, "SIGTERM");
    } catch { /* already stopped */ }
  });

  const cases = [
    { name: "wrapper default", args: [], opts: {}, expected: "gpt-5.6-terra" },
    {
      name: "explicit model",
      args: ["--model", "gpt-5.6-sol"],
      opts: {},
      expected: "gpt-5.6-sol",
    },
    {
      name: "environment model",
      args: [],
      opts: { envModel: "gpt-5.6-luna" },
      expected: "gpt-5.6-luna",
    },
    {
      name: "workflow default",
      args: ["--default-model", "gpt-5.6-sol"],
      opts: {},
      expected: "gpt-5.6-sol",
    },
    {
      name: "environment beats workflow default",
      args: ["--default-model", "gpt-5.6-sol"],
      opts: { envModel: "gpt-5.6-luna" },
      expected: "gpt-5.6-luna",
    },
    {
      name: "explicit model beats environment",
      args: ["--model", "gpt-5.6-sol"],
      opts: { envModel: "gpt-5.6-luna" },
      expected: "gpt-5.6-sol",
    },
  ];

  for (const testCase of cases) {
    it(`sends ${testCase.name} to thread/start and turn/start`, () => {
      const sid = newSid();
      const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
      const output = resolve(TEST_DIR, `${sid}_o.txt`);
      const requestLog = resolve(TEST_DIR, `${sid}_requests.jsonl`);
      writeFileSync(prompt, "Review this code.", "utf8");

      const result = cli([
        "start", prompt, output,
        "--session", sid,
        "--review-dir", TEST_DIR,
        "--foreground",
        ...testCase.args,
      ], { ...testCase.opts, requestLog });

      assert.equal(result.exit, 0, result.stderr);
      const requests = readRequests(requestLog);
      const threadStart = requests.find(request => request.method === "thread/start");
      const turnStart = requests.find(request => request.method === "turn/start");
      assert.equal(threadStart?.params?.model, testCase.expected);
      assert.equal(turnStart?.params?.model, testCase.expected);
    });
  }

  it("preserves an explicit model through the broker boundary", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "Review this code through the broker.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "gpt-5.6-sol",
    ], {
      broker: true,
      home: MODEL_BROKER_HOME,
      requestLog: MODEL_BROKER_REQUEST_LOG,
    });

    assert.equal(result.exit, 0, result.stderr);
    const requests = readRequests(MODEL_BROKER_REQUEST_LOG);
    assert.equal(
      requests.find(request => request.method === "thread/start")?.params?.model,
      "gpt-5.6-sol"
    );
    assert.equal(
      requests.find(request => request.method === "turn/start")?.params?.model,
      "gpt-5.6-sol"
    );
  });

  it("preserves a workflow default through a background worker and broker", async () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "Review this code in a background worker.", "utf8");

    const startResult = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--default-model", "gpt-5.6-luna",
    ], {
      broker: true,
      home: MODEL_BROKER_HOME,
      requestLog: MODEL_BROKER_REQUEST_LOG,
    });
    assert.equal(startResult.exit, 0, startResult.stderr);

    let completed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      const statusResult = cli(
        ["status", "--session", sid, "--review-dir", TEST_DIR],
        { broker: true, home: MODEL_BROKER_HOME }
      );
      if (statusResult.exit === 0) {
        completed = true;
        break;
      }
      assert.equal(statusResult.exit, 7, statusResult.stderr);
    }
    assert.equal(completed, true, "background broker session should complete");

    const requests = readRequests(MODEL_BROKER_REQUEST_LOG);
    const threadStarts = requests.filter(request => request.method === "thread/start");
    const turnStarts = requests.filter(request => request.method === "turn/start");
    assert.equal(threadStarts.at(-1)?.params?.model, "gpt-5.6-luna");
    assert.equal(turnStarts.at(-1)?.params?.model, "gpt-5.6-luna");
  });
});

describe("model availability", () => {
  it("fails before thread creation and lists available models", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    const requestLog = resolve(TEST_DIR, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "Review with an unavailable model.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "unavailable-model",
    ], {
      requestLog,
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    });

    assert.equal(result.exit, 6);
    assert.match(result.stderr, /not available/i);
    assert.match(result.stderr, /gpt-5\.6-sol/);
    assert.match(result.stderr, /gpt-5\.6-terra/);
    const requests = readRequests(requestLog);
    assert.equal(requests.some(request => request.method === "thread/start"), false);
    assert.equal(requests.some(request => request.method === "turn/start"), false);
  });

  it("continues when model/list is unsupported", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    const requestLog = resolve(TEST_DIR, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "Review through a legacy App Server.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "legacy-model",
    ], { requestLog, modelListUnsupported: true });

    assert.equal(result.exit, 0, result.stderr);
    assert.ok(existsSync(output));
  });

  it("accepts a requested model returned on a later model/list page", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    writeFileSync(prompt, "Review with a paginated model catalog.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "gpt-5.6-luna",
    ], {
      modelPages: [["gpt-5.6-sol"], ["gpt-5.6-terra", "gpt-5.6-luna"]],
    });

    assert.equal(result.exit, 0, result.stderr);
    assert.ok(existsSync(output));
  });

  it("fails closed when model/list succeeds with an empty catalog", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    const requestLog = resolve(TEST_DIR, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "Review with an empty model catalog.", "utf8");

    const result = cli([
      "start", prompt, output,
      "--session", sid,
      "--review-dir", TEST_DIR,
      "--foreground",
      "--model", "gpt-5.6-sol",
    ], { models: [], requestLog });

    assert.equal(result.exit, 6);
    assert.match(result.stderr, /none reported/);
    const requests = readRequests(requestLog);
    assert.equal(requests.some(request => request.method === "thread/start"), false);
  });
});

describe("model reuse fix (#2)", () => {
  it("follow-up without --model preserves state.model", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    const requestLog = resolve(TEST_DIR, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "test", "utf8");

    // Start with explicit model
    cli(
      ["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground", "--model", "gpt-5.6-sol"],
      { requestLog }
    );
    const state1 = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    assert.equal(state1.model, "gpt-5.6-sol");

    // Follow-up without --model
    const fu_p = resolve(TEST_DIR, `${sid}_fu.txt`);
    const fu_o = resolve(TEST_DIR, `${sid}_fuo.txt`);
    writeFileSync(fu_p, "follow-up", "utf8");
    cli(
      ["follow-up", fu_p, fu_o, "--session", sid, "--review-dir", TEST_DIR, "--foreground"],
      { requestLog }
    );

    // State and the actual follow-up request should keep the original model.
    const state2 = readJson(resolve(TEST_DIR, `${sid}_state.json`));
    assert.equal(state2.model, "gpt-5.6-sol", "Model should be preserved from initial start");
    const turnRequests = readRequests(requestLog).filter(request => request.method === "turn/start");
    assert.equal(turnRequests.at(-1)?.params?.model, "gpt-5.6-sol");
  });

  it("preserves gpt-5.5 for an existing follow-up session", () => {
    const sid = newSid();
    const prompt = resolve(TEST_DIR, `${sid}_p.txt`);
    const output = resolve(TEST_DIR, `${sid}_o.txt`);
    const requestLog = resolve(TEST_DIR, `${sid}_requests.jsonl`);
    writeFileSync(prompt, "start an older session", "utf8");

    cli(
      ["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR, "--foreground", "--model", "gpt-5.5"],
      { requestLog }
    );

    const followPrompt = resolve(TEST_DIR, `${sid}_fu.txt`);
    const followOutput = resolve(TEST_DIR, `${sid}_fuo.txt`);
    writeFileSync(followPrompt, "continue the older session", "utf8");
    const result = cli(
      ["follow-up", followPrompt, followOutput, "--session", sid, "--review-dir", TEST_DIR, "--foreground"],
      { requestLog }
    );

    assert.equal(result.exit, 0, result.stderr);
    const turnRequests = readRequests(requestLog).filter(request => request.method === "turn/start");
    assert.equal(turnRequests.at(-1)?.params?.model, "gpt-5.5");
  });
});
