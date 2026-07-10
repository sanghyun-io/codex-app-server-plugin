# Long-Running Review Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind every Codex review session to its originating project, multiplex concurrent turns safely, recover temporary broker disconnects, interrupt upstream work on cancellation, and report honest latency phases.

**Architecture:** Add a small project-scope module and a shared turn controller so direct and broker clients enforce the same identity and cancellation rules. Replace the broker's global turn mutex with turn-id snapshots and watcher routing, then let workers reattach after a heartbeat-detected disconnect. Keep current review prompts unchanged while recording prompt size and first-output latency for a later native-review experiment.

**Tech Stack:** Node.js ESM and built-ins, Node test runner, JSON-RPC over stdio, localhost TCP broker, Claude Code plugin manifests and Markdown workflow rules.

## Global Constraints

- Marketplace and `codex-core` release version become `2.5.0`; `codex-code-review` becomes `2.4.0`.
- Preserve model priority `--model` > `CODEX_REVIEW_MODEL` > workflow default > `gpt-5.6-terra`.
- Preserve workflow defaults: red-review Sol, code-review and regular delegate Terra, read-only delegate Luna.
- Never replay or silently retry a model turn after App Server process failure.
- Never truncate or rewrite a review prompt in this release.
- Bind sessions to canonical Git roots; non-Git work uses the canonical requested cwd.
- Follow-up from a different root or legacy state without `projectRoot` exits 6 before App Server thread operations.
- User cancel remains exit 8; hard timeout remains exit 5; partial output is preserved.
- Keep the implementation dependency-free and portable across Windows and the existing POSIX test path.

---

## File structure

- Create `plugins/codex-core/bin/lib/project-scope.mjs`: canonical cwd/root resolution and equality.
- Create `plugins/codex-core/bin/lib/turn-controller.mjs`: one identity-filtered streaming, interrupt, timeout, and reconnect state machine shared by direct and broker clients.
- Modify `plugins/codex-core/bin/codex-review.mjs`: CLI/state integration, progress metrics, client adapters, and detached-worker forwarding.
- Modify `plugins/codex-core/bin/broker.mjs`: multiplexed turn snapshots, watchers, heartbeat, attach, and App Server exit handling.
- Modify `plugins/codex-core/test/fake-codex.mjs`: current App Server turn response/notification identity and interrupt simulation.
- Modify `plugins/codex-core/test/codex-review.test.mjs`: project binding, concurrency, reconnection, cancellation, and metrics integration coverage.
- Modify runtime rules/skills and README files only where progress phases, project isolation, or recovery behavior is user-visible.
- Modify plugin and marketplace manifests for the release versions.

---

### Task 1: Upgrade the fake protocol and prove missing project binding

**Files:**
- Modify: `plugins/codex-core/test/fake-codex.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: existing `FAKE_REQUEST_LOG`, `FAKE_TURN_DELAY_MS`, and tagged-output test controls.
- Produces: `FAKE_INTERRUPT_LOG`, `FAKE_DELTA_INTERVAL_MS`, immediate `turn/start` responses, and v2-scoped notifications.

- [ ] **Step 1: Make the fake App Server return turn ids and scoped events**

Add counters and interrupt logging:

```js
let threadCounter = 0;
let turnCounter = 0;
const INTERRUPT_LOG = process.env.FAKE_INTERRUPT_LOG || "";

function recordInterrupt(params) {
  if (INTERRUPT_LOG) {
    appendFileSync(INTERRUPT_LOG, `${JSON.stringify(params)}\n`, "utf8");
  }
}
```

Replace fake `turn/start` handling with an immediate response followed by
identified notifications:

```js
case "turn/start": {
  const threadId = params.threadId;
  const turnId = `fake-turn-${++turnCounter}`;
  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  setTimeout(() => streamTurn({ threadId, turnId }), TURN_DELAY);
  break;
}

case "turn/interrupt":
  recordInterrupt(params);
  send({ id, result: {} });
  send({
    method: "turn/completed",
    params: {
      threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted", items: [], error: null },
    },
  });
  break;
```

`streamTurn` must include `threadId`, `turnId`, and a stable `itemId` on each
delta and include `threadId` plus the same turn id on completion:

```js
send({
  method: "item/agentMessage/delta",
  params: { threadId, turnId, itemId: `item-${turnId}`, delta: chunk },
});
send({
  method: "turn/completed",
  params: {
    threadId,
    turn: { id: turnId, status: "completed", items: [], error: null },
  },
});
```

- [ ] **Step 2: Extend the test helper with cwd and interrupt controls**

Add to `cli()`:

```js
...(opts.interruptLog ? { FAKE_INTERRUPT_LOG: opts.interruptLog } : {}),
...(opts.deltaInterval ? { FAKE_DELTA_INTERVAL_MS: String(opts.deltaInterval) } : {}),
```

Pass `cwd: opts.cwd` to `execFileSync` when provided. Add:

```js
function requestsByMethod(path, method) {
  return readRequests(path).filter(request => request.method === method);
}
```

- [ ] **Step 3: Write failing project-binding tests**

Create two temporary Git repositories, each initialized with:

```js
execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
```

For direct and broker foreground starts, assert the captured request payloads
equal the canonical first repository root:

```js
assert.equal(threadStart.params.cwd, realpathSync.native(repoA));
assert.equal(turnStart.params.cwd, realpathSync.native(repoA));
assert.equal(state.projectRoot, realpathSync.native(repoA));
```

After a session is created in `repoA`, invoke follow-up from `repoB` and
assert exit 6, an error containing `different project`, and no captured
`thread/resume`. Create a state file without `projectRoot` and assert a legacy
follow-up also exits 6 before resume.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="project binding|legacy unbound" plugins/codex-core/test/codex-review.test.mjs
```

Expected: FAIL because `cwd` and `projectRoot` are absent and follow-up does
not enforce project identity.

### Task 2: Implement canonical project binding

**Files:**
- Create: `plugins/codex-core/bin/lib/project-scope.mjs`
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Test: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Produces: `resolveProjectRoot(cwd: string): string` and `sameProject(a: string, b: string): boolean`.
- Consumes: these functions from CLI parsing, worker spawning, state creation, follow-up validation, and App Server request adapters.

- [ ] **Step 1: Implement the project-scope module minimally**

Create:

```js
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

function canonical(path) {
  const absolute = resolve(path);
  let value;
  try { value = realpathSync.native(absolute); } catch { value = absolute; }
  if (value.length > 1 && value.endsWith(sep)) value = value.slice(0, -1);
  return value;
}

export function resolveProjectRoot(cwd) {
  const start = canonical(cwd);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return canonical(root);
  } catch {
    return start;
  }
}

export function sameProject(a, b) {
  const left = canonical(a);
  const right = canonical(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
```

- [ ] **Step 2: Thread `--cwd` through the detached worker**

Parse optional `--cwd`, resolve `projectRoot` in the foreground process, and
always add this pair to `workerArgs`:

```js
"--cwd", projectRoot,
```

Return `projectRoot` from `parseArgs`. In worker mode trust the already
canonical `--cwd` value and do not infer it from the broker process.

- [ ] **Step 3: Bind state and App Server requests**

Change both client adapters to accept `cwd`:

```js
async startThread(opts = {}) {
  return await this.request("thread/start", {
    model: opts.model || DEFAULT_MODEL,
    cwd: opts.cwd,
    approvalPolicy: "never",
  });
}
```

Add `cwd: opts.cwd` to `turn/start`. Save new state as:

```js
{
  threadId,
  model: effectiveModel,
  projectRoot,
  createdAt: new Date().toISOString(),
  turnCount: 0,
}
```

Before validation on follow-up:

```js
if (!state.projectRoot) {
  throw new CodexError(6, "This session predates project binding. Start a new session in the current project.");
}
if (!sameProject(state.projectRoot, projectRoot)) {
  throw new CodexError(6, `Session belongs to a different project.\nSession: ${state.projectRoot}\nCurrent: ${projectRoot}\nStart a new session here.`);
}
```

- [ ] **Step 4: Run focused and full tests and verify GREEN**

```powershell
node --test --test-name-pattern="project binding|legacy unbound" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: focused tests pass and the full existing suite remains green.

- [ ] **Step 5: Commit project isolation**

```powershell
git add plugins/codex-core/bin/lib/project-scope.mjs plugins/codex-core/bin/codex-review.mjs plugins/codex-core/test
git commit -m "fix(core): bind sessions to their project root"
```

### Task 3: Prove and implement turn-id broker multiplexing

**Files:**
- Modify: `plugins/codex-core/bin/broker.mjs`
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Produces broker actions: `turn/attach` and `turn/snapshot`.
- Produces broker state: `turns`, `threadTurns`, and `watchers` maps keyed by protocol ids.
- Consumes v2 fake notifications from Task 1.

- [ ] **Step 1: Replace the old serialization assertion with a failing concurrency test**

Start two broker-backed background sessions with a 1,200 ms fake delay and
different tagged output. Record wall-clock completion and assert:

```js
assert.ok(elapsedMs < 2200, `turns were serialized: ${elapsedMs}ms`);
assert.match(outputA, new RegExp(`\\[${stateA.threadId}\\]`));
assert.doesNotMatch(outputA, new RegExp(`\\[${stateB.threadId}\\]`));
assert.match(outputB, new RegExp(`\\[${stateB.threadId}\\]`));
assert.doesNotMatch(outputB, new RegExp(`\\[${stateA.threadId}\\]`));
```

Add a test that sends a delta with the wrong `threadId`/`turnId` to one
client and asserts the output ignores it.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
node --test --test-name-pattern="concurrent broker turns|ignores foreign notification" plugins/codex-core/test/codex-review.test.mjs
```

Expected: concurrency test exceeds the threshold because the broker still
uses one global active-turn mutex; identity filtering is absent.

- [ ] **Step 3: Add broker turn snapshots and watchers**

Replace `activeTurn` and `turnWaiters` with:

```js
this.turns = new Map();
this.threadTurns = new Map();
this.watchers = new Map();
this.pendingMeta = new Map();
```

Use this snapshot constructor:

```js
function makeTurnSnapshot(threadId, turnId) {
  const now = new Date().toISOString();
  return {
    threadId,
    turnId,
    text: "",
    status: "inProgress",
    error: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
```

When a `turn/start` response arrives, register its turn id and attach the
requesting socket. Update snapshots from `item/agentMessage/delta` and
`turn/completed` using their protocol ids. Forward a turn notification only
to `watchers.get(turnId)`.

- [ ] **Step 4: Implement local attach/snapshot actions**

Handle these broker messages without forwarding upstream:

```js
case "turn/attach": {
  const snapshot = this.appServer.attachTurn(socket, msg.threadId, msg.turnId);
  socket.write(JSON.stringify({ type: "response", id: msg.id, result: snapshot }) + "\n");
  break;
}
case "turn/snapshot": {
  const snapshot = this.appServer.getTurnSnapshot(msg.threadId, msg.turnId);
  socket.write(JSON.stringify({ type: "response", id: msg.id, result: snapshot }) + "\n");
  break;
}
```

`attachTurn` must reject missing or mismatched snapshots, add the socket to
the turn's watcher set, and return a copy. Socket cleanup removes it from all
watcher sets without changing snapshot status.

- [ ] **Step 5: Filter notifications in both client paths**

Capture the immediate `turn/start` result and set `turnId`. Delta and
completion handlers must return early unless:

```js
params?.threadId === threadId && params?.turnId === turnId
```

For completion the turn id is `params?.turn?.id`. Buffer matching-thread
events received before the response and replay after `turnId` is assigned.

- [ ] **Step 6: Run focused and full tests and verify GREEN**

```powershell
node --test --test-name-pattern="concurrent broker turns|ignores foreign notification" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: parallel test completes below 2,200 ms, outputs remain isolated,
and the full suite passes.

- [ ] **Step 7: Commit broker multiplexing**

```powershell
git add plugins/codex-core/bin/broker.mjs plugins/codex-core/bin/codex-review.mjs plugins/codex-core/test
git commit -m "feat(core): multiplex broker turns by protocol identity"
```

### Task 4: Add heartbeat, reattachment, and snapshot recovery

**Files:**
- Create: `plugins/codex-core/bin/lib/turn-controller.mjs`
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/bin/broker.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Produces: `runTurn(client, params): Promise<{ text, status, turnId, reconnectCount, firstOutputAt }>`.
- Requires broker clients to implement `isBroker`, `attachTurn`, `reconnect`, `startHeartbeat`, and `stopHeartbeat`.
- Direct clients set `isBroker = false` and do not reconnect.

- [ ] **Step 1: Write a failing reconnect integration test**

Add fake control `FAKE_TURN_CHUNKS=6`. Start a broker turn, wait until its
progress contains a `turnId` and nonzero characters, then destroy only the
worker's broker socket through a test-only broker action enabled by
`CODEX_REVIEW_TEST_MODE=1`. Assert the worker reaches `completed`,
`reconnectCount === 1`, and output contains each tagged chunk exactly once.

Add a second test that terminates the App Server child and asserts the worker
fails promptly, preserves nonempty partial output, and does not issue a
second `turn/start`.

- [ ] **Step 2: Run reconnect tests and verify RED**

```powershell
node --test --test-name-pattern="reattaches after broker disconnect|does not replay after app server exit" plugins/codex-core/test/codex-review.test.mjs
```

Expected: disconnect waits until hard timeout or crashes, and no snapshot
reattachment exists.

- [ ] **Step 3: Implement typed disconnect handling and heartbeat**

Add `BrokerConnectionError extends Error`. After connection, socket `close`
and `error` must reject all pending requests and invoke one disconnect
callback. Replace fire-and-forget ping with:

```js
async ping(timeoutMs = 2000) {
  return await this.localRequest("ping", {}, timeoutMs);
}
```

While a turn is active, ping every 5,000 ms. Two consecutive failures call
the disconnect callback. Clear the interval on terminal completion.

- [ ] **Step 4: Implement broker reconnect and attach**

Use fixed delays:

```js
const RECONNECT_DELAYS_MS = [250, 1000, 2000];
```

`BrokerClient.reconnect()` rereads the current port file, creates a fresh
socket/readline pair, and restores notification subscription. `attachTurn`
sends the local action and returns a full snapshot.

In `runTurn`, on typed disconnect:

```js
for (const delayMs of RECONNECT_DELAYS_MS) {
  await sleep(delayMs);
  try {
    await client.reconnect();
    const snapshot = await client.attachTurn(threadId, turnId);
    agentText = snapshot.text;
    reconnectCount += 1;
    if (snapshot.status !== "inProgress") return terminal(snapshot);
    break;
  } catch (error) {
    lastReconnectError = error;
  }
}
```

If all attempts fail, return `connection_failed_partial` with current text;
workerMain converts it to exit 6 and writes the partial output.

- [ ] **Step 5: Handle App Server exit in the broker**

On child exit, reject pending requests, mark all in-progress snapshots
`failed`, notify watchers with a broker terminal error, remove `broker.port`,
and shut down. Do not respawn the child in place.

- [ ] **Step 6: Run reconnect and full tests and verify GREEN**

```powershell
node --test --test-name-pattern="reattaches after broker disconnect|does not replay after app server exit" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: reconnect completes once with no duplicate chunks; App Server exit
fails promptly and captured requests contain one `turn/start`.

- [ ] **Step 7: Commit recovery behavior**

```powershell
git add plugins/codex-core/bin/lib/turn-controller.mjs plugins/codex-core/bin/codex-review.mjs plugins/codex-core/bin/broker.mjs plugins/codex-core/test
git commit -m "feat(core): reattach long turns after broker disconnects"
```

### Task 5: Interrupt upstream turns on cancel and timeout

**Files:**
- Modify: `plugins/codex-core/bin/lib/turn-controller.mjs`
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

**Interfaces:**
- Consumes: Task 1 `FAKE_INTERRUPT_LOG` and Task 4 `runTurn` identity.
- Produces: `client.interruptTurn(threadId, turnId)` for both direct and broker clients.

- [ ] **Step 1: Write failing cancellation and timeout assertions**

For background cancel, wait for a recorded `turnId`, invoke `cancel`, and
assert exactly one JSONL interrupt record equals:

```js
{ threadId: state.threadId, turnId: progress.turnId }
```

For a 250 ms hard timeout with a delayed fake turn, assert exit 5,
`timeout_partial`, partial output preservation when available, and exactly one
interrupt with the matching ids.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test --test-name-pattern="cancel interrupts upstream|timeout interrupts upstream" plugins/codex-core/test/codex-review.test.mjs
```

Expected: interrupt logs are empty because current cancellation only changes
local worker state.

- [ ] **Step 3: Implement one-shot interruption**

Expose on both clients:

```js
async interruptTurn(threadId, turnId) {
  return await this.request("turn/interrupt", { threadId, turnId }, INIT_TIMEOUT_MS);
}
```

In `runTurn`, guard with `interruptSent`. On cancellation or timeout, send
one interrupt, wait up to 5,000 ms for matching terminal completion, then
return `cancelled` or `timeout_partial`. Store any interrupt error in the
result so progress can report it without changing the exit-code contract.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

```powershell
node --test --test-name-pattern="cancel interrupts upstream|timeout interrupts upstream" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
```

Expected: each path records exactly one correct interrupt and all tests pass.

- [ ] **Step 5: Commit upstream cancellation**

```powershell
git add plugins/codex-core/bin/lib/turn-controller.mjs plugins/codex-core/bin/codex-review.mjs plugins/codex-core/test
git commit -m "fix(core): interrupt upstream turns on local stop"
```

### Task 6: Add progress phases and latency measurements

**Files:**
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/test/codex-review.test.mjs`
- Modify: `plugins/codex-core/rules/review-protocol.md`
- Modify: `plugins/codex-core/rules/codex-session-ops.md`
- Modify: `plugins/codex-core/rules/codex-delegate.md`
- Modify: `plugins/codex-code-review/rules/codex-code-review.md`
- Modify: `plugins/codex-code-review/rules/codex-red-review.md`

**Interfaces:**
- Consumes: `runTurn` callbacks `onPhase`, `onDelta`, `onReconnect`, and terminal metrics.
- Produces: expanded progress JSON and exit-7 handling for every non-terminal phase.

- [ ] **Step 1: Write failing progress-metric tests**

Start a delayed background turn and poll snapshots. Assert observed phases
include `waiting_first_output` and `streaming`. Final progress must satisfy:

```js
assert.equal(progress.projectRoot, canonicalRoot);
assert.ok(progress.threadId);
assert.ok(progress.turnId);
assert.equal(progress.promptChars, promptText.length);
assert.ok(progress.firstOutputMs >= 0);
assert.ok(progress.firstOutputAt);
assert.ok(progress.lastEventAt);
assert.equal(progress.reconnectCount, 0);
```

Use a 131,073-character prompt and assert the worker log contains
`Large prompt` without changing the prompt captured by fake `turn/start`.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test --test-name-pattern="progress phases|large prompt warning" plugins/codex-core/test/codex-review.test.mjs
```

Expected: new phase names and metrics are absent.

- [ ] **Step 3: Emit phases and metrics**

Initialize a persistent progress context with `projectRoot`, `promptChars`,
`reconnectCount`, and timestamps. Emit phases in this order where applicable:

```text
queued -> connecting -> validating_model -> starting_thread
-> waiting_first_output -> streaming -> reconnecting -> streaming
-> terminal
```

Set `firstOutputAt` and `firstOutputMs` only on the first nonempty delta. Set
`lastEventAt` on every accepted turn notification. Log:

```js
if (promptText.length > 131_072) {
  log(`Large prompt (${promptText.length} chars) may increase time to first output.`);
}
```

Treat all seven non-terminal phases as exit 7 in `cmdStatus` and as live in
crash detection and cancellation.

- [ ] **Step 4: Update user-facing workflow wording**

Document plain descriptions for connecting, validating, waiting for first
output, streaming, and reconnecting. Preserve the instruction that polling
continues through every exit-7 status and that timeout partial output remains
usable.

- [ ] **Step 5: Run focused and full tests and verify GREEN**

```powershell
node --test --test-name-pattern="progress phases|large prompt warning" plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
git diff --check
```

Expected: phase/metric tests pass, all integration tests pass, and Markdown
changes have no whitespace errors.

- [ ] **Step 6: Commit observable progress**

```powershell
git add plugins/codex-core plugins/codex-code-review/rules
git commit -m "feat(core): report long-turn latency and recovery phases"
```

### Task 7: Release, validate, and refresh the Claude Code installation

**Files:**
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/codex-core/.claude-plugin/plugin.json`
- Modify: `plugins/codex-code-review/.claude-plugin/plugin.json`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `plugins/codex-core/skills/setup/SKILL.md`

**Interfaces:**
- Consumes: completed v2.5.0 runtime behavior.
- Produces: marketplace-visible versions, release notes, validated installed wrapper, and Claude Code cache refresh.

- [ ] **Step 1: Bump exact versions and document behavior**

Set marketplace metadata and codex-core to `2.5.0`; set codex-code-review to
`2.4.0`. Document project binding, parallel broker turns, automatic local
reattachment, real upstream interruption, progress phases, and the unchanged
GPT-5.6 model table.

- [ ] **Step 2: Validate JSON, syntax, tests, and release text**

```powershell
node --check plugins/codex-core/bin/codex-review.mjs
node --check plugins/codex-core/bin/broker.mjs
node --check plugins/codex-core/bin/lib/project-scope.mjs
node --check plugins/codex-core/bin/lib/turn-controller.mjs
node --test plugins/codex-core/test/codex-review.test.mjs
node -e "for (const p of ['.claude-plugin/marketplace.json','plugins/codex-core/.claude-plugin/plugin.json','plugins/codex-code-review/.claude-plugin/plugin.json']) JSON.parse(require('node:fs').readFileSync(p,'utf8')); console.log('manifest JSON OK')"
rg -n '2\.5\.0|2\.4\.0|projectRoot|waiting_first_output|turn/interrupt' .claude-plugin plugins README.md README.ko.md
git diff --check
```

Expected: syntax checks succeed, every test passes, manifest parsing prints
`manifest JSON OK`, expected release strings are present, and diff check is
clean.

- [ ] **Step 3: Commit release metadata**

```powershell
git add .claude-plugin plugins README.md README.ko.md
git commit -m "feat: release resilient long-running reviews"
```

- [ ] **Step 4: Run independent review and address findings**

Invoke `superpowers:requesting-code-review` for the complete branch diff.
Resolve every Critical or Important finding with a new failing regression
test before changing production code. Re-run the full suite after fixes.

- [ ] **Step 5: Update the installed Claude Code plugins**

After the release commit is pushed to `origin/main`, run:

```powershell
claude plugin update codex-core@sanghyun-io
claude plugin update codex-code-review@sanghyun-io
claude plugin list
```

Expected: the list reports `codex-core` `2.5.0` and
`codex-code-review` `2.4.0`. Locate their refreshed cache roots under
`~/.claude/plugins/cache/sanghyun-io/`, then copy the same files that the
`/codex-core:setup` workflow synchronizes:

```powershell
$core = Resolve-Path "$HOME/.claude/plugins/cache/sanghyun-io/codex-core/2.5.0"
$review = Resolve-Path "$HOME/.claude/plugins/cache/sanghyun-io/codex-code-review/2.4.0"
Copy-Item "$core/bin/codex-review.mjs" "$HOME/.claude/bin/codex-review.mjs" -Force
Copy-Item "$core/bin/broker.mjs" "$HOME/.claude/bin/broker.mjs" -Force
Copy-Item "$core/bin/lib" "$HOME/.claude/bin/lib" -Recurse -Force
Copy-Item "$core/rules/*.md" "$HOME/.claude/rules/" -Force
Copy-Item "$review/rules/*.md" "$HOME/.claude/rules/" -Force
```

Verify installed SHA-256 hashes match the cache files. Claude Code requires a
restart before its active session picks up the refreshed plugin metadata and
skills.

- [ ] **Step 6: Final verification**

Run one real broker-backed Terra probe in the current repository and confirm
the captured state/progress show the canonical project root, matching thread
and turn ids, and `completed`. Run two isolated fake broker turns to confirm
parallel completion and output isolation. Confirm `git status --short` is
clean before publishing.
