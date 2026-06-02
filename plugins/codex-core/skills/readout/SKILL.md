---
name: readout
description: Display the output and metadata (model, turn count, internal thread ID, status) of a completed Codex session. Works for code-review, delegate, and red-review sessions.
argument-hint: "[<session-id>]"
invocation:
  command: readout
  user_invocable: true
---

# Readout

Fetch and display the output of a completed Codex session (completed, cancelled, or timeout_partial), together with its metadata. The `threadId` shown is the App Server's internal thread identifier, not a resumable session UUID for the interactive `codex` CLI — use the same Claude skill again to follow up on the thread.

Follow the workflow defined in `~/.claude/rules/codex-session-ops.md` (section: **결과 조회**).

## Arguments

- `(no args)` — List completed sessions and ask which to display
- `<session-id>` — Display a specific session (e.g., `dg_1728473812_9876`)

## Execution

$ARGUMENTS

If the rules file is not yet active, ensure it is imported in `~/.claude/CLAUDE.md`.
Run `/codex-core:setup` if you haven't configured the plugin yet.

## Reporting to the User (Plain Language)

When you display the session result to the user, use plain, easy words — not hard technical terms. Do NOT use metaphors or analogies; just say the same thing in simpler words. And do NOT compress everything into one short line — explain enough that the user understands what this session did.

- Start with a plain summary, in a few sentences, of what this session actually found or did, then show the full output.
- Do NOT surface mechanism words like Thread, threadId, exit code, polling, JSON-RPC, or App Server as the main message. The internal thread ID may appear as an optional reference line, clearly labeled "내부 식별자 (참고용)", not as something the user must act on.
- Explain the metadata in plain words: which kind of task it was, which model, how many back-and-forth rounds happened, and whether it finished normally or was stopped partway.
- Always write the summary to the user in Korean.
