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
 *   --model <MODEL>       Model override (default: gpt-5.6-terra, env: CODEX_REVIEW_MODEL)
 *   --timeout <MS>        Hard timeout in ms (default: 1800000, env: CODEX_REVIEW_TIMEOUT)
 *   --foreground          Run synchronously (v1 compat, no background worker)
 *   --stdin               Read prompt from stdin and write to <prompt-file> (avoids Write tool permission)
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

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
  openSync, closeSync, renameSync, mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { resolveProjectRoot, sameProject } from "./lib/project-scope.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_HARD_TIMEOUT_MS = 1_800_000; // 30 min safety net
const INIT_TIMEOUT_MS = 30_000;            // 30s for init/auth requests
const PROGRESS_INTERVAL_MS = 3_000;        // 3s between progress file writes
const PROGRESS_RENAME_RETRY_DELAYS_MS = [10, 25, 50];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const CANCEL_CHECK_MS = 500;               // 500ms cancel signal polling
const INTERRUPT_GRACE_MS = Math.max(
  50,
  Number(process.env.CODEX_REVIEW_INTERRUPT_GRACE_MS) || 5_000,
);
const LARGE_PROMPT_CHARS = 131_072;
const ACTIVE_PROGRESS_STATUSES = new Set([
  "queued",
  "connecting",
  "validating_model",
  "starting_thread",
  "waiting_first_output",
  "streaming",
  "reconnecting",
  // Legacy progress files from versions before 2.5.0.
  "initializing",
  "running",
]);

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Codex binary resolution
// ---------------------------------------------------------------------------

/**
 * Decide how to launch the codex app-server.
 *
 * Resolution order:
 *   1. CODEX_BINARY env — run via `node <bin>` (test fakes / explicit override)
 *   2. ~/.claude/bin/codex — symlink installed by /codex-core:setup when the
 *      codex CLI isn't on PATH but a desktop-app binary was found. Using the
 *      absolute path means it works even if ~/.claude/bin is not on PATH.
 *   3. PATH `codex` — the normal case (npm -g / standalone installer / brew).
 *      On Windows we go through `cmd /c codex` so the .ps1/.cmd shim resolves.
 *
 * Returns { command, prependArgs, passAppServerArg }:
 *   - command + prependArgs: how to invoke the process
 *   - passAppServerArg: whether to append the "app-server" arg. For the
 *     CODEX_BINARY test fake this is false (it preserves the original
 *     `node <bin>` invocation, which did NOT pass "app-server"); every real
 *     codex launch sets it true.
 */
function resolveCodexLauncher() {
  const customBin = process.env.CODEX_BINARY;
  if (customBin) {
    return { command: process.execPath, prependArgs: [customBin], passAppServerArg: false };
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    const isWin = process.platform === "win32";
    // setup symlinks/copies to ~/.claude/bin/codex (or codex.cmd/.exe on Windows)
    const candidates = isWin
      ? ["codex.cmd", "codex.exe", "codex.ps1", "codex"]
      : ["codex"];
    for (const name of candidates) {
      const p = resolve(home, ".claude", "bin", name);
      if (existsSync(p)) {
        // .ps1 must be run through PowerShell; everything else runs directly.
        if (p.endsWith(".ps1")) {
          return { command: "powershell", prependArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p], passAppServerArg: true };
        }
        return { command: p, prependArgs: [], passAppServerArg: true };
      }
    }
  }

  // Fall back to PATH lookup.
  if (process.platform === "win32") {
    return { command: "cmd", prependArgs: ["/c", "codex"], passAppServerArg: true };
  }
  return { command: "codex", prependArgs: [], passAppServerArg: true };
}

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
    this.disconnectHandlers = new Set();
    this.processExited = false;
    this.closing = false;
  }

  nextId() {
    return ++this.msgId;
  }

  async spawn() {
    return new Promise((resolveP, rejectP) => {
      const { command, prependArgs, passAppServerArg } = resolveCodexLauncher();
      const spawnArgs = passAppServerArg ? [...prependArgs, "app-server"] : [...prependArgs];
      this.proc = spawn(command, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      this.proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          rejectP(new CodexError(1, "codex binary not found. Install the codex CLI (npm i -g @openai/codex) or run /codex-core:setup to link an installed Codex app."));
        } else {
          rejectP(new CodexError(6, `Process spawn error: ${err.message}`));
        }
      });

      this.proc.on("exit", (code, signal) => {
        this._handleDisconnect(new Error(
          `App server exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`
        ));
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

  _handleDisconnect(error) {
    if (this.closing || this.processExited) return;
    this.processExited = true;
    const wrapped = new CodexError(6, error?.message || String(error));
    for (const [, pending] of this.pendingRequests) pending.reject(wrapped);
    this.pendingRequests.clear();
    for (const handler of this.disconnectHandlers) handler(wrapped);
  }

  onDisconnect(handler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
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
      clientInfo: { name: "codex_review", title: "Codex Review", version: "2.5.1" },
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

  async listModels() {
    return await listAllModels(params => this.request("model/list", params));
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

  async interruptTurn(threadId, turnId) {
    return await this.request("turn/interrupt", { threadId, turnId }, INIT_TIMEOUT_MS);
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
      let turnId = null;
      let interruptSent = false;
      let interruptReason = null;
      let interruptError = null;
      let interruptGraceTimer = null;
      let pendingInterruptReason = null;

      const cleanup = () => {
        if (hardTimer) clearTimeout(hardTimer);
        if (cancelChecker) clearInterval(cancelChecker);
        if (interruptGraceTimer) clearTimeout(interruptGraceTimer);
        removeDisconnectHandler();
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
        resolveP({ ...result, turnId, reconnectCount: 0, interruptError });
      };

      const fail = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        rejectP(err);
      };

      const removeDisconnectHandler = this.onDisconnect((error) => {
        finish({
          text: agentText,
          status: "connection_failed_partial",
          error: error.message,
        });
      });

      const requestInterrupt = async (reason) => {
        if (resolved || interruptSent) return;
        pendingInterruptReason ||= reason;
        if (!turnId) return;
        interruptSent = true;
        interruptReason = pendingInterruptReason;
        interruptGraceTimer = setTimeout(() => {
          finish({ text: agentText, status: interruptReason, interruptError });
        }, INTERRUPT_GRACE_MS);
        try {
          await this.interruptTurn(threadId, turnId);
        } catch (error) {
          interruptError = extractAppServerErrorMessage(error);
        }
      };

      // Hard timeout (safety net)
      const hardTimer = timeoutMs > 0
        ? setTimeout(() => { void requestInterrupt("timeout_partial"); }, timeoutMs)
        : null;

      // Cancel signal polling
      const cancelChecker = setInterval(() => {
        if (cancelSignal()) {
          void requestInterrupt("cancelled");
        }
      }, CANCEL_CHECK_MS);

      // Collect agent message deltas
      this.onNotification("item/agentMessage/delta", (params) => {
        if (params?.threadId !== threadId || !turnId || params?.turnId !== turnId) return;
        agentText += params?.delta || "";
        onDelta(agentText.length);
      });

      // Handle turn completion
      this.onNotification("turn/completed", (params) => {
        const turn = params?.turn;
        if (params?.threadId !== threadId || !turnId || turn?.id !== turnId) return;
        if (turn?.status === "completed") {
          finish({ text: agentText, status: interruptReason || "completed", interruptError });
        } else if (turn?.status === "failed") {
          const error = turn?.error || params?.error;
          const errMsg = extractAppServerErrorMessage(error || params?.error || "Turn failed");
          const errCode = error?.codexErrorInfo;

          if (errCode === "usageLimitExceeded" || errMsg.includes("usage limit")) {
            fail(new CodexError(3, `Rate limit exceeded: ${errMsg}`));
          } else {
            fail(new CodexError(6, `Turn failed: ${errMsg}`));
          }
        } else {
          finish({
            text: agentText,
            status: interruptReason || (turn?.status === "interrupted" ? "cancelled" : turn?.status || "unknown"),
            interruptError,
          });
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
          cwd: opts.cwd,
          model: opts.model || DEFAULT_MODEL,
          effort: opts.effort || "high",
        },
        INIT_TIMEOUT_MS
      ).then((result) => {
        turnId = result?.turn?.id || null;
        if (!turnId) fail(new CodexError(6, "Turn start returned no turn id"));
        else {
          opts.onStarted?.(turnId);
          if (pendingInterruptReason) void requestInterrupt(pendingInterruptReason);
        }
      }).catch((err) => {
        fail(err instanceof CodexError ? err : new CodexError(6, `Turn start failed: ${extractAppServerErrorMessage(err)}`));
      });
    });
  }

  close() {
    this.closing = true;
    this.notificationHandlers.clear();
    this.pendingRequests.clear();
    this.disconnectHandlers.clear();
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// BrokerClient — connects to a running broker instead of spawning app-server
// ---------------------------------------------------------------------------

const BROKER_HOME = process.env.HOME || process.env.USERPROFILE || "";
const BROKER_TMP = resolve(BROKER_HOME, ".claude", "tmp");
const BROKER_PORT_FILE = resolve(BROKER_TMP, "broker.port");
const BROKER_START_LOCK = resolve(BROKER_TMP, "broker.start.lock");
const BROKER_SCRIPT = resolve(dirname(SELF), "broker.mjs");

class BrokerClient {
  constructor() {
    this.socket = null;
    this.rl = null;
    this.msgId = 0;
    this.pendingRequests = new Map();
    this.notificationHandlers = new Map();
    this.subscribedMethods = [];
    this.disconnectHandlers = new Set();
    this.connectionActive = false;
    this.disconnectNotified = false;
  }

  nextId() { return ++this.msgId; }

  async connect(port) {
    return new Promise((resolveP, rejectP) => {
      let settled = false;
      this.disconnectNotified = false;
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        if (this.socket !== socket) return;
        settled = true;
        this.connectionActive = true;
        const rl = createInterface({ input: socket });
        this.rl = rl;
        rl.on("line", (line) => {
          let msg;
          try { msg = JSON.parse(line); } catch { return; }
          this._handleMessage(msg);
        });
        rl.on("error", (error) => {
          if (this.rl === rl && this.socket === socket) this._handleDisconnect(error);
        });
        resolveP();
      });
      this.socket = socket;
      socket.on("error", (err) => {
        if (this.socket !== socket) return;
        if (!settled) {
          settled = true;
          rejectP(new Error(`Broker connection failed: ${err.message}`));
        } else {
          this._handleDisconnect(err);
        }
      });

      socket.on("close", () => {
        if (this.socket !== socket) return;
        if (this.connectionActive) this._handleDisconnect(new Error("Broker connection closed"));
      });
    });
  }

  _handleDisconnect(error) {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.connectionActive = false;
    const wrapped = new CodexError(6, `Broker disconnected: ${error?.message || error}`);
    for (const [, pending] of this.pendingRequests) pending.reject(wrapped);
    this.pendingRequests.clear();
    for (const handler of this.disconnectHandlers) handler(wrapped);
  }

  onDisconnect(handler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  _handleMessage(msg) {
    if (msg.type === "response" && msg.id != null && this.pendingRequests.has(msg.id)) {
      const { resolve: res, reject: rej } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      msg.error ? rej(msg.error) : res(msg.result);
      return;
    }
    if (msg.type === "notification" && msg.method) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
      const wildcard = this.notificationHandlers.get("*");
      if (wildcard) wildcard(msg.method, msg.params);
    }
  }

  send(data) {
    if (!this.socket?.writable) {
      throw new CodexError(6, "Broker connection not writable");
    }
    this.socket.write(JSON.stringify(data) + "\n");
  }

  request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    return new Promise((resolveP, rejectP) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectP(new CodexError(5, `Broker request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolveP(result); },
        reject: (error) => { clearTimeout(timer); rejectP(error); },
      });

      this.send({ action: "request", method, params: params || {}, id, timeout: timeoutMs });
    });
  }

  localRequest(action, params = {}, timeoutMs = INIT_TIMEOUT_MS) {
    return new Promise((resolveP, rejectP) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectP(new CodexError(5, `Broker action ${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolveP(result); },
        reject: (error) => { clearTimeout(timer); rejectP(error); },
      });
      this.send({ action, id, ...params });
    });
  }

  notify(method, params) {
    this.send({ action: "notify", method, params: params || {} });
  }

  subscribe(methods = ["*"]) {
    this.subscribedMethods = [...methods];
    this.send({ action: "subscribe", methods });
  }

  async reconnect() {
    const portData = readJson(BROKER_PORT_FILE);
    if (!portData?.port) throw new CodexError(6, "Broker port file is unavailable during reconnect");
    if (this.rl) { try { this.rl.close(); } catch { /* ignore */ } }
    if (this.socket) { try { this.socket.destroy(); } catch { /* ignore */ } }
    this.rl = null;
    this.socket = null;
    await this.connect(portData.port);
    if (this.subscribedMethods.length) this.subscribe(this.subscribedMethods);
  }

  async attachTurn(threadId, turnId) {
    return await this.localRequest("turn/attach", { threadId, turnId });
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  // -- High-level operations (same interface as AppServerClient) --

  async initialize() {
    // Broker is already initialized — just return cached info
    return { serverInfo: { name: "broker-proxy" } };
  }

  async checkAuth() {
    // Broker already checked auth on startup — ping to verify connection
    await this.localRequest("ping");
    return { email: "broker-cached", type: "broker" };
  }

  async listModels() {
    return await listAllModels(params => this.request("model/list", params));
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
        throw new CodexError(4, `Thread resume failed: ${err.message}`);
      }
      throw new CodexError(4, `Thread resume failed: ${err.message || JSON.stringify(err)}`);
    }
  }

  async interruptTurn(threadId, turnId) {
    return await this.request("turn/interrupt", { threadId, turnId }, INIT_TIMEOUT_MS);
  }

  async startTurn(threadId, inputText, opts = {}) {
    const timeoutMs = opts.timeout ?? DEFAULT_HARD_TIMEOUT_MS;
    const onDelta = opts.onDelta || (() => {});
    const cancelSignal = opts.cancelSignal || (() => false);
    const heartbeatMs = Math.max(50, Number(process.env.CODEX_REVIEW_HEARTBEAT_MS) || 5_000);

    // Subscribe to turn notifications
    this.subscribe(["item/agentMessage/delta", "turn/completed", "broker/turn-failed", "error"]);

    return new Promise((resolveP, rejectP) => {
      let agentText = "";
      let resolved = false;
      let turnId = null;
      let reconnectCount = 0;
      let reconnectAttemptCount = 0;
      let reconnecting = false;
      let interruptSent = false;
      let pendingInterruptReason = null;
      let interruptReason = null;
      let interruptError = null;
      let interruptGraceTimer = null;
      let heartbeatTimer = null;
      let heartbeatInFlight = false;
      let missedHeartbeats = 0;
      const reconnectDelays = [250, 1000, 2000];

      const cleanup = () => {
        if (hardTimer) clearTimeout(hardTimer);
        if (cancelChecker) clearInterval(cancelChecker);
        if (interruptGraceTimer) clearTimeout(interruptGraceTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        removeDisconnectHandler();
        for (const [, pending] of this.pendingRequests) {
          pending.resolve(null);
        }
        this.pendingRequests.clear();
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolveP({ ...result, turnId, reconnectCount });
      };

      const fail = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        rejectP(err);
      };

      const handleDisconnect = async () => {
        if (resolved || reconnecting) return;
        if (!turnId) {
          fail(new CodexError(6, "Broker disconnected before the turn id was received"));
          return;
        }
        reconnecting = true;
        let lastError = null;
        for (const delayMs of reconnectDelays) {
          reconnectAttemptCount += 1;
          opts.onReconnectAttempt?.(reconnectAttemptCount, delayMs);
          await sleep(delayMs);
          try {
            await this.reconnect();
            const snapshot = await this.attachTurn(threadId, turnId);
            agentText = snapshot?.text || "";
            reconnectCount += 1;
            missedHeartbeats = 0;
            opts.onReconnect?.(reconnectCount, agentText.length, snapshot);
            reconnecting = false;
            if (snapshot?.status && snapshot.status !== "inProgress") {
              finish({
                text: agentText,
                status: snapshot.status === "interrupted" ? "cancelled" : snapshot.status,
              });
            } else if (pendingInterruptReason) {
              void requestInterrupt(pendingInterruptReason);
            }
            return;
          } catch (error) {
            lastError = error;
          }
        }
        finish({
          text: agentText,
          status: "connection_failed_partial",
          error: lastError?.message || String(lastError || "Broker reconnect failed"),
        });
      };
      const removeDisconnectHandler = this.onDisconnect(handleDisconnect);

      const heartbeat = async () => {
        if (resolved || reconnecting || heartbeatInFlight) return;
        heartbeatInFlight = true;
        try {
          await this.localRequest("ping", {}, heartbeatMs);
          missedHeartbeats = 0;
        } catch {
          if (resolved || reconnecting) return;
          missedHeartbeats += 1;
          if (missedHeartbeats >= 2) {
            this.socket?.destroy();
          }
        } finally {
          heartbeatInFlight = false;
        }
      };

      const requestInterrupt = async (reason) => {
        if (resolved || interruptSent) return;
        pendingInterruptReason ||= reason;
        if (!turnId || reconnecting || !this.connectionActive) return;
        interruptSent = true;
        interruptReason = pendingInterruptReason;
        interruptGraceTimer = setTimeout(() => {
          finish({ text: agentText, status: interruptReason, interruptError });
        }, INTERRUPT_GRACE_MS);
        try {
          await this.interruptTurn(threadId, turnId);
        } catch (error) {
          interruptError = extractAppServerErrorMessage(error);
          if (!this.connectionActive || reconnecting) {
            interruptSent = false;
            if (interruptGraceTimer) clearTimeout(interruptGraceTimer);
            interruptGraceTimer = null;
          }
        }
      };

      const hardTimer = timeoutMs > 0
        ? setTimeout(() => { void requestInterrupt("timeout_partial"); }, timeoutMs)
        : null;

      const cancelChecker = setInterval(() => {
        if (cancelSignal()) {
          void requestInterrupt("cancelled");
        }
      }, CANCEL_CHECK_MS);

      this.onNotification("item/agentMessage/delta", (params) => {
        if (params?.threadId !== threadId || !turnId || params?.turnId !== turnId) return;
        agentText += params?.delta || "";
        onDelta(agentText.length);
      });

      this.onNotification("turn/completed", (params) => {
        const turn = params?.turn;
        if (params?.threadId !== threadId || !turnId || turn?.id !== turnId) return;
        if (turn?.status === "completed") {
          finish({ text: agentText, status: interruptReason || "completed", interruptError });
        } else if (turn?.status === "failed") {
          const error = turn?.error || params?.error;
          const errMsg = extractAppServerErrorMessage(error || params?.error || "Turn failed");
          if (error?.codexErrorInfo === "usageLimitExceeded" || errMsg.includes("usage limit")) {
            fail(new CodexError(3, `Rate limit exceeded: ${errMsg}`));
          } else {
            fail(new CodexError(6, `Turn failed: ${errMsg}`));
          }
        } else {
          finish({
            text: agentText,
            status: interruptReason || (turn?.status === "interrupted" ? "cancelled" : turn?.status || "unknown"),
            interruptError,
          });
        }
      });

      this.onNotification("error", (params) => {
        const error = params?.error;
        if (error?.codexErrorInfo === "usageLimitExceeded") {
          fail(new CodexError(3, `Rate limit exceeded: ${error.message}`));
        }
      });

      this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: inputText }],
          cwd: opts.cwd,
          model: opts.model || DEFAULT_MODEL,
          effort: opts.effort || "high",
        },
        INIT_TIMEOUT_MS
      ).then((result) => {
        turnId = result?.turn?.id || null;
        if (!turnId) fail(new CodexError(6, "Turn start returned no turn id"));
        else {
          opts.onStarted?.(turnId);
          heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs);
          if (pendingInterruptReason) void requestInterrupt(pendingInterruptReason);
        }
      }).catch((err) => {
        fail(err instanceof CodexError ? err : new CodexError(6, `Turn start failed: ${extractAppServerErrorMessage(err)}`));
      });

      this.onNotification("broker/turn-failed", (params) => {
        if (params?.threadId !== threadId || !turnId || params?.turnId !== turnId) return;
        finish({
          text: agentText,
          status: "connection_failed_partial",
          error: params?.error?.message || "App server exited unexpectedly",
        });
      });
    });
  }

  close() {
    this.connectionActive = false;
    this.disconnectNotified = true;
    this.notificationHandlers.clear();
    this.pendingRequests.clear();
    this.disconnectHandlers.clear();
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}

/**
 * Try to connect to an existing broker. If no broker is running, start one
 * as a detached process and wait for it to become ready.
 *
 * Returns a connected BrokerClient, or null if broker is unavailable
 * (caller should fall back to direct AppServerClient).
 */
async function connectExistingBroker() {
  if (existsSync(BROKER_PORT_FILE)) {
    const portData = readJson(BROKER_PORT_FILE);
    if (portData?.port && portData?.pid) {
      // Verify broker is alive
      if (isAlive(portData.pid)) {
        try {
          const client = new BrokerClient();
          await client.connect(portData.port);
          log("Connected to existing broker");
          return client;
        } catch {
          log("Broker port file exists but connection failed, starting new broker");
        }
      } else {
        removeFile(BROKER_PORT_FILE);
      }
    }
  }
  return null;
}

async function waitForBrokerReady() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const client = await connectExistingBroker();
    if (client) return client;
  }
  return null;
}

async function connectOrStartBroker(retryCount = 0) {
  const existing = await connectExistingBroker();
  if (existing) return existing;

  // Start new broker
  if (!existsSync(BROKER_SCRIPT)) {
    log("Broker script not found, falling back to direct connection");
    return null;
  }

  if (!existsSync(BROKER_TMP)) {
    mkdirSync(BROKER_TMP, { recursive: true });
  }

  let ownsStartLock = false;
  try {
    const lockFd = openSync(BROKER_START_LOCK, "wx");
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    closeSync(lockFd);
    ownsStartLock = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  if (!ownsStartLock) {
    log("Another worker is starting the broker; waiting for readiness");
    const client = await waitForBrokerReady();
    if (client) return client;
    const lock = readJson(BROKER_START_LOCK);
    if (retryCount === 0 && (!lock?.pid || !isAlive(lock.pid))) {
      removeFile(BROKER_START_LOCK);
      return await connectOrStartBroker(1);
    }
    log("Broker startup owner did not become ready; falling back to direct connection");
    return null;
  }

  try {
    log("Starting new broker...");
    const logPath = resolve(BROKER_TMP, "broker.log");
    const logFd = openSync(logPath, "w");

    const brokerProc = spawn(process.execPath, [BROKER_SCRIPT], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      windowsHide: true,
    });
    brokerProc.unref();
    closeSync(logFd);

    const client = await waitForBrokerReady();
    if (client) return client;
    log("Broker startup timeout, falling back to direct connection");
    return null;
  } finally {
    removeFile(BROKER_START_LOCK);
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
  cancel:   (dir, sid) => resolve(dir, `${sid}_cancel`),
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
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, path);
        renamed = true;
        return;
      } catch (error) {
        const delayMs = PROGRESS_RENAME_RETRY_DELAYS_MS[attempt];
        if (!RETRYABLE_RENAME_CODES.has(error?.code) || delayMs === undefined) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
  } finally {
    if (!renamed) removeFile(tmp);
  }
}

function removeFile(path) {
  if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
}

function loadState(dir, sid) { return readJson(fp.state(dir, sid)); }
function saveState(dir, sid, data) { writeJson(fp.state(dir, sid), data); }

function loadProgress(dir, sid) { return readJson(fp.progress(dir, sid)); }
function saveProgress(dir, sid, data) {
  try {
    writeJsonAtomic(fp.progress(dir, sid), data);
    return true;
  } catch (error) {
    log(`Progress update skipped: ${error?.message || error}`);
    return false;
  }
}

/**
 * PID file stores JSON: { pid, nonce, ownerSessionId? } for identity verification
 * and Claude-session-scoped lifecycle cleanup.
 * Nonce is checked against /proc/<pid>/cmdline before signaling
 * to prevent killing a recycled PID belonging to a different process.
 */
function readPidFile(dir, sid) {
  const p = fp.pid(dir, sid);
  if (!existsSync(p)) return null;
  const data = readJson(p);
  if (!data) return null;
  // Handle legacy bare-number format
  if (typeof data === "number") {
    return { pid: data, nonce: null, ownerSessionId: null };
  }
  return {
    pid: data.pid,
    nonce: data.nonce || null,
    ownerSessionId: data.ownerSessionId || null,
  };
}

function writePidFile(dir, sid, pid, nonce, ownerSessionId = null) {
  writeJson(fp.pid(dir, sid), {
    pid,
    nonce,
    ...(ownerSessionId ? { ownerSessionId } : {}),
  });
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

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[codex-review] ${msg}\n`);
}

function extractAppServerErrorMessage(value) {
  if (typeof value === "string") {
    try {
      return extractAppServerErrorMessage(JSON.parse(value));
    } catch {
      return value;
    }
  }

  if (!value || typeof value !== "object") {
    return String(value || "Unknown App Server error");
  }

  const nested = value.error ?? value.message ?? value.detail;
  if (nested !== undefined && nested !== value) {
    return extractAppServerErrorMessage(nested);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function enrichUnsupportedModelError(error, model, availableModels) {
  const message = extractAppServerErrorMessage(error?.message || error);
  if (!/not supported|unsupported model|model.+not available/i.test(message)) {
    return error;
  }

  const alternatives = availableModels.filter(name => name !== model);
  return new CodexError(error?.exitCode || 6, [
    `Model "${model}" was rejected by the authenticated Codex account: ${message}`,
    `Available models: ${alternatives.join(", ") || "query model/list for this account"}`,
    "No fallback was performed. Choose a supported model with --model or CODEX_REVIEW_MODEL.",
  ].join("\n"));
}

async function listAllModels(requestPage) {
  const data = [];
  const seenCursors = new Set();
  let cursor = null;

  do {
    const params = { includeHidden: true };
    if (cursor) params.cursor = cursor;
    const result = await requestPage(params);
    if (Array.isArray(result?.data)) data.push(...result.data);

    const nextCursor = result?.nextCursor;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`model/list returned a repeated cursor: ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return { data, nextCursor: null };
}

function normalizeModelCatalog(result) {
  const entries = Array.isArray(result?.data) ? result.data : [];
  const accepted = new Set();
  const visible = [];

  for (const entry of entries) {
    for (const value of [entry?.id, entry?.model]) {
      if (typeof value === "string" && value.trim()) {
        accepted.add(value.trim());
      }
    }

    const display = entry?.model || entry?.id;
    if (!entry?.hidden && typeof display === "string" && !visible.includes(display)) {
      visible.push(display);
    }
  }

  return { accepted, visible };
}

async function validateModelAvailability(client, model) {
  let result;
  try {
    result = await client.listModels();
  } catch (err) {
    log(`Warning: could not validate model availability (${err?.message || JSON.stringify(err)}); continuing without preflight validation.`);
    return [];
  }

  const catalog = normalizeModelCatalog(result);
  if (!catalog.accepted.has(model)) {
    throw new CodexError(6, [
      `Model "${model}" is not available for the current Codex account.`,
      `Available models: ${catalog.visible.join(", ") || "none reported"}`,
      "No fallback was performed. Choose a supported model with --model or CODEX_REVIEW_MODEL.",
    ].join("\n"));
  }

  return catalog.visible;
}

// ---------------------------------------------------------------------------
// Worker — runs as a detached child process
// ---------------------------------------------------------------------------

async function workerMain(parsed) {
  const { command, positional, sessionId, reviewDir, projectRoot, model, modelExplicit, timeout } = parsed;
  const promptFile = resolve(positional[0]);
  const outputFile = resolve(positional[1]);
  const promptText = readFileSync(promptFile, "utf8");
  const hardTimeout = timeout || DEFAULT_HARD_TIMEOUT_MS;
  const startMs = Date.now();

  let cancelled = false;
  let charsReceived = 0;
  let activeTurnId = null;
  let reconnectCount = 0;
  let reconnectAttemptCount = 0;
  let currentPhase = "connecting";
  let firstOutputAt = null;
  const warnings = promptText.length > LARGE_PROMPT_CHARS
    ? [`Large prompt (${promptText.length} chars) may increase time to first output.`]
    : [];

  // Graceful cancel on SIGTERM
  process.on("SIGTERM", () => { cancelled = true; });

  const progressContext = {
    startedAt: new Date(startMs).toISOString(),
    projectRoot,
    promptChars: promptText.length,
    charsReceived: 0,
    reconnectCount: 0,
    reconnectAttemptCount: 0,
    ...(warnings.length ? { warnings } : {}),
  };

  const progress = (status = currentPhase, extra = {}) => {
    currentPhase = status;
    Object.assign(progressContext, extra, { charsReceived, reconnectCount });
    saveProgress(reviewDir, sessionId, {
      ...progressContext,
      status,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startMs,
    });
  };

  progress("connecting");

  // Try broker first, fall back to direct AppServerClient
  // Broker can be disabled via env (useful for testing with fake-codex)
  const brokerDisabled = !!process.env.CODEX_REVIEW_NO_BROKER;
  let client = brokerDisabled ? null : await connectOrStartBroker();
  let usedBroker = !!client;

  if (!client) {
    client = new AppServerClient();
    await client.spawn();
    await client.initialize();
    const account = await client.checkAuth();
    log(`Auth (direct): ${account.type} / ${account.planType} / ${account.email}`);
  } else {
    log("Using broker connection (auth cached)");
  }

  try {

    let threadId;
    let effectiveModel = model;
    let state = null;

    if (command !== "start") {
      state = loadState(reviewDir, sessionId);
      if (!state?.threadId) {
        throw new CodexError(4, `No active session found for ${sessionId}. Run 'start' first.`);
      }
      if (!state.projectRoot) {
        throw new CodexError(6, "This session predates project binding. Start a new session in the current project.");
      }
      if (!sameProject(state.projectRoot, projectRoot)) {
        throw new CodexError(6, [
          "Session belongs to a different project.",
          `Session: ${state.projectRoot}`,
          `Current: ${projectRoot}`,
          "Start a new session here.",
        ].join("\n"));
      }
      effectiveModel = modelExplicit ? model : (state.model || model || DEFAULT_MODEL);
    }

    progress("validating_model", { model: effectiveModel });
    const availableModels = await validateModelAvailability(client, effectiveModel);

    progress("starting_thread", { model: effectiveModel });

    if (command === "start") {
      const threadResult = await client.startThread({ model: effectiveModel, cwd: projectRoot });
      threadId = threadResult.thread.id;
      log(`Thread created: ${threadId} (model: ${effectiveModel})`);
      saveState(reviewDir, sessionId, {
        threadId,
        model: effectiveModel,
        projectRoot,
        createdAt: new Date().toISOString(),
        turnCount: 0,
      });
    } else {
      // follow-up
      threadId = state.threadId;
      await client.resumeThread(threadId);
      log(`Thread resumed: ${threadId} (model: ${effectiveModel})`);
    }

    progress("waiting_first_output", { threadId });

    // Periodic progress file updates
    const progressTimer = setInterval(() => {
      progress(currentPhase, { threadId, turnId: activeTurnId });
    }, PROGRESS_INTERVAL_MS);

    // Execute turn
    log(`Starting turn (model: ${effectiveModel})`);
    let turnResult;
    try {
      turnResult = await client.startTurn(threadId, promptText, {
        model: effectiveModel,
        cwd: projectRoot,
        timeout: hardTimeout,
        onDelta: (chars) => {
          charsReceived = chars;
          const now = new Date();
          if (!firstOutputAt) {
            firstOutputAt = now.toISOString();
          }
          progress("streaming", {
            threadId,
            turnId: activeTurnId,
            firstOutputAt,
            firstOutputMs: new Date(firstOutputAt).getTime() - startMs,
            lastEventAt: now.toISOString(),
          });
        },
        onStarted: (turnId) => {
          activeTurnId = turnId;
          progress("waiting_first_output", { threadId, turnId });
        },
        onReconnect: (count, chars, snapshot) => {
          reconnectCount = count;
          charsReceived = chars;
          if (!firstOutputAt && snapshot?.firstOutputAt) {
            firstOutputAt = snapshot.firstOutputAt;
          }
          progress("reconnecting", {
            threadId,
            turnId: activeTurnId,
            ...(firstOutputAt ? {
              firstOutputAt,
              firstOutputMs: new Date(firstOutputAt).getTime() - startMs,
            } : {}),
            ...(snapshot?.updatedAt ? { lastEventAt: snapshot.updatedAt } : {}),
          });
        },
        onReconnectAttempt: (attempt) => {
          reconnectAttemptCount = attempt;
          progress("reconnecting", {
            threadId,
            turnId: activeTurnId,
            reconnectAttemptCount,
          });
        },
        cancelSignal: () => cancelled || existsSync(fp.cancel(reviewDir, sessionId)),
      });
    } catch (err) {
      throw enrichUnsupportedModelError(err, effectiveModel, availableModels);
    }

    clearInterval(progressTimer);

    log(`Turn finished: ${turnResult.status} (${turnResult.text.length} chars)`);

    // Write output (full or partial)
    writeFileSync(outputFile, turnResult.text, "utf8");

    // Update state
    const updatedState = loadState(reviewDir, sessionId);
    if (updatedState) {
      updatedState.turnCount = (updatedState.turnCount || 0) + 1;
      saveState(reviewDir, sessionId, updatedState);
    }

    // Final progress
    const finalStatus =
      turnResult.status === "cancelled" ? "cancelled" :
      turnResult.status === "timeout_partial" ? "timeout_partial" :
      turnResult.status === "connection_failed_partial" ? "failed" :
      "completed";

    progress(finalStatus, {
      charsReceived: turnResult.text.length,
      completedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      outputFile,
      threadId,
      turnId: activeTurnId || turnResult.turnId || null,
      reconnectCount: turnResult.reconnectCount ?? reconnectCount,
      ...(turnResult.error ? { error: turnResult.error, exitCode: 6 } : {}),
    });

    if (finalStatus === "cancelled") {
      process.exit(8);
    }
    if (finalStatus === "timeout_partial") {
      log(`Hard timeout reached. Partial output saved (${turnResult.text.length} chars).`);
      process.exit(5);
    }
    if (finalStatus === "failed") {
      log(`Connection failed. Partial output saved (${turnResult.text.length} chars).`);
      process.exit(6);
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
    removeFile(fp.cancel(reviewDir, sessionId));
  }
}

// ---------------------------------------------------------------------------
// CLI Command: start (background)
// ---------------------------------------------------------------------------

function spawnWorker(parsed) {
  const { command, positional, sessionId, reviewDir, projectRoot, model, modelExplicit, defaultModel, timeout } = parsed;

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
  removeFile(fp.cancel(reviewDir, sessionId));
  saveProgress(reviewDir, sessionId, {
    status: "queued",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    "--cwd", projectRoot,
    "--nonce", nonce,
  ];
  if (modelExplicit) {
    workerArgs.push("--model", model);
  }
  if (defaultModel) {
    workerArgs.push("--default-model", defaultModel);
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
    windowsHide: true,
  });

  // Write PID file with nonce and optional Claude session ownership.
  writePidFile(
    reviewDir,
    sessionId,
    worker.pid,
    nonce,
    process.env.CODEX_REVIEW_OWNER_SESSION || null,
  );

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
  if (parsed.stdin) {
    const promptFile = resolve(parsed.positional[0]);
    const promptText = await readStdin();
    if (!promptText.trim()) {
      console.error("Error: empty prompt received from stdin");
      process.exit(6);
    }
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, promptText, "utf8");
    log(`Prompt written from stdin (${promptText.length} chars) → ${promptFile}`);
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

  if (parsed.stdin) {
    const promptFile = resolve(parsed.positional[0]);
    const promptText = await readStdin();
    if (!promptText.trim()) {
      console.error("Error: empty prompt received from stdin");
      process.exit(6);
    }
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, promptText, "utf8");
    log(`Prompt written from stdin (${promptText.length} chars) → ${promptFile}`);
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
  const progressUpdatedAt = new Date(progress.updatedAt || progress.startedAt || 0).getTime();
  const progressRecentlyUpdated = Number.isFinite(progressUpdatedAt)
    && Date.now() - progressUpdatedAt < PROGRESS_INTERVAL_MS * 2;
  if (!pidAlive && ACTIVE_PROGRESS_STATUSES.has(progress.status) && !progressRecentlyUpdated) {
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
  if (ACTIVE_PROGRESS_STATUSES.has(progress.status) && progress.startedAt) {
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
    case "connecting":
    case "validating_model":
    case "starting_thread":
    case "waiting_first_output":
    case "streaming":
    case "running":
    case "reconnecting":
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

  // Use a file signal so Windows workers can interrupt the upstream turn
  // before process termination. SIGTERM does not reliably run Node handlers
  // on Windows.
  writeFileSync(fp.cancel(reviewDir, sessionId), new Date().toISOString(), "utf8");
  log(`Cancellation requested for worker (PID: ${pid})`);

  // Allow cancel polling plus the full upstream interrupt grace period.
  const liveProgress = loadProgress(reviewDir, sessionId);
  const turnStartAllowance = liveProgress?.turnId ? 0 : INIT_TIMEOUT_MS;
  const gracefulDeadline = Date.now()
    + turnStartAllowance + INTERRUPT_GRACE_MS + CANCEL_CHECK_MS + 1500;
  while (Date.now() < gracefulDeadline) {
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
  removeFile(fp.cancel(reviewDir, sessionId));

  // Update progress if still marked as running
  const progress = loadProgress(reviewDir, sessionId);
  if (progress && ACTIVE_PROGRESS_STATUSES.has(progress.status)) {
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
    writeFileSync(fp.cancel(reviewDir, sessionId), new Date().toISOString(), "utf8");
    const liveProgress = loadProgress(reviewDir, sessionId);
    const turnStartAllowance = liveProgress?.turnId ? 0 : INIT_TIMEOUT_MS;
    const gracefulDeadline = Date.now()
      + turnStartAllowance + INTERRUPT_GRACE_MS + CANCEL_CHECK_MS + 1500;
    while (Date.now() < gracefulDeadline && isAlive(pidData.pid)) {
      await sleep(200);
    }
    if (isAlive(pidData.pid)) {
      try { process.kill(pidData.pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }

  // Remove all session files
  removeFile(fp.state(reviewDir, sessionId));
  removeFile(fp.progress(reviewDir, sessionId));
  removeFile(fp.pid(reviewDir, sessionId));
  removeFile(fp.log(reviewDir, sessionId));
  removeFile(fp.cancel(reviewDir, sessionId));

  log(`Session ${sessionId} closed.`);
}

// ---------------------------------------------------------------------------
// CLI Command: scope
// ---------------------------------------------------------------------------

const SCOPE_THRESHOLDS = {
  // Files changed thresholds
  SMALL_FILES: 5,
  LARGE_FILES: 20,
  // Total lines changed thresholds
  SMALL_LINES: 100,
  LARGE_LINES: 500,
  // Untracked file size cap (bytes)
  UNTRACKED_CAP: 24_576,    // 24 KB
  // Inline diff size cap (chars)
  DIFF_CAP: 262_144,        // 256 KB
};

function cmdScope(parsed) {
  const base = parsed.positional[0] || null; // optional base ref

  let shortstat = "";
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let untrackedCount = 0;
  let totalLines = 0;

  try {
    // Determine diff base
    let diffCmd;
    if (base) {
      diffCmd = `git diff --shortstat ${base}...HEAD`;
    } else {
      // Try current branch vs default branch
      let defaultBranch;
      try {
        defaultBranch = execSync(
          "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
        ).trim();
      } catch {
        defaultBranch = "main";
      }

      // Check for uncommitted changes first
      const uncommitted = execSync("git diff --shortstat", { encoding: "utf8", windowsHide: true }).trim();
      const staged = execSync("git diff --cached --shortstat", { encoding: "utf8", windowsHide: true }).trim();

      if (uncommitted || staged) {
        // Working tree mode: uncommitted + staged changes
        diffCmd = "git diff HEAD --shortstat";
      } else {
        // Branch mode: current branch vs default
        diffCmd = `git diff ${defaultBranch}...HEAD --shortstat`;
      }
    }

    shortstat = execSync(diffCmd, { encoding: "utf8", windowsHide: true }).trim();

    // Parse shortstat: "N files changed, N insertions(+), N deletions(-)"
    const filesMatch = shortstat.match(/(\d+) files? changed/);
    const insMatch = shortstat.match(/(\d+) insertions?\(\+\)/);
    const delMatch = shortstat.match(/(\d+) deletions?\(-\)/);

    filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
    insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
    deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
    totalLines = insertions + deletions;

    // Count untracked files
    try {
      const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8", windowsHide: true }).trim();
      untrackedCount = untracked ? untracked.split("\n").length : 0;
    } catch { /* ignore */ }

  } catch (err) {
    // Not in a git repo or git command failed
    console.log(JSON.stringify({
      error: `Git command failed: ${err.message}`,
      recommendation: "foreground",
    }, null, 2));
    process.exit(0);
    return;
  }

  // Determine recommendation
  let recommendation;
  let reason;

  if (totalLines <= SCOPE_THRESHOLDS.SMALL_LINES && filesChanged <= SCOPE_THRESHOLDS.SMALL_FILES) {
    recommendation = "foreground";
    reason = `Small change (${filesChanged} files, ${totalLines} lines)`;
  } else if (totalLines >= SCOPE_THRESHOLDS.LARGE_LINES || filesChanged >= SCOPE_THRESHOLDS.LARGE_FILES) {
    recommendation = "background";
    reason = `Large change (${filesChanged} files, ${totalLines} lines) — background recommended for non-blocking execution`;
  } else {
    recommendation = "either";
    reason = `Medium change (${filesChanged} files, ${totalLines} lines) — either mode works`;
  }

  const result = {
    files_changed: filesChanged,
    insertions,
    deletions,
    total_lines: totalLines,
    untracked_files: untrackedCount,
    recommendation,
    reason,
    thresholds: {
      untracked_cap_bytes: SCOPE_THRESHOLDS.UNTRACKED_CAP,
      diff_cap_chars: SCOPE_THRESHOLDS.DIFF_CAP,
    },
  };

  console.log(JSON.stringify(result, null, 2));
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
  codex-review scope      [<base-ref>]

Options:
  --model <MODEL>       Model to use (default: gpt-5.6-terra, env: CODEX_REVIEW_MODEL)
  --timeout <MS>        Hard timeout in ms (default: 1800000, env: CODEX_REVIEW_TIMEOUT)
  --foreground          Run synchronously (v1 compat)
  --stdin               Read prompt from stdin, write to <prompt-file>

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
  let cwd = null;
  let model = null;
  let defaultModel = null;
  let timeout = null;
  let nonce = null;
  let foreground = false;
  let stdin = false;
  const positional = [];

  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "--session" && raw[i + 1]) {
      sessionId = raw[++i];
    } else if (raw[i] === "--review-dir" && raw[i + 1]) {
      reviewDir = raw[++i];
    } else if (raw[i] === "--cwd" && raw[i + 1]) {
      cwd = raw[++i];
    } else if (raw[i] === "--model" && raw[i + 1]) {
      model = raw[++i];
    } else if (raw[i] === "--default-model" && raw[i + 1]) {
      defaultModel = raw[++i];
    } else if (raw[i] === "--timeout" && raw[i + 1]) {
      timeout = parseInt(raw[++i], 10);
    } else if (raw[i] === "--nonce" && raw[i + 1]) {
      nonce = raw[++i];
    } else if (raw[i] === "--foreground") {
      foreground = true;
    } else if (raw[i] === "--stdin") {
      stdin = true;
    } else if (!raw[i].startsWith("--")) {
      positional.push(raw[i]);
    }
  }

  // scope command doesn't require --session / --review-dir
  if (command === "scope") {
    return {
      command,
      positional,
      sessionId: sessionId || "",
      reviewDir: reviewDir ? resolve(reviewDir) : "",
      projectRoot: resolveProjectRoot(cwd || process.cwd()),
      model: model || process.env.CODEX_REVIEW_MODEL || defaultModel || DEFAULT_MODEL,
      modelExplicit: model !== null,
      defaultModel,
      timeout: DEFAULT_HARD_TIMEOUT_MS,
      nonce,
      foreground,
      stdin,
      isWorker,
    };
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
  const resolvedModel = model || process.env.CODEX_REVIEW_MODEL || defaultModel || DEFAULT_MODEL;
  const resolvedTimeout = timeout
    || (process.env.CODEX_REVIEW_TIMEOUT ? parseInt(process.env.CODEX_REVIEW_TIMEOUT, 10) : null)
    || DEFAULT_HARD_TIMEOUT_MS;

  const projectRoot = resolveProjectRoot(cwd || process.cwd());

  return {
    command,
    positional,
    sessionId,
    reviewDir: resolve(reviewDir),
    projectRoot,
    model: resolvedModel,
    modelExplicit: model !== null,
    defaultModel,
    timeout: resolvedTimeout,
    nonce,
    foreground,
    stdin,
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
      case "scope":
        cmdScope(parsed);
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
