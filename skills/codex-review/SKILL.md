---
name: codex-review
description: Start a multi-round iterative code review using Codex App Server (gpt-5.3-codex). Tracks issues across rounds until convergence. Reviews current branch vs default branch by default.
argument-hint: "[PR#N | --base <ref>] [--with-opus]"
invocation:
  command: codex-review
  user_invocable: true
---

# Code Review

Start a multi-round code review session following the protocol in `~/.claude/rules/codex-code-review.md`.

## Arguments

- `(no args)` — Review current branch vs default branch
- `PR#N` — Review PR number N via `gh pr diff N`
- `--base <ref>` — Review against a specific base ref
- `--with-opus` — Enable Opus cross-validation after Codex review

## Execution

$ARGUMENTS

Follow the complete workflow defined in `~/.claude/rules/codex-code-review.md`.

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-app-server-plugin:setup` if you haven't configured the plugin yet.
