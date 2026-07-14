# Session-Scoped Claude Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one Claude Code session from terminating reviews owned by other sessions, while applying the verified fix to the current local plugin installation.

**Architecture:** Claude Code's stdin hook payload becomes the source of the owner session ID. `SessionStart` propagates that identity through `CLAUDE_ENV_FILE`, the wrapper stores it in PID metadata, and `SessionEnd` writes cancellation markers and signals only matching workers. The shared broker remains under its existing idle-timeout lifecycle.

**Tech Stack:** Node.js ESM and built-ins, Node test runner, Claude Code command hooks, JSON control files, PowerShell/Git Bash installation tooling.

## Global Constraints

- Do not change review prompts, model selection, verdict semantics, or review session IDs.
- Keep `~/.claude/tmp` as the shared review directory.
- Add no runtime dependency or new daemon.
- Never terminate an unowned legacy worker from a session-level hook.
- Never terminate or remove the user-wide broker from `SessionEnd`.
- Preserve partial output and terminal progress through the existing cancellation-marker protocol.
- Do not interrupt currently running reviews while installing the verified files.

---

## File Structure

- Create `plugins/codex-core/test/session-lifecycle.test.mjs`: isolated integration coverage for Claude hook input, ownership propagation, scoped cancellation, legacy safety, and broker survival.
- Modify `plugins/codex-core/scripts/session-lifecycle.mjs`: parse hook JSON, export owner identity, and perform fail-closed owner-scoped cancellation.
- Modify `plugins/codex-core/test/codex-review.test.mjs`: prove background PID records retain the owner session ID.
- Modify `plugins/codex-core/bin/codex-review.mjs`: add optional `ownerSessionId` to PID metadata.
- Modify `README.md` and `README.ko.md`: describe session-scoped cleanup and shared broker lifetime accurately.

### Task 1: Hook identity propagation

**Files:**
- Create: `plugins/codex-core/test/session-lifecycle.test.mjs`
- Modify: `plugins/codex-core/scripts/session-lifecycle.mjs`

**Interfaces:**
- Consumes: Claude hook JSON `{ session_id, hook_event_name, ... }` on stdin and optional `CLAUDE_SESSION_ID` compatibility environment value.
- Produces: `CODEX_REVIEW_OWNER_SESSION` export in `CLAUDE_ENV_FILE` and `session_<safe-id>.env` diagnostic marker.

- [ ] **Step 1: Write the failing SessionStart test**

Create a Node test that runs the real lifecycle script with an isolated home:

```js
it("reads session_id from hook stdin and exports review ownership", () => {
  const home = makeHome();
  const envFile = resolve(home, "claude-env.sh");
  runHook("start", {
    home,
    envFile,
    input: { session_id: "claude-A", hook_event_name: "SessionStart" },
  });

  assert.match(readFileSync(envFile, "utf8"),
    /export CODEX_REVIEW_OWNER_SESSION='claude-A'/);
  assert.ok(existsSync(resolve(home, ".claude", "tmp", "session_claude-A.env")));
  assert.ok(!existsSync(resolve(home, ".claude", "tmp", "session_.env")));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern="reads session_id" plugins/codex-core/test/session-lifecycle.test.mjs
```

Expected: FAIL because the current script ignores stdin and does not write `CLAUDE_ENV_FILE`.

- [ ] **Step 3: Implement hook parsing and safe environment export**

Add synchronous hook-input helpers before dispatch:

```js
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
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

const hookInput = readHookInput();
const SESSION_ID = hookInput.session_id || process.env.CLAUDE_SESSION_ID || "";
```

Make `onSessionStart` create `TMP_DIR`, write the marker using a filename-safe form of `SESSION_ID`, and append:

```js
appendFileSync(
  process.env.CLAUDE_ENV_FILE,
  `export CODEX_REVIEW_OWNER_SESSION=${shellQuote(SESSION_ID)}\n`,
  "utf8",
);
```

Skip the export with a warning when either the session ID or `CLAUDE_ENV_FILE` is absent.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: one passing test and zero failures.

- [ ] **Step 5: Commit the identity propagation slice**

```powershell
git add plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/scripts/session-lifecycle.mjs
git commit -m "fix(core): propagate Claude review ownership"
```

### Task 2: Session-scoped cancellation and broker survival

**Files:**
- Modify: `plugins/codex-core/test/session-lifecycle.test.mjs`
- Modify: `plugins/codex-core/scripts/session-lifecycle.mjs`

**Interfaces:**
- Consumes: PID JSON `{ pid, nonce, ownerSessionId? }` and the ending hook's parsed `session_id`.
- Produces: `<review-session>_cancel` only for matching owners; no broker mutation and no cross-session artifact deletion.

- [ ] **Step 1: Write failing cleanup isolation tests**

Use real short-lived Node sleeper processes in isolated temp homes and clean them in `finally` blocks. Add these tests:

```js
it("ends only workers owned by the ending Claude session", async () => {
  const owned = spawnSleeper();
  const foreign = spawnSleeper();
  writePid(home, "rr_owned", owned.pid, "claude-A");
  writePid(home, "rr_foreign", foreign.pid, "claude-B");

  runHook("end", { home, input: { session_id: "claude-A" } });

  await waitForExit(owned.pid);
  assert.equal(isAlive(owned.pid), false);
  assert.equal(isAlive(foreign.pid), true);
  assert.ok(existsSync(tmp(home, "rr_owned_cancel")));
  assert.ok(existsSync(tmp(home, "rr_foreign_pid")));
});

it("preserves the shared broker and unowned legacy workers", () => {
  const broker = spawnSleeper();
  const legacy = spawnSleeper();
  writeBrokerPort(home, broker.pid);
  writePid(home, "rr_legacy", legacy.pid, null);

  runHook("end", { home, input: { session_id: "claude-A" } });

  assert.equal(isAlive(broker.pid), true);
  assert.equal(isAlive(legacy.pid), true);
  assert.ok(existsSync(tmp(home, "broker.port")));
});

it("does no destructive cleanup without a session identity", () => {
  const worker = spawnSleeper();
  writePid(home, "rr_unknown", worker.pid, "claude-A");

  runHook("end", { home, input: {} });

  assert.equal(isAlive(worker.pid), true);
  assert.ok(existsSync(tmp(home, "rr_unknown_pid")));
});
```

- [ ] **Step 2: Run cleanup tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="ends only|preserves the shared broker|without a session identity" plugins/codex-core/test/session-lifecycle.test.mjs
```

Expected: FAIL because the current hook globally kills PID records, kills the broker, and removes control files.

- [ ] **Step 3: Replace global cleanup with owner-scoped cancellation**

Implement the end path around exact metadata matches:

```js
if (!SESSION_ID) {
  log("Warning: SessionEnd has no session identity; skipping worker cleanup");
  return;
}

const pidFiles = readdirSync(TMP_DIR).filter(file => file.endsWith("_pid"));
for (const pidFile of pidFiles) {
  const pidData = readJson(resolve(TMP_DIR, pidFile));
  if (!pidData || pidData.ownerSessionId !== SESSION_ID) continue;

  const sessionName = pidFile.slice(0, -"_pid".length);
  writeFileSync(resolve(TMP_DIR, `${sessionName}_cancel`), new Date().toISOString(), "utf8");
  if (pidData.pid && isAlive(pidData.pid)) process.kill(pidData.pid, "SIGTERM");
}
```

Remove broker termination, broker port deletion, suffix-wide progress/state/log deletion, and immediate matching PID deletion. Remove only the ending session's diagnostic marker.

- [ ] **Step 4: Run the lifecycle test file and verify GREEN**

```powershell
node --test plugins/codex-core/test/session-lifecycle.test.mjs
```

Expected: all lifecycle tests pass with zero leaked sleeper processes.

- [ ] **Step 5: Commit scoped lifecycle cleanup**

```powershell
git add plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/scripts/session-lifecycle.mjs
git commit -m "fix(core): scope SessionEnd cleanup to its owner"
```

### Task 3: Persist ownership in worker PID metadata

**Files:**
- Modify: `plugins/codex-core/test/codex-review.test.mjs`
- Modify: `plugins/codex-core/bin/codex-review.mjs`

**Interfaces:**
- Consumes: optional `CODEX_REVIEW_OWNER_SESSION` inherited by the background wrapper.
- Produces: PID JSON `{ pid, nonce, ownerSessionId? }`; existing callers continue receiving `pid` and `nonce`.

- [ ] **Step 1: Write the failing wrapper metadata test**

Extend the test CLI environment with:

```js
CODEX_REVIEW_OWNER_SESSION: opts.ownerSession ?? "",
```

Add a background test that starts a delayed direct-mode worker, reads the PID file, and cancels it in `finally`:

```js
it("stores the owning Claude session in background PID metadata", () => {
  const r = cli(
    ["start", prompt, output, "--session", sid, "--review-dir", TEST_DIR],
    { ownerSession: "claude-A", turnDelay: 10_000 },
  );
  assert.equal(r.exit, 0);
  assert.equal(readJson(resolve(TEST_DIR, `${sid}_pid`)).ownerSessionId, "claude-A");
});
```

- [ ] **Step 2: Run the metadata test and verify RED**

```powershell
node --test --test-name-pattern="owning Claude session" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because PID JSON currently contains only `pid` and `nonce`.

- [ ] **Step 3: Extend PID read/write helpers and worker spawn**

Use optional metadata without breaking legacy formats:

```js
function readPidFile(dir, sid) {
  const data = readJson(fp.pid(dir, sid));
  if (!data) return null;
  if (typeof data === "number") return { pid: data, nonce: null, ownerSessionId: null };
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
```

In `spawnWorker`, pass `process.env.CODEX_REVIEW_OWNER_SESSION || null` to `writePidFile`.

- [ ] **Step 4: Run focused wrapper and lifecycle tests**

```powershell
node --test --test-name-pattern="owning Claude session" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/session-lifecycle.test.mjs
```

Expected: both commands pass.

- [ ] **Step 5: Commit worker ownership metadata**

```powershell
git add plugins/codex-core/test/codex-review.test.mjs plugins/codex-core/bin/codex-review.mjs
git commit -m "fix(core): record review worker ownership"
```

### Task 4: Documentation, full verification, and local installation

**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Runtime copies: `~/.claude/bin/{codex-review.mjs,session-lifecycle.mjs}` and the active `codex-core` plugin cache equivalents.

**Interfaces:**
- Consumes: verified repository runtime files and the installed plugin registry/cache location.
- Produces: accurate lifecycle documentation and byte-identical active local runtime copies.

- [ ] **Step 1: Update user-visible lifecycle documentation**

Change the hook table wording in both READMEs from global worker/broker cleanup to:

```text
Cancels only workers owned by the ending Claude session; the shared broker exits on idle timeout
```

and the equivalent Korean wording.

- [ ] **Step 2: Run repository verification**

```powershell
node --test plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/test/codex-review.test.mjs
git diff --check
```

Expected: all tests pass, zero failures, and `git diff --check` produces no output.

- [ ] **Step 3: Commit documentation**

```powershell
git add README.md README.ko.md
git commit -m "docs: explain session-scoped review cleanup"
```

- [ ] **Step 4: Discover the active plugin cache without disturbing processes**

Read the installed plugin registry and locate the active `codex-core` cache directory. Record the currently active review worker and broker PIDs before installation; do not signal them:

```powershell
$registry = Get-Content -Raw "$HOME\.claude\plugins\installed_plugins.json" | ConvertFrom-Json
$activeRoot = @($registry.plugins.'codex-core@sanghyun-io')[-1].installPath
if (-not (Test-Path "$activeRoot\scripts\session-lifecycle.mjs")) {
  throw "Active codex-core cache is missing lifecycle script: $activeRoot"
}
$beforePids = @(
  Get-ChildItem "$HOME\.claude\tmp" -Filter '*_pid' -File -ErrorAction SilentlyContinue |
    ForEach-Object { (Get-Content -Raw $_.FullName | ConvertFrom-Json).pid }
)
$brokerPort = "$HOME\.claude\tmp\broker.port"
if (Test-Path $brokerPort) {
  $beforePids += (Get-Content -Raw $brokerPort | ConvertFrom-Json).pid
}
$beforePids = $beforePids | Where-Object { $_ } | Sort-Object -Unique
$beforePids
```

- [ ] **Step 5: Apply verified runtime files**

Run the installer from the verified worktree with `CLAUDE_PLUGIN_ROOT` set to `plugins/codex-core`. Then copy the same verified `session-lifecycle.mjs` and `codex-review.mjs` into the active `codex-core` cache so already registered hook command paths execute the fixed script:

```powershell
$coreRoot = (Resolve-Path 'plugins/codex-core').Path
$env:CLAUDE_PLUGIN_ROOT = $coreRoot
bash "$coreRoot/scripts/install.sh"
if ($LASTEXITCODE -ne 0) { throw "codex-core installer failed: $LASTEXITCODE" }

Copy-Item -Force "$coreRoot\scripts\session-lifecycle.mjs" "$activeRoot\scripts\session-lifecycle.mjs"
Copy-Item -Force "$coreRoot\bin\codex-review.mjs" "$activeRoot\bin\codex-review.mjs"
```

- [ ] **Step 6: Verify installation identity and process continuity**

Compare SHA-256 hashes for repository, `~/.claude/bin`, and active cache copies. Confirm every pre-install active worker and broker PID is still alive unless its progress is already terminal, and confirm installation did not create cancellation markers:

```powershell
$hashGroups = @(
  @(
    "$coreRoot\scripts\session-lifecycle.mjs",
    "$HOME\.claude\bin\session-lifecycle.mjs",
    "$activeRoot\scripts\session-lifecycle.mjs"
  ),
  @(
    "$coreRoot\bin\codex-review.mjs",
    "$HOME\.claude\bin\codex-review.mjs",
    "$activeRoot\bin\codex-review.mjs"
  )
)
foreach ($group in $hashGroups) {
  $hashes = $group | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash } | Sort-Object -Unique
  if ($hashes.Count -ne 1) { throw "Installed runtime hash mismatch: $($group -join ', ')" }
}

$afterCancelFiles = @(Get-ChildItem "$HOME\.claude\tmp" -Filter '*_cancel' -File -ErrorAction SilentlyContinue)
$beforePids | ForEach-Object {
  $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
  if ($process) { "PID $_ remains alive ($($process.ProcessName))" }
}
```

- [ ] **Step 7: Run a local isolated smoke test against the installed scripts**

Make the lifecycle test accept `LIFECYCLE_SCRIPT` as an override, then run the complete suite against the installed copy. Its helpers create isolated homes, so no `SessionEnd` call targets the real user home:

```powershell
$env:LIFECYCLE_SCRIPT = "$HOME\.claude\bin\session-lifecycle.mjs"
node --test plugins/codex-core/test/session-lifecycle.test.mjs
Remove-Item Env:LIFECYCLE_SCRIPT
```

Expected: all lifecycle tests pass against the installed script.
