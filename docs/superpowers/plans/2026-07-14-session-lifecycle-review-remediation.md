# Session Lifecycle Review Remediation Implementation Plan

> **Execution note:** This plan is being executed in the current session because the user approved all review findings through LOW severity.

**Goal:** Close every review finding from the multi-Claude-session `/red-review` lifecycle change: prevent stale-PID signalling, bound Windows cleanup, remove the broker reconnect test race, and publish the patch as `codex-core` 2.5.1.

**Architecture:** Keep cancellation marker-first so workers can persist partial output. `SessionEnd` will only signal a process after matching the PID record's nonce against the live process command line, wait once for all owned workers within the 10-second hook budget, then re-verify identity immediately before forced termination. Broker tests will synchronize on observable reconnect state instead of fixed sleeps. Runtime metadata will move to 2.5.1 and the same files will be copied into the active local Claude installation.

**Tech Stack:** Node.js ESM, `node:test`, Claude Code hook JSON, PowerShell local installation checks.

---

## Task 1: Lock the lifecycle safety contract with failing tests

**Files:**
- Modify: `plugins/codex-core/test/session-lifecycle.test.mjs`

- [ ] Extend `runHook` to accept environment overrides so tests can use a short cleanup grace period.
- [ ] Pass a known nonce on each spawned worker command line and write the same nonce to its PID record.
- [ ] Add a stubborn owned-worker test: marker is written, the worker ignores it, and `SessionEnd` force-terminates it after the configured grace period.
- [ ] Add a mismatched-nonce test: the PID belongs to a live process but the PID record nonce does not match, so no signal or force-kill occurs.
- [ ] Run the stubborn-worker test against the current implementation and confirm it fails on Windows because marker-only cleanup has no escalation.

Command:

```powershell
node --test --test-name-pattern="force-terminates|nonce does not match" plugins/codex-core/test/session-lifecycle.test.mjs
```

## Task 2: Implement identity-verified bounded cleanup

**Files:**
- Modify: `plugins/codex-core/scripts/session-lifecycle.mjs`
- Modify: `plugins/codex-core/hooks/hooks.json`
- Modify: `README.md`

- [ ] Add a strict process identity reader:
  - Linux: `/proc/<pid>/cmdline`, with `ps` fallback.
  - macOS/other POSIX: `ps -p <pid> -o command=`.
  - Windows: `Get-CimInstance Win32_Process` via `powershell.exe`, with `pwsh.exe` fallback.
- [ ] Treat missing nonce, failed command-line lookup, and nonce mismatch as unverifiable and refuse to signal.
- [ ] Write all cancellation markers before waiting, so multiple owned workers receive cancellation concurrently.
- [ ] On POSIX, send `SIGTERM` only after strict identity verification. On Windows, let the marker path run first.
- [ ] Wait once for all verified owned workers using `CODEX_REVIEW_SESSION_END_GRACE_MS` (default 7000 ms, capped below the 10000 ms hook timeout).
- [ ] Re-read and re-verify process identity immediately before `SIGKILL` to prevent PID-reuse termination during the grace window.
- [ ] Update the hook description and README to describe marker-first bounded escalation without claiming that `SessionEnd` shuts down the shared broker.
- [ ] Run the complete lifecycle test file and confirm all tests pass.

Command:

```powershell
node --test plugins/codex-core/test/session-lifecycle.test.mjs
```

## Task 3: Remove timing races from queued-interrupt reconnect coverage

**Files:**
- Modify: `plugins/codex-core/test/codex-review.test.mjs`

- [ ] Make the test control helper retry transient `ECONNREFUSED`/startup races until its existing timeout instead of failing on the first socket attempt.
- [ ] Replace the fixed 50 ms disconnect delay with an observable state check that confirms the worker has entered reconnect handling.
- [ ] Keep the broker port record absent until at least one reconnect attempt is observable, then restore it; this proves the interrupt is queued during a real outage.
- [ ] Preserve the exact-once interrupt assertion.
- [ ] Run the focused reconnect test repeatedly to demonstrate stability.

Commands:

```powershell
1..10 | ForEach-Object {
  node --test --test-name-pattern="retries a queued interrupt" plugins/codex-core/test/codex-review.test.mjs
  if ($LASTEXITCODE -ne 0) { throw "Reconnect run $_ failed" }
}
```

## Task 4: Publish the patch version

**Files:**
- Modify: `plugins/codex-core/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/codex-core/bin/codex-review.mjs`
- Modify: `plugins/codex-core/bin/broker.mjs`

- [ ] Change marketplace metadata and `codex-core` package metadata from 2.5.0 to 2.5.1.
- [ ] Change both App Server `clientInfo.version` values to 2.5.1.
- [ ] Leave historical 2.5.0 design and migration references unchanged.
- [ ] Verify no live package/runtime version field still reports 2.5.0.

Command:

```powershell
rg -n '"version"\s*:\s*"2\.5\.0"|version: "2\.5\.0"' plugins/codex-core .claude-plugin
```

## Task 5: Verify source and active installation

**Files:**
- Source: `plugins/codex-core/bin/codex-review.mjs`
- Source: `plugins/codex-core/bin/broker.mjs`
- Source: `plugins/codex-core/scripts/session-lifecycle.mjs`
- Install target: `~/.claude/bin/`
- Active plugin cache: `~/.claude/plugins/cache/sanghyun-io/codex-core/2.5.0/`

- [ ] Run focused lifecycle and reconnect tests.
- [ ] Run the entire test suite at least twice; any failure must be diagnosed rather than dismissed as flaky.
- [ ] Copy the updated runtime and hook files into `~/.claude/bin/` and the currently active cache directory. Keep the cache directory name because Claude's plugin registry owns it; copy 2.5.1 metadata into the cache so runtime contents identify the hotfix accurately.
- [ ] Compare SHA-256 hashes between source, installed runtime, and active cache.
- [ ] Run lifecycle tests against the installed hook via `LIFECYCLE_SCRIPT`.
- [ ] Review the final diff for correctness, scope, stale documentation, and unsafe PID operations.

Commands:

```powershell
node --test plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/test/codex-review.test.mjs
node --test plugins/codex-core/test/session-lifecycle.test.mjs plugins/codex-core/test/codex-review.test.mjs
$env:LIFECYCLE_SCRIPT="$HOME/.claude/bin/session-lifecycle.mjs"
node --test plugins/codex-core/test/session-lifecycle.test.mjs
Remove-Item Env:LIFECYCLE_SCRIPT
git diff --check
git status --short
```

## Final self-review checklist

- [ ] No signal is sent from `SessionEnd` without a nonce match against the live command line.
- [ ] The identity check is repeated immediately before force-kill.
- [ ] Marker-first graceful cancellation still preserves partial-output behavior.
- [ ] The total cleanup grace stays within Claude Code's 10-second `SessionEnd` timeout.
- [ ] Shared broker state and foreign/legacy workers remain untouched.
- [ ] Reconnect tests wait on observable state, not arbitrary sleeps.
- [ ] Package and runtime metadata consistently report 2.5.1.
- [ ] Repository and installed-copy tests pass.
