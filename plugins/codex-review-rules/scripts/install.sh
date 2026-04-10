#!/bin/bash
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  codex-review-rules - Installation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# Install rules → ~/.claude/rules/
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

# Auto-activate: append @imports to ~/.claude/CLAUDE.md
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
MARKER_BEGIN="<!-- @codex-review-rules:begin -->"
MARKER_END="<!-- @codex-review-rules:end -->"

mkdir -p "$HOME/.claude"

if [ -f "$CLAUDE_MD" ] && grep -qF "$MARKER_BEGIN" "$CLAUDE_MD"; then
  echo -e "${YELLOW}⚠️  CLAUDE.md already contains codex-review-rules block, skipping activation${NC}"
else
  if [ -f "$CLAUDE_MD" ]; then
    cp "$CLAUDE_MD" "$CLAUDE_MD.bak"
    echo -e "✓ Backed up existing CLAUDE.md → ${GREEN}CLAUDE.md.bak${NC}"
  else
    touch "$CLAUDE_MD"
  fi

  {
    echo ""
    echo "$MARKER_BEGIN"
    echo "@~/.claude/rules/review-protocol.md"
    echo "@~/.claude/rules/codex-delegation.md"
    echo "@~/.claude/rules/codex-code-review.md"
    echo "@~/.claude/rules/codex-red-review.md"
    echo "@~/.claude/rules/codex-delegate.md"
    echo "@~/.claude/rules/codex-session-ops.md"
    echo "$MARKER_END"
  } >> "$CLAUDE_MD"

  echo -e "✓ Activated rules in ${GREEN}~/.claude/CLAUDE.md${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete! ${INSTALLED_COUNT} rule file(s) installed${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📚 Next:${NC}"
echo "   /codex-review-rules:code-review   — iterative code review"
echo "   /codex-review-rules:red-review    — adversarial security review"
echo "   /codex-review-rules:delegate ...  — delegate a coding task"
echo "   /codex-review-rules:sessions      — list all Codex sessions"
echo ""
echo -e "${YELLOW}💡 Rules are auto-activated via markers in ~/.claude/CLAUDE.md${NC}"
echo -e "${YELLOW}   To deactivate: remove the codex-review-rules block or run uninstall${NC}"
echo ""
