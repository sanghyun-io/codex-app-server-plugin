---
name: sessions
description: List all Codex sessions (running, completed, cancelled) across all skills (code-review, delegate, red-review). Shows session ID, elapsed time, model, and status in a grouped table.
argument-hint: "[--running | --completed]"
invocation:
  command: sessions
  user_invocable: true
---

# Sessions

List every Codex session in `~/.claude/tmp/`, grouped by skill prefix and status.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **세션 현황 조회**).

## Arguments

- `(no args)` — Show all sessions (running + completed)
- `--running` — Show only running sessions
- `--completed` — Show only completed/cancelled/failed sessions

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.
