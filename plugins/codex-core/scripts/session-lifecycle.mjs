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
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const TMP_DIR = resolve(HOME, ".claude", "tmp");
const HOOK_EVENT = process.argv[2] || ""; // "start" or "end"
const DEFAULT_SESSION_END_GRACE_MS = 7_000;
const MAX_SESSION_END_GRACE_MS = 7_000;
const graceValue = process.env.CODEX_REVIEW_SESSION_END_GRACE_MS;
const configuredGraceMs = graceValue?.trim() ? Number(graceValue) : Number.NaN;
const SESSION_END_GRACE_MS = Number.isFinite(configuredGraceMs) && configuredGraceMs >= 0
  ? Math.min(configuredGraceMs, MAX_SESSION_END_GRACE_MS)
  : DEFAULT_SESSION_END_GRACE_MS;

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
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readProcessCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  }
}

function readWindowsProcessCommandLines(pids) {
  const validPids = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
  if (validPids.length === 0) return new Map();

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$ids = @(${validPids.join(",")})`,
    "$items = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | Select-Object ProcessId, CommandLine)",
    "[Console]::Out.Write(($items | ConvertTo-Json -Compress))",
  ].join("; ");

  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      const raw = execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
          windowsHide: true,
        },
      ).trim();
      if (!raw) return new Map();
      const items = JSON.parse(raw);
      return new Map(
        (Array.isArray(items) ? items : [items])
          .map(item => [Number(item.ProcessId), item.CommandLine || ""]),
      );
    } catch {
      // Try the other PowerShell host before refusing identity verification.
    }
  }
  return new Map();
}

function isVerifiedWorker(pid, nonce) {
  if (!isAlive(pid) || typeof nonce !== "string" || nonce.length === 0) return false;
  const commandLine = readProcessCommandLine(pid);
  return typeof commandLine === "string" && commandLine.includes(nonce);
}

async function waitForWorkersToExit(workers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (workers.every(({ pid }) => !isAlive(pid))) return;
    await new Promise(resolveP => setTimeout(resolveP, 100));
  }
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

async function onSessionEnd() {
  if (!existsSync(TMP_DIR)) {
    log("No tmp directory found, nothing to clean up");
    return;
  }

  if (!SESSION_ID) {
    log("Warning: SessionEnd has no session identity; skipping worker cleanup");
    return;
  }

  let cancellationRequests = 0;
  const cancellationWorkers = [];

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
        if (typeof pidData.nonce !== "string" || pidData.nonce.length === 0) {
          log(`Warning: Refusing to signal worker PID ${pid} without a nonce (${pidFile})`);
          continue;
        }
        if (process.platform === "win32") {
          // On Windows, external SIGTERM terminates Node immediately instead
          // of reliably running its handler. Let the worker poll the marker so
          // it can interrupt upstream and persist partial output first. Strict
          // identity verification is deferred until force-kill is necessary.
          cancellationWorkers.push({ pid, nonce: pidData.nonce, pidFile });
          log(`Requested marker-based cancellation for worker PID ${pid} (${pidFile})`);
        } else {
          if (!isVerifiedWorker(pid, pidData.nonce)) {
            log(`Warning: Refusing to signal unverifiable worker PID ${pid} (${pidFile})`);
            continue;
          }
          cancellationWorkers.push({ pid, nonce: pidData.nonce, pidFile });
          try {
            process.kill(pid, "SIGTERM");
            log(`Requested cancellation for worker PID ${pid} (${pidFile})`);
          } catch (err) {
            log(`Warning: Could not signal PID ${pid}: ${err.message}`);
          }
        }
      }
    }

    if (cancellationWorkers.length > 0) {
      await waitForWorkersToExit(cancellationWorkers, SESSION_END_GRACE_MS);
    }

    const liveWorkers = cancellationWorkers.filter(worker => isAlive(worker.pid));
    const windowsCommandLines = process.platform === "win32"
      ? readWindowsProcessCommandLines(liveWorkers.map(worker => worker.pid))
      : null;

    for (const worker of liveWorkers) {
      // Re-verify after the grace period. The original worker may have exited
      // and its PID may already belong to an unrelated process.
      const identityMatches = process.platform === "win32"
        ? typeof worker.nonce === "string"
          && worker.nonce.length > 0
          && windowsCommandLines.get(worker.pid)?.includes(worker.nonce)
        : isVerifiedWorker(worker.pid, worker.nonce);
      if (!identityMatches) {
        log(`Warning: Refusing to force-kill unverifiable worker PID ${worker.pid} (${worker.pidFile})`);
        continue;
      }
      try {
        process.kill(worker.pid, "SIGKILL");
        log(`Force killed unresponsive worker PID ${worker.pid} (${worker.pidFile})`);
      } catch (err) {
        log(`Warning: Could not force-kill PID ${worker.pid}: ${err.message}`);
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
  await onSessionEnd();
} else {
  // Auto-detect from hook type name
  const hookType = process.env.CLAUDE_HOOK_TYPE || "";
  if (hookType === "SessionStart" || hookType.toLowerCase().includes("start")) {
    onSessionStart();
  } else {
    await onSessionEnd();
  }
}
