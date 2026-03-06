# codex-app-server-plugin

A Claude Code plugin monorepo that integrates the **Codex App Server** with Claude Code, enabling stateful multi-round plan validation and iterative code review using **gpt-5.3-codex** (or any configurable model).

## Plugins

This repo contains two independent plugins. Install only what you need:

| Plugin | Purpose | Required |
|--------|---------|:--------:|
| **codex-review-core** | Codex App Server CLI wrapper (`codex-review.mjs`) | ✅ |
| **codex-review-rules** | Review workflow rules for plan validation and code review | Optional |

## How It Works

```
Claude Code
  └─ codex-review.mjs          (JSON-RPC wrapper — installed by codex-review-core)
       └─ codex app-server      (spawned subprocess)
            └─ gpt-5.3-codex    (stateful thread, model is configurable)
```

The wrapper manages thread lifecycle via three commands:
- `start` — create thread + first turn
- `follow-up` — resume thread + next turn (incremental diff only)
- `close` — clean up session state

The model used for review is configurable (priority: CLI flag > env var > default):

```bash
# CLI flag
node codex-review.mjs start prompt.txt out.txt --session s1 --review-dir /tmp --model gpt-4o

# Environment variable
CODEX_REVIEW_MODEL=gpt-4o node codex-review.mjs start ...

# Default (no override needed)
node codex-review.mjs start ...  # uses gpt-5.3-codex
```

## Prerequisites

- [Claude Code](https://claude.ai/code) v1.x+
- [Node.js](https://nodejs.org) v18+
- [codex CLI](https://github.com/openai/codex) with a ChatGPT account (`codex login`)

## Installation

```bash
# 1. Add marketplace
/plugin marketplace add sanghyun-io/codex-app-server-plugin

# 2. Install core (CLI binary only)
claude plugin install codex-review-core@sanghyun-io

# 3. (Optional) Install rules for full review workflow
claude plugin install codex-review-rules@sanghyun-io

# 4. Verify setup
/codex-review-core:setup
```

## Plugin: codex-review-core

Installs the `codex-review.mjs` CLI binary to `~/.claude/bin/`. No rules are added — Claude's behavior is unchanged until you explicitly invoke the binary or install `codex-review-rules`.

### Installed Files

| File | Location |
|------|----------|
| `codex-review.mjs` | `~/.claude/bin/` |

### Skills

| Skill | Invocation |
|-------|-----------|
| Setup | `/codex-review-core:setup` |

## Plugin: codex-review-rules (Optional)

Installs review workflow rules that instruct Claude to automatically offer plan validation and iterative code review using Codex.

> **Requires** `codex-review-core` to be installed first.

### Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `review-protocol.md` | `~/.claude/rules/` | Core review protocol |
| `codex-plan-validation.md` | `~/.claude/rules/` | Plan validation workflow |
| `codex-code-review.md` | `~/.claude/rules/` | Code review workflow |

After installation, add to your `~/.claude/CLAUDE.md`:

```
@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-plan-validation.md
@~/.claude/rules/codex-code-review.md
```

### Skills

| Skill | Invocation | Description |
|-------|-----------|-------------|
| Code Review | `/codex-review-rules:code-review` | Start iterative code review |

### Plan Validation

After finishing a plan in Plan mode, Claude automatically offers validation:

```
Plan 작성이 완료되었습니다. Multi-Model Debate로 유효성 검증을 실행할까요?
  ▶ 검증 실행
    스킵
```

### Code Review

```
/codex-review-rules:code-review              # Current branch vs default branch
/codex-review-rules:code-review PR#123       # Review a specific PR
/codex-review-rules:code-review --base main  # Review against a specific base
/codex-review-rules:code-review --with-opus  # Add Claude Opus cross-validation
```

## Exit Codes

| Code | Meaning | Behavior |
|------|---------|----------|
| 0 | Success | Normal flow |
| 1 | codex not found | Auto-skip |
| 2 | Auth failure | Auto-skip + `codex login` guide |
| 3 | Rate limit | Auto-skip |
| 4 | Thread resume fail | Retry with new thread |
| 5 | Timeout (5 min) | Auto-skip |
| 6 | Process error | 1 retry, then skip |

## License

MIT © [sanghyun-io](https://github.com/sanghyun-io)
