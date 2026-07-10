# Long-Running Review Reliability and Project Isolation Design

## Context

`codex-review.mjs` runs long Codex turns in detached workers and normally
connects them through one user-wide broker. The broker owns one persistent
`codex app-server` process and is shared by every Claude Code project under
the same user profile.

The current implementation has four coupled problems:

1. `thread/start` and `turn/start` omit `cwd`. The broker process therefore
   leaves Codex to infer a working directory from the process that first
   launched the user-wide broker.
2. The broker serializes every `turn/start` globally because it assumes turn
   notifications cannot be attributed to a thread. Codex 0.144.1 schemas
   require `threadId` and `turnId` on agent-message deltas and identify the
   thread on turn lifecycle notifications, so this global queue is no longer
   necessary.
3. Closing a worker socket releases the broker's active-turn mutex without
   interrupting the upstream turn. A late notification from that abandoned
   turn can then be routed to the next socket that acquires the mutex.
4. Worker cancellation stops only the local worker. It does not send
   `turn/interrupt`, and there is no heartbeat, reconnect, or broker-side turn
   snapshot for a worker that temporarily loses its local TCP connection.

The current progress file makes queue time and model time indistinguishable.
It changes to `running` before the broker grants the global turn slot, and it
records only elapsed time and received character count. Large prompts can
also increase time to first output: review workflows may send project context
plus an inline diff capped at 256 KiB. No measurement currently separates
prompt preparation, broker wait, first output, and generation time.

The App Server protocol provides the primitives needed to fix these issues:

- `cwd` overrides on both `thread/start` and `turn/start`;
- immediate `turn/start` responses containing a turn id;
- turn and item notifications scoped by thread and turn ids;
- `turn/interrupt` for in-flight cancellation; and
- `thread/resume` for rejoining a loaded running thread.

## Goals

- Bind every new review/delegation session to one canonical project root.
- Refuse a follow-up before any App Server request when it comes from a
  different project.
- Route all streamed output and completion events by `threadId` and `turnId`.
- Allow turns on different threads to execute concurrently through one
  broker.
- Keep an upstream turn alive across a temporary worker-to-broker disconnect
  and let the worker reattach without duplicating output.
- Send `turn/interrupt` on user cancellation and hard timeout.
- Surface honest progress phases and latency measurements.
- Preserve the fixed GPT-5.6 workflow defaults and account-aware model
  validation delivered in v2.4.0.

## Non-goals

- Do not change, alias, or automatically fall back from the selected model.
- Do not change review prompts or verdict semantics in this release.
- Do not migrate code-review/red-review to `review/start` in this release.
- Do not use the experimental WebSocket App Server transport.
- Do not automatically replay a turn after an App Server process crash; an
  automatic replay could repeat tool calls or produce duplicate work.
- Do not make broker connectivity dependent on external network services.

## Release scope

This design ships as:

- marketplace metadata `2.5.0`;
- `codex-core` `2.5.0`; and
- `codex-code-review` `2.4.0` because its workflow rules and user-facing
  progress guidance change with the runtime protocol.

Native `review/start` prompt reduction is a separate v2.6 design. Version
2.5.0 records the measurements needed to evaluate that migration without
mixing output-quality changes into the reliability release.

## Design

### 1. Canonical project binding

The foreground CLI resolves the project root once, before it spawns a worker:

1. If `--cwd <path>` is present, resolve that path.
2. Otherwise start from `process.cwd()`.
3. Run `git rev-parse --show-toplevel` from that directory.
4. If the command succeeds, use the returned repository root; otherwise use
   the starting directory.
5. Canonicalize the path with `realpathSync.native` when available, normalize
   separators, remove a trailing separator, and compare case-insensitively on
   Windows.

The resolved value is forwarded to the detached worker as `--cwd`. A new
session stores it as `projectRoot` in its state file and passes it to both
`thread/start` and `turn/start`. A follow-up compares its current canonical
root with `state.projectRoot` before model validation or `thread/resume`.

On mismatch the worker exits 6 and reports both paths plus an instruction to
start a new session in the current project. No override is provided because
silently rebinding an existing conversation defeats the isolation guarantee.

State created before v2.5.0 has no `projectRoot`. A legacy follow-up fails
closed with a concise message asking the user to start a new session. Review
session state is temporary, so preserving an unbound thread is not worth the
cross-project risk.

### 2. Protocol-correct turn identity

The fake App Server and both real client paths adopt the current v2 lifecycle:

- `turn/start` returns immediately with `{ turn: { id, status } }`;
- every delta includes `threadId`, `turnId`, `itemId`, and `delta`;
- `turn/completed` includes `threadId` and the completed turn object; and
- the wrapper stores the active `turnId` in the progress file.

Turn handlers ignore notifications whose `threadId` or `turnId` does not
match the active operation. Notifications that arrive after the thread is
known but before the `turn/start` response are buffered per thread and
replayed after the returned turn id is recorded.

This filtering applies in direct mode as defense in depth even though a
direct client normally owns only one active turn.

### 3. Broker multiplexer

The global active-turn mutex and FIFO waiter list are removed. The broker
maintains these maps instead:

```text
turns:       turnId -> TurnSnapshot
threadTurns: threadId -> active turnId
watchers:    turnId -> Set<socket>
pending:     requestId -> requesting socket and method metadata
```

`TurnSnapshot` contains:

```text
turnId, threadId, text, status, error,
startedAt, updatedAt, completedAt
```

When `turn/start` succeeds, the broker registers the returned turn id,
attaches the requesting socket, and responds to the request. Upstream
notifications update the matching snapshot and are forwarded only to sockets
watching that turn. Closing a socket removes only that watcher; it never
releases, cancels, or reassigns the upstream turn.

The broker exposes two local actions:

- `turn/attach`: attach a socket to an existing snapshot by `threadId` and
  `turnId`, returning the complete current snapshot;
- `turn/snapshot`: read a snapshot without changing upstream state.

Snapshots are retained for ten minutes after completion, matching the
broker's existing idle lifetime. They contain the same generated text already
written to per-session output files and stay under localhost-only transport.

### 4. Heartbeat and reattachment

`BrokerClient` performs a request/response heartbeat every five seconds while
a turn is active. `ping` carries an id and the broker answers with `pong` and
that id. Missing two consecutive heartbeats or receiving socket `close`/`error`
marks the connection disconnected and rejects outstanding broker requests
with a typed connection error.

During an active turn the worker attempts three reconnects with delays of
250 ms, 1 s, and 2 s. Each attempt rereads `broker.port`, connects, and sends
`turn/attach` using the recorded thread and turn ids. The returned snapshot
replaces the local accumulated text, preventing duplicate deltas. Streaming
then continues from subsequent notifications.

If the snapshot is already terminal, the worker finishes from it immediately.
If the broker process or App Server died and no snapshot can be recovered,
the worker saves its partial output and exits 6 with an explicit recovery
message. It does not replay the request automatically.

### 5. Cancellation and timeout

Once `turn/start` returns, cancellation and timeout paths know both ids.
They send:

```json
{
  "method": "turn/interrupt",
  "params": { "threadId": "...", "turnId": "..." }
}
```

After a successful interrupt request the worker waits up to five seconds for
`turn/completed` with status `interrupted`. It then saves accumulated output.
A failed interrupt still ends the local worker after the grace period but is
logged and reflected in progress metadata.

User cancellation remains exit 8. Hard timeout remains exit 5 and preserves
partial output. Because the broker snapshot remains bound to the original
turn id, late terminal events cannot be delivered to another session.

### 6. Honest progress and latency metrics

Progress status gains these non-terminal phases:

```text
queued
connecting
validating_model
starting_thread
waiting_first_output
streaming
reconnecting
```

Terminal statuses remain `completed`, `cancelled`, `timeout_partial`,
`failed`, and `crashed`.

Every progress snapshot includes:

```text
projectRoot
threadId
turnId
promptChars
charsReceived
startedAt
lastEventAt
firstOutputAt
firstOutputMs
reconnectCount
```

`status` treats every non-terminal phase as exit 7. Session listing and review
protocol documentation translate the phases into plain user language. A
request with no output is no longer described simply as running: users can
distinguish connection setup, model validation, waiting for the first model
output, streaming, and reconnection.

The worker logs a warning when `promptChars` exceeds 131,072 characters but
does not truncate or rewrite the prompt. This measurement and `firstOutputMs`
provide the baseline for the v2.6 native-review experiment.

### 7. Broker/App Server failure handling

When the App Server child exits, the broker:

- rejects every pending JSON-RPC request;
- marks active snapshots failed with an App Server exit message;
- forwards a terminal broker error to their watchers;
- removes the stale port file; and
- shuts down so the next worker can start a fresh broker.

The broker does not restart underneath an active turn because it cannot prove
that replay is safe. A later new session starts a new broker normally.

## Compatibility

- Model selection priority and persisted-model follow-ups remain unchanged.
- Existing v2.4.0 sessions without `projectRoot` cannot be followed up and
  must be restarted.
- Direct mode (`CODEX_REVIEW_NO_BROKER=1`) receives the same cwd binding,
  notification filtering, interrupt behavior, and progress fields.
- Session IDs and file names remain unchanged.
- No new runtime dependency is added; implementation uses Node.js built-ins.

## Test strategy

The fake App Server will emit current v2 identifiers and support
`turn/interrupt`. Broker tests will use multiple detached workers and an
isolated fake home.

Regression coverage includes:

- direct and broker `thread/start`/`turn/start` payloads contain the canonical
  project root;
- state persists `projectRoot` and follow-up from a different root exits 6
  before `thread/resume`;
- legacy unbound state fails closed;
- two broker turns stream concurrently and each output contains only its own
  tagged deltas;
- disconnecting one watcher does not release or contaminate another turn;
- a worker reconnects and replaces its local text with the broker snapshot;
- cancel and hard-timeout paths send exactly one `turn/interrupt` with the
  correct ids;
- an App Server exit fails active workers promptly with partial output;
- progress transitions through waiting, streaming, and reconnecting with
  prompt and first-output metrics;
- all model validation, background execution, follow-up, and session
  operation tests remain green.

## Acceptance criteria

- A Codex turn never runs without an explicit canonical project root.
- A session cannot be resumed from a different project or from unbound legacy
  state.
- No notification is appended or completed unless both its thread and turn
  identity match the active operation.
- Two different threads can make progress simultaneously through the broker.
- Temporary worker/broker disconnection does not duplicate output and does
  not silently restart the model request.
- Cancel and timeout interrupt the actual upstream turn.
- Progress output identifies the current phase and records prompt size and
  time to first output.
- All automated tests pass on Windows and remain portable to the repository's
  existing POSIX test path.

