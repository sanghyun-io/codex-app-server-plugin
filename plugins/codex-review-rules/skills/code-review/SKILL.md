---
name: code-review
description: Start a multi-round iterative code review using Codex App Server (default model gpt-5.4). Tracks issues across rounds until convergence. Reviews current branch vs default branch by default.
argument-hint: "[PR#N | --base <ref>] [--model <name>] [--with-opus]"
invocation:
  command: code-review
  user_invocable: true
---

# Code Review

Start a multi-round code review session following the protocol in `~/.claude/rules/codex-code-review.md`.

## Arguments

- `(no args)` — Review current branch vs default branch
- `PR#N` — Review PR number N via `gh pr diff N`
- `--base <ref>` — Review against a specific base ref
- `--model <name>` — Override Codex model (default: `gpt-5.4`, env: `CODEX_REVIEW_MODEL`)
- `--with-opus` — Enable Opus cross-validation after Codex review

## Examples

```
/codex-review-rules:code-review
/codex-review-rules:code-review PR#123
/codex-review-rules:code-review --base develop --model gpt-4o
/codex-review-rules:code-review --with-opus --model gpt-5.4
```

## Execution

$ARGUMENTS

Follow the complete workflow defined in `~/.claude/rules/codex-code-review.md`.

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-review-core:setup` if you haven't configured the plugin yet.
