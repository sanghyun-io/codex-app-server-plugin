#!/bin/bash
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  codex-code-review - Installation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# Install rules → ~/.claude/rules/  (codex-code-review, codex-red-review)
RULES_DIR="$HOME/.claude/rules"
mkdir -p "$RULES_DIR"

INSTALLED_COUNT=0
for rule_file in "$PLUGIN_ROOT/rules"/*.md; do
  if [ -f "$rule_file" ]; then
    filename=$(basename "$rule_file")
    if [ -f "$RULES_DIR/$filename" ]; then
      echo -e "${YELLOW}⚠️  ${filename} already exists, overwriting...${NC}"
    fi
    cp "$rule_file" "$RULES_DIR/"
    echo -e "✓ Installed ${GREEN}${filename}${NC}"
    INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
  fi
done

echo ""

# Seed the persistent tone config if absent (preserve an existing user setting)
TONE_CONFIG="$HOME/.claude/codex-review.config.json"
if [ -f "$TONE_CONFIG" ]; then
  echo -e "${YELLOW}⚠️  codex-review.config.json exists — preserving your defaultTone${NC}"
else
  printf '{\n  "defaultTone": "plain"\n}\n' > "$TONE_CONFIG"
  echo -e "✓ Seeded ${GREEN}~/.claude/codex-review.config.json${NC} (defaultTone: plain)"
fi

echo ""

# Auto-activate: append @imports to ~/.claude/CLAUDE.md
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
MARKER_BEGIN="<!-- @codex-code-review:begin -->"
MARKER_END="<!-- @codex-code-review:end -->"

mkdir -p "$HOME/.claude"

if [ -f "$CLAUDE_MD" ] && grep -qF "$MARKER_BEGIN" "$CLAUDE_MD"; then
  echo -e "${YELLOW}⚠️  CLAUDE.md already contains codex-code-review block, skipping activation${NC}"
else
  if [ -f "$CLAUDE_MD" ] && [ ! -f "$CLAUDE_MD.bak" ]; then
    cp "$CLAUDE_MD" "$CLAUDE_MD.bak"
    echo -e "✓ Backed up existing CLAUDE.md → ${GREEN}CLAUDE.md.bak${NC}"
  elif [ ! -f "$CLAUDE_MD" ]; then
    touch "$CLAUDE_MD"
  fi

  {
    echo ""
    echo "$MARKER_BEGIN"
    echo "@~/.claude/rules/codex-code-review.md"
    echo "@~/.claude/rules/codex-red-review.md"
    echo "$MARKER_END"
  } >> "$CLAUDE_MD"

  echo -e "✓ Activated code-review workflows in ${GREEN}~/.claude/CLAUDE.md${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete! ${INSTALLED_COUNT} rule file(s) installed${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📚 Next:${NC}"
echo "   /codex-code-review:code-review   — iterative code review"
echo "   /codex-code-review:red-review    — adversarial security review"
echo ""
echo -e "${YELLOW}💡 Requires codex-core (the runtime + delegate + session ops)${NC}"
echo ""
