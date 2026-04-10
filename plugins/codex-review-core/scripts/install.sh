#!/bin/bash
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  codex-review-core - Installation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# Install bin/codex-review.mjs → ~/.claude/bin/
BIN_DIR="$HOME/.claude/bin"
mkdir -p "$BIN_DIR"

if [ -f "$BIN_DIR/codex-review.mjs" ]; then
  echo -e "${YELLOW}⚠️  codex-review.mjs already exists, overwriting...${NC}"
fi

cp "$PLUGIN_ROOT/bin/codex-review.mjs" "$BIN_DIR/"
chmod +x "$BIN_DIR/codex-review.mjs"
echo -e "✓ Installed ${GREEN}~/.claude/bin/codex-review.mjs${NC}"

# Install bin/broker.mjs → ~/.claude/bin/
if [ -f "$PLUGIN_ROOT/bin/broker.mjs" ]; then
  cp "$PLUGIN_ROOT/bin/broker.mjs" "$BIN_DIR/"
  chmod +x "$BIN_DIR/broker.mjs"
  echo -e "✓ Installed ${GREEN}~/.claude/bin/broker.mjs${NC}"
fi

# Install schemas → ~/.claude/schemas/
SCHEMA_DIR="$HOME/.claude/schemas"
mkdir -p "$SCHEMA_DIR"
if [ -d "$PLUGIN_ROOT/schemas" ]; then
  for schema_file in "$PLUGIN_ROOT/schemas"/*.json; do
    if [ -f "$schema_file" ]; then
      filename=$(basename "$schema_file")
      cp "$schema_file" "$SCHEMA_DIR/"
      echo -e "✓ Installed ${GREEN}~/.claude/schemas/${filename}${NC}"
    fi
  done
fi

# Install scripts → ~/.claude/bin/ (lifecycle hooks)
for script_file in session-lifecycle.mjs stop-gate.mjs; do
  if [ -f "$PLUGIN_ROOT/scripts/$script_file" ]; then
    cp "$PLUGIN_ROOT/scripts/$script_file" "$BIN_DIR/"
    chmod +x "$BIN_DIR/$script_file"
    echo -e "✓ Installed ${GREEN}~/.claude/bin/${script_file}${NC}"
  fi
done

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📚 Next: Run /codex-review-core:setup to verify prerequisites${NC}"
echo -e "${BLUE}💡 Optional: Install codex-review-rules for review workflow rules${NC}"
echo ""
