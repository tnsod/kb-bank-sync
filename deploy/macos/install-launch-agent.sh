#!/bin/zsh
set -euo pipefail

force=false
if (( $# > 1 )); then
  print -u2 -- "Usage: $0 [--force]"
  exit 2
fi
if (( $# == 1 )); then
  if [[ "$1" != "--force" ]]; then
    print -u2 -- "Usage: $0 [--force]"
    exit 2
  fi
  force=true
fi

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${KB_BANK_SYNC_DIR:-${SCRIPT_DIR:h:h}}"
TEMPLATE="${SCRIPT_DIR}/com.kb-bank-sync.daily.plist.template"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET="${TARGET_DIR}/com.kb-bank-sync.daily.plist"
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/com.kb-bank-sync.daily"

if [[ ! -f "$TEMPLATE" || ! -x "${SCRIPT_DIR}/run-sync.sh" ]]; then
  print -u2 -- "LaunchAgent template or executable runner is missing"
  exit 1
fi

if launchctl print "$SERVICE" >/dev/null 2>&1 && [[ "$force" != true ]]; then
  print -u2 -- "LaunchAgent is already loaded. Use --force to replace it."
  exit 1
fi
if [[ -e "$TARGET" && "$force" != true ]]; then
  print -u2 -- "LaunchAgent file already exists. Use --force to replace it: $TARGET"
  exit 1
fi

mkdir -p "$TARGET_DIR" "${HOME}/Library/Logs"
temporary="$(mktemp "${TMPDIR:-/tmp}/kb-bank-sync-launchd.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

escape_xml_sed() {
  print -r -- "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/[|\\]/\\&/g' \
    -e 's/&/\\&/g'
}

project_escaped="$(escape_xml_sed "$PROJECT_DIR")"
home_escaped="$(escape_xml_sed "$HOME")"
sed -e "s|__PROJECT_DIR__|${project_escaped}|g" -e "s|__HOME_DIR__|${home_escaped}|g" "$TEMPLATE" > "$temporary"
plutil -lint "$temporary" >/dev/null

if [[ "$force" == true ]]; then
  launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
fi
mv "$temporary" "$TARGET"
trap - EXIT

launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$SERVICE"
print -r -- "LaunchAgent installed without running the synchronization: $TARGET"
