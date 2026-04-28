#!/bin/bash
# Wrapper that makes fake-codex.mjs behave as `codex app-server`.
# Usage: put this script's directory first in PATH so `codex` resolves here.
if [ "$1" = "app-server" ]; then
  exec node "$(dirname "$0")/fake-codex.mjs"
else
  echo "fake-codex: unknown command: $*" >&2
  exit 1
fi
