---
name: readout
description: Display the output of a completed Codex session along with its thread_id, so you can resume the thread externally via the codex CLI. Works for code-review, delegate, and red-review sessions.
argument-hint: "[<session-id>]"
invocation:
  command: readout
  user_invocable: true
---

# Readout

Fetch and display the output of a completed Codex session (completed, cancelled, or timeout_partial), together with the `threadId` needed to resume it from the `codex` CLI directly.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **결과 조회**).

## Arguments

- `(no args)` — List completed sessions and ask which to display
- `<session-id>` — Display a specific session (e.g., `dg_1728473812_9876`)

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-review-core:setup` if you haven't configured the plugin yet.
