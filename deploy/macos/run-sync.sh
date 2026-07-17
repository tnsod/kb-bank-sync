#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
DEFAULT_PROJECT_DIR="${SCRIPT_DIR:h:h}"
PROJECT_DIR="${KB_BANK_SYNC_DIR:-$DEFAULT_PROJECT_DIR}"
LOCK_DIR="${PROJECT_DIR}/.sync-lock"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/macos-scheduler.log"
export PATH="/Applications/Docker.app/Contents/Resources/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

mkdir -p "$LOG_DIR"

log_event() {
  local event="$1"
  local exit_code="$2"
  print -r -- "$(date -u '+%Y-%m-%dT%H:%M:%SZ') event=${event} exitCode=${exit_code}" >> "$LOG_FILE"
}

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log_event "skipped_already_running" 0
  exit 0
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$PROJECT_DIR"

if [[ ! -f ".env" ]]; then
  log_event "failed" 1
  print -u2 -- ".env file not found: ${PROJECT_DIR}/.env"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  log_event "failed" 1
  print -u2 -- "docker command not found"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  log_event "failed" 1
  print -u2 -- "docker compose is not available"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  log_event "failed" 1
  print -u2 -- "Docker Desktop is not running or the Docker engine is unavailable"
  exit 1
fi

log_event "started" 0
set +e
docker compose run --rm kb-sync
exit_code=$?
set -e

if (( exit_code == 0 )); then
  log_event "succeeded" 0
else
  log_event "failed" "$exit_code"
fi

exit "$exit_code"
