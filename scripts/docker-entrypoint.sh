#!/bin/sh
set -eu

: "${PLAYWRIGHT_BROWSER_MODE:?PLAYWRIGHT_BROWSER_MODE must be set explicitly}"

if [ "$PLAYWRIGHT_BROWSER_MODE" = "headed" ]; then
  xvfb-run -a node dist/index.js "$@" &
  child_pid=$!
  trap 'kill -TERM "$child_pid" 2>/dev/null || true' INT TERM
  set +e
  wait "$child_pid"
  status=$?
  set -e
  exit "$status"
fi

exec node dist/index.js "$@"
