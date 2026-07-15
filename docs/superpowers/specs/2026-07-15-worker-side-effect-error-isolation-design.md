# Worker Side-Effect Error Isolation Design

## Goal

Keep a long-running Codex review alive when progress persistence or the local
broker transport experiences a transient failure. Progress reporting and broker
reconnection are support functions; neither may terminate an otherwise viable
turn through an uncaught exception or unhandled event.

## Scope

This change is limited to `plugins/codex-core/bin/codex-review.mjs` and its
integration tests. It does not change the progress JSON schema, broker protocol,
turn timeout policy, or output/state persistence semantics.

## Progress Persistence

`saveProgress` remains synchronous so existing call sites and ordering stay
unchanged. Atomic replacement will retry Windows sharing-violation style errors
(`EPERM`, `EACCES`, and `EBUSY`) a small, bounded number of times with short
delays. If the final attempt fails, the temporary file is removed where possible,
the failure is logged to the worker log, and execution continues.

Progress data is observational and may safely miss an update. Final model output
and session state are not routed through this best-effort path and retain their
current failure behavior.

## Broker Readline Errors

Each `readline.Interface` created for a broker socket receives an `error`
listener. The listener forwards the error to `BrokerClient._handleDisconnect`,
the same path used by socket errors and close events. Existing
`disconnectNotified` deduplication guarantees that a single transport reset
cannot start multiple reconnect loops when both the socket and readline layer
report it.

The interface listener is attached before line processing begins. Reconnect
continues to replace the old interface and socket with newly guarded instances.

## Tests

Integration coverage will prove two regressions:

1. A simulated transient `EPERM` during progress-file replacement does not crash
   the worker, and the review completes with valid output and progress state.
2. A broker connection reset propagated through `readline.Interface` does not
   produce an unhandled `error`; the worker enters the existing reconnect flow
   and completes from the broker snapshot.

The focused tests must fail against the current implementation before production
code changes. After the patch, the focused tests and the complete codex-review
test suite must pass, followed by a Node syntax check.

## Operational Rollout

After repository verification, copy the verified `codex-review.mjs` to the active
`~/.claude/bin/codex-review.mjs` runtime and any active codex-core cache copy used
by hooks. Verify hashes so the running installation matches the tested source.
