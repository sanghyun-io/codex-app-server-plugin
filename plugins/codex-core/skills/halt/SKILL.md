---
name: halt
description: Cancel a running Codex session. If multiple sessions are running, asks which one to halt. Preserves partial output files and thread state for later inspection or resume.
argument-hint: "[<session-id> | --all]"
invocation:
  command: halt
  user_invocable: true
---

# Halt

Cancel one or more running Codex sessions. Wraps `codex-review cancel` with session discovery and user selection.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **세션 중단**).

## Arguments

- `(no args)` — List running sessions and ask which to cancel
- `<session-id>` — Cancel a specific session (e.g., `cr_1728473812_9876`)
- `--all` — Cancel every running session (requires explicit confirmation)

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Plain Language)

When you confirm the cancellation back to the user, use plain, easy words — not hard technical terms. Do NOT use metaphors or analogies; just say the same thing in simpler words.

- Say plainly what was stopped and whether any partial result was kept, in a sentence or two ("진행하던 작업을 멈췄어요. 중간까지 나온 내용은 지우지 않고 남겨뒀습니다").
- Do NOT surface mechanism words like Thread, threadId, exit code, polling, JSON-RPC, App Server, or state-file names in the user-facing summary at all.
- If a partial result exists, tell the user in plain words that they can look at it later and which command to use — do not just paste file paths as the main message.
- Always write the confirmation to the user in Korean.
