# Runtime File Verification

Locate the active plugin cache without assuming a version:

```bash
CORE_ROOT=$(find ~/.claude/plugins/cache/sanghyun-io/codex-core -type d -name bin 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
REVIEW_ROOT=$(find ~/.claude/plugins/cache/sanghyun-io/codex-code-review -type d -name rules 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
echo "CORE_ROOT=$CORE_ROOT"
echo "REVIEW_ROOT=$REVIEW_ROOT"
```

If `CORE_ROOT` is empty, stop and recommend reinstalling
`codex-core@sanghyun-io`. An empty `REVIEW_ROOT` is valid.

Run the deterministic checker:

```bash
bash "$CORE_ROOT/skills/setup/scripts/sync-runtime.sh" check "$CORE_ROOT" "$REVIEW_ROOT"
```

Interpret output as follows:

| Status | Action |
|---|---|
| `MATCH` | Continue |
| `MISSING` | Install from cache |
| `DIFFER` | Ask before replacing |

If installation or an approved update is required, run:

```bash
bash "$CORE_ROOT/skills/setup/scripts/sync-runtime.sh" install "$CORE_ROOT" "$REVIEW_ROOT"
```

The script covers the v3 command client, supervisor, job worker, every runtime
library, lifecycle scripts, schemas, and rules. It also copies optional
code-review rules when that plugin is installed.

If Bash is unavailable, report that automatic verification is blocked and ask
the user to compare the same files manually. Do not claim the setup is complete.
