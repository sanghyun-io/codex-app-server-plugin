#!/usr/bin/env node

/**
 * Codex App Server Broker — Persistent IPC multiplexer
 *
 * Holds a single codex app-server subprocess and multiplexes concurrent
 * workers via a TCP server on localhost.
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
 * Turn routing:
 *   Current App Server turn and item notifications carry threadId/turnId.
 *   The broker forwards subscribed notifications and each worker accepts
 *   only events matching its active protocol identity.
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

    // Forward via subscribe fan-out. Workers scope turn events by protocol id.
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
      clientInfo: { name: "codex_review_broker", title: "Codex Review Broker", version: "2.4.0" },
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

  close() {
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
            const result = await this.appServer.request(msg.method, msg.params, timeoutMs);
            socket.write(JSON.stringify({ type: "response", id: msg.id, result }) + "\n");
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
        const serializedError = err && typeof err === "object"
          ? { ...err, ...(err.message ? { message: err.message } : {}) }
          : { message: String(err) };
        socket.write(JSON.stringify({
          type: "response",
          id: msg.id,
          error: serializedError,
        }) + "\n");
      }
    });

    const cleanup = () => {
      this.clients.delete(socket);
      if (subscription) {
        this.appServer.removeSubscriber(subscription);
        subscription = null;
      }
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
