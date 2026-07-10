---
name: code-review
description: Start a multi-round iterative code review using Codex App Server (default model gpt-5.6-terra). Tracks issues across rounds until convergence. Reviews current branch vs default branch by default.
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
- `--model <name>` — Override Codex model (workflow default: `gpt-5.6-terra`, env: `CODEX_REVIEW_MODEL`)
- `--with-opus` — Enable Opus cross-validation after Codex review

## Examples

```
/codex-code-review:code-review
/codex-code-review:code-review PR#123
/codex-code-review:code-review --base develop --model gpt-5.6-sol
/codex-code-review:code-review --with-opus
```

## Execution

$ARGUMENTS

Follow the complete workflow defined in `~/.claude/rules/codex-code-review.md`.

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Plain Language)

When you relay review results back to the user, use plain, easy words — not hard technical terms. Do NOT use metaphors or analogies; just say the same thing in simpler words. And do NOT compress everything into one short line — explain enough that someone non-technical understands without asking follow-ups.

- Replace hard terms with everyday words. If a technical term is unavoidable, write it and then add a short plain-words explanation right after it (e.g. "race condition(두 작업이 동시에 실행돼서 순서가 꼬이는 문제)").
- Do NOT surface mechanism words like Thread, Turn, threadId, exit code, polling, JSON-RPC, App Server, or `rr_`/`cr_` session prefixes in the user-facing summary at all.
- For each issue, take a few sentences — not one terse line — to explain: what is wrong, why it actually matters, and what to do about it. Give enough context that the user does not have to ask "그래서 무슨 뜻이야?".
- Explain severity in plain words about what happens if ignored ("이건 지금 안 고치면 실제로 문제가 생김" vs "당장은 괜찮고 나중에 정리해도 됨"), not just the HIGH/MED/LOW label.
- Keep the deep technical detail available, but only show it when the user asks ("자세히 보여줘").
- Always write the final report to the user in Korean.
