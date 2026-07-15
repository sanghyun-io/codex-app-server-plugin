# V3 Durable Multi-Session Runtime Design

## Goal

Support multiple Claude Code sessions and long-running Codex turns without a
shared execution process becoming a global failure point. Jobs must survive
client disconnects and supervisor restarts, recover automatically from transient
transport or process failures, and isolate an unrecoverable failure to one job.

## Constraints

- Preserve the `start`, `follow-up`, `status`, `cancel`, and `close` CLI contract.
- Preserve current exit-code meanings and project-root binding.
- Support Node.js 18 or newer without external npm dependencies.
- Support Windows, macOS, and Linux.
- Run at most three jobs concurrently by default; make the limit configurable.
- Keep one active turn per Codex thread while allowing unrelated sessions to run
  concurrently.
- Let jobs outlive the Claude Code session that submitted them. Only explicit
  cancellation stops a job.
- Treat automatic recovery as the default behavior.

## Architecture

`codex-review.mjs` becomes a thin command client. It submits durable work and
queries a persistent `supervisor.mjs` over local IPC. The supervisor owns queue
scheduling but does not own active Codex transports. Each dispatched job runs in
an independent `job-worker.mjs`, and every worker owns a dedicated `codex
app-server` subprocess.

This boundary prevents one app-server, readline interface, or transport error
from affecting another job. A supervisor failure also does not terminate active
workers: workers continue receiving output and writing their attempt journals,
then register with the replacement supervisor.

The supervisor uses a configurable worker limit with a default of three. Jobs
are dispatched FIFO, subject to a per-thread rule that prevents concurrent turns
on the same Codex thread.

## Runtime Layout

Runtime state lives under `~/.claude/codex-runtime/v3`:

```text
supervisor/
  endpoint.json
  events.jsonl
jobs/<job-id>/
  request.json
  attempts/
    0001/
      events.jsonl
      output.part
    0002/
      events.jsonl
      output.part
  result.txt
```

`request.json` is immutable and contains `schemaVersion: 3`, the prompt, model,
canonical project root, owner session, command, and prior thread metadata. The
supervisor acknowledges submission only after the immutable request and queued
event are durable.

Supervisor queue and cancellation events are append-only. Each attempt journal
has exactly one writer: its worker. Model deltas append to `output.part`; status
checkpoints are written at most once every three seconds. The CLI never polls
these files directly, eliminating reader-versus-rename contention.

On successful completion, the worker flushes `output.part`, publishes immutable
`result.txt`, then appends and flushes the terminal event. If the terminal event
is lost, `result.txt` is sufficient evidence to recover the job as completed.
An incomplete final JSONL line is treated as a crash tail and ignored. Invalid
immutable input is a terminal corruption error.

## Job State Machine

The only valid transitions are:

```text
queued -> starting -> running -> completed
                         |-----> recovering -> running
                         |-----> cancelled
                         `-----> failed
```

Terminal states are immutable. Every attempt has a monotonically increasing
generation, and events from older generations are ignored after a replacement
attempt starts.

Transport resets, app-server exits, worker exits, and lost supervisor
connections are recoverable. A still-live worker registers with the restarted
supervisor and continues the same generation. A lost worker or app-server starts
a replacement attempt after delays of one, three, and ten seconds. After three
replacement attempts the job fails and preserves its latest partial output.

Because Codex runs with `approvalPolicy: never` and acts as the analysis side of
the Claude/Codex workflow, replaying the current prompt cannot duplicate an
external write. Completed prior turns are resumed by thread ID; an incomplete
current turn is replayed as a new attempt. Authentication errors, unavailable
models, invalid project roots, and corrupt immutable requests fail immediately.

Cancellation is persisted before signalling a worker. Recovery never dispatches
a job with a durable cancellation request. Worker and app-server termination use
nonce-verified process identity and bounded escalation.

## IPC and Process Lifetime

Windows uses a named pipe; macOS and Linux use a Unix domain socket. Messages are
newline-delimited JSON request/response frames authenticated by a per-runtime
token. Every socket and `readline.Interface` consumes `error` and `close` events,
and all cleanup routines are idempotent.

The command client starts a missing supervisor under a nonce-protected startup
lock and retries connection for a bounded interval. Workers reconnect and
register after supervisor replacement. A dedicated app-server remains a child of
its worker so explicit job cancellation terminates the complete execution tree.

Session lifecycle hooks no longer cancel jobs on `SessionEnd`. Ownership remains
metadata for filtering, diagnostics, and access from later Claude sessions.

## Compatibility and Upgrade

Existing CLI verbs, arguments, JSON status fields, and exit codes remain
compatible so installed skills and rules do not require a synchronized rewrite.
New jobs use the v3 runtime. Existing v2 workers and the v2 broker are not
force-migrated; they may finish naturally, and the old broker exits on idle.
Read-only access to existing v2 result and state files remains available during
the transition.

The v3 implementation removes the shared broker from the normal execution path.
The `CODEX_REVIEW_NO_BROKER` compatibility setting becomes unnecessary for v3
jobs but may remain accepted as a no-op during the transition.

## Verification

The release suite must include:

- state reducer and journal-tail recovery unit tests;
- FIFO scheduling with three concurrent jobs and queued overflow;
- serialization of follow-up turns on one thread;
- independent jobs from different Claude sessions;
- forced IPC disconnect and reconnect;
- forced worker, app-server, and supervisor termination;
- supervisor replacement while an existing worker completes;
- completion concurrent with reconnect;
- cancellation concurrent with supervisor restart;
- incomplete journal tails and missing terminal events;
- Windows result-file locking and retry behavior;
- v2 CLI contract and exit-code regressions;
- installed-plugin lifecycle verification on the active runtime.

No v3 release is complete until fault-injection coverage and the full existing
suite pass on the repository version, followed by verification of the installed
plugin copy.
