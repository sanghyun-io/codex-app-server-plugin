#!/usr/bin/env node

/**
 * Session Lifecycle Hook — SessionStart / SessionEnd handler
 *
 * SessionStart: Exports session metadata to env file for worker coordination.
 * SessionEnd:   Kills all running workers, shuts down broker, cleans up temp files.
 *
 * Invoked by Claude Code hooks system via hooks.json.
 *
 * Environment:
 *   CLAUDE_SESSION_ID   — Current session ID (set by Claude Code)
 *   CLAUDE_PLUGIN_ROOT  — Plugin root directory
 *   HOME                — User home directory
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const TMP_DIR = resolve(HOME, ".claude", "tmp");
const HOOK_EVENT = process.argv[2] || ""; // "start" or "end"

function log(msg) {
  process.stderr.write(`[session-lifecycle] ${msg}\n`);
}

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    log(`Warning: Could not parse hook input: ${err.message}`);
    return {};
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safeSessionId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

const hookInput = readHookInput();
const SESSION_ID = hookInput.session_id || process.env.CLAUDE_SESSION_ID || "";

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function removeFile(path) {
  if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

function onSessionStart() {
  if (!SESSION_ID) {
    log("Warning: SessionStart has no session identity; skipping owner export");
    return;
  }

  mkdirSync(TMP_DIR, { recursive: true });

  // Write session env file for worker coordination
  const envPath = resolve(TMP_DIR, `session_${safeSessionId(SESSION_ID)}.env`);
  const envContent = [
    `SESSION_ID=${SESSION_ID}`,
    `STARTED_AT=${new Date().toISOString()}`,
    `TMP_DIR=${TMP_DIR}`,
  ].join("\n");

  try {
    writeFileSync(envPath, envContent, "utf8");
    log(`Session started: ${SESSION_ID}`);
  } catch (err) {
    log(`Warning: Could not write session env: ${err.message}`);
  }

  const claudeEnvFile = process.env.CLAUDE_ENV_FILE;
  if (claudeEnvFile) {
    try {
      appendFileSync(
        claudeEnvFile,
        `export CODEX_REVIEW_OWNER_SESSION=${shellQuote(SESSION_ID)}\n`,
        "utf8",
      );
    } catch (err) {
      log(`Warning: Could not export session ownership: ${err.message}`);
    }
  } else {
    log("Warning: CLAUDE_ENV_FILE is unavailable; review ownership was not exported");
  }
}

// ---------------------------------------------------------------------------
// SessionEnd
// ---------------------------------------------------------------------------

function onSessionEnd() {
  if (!existsSync(TMP_DIR)) {
    log("No tmp directory found, nothing to clean up");
    return;
  }

  let killedWorkers = 0;
  let cleanedFiles = 0;

  try {
    const files = readdirSync(TMP_DIR);

    // 1. Kill all running workers (find PID files)
    const pidFiles = files.filter(f => f.endsWith("_pid"));
    for (const pidFile of pidFiles) {
      const pidPath = resolve(TMP_DIR, pidFile);
      const pidData = readJson(pidPath);
      if (!pidData) continue;

      const pid = pidData.pid;
      if (pid && isAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          killedWorkers++;
          log(`Killed worker PID ${pid} (${pidFile})`);
        } catch (err) {
          log(`Warning: Could not kill PID ${pid}: ${err.message}`);
        }
      }
      removeFile(pidPath);
    }

    // 2. Kill broker if running
    const brokerPortFile = resolve(TMP_DIR, "broker.port");
    const brokerData = readJson(brokerPortFile);
    if (brokerData?.pid && isAlive(brokerData.pid)) {
      try {
        process.kill(brokerData.pid, "SIGTERM");
        log(`Killed broker PID ${brokerData.pid}`);
      } catch { /* ignore */ }
    }
    removeFile(brokerPortFile);

    // 3. Clean up session files (progress, state, logs, env)
    const sessionPatterns = ["_progress.json", "_state.json", "_worker.log"];
    for (const file of files) {
      if (sessionPatterns.some(p => file.endsWith(p))) {
        removeFile(resolve(TMP_DIR, file));
        cleanedFiles++;
      }
    }

    // Clean up session env file
    const envFile = resolve(TMP_DIR, `session_${SESSION_ID}.env`);
    removeFile(envFile);

    log(`Session ended: killed ${killedWorkers} worker(s), cleaned ${cleanedFiles} file(s)`);
  } catch (err) {
    log(`Warning: Cleanup error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (HOOK_EVENT === "start") {
  onSessionStart();
} else if (HOOK_EVENT === "end") {
  onSessionEnd();
} else {
  // Auto-detect from hook type name
  const hookType = process.env.CLAUDE_HOOK_TYPE || "";
  if (hookType === "SessionStart" || hookType.toLowerCase().includes("start")) {
    onSessionStart();
  } else {
    onSessionEnd();
  }
}
