import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeDurableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w");
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function runtimePaths(runtimeDir) {
  const root = resolve(runtimeDir);
  const supervisorDir = join(root, "supervisor");
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\codex-review-v3-${suffix}`
    : join(supervisorDir, "supervisor.sock");
  return {
    runtimeDir: root,
    supervisorDir,
    endpoint,
    endpointFile: join(supervisorDir, "endpoint.json"),
    lockFile: join(supervisorDir, "startup.lock"),
  };
}

export function acquireStartupLock(runtimeDir, identity = {}) {
  const paths = runtimePaths(runtimeDir);
  mkdirSync(paths.supervisorDir, { recursive: true });
  const record = {
    pid: identity.pid || process.pid,
    nonce: identity.nonce || randomBytes(12).toString("hex"),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(paths.lockFile, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, ...record, path: paths.lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(readFileSync(paths.lockFile, "utf8")); } catch { /* stale */ }
      if (existing && isProcessAlive(Number(existing.pid))) {
        return { acquired: false, ...existing, path: paths.lockFile };
      }
      try { unlinkSync(paths.lockFile); } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") return { acquired: false, ...existing, path: paths.lockFile };
      }
    }
  }
  return { acquired: false, path: paths.lockFile };
}

export function releaseStartupLock(runtimeDir, nonce) {
  const { lockFile } = runtimePaths(runtimeDir);
  let current;
  try { current = JSON.parse(readFileSync(lockFile, "utf8")); } catch { return false; }
  if (!nonce || current.nonce !== nonce) return false;
  try {
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || "RUNTIME_ERROR",
  };
}

function send(socket, payload) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(payload)}\n`);
}

export async function createRuntimeServer(options) {
  const { runtimeDir, onRequest } = options;
  const token = options.token || randomBytes(32).toString("hex");
  const paths = runtimePaths(runtimeDir);
  mkdirSync(paths.supervisorDir, { recursive: true });
  if (process.platform !== "win32" && existsSync(paths.endpoint)) {
    try { unlinkSync(paths.endpoint); } catch { /* listen reports a useful error */ }
  }

  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    let cleaned = false;
    const rl = createInterface({ input: socket });
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sockets.delete(socket);
      try { rl.close(); } catch { /* already closed */ }
    };

    socket.on("error", cleanup);
    socket.on("close", cleanup);
    rl.on("error", cleanup);
    rl.on("line", async line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send(socket, { id: null, error: { code: "INVALID_FRAME", message: "Malformed runtime frame" } });
        return;
      }
      if (message.token !== token) {
        send(socket, { id: message.id ?? null, error: { code: "UNAUTHORIZED", message: "Unauthorized runtime client" } });
        return;
      }
      try {
        const result = await onRequest(message);
        send(socket, { id: message.id, result });
      } catch (error) {
        send(socket, { id: message.id, error: serializeError(error) });
      }
    });
  });
  server.on("error", () => {});

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = error => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(paths.endpoint);
  });

  writeDurableJson(paths.endpointFile, {
    schemaVersion: 3,
    endpoint: paths.endpoint,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  return {
    endpoint: paths.endpoint,
    token,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolvePromise => {
        server.close(() => {
          if (process.platform !== "win32") {
            try { unlinkSync(paths.endpoint); } catch { /* removed by Node or already gone */ }
          }
          try { unlinkSync(paths.endpointFile); } catch { /* already removed */ }
          resolvePromise();
        });
      });
    },
  };
}

export function requestRuntime(action, params = {}, options = {}) {
  const paths = runtimePaths(options.runtimeDir);
  let endpointData = {};
  if (existsSync(paths.endpointFile)) {
    endpointData = JSON.parse(readFileSync(paths.endpointFile, "utf8"));
  }
  const endpoint = options.endpoint || endpointData.endpoint || paths.endpoint;
  const token = options.token || endpointData.token;
  const id = options.id || randomBytes(8).toString("hex");
  const timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let rl = null;
    const socket = createConnection(endpoint);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rl) { try { rl.close(); } catch { /* already closed */ } }
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Runtime request timed out after ${timeoutMs}ms`);
      error.code = "RUNTIME_TIMEOUT";
      finish(error);
    }, timeoutMs);
    socket.once("connect", () => {
      rl = createInterface({ input: socket });
      rl.on("error", finish);
      rl.on("line", line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== id) return;
        if (message.error) {
          const error = new Error(message.error.message || "Runtime request failed");
          error.code = message.error.code;
          finish(error);
        } else {
          finish(null, message.result);
        }
      });
      socket.write(`${JSON.stringify({ id, token, action, params })}\n`);
    });
    socket.on("error", finish);
    socket.on("close", hadError => {
      if (!settled && !hadError) finish(new Error("Runtime connection closed before a response"));
    });
  });
}
