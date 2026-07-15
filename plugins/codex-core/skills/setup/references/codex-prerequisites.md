# Codex CLI Discovery

Do not guess undocumented Codex application paths. Check executable candidates
and accept only a file that successfully runs `--version`.

```bash
FOUND=""

if [ "$(uname)" = "Darwin" ]; then
  APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.openai.codex'" 2>/dev/null | head -1)
  [ -z "$APP" ] && APP=$(mdfind -name Codex.app 2>/dev/null | grep -i '/Codex.app$' | head -1)
  [ -n "$APP" ] && FOUND=$(find "$APP" -type f \( -name codex -o -name 'codex-*-apple-darwin' \) -perm -u+x 2>/dev/null | head -1)
fi

if [ -z "$FOUND" ]; then
  for candidate in \
    "$HOME/.codex/bin/codex" \
    "$HOME/.local/bin/codex" \
    /opt/homebrew/bin/codex \
    /usr/local/bin/codex \
    /opt/codex/bin/codex \
    /opt/codex/codex; do
    if [ -x "$candidate" ]; then FOUND="$candidate"; break; fi
  done
fi

if [ -z "$FOUND" ] && command -v where.exe >/dev/null 2>&1; then
  candidate=$(where.exe codex.exe 2>/dev/null | head -1 | tr -d '\r')
  [ -n "$candidate" ] && [ -f "$candidate" ] && FOUND="$candidate"
fi

if [ -n "$FOUND" ] && "$FOUND" --version >/dev/null 2>&1; then
  echo "RUNNABLE: $FOUND"
else
  echo "RUNNABLE: none"
fi
```

For a runnable binary, link or copy it into `~/.claude/bin/codex`, then verify
that installed path with `--version`. If nothing is found, offer
`npm install -g @openai/codex@latest` or let the user install manually.

In WSL, a path under `/mnt/` is a Windows executable and is not a valid
Linux-native installation. Ask the user to install Node.js and Codex inside WSL.
