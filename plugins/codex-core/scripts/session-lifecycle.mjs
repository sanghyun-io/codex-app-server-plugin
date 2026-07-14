#!/usr/bin/env node

/**
 * Session Lifecycle Hook — SessionStart / SessionEnd handler
 *
 * SessionStart: Exports session metadata to env file for worker coordination.
 * SessionEnd:   Cancels only workers owned by the ending Claude session.
 *
 * Invoked by Claude Code hooks system via hooks.json.
 *
 * Environment:
 *   CLAUDE_ENV_FILE     — SessionStart environment export file (set by Claude Code)
 *   CLAUDE_SESSION_ID   — Compatibility fallback for manual/older integrations
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

  if (!SESSION_ID) {
    log("Warning: SessionEnd has no session identity; skipping worker cleanup");
    return;
  }

  let cancellationRequests = 0;

  try {
    const files = readdirSync(TMP_DIR);

    // Cancel only workers that prove ownership by this Claude session.
    const pidFiles = files.filter(f => f.endsWith("_pid"));
    for (const pidFile of pidFiles) {
      const pidPath = resolve(TMP_DIR, pidFile);
      const pidData = readJson(pidPath);
      if (!pidData || pidData.ownerSessionId !== SESSION_ID) continue;

      const reviewSession = pidFile.slice(0, -"_pid".length);
      const cancelPath = resolve(TMP_DIR, `${reviewSession}_cancel`);
      const pid = pidData.pid;
      try {
        writeFileSync(cancelPath, new Date().toISOString(), "utf8");
      } catch (err) {
        log(`Warning: Could not request cancellation for ${reviewSession}: ${err.message}`);
        continue;
      }

      cancellationRequests++;
      if (pid && isAlive(pid)) {
        if (process.platform === "win32") {
          // On Windows, external SIGTERM terminates Node immediately instead
          // of reliably running its handler. Let the worker poll the marker so
          // it can interrupt upstream and persist partial output first.
          log(`Requested marker-based cancellation for worker PID ${pid} (${pidFile})`);
        } else {
          try {
            process.kill(pid, "SIGTERM");
            log(`Requested cancellation for worker PID ${pid} (${pidFile})`);
          } catch (err) {
            log(`Warning: Could not signal PID ${pid}: ${err.message}`);
          }
        }
      }
    }

    // The broker is user-wide and owns its idle shutdown. SessionEnd must not
    // mutate it or delete review control files that workers still need.
    const envFile = resolve(TMP_DIR, `session_${safeSessionId(SESSION_ID)}.env`);
    removeFile(envFile);

    log(`Session ended: requested cancellation for ${cancellationRequests} owned worker(s)`);
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
