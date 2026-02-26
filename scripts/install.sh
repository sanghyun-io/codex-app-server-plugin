#!/bin/bash
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Codex App Server Plugin - Installation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# 1. Install bin/codex-review.mjs → ~/.claude/bin/
BIN_DIR="$HOME/.claude/bin"
mkdir -p "$BIN_DIR"

if [ -f "$BIN_DIR/codex-review.mjs" ]; then
  echo -e "${YELLOW}⚠️  codex-review.mjs already exists, overwriting...${NC}"
fi

cp "$PLUGIN_ROOT/bin/codex-review.mjs" "$BIN_DIR/"
chmod +x "$BIN_DIR/codex-review.mjs"
echo -e "✓ Installed ${GREEN}~/.claude/bin/codex-review.mjs${NC}"

# 2. Install rules → ~/.claude/rules/
RULES_DIR="$HOME/.claude/rules"
mkdir -p "$RULES_DIR"

INSTALLED_COUNT=0
for rule_file in "$PLUGIN_ROOT/rules"/*.md; do
  if [ -f "$rule_file" ]; then
    filename=$(basename "$rule_file")
    if [ -f "$RULES_DIR/$filename" ]; then
      echo -e "${YELLOW}⚠️  ${filename} already exists, skipping...${NC}"
    else
      cp "$rule_file" "$RULES_DIR/"
      echo -e "✓ Installed ${GREEN}${filename}${NC}"
      INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
    fi
  fi
done

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete! ${INSTALLED_COUNT} rule file(s) installed${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}💡 Add to your CLAUDE.md to activate rules:${NC}"
echo ""
echo "   @~/.claude/rules/review-protocol.md"
echo "   @~/.claude/rules/codex-plan-validation.md"
echo "   @~/.claude/rules/codex-code-review.md"
echo ""
echo -e "${BLUE}📚 Next: Run /codex-app-server-plugin:setup to verify prerequisites${NC}"
echo ""
