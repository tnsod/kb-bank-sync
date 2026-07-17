#!/bin/zsh
set -euo pipefail

LABEL="com.kb-bank-sync.daily"
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE"
else
  print -r -- "LaunchAgent is not loaded: $LABEL"
fi

if [[ -e "$TARGET" ]]; then
  rm -f "$TARGET"
  print -r -- "LaunchAgent file removed: $TARGET"
else
  print -r -- "LaunchAgent file does not exist: $TARGET"
fi
