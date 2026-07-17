#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${KB_BANK_SYNC_DIR:-/opt/kb-bank-sync}"
LOCK_FILE="${PROJECT_DIR}/.sync.lock"
COMPOSE_SERVICE="kb-sync"

cd "$PROJECT_DIR"

if [[ ! -f ".env" ]]; then
  echo ".env file not found: ${PROJECT_DIR}/.env"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is not available"
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "flock command not found"
  exit 1
fi

exec 9>"$LOCK_FILE"

if ! flock -n 9; then
  echo "Another synchronization is already running."
  exit 0
fi

docker compose run --rm "$COMPOSE_SERVICE" "$@"
