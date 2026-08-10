---
name: code-review
description: Use when reviewing a branch, pull request, or base-ref diff with Codex across one or more review rounds.
argument-hint: "[PR#N | --base <ref>] [--model <name>] [--effort <level>] [--tone easy|plain|normal|deep] [--with-opus]"
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
- `--effort <level>` — Override reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; default: `high`)
- `--tone <level>` — Result readability: `easy` (비개발자), `plain` (풀어서), `normal` (평범하게), `deep` (아주 자세히). Session-only override; the persistent default is `defaultTone` in `~/.claude/codex-review.config.json` (else `plain`). Distinct from `--effort` (readability vs reasoning depth).
- `--with-opus` — Enable Opus cross-validation after Codex review

## Examples

```
/codex-code-review:code-review
/codex-code-review:code-review PR#123
/codex-code-review:code-review --base develop --model gpt-5.6-sol --effort max
/codex-code-review:code-review --with-opus
```

## Execution

$ARGUMENTS

Follow the complete workflow defined in `~/.claude/rules/codex-code-review.md`.

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Tone Levels)

Relay review results in Korean at the effective tone level — `--tone` (or an in-session request) if given this session, otherwise `defaultTone` from `~/.claude/codex-review.config.json`, otherwise `plain`. The level controls vocabulary and depth — the same findings are reported, just phrased for the audience. Regardless of level: always write the final report in Korean, never surface mechanism words (Thread, Turn, threadId, exit code, polling, JSON-RPC, App Server, `cr_`/`rr_` prefixes) in the user-facing summary, and do NOT use metaphors or analogies — say the same thing in plainer words.

- **`easy` (쉽게, 비개발자)**: Everyday language, no jargon. If a technical term is truly unavoidable, define it inline in one short clause. A few sentences per issue: what is wrong, why it matters, what to do. Explain severity as a real-world consequence ("지금 안 고치면 실제로 문제가 생김" vs "당장은 괜찮음"), not the HIGH/MED/LOW label.
- **`plain` (풀어서, 기본값 — 일반 개발자)**: Ordinary development terms are fine, but the FIRST time a specialized/security acronym appears, expand it inline in parentheses (e.g. "race condition(두 작업이 동시에 실행돼 순서가 꼬이는 문제)", "IDOR(식별자를 조작해 남의 데이터에 접근하는 결함)"). A few sentences per issue with enough context that the user need not ask "그래서 무슨 뜻이야?". Severity in plain words plus the label.
- **`normal` (평범하게, 숙련 개발자)**: Standard technical terms used directly, concise — one or two sentences per issue. Keep the HIGH/MED/LOW label.
- **`deep` (아주 자세히, 전문가)**: Full technical depth — retain CWE/CVE names, exact mechanisms, and `file:line` detail, and include the options/recommendation breakdown per finding.

For `easy`/`plain`/`normal`, keep the deepest technical detail available but only show it when the user asks ("자세히 보여줘"). For `deep`, include it up front.

## References

- `~/.claude/rules/codex-code-review.md` — Read whenever executing this code-review workflow.
