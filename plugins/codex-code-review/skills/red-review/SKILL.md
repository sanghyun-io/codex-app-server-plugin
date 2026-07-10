---
name: red-review
description: Adversarial security-focused code review using Codex. Unlike the default code-review, this prompt instructs Codex to act as an attacker hunting for vulnerabilities, auth bypasses, race conditions, injection flaws, and data leakage paths.
argument-hint: "[PR#N | --base <ref>] [--model <name>] [--with-opus]"
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
- `--model <name>` — Override Codex model (workflow default: `gpt-5.6-sol`, env: `CODEX_REVIEW_MODEL`)
- `--with-opus` — Enable Opus cross-validation after Codex review

## Examples

```
/codex-code-review:red-review
/codex-code-review:red-review PR#123
/codex-code-review:red-review --base develop --model gpt-5.6-terra
/codex-code-review:red-review --with-opus
```

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Plain Language)

When you relay the security findings back to the user, use plain, easy words — not hard technical terms. Do NOT use metaphors or analogies; just say the same thing in simpler words. And do NOT compress everything into one short line — explain enough that someone non-technical understands without asking follow-ups.

- Replace hard terms with everyday words. If a security term is unavoidable, write it and then add a short plain-words explanation right after it (e.g. "SQL injection(공격자가 입력칸에 명령어를 넣어 데이터베이스를 조작하는 공격)").
- Do NOT surface mechanism words like Thread, Turn, threadId, exit code, polling, JSON-RPC, App Server, or `rr_`/`cr_` session prefixes in the user-facing summary at all.
- For each finding, take a few sentences — not one terse line — to explain: how an attacker could actually exploit it, what they would gain, and what to do to close the hole. Give enough context that the user understands the danger without asking. Keep CVE/CWE names only as an optional aside.
- Explain severity in plain words about the real danger ("이건 뚫리면 실제로 데이터가 새거나 계정이 털릴 수 있음" vs "이론상 가능하지만 실제로 악용되긴 어려움"), not just the HIGH/MED/LOW label.
- Keep the deep technical detail available, but only show it when the user asks ("자세히 보여줘").
- Always write the final report to the user in Korean.
