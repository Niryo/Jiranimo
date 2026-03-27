#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"
EXTENSION_DIR="$PROJECT_ROOT/extension"

# Check for --self flag: operate on this repo instead of gitPlaygrounds
JIRANIMO_SELF=""
for arg in "$@"; do
  if [ "$arg" = "--self" ]; then
    JIRANIMO_SELF=1
    break
  fi
done

# Load .env.test for JIRA_HOST
if [ -f "$PROJECT_ROOT/.env.test" ]; then
  set -a
  source "$PROJECT_ROOT/.env.test"
  set +a
fi

JIRA_HOST="${JIRA_HOST:-}"
SERVER_PORT=3456
DASHBOARD_URL="http://127.0.0.1:$SERVER_PORT"
CHROME_PROFILE_DIR="$PROJECT_ROOT/.chrome-dev-profile"
PID_FILE="$PROJECT_ROOT/.dev-pids"

# Construct Jira board URL
JIRA_BOARD_URL="${JIRA_BOARD_URL:-}"
if [ -z "$JIRA_BOARD_URL" ] && [ -n "$JIRA_HOST" ]; then
  JIRA_BOARD_URL="https://$JIRA_HOST/jira"
fi

# Kill previous dev processes
if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

cleanup() {
  echo ""
  echo "[dev] Shutting down..."
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do
      kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

# Start server
if [ -n "$JIRANIMO_SELF" ]; then
  echo "[dev] Self mode: Claude will operate on the Jiranimo repo itself"
fi

echo "[dev] Starting server in development mode..."
cd "$SERVER_DIR"
JIRANIMO_MODE=development JIRANIMO_SELF="$JIRANIMO_SELF" npx tsx watch src/index.ts &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server to be ready
echo "[dev] Waiting for server..."
for i in $(seq 1 30); do
  if curl -s "$DASHBOARD_URL/api/tasks" > /dev/null 2>&1; then
    echo "[dev] Server is ready on port $SERVER_PORT"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[dev] Server failed to start"
    exit 1
  fi
  sleep 0.5
done

# Launch Chrome with dev profile + extension
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -f "$CHROME_APP" ]; then
  echo "[dev] Launching Chrome with dev profile..."
  "$CHROME_APP" \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    --load-extension="$EXTENSION_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$DASHBOARD_URL" \
    ${JIRA_BOARD_URL:+"$JIRA_BOARD_URL"} &
  CHROME_PID=$!
  echo "$CHROME_PID" >> "$PID_FILE"
  echo "[dev] Chrome launched (profile: $CHROME_PROFILE_DIR)"
else
  echo "[dev] Chrome not found. Open manually:"
  echo "  Dashboard: $DASHBOARD_URL"
  [ -n "$JIRA_BOARD_URL" ] && echo "  Jira: $JIRA_BOARD_URL"
fi

echo ""
echo "[dev] Ready! Extension auto-reloads on file changes."
echo "[dev] Press Ctrl+C to stop."
echo ""

# Keep the script running (server is in background)
wait $SERVER_PID
