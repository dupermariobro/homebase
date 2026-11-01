#!/usr/bin/env bash
# Run the Homebase server with auto-restart on crash.
cd "$(dirname "$0")/.." || exit 1

PORT="${HOMEBASE_PORT:-4830}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
[ -z "$NODE_BIN" ] && [ -x /opt/homebrew/bin/node ] && NODE_BIN="/opt/homebrew/bin/node"
if [ -z "$NODE_BIN" ]; then
  echo "[$(date '+%H:%M:%S')] node not found. Set NODE_BIN or install Node.js."
  exit 127
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[$(date '+%H:%M:%S')] Port $PORT already in use; not starting a duplicate Homebase."
  exit 0
fi

if [ ! -f client/dist/index.html ]; then
  echo "[$(date '+%H:%M:%S')] client/dist missing — building client..."
  (cd client && npx vite build) || exit 1
fi

while true; do
  echo "[$(date '+%H:%M:%S')] Starting Homebase on port $PORT..."
  "$NODE_BIN" server/index.js
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%H:%M:%S')] Server exited cleanly."
    break
  fi
  echo "[$(date '+%H:%M:%S')] Server crashed (exit $EXIT_CODE). Restarting in 2s..."
  sleep 2
done
