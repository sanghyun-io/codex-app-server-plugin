# Session-Scoped Claude Lifecycle Design

## Context

Every Codex review worker stores its control files in the user-wide
`~/.claude/tmp` directory. The persistent broker is also user-wide and is
shared by all Claude Code sessions.

The current `SessionEnd` hook treats those shared resources as if they belong
to the Claude Code session that is ending. It terminates every worker found by
an `*_pid` file, terminates the broker, and removes every progress, state, and
worker-log file. Closing one Claude Code session therefore kills reviews that
were started by other live sessions.

The hook also reads `CLAUDE_SESSION_ID` from the environment, while Claude
Code provides `session_id` in the hook JSON on stdin. Session ownership is
therefore unavailable even before cleanup begins.

## Goals

- Associate every background review worker with the Claude Code session that
  started it.
- Limit `SessionEnd` cancellation and cleanup to workers owned by the ending
  Claude Code session.
- Keep the user-wide broker alive while other sessions may still use it.
- Preserve partial output and terminal progress when a session-owned worker is
  cancelled.
- Apply the corrected lifecycle script and wrapper to the current local Claude
  Code installation after automated verification.

## Non-goals

- Do not change review prompts, model selection, verdict semantics, or session
  IDs used by review workflows.
- Do not move review artifacts into per-Claude-session directories.
- Do not add a new daemon, dependency, or broker reference-count service.
- Do not delete completed prompt, output, or history artifacts automatically.

## Considered Approaches

### 1. Store owner metadata with each worker (selected)

`SessionStart` reads the hook JSON and exports the Claude session ID through
`CLAUDE_ENV_FILE`. `codex-review` copies that value into its PID metadata.
`SessionEnd` reads its own hook JSON and cancels only PID records with a
matching owner.

This is a small extension of the existing control-file protocol, works with
the shared temp directory, and leaves review workflow file naming unchanged.

### 2. Use one temp directory per Claude session

This gives strong filesystem isolation but requires every skill and rule to
discover the correct directory across rounds. It would also complicate
follow-up and recovery compatibility for existing sessions.

### 3. Reference-count the broker and globally registered sessions

A shared registry could decide when the last Claude session exits. This adds
locking, stale-owner recovery, and another global state machine. It is not
needed because the broker already shuts itself down after its idle timeout.

## Design

### Hook input and environment propagation

`session-lifecycle.mjs` reads one JSON object from stdin for both `start` and
`end`. It obtains the owner ID from `input.session_id`, with the existing
environment variable accepted only as a compatibility fallback for manual or
older integrations.

On `SessionStart`, when `CLAUDE_ENV_FILE` is available, the hook appends an
environment assignment for `CODEX_REVIEW_OWNER_SESSION`. Claude Code then
propagates that value to Bash commands and the detached review worker. The
existing session marker file remains diagnostic metadata and uses the parsed
session ID rather than an empty filename.

The session ID is treated as opaque data. Environment-file serialization must
quote it safely rather than interpolating unescaped hook input into shell
syntax.

### Worker ownership metadata

PID files retain their existing JSON format and add an optional
`ownerSessionId` field:

```json
{
  "pid": 12345,
  "nonce": "random-worker-nonce",
  "ownerSessionId": "claude-session-id"
}
```

Foreground execution does not need ownership metadata because there is no
detached worker to clean up. Background `start` and `follow-up` commands read
`CODEX_REVIEW_OWNER_SESSION` and write it with the PID and nonce.

Existing PID files without ownership are treated as unowned legacy records.
A session-level hook must not terminate them because it cannot prove
ownership. Normal `status`, `cancel`, and `close` commands remain compatible
with both formats.

### Session-scoped cancellation

On `SessionEnd`, the lifecycle hook examines PID records and selects only
those whose `ownerSessionId` exactly matches the parsed ending session ID.
For each selected worker it writes the existing cancellation marker. On
POSIX it may also send `SIGTERM` to wake the worker's handler. On Windows it
must not send external `SIGTERM`, which terminates Node before its handler can
reliably preserve partial output; the worker polls the marker instead.

The hook does not immediately delete progress, state, worker log, PID, or
cancellation files. The worker owns its terminal update and PID cleanup, and
explicit `codex-review close` remains responsible for final session cleanup.
The session marker file for the ending Claude session is removed.

If hook input has no session ID, the hook logs a warning and performs no
worker cancellation. Failing closed is safer than reverting to global
cleanup.

### Broker lifecycle

`SessionEnd` never terminates `broker.port`'s process and never removes the
port file. The broker is user-wide, tracks active clients, and already exits
after ten minutes without clients. Explicit global teardown remains available
through process management and test cleanup, but it is not a session-level
responsibility.

### Compatibility

- Existing review state, output, and PID files remain readable.
- Legacy unowned workers are not killed by unrelated session exits.
- Direct mode remains supported; its detached workers receive the same owner
  metadata even though no broker is present.
- Manual invocations outside Claude Code may set
  `CODEX_REVIEW_OWNER_SESSION`; otherwise they remain unowned.

## Error Handling

- Invalid or absent hook JSON produces a warning and uses the compatibility
  environment fallback if present.
- Missing `CLAUDE_ENV_FILE` does not fail `SessionStart`; ownership will be
  absent and cleanup will fail closed.
- Malformed PID files are skipped without affecting other records.
- Failure to write a cancellation marker or, where applicable, signal a selected worker is
  logged and does not broaden cleanup to other workers.
- Broker state is never mutated by `SessionEnd`, including on partial errors.

## Test Strategy

Add lifecycle integration tests that use isolated temporary homes and real
short-lived Node worker processes:

- `SessionStart` reads `session_id` from stdin, writes a correctly named marker,
  and exports `CODEX_REVIEW_OWNER_SESSION` through `CLAUDE_ENV_FILE`.
- Ending session A requests cancellation only for A's worker and leaves B's
  worker alive.
- Ending session A leaves the shared broker process and `broker.port` intact.
- Unowned legacy PID records survive session end.
- Missing session identity performs no destructive cleanup.
- Background wrapper PID metadata includes the owner session ID supplied by
  the environment.

Run the focused lifecycle and wrapper tests first, then the complete Node test
suite. After repository verification, run the plugin installer and compare
the installed runtime files with the verified repository copies.

## Acceptance Criteria

- Closing one Claude Code session cannot terminate or erase another session's
  active review.
- The ending session's owned workers receive the normal cancellation marker
  without forced Windows termination.
- A session exit cannot terminate the shared broker.
- Hook ownership comes from Claude Code's stdin `session_id` and is propagated
  to background worker PID metadata.
- Legacy or unidentified resources are preserved rather than globally
  deleted.
- All automated tests pass before the local installation is updated.
