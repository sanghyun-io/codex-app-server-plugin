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
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    FAKE_REQUEST_LOG: opts.requestLog ?? "",
    FAKE_MODELS: opts.models ? JSON.stringify(opts.models) : "",
    FAKE_MODEL_LIST_UNSUPPORTED: opts.modelListUnsupported ? "1" : "",
    ...(opts.broker ? {} : { CODEX_REVIEW_NO_BROKER: "1" }),
    ...(opts.tagThread ? { FAKE_TAG_THREAD: "1" } : {}),
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
function readRequests(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
});

describe("broker turn serialization", () => {
  const BROKER_HOME = resolve(TEST_DIR, "broker_home");
  const BROKER_TMP = resolve(BROKER_HOME, ".claude", "tmp");
  const BROKER_PORT_FILE = resolve(BROKER_TMP, "broker.port");

  before(() => {
    mkdirSync(BROKER_TMP, { recursive: true });
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

  async function pollToComplete(sid, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      const r = cli(
        ["status", "--session", sid, "--review-dir", TEST_DIR],
        { broker: true, home: BROKER_HOME }
      );
      if (r.exit === 0) return JSON.parse(r.stdout);
      if (![7].includes(r.exit)) throw new Error(`status exit ${r.exit}: ${r.stderr}`);
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

  it("serializes three concurrent turn-starts in FIFO order", async () => {
    // Three simultaneous starts must each end up with exactly one unique
    // threadId tag, proving the broker isolated each turn's notification
    // stream from the others.
    const sessions = Array.from({ length: 3 }, (_, i) => {
      const sid = newSid();
      const promptPath = resolve(TEST_DIR, `${sid}_p.txt`);
      const outputPath = resolve(TEST_DIR, `${sid}_o.txt`);
      writeFileSync(promptPath, `Prompt ${i}.`, "utf8");
      return { sid, promptPath, outputPath, idx: i };
    });

    for (const s of sessions) {
      const r = cli(
        ["start", s.promptPath, s.outputPath, "--session", s.sid, "--review-dir", TEST_DIR],
        {
          broker: true,
          home: BROKER_HOME,
          tagThread: true,
          turnDelay: 400,
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
