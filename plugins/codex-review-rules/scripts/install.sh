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
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete! ${INSTALLED_COUNT} rule file(s) installed${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}💡 Add to your CLAUDE.md to activate rules:${NC}"
echo ""
echo "   @~/.claude/rules/review-protocol.md"
echo "   @~/.claude/rules/codex-delegation.md"
echo "   @~/.claude/rules/codex-code-review.md"
echo "   @~/.claude/rules/codex-red-review.md"
echo "   @~/.claude/rules/codex-delegate.md"
echo "   @~/.claude/rules/codex-session-ops.md"
echo ""
echo -e "${YELLOW}   Tip:${NC} review-protocol + codex-delegation are the two you need"
echo -e "${YELLOW}        for the natural language router to work.${NC}"
echo -e "${YELLOW}        The other four are the individual workflows — import only${NC}"
echo -e "${YELLOW}        the ones you want active.${NC}"
echo ""
echo -e "${BLUE}📚 Next:${NC}"
echo "   /codex-review-rules:code-review   — iterative code review"
echo "   /codex-review-rules:red-review    — adversarial security review"
echo "   /codex-review-rules:delegate ...  — delegate a coding task"
echo "   /codex-review-rules:sessions      — list all Codex sessions"
echo ""
