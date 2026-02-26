# codex-app-server-plugin

A Claude Code plugin that integrates the **Codex App Server** with Claude Code, enabling stateful multi-round plan validation and iterative code review using **gpt-5.3-codex**.

## What It Does

| Feature | Description |
|---------|-------------|
| **Plan Validation** | After writing a plan, Claude offers multi-round validation via Codex. Issues are presented with options (A/B/C) and tracked across rounds. |
| **Code Review** | `/codex-app-server-plugin:code-review` starts an iterative review session. Each round sends only incremental diffs to save tokens. |
| **Stateful Threads** | Uses Codex App Server's thread persistence — the model remembers previous review context within a session. |

## How It Works

```
Claude Code
  └─ codex-review.mjs          (JSON-RPC wrapper)
       └─ codex app-server      (spawned subprocess)
            └─ gpt-5.3-codex    (stateful thread)
```

The wrapper (`codex-review.mjs`) manages thread lifecycle via three commands:
- `start` — create thread + first turn
- `follow-up` — resume thread + next turn (incremental diff only)
- `close` — clean up session state

All exit codes have graceful fallback: if Codex is unavailable, validation is automatically skipped without blocking your workflow.

## Prerequisites

- [Claude Code](https://claude.ai/code) v1.x+
- [Node.js](https://nodejs.org) v18+
- [codex CLI](https://github.com/openai/codex) with a ChatGPT account (`codex login`)

## Installation

```bash
# 1. Add as marketplace
/plugin marketplace add sanghyun-io/codex-app-server-plugin

# 2. Install plugin (runs install.sh automatically)
claude plugin install codex-app-server-plugin@sanghyun-io

# 3. Verify setup
/codex-app-server-plugin:setup
```

The setup skill guides you through:
- Verifying Node.js and codex CLI
- Completing `codex login` if needed
- Adding rules to your `~/.claude/CLAUDE.md`

## Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `codex-review.mjs` | `~/.claude/bin/` | App Server wrapper |
| `review-protocol.md` | `~/.claude/rules/` | Core review protocol |
| `codex-plan-validation.md` | `~/.claude/rules/` | Plan validation workflow |
| `codex-code-review.md` | `~/.claude/rules/` | Code review workflow |

## Usage

### Plan Validation

After finishing a plan in Plan mode, Claude automatically offers validation:

```
Plan 작성이 완료되었습니다. Multi-Model Debate로 유효성 검증을 실행할까요?
  ▶ 검증 실행
    스킵
```

Codex reviews the plan across 4 areas: Architecture, Implementation Quality, Test Strategy, Performance.

### Code Review

```
/codex-app-server-plugin:code-review              # Current branch vs default branch
/codex-app-server-plugin:code-review PR#123       # Review a specific PR
/codex-app-server-plugin:code-review --base main  # Review against a specific base
/codex-app-server-plugin:code-review --with-opus  # Add Claude Opus cross-validation
```

Review continues round by round, sending only incremental diffs, until all issues are resolved or the user decides to stop.

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

## Skills

| Skill | Invocation | Description |
|-------|-----------|-------------|
| Setup | `/codex-app-server-plugin:setup` | Verify prerequisites and configuration |
| Code Review | `/codex-app-server-plugin:code-review` | Start iterative code review |

## License

MIT © [sanghyun-io](https://github.com/sanghyun-io)
