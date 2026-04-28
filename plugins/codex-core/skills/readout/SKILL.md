---
name: readout
description: Display the output and metadata (model, turn count, internal thread ID, status) of a completed Codex session. Works for code-review, delegate, and red-review sessions.
argument-hint: "[<session-id>]"
invocation:
  command: readout
  user_invocable: true
---

# Readout

Fetch and display the output of a completed Codex session (completed, cancelled, or timeout_partial), together with its metadata. The `threadId` shown is the App Server's internal thread identifier, not a resumable session UUID for the interactive `codex` CLI — use the same Claude skill again to follow up on the thread.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **결과 조회**).

## Arguments

- `(no args)` — List completed sessions and ask which to display
- `<session-id>` — Display a specific session (e.g., `dg_1728473812_9876`)

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.
