#!/usr/bin/env bash
set -u

PROJECT_DIR="${KB_BANK_SYNC_DIR:-/opt/kb-bank-sync}"
IMAGE_NAME="kb-bank-sync:0.1.0"

echo "== Timer =="
systemctl status kb-bank-sync.timer --no-pager || true

echo
echo "== Service =="
systemctl status kb-bank-sync.service --no-pager || true

echo
echo "== Schedule =="
systemctl list-timers kb-bank-sync.timer --no-pager || true

echo
echo "== Recent logs =="
journalctl -u kb-bank-sync.service -n 50 --no-pager || true

echo
echo "== Docker image =="
docker image inspect "$IMAGE_NAME" --format '{{.RepoTags}}' 2>/dev/null || echo "Image not found: $IMAGE_NAME"

echo
echo "== Compose services =="
if [[ -d "$PROJECT_DIR" ]]; then
  (cd "$PROJECT_DIR" && docker compose config --services) || true
else
  echo "Project directory not found: $PROJECT_DIR"
fi
