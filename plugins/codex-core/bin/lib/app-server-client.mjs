import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const INIT_TIMEOUT_MS = 30_000;

export class AppServerError extends Error {
  constructor(exitCode, message, details = null, retryable = false) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
    this.retryable = retryable;
  }
}

function messageFrom(value) {
  if (typeof value === "string") return value;
  if (value?.message) return value.message;
  if (value?.error?.message) return value.error.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function resolveLauncher() {
  if (process.env.CODEX_BINARY) {
    return { command: process.execPath, args: [process.env.CODEX_BINARY] };
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const names = process.platform === "win32"
    ? ["codex.cmd", "codex.exe", "codex.ps1", "codex"]
    : ["codex"];
  for (const name of names) {
    const candidate = resolve(home, ".claude", "bin", name);
    if (!existsSync(candidate)) continue;
    if (candidate.endsWith(".ps1")) {
      return { command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate, "app-server"] };
    }
    return { command: candidate, args: ["app-server"] };
  }
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "codex", "app-server"] }
    : { command: "codex", args: ["app-server"] };
}

export class AppServerClient {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.nextMessageId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.disconnectHandlers = new Set();
    this.generation = 0;
    this.closed = false;
  }

  async spawn() {
    const launcher = resolveLauncher();
    const generation = ++this.generation;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const proc = spawn(launcher.command, launcher.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = proc;
      proc.stderr.on("data", () => {});
      proc.once("spawn", () => {
        if (settled || this.proc !== proc || this.generation !== generation) return;
        settled = true;
        resolvePromise();
      });
      proc.on("error", error => {
        if (this.proc !== proc || this.generation !== generation) return;
        const wrapped = error?.code === "ENOENT"
          ? new AppServerError(1, "codex binary not found. Install Codex or run /codex-core:setup.")
          : new AppServerError(6, `Process spawn error: ${error.message}`, null, true);
        if (!settled) {
          settled = true;
          rejectPromise(wrapped);
        }
        this.#disconnect(wrapped, generation);
      });
      proc.on("exit", (code, signal) => {
        if (this.proc !== proc || this.generation !== generation) return;
        this.#disconnect(new AppServerError(6, `App server exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`, null, true), generation);
      });

      const rl = createInterface({ input: proc.stdout });
      this.rl = rl;
      rl.on("line", line => {
        if (this.rl !== rl || this.generation !== generation) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        this.#handleMessage(message);
      });
      rl.on("error", error => {
        if (this.rl === rl && this.generation === generation) {
          this.#disconnect(new AppServerError(6, error?.message || String(error), null, true), generation);
        }
      });
    });
  }

  #handleMessage(message) {
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new AppServerError(6, messageFrom(message.error), message.error);
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    for (const handler of this.handlers.get(message.method) || []) handler(message.params);
  }

  #disconnect(error, generation) {
    if (this.closed || generation !== this.generation) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const handler of this.disconnectHandlers) handler(error);
  }

  onDisconnect(handler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  onNotification(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }

  send(message) {
    if (!this.proc?.stdin?.writable) throw new AppServerError(6, "App server process not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = INIT_TIMEOUT_MS) {
    const id = ++this.nextMessageId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new AppServerError(5, `Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: result => { clearTimeout(timer); resolvePromise(result); },
        reject: error => { clearTimeout(timer); rejectPromise(error); },
      });
      try { this.send({ method, id, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_review", title: "Codex Review", version: "3.0.0" },
    });
    this.send({ method: "initialized", params: {} });
    return result;
  }

  async checkAuth() {
    const result = await this.request("account/read", { refreshToken: false });
    if (!result?.account || (!result.account.email && !result.account.type)) {
      throw new AppServerError(2, "Not authenticated. Run 'codex login' first.");
    }
    return result.account;
  }

  async listModels() {
    const models = [];
    let cursor = null;
    do {
      let page;
      try { page = await this.request("model/list", cursor ? { cursor } : {}); } catch (error) {
        if (messageFrom(error).includes("Method not found")) return null;
        throw error;
      }
      for (const item of page?.data || []) models.push(item.model || item.id);
      cursor = page?.nextCursor || null;
    } while (cursor);
    return models;
  }

  startThread(options) {
    return this.request("thread/start", {
      model: options.model,
      approvalPolicy: "never",
      cwd: options.cwd,
    });
  }

  resumeThread(threadId) {
    return this.request("thread/resume", { threadId }).catch(error => {
      throw new AppServerError(4, `Thread resume failed: ${messageFrom(error)}`, error);
    });
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  startTurn(threadId, prompt, options = {}) {
    const timeoutMs = options.timeoutMs || 1_800_000;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let turnId = null;
      let text = "";
      let interruptSent = false;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(cancelTimer);
        removeDelta();
        removeCompleted();
        removeError();
        removeDisconnect();
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) rejectPromise(error);
        else resolvePromise({ ...result, text, turnId });
      };
      const removeDelta = this.onNotification("item/agentMessage/delta", params => {
        if (!turnId || params?.threadId !== threadId || params?.turnId !== turnId) return;
        const delta = params?.delta || "";
        text += delta;
        options.onDelta?.(delta, text.length);
      });
      const removeCompleted = this.onNotification("turn/completed", params => {
        const turn = params?.turn;
        if (!turnId || params?.threadId !== threadId || turn?.id !== turnId) return;
        if (turn.status === "completed") finish(null, { status: "completed" });
        else if (turn.status === "interrupted") finish(null, { status: "cancelled" });
        else finish(new AppServerError(6, `Turn failed: ${messageFrom(turn?.error || turn?.status)}`, turn?.error));
      });
      const removeError = this.onNotification("error", params => {
        if (params?.error?.codexErrorInfo === "usageLimitExceeded") {
          finish(new AppServerError(3, `Rate limit exceeded: ${messageFrom(params.error)}`, params.error));
        }
      });
      const removeDisconnect = this.onDisconnect(error => finish(error));
      const timer = setTimeout(() => finish(new AppServerError(5, `Turn timed out after ${timeoutMs}ms`)), timeoutMs);
      const cancelTimer = setInterval(() => {
        if (!options.cancelSignal?.() || !turnId || interruptSent || settled) return;
        interruptSent = true;
        this.interruptTurn(threadId, turnId).catch(error => finish(error));
      }, 100);

      this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: options.cwd,
        model: options.model,
        effort: options.effort || "high",
      }).then(result => {
        if (settled) return;
        turnId = result?.turn?.id || null;
        if (!turnId) finish(new AppServerError(6, "Turn start returned no turn id"));
        else options.onStarted?.(turnId);
      }).catch(error => finish(error));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    for (const pending of this.pending.values()) pending.reject(new AppServerError(6, "App server closed"));
    this.pending.clear();
    this.handlers.clear();
    this.disconnectHandlers.clear();
    if (this.rl) { try { this.rl.close(); } catch { /* already closed */ } }
    if (this.proc) { try { this.proc.kill(); } catch { /* already exited */ } }
    this.rl = null;
    this.proc = null;
  }
}
