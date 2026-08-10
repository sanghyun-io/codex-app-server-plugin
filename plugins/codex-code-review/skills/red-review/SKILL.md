---
name: red-review
description: Use when reviewing code from an adversarial security perspective for vulnerabilities, auth bypasses, races, injection flaws, or data leakage.
argument-hint: "[PR#N | --base <ref>] [--model <name>] [--effort <level>] [--tone easy|plain|normal|deep] [--with-opus]"
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
- `--effort <level>` — Override reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; default: `high`)
- `--tone <level>` — Result readability: `easy` (비개발자), `plain` (풀어서, 기본값), `normal` (평범하게), `deep` (아주 자세히). Distinct from `--effort` (readability vs reasoning depth).
- `--with-opus` — Enable Opus cross-validation after Codex review

## Examples

```
/codex-code-review:red-review
/codex-code-review:red-review PR#123
/codex-code-review:red-review --base develop --model gpt-5.6-terra --effort max
/codex-code-review:red-review --with-opus
```

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Tone Levels)

Relay the security findings in Korean at the `--tone` level (default `plain`). The level controls vocabulary and depth — the same findings are reported, just phrased for the audience. Regardless of level: always write the final report in Korean, never surface mechanism words (Thread, Turn, threadId, exit code, polling, JSON-RPC, App Server, `cr_`/`rr_` prefixes) in the user-facing summary, and do NOT use metaphors or analogies. For each finding explain, in proportion to the level: how an attacker could exploit it, what they would gain, and how to close the hole.

- **`easy` (쉽게, 비개발자)**: Everyday language, no jargon. If a security term is truly unavoidable, define it inline in one short clause. Explain severity as real danger ("뚫리면 실제로 데이터가 새거나 계정이 털릴 수 있음" vs "이론상 가능하지만 악용은 어려움"), not the HIGH/MED/LOW label.
- **`plain` (풀어서, 기본값 — 일반 개발자)**: Ordinary development terms are fine, but the FIRST time a security acronym appears, expand it inline in parentheses (e.g. "SQL injection(입력칸에 명령어를 넣어 DB를 조작하는 공격)", "IDOR(식별자를 조작해 남의 데이터에 접근하는 결함)"). A few sentences per finding with enough context to understand the danger. Severity in plain words plus the label.
- **`normal` (평범하게, 숙련 개발자)**: Standard security terminology used directly, concise. CVE/CWE names as an optional aside. Keep the HIGH/MED/LOW label.
- **`deep` (아주 자세히, 전문가)**: Full offensive depth — retain CWE/CVE, the vector/exploit/impact chain, `file:line`, and the mitigation options/recommendation per finding.

For `easy`/`plain`/`normal`, keep the deep exploit detail available but only show it when the user asks ("자세히 보여줘"). For `deep`, include it up front.

## References

- `~/.claude/rules/codex-red-review.md` — Read whenever executing this adversarial review workflow.
