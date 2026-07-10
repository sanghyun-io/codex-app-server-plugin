#!/bin/bash
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  codex-core - Installation${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# 1. Runtime files → ~/.claude/bin/
BIN_DIR="$HOME/.claude/bin"
mkdir -p "$BIN_DIR/lib"

if [ -f "$BIN_DIR/codex-review.mjs" ]; then
  echo -e "${YELLOW}⚠️  codex-review.mjs already exists, overwriting...${NC}"
fi
cp "$PLUGIN_ROOT/bin/codex-review.mjs" "$BIN_DIR/"
chmod +x "$BIN_DIR/codex-review.mjs"
echo -e "✓ Installed ${GREEN}~/.claude/bin/codex-review.mjs${NC}"

if [ -f "$PLUGIN_ROOT/bin/broker.mjs" ]; then
  cp "$PLUGIN_ROOT/bin/broker.mjs" "$BIN_DIR/"
  chmod +x "$BIN_DIR/broker.mjs"
  echo -e "✓ Installed ${GREEN}~/.claude/bin/broker.mjs${NC}"
fi

if [ -f "$PLUGIN_ROOT/bin/lib/project-scope.mjs" ]; then
  cp "$PLUGIN_ROOT/bin/lib/project-scope.mjs" "$BIN_DIR/lib/"
  test -f "$BIN_DIR/lib/project-scope.mjs"
  echo -e "✓ Installed ${GREEN}~/.claude/bin/lib/project-scope.mjs${NC}"
fi

# 2. schemas → ~/.claude/schemas/
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

# 3. lifecycle scripts → ~/.claude/bin/
for script_file in session-lifecycle.mjs stop-gate.mjs; do
  if [ -f "$PLUGIN_ROOT/scripts/$script_file" ]; then
    cp "$PLUGIN_ROOT/scripts/$script_file" "$BIN_DIR/"
    chmod +x "$BIN_DIR/$script_file"
    echo -e "✓ Installed ${GREEN}~/.claude/bin/${script_file}${NC}"
  fi
done

# 4. rules → ~/.claude/rules/  (review-protocol, codex-delegation, codex-delegate, codex-session-ops)
RULES_DIR="$HOME/.claude/rules"
mkdir -p "$RULES_DIR"
RULES_INSTALLED=0
if [ -d "$PLUGIN_ROOT/rules" ]; then
  for rule_file in "$PLUGIN_ROOT/rules"/*.md; do
    if [ -f "$rule_file" ]; then
      filename=$(basename "$rule_file")
      if [ -f "$RULES_DIR/$filename" ]; then
        echo -e "${YELLOW}⚠️  ${filename} already exists, overwriting...${NC}"
      fi
      cp "$rule_file" "$RULES_DIR/"
      echo -e "✓ Installed ${GREEN}~/.claude/rules/${filename}${NC}"
      RULES_INSTALLED=$((RULES_INSTALLED + 1))
    fi
  done
fi

echo ""

# 5. CLAUDE.md auto-activation: clean up legacy markers + insert new ones
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
NEW_BEGIN="<!-- @codex-core:begin -->"
NEW_END="<!-- @codex-core:end -->"
LEGACY_BEGIN="<!-- @codex-review-rules:begin -->"
LEGACY_END="<!-- @codex-review-rules:end -->"

mkdir -p "$HOME/.claude"

# 5a. Remove legacy v1.x marker block if present (auto-migration)
if [ -f "$CLAUDE_MD" ] && grep -qF "$LEGACY_BEGIN" "$CLAUDE_MD"; then
  cp "$CLAUDE_MD" "$CLAUDE_MD.bak"
  awk -v b="$LEGACY_BEGIN" -v e="$LEGACY_END" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip { print }
  ' "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
  echo -e "✓ Removed legacy ${YELLOW}codex-review-rules${NC} marker block from CLAUDE.md (backup: CLAUDE.md.bak)"
fi

# 5b. Insert new marker block (idempotent)
if [ -f "$CLAUDE_MD" ] && grep -qF "$NEW_BEGIN" "$CLAUDE_MD"; then
  echo -e "${YELLOW}⚠️  CLAUDE.md already contains codex-core block, skipping activation${NC}"
else
  if [ ! -f "$CLAUDE_MD" ]; then
    touch "$CLAUDE_MD"
  elif [ ! -f "$CLAUDE_MD.bak" ]; then
    cp "$CLAUDE_MD" "$CLAUDE_MD.bak"
    echo -e "✓ Backed up existing CLAUDE.md → ${GREEN}CLAUDE.md.bak${NC}"
  fi

  {
    echo ""
    echo "$NEW_BEGIN"
    echo "@~/.claude/rules/review-protocol.md"
    echo "@~/.claude/rules/codex-delegation.md"
    echo "@~/.claude/rules/codex-delegate.md"
    echo "@~/.claude/rules/codex-session-ops.md"
    echo "$NEW_END"
  } >> "$CLAUDE_MD"

  echo -e "✓ Activated codex-core rules in ${GREEN}~/.claude/CLAUDE.md${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ codex-core installation complete (${RULES_INSTALLED} rule file(s))${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📚 Next:${NC}"
echo "   /codex-core:setup            — verify prerequisites (Node, codex CLI, auth)"
echo "   /codex-core:delegate ...     — A+ task delegation (Codex proposes, Claude applies)"
echo "   /codex-core:sessions         — list all Codex sessions"
echo "   /codex-core:halt             — cancel a running session"
echo "   /codex-core:readout          — view a completed session's output"
echo ""
echo -e "${BLUE}💬 Natural language also works:${NC}"
echo "   \"Codex에게 이 버그 고쳐달라고 해\""
echo "   \"Codex로 gpt-5.6-sol 써서 검토 부탁\""
echo ""
echo -e "${BLUE}💡 Optional: install codex-code-review for iterative/adversarial code review workflows${NC}"
echo ""
