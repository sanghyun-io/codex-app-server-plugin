---
name: delegate
description: Delegate a coding task (fix, implement, refactor, debug) to Codex using the A+ pattern. Codex analyzes and proposes concrete changes (diff/JSON); Claude applies them with Edit/Write. Multi-turn Thread reuses context so follow-ups only send deltas.
argument-hint: "<task description> [--model <name>] [--read-only]"
invocation:
  command: delegate
  user_invocable: true
---

# Delegate (Codex A+ Task Delegation)

Delegate an autonomous coding task to Codex while keeping Claude as the executor.

Codex is the brain: analyzes the codebase, proposes specific changes in unified diff or JSON format, and decides when the task is complete. Claude is the hands: applies those changes with the Edit/Write tools, runs verification, and reports results back to Codex for the next turn.

Follow the complete workflow defined in `~/.claude/rules/codex-delegate.md`.

## Arguments

- `<task description>` — Free-form task description (e.g., "Fix the null pointer in UserService.login")
- `--model <name>` — Override Codex model (default: `gpt-5.5`)
- `--read-only` — Question-answer mode: Codex answers without proposing file changes

## Examples

```
/codex-core:delegate Refactor auth middleware to use JWT instead of session tokens
/codex-core:delegate Find and fix the race condition in OrderService --model gpt-4o
/codex-core:delegate Why does /api/v1/users return 500 when email is null --read-only
```

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.
