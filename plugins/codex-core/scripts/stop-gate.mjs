#!/usr/bin/env node

/**
 * Stop Gate Hook — Quality gate before session termination
 *
 * When enabled (stopReviewGate: true in state), this hook runs before
 * Claude Code stops. It checks for:
 *   1. Active/incomplete review sessions (workers still running)
 *   2. Uncommitted changes that haven't been reviewed
 *
 * Output:
 *   First line MUST be "ALLOW: <reason>" or "BLOCK: <reason>"
 *   - ALLOW: session can terminate normally
 *   - BLOCK: session termination is blocked (user must address the issue)
 *
 * Environment:
 *   HOME — User home directory
 *
 * Configuration:
 *   State file: ~/.claude/tmp/codex_review_config.json
 *   { "stopReviewGate": true/false }
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const TMP_DIR = resolve(HOME, ".claude", "tmp");
const CONFIG_PATH = resolve(TMP_DIR, "codex_review_config.json");

function log(msg) {
  process.stderr.write(`[stop-gate] ${msg}\n`);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function allow(reason) {
  console.log(`ALLOW: ${reason}`);
  process.exit(0);
}

function block(reason) {
  console.log(`BLOCK: ${reason}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Check if gate is enabled
  const config = readJson(CONFIG_PATH);
  if (!config?.stopReviewGate) {
    allow("Stop review gate is disabled");
    return;
  }

  // Check 1: Any workers still running?
  if (existsSync(TMP_DIR)) {
    try {
      const files = readdirSync(TMP_DIR);
      const pidFiles = files.filter(f => f.endsWith("_pid"));
      const runningWorkers = [];

      for (const pidFile of pidFiles) {
        const pidPath = resolve(TMP_DIR, pidFile);
        const pidData = readJson(pidPath);
        if (pidData?.pid && isAlive(pidData.pid)) {
          // Check progress to see what session it belongs to
          const sessionId = pidFile.replace("_pid", "");
          const progressPath = resolve(TMP_DIR, `${sessionId}_progress.json`);
          const progress = readJson(progressPath);
          runningWorkers.push({
            session: sessionId,
            pid: pidData.pid,
            status: progress?.status || "unknown",
            elapsed: progress?.elapsedMs || 0,
          });
        }
      }

      if (runningWorkers.length > 0) {
        const summary = runningWorkers
          .map(w => `${w.session} (PID ${w.pid}, ${w.status}, ${Math.round(w.elapsed / 1000)}s)`)
          .join("; ");
        block(`${runningWorkers.length} review worker(s) still running: ${summary}`);
        return;
      }
    } catch (err) {
      log(`Warning: Could not check workers: ${err.message}`);
    }
  }

  // Check 2: Any incomplete review sessions (progress = running/initializing)?
  if (existsSync(TMP_DIR)) {
    try {
      const files = readdirSync(TMP_DIR);
      const progressFiles = files.filter(f => f.endsWith("_progress.json"));
      const incomplete = [];

      for (const pFile of progressFiles) {
        const progress = readJson(resolve(TMP_DIR, pFile));
        if (progress && ["running", "initializing", "queued"].includes(progress.status)) {
          incomplete.push(pFile.replace("_progress.json", ""));
        }
      }

      if (incomplete.length > 0) {
        block(`${incomplete.length} review session(s) appear incomplete: ${incomplete.join(", ")}`);
        return;
      }
    } catch { /* ignore */ }
  }

  // Check 3: Uncommitted changes that may need review
  try {
    const status = execSync("git status --porcelain 2>/dev/null", {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (status) {
      const lineCount = status.split("\n").length;
      // Only block for large uncommitted changes
      if (lineCount >= 10) {
        block(`${lineCount} uncommitted file changes detected — consider reviewing before stopping`);
        return;
      }
    }
  } catch {
    // Not in a git repo — skip this check
  }

  allow("No active reviews or significant uncommitted changes");
}

main();
