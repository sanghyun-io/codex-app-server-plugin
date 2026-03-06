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

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📚 Next: Run /codex-review-core:setup to verify prerequisites${NC}"
echo -e "${BLUE}💡 Optional: Install codex-review-rules for review workflow rules${NC}"
echo ""
