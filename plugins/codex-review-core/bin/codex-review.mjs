#!/usr/bin/env node

/**
 * codex-review — Codex App Server wrapper for stateful review loops
 *
 * Commands:
 *   start      <prompt-file> <output-file> --session <SID> --review-dir <DIR>
 *   follow-up  <prompt-file> <output-file> --session <SID> --review-dir <DIR>
 *   close      --session <SID> --review-dir <DIR>
 *
 * Exit codes:
 *   0 = success
 *   1 = codex binary not found
 *   2 = auth failure
 *   3 = rate limit exceeded
 *   4 = thread resume failure
 *   5 = turn timeout
 *   6 = process error
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TURN_TIMEOUT_MS = 300_000; // 5 minutes
const INIT_TIMEOUT_MS = 30_000; // 30 seconds
const MODEL = "gpt-5.3-codex";

// ---------------------------------------------------------------------------
// AppServerClient
// ---------------------------------------------------------------------------

class AppServerClient {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.msgId = 0;
    this.pendingRequests = new Map(); // id → { resolve, reject }
    this.notificationHandlers = new Map(); // method → handler
  }

  nextId() {
    return ++this.msgId;
  }

  // -- Process lifecycle --

  async spawn() {
    return new Promise((resolve, reject) => {
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
          reject(new CodexError(1, "codex binary not found. Install with: npm i -g @anthropic-ai/codex"));
        } else {
          reject(new CodexError(6, `Process spawn error: ${err.message}`));
        }
      });

      this.rl = createInterface({ input: this.proc.stdout });

      this.rl.on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // skip non-JSON lines
        }
        this._handleMessage(msg);
      });

      // Give process a moment to start
      setTimeout(() => resolve(), 200);
    });
  }

  _handleMessage(msg) {
    // Response to a request (has id)
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(msg.error);
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Notification (no id, has method)
    if (msg.method) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) {
        handler(msg.params);
      }
      // Also check wildcard handlers
      const wildcardHandler = this.notificationHandlers.get("*");
      if (wildcardHandler) {
        wildcardHandler(msg.method, msg.params);
      }
    }
  }

  send(msg) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new CodexError(6, "App server process not running");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new CodexError(5, `Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
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
      clientInfo: {
        name: "codex_review",
        title: "Codex Review",
        version: "1.0.0",
      },
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
      model: opts.model || MODEL,
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

  async startTurn(threadId, inputText, opts = {}) {
    return new Promise((resolve, reject) => {
      let agentText = "";
      let turnResolved = false;

      const timer = setTimeout(() => {
        if (!turnResolved) {
          turnResolved = true;
          // Save partial response if any
          if (agentText.length > 0) {
            resolve({ text: agentText, status: "timeout_partial" });
          } else {
            reject(new CodexError(5, `Turn timed out after ${TURN_TIMEOUT_MS}ms with no response`));
          }
        }
      }, TURN_TIMEOUT_MS);

      // Collect agent message deltas
      this.onNotification("item/agentMessage/delta", (params) => {
        agentText += params?.delta || "";
      });

      // Handle turn completion
      this.onNotification("turn/completed", (params) => {
        if (turnResolved) return;
        turnResolved = true;
        clearTimeout(timer);

        const turn = params?.turn;
        if (turn?.status === "completed") {
          resolve({ text: agentText, status: "completed" });
        } else if (turn?.status === "failed") {
          const error = turn?.error || params?.error;
          const errMsg = error?.message || "Turn failed";
          const errCode = error?.codexErrorInfo;

          if (errCode === "usageLimitExceeded" || errMsg.includes("usage limit")) {
            reject(new CodexError(3, `Rate limit exceeded: ${errMsg}`));
          } else {
            reject(new CodexError(6, `Turn failed: ${errMsg}`));
          }
        } else {
          resolve({ text: agentText, status: turn?.status || "unknown" });
        }
      });

      // Handle error notifications
      this.onNotification("error", (params) => {
        const error = params?.error;
        if (error?.codexErrorInfo === "usageLimitExceeded") {
          if (!turnResolved) {
            turnResolved = true;
            clearTimeout(timer);
            reject(new CodexError(3, `Rate limit exceeded: ${error.message}`));
          }
        }
      });

      // Start the turn
      this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: inputText }],
          model: opts.model || MODEL,
          effort: opts.effort || "high",
        },
        TURN_TIMEOUT_MS
      ).catch((err) => {
        if (!turnResolved) {
          turnResolved = true;
          clearTimeout(timer);
          reject(err instanceof CodexError ? err : new CodexError(6, `Turn start failed: ${err.message || JSON.stringify(err)}`));
        }
      });
    });
  }

  close() {
    // Clean up notification handlers
    this.notificationHandlers.clear();
    this.pendingRequests.clear();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class CodexError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// State file management
// ---------------------------------------------------------------------------

function stateFilePath(reviewDir, sessionId) {
  return resolve(reviewDir, `${sessionId}_state.json`);
}

function loadState(reviewDir, sessionId) {
  const path = stateFilePath(reviewDir, sessionId);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(reviewDir, sessionId, state) {
  const path = stateFilePath(reviewDir, sessionId);
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function deleteState(reviewDir, sessionId) {
  const path = stateFilePath(reviewDir, sessionId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// CLI Command Handlers
// ---------------------------------------------------------------------------

async function cmdStart(promptFile, outputFile, sessionId, reviewDir) {
  const promptText = readFileSync(promptFile, "utf8");
  const client = new AppServerClient();

  try {
    await client.spawn();
    await client.initialize();
    const account = await client.checkAuth();
    log(`Auth: ${account.type} / ${account.planType} / ${account.email}`);

    const threadResult = await client.startThread({ model: MODEL });
    const threadId = threadResult.thread.id;
    log(`Thread created: ${threadId}`);

    // Save state immediately (before turn, in case of rate limit)
    saveState(reviewDir, sessionId, {
      threadId,
      model: MODEL,
      createdAt: new Date().toISOString(),
      turnCount: 0,
    });

    const turnResult = await client.startTurn(threadId, promptText);
    log(`Turn completed: ${turnResult.status} (${turnResult.text.length} chars)`);

    // Update state with turn count
    saveState(reviewDir, sessionId, {
      threadId,
      model: MODEL,
      createdAt: new Date().toISOString(),
      turnCount: 1,
    });

    // Write output
    writeFileSync(outputFile, turnResult.text, "utf8");
    log(`Output saved to ${outputFile}`);
  } finally {
    client.close();
  }
}

async function cmdFollowUp(promptFile, outputFile, sessionId, reviewDir) {
  const state = loadState(reviewDir, sessionId);
  if (!state || !state.threadId) {
    throw new CodexError(4, `No active session found for ${sessionId}. Run 'start' first.`);
  }

  const promptText = readFileSync(promptFile, "utf8");
  const client = new AppServerClient();

  try {
    await client.spawn();
    await client.initialize();
    await client.checkAuth();

    await client.resumeThread(state.threadId);
    log(`Thread resumed: ${state.threadId}`);

    const turnResult = await client.startTurn(state.threadId, promptText);
    log(`Turn completed: ${turnResult.status} (${turnResult.text.length} chars)`);

    // Update state
    state.turnCount = (state.turnCount || 0) + 1;
    saveState(reviewDir, sessionId, state);

    // Write output
    writeFileSync(outputFile, turnResult.text, "utf8");
    log(`Output saved to ${outputFile}`);
  } finally {
    client.close();
  }
}

async function cmdClose(sessionId, reviewDir) {
  deleteState(reviewDir, sessionId);
  log(`Session ${sessionId} closed.`);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[codex-review] ${msg}\n`);
}

function printHelp() {
  console.log(`Usage:
  codex-review start      <prompt-file> <output-file> --session <SID> --review-dir <DIR>
  codex-review follow-up  <prompt-file> <output-file> --session <SID> --review-dir <DIR>
  codex-review close      --session <SID> --review-dir <DIR>

Exit codes:
  0 = success
  1 = codex binary not found
  2 = auth failure
  3 = rate limit exceeded
  4 = thread resume failure
  5 = turn timeout
  6 = process error`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  let sessionId = null;
  let reviewDir = null;
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--session" && args[i + 1]) {
      sessionId = args[++i];
    } else if (args[i] === "--review-dir" && args[i + 1]) {
      reviewDir = args[++i];
    } else if (!args[i].startsWith("--")) {
      positional.push(args[i]);
    }
  }

  if (!sessionId) {
    console.error("Error: --session <SID> is required");
    process.exit(6);
  }
  if (!reviewDir) {
    console.error("Error: --review-dir <DIR> is required");
    process.exit(6);
  }

  return { command, positional, sessionId, reviewDir: resolve(reviewDir) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { command, positional, sessionId, reviewDir } = parseArgs(process.argv);

  try {
    switch (command) {
      case "start": {
        if (positional.length < 2) {
          console.error("Error: start requires <prompt-file> <output-file>");
          process.exit(6);
        }
        await cmdStart(positional[0], positional[1], sessionId, reviewDir);
        break;
      }
      case "follow-up": {
        if (positional.length < 2) {
          console.error("Error: follow-up requires <prompt-file> <output-file>");
          process.exit(6);
        }
        await cmdFollowUp(positional[0], positional[1], sessionId, reviewDir);
        break;
      }
      case "close": {
        await cmdClose(sessionId, reviewDir);
        break;
      }
      default: {
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(6);
      }
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
