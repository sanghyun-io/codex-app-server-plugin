# codex-app-server-plugin

A Claude Code plugin monorepo that integrates the **Codex App Server** with Claude Code, enabling stateful multi-round iterative code review using **gpt-5.4** (or any configurable model).

## Plugins

This repo contains two independent plugins. Install only what you need:

| Plugin | Purpose | Required |
|--------|---------|:--------:|
| **codex-review-core** | Codex App Server CLI wrapper (`codex-review.mjs`) | ✅ |
| **codex-review-rules** | Review workflow rules for iterative code review | Optional |

## How It Works

```
Claude Code
  └─ codex-review.mjs              (JSON-RPC wrapper — installed by codex-review-core)
       └─ broker.mjs (TCP, opt-out) (persistent IPC serializer — auth cached, warm app-server)
            └─ codex app-server      (single subprocess, shared across workers)
                 └─ gpt-5.4            (stateful thread, model is configurable)
```

The wrapper manages thread lifecycle via three commands:
- `start` — create thread + first turn
- `follow-up` — resume thread + next turn (incremental diff only)
- `close` — clean up session state

By default, workers connect through a **persistent broker** (`broker.mjs`) that holds a single warm `codex app-server` subprocess on a localhost TCP port. This eliminates per-turn spawn overhead (~2–3s) and reuses a single auth check across all workers. The broker auto-starts on first use, idles out after 10 minutes, and is torn down by the `SessionEnd` hook. Set `CODEX_REVIEW_NO_BROKER=1` to bypass the broker and spawn `codex app-server` directly (used in tests).

The model used for review is configurable (priority: CLI flag > env var > default):

```bash
# CLI flag
node codex-review.mjs start prompt.txt out.txt --session s1 --review-dir /tmp --model gpt-4o

# Environment variable
CODEX_REVIEW_MODEL=gpt-4o node codex-review.mjs start ...

# Default (no override needed)
node codex-review.mjs start ...  # uses gpt-5.4
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CODEX_REVIEW_MODEL` | Override default model | `gpt-5.4` |
| `CODEX_REVIEW_NO_BROKER` | Skip broker, spawn `codex app-server` directly (set to `1`) | unset |
| `CODEX_BINARY` | Path to a custom binary used in place of `codex app-server` (testing hook) | unset |

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

Installs the `codex-review.mjs` CLI binary, the broker, lifecycle scripts, and the review output schema to `~/.claude/`. No rules are added — Claude's behavior is unchanged until you explicitly invoke the binary or install `codex-review-rules`.

### Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `codex-review.mjs` | `~/.claude/bin/` | JSON-RPC wrapper CLI |
| `broker.mjs` | `~/.claude/bin/` | Persistent TCP broker for IPC serialization |
| `session-lifecycle.mjs` | `~/.claude/bin/` | SessionStart/SessionEnd handler (worker + broker cleanup) |
| `stop-gate.mjs` | `~/.claude/bin/` | Stop hook quality gate (active reviews / uncommitted changes) |
| `review-output.schema.json` | `~/.claude/schemas/` | JSON schema for structured review output |

### Hook Events

`codex-review-core` registers four hooks via `hooks.json`:

| Event | Script | Purpose |
|-------|--------|---------|
| `Setup` | `scripts/install.sh` | Copies bin/schemas into `~/.claude/` on plugin install |
| `SessionStart` | `session-lifecycle.mjs start` | Exports session metadata for worker coordination |
| `SessionEnd` | `session-lifecycle.mjs end` | Kills running workers, shuts down broker, cleans temp files |
| `Stop` | `stop-gate.mjs` | Blocks session stop when reviews are in flight or unreviewed changes exist |

### Skills

| Skill | Invocation |
|-------|-----------|
| Setup | `/codex-review-core:setup` |

## Plugin: codex-review-rules (Optional)

Installs review workflow rules that instruct Claude to automatically offer iterative code review using Codex.

> **Requires** `codex-review-core` to be installed first.

### Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `review-protocol.md` | `~/.claude/rules/` | Shared protocol (session, polling, prompts) |
| `codex-code-review.md` | `~/.claude/rules/` | Code review workflow |
| `codex-red-review.md` | `~/.claude/rules/` | Adversarial (security) review workflow |
| `codex-delegate.md` | `~/.claude/rules/` | A+ task delegation workflow |
| `codex-session-ops.md` | `~/.claude/rules/` | Session list / cancel / readout |
| `codex-delegation.md` | `~/.claude/rules/` | Natural language intent router |

After installation, add to your `~/.claude/CLAUDE.md`:

```
@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-delegation.md
@~/.claude/rules/codex-code-review.md
@~/.claude/rules/codex-red-review.md
@~/.claude/rules/codex-delegate.md
@~/.claude/rules/codex-session-ops.md
```

### Skills

| Skill | Invocation | Description |
|-------|-----------|-------------|
| Code Review | `/codex-review-rules:code-review` | Iterative multi-round code review |
| Red Review | `/codex-review-rules:red-review` | Adversarial, security-focused review |
| Delegate | `/codex-review-rules:delegate` | Delegate a coding task (A+ pattern — Codex proposes, Claude applies) |
| Sessions | `/codex-review-rules:sessions` | List all Codex sessions (running + completed) |
| Halt | `/codex-review-rules:halt` | Cancel a running Codex session |
| Readout | `/codex-review-rules:readout` | Show a completed session's output along with its metadata (model, turn count, internal thread ID) |

### Natural Language Router

With `codex-delegation.md` imported, Claude auto-routes when you mention Codex in plain language. The router inspects the verb and dispatches to the right skill — no slash command required.

| You say | Routes to |
|---------|-----------|
| "Codex에게 리뷰 부탁해" / "Have Codex review this" | `code-review` |
| "Codex로 보안 검토해줘" / "Ask Codex to check for vulns" | `red-review` |
| "Codex에게 이 버그 고쳐달라고 해" / "Let Codex fix the race condition" | `delegate` |
| "Codex에게 이 함수가 왜 느린지 물어봐" (read-only) | `delegate --read-only` |
| "Codex 세션 뭐 돌아가고 있어?" / "What Codex sessions are running" | `sessions` |
| "Codex 지금 거 중단해" / "Stop the Codex session" | `halt` |
| "Codex 그 결과 다시 보여줘" / "Show me that Codex output" | `readout` |

If the intent is ambiguous, Claude asks with an `AskUserQuestion` prompt instead of guessing.

### A+ Delegation Pattern

`delegate` uses a **Codex = brain / Claude = hands** split:

1. Codex analyzes the task and returns a concrete change proposal (unified diff or structured JSON).
2. Claude applies the proposal with `Edit` / `Write`, runs verification, and captures the result.
3. Claude sends a `follow-up` turn with the applied-change summary. The Codex thread remembers prior context, so only the delta is transmitted.
4. Loop until Codex declares `DONE`, then `close` the thread.

This keeps file writes under Claude's tool-permission control while letting Codex drive the plan.

### Code Review

```
/codex-review-rules:code-review              # Current branch vs default branch
/codex-review-rules:code-review PR#123       # Review a specific PR
/codex-review-rules:code-review --base main  # Review against a specific base
/codex-review-rules:code-review --with-opus  # Add Claude Opus cross-validation
```

### Red Review

```
/codex-review-rules:red-review               # Adversarial review of current branch
/codex-review-rules:red-review PR#123        # Adversarial review of a PR
/codex-review-rules:red-review --with-opus   # Add Claude Opus cross-validation
```

### Delegate

```
/codex-review-rules:delegate Fix the null pointer in UserService.login
/codex-review-rules:delegate Refactor auth middleware to use JWT --model gpt-5.4
/codex-review-rules:delegate Why is /api/v1/users returning 500 --read-only
```

### Session Operations

```
/codex-review-rules:sessions            # List all sessions
/codex-review-rules:sessions --running  # Only running
/codex-review-rules:halt                # Pick a running session to cancel
/codex-review-rules:halt cr_1728473812_9876
/codex-review-rules:readout             # Pick a completed session to view
/codex-review-rules:readout dg_1728473812_9876
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
