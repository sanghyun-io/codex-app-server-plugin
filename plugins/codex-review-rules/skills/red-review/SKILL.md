---
name: red-review
description: Adversarial security-focused code review using Codex. Unlike the default code-review, this prompt instructs Codex to act as an attacker hunting for vulnerabilities, auth bypasses, race conditions, injection flaws, and data leakage paths.
argument-hint: "[PR#N | --base <ref>] [--with-opus]"
invocation:
  command: red-review
  user_invocable: true
---

# Red Review (Adversarial Codex Review)

Run a multi-round code review through Codex, but with an attacker's mindset. The prompt emphasizes security boundaries, untrusted input, auth/authz holes, and side-channel exploitation.

Follow the complete workflow defined in `~/.claude/rules/codex-red-review.md`.

## Arguments

- `(no args)` — Review current branch vs default branch
- `PR#N` — Review PR number N via `gh pr diff N`
- `--base <ref>` — Review against a specific base ref
- `--with-opus` — Enable Opus cross-validation after Codex review

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-review-core:setup` if you haven't configured the plugin yet.
