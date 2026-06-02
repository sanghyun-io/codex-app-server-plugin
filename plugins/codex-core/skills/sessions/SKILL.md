---
name: sessions
description: List all Codex sessions (running, completed, cancelled) across all skills (code-review, delegate, red-review). Shows session ID, elapsed time, model, and status in a grouped table.
argument-hint: "[--running | --completed]"
invocation:
  command: sessions
  user_invocable: true
---

# Sessions

List every Codex session in `~/.claude/tmp/`, grouped by skill prefix and status.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **세션 현황 조회**).

## Arguments

- `(no args)` — Show all sessions (running + completed)
- `--running` — Show only running sessions
- `--completed` — Show only completed/cancelled/failed sessions

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Plain Language)

When you show the session list to the user, use plain, easy words — not hard technical terms. Do NOT use metaphors or analogies; just say the same thing in simpler words.

- Translate raw status values into plain words: `running` → "진행 중", `completed` → "끝남", `cancelled` → "중단됨", `failed`/`crashed` → "실패함".
- Keep the table for reference, but above it write a plain summary in a sentence or two: how many tasks are running now, how many finished, and whether any look stuck — so the user gets the picture without reading every column.
- Do NOT surface mechanism words like Thread, threadId, exit code, polling, JSON-RPC, or App Server in the user-facing summary at all. Session IDs and prefixes (`cr_`/`dg_`/`rr_`) may stay in the table since the user needs them to act, but explain in plain words what each kind of task is ("cr_로 시작하는 건 코드 검토 작업이에요").
- Always write the summary to the user in Korean.
