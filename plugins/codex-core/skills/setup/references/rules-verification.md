# Claude Rule Verification

Read `~/.claude/CLAUDE.md` without modifying it. Verify these required imports:

```text
@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-delegation.md
@~/.claude/rules/codex-delegate.md
@~/.claude/rules/codex-session-ops.md
```

When `codex-code-review` is installed, also check:

```text
@~/.claude/rules/codex-code-review.md
@~/.claude/rules/codex-red-review.md
```

Report legacy `@codex-review-rules` marker blocks and recommend removing them.
If required imports are missing, show this block for manual insertion:

```text
<!-- @codex-core:begin -->
@~/.claude/rules/review-protocol.md
@~/.claude/rules/codex-delegation.md
@~/.claude/rules/codex-delegate.md
@~/.claude/rules/codex-session-ops.md
<!-- @codex-core:end -->
```

The plugin install hook owns automatic marker insertion. This setup skill only
reports state and guidance.
