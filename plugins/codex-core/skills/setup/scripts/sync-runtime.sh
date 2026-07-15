#!/bin/bash
set -euo pipefail

MODE=${1:-check}
CORE_ROOT=${2:-}
REVIEW_ROOT=${3:-}

if [ -z "$CORE_ROOT" ] || [ ! -d "$CORE_ROOT" ]; then
  echo "ERROR: codex-core cache root not found" >&2
  exit 1
fi
if [ "$MODE" != check ] && [ "$MODE" != install ]; then
  echo "Usage: sync-runtime.sh <check|install> <core-root> [review-root]" >&2
  exit 2
fi

BIN_DIR="$HOME/.claude/bin"
SCHEMA_DIR="$HOME/.claude/schemas"
RULES_DIR="$HOME/.claude/rules"

sync_file() {
  local src=$1
  local dest=$2
  [ -f "$src" ] || return 0
  if [ "$MODE" = install ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    case "$dest" in "$BIN_DIR"/*) chmod +x "$dest" 2>/dev/null || true;; esac
    echo "INSTALLED: ${dest#$HOME/}"
  elif [ ! -f "$dest" ]; then
    echo "MISSING: ${dest#$HOME/}"
  elif diff -q "$src" "$dest" >/dev/null 2>&1; then
    echo "MATCH: ${dest#$HOME/}"
  else
    echo "DIFFER: ${dest#$HOME/}"
  fi
}

for name in codex-review.mjs supervisor.mjs job-worker.mjs broker.mjs; do
  sync_file "$CORE_ROOT/bin/$name" "$BIN_DIR/$name"
done
for src in "$CORE_ROOT/bin/lib"/*.mjs; do
  [ -f "$src" ] && sync_file "$src" "$BIN_DIR/lib/$(basename "$src")"
done
for name in session-lifecycle.mjs stop-gate.mjs; do
  sync_file "$CORE_ROOT/scripts/$name" "$BIN_DIR/$name"
done
sync_file "$CORE_ROOT/schemas/review-output.schema.json" "$SCHEMA_DIR/review-output.schema.json"
for src in "$CORE_ROOT/rules"/*.md; do
  [ -f "$src" ] && sync_file "$src" "$RULES_DIR/$(basename "$src")"
done
if [ -n "$REVIEW_ROOT" ] && [ -d "$REVIEW_ROOT/rules" ]; then
  for src in "$REVIEW_ROOT/rules"/*.md; do
    [ -f "$src" ] && sync_file "$src" "$RULES_DIR/$(basename "$src")"
  done
fi
