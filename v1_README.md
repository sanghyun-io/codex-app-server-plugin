# Migration from v1.x to v2.x

> This document is for users upgrading from `codex-review-core` / `codex-review-rules` (v1.x) to `codex-core` / `codex-code-review` (v2.x).
>
> If you are starting fresh, see the main [README.md](./README.md) — you do not need this document.

## What changed in v2.0

v2.0.0 renamed both plugins and reorganized which plugin owns which features. The natural language router, A+ delegation, and session ops moved from the rules plugin into the core plugin, so **installing core alone is now enough** to use Codex from Claude Code.

### Name changes

| v1.x | v2.x |
|------|------|
| `codex-review-core` | **`codex-core`** |
| `codex-review-rules` | **`codex-code-review`** |

### Feature relocation

| File / Skill | v1.x location | v2.x location |
|--------------|---------------|---------------|
| `review-protocol.md` | rules | **core** |
| `codex-delegation.md` | rules | **core** |
| `codex-delegate.md` | rules | **core** |
| `codex-session-ops.md` | rules | **core** |
| `delegate`, `sessions`, `halt`, `readout` skills | rules | **core** |
| `codex-code-review.md` | rules | code-review |
| `codex-red-review.md` | rules | code-review |
| `code-review`, `red-review` skills | rules | code-review |

### Slash command changes

| v1.x | v2.x |
|------|------|
| `/codex-review-core:setup` | `/codex-core:setup` |
| `/codex-review-rules:delegate` | `/codex-core:delegate` |
| `/codex-review-rules:sessions` | `/codex-core:sessions` |
| `/codex-review-rules:halt` | `/codex-core:halt` |
| `/codex-review-rules:readout` | `/codex-core:readout` |
| `/codex-review-rules:code-review` | `/codex-code-review:code-review` |
| `/codex-review-rules:red-review` | `/codex-code-review:red-review` |

## Migration steps

```bash
# 1. Update marketplace
/plugin marketplace update sanghyun-io

# 2. Uninstall old plugins
/plugin uninstall codex-review-core@sanghyun-io
/plugin uninstall codex-review-rules@sanghyun-io

# 3. Install v2 plugins
/plugin install codex-core@sanghyun-io
/plugin install codex-code-review@sanghyun-io   # optional, only if you want code-review workflows

# 4. Verify
/codex-core:setup
```

## CLAUDE.md handling

The `codex-core` install hook automatically removes the legacy `<!-- @codex-review-rules:begin -->...<!-- @codex-review-rules:end -->` block from `~/.claude/CLAUDE.md` and replaces it with the new `<!-- @codex-core:begin -->...` block. Your existing `CLAUDE.md` is backed up to `CLAUDE.md.bak` before any change.

Files in `~/.claude/rules/` keep their names — no rename happens at the file level.
