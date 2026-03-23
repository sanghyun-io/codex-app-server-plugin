#!/usr/bin/env node

/**
 * codex-review v2 — Async Codex App Server wrapper with progress tracking
 *
 * Commands:
 *   start      <prompt> <output> --session <SID> --review-dir <DIR>   Start a new thread + turn (background)
 *   follow-up  <prompt> <output> --session <SID> --review-dir <DIR>   Resume thread + new turn (background)
 *   status     --session <SID> --review-dir <DIR>                     Check turn progress (JSON to stdout)
 *   cancel     --session <SID> --review-dir <DIR>                     Cancel running turn, save partial output
 *   close      --session <SID> --review-dir <DIR>                     Clean up all session files
 *
 * Options:
 *   --model <MODEL>       Model override (default: gpt-5.4, env: CODEX_REVIEW_MODEL)
 *   --timeout <MS>        Hard timeout in ms (default: 1800000, env: CODEX_REVIEW_TIMEOUT)
 *   --foreground          Run synchronously (v1 compat, no background worker)
 *
 * Exit codes:
 *   0 = success / completed
 *   1 = codex binary not found
 *   2 = auth failure
 *   3 = rate limit exceeded
 *   4 = thread resume failure
 *   5 = turn timeout (hard safety net)
 *   6 = process error
 *   7 = turn still running (status command only)
 *   8 = turn cancelled
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
  openSync, closeSync, renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_HARD_TIMEOUT_MS = 1_800_000; // 30 min safety net
const INIT_TIMEOUT_MS = 30_000;            // 30s for init/auth requests
const PROGRESS_INTERVAL_MS = 3_000;        // 3s between progress file writes
const CANCEL_CHECK_MS = 500;               // 500ms cancel signal polling

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// CodexError
// ---------------------------------------------------------------------------

class CodexError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// AppServerClient
// ---------------------------------------------------------------------------

class AppServerClient {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.msgId = 0;
    this.pendingRequests = new Map();
    this.notificationHandlers = new Map();
  }

  nextId() {
    return ++this.msgId;
  }

  async spawn() {
    return new Promise((resolveP, rejectP) => {
      const isWin = process.platform === "win32";
      this.proc = isWin
        ? spawn("cmd", ["/c", "codex", "app-server"], {
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn("codex", ["app-server"], {
            stdio: ["pipe", "pipe", "pipe"],
          });

      this.proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          rejectP(new CodexError(1, "codex binary not found. Install with: npm i -g @anthropic-ai/codex"));
        } else {
          rejectP(new CodexError(6, `Process spawn error: ${err.message}`));
        }
      });

      this.rl = createInterface({ input: this.proc.stdout });
      this.rl.on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        this._handleMessage(msg);
      });

      setTimeout(() => resolveP(), 200);
    });
  }

  _handleMessage(msg) {
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const { resolve: res, reject: rej } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      msg.error ? rej(msg.error) : res(msg.result);
      return;
    }
    if (msg.method) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
      const wildcard = this.notificationHandlers.get("*");
      if (wildcard) wildcard(msg.method, msg.params);
    }
  }

  send(msg) {
    if (!this.proc?.stdin?.writable) {
      throw new CodexError(6, "App server process not running");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    return new Promise((resolveP, rejectP) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectP(new CodexError(5, `Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolveP(result); },
        reject: (error) => { clearTimeout(timer); rejectP(error); },
      });

      this.send({ method, id, params: params || {} });
    });
  }

  notify(method, params) {
    this.send({ method, params: params || {} });
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  // -- High-level operations --

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_review", title: "Codex Review", version: "2.0.0" },
    });
    this.notify("initialized");
    return result;
  }

  async checkAuth() {
    const result = await this.request("account/read", { refreshToken: false });
    const account = result?.account;
    if (!account || (!account.email && !account.type)) {
      throw new CodexError(2, "Not authenticated. Run 'codex login' first.");
    }
    return account;
  }

  async startThread(opts = {}) {
    return await this.request("thread/start", {
      model: opts.model || DEFAULT_MODEL,
      approvalPolicy: "never",
      ...opts,
    });
  }

  async resumeThread(threadId) {
    try {
      return await this.request("thread/resume", { threadId });
    } catch (err) {
      if (err.message?.includes("no rollout found")) {
        throw new CodexError(4, `Thread resume failed: ${err.message}. Thread may not have been persisted (needs at least one completed turn).`);
      }
      throw new CodexError(4, `Thread resume failed: ${err.message || JSON.stringify(err)}`);
    }
  }

  /**
   * Start a turn with configurable timeout, cancel signal, and delta callback.
   *
   * @param {string} threadId
   * @param {string} inputText
   * @param {object} opts
   * @param {string}   opts.model
   * @param {number}   opts.timeout    - Hard timeout in ms (0 = no timeout)
   * @param {string}   opts.effort
   * @param {function} opts.onDelta    - Called with total char count on each delta
   * @param {function} opts.cancelSignal - Returns true when turn should be cancelled
   */
  async startTurn(threadId, inputText, opts = {}) {
    const timeoutMs = opts.timeout ?? DEFAULT_HARD_TIMEOUT_MS;
    const onDelta = opts.onDelta || (() => {});
    const cancelSignal = opts.cancelSignal || (() => false);

    return new Promise((resolveP, rejectP) => {
      let agentText = "";
      let resolved = false;

      const cleanup = () => {
        if (hardTimer) clearTimeout(hardTimer);
        if (cancelChecker) clearInterval(cancelChecker);
        // Clear pending request timers to prevent event loop hang.
        // The turn/start request may never get a JSON-RPC response (only
        // notifications), leaving its timeout timer alive indefinitely.
        for (const [id, pending] of this.pendingRequests) {
          pending.resolve(null);
        }
        this.pendingRequests.clear();
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolveP(result);
      };

      const fail = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        rejectP(err);
      };

      // Hard timeout (safety net)
      const hardTimer = timeoutMs > 0
        ? setTimeout(() => {
            if (agentText.length > 0) {
              finish({ text: agentText, status: "timeout_partial" });
            } else {
              fail(new CodexError(5, `Turn timed out after ${timeoutMs}ms with no response`));
            }
          }, timeoutMs)
        : null;

      // Cancel signal polling
      const cancelChecker = setInterval(() => {
        if (cancelSignal()) {
          finish({ text: agentText, status: "cancelled" });
        }
      }, CANCEL_CHECK_MS);

      // Collect agent message deltas
      this.onNotification("item/agentMessage/delta", (params) => {
        agentText += params?.delta || "";
        onDelta(agentText.length);
      });

      // Handle turn completion
      this.onNotification("turn/completed", (params) => {
        const turn = params?.turn;
        if (turn?.status === "completed") {
          finish({ text: agentText, status: "completed" });
        } else if (turn?.status === "failed") {
          const error = turn?.error || params?.error;
          const errMsg = error?.message || "Turn failed";
          const errCode = error?.codexErrorInfo;

          if (errCode === "usageLimitExceeded" || errMsg.includes("usage limit")) {
            fail(new CodexError(3, `Rate limit exceeded: ${errMsg}`));
          } else {
            fail(new CodexError(6, `Turn failed: ${errMsg}`));
          }
        } else {
          finish({ text: agentText, status: turn?.status || "unknown" });
        }
      });

      // Handle error notifications
      this.onNotification("error", (params) => {
        const error = params?.error;
        if (error?.codexErrorInfo === "usageLimitExceeded") {
          fail(new CodexError(3, `Rate limit exceeded: ${error.message}`));
        }
      });

      // Start the turn
      this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: inputText }],
          model: opts.model || DEFAULT_MODEL,
          effort: opts.effort || "high",
        },
        timeoutMs || DEFAULT_HARD_TIMEOUT_MS
      ).catch((err) => {
        fail(err instanceof CodexError ? err : new CodexError(6, `Turn start failed: ${err.message || JSON.stringify(err)}`));
      });
    });
  }

  close() {
    this.notificationHandlers.clear();
    this.pendingRequests.clear();
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const fp = {
  state:    (dir, sid) => resolve(dir, `${sid}_state.json`),
  progress: (dir, sid) => resolve(dir, `${sid}_progress.json`),
  pid:      (dir, sid) => resolve(dir, `${sid}_pid`),
  log:      (dir, sid) => resolve(dir, `${sid}_worker.log`),
};

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

/** Atomic write: write to tmp file then rename into place. */
function writeJsonAtomic(path, data) {
  const tmp = path + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

function removeFile(path) {
  if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
}

function loadState(dir, sid) { return readJson(fp.state(dir, sid)); }
function saveState(dir, sid, data) { writeJson(fp.state(dir, sid), data); }

function loadProgress(dir, sid) { return readJson(fp.progress(dir, sid)); }
function saveProgress(dir, sid, data) { writeJsonAtomic(fp.progress(dir, sid), data); }

/**
 * PID file stores JSON: { pid, nonce } for identity verification.
 * Nonce is checked against /proc/<pid>/cmdline before signaling
 * to prevent killing a recycled PID belonging to a different process.
 */
function readPidFile(dir, sid) {
  const p = fp.pid(dir, sid);
  if (!existsSync(p)) return null;
  const data = readJson(p);
  if (!data) return null;
  // Handle legacy bare-number format
  if (typeof data === "number") return { pid: data, nonce: null };
  return { pid: data.pid, nonce: data.nonce || null };
}

function writePidFile(dir, sid, pid, nonce) {
  writeJson(fp.pid(dir, sid), { pid, nonce });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Verify PID belongs to our worker by checking cmdline for nonce. */
function isOurWorker(pid, nonce) {
  if (!isAlive(pid)) return false;
  if (!nonce) return true; // no nonce = can't verify, assume yes (legacy compat)
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(nonce);
  } catch {
    // /proc not available (Windows?) — fall back to PID-only check
    return true;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[codex-review] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Worker — runs as a detached child process
// ---------------------------------------------------------------------------

async function workerMain(parsed) {
  const { command, positional, sessionId, reviewDir, model, modelExplicit, timeout } = parsed;
  const promptFile = resolve(positional[0]);
  const outputFile = resolve(positional[1]);
  const promptText = readFileSync(promptFile, "utf8");
  const hardTimeout = timeout || DEFAULT_HARD_TIMEOUT_MS;
  const startMs = Date.now();

  let cancelled = false;
  let charsReceived = 0;

  // Graceful cancel on SIGTERM
  process.on("SIGTERM", () => { cancelled = true; });

  const progress = (status, extra = {}) => {
    saveProgress(reviewDir, sessionId, {
      status,
      startedAt: new Date(startMs).toISOString(),
      elapsedMs: Date.now() - startMs,
      charsReceived,
      ...extra,
    });
  };

  progress("initializing");

  const client = new AppServerClient();

  try {
    await client.spawn();
    await client.initialize();
    const account = await client.checkAuth();
    log(`Auth: ${account.type} / ${account.planType} / ${account.email}`);

    let threadId;
    let effectiveModel = model;

    if (command === "start") {
      const threadResult = await client.startThread({ model });
      threadId = threadResult.thread.id;
      log(`Thread created: ${threadId} (model: ${model})`);
      saveState(reviewDir, sessionId, {
        threadId, model, createdAt: new Date().toISOString(), turnCount: 0,
      });
    } else {
      // follow-up
      const state = loadState(reviewDir, sessionId);
      if (!state?.threadId) {
        throw new CodexError(4, `No active session found for ${sessionId}. Run 'start' first.`);
      }
      threadId = state.threadId;
      effectiveModel = modelExplicit ? model : (state.model || DEFAULT_MODEL);
      await client.resumeThread(threadId);
      log(`Thread resumed: ${threadId} (model: ${effectiveModel})`);
    }

    progress("running", { threadId });

    // Periodic progress file updates
    const progressTimer = setInterval(() => {
      progress("running", { threadId });
    }, PROGRESS_INTERVAL_MS);

    // Execute turn
    const turnResult = await client.startTurn(threadId, promptText, {
      model: effectiveModel,
      timeout: hardTimeout,
      onDelta: (chars) => { charsReceived = chars; },
      cancelSignal: () => cancelled,
    });

    clearInterval(progressTimer);

    log(`Turn finished: ${turnResult.status} (${turnResult.text.length} chars)`);

    // Write output (full or partial)
    writeFileSync(outputFile, turnResult.text, "utf8");

    // Update state
    const state = loadState(reviewDir, sessionId);
    if (state) {
      state.turnCount = (state.turnCount || 0) + 1;
      saveState(reviewDir, sessionId, state);
    }

    // Final progress
    const finalStatus =
      turnResult.status === "cancelled" ? "cancelled" :
      turnResult.status === "timeout_partial" ? "timeout_partial" :
      "completed";

    progress(finalStatus, {
      charsReceived: turnResult.text.length,
      completedAt: new Date().toISOString(),
      outputFile,
    });

    if (finalStatus === "cancelled") {
      process.exit(8);
    }
    if (finalStatus === "timeout_partial") {
      log(`Hard timeout reached. Partial output saved (${turnResult.text.length} chars).`);
      process.exit(5);
    }

  } catch (err) {
    const exitCode = err instanceof CodexError ? err.exitCode : 6;
    progress("failed", {
      error: err.message,
      exitCode,
    });
    log(`ERROR (exit ${exitCode}): ${err.message}`);
    process.exit(exitCode);
  } finally {
    client.close();
    removeFile(fp.pid(reviewDir, sessionId));
  }
}

// ---------------------------------------------------------------------------
// CLI Command: start (background)
// ---------------------------------------------------------------------------

function spawnWorker(parsed) {
  const { command, positional, sessionId, reviewDir, model, modelExplicit, timeout } = parsed;

  // Check if a worker is already running for this session
  const existing = readPidFile(reviewDir, sessionId);
  if (existing && isOurWorker(existing.pid, existing.nonce)) {
    log(`Worker already running (PID: ${existing.pid}). Use 'cancel' first.`);
    process.exit(6);
  }

  // Verify prompt file exists
  const promptFile = resolve(positional[0]);
  if (!existsSync(promptFile)) {
    console.error(`Error: prompt file not found: ${promptFile}`);
    process.exit(6);
  }

  // Generate nonce for worker identity verification
  const nonce = randomBytes(8).toString("hex");

  // Initialize progress
  saveProgress(reviewDir, sessionId, {
    status: "queued",
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    charsReceived: 0,
  });

  // Build worker args — only pass --model when user explicitly specified it (#2 fix)
  const workerArgs = [
    SELF,
    "--worker", command,
    positional[0], positional[1],
    "--session", sessionId,
    "--review-dir", reviewDir,
    "--nonce", nonce,
  ];
  if (modelExplicit) {
    workerArgs.push("--model", model);
  }
  if (timeout) {
    workerArgs.push("--timeout", String(timeout));
  }

  // Spawn detached worker
  const logPath = fp.log(reviewDir, sessionId);
  const logFd = openSync(logPath, "w");

  const worker = spawn(process.execPath, workerArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  // Write PID file with nonce for identity verification
  writePidFile(reviewDir, sessionId, worker.pid, nonce);

  worker.unref();
  closeSync(logFd);

  log(`Worker spawned (PID: ${worker.pid}, command: ${command})`);
  log(`Progress: ${fp.progress(reviewDir, sessionId)}`);
  log(`Worker log: ${logPath}`);
}

async function cmdStart(parsed) {
  if (parsed.foreground) {
    await workerMain(parsed);
    return;
  }
  if (parsed.positional.length < 2) {
    console.error("Error: start requires <prompt-file> <output-file>");
    process.exit(6);
  }
  spawnWorker(parsed);
}

async function cmdFollowUp(parsed) {
  if (parsed.foreground) {
    await workerMain(parsed);
    return;
  }
  if (parsed.positional.length < 2) {
    console.error("Error: follow-up requires <prompt-file> <output-file>");
    process.exit(6);
  }

  // Verify state exists
  const state = loadState(parsed.reviewDir, parsed.sessionId);
  if (!state?.threadId) {
    log(`No active session found for ${parsed.sessionId}. Run 'start' first.`);
    process.exit(4);
  }

  spawnWorker(parsed);
}

// ---------------------------------------------------------------------------
// CLI Command: status
// ---------------------------------------------------------------------------

function cmdStatus(parsed) {
  const { sessionId, reviewDir } = parsed;

  const progress = loadProgress(reviewDir, sessionId);
  if (!progress) {
    console.error(`No session found: ${sessionId}`);
    process.exit(6);
  }

  // Enrich with live info
  const pidData = readPidFile(reviewDir, sessionId);
  const pid = pidData?.pid || null;
  const pidAlive = pid ? isOurWorker(pid, pidData?.nonce) : false;

  // Detect crashed worker
  if (!pidAlive && (progress.status === "running" || progress.status === "initializing" || progress.status === "queued")) {
    progress.status = "crashed";
    progress.error = "Worker process exited unexpectedly";
    // Check worker log for details
    const logPath = fp.log(reviewDir, sessionId);
    if (existsSync(logPath)) {
      try {
        const logContent = readFileSync(logPath, "utf8");
        const lastLines = logContent.split("\n").filter(Boolean).slice(-3).join(" | ");
        if (lastLines) progress.error += ` — ${lastLines}`;
      } catch { /* ignore */ }
    }
  }

  // Recalculate elapsed for running processes
  if (progress.status === "running" && progress.startedAt) {
    progress.elapsedMs = Date.now() - new Date(progress.startedAt).getTime();
  }

  // Add PID info
  progress.pid = pid;
  progress.pidAlive = pidAlive;

  // Output JSON
  console.log(JSON.stringify(progress, null, 2));

  // Exit code by status
  switch (progress.status) {
    case "completed":      process.exit(0); break;
    case "running":
    case "initializing":
    case "queued":         process.exit(7); break;
    case "cancelled":      process.exit(8); break;
    case "timeout_partial": process.exit(5); break;
    case "failed":         process.exit(progress.exitCode || 6); break;
    case "crashed":        process.exit(6); break;
    default:               process.exit(6);
  }
}

// ---------------------------------------------------------------------------
// CLI Command: cancel
// ---------------------------------------------------------------------------

async function cmdCancel(parsed) {
  const { sessionId, reviewDir } = parsed;
  const pidData = readPidFile(reviewDir, sessionId);

  if (!pidData) {
    const progress = loadProgress(reviewDir, sessionId);
    if (progress?.status === "completed") {
      log("Turn already completed");
    } else {
      log("No worker PID found");
    }
    process.exit(0);
    return;
  }

  const { pid, nonce } = pidData;

  if (!isOurWorker(pid, nonce)) {
    log("Worker already exited (PID not found or belongs to another process)");
    removeFile(fp.pid(reviewDir, sessionId));
    process.exit(0);
    return;
  }

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, "SIGTERM");
    log(`SIGTERM sent to worker (PID: ${pid})`);
  } catch (err) {
    log(`Failed to signal worker: ${err.message}`);
  }

  // Wait for graceful exit (up to 5s)
  for (let i = 0; i < 25; i++) {
    if (!isAlive(pid)) break;
    await sleep(200);
  }

  // Force kill if still alive
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
      log("Force killed worker");
    } catch { /* ignore */ }
    await sleep(500);
  }

  // Clean up PID file
  removeFile(fp.pid(reviewDir, sessionId));

  // Update progress if still marked as running
  const progress = loadProgress(reviewDir, sessionId);
  if (progress && ["running", "initializing", "queued"].includes(progress.status)) {
    saveProgress(reviewDir, sessionId, {
      ...progress,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    });
  }

  log("Worker cancelled");
}

// ---------------------------------------------------------------------------
// CLI Command: close
// ---------------------------------------------------------------------------

async function cmdClose(parsed) {
  const { sessionId, reviewDir } = parsed;

  // Kill worker if still running (with identity verification)
  const pidData = readPidFile(reviewDir, sessionId);
  if (pidData && isOurWorker(pidData.pid, pidData.nonce)) {
    try { process.kill(pidData.pid, "SIGTERM"); } catch { /* ignore */ }
    await sleep(1000);
    if (isAlive(pidData.pid)) {
      try { process.kill(pidData.pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }

  // Remove all session files
  removeFile(fp.state(reviewDir, sessionId));
  removeFile(fp.progress(reviewDir, sessionId));
  removeFile(fp.pid(reviewDir, sessionId));
  removeFile(fp.log(reviewDir, sessionId));

  log(`Session ${sessionId} closed.`);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`codex-review v2 — Async Codex App Server wrapper

Usage:
  codex-review start      <prompt> <output> --session <SID> --review-dir <DIR> [options]
  codex-review follow-up  <prompt> <output> --session <SID> --review-dir <DIR> [options]
  codex-review status     --session <SID> --review-dir <DIR>
  codex-review cancel     --session <SID> --review-dir <DIR>
  codex-review close      --session <SID> --review-dir <DIR>

Options:
  --model <MODEL>       Model to use (default: gpt-5.4, env: CODEX_REVIEW_MODEL)
  --timeout <MS>        Hard timeout in ms (default: 1800000, env: CODEX_REVIEW_TIMEOUT)
  --foreground          Run synchronously (v1 compat)

Exit codes:
  0 = success / completed
  1 = codex binary not found
  2 = auth failure
  3 = rate limit exceeded
  4 = thread resume failure
  5 = turn timeout (hard safety net)
  6 = process error
  7 = turn still running (status only)
  8 = turn cancelled`);
}

function parseArgs(argv) {
  const raw = argv.slice(2);

  // Extract --worker flag (internal)
  let isWorker = false;
  const workerIdx = raw.indexOf("--worker");
  if (workerIdx !== -1) {
    isWorker = true;
    raw.splice(workerIdx, 1);
  }

  const command = raw[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  let sessionId = null;
  let reviewDir = null;
  let model = null;
  let timeout = null;
  let nonce = null;
  let foreground = false;
  const positional = [];

  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "--session" && raw[i + 1]) {
      sessionId = raw[++i];
    } else if (raw[i] === "--review-dir" && raw[i + 1]) {
      reviewDir = raw[++i];
    } else if (raw[i] === "--model" && raw[i + 1]) {
      model = raw[++i];
    } else if (raw[i] === "--timeout" && raw[i + 1]) {
      timeout = parseInt(raw[++i], 10);
    } else if (raw[i] === "--nonce" && raw[i + 1]) {
      nonce = raw[++i];
    } else if (raw[i] === "--foreground") {
      foreground = true;
    } else if (!raw[i].startsWith("--")) {
      positional.push(raw[i]);
    }
  }

  // Validate required args
  if (!sessionId) {
    console.error("Error: --session <SID> is required");
    process.exit(6);
  }
  if (!reviewDir) {
    console.error("Error: --review-dir <DIR> is required");
    process.exit(6);
  }

  // Resolve with env vars / defaults
  const resolvedModel = model || process.env.CODEX_REVIEW_MODEL || DEFAULT_MODEL;
  const resolvedTimeout = timeout
    || (process.env.CODEX_REVIEW_TIMEOUT ? parseInt(process.env.CODEX_REVIEW_TIMEOUT, 10) : null)
    || DEFAULT_HARD_TIMEOUT_MS;

  return {
    command,
    positional,
    sessionId,
    reviewDir: resolve(reviewDir),
    model: resolvedModel,
    modelExplicit: model !== null,
    timeout: resolvedTimeout,
    nonce,
    foreground,
    isWorker,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv);

  // Worker mode — run the actual Codex interaction
  if (parsed.isWorker) {
    await workerMain(parsed);
    return;
  }

  try {
    switch (parsed.command) {
      case "start":
        await cmdStart(parsed);
        break;
      case "follow-up":
        await cmdFollowUp(parsed);
        break;
      case "status":
        cmdStatus(parsed);
        break;
      case "cancel":
        await cmdCancel(parsed);
        break;
      case "close":
        await cmdClose(parsed);
        break;
      default:
        console.error(`Unknown command: ${parsed.command}`);
        printHelp();
        process.exit(6);
    }
  } catch (err) {
    if (err instanceof CodexError) {
      log(`ERROR (exit ${err.exitCode}): ${err.message}`);
      process.exit(err.exitCode);
    }
    log(`UNEXPECTED ERROR: ${err.message}`);
    process.exit(6);
  }
}

main();
