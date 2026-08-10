# codex-app-server-plugin

> 🌐 [한국어](./README.ko.md)

A Claude Code plugin marketplace that integrates the **Codex App Server** with Claude Code. New sessions use GPT-5.6 workflow defaults, with stateful threads, model overrides, and cross-turn context reuse.

## Plugins

| Plugin | What it gives you | Required |
|--------|-------------------|:--------:|
| **codex-core** | Everything needed to use Codex from Claude Code: durable supervisor, isolated workers, hooks, natural language router, A+ task delegation (`/codex-core:delegate`), and session ops (`sessions`/`halt`/`readout`) | ✅ |
| **codex-code-review** | Iterative multi-round code review and adversarial security review workflows (`/codex-code-review:code-review`, `/codex-code-review:red-review`) | Optional |

After installing **codex-core** alone, sentences like "Codex에게 이 버그 고쳐달라고 해" or "Have Codex fix the race condition" already work — Claude routes them to the right skill automatically.

**codex-code-review** adds review-specific workflows on top: round-by-round issue tracking, deferred issue history, opt-in Opus cross-validation.

## How It Works

```
Claude Code sessions
  └─ codex-review.mjs             (compatible command client)
       └─ supervisor.mjs          (durable FIFO queue, default concurrency: 3)
            └─ job-worker.mjs     (one isolated worker per active turn)
                 └─ codex app-server (one dedicated subprocess per job)
                      └─ gpt-5.6-*   (stateful thread, model is configurable)
```

The wrapper manages thread lifecycle via three commands:
- `start` — create thread + first turn
- `follow-up` — resume thread + next turn (incremental diff only)
- `close` — clean up session state

Version 3 uses a persistent **supervisor with isolated workers**. The supervisor accepts work from multiple Claude sessions, runs three unrelated turns concurrently by default, and serializes follow-ups that share a Codex thread. Each active turn owns a dedicated `codex app-server`, so a transport or subprocess failure affects only that job. Jobs and partial output are journaled under `~/.claude/codex-runtime/v3`; a replacement supervisor recovers the queue while already-running workers continue independently. Recoverable app-server failures replay only the current turn with bounded backoff. A transient thread-resume error is retried on the same thread rather than discarded, and a follow-up resumes the session's last completed thread even when the previous turn was cancelled (e.g. via `halt`) or failed. `SessionEnd` does not cancel v3 jobs; use `cancel` or `halt` explicitly.

Each session is bound to the canonical Git project root and sends that same `cwd` to both `thread/start` and `turn/start`. Follow-ups from another project fail before reaching Codex. Progress JSON exposes connection/validation/thread/first-output/streaming phases plus prompt size, first-output latency, received characters, protocol IDs, and per-turn liveness (`pidAlive`, `idleMs`, `lastActivityAt` — the worker checkpoints every ~3s). By default there is **no turn-duration timeout**: a long, output-less reasoning phase (e.g. ultra effort) is bounded only by liveness, not a wall clock — opt into a cap with `--timeout`/`CODEX_REVIEW_TIMEOUT`. Poll status only with a foreground `status` call; the durable worker already runs detached, so codex-review commands are never backgrounded via other tooling (`reconnectCount` appears only on the legacy broker path). Prompts over 131,072 characters are preserved intact and receive a latency warning only.

The model and reasoning effort used for each call are configurable. Model priority is CLI flag > env var > workflow default > wrapper default `gpt-5.6-terra`; effort defaults to `high`:

```bash
# CLI flag
node codex-review.mjs start prompt.txt out.txt --session s1 --review-dir /tmp --model gpt-5.6-sol --effort max

# Environment variable
CODEX_REVIEW_MODEL=gpt-5.6-luna node codex-review.mjs start ...
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CODEX_REVIEW_MODEL` | Override workflow/wrapper model | unset (wrapper default: `gpt-5.6-terra`) |
| `CODEX_REVIEW_CONCURRENCY` | Maximum number of unrelated v3 jobs running at once | `3` |
| `CODEX_REVIEW_RUNTIME_DIR` | Override the durable v3 runtime directory | `~/.claude/codex-runtime/v3` |
| `CODEX_REVIEW_NO_BROKER` | Accepted for v2 compatibility; v3 never uses the shared broker | unset |
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

The runtime + universal workflows. Installs the CLI, durable supervisor, isolated worker, hook scripts, schemas, natural language router, A+ delegation, and session operations.

### Installed Files

| File | Location | Purpose |
|------|----------|---------|
| `codex-review.mjs` | `~/.claude/bin/` | JSON-RPC wrapper CLI |
| `supervisor.mjs` | `~/.claude/bin/` | Durable multi-session queue and recovery coordinator |
| `job-worker.mjs` | `~/.claude/bin/` | Isolated per-job app-server runner |
| `broker.mjs` | `~/.claude/bin/` | Upgrade compatibility for already-running v2 work |
| `lib/project-scope.mjs` | `~/.claude/bin/lib/` | Canonical project-root binding and comparison |
| `session-lifecycle.mjs` | `~/.claude/bin/` | SessionStart/SessionEnd handler (v3 durable jobs survive session exit) |
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
| `SessionEnd` | `session-lifecycle.mjs end` | Preserve v3 durable jobs and clean up only session-owned legacy workers |
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
| "Codex에게 **gpt-5.6-sol max 로** 부탁" / "Have Codex **with gpt-5.6-sol at max effort**" | (any) `--model gpt-5.6-sol --effort max` |
| "**o1 써서** 검토" / "Ask Codex **using o1**" | (any) `--model o1` |

If the intent is ambiguous, Claude asks with an `AskUserQuestion` prompt instead of guessing.

Code review intents (`/codex-code-review:code-review`, `/codex-code-review:red-review`) only route correctly when `codex-code-review` is installed.

### Model and Effort Override

Every Codex-backed skill accepts `--model <name>` and `--effort <level>`. Model priority:

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

Recognized effort values are `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Natural-language forms such as `gpt-5.6-sol max 로`, `at max effort`, and `reasoning effort ultra` become `--effort` arguments. The selected effort is reused on follow-up turns until explicitly changed.

`code-review` and `red-review` additionally accept `--tone <level>` — `easy` (non-developer), `plain` (default), `normal`, `deep` — to set how readable the reported findings are. This is distinct from `--effort` (readability vs reasoning depth): `--tone` shapes both the Codex review prompt and Claude's final Korean report (expanding acronyms like IDOR/SSRF inline at `easy`/`plain`), and is handled by Claude rather than passed to the CLI.

Recognized model prefixes for natural language extraction: `gpt-*`, `o1*`, `o3*`, `o4*`, `claude-*`, `gemini-*`. Selected model is stored in the thread's `state.json` and reused automatically across follow-up turns.

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
/codex-core:delegate Refactor auth middleware to use JWT --model gpt-5.6-sol --effort max
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
/codex-code-review:code-review --model gpt-5.6-sol --effort max   # Override Codex model/effort
/codex-code-review:code-review --with-opus      # Add Claude Opus cross-validation
```

### Red Review

```
/codex-code-review:red-review                   # Adversarial review of current branch
/codex-code-review:red-review PR#123            # Adversarial review of a PR
/codex-code-review:red-review --model gpt-5.6-sol --effort ultra  # Override Codex model/effort
/codex-code-review:red-review --with-opus       # Add Claude Opus cross-validation
```

## Exit Codes

| Code | Meaning | Behavior |
|------|---------|----------|
| 0 | Success | Normal flow |
| 1 | codex not found | Auto-skip |
| 2 | Auth failure | Auto-skip + `codex login` guide |
| 3 | Rate limit | Auto-skip |
| 4 | No resumable completed turn (rollout not persisted) | Re-poll status (transient errors auto-retry the same thread); start a new thread only if no turn ever completed |
| 5 | Turn timeout (only when `--timeout` / `CODEX_REVIEW_TIMEOUT` is set) | Save partial output |
| 6 | Process error | 1 retry, then skip |
| 7 | Turn still running | (status command only) |
| 8 | Turn cancelled | Save partial output |

## Upgrading from v1.x

If you previously installed `codex-review-core` or `codex-review-rules`, see [v1_README.md](./v1_README.md) for plugin renames, feature relocation, slash command changes, and migration steps.

## License

MIT © [sanghyun-io](https://github.com/sanghyun-io)
