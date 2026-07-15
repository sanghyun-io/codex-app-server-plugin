---
name: setup
description: Use when installing, updating, repairing, or verifying codex-core and the optional codex-code-review plugin.
invocation:
  command: setup
  user_invocable: true
---

# codex-core Setup

Verify the installed runtime, Node.js, Codex CLI, authentication, and Claude
rules in order. Stop on a missing required prerequisite; `codex-code-review` is
optional.

## 1. Runtime Files

Read [references/runtime-files.md](references/runtime-files.md) and perform its
check workflow. The v3 installation is incomplete unless these files match the
active plugin cache:

- `codex-review.mjs`, `supervisor.mjs`, and `job-worker.mjs`
- every `bin/lib/*.mjs` runtime module
- `session-lifecycle.mjs` and `stop-gate.mjs`
- schemas and core rules

Ask before replacing a file that differs. Missing files may be installed
immediately from the active cache.

## 2. Node.js

Run:

```bash
node --version
which node 2>/dev/null || where.exe node 2>/dev/null
```

Require Node.js 18 or newer. In WSL, reject a Node executable under `/mnt/` and
ask the user to install a Linux-native Node.js runtime.

## 3. Codex CLI

Run:

```bash
codex --version
which codex 2>/dev/null || where.exe codex 2>/dev/null
```

If Codex is unavailable, read
[references/codex-prerequisites.md](references/codex-prerequisites.md) for the
bounded discovery and installation workflow. Never invent an executable path.

## 4. Authentication

Ask whether the user is already logged in. If not, instruct them to run:

```bash
BROWSER=/bin/false codex login
```

Stop until authentication is complete.

## 5. Claude Rules

Read [references/rules-verification.md](references/rules-verification.md). This
step is read-only: never edit `~/.claude/CLAUDE.md` from this skill.

## 6. Completion

Report a compact checklist including:

```text
✓ ~/.claude/bin/codex-review.mjs
✓ ~/.claude/bin/supervisor.mjs
✓ ~/.claude/bin/job-worker.mjs
✓ ~/.claude/bin/lib/*.mjs
✓ ~/.claude/bin/session-lifecycle.mjs
✓ ~/.claude/bin/stop-gate.mjs
✓ ~/.claude/schemas/review-output.schema.json
✓ ~/.claude/rules/*.md
```

State that v3 uses a durable supervisor, runs three unrelated jobs concurrently
by default, isolates each job in its own app-server, and preserves jobs across
Claude `SessionEnd`. Mention `CODEX_REVIEW_CONCURRENCY` and
`CODEX_REVIEW_RUNTIME_DIR` as the supported runtime controls.

## References

- [references/runtime-files.md](references/runtime-files.md) — read when
  checking, comparing, or repairing installed plugin files.
- [references/codex-prerequisites.md](references/codex-prerequisites.md) — read
  when the Codex executable is missing, unusable, or comes from the wrong OS.
- [references/rules-verification.md](references/rules-verification.md) — read
  when checking Claude rule imports or legacy marker blocks.
