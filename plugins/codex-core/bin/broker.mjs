#!/usr/bin/env node

/**
 * Codex App Server Broker — Persistent IPC serializer
 *
 * Holds a single codex app-server subprocess and serializes concurrent
 * access from multiple workers via a TCP server on localhost.
 *
 * Benefits:
 *   - Eliminates per-turn app-server spawn overhead (~2-3s saved per call)
 *   - Auth check happens once, reused across all workers
 *   - Thread management is cleaner (single persistent connection)
 *
 * Protocol (line-delimited JSON over TCP):
 *   Client → Broker:
 *     { "action": "request", "method": "...", "params": {...}, "id": N, "timeout": MS }
 *     { "action": "notify",  "method": "...", "params": {...} }
 *     { "action": "subscribe", "methods": ["item/agentMessage/delta", "turn/completed"] }
 *     { "action": "unsubscribe" }
 *     { "action": "ping" }
 *
 *   Broker → Client:
 *     { "type": "response", "id": N, "result": {...} }
 *     { "type": "response", "id": N, "error": {...} }
 *     { "type": "notification", "method": "...", "params": {...} }
 *     { "type": "pong" }
 *     { "type": "error", "message": "..." }
 *
 * Turn serialization:
 *   The upstream codex app-server streams agent deltas and turn events on a
 *   single stdin/stdout pipe without a threadId tag, so two concurrent
 *   `turn/start` requests would produce interleaved notifications that the
 *   broker cannot disambiguate. To prevent cross-turn contamination, the
 *   broker serializes `turn/start`: one turn owns the notification stream at
 *   a time, later requests queue until the previous turn emits a terminal
 *   event (`turn/completed` / `turn/failed` / `turn/cancelled`) or the
 *   client disconnects. Notifications whose method matches `item/*`,
 *   `turn/*`, or `error` are routed only to the active turn's socket;
 *   everything else goes through the normal subscribe fan-out.
 *
 * Lifecycle:
 *   - Starts on first worker connection (via ensureBroker() in codex-review.mjs)
 *   - Auto-shuts down after IDLE_TIMEOUT_MS of no active connections
 *   - Killed by SessionEnd hook (session-lifecycle.mjs)
 *
 * Port file: ~/.claude/tmp/broker.port
 *   { "port": N, "pid": N, "startedAt": "ISO", "serverInfo": {...} }
 */

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  writeFileSync, unlinkSync, existsSync, mkdirSync,
} from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const TMP_DIR = resolve(HOME, ".claude", "tmp");
const PORT_FILE = resolve(TMP_DIR, "broker.port");
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;      // 10 minutes
const INIT_TIMEOUT_MS = 30_000;              // 30s for codex init
const DEFAULT_TURN_TIMEOUT_MS = 1_800_000;   // 30 min (matches codex-review default)
const TURN_SAFETY_BUFFER_MS = 15_000;        // grace window beyond client timeout

const TURN_SCOPED_PREFIXES = ["item/", "turn/"];
const TURN_SCOPED_METHODS = new Set(["error"]);
const TURN_TERMINAL_METHODS = new Set([
  "turn/completed",
  "turn/failed",
  "turn/cancelled",
]);

function isTurnScopedMethod(method) {
  if (!method) return false;
  if (TURN_SCOPED_METHODS.has(method)) return true;
  return TURN_SCOPED_PREFIXES.some((p) => method.startsWith(p));
}

// ---------------------------------------------------------------------------
// Codex binary resolution (mirrors codex-review.mjs resolveCodexLauncher)
// ---------------------------------------------------------------------------

/**
 * Decide how to launch the codex app-server.
 *   1. CODEX_BINARY env — run via `node <bin>` (test fakes / explicit override)
 *   2. ~/.claude/bin/codex — symlink installed by /codex-core:setup
 *   3. PATH `codex` (Windows via `cmd /c codex`)
 */
function resolveCodexLauncher() {
  const customBin = process.env.CODEX_BINARY;
  if (customBin) {
    // Preserve original test-fake invocation: `node <bin>` with no "app-server" arg.
    return { command: process.execPath, prependArgs: [customBin], passAppServerArg: false };
  }

  if (HOME) {
    const isWin = process.platform === "win32";
    const candidates = isWin
      ? ["codex.cmd", "codex.exe", "codex.ps1", "codex"]
      : ["codex"];
    for (const name of candidates) {
      const p = resolve(HOME, ".claude", "bin", name);
      if (existsSync(p)) {
        if (p.endsWith(".ps1")) {
          return { command: "powershell", prependArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p], passAppServerArg: true };
        }
        return { command: p, prependArgs: [], passAppServerArg: true };
      }
    }
  }

  if (process.platform === "win32") {
    return { command: "cmd", prependArgs: ["/c", "codex"], passAppServerArg: true };
  }
  return { command: "codex", prependArgs: [], passAppServerArg: true };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[broker] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// AppServerConnection — wraps the codex app-server subprocess
// ---------------------------------------------------------------------------

class AppServerConnection {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.msgId = 0;
    this.pendingRequests = new Map();
    this.subscribers = new Set();         // Set of { socket, methods }
    this.initialized = false;
    this.serverInfo = null;
    this.account = null;

    // Turn serialization state
    this.activeTurn = null;               // { socket, startedAt, safetyTimer }
    this.turnWaiters = [];                // FIFO queue of { socket, timeoutMs, resolve }
  }

  nextId() { return ++this.msgId; }

  async start() {
    return new Promise((resolveP, rejectP) => {
      const { command, prependArgs, passAppServerArg } = resolveCodexLauncher();
      const spawnArgs = passAppServerArg ? [...prependArgs, "app-server"] : [...prependArgs];
      this.proc = spawn(command, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      this.proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          rejectP(new Error("codex binary not found"));
        } else {
          rejectP(new Error(`Process spawn error: ${err.message}`));
        }
      });

      this.proc.on("exit", (code) => {
        log(`App server exited with code ${code}`);
        this.proc = null;
      });

      this.rl = createInterface({ input: this.proc.stdout });
      this.rl.on("line", (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        this._handleMessage(msg);
      });

      setTimeout(() => resolveP(), 200);
    });
  }

  _handleMessage(msg) {
    // Response to a pending request
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const { resolve: res, reject: rej } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      msg.error ? rej(msg.error) : res(msg.result);
      return;
    }

    if (!msg.method) return;

    // Turn-scoped notifications must never leak between concurrent turns.
    // Route them only to the socket that currently owns the turn; if no turn
    // is active (e.g. trailing notifications arriving after a cancel), drop.
    if (isTurnScopedMethod(msg.method)) {
      const sock = this.activeTurn?.socket;
      if (sock) {
        try {
          sock.write(JSON.stringify({
            type: "notification",
            method: msg.method,
            params: msg.params,
          }) + "\n");
        } catch { /* client disconnected */ }
      }
      if (TURN_TERMINAL_METHODS.has(msg.method)) {
        this._releaseTurn(`terminal:${msg.method}`);
      }
      return;
    }

    // Non-turn notification → forward via subscribe fan-out
    for (const sub of this.subscribers) {
      if (sub.methods.includes("*") || sub.methods.includes(msg.method)) {
        try {
          sub.socket.write(JSON.stringify({
            type: "notification",
            method: msg.method,
            params: msg.params,
          }) + "\n");
        } catch { /* client disconnected */ }
      }
    }
  }

  send(msg) {
    if (!this.proc?.stdin?.writable) {
      throw new Error("App server not running");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    return new Promise((resolveP, rejectP) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectP(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
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

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_review_broker", title: "Codex Review Broker", version: "2.0.0" },
    });
    this.notify("initialized");
    this.serverInfo = result?.serverInfo || {};
    this.initialized = true;
    return result;
  }

  async checkAuth() {
    const result = await this.request("account/read", { refreshToken: false });
    const account = result?.account;
    if (!account || (!account.email && !account.type)) {
      throw new Error("Not authenticated. Run 'codex login' first.");
    }
    this.account = account;
    return account;
  }

  addSubscriber(socket, methods) {
    const sub = { socket, methods };
    this.subscribers.add(sub);
    return sub;
  }

  removeSubscriber(sub) {
    this.subscribers.delete(sub);
  }

  // -- Turn serialization --

  /**
   * Acquire exclusive ownership of the upstream notification stream for a
   * `turn/start` request. Resolves immediately if no turn is active,
   * otherwise queues FIFO until the previous turn releases.
   */
  acquireTurn(socket, timeoutMs) {
    return new Promise((resolve) => {
      const task = { socket, timeoutMs: timeoutMs || DEFAULT_TURN_TIMEOUT_MS, resolve };
      if (!this.activeTurn) {
        this._grantTurn(task);
      } else {
        this.turnWaiters.push(task);
        log(`Turn queued (queue depth: ${this.turnWaiters.length})`);
      }
    });
  }

  _grantTurn(task) {
    const safetyMs = task.timeoutMs + TURN_SAFETY_BUFFER_MS;
    const safetyTimer = setTimeout(() => {
      log(`Turn safety timeout (${safetyMs}ms) — force-releasing`);
      this._releaseTurn("safety-timeout");
    }, safetyMs);
    this.activeTurn = {
      socket: task.socket,
      startedAt: Date.now(),
      safetyTimer,
    };
    task.resolve();
  }

  /**
   * Release the active-turn mutex. Grants the next waiter if any. Safe to
   * call multiple times or when no turn is active.
   */
  _releaseTurn(reason) {
    if (!this.activeTurn) return;
    if (this.activeTurn.safetyTimer) clearTimeout(this.activeTurn.safetyTimer);
    this.activeTurn = null;
    if (this.turnWaiters.length > 0) {
      const next = this.turnWaiters.shift();
      // Skip waiters whose socket has already disconnected
      if (next.socket.destroyed) {
        this._releaseTurn("skip-dead-waiter");
        return;
      }
      log(`Turn released (${reason || "unknown"}), granting queued waiter`);
      this._grantTurn(next);
    } else if (reason) {
      log(`Turn released (${reason})`);
    }
  }

  /**
   * Handle a socket closing: release the turn if this socket owns it, and
   * drop it from the waiter queue.
   */
  onSocketClose(socket) {
    // Drop from waiter queue
    if (this.turnWaiters.length > 0) {
      this.turnWaiters = this.turnWaiters.filter((w) => w.socket !== socket);
    }
    // Release if this socket owns the active turn
    if (this.activeTurn?.socket === socket) {
      this._releaseTurn("socket-closed");
    }
  }

  close() {
    if (this.activeTurn?.safetyTimer) clearTimeout(this.activeTurn.safetyTimer);
    this.activeTurn = null;
    this.turnWaiters = [];
    this.pendingRequests.clear();
    this.subscribers.clear();
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// BrokerServer
// ---------------------------------------------------------------------------

class BrokerServer {
  constructor() {
    this.appServer = new AppServerConnection();
    this.server = null;
    this.clients = new Set();
    this.idleTimer = null;
  }

  async start() {
    // Ensure tmp dir exists
    if (!existsSync(TMP_DIR)) {
      mkdirSync(TMP_DIR, { recursive: true });
    }

    // Start codex app-server
    log("Starting codex app-server...");
    await this.appServer.start();
    const initResult = await this.appServer.initialize();
    log(`App server initialized: ${JSON.stringify(initResult?.serverInfo || {})}`);

    const account = await this.appServer.checkAuth();
    log(`Authenticated: ${account.type} / ${account.email}`);

    // Start TCP server
    return new Promise((resolveP) => {
      this.server = createServer((socket) => this._onConnection(socket));
      this.server.listen(0, "127.0.0.1", () => {
        const port = this.server.address().port;
        log(`Broker listening on 127.0.0.1:${port}`);

        // Write port file
        const portData = {
          port,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          serverInfo: this.appServer.serverInfo,
          account: { email: account.email, type: account.type },
        };
        writeFileSync(PORT_FILE, JSON.stringify(portData, null, 2), "utf8");

        this._resetIdleTimer();
        resolveP(port);
      });
    });
  }

  _onConnection(socket) {
    this.clients.add(socket);
    this._resetIdleTimer();
    log(`Client connected (${this.clients.size} active)`);

    let subscription = null;

    const rl = createInterface({ input: socket });
    rl.on("line", async (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      try {
        switch (msg.action) {
          case "request": {
            const timeoutMs = msg.timeout || INIT_TIMEOUT_MS;
            const isTurnStart = msg.method === "turn/start";
            let acquired = false;

            if (isTurnStart) {
              await this.appServer.acquireTurn(socket, timeoutMs);
              acquired = true;
            }

            try {
              const result = await this.appServer.request(msg.method, msg.params, timeoutMs);
              socket.write(JSON.stringify({ type: "response", id: msg.id, result }) + "\n");
            } catch (err) {
              if (isTurnStart && acquired && this.appServer.activeTurn?.socket === socket) {
                // turn/start request failed before upstream streamed terminal event;
                // release the mutex so other clients aren't blocked.
                this.appServer._releaseTurn("turn-start-request-error");
              }
              throw err;
            }
            break;
          }

          case "notify":
            this.appServer.notify(msg.method, msg.params);
            break;

          case "subscribe":
            if (subscription) {
              this.appServer.removeSubscriber(subscription);
            }
            subscription = this.appServer.addSubscriber(socket, msg.methods || ["*"]);
            break;

          case "unsubscribe":
            if (subscription) {
              this.appServer.removeSubscriber(subscription);
              subscription = null;
            }
            break;

          case "ping":
            socket.write(JSON.stringify({ type: "pong" }) + "\n");
            break;

          default:
            socket.write(JSON.stringify({
              type: "error",
              message: `Unknown action: ${msg.action}`,
            }) + "\n");
        }
      } catch (err) {
        socket.write(JSON.stringify({
          type: "response",
          id: msg.id,
          error: { message: err.message || String(err) },
        }) + "\n");
      }
    });

    const cleanup = () => {
      this.clients.delete(socket);
      if (subscription) {
        this.appServer.removeSubscriber(subscription);
        subscription = null;
      }
      this.appServer.onSocketClose(socket);
      rl.close();
    };

    socket.on("close", () => {
      cleanup();
      log(`Client disconnected (${this.clients.size} active)`);
      this._resetIdleTimer();
    });

    socket.on("error", () => {
      cleanup();
    });
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => {
        log(`Idle timeout (${IDLE_TIMEOUT_MS / 1000}s) — shutting down`);
        this.shutdown();
      }, IDLE_TIMEOUT_MS);
    }
  }

  shutdown() {
    log("Shutting down broker...");

    // Clean up port file
    try { unlinkSync(PORT_FILE); } catch { /* ignore */ }

    // Close all client connections
    for (const socket of this.clients) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();

    // Close TCP server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Close app-server
    this.appServer.close();

    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const broker = new BrokerServer();

  // Graceful shutdown signals
  process.on("SIGTERM", () => broker.shutdown());
  process.on("SIGINT", () => broker.shutdown());

  try {
    await broker.start();
  } catch (err) {
    log(`Fatal: ${err.message}`);
    // Clean up port file on failure
    try { unlinkSync(PORT_FILE); } catch { /* ignore */ }
    process.exit(1);
  }
}

main();
