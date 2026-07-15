# Worker Side-Effect Error Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent transient progress-file and broker-readline failures from terminating long-running review workers.

**Architecture:** Keep progress persistence synchronous, add bounded retry around atomic rename, and make `saveProgress` best-effort with diagnostic logging. Route broker `readline.Interface` errors through the existing deduplicated disconnect/reconnect path and ignore events from stale socket/interface instances.

**Tech Stack:** Node.js 22 ESM runtime, Node built-in test runner, fake Codex app-server and broker integration harness.

## Global Constraints

- Do not change the progress JSON schema, broker protocol, turn timeout policy, or output/state persistence behavior.
- Retry only `EPERM`, `EACCES`, and `EBUSY` rename failures with bounded synchronous delays.
- A failed progress update must be logged and must not terminate the worker.
- Socket and readline errors for one disconnect must start no more than one reconnect loop.
- Do not add runtime dependencies.

---

### Task 1: Fault-injection integration coverage

**Files:**
- Create: `plugins/codex-core/test/fault-inject.cjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: `NODE_OPTIONS=--require=<fault-inject.cjs>` inherited by detached workers.
- Produces: `CODEX_TEST_PROGRESS_RENAME_FAILURES=<count>` and `CODEX_TEST_READLINE_ERROR_SIGNAL=<path>` test controls.

- [ ] **Step 1: Add the preload fault injector**

Create a CommonJS preload that replaces `fs.renameSync` only in `--worker` processes, throws an `EPERM` with the normal `path` and `dest` fields for the requested number of progress renames, wraps `readline.createInterface`, and emits one `ECONNRESET` error when the configured signal file appears. Call `syncBuiltinESMExports()` after patching the built-ins so ESM named imports observe the replacements.

- [ ] **Step 2: Extend the CLI test helper**

Add `FAULT_INJECTOR`, append `--require=<path>` to `NODE_OPTIONS` only when a fault option is supplied, and map `progressRenameFailures` and `readlineErrorSignal` options into the two environment variables.

- [ ] **Step 3: Add the progress failure regression test**

Start a background direct-mode review with four injected progress rename failures. Poll to terminal state and assert `status === "completed"`, valid output exists, the worker log contains `Progress update skipped`, and no `*_progress.json.tmp.*` file remains for the session.

- [ ] **Step 4: Run the progress test and verify RED**

Run:

```powershell
node --test --test-name-pattern="progress rename failures" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because the current uncaught `EPERM` terminates the worker.

- [ ] **Step 5: Add the readline failure regression test**

Start a long broker-mode review with a unique signal path. Wait until the turn ID is published, create the signal file, then assert the review completes, `reconnectCount >= 1`, output is preserved, and the worker log does not contain `Unhandled 'error' event`.

- [ ] **Step 6: Run the readline test and verify RED**

Run:

```powershell
node --test --test-name-pattern="readline ECONNRESET" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because the current `readline.Interface` has no error listener.

- [ ] **Step 7: Commit the RED tests**

```powershell
git add plugins/codex-core/test/fault-inject.cjs plugins/codex-core/test/codex-review.test.mjs
git commit -m "test(core): reproduce worker side-effect crashes"
```

### Task 2: Best-effort progress persistence

**Files:**
- Modify: `plugins/codex-core/bin/codex-review.mjs:1004`
- Test: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: `writeJsonAtomic(path, data)` and the existing `log(message)` diagnostic sink.
- Produces: `saveProgress(dir, sid, data): boolean`, returning `false` instead of throwing when persistence fails.

- [ ] **Step 1: Add bounded rename retry**

Define `PROGRESS_RENAME_RETRY_DELAYS_MS = [10, 25, 50]`, `RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])`, and a synchronous `sleepSync(ms)` using `Atomics.wait`. Write the temporary file once, retry `renameSync` after each configured delay only for retryable codes, and remove the temporary file before rethrowing the final error.

- [ ] **Step 2: Isolate progress failures**

Wrap `writeJsonAtomic` inside `saveProgress`. Return `true` on success; on error call `log("Progress update skipped: ...")` and return `false` without throwing.

- [ ] **Step 3: Run the progress regression test and verify GREEN**

Run the Task 1 Step 4 command. Expected: PASS.

- [ ] **Step 4: Commit progress isolation**

```powershell
git add plugins/codex-core/bin/codex-review.mjs
git commit -m "fix(core): isolate transient progress write failures"
```

### Task 3: Broker readline error isolation

**Files:**
- Modify: `plugins/codex-core/bin/codex-review.mjs:495`
- Test: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: `BrokerClient._handleDisconnect(error)` and `disconnectNotified` reconnect deduplication.
- Produces: guarded socket and readline handlers tied to the connection instance that created them.

- [ ] **Step 1: Guard the socket instance**

Capture the newly created socket in a local `socket` constant, assign it to `this.socket`, and make connect, error, and close callbacks ignore events when `this.socket !== socket`.

- [ ] **Step 2: Handle readline errors**

Capture the interface in a local `rl` constant, assign it to `this.rl`, attach the line handler, and attach `rl.on("error", error => { if (this.rl === rl) this._handleDisconnect(error); })` before resolving the connection.

- [ ] **Step 3: Run the readline regression test and verify GREEN**

Run the Task 1 Step 6 command. Expected: PASS with one or more successful reconnects.

- [ ] **Step 4: Run both focused tests**

```powershell
node --test --test-name-pattern="progress rename failures|readline ECONNRESET" plugins/codex-core/test/codex-review.test.mjs
```

Expected: 2 matching tests pass and all non-matching tests are skipped.

- [ ] **Step 5: Commit broker isolation**

```powershell
git add plugins/codex-core/bin/codex-review.mjs
git commit -m "fix(core): reconnect after broker readline errors"
```

### Task 4: Full verification and runtime rollout

**Files:**
- Verify: `plugins/codex-core/bin/codex-review.mjs`
- Copy after verification: `C:\Users\QESG\.claude\bin\codex-review.mjs`
- Copy after verification: active `C:\Users\QESG\.claude\plugins\cache\sanghyun-io\codex-core\*\bin\codex-review.mjs`

**Interfaces:**
- Consumes: repository test suite and verified source artifact.
- Produces: identical SHA-256 hashes for repository and active runtime copies.

- [ ] **Step 1: Run syntax validation**

```powershell
node --check plugins/codex-core/bin/codex-review.mjs
```

- [ ] **Step 2: Run the complete integration suite twice**

```powershell
node --test plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/test/codex-review.test.mjs
```

Expected: both runs exit 0 with zero failures.

- [ ] **Step 3: Check the patch**

```powershell
git diff --check HEAD~2..HEAD
git status --short
```

- [ ] **Step 4: Copy the verified runtime**

Use `Copy-Item -Force` to replace `~/.claude/bin/codex-review.mjs` and the active installed codex-core cache binary after all tests pass. Do not alter older inactive cache versions.

- [ ] **Step 5: Verify deployed hashes**

Run `Get-FileHash -Algorithm SHA256` for the repository source and both active copies and require identical hashes.
