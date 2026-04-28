---
name: halt
description: Cancel a running Codex session. If multiple sessions are running, asks which one to halt. Preserves partial output files and thread state for later inspection or resume.
argument-hint: "[<session-id> | --all]"
invocation:
  command: halt
  user_invocable: true
---

# Halt

Cancel one or more running Codex sessions. Wraps `codex-review cancel` with session discovery and user selection.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **세션 중단**).

## Arguments

- `(no args)` — List running sessions and ask which to cancel
- `<session-id>` — Cancel a specific session (e.g., `cr_1728473812_9876`)
- `--all` — Cancel every running session (requires explicit confirmation)

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.
