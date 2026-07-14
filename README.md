# codex-app-server-plugin

> 🌐 [한국어](./README.ko.md)

A Claude Code plugin marketplace that integrates the **Codex App Server** with Claude Code. New sessions use GPT-5.6 workflow defaults, with stateful threads, model overrides, and cross-turn context reuse.

## Plugins

| Plugin | What it gives you | Required |
|--------|-------------------|:--------:|
| **codex-core** | Everything needed to use Codex from Claude Code: CLI runtime, broker, hooks, natural language router, A+ task delegation (`/codex-core:delegate`), and session ops (`sessions`/`halt`/`readout`) | ✅ |
| **codex-code-review** | Iterative multi-round code review and adversarial security review workflows (`/codex-code-review:code-review`, `/codex-code-review:red-review`) | Optional |

After installing **codex-core** alone, sentences like "Codex에게 이 버그 고쳐달라고 해" or "Have Codex fix the race condition" already work — Claude routes them to the right skill automatically.

**codex-code-review** adds review-specific workflows on top: round-by-round issue tracking, deferred issue history, opt-in Opus cross-validation.

## How It Works

```
Claude Code
  └─ codex-review.mjs              (JSON-RPC wrapper — installed by codex-core)
       └─ broker.mjs (TCP, opt-out) (persistent IPC multiplexer — auth cached, warm app-server)
            └─ codex app-server      (single subprocess, shared across workers)
                 └─ gpt-5.6-*          (stateful thread, model is configurable)
```

The wrapper manages thread lifecycle via three commands:
- `start` — create thread + first turn
- `follow-up` — resume thread + next turn (incremental diff only)
- `close` — clean up session state

By default, workers connect through a **persistent broker** (`broker.mjs`) that holds a single warm `codex app-server` subprocess on a localhost TCP port. This eliminates per-turn spawn overhead (~2–3s), reuses a single auth check, and safely multiplexes concurrent turns by `threadId`/`turnId`. During an active turn the wrapper sends a 5-second heartbeat; after two missed replies it reconnects and reattaches to the broker's output snapshot without replaying the prompt. The broker auto-starts on first use and idles out after 10 minutes. `SessionEnd` cancels only workers owned by that Claude session, verifies each live process against its nonce before signalling, and uses bounded escalation while leaving the shared broker available to other sessions. Set `CODEX_REVIEW_NO_BROKER=1` to bypass it.

Each session is bound to the canonical Git project root and sends that same `cwd` to both `thread/start` and `turn/start`. Follow-ups from another project fail before reaching Codex. Progress JSON exposes connection/validation/thread/first-output/streaming phases plus prompt size, first-output latency, received characters, protocol IDs, and reconnect count. Prompts over 131,072 characters are preserved intact and receive a latency warning only.

The model used for each call is configurable (priority: CLI flag > env var > workflow default > wrapper default `gpt-5.6-terra`):

```bash
# CLI flag
node codex-review.mjs start prompt.txt out.txt --session s1 --review-dir /tmp --model gpt-5.6-sol

# Environment variable
CODEX_REVIEW_MODEL=gpt-5.6-luna node codex-review.mjs start ...
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CODEX_REVIEW_MODEL` | Override workflow/wrapper model | unset (wrapper default: `gpt-5.6-terra`) |
| `CODEX_REVIEW_NO_BROKER` | Skip broker, spawn `codex app-server` directly (set to `1`) | unset |
| `CODEX_REVIEW_HEARTBEAT_MS` | Broker heartbeat interval (advanced/testing) | `5000` |
| `CODEX_BINARY` | Path to a custom binary used in place of `codex app-server` (testing hook) | unset |

## Prerequisites

- [Claude Code](https://claude.ai/code) v1.x+
- [Node.js](https://nodejs.org) v18+
- [codex CLI](https://github.com/openai/codex) with a ChatGPT account (`codex login`)

## Installation

```bash
# 1. Add marketplace
/plugin marketplace add sanghyun-io/codex-app-server-plugin

# 2. Install core (gives you natural language + delegate + session ops)
/plugin install codex-core@sanghyun-io

# 3. (Optional) Install code-review workflows
/plugin install codex-code-review@sanghyun-io

# 4. Verify
/codex-core:setup
```

The `codex-core` install hook auto-activates rules by appending a marker block to `~/.claude/CLAUDE.md`. The block is idempotent (safe to re-run).

### Updating

When you update the plugin via `/plugin`, the **plugin cache** is refreshed, but the rule files Claude actually reads live at `~/.claude/rules/*.md` (the skills `@import` them from there, not from the cache). The install hook copies them across on update, so in most cases the new rules apply automatically.

> Not strictly required, but **running `/codex-core:setup` once after an update is the safe move.** It diffs the cache against `~/.claude/rules/` and re-copies anything that changed — guaranteeing the latest rules are active even if the hook didn't fire.

## Plugin: codex-core

The runtime + universal workflows. Installs CLI binary, broker, hook scripts, schemas, the natural language router, A+ delegation, and session operations.

### Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `codex-review.mjs` | `~/.claude/bin/` | JSON-RPC wrapper CLI |
| `broker.mjs` | `~/.claude/bin/` | Persistent TCP broker for concurrent turn multiplexing and recovery |
| `lib/project-scope.mjs` | `~/.claude/bin/lib/` | Canonical project-root binding and comparison |
| `session-lifecycle.mjs` | `~/.claude/bin/` | SessionStart/SessionEnd handler (session-owned worker cancellation) |
| `stop-gate.mjs` | `~/.claude/bin/` | Stop hook quality gate (active reviews / uncommitted changes) |
| `review-output.schema.json` | `~/.claude/schemas/` | JSON schema for structured review output |
| `review-protocol.md` | `~/.claude/rules/` | Shared call protocol (session ID, polling, error handling) |
| `codex-delegation.md` | `~/.claude/rules/` | Natural language intent router |
| `codex-delegate.md` | `~/.claude/rules/` | A+ task delegation workflow |
| `codex-session-ops.md` | `~/.claude/rules/` | Session list / cancel / readout |

### Hook Events

| Event | Script | Purpose |
|-------|--------|---------|
| `Setup` | `scripts/install.sh` | Copies bin/schemas/rules into `~/.claude/`, manages CLAUDE.md marker block |
| `SessionStart` | `session-lifecycle.mjs start` | Exports session metadata for worker coordination |
| `SessionEnd` | `session-lifecycle.mjs end` | Marker-first cancellation for workers owned by the ending session, followed by nonce-verified bounded escalation; the shared broker exits on idle timeout |
| `Stop` | `stop-gate.mjs` | Blocks session stop when reviews are in flight or unreviewed changes exist |

### Skills

| Skill | Invocation | Description |
|-------|-----------|-------------|
| Setup | `/codex-core:setup` | Verify Node, codex CLI, auth, and installed files |
| Delegate | `/codex-core:delegate <task>` | A+ task delegation — Codex proposes, Claude applies |
| Sessions | `/codex-core:sessions` | List all Codex sessions (running + completed) |
| Halt | `/codex-core:halt` | Cancel a running Codex session |
| Readout | `/codex-core:readout` | Display a completed session's output + metadata |

### Natural Language Router

With `codex-delegation.md` imported (auto-activated on install), Claude routes Codex-related requests in plain language — no slash command needed.

| You say | Routes to |
|---------|-----------|
| "Codex에게 이 버그 고쳐달라고 해" / "Let Codex fix the race condition" | `delegate` |
| "Codex에게 이 함수가 왜 느린지 물어봐" (read-only) | `delegate --read-only` |
| "Codex 세션 뭐 돌아가고 있어?" / "What Codex sessions are running" | `sessions` |
| "Codex 지금 거 중단해" / "Stop the Codex session" | `halt` |
| "Codex 그 결과 다시 보여줘" / "Show me that Codex output" | `readout` |
| "Codex에게 **gpt-5.6-sol로** 부탁" / "Have Codex **with gpt-5.6-sol**" | (any) `--model gpt-5.6-sol` |
| "**o1 써서** 검토" / "Ask Codex **using o1**" | (any) `--model o1` |

If the intent is ambiguous, Claude asks with an `AskUserQuestion` prompt instead of guessing.

Code review intents (`/codex-code-review:code-review`, `/codex-code-review:red-review`) only route correctly when `codex-code-review` is installed.

### Model Override

Every Codex-backed skill accepts `--model <name>`. Priority:

1. `--model <name>` CLI flag (highest)
2. `CODEX_REVIEW_MODEL` environment variable
3. Workflow default
4. Wrapper default (`gpt-5.6-terra`)

| Workflow | Default model |
|----------|---------------|
| `red-review` | `gpt-5.6-sol` |
| `code-review` | `gpt-5.6-terra` |
| regular `delegate` | `gpt-5.6-terra` |
| `delegate --read-only` | `gpt-5.6-luna` |

Before creating or resuming a thread, the wrapper checks `model/list` for the authenticated account. If a requested model is unavailable, it exits without fallback and prints the available model names. Existing sessions keep their stored model across follow-up turns.

Recognized prefixes for natural language extraction: `gpt-*`, `o1*`, `o3*`, `o4*`, `claude-*`, `gemini-*`. Selected model is stored in the thread's `state.json` and reused automatically across follow-up turns.

### A+ Delegation Pattern

`delegate` uses a **Codex = brain / Claude = hands** split:

1. Codex analyzes the task and returns a concrete change proposal (unified diff or structured JSON).
2. Claude applies the proposal with `Edit` / `Write`, runs verification, and captures the result.
3. Claude sends a `follow-up` turn with the applied-change summary. The Codex thread remembers prior context, so only the delta is transmitted.
4. Loop until Codex declares `DONE`, then `close` the thread.

This keeps file writes under Claude's tool-permission control while letting Codex drive the plan.

### Examples

```
/codex-core:delegate Fix the null pointer in UserService.login
/codex-core:delegate Refactor auth middleware to use JWT --model gpt-5.6-sol
/codex-core:delegate Why is /api/v1/users returning 500 --read-only

/codex-core:sessions            # List all sessions
/codex-core:sessions --running  # Only running
/codex-core:halt                # Pick a running session to cancel
/codex-core:halt cr_1728473812_9876
/codex-core:readout             # Pick a completed session to view
/codex-core:readout dg_1728473812_9876
```

## Plugin: codex-code-review (Optional)

Iterative and adversarial code review workflows on top of codex-core.

> **Requires** `codex-core` to be installed first.

### Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `codex-code-review.md` | `~/.claude/rules/` | Iterative code review workflow |
| `codex-red-review.md` | `~/.claude/rules/` | Adversarial (security) review workflow |

The install hook adds a separate marker block (`<!-- @codex-code-review:begin -->`) to `~/.claude/CLAUDE.md`.

### Skills

| Skill | Invocation | Description |
|-------|-----------|-------------|
| Code Review | `/codex-code-review:code-review` | Iterative multi-round code review |
| Red Review | `/codex-code-review:red-review` | Adversarial, security-focused review |

### Code Review

```
/codex-code-review:code-review                  # Current branch vs default branch
/codex-code-review:code-review PR#123           # Review a specific PR
/codex-code-review:code-review --base main      # Review against a specific base
/codex-code-review:code-review --model gpt-5.6-sol   # Override Codex model
/codex-code-review:code-review --with-opus      # Add Claude Opus cross-validation
```

### Red Review

```
/codex-code-review:red-review                   # Adversarial review of current branch
/codex-code-review:red-review PR#123            # Adversarial review of a PR
/codex-code-review:red-review --model o1        # Override Codex model
/codex-code-review:red-review --with-opus       # Add Claude Opus cross-validation
```

## Exit Codes

| Code | Meaning | Behavior |
|------|---------|----------|
| 0 | Success | Normal flow |
| 1 | codex not found | Auto-skip |
| 2 | Auth failure | Auto-skip + `codex login` guide |
| 3 | Rate limit | Auto-skip |
| 4 | Thread resume fail | Retry with new thread |
| 5 | Turn timeout (30 min safety net) | Save partial output |
| 6 | Process error | 1 retry, then skip |
| 7 | Turn still running | (status command only) |
| 8 | Turn cancelled | Save partial output |

## Upgrading from v1.x

If you previously installed `codex-review-core` or `codex-review-rules`, see [v1_README.md](./v1_README.md) for plugin renames, feature relocation, slash command changes, and migration steps.

## License

MIT © [sanghyun-io](https://github.com/sanghyun-io)
