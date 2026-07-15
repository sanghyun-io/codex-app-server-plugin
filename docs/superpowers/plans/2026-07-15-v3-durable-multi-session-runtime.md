# V3 Durable Multi-Session Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared broker execution path with a durable supervisor and isolated per-job workers that support multiple Claude sessions, long-running turns, and automatic recovery.

**Architecture:** Keep `codex-review.mjs` as the compatible command surface, route new work through a local supervisor, and give every active job a dedicated worker plus Codex app-server. Persist immutable requests, append-only attempt events, partial output, and immutable results so supervisor, worker, and transport failures can be recovered without cross-job impact.

**Tech Stack:** Node.js 18+ ESM, Node built-in test runner, built-in filesystem/net/child-process/crypto modules, fake Codex app-server integration harness, Bash installer.

## Global Constraints

- Default to automatic recovery with at most three replacement attempts and delays of 1, 3, and 10 seconds.
- Run three jobs concurrently by default and serialize jobs that share one Codex thread.
- Keep `start`, `follow-up`, `status`, `cancel`, and `close` arguments, JSON status fields, and exit-code meanings compatible.
- Let jobs survive Claude `SessionEnd`; only explicit cancellation stops a job.
- Use one dedicated Codex app-server per active job and no shared broker for v3 jobs.
- Keep Node.js 18 compatibility and add no runtime dependency.
- Support Windows named pipes and Unix domain sockets.
- Write streaming checkpoints no more often than once every three seconds.
- Never transition a terminal job back to an active state.

---

### Task 1: Durable job model and journal reducer

**Files:**
- Create: `plugins/codex-core/bin/lib/job-store.mjs`
- Create: `plugins/codex-core/bin/lib/job-state.mjs`
- Create: `plugins/codex-core/test/job-store.test.mjs`

**Interfaces:**
- Produces: `createJob(runtimeDir, request): JobRecord`, `appendEvent(path, event): void`, `readEvents(path): Event[]`, `publishResult(jobDir, attemptOutput): string`, `recoverJobs(runtimeDir): JobRecord[]`.
- Produces: `reduceJob(request, supervisorEvents, attemptEvents, resultExists): JobState` and `canTransition(from, to): boolean`.

- [ ] **Step 1: Write RED reducer tests**

Test immutable terminal states, generation filtering, `queued -> starting -> running -> recovering -> running -> completed`, cancellation before dispatch, `result.txt` as completion evidence, and an incomplete final JSONL line being ignored.

- [ ] **Step 2: Verify reducer tests fail**

Run `node --test plugins/codex-core/test/job-store.test.mjs`. Expect module-not-found failure before the production modules exist.

- [ ] **Step 3: Implement minimal reducer and append-only reader**

Define frozen terminal statuses, explicit transition sets, monotonic event sequence validation, generation selection, JSONL append with `openSync(..., "a")` plus `fsyncSync`, and final-line-only corruption tolerance.

- [ ] **Step 4: Verify reducer tests pass**

Run the Task 1 test command and require zero failures.

- [ ] **Step 5: Write RED persistence tests**

Test durable acknowledgement ordering, immutable `request.json` with `schemaVersion: 3`, unique job IDs, attempt directories, append-only `output.part`, missing terminal event recovery from `result.txt`, and bounded retry when publishing a result is temporarily locked.

- [ ] **Step 6: Implement job persistence**

Use exclusive request creation, one writer per event journal, append-only partial output, flush-before-publish result ordering, and bounded Windows `EPERM`/`EACCES`/`EBUSY` retries.

- [ ] **Step 7: Run tests and commit**

Run `node --test plugins/codex-core/test/job-store.test.mjs`, then commit `test/core: add durable v3 job store` and implementation together as `feat(core): add durable v3 job store` in separate RED/GREEN commits.

### Task 2: Authenticated local IPC and supervisor bootstrap

**Files:**
- Create: `plugins/codex-core/bin/lib/runtime-ipc.mjs`
- Create: `plugins/codex-core/bin/supervisor.mjs`
- Create: `plugins/codex-core/test/runtime-ipc.test.mjs`

**Interfaces:**
- Produces: `runtimePaths(home)`, `createRuntimeServer(options)`, `connectRuntime(options)`, `requestRuntime(action, params, options)`, and `ensureSupervisor(options)`.
- Consumes: the durable job store from Task 1.

- [ ] **Step 1: Write RED IPC tests**

Test platform endpoint formatting, token rejection, request/response correlation, malformed frames, `ECONNRESET`, idempotent cleanup, stale endpoint replacement, and two simultaneous callers starting exactly one supervisor.

- [ ] **Step 2: Verify RED**

Run `node --test plugins/codex-core/test/runtime-ipc.test.mjs`; expect missing exports.

- [ ] **Step 3: Implement IPC primitives**

Use a Windows named pipe or Unix socket, newline-delimited JSON frames, a 256-bit token in `endpoint.json`, per-connection `error`/`close` listeners, bounded request timers, and a nonce-verified startup lock created with exclusive file creation.

- [ ] **Step 4: Implement supervisor startup and health endpoint**

Add `ping`, `shutdown-if-idle`, and durable endpoint publication. The supervisor must rebuild its in-memory registry before accepting job commands.

- [ ] **Step 5: Verify and commit**

Run Task 2 tests twice and commit RED tests, then GREEN implementation.

### Task 3: FIFO queue and per-thread scheduler

**Files:**
- Create: `plugins/codex-core/bin/lib/job-scheduler.mjs`
- Create: `plugins/codex-core/test/job-scheduler.test.mjs`
- Modify: `plugins/codex-core/bin/supervisor.mjs`

**Interfaces:**
- Produces: `JobScheduler({ concurrency, spawnJob })`, `enqueue(job)`, `complete(jobId, terminalState)`, `cancel(jobId)`, and `snapshot()`.
- Consumes: recovered job states and durable supervisor events.

- [ ] **Step 1: Write RED scheduler tests**

Cover FIFO overflow at concurrency three, unrelated session concurrency, one active job per `threadId`, cancelled queued jobs, immediate slot reuse, and recovered `running` jobs reserving slots.

- [ ] **Step 2: Verify RED**

Run `node --test plugins/codex-core/test/job-scheduler.test.mjs` and confirm expected missing implementation.

- [ ] **Step 3: Implement scheduler and supervisor actions**

Add `submit`, `status`, `list`, `cancel`, and worker registration actions. Persist queue/cancel events before replying. Read `CODEX_REVIEW_CONCURRENCY` as a positive integer with default three.

- [ ] **Step 4: Verify and commit**

Run scheduler and IPC tests, then commit RED and GREEN changes separately.

### Task 4: Isolated job worker and direct Codex transport

**Files:**
- Create: `plugins/codex-core/bin/job-worker.mjs`
- Create: `plugins/codex-core/bin/lib/app-server-client.mjs`
- Create: `plugins/codex-core/test/job-worker.test.mjs`
- Modify: `plugins/codex-core/test/fake-codex.mjs`

**Interfaces:**
- Produces: `AppServerClient` with `initialize`, `listModels`, `startThread`, `resumeThread`, `startTurn`, `interruptTurn`, and `close`.
- Produces: worker entry arguments `--runtime`, `--job`, `--generation`, and `--nonce`.
- Consumes: Task 1 job storage and Task 2 worker registration IPC.

- [ ] **Step 1: Write RED worker success tests**

Submit a start job through a dedicated fake app-server, assert thread/turn metadata, checkpoint throttling, immutable result publication, worker exit, and no shared broker process or port file.

- [ ] **Step 2: Verify RED**

Run `node --test plugins/codex-core/test/job-worker.test.mjs`; expect missing worker implementation.

- [ ] **Step 3: Extract guarded app-server client**

Move the direct JSON-RPC behavior behind a focused module. Every child stream and readline interface must consume errors, reject pending requests once, and use connection generation guards so stale notifications are ignored.

- [ ] **Step 4: Implement worker success path**

Validate the request, start a dedicated app-server, validate the requested model, start or resume the thread, append deltas to partial output, checkpoint every three seconds, publish the result, append a terminal event, and shut down the child.

- [ ] **Step 5: Verify and commit**

Run job-worker, job-store, and existing model-validation tests; commit RED then GREEN.

### Task 5: Automatic recovery and process isolation

**Files:**
- Modify: `plugins/codex-core/bin/job-worker.mjs`
- Modify: `plugins/codex-core/bin/supervisor.mjs`
- Create: `plugins/codex-core/test/v3-recovery.test.mjs`
- Modify: `plugins/codex-core/test/fault-inject.cjs`

**Interfaces:**
- Consumes: attempt generations, worker registration, scheduler slots, and durable cancellation.
- Produces: recoverable failure events, replacement attempts, worker re-registration, and terminal retry exhaustion.

- [ ] **Step 1: Write RED fault-injection tests**

Cover app-server exit, worker exit, supervisor exit while worker remains alive, IPC reset, completion during reconnect, stale generation events, cancel-plus-restart, and three exhausted replacement attempts.

- [ ] **Step 2: Verify each failure for the intended reason**

Run `node --test plugins/codex-core/test/v3-recovery.test.mjs` after adding each scenario and confirm it fails before its recovery behavior exists.

- [ ] **Step 3: Implement worker re-registration**

Keep the worker alive across supervisor IPC loss, retry registration against a replacement endpoint, and continue writing its own journal without blocking model output.

- [ ] **Step 4: Implement replacement attempts**

Classify transport and process failures as recoverable, persist `recovering`, schedule generations with 1/3/10-second backoff, replay only the current prompt, and ignore older-generation messages.

- [ ] **Step 5: Implement durable cancellation and bounded tree termination**

Persist cancellation before signalling. Verify worker nonce, interrupt the turn, wait a bounded grace period, then terminate the worker/app-server tree without affecting other jobs.

- [ ] **Step 6: Verify and commit**

Run recovery tests twice plus worker/scheduler tests and commit in focused RED/GREEN pairs.

### Task 6: Compatible CLI migration

**Files:**
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Create: `plugins/codex-core/test/v3-cli.test.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: supervisor IPC actions.
- Preserves: existing command arguments, status JSON fields, output paths, session state, and exit codes 0 through 8.

- [ ] **Step 1: Write RED CLI compatibility tests**

Exercise `start`, `follow-up`, `status`, `cancel`, `close`, `scope`, unsupported model handling, project mismatch, partial failure output, v2 completed-state readout, and `CODEX_REVIEW_NO_BROKER` acceptance.

- [ ] **Step 2: Verify RED against v3 expectations**

Run `node --test plugins/codex-core/test/v3-cli.test.mjs` and confirm new-runtime assertions fail.

- [ ] **Step 3: Convert CLI to supervisor client**

Retain parsing and public output behavior, replace v3 spawn/status/cancel internals with durable IPC, store thread metadata after completed jobs, and retain read-only fallback for v2 artifacts.

- [ ] **Step 4: Remove shared broker from the new-job path**

Leave `broker.mjs` only as an upgrade artifact for already-running v2 processes. Ensure no v3 test creates `broker.port`.

- [ ] **Step 5: Verify and commit**

Run v3 CLI tests and the full legacy codex-review suite, then commit RED and GREEN changes.

### Task 7: Lifecycle, installer, and operator documentation

**Files:**
- Modify: `plugins/codex-core/scripts/session-lifecycle.mjs`
- Modify: `plugins/codex-core/test/session-lifecycle.test.mjs`
- Modify: `plugins/codex-core/scripts/install.sh`
- Modify: `plugins/codex-core/hooks/hooks.json`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `plugins/codex-core/rules/review-protocol.md`
- Modify: `plugins/codex-core/rules/codex-session-ops.md`

**Interfaces:**
- Preserves: SessionStart metadata export.
- Changes: SessionEnd detaches ownership without cancelling durable jobs.
- Installs: supervisor, job worker, and all v3 library modules.

- [ ] **Step 1: Write RED lifecycle and installed-layout tests**

Assert SessionEnd leaves v3 jobs running, explicit cancel still terminates them, installer copies every v3 module, and setup diagnostics identify the v3 runtime.

- [ ] **Step 2: Verify RED**

Run the focused lifecycle and install-layout tests.

- [ ] **Step 3: Implement lifecycle and installer changes**

Remove SessionEnd worker cancellation for v3, update hook descriptions, install executable entry points plus libraries, and document concurrency/recovery/runtime environment variables.

- [ ] **Step 4: Verify and commit**

Run lifecycle, install, and CLI suites; commit tests then implementation/docs.

### Task 8: V3 release verification and deployment

**Files:**
- Modify: `plugins/codex-core/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Verify/copy: active `~/.claude/bin` and plugin cache.

**Interfaces:**
- Produces: version `3.0.0`, annotated tag `v3.0.0`, pushed `origin/main`, and a GitHub release.

- [ ] **Step 1: Run syntax checks**

Run `node --check` for every `.mjs` under `plugins/codex-core/bin` and `plugins/codex-core/scripts`.

- [ ] **Step 2: Run the complete suite twice**

Run all `plugins/codex-core/test/*.test.mjs` twice and require zero failures, warnings, leaked workers, app-servers, supervisor processes, or runtime temp files.

- [ ] **Step 3: Run installed-runtime fault injection**

Install into an isolated HOME, execute multi-session queue and supervisor/worker/app-server restart scenarios, then run the lifecycle suite against installed paths.

- [ ] **Step 4: Version and validate manifests**

Set core and marketplace versions to `3.0.0`, validate JSON, update README release details, and commit `chore(core): release v3.0.0`.

- [ ] **Step 5: Review and publish**

Run `git diff --check`, inspect all commits since `v2.5.2`, push the implementation branch or fast-forward `main` as appropriate, push annotated tag `v3.0.0`, create the GitHub release, install the released plugin, and verify source/installed SHA-256 hashes.
