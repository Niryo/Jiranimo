#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"
EXTENSION_DIR="$PROJECT_ROOT/extension"

SERVER_ONLY=""
TARGET_INPUT=""
for arg in "$@"; do
  case "$arg" in
    --server-only)
      SERVER_ONLY=1
      ;;
    -*)
      echo "[dev] Unknown option: $arg"
      echo "[dev] Usage: npm run dev -- <path-to-repo-or-repos>"
      exit 1
      ;;
    *)
      if [ -n "$TARGET_INPUT" ]; then
        echo "[dev] Only one path argument is supported"
        echo "[dev] Usage: npm run dev -- <path-to-repo-or-repos>"
        exit 1
      fi
      TARGET_INPUT="$arg"
      ;;
  esac
done

if [ -z "$TARGET_INPUT" ]; then
  echo "[dev] Missing required path argument"
  echo "[dev] Usage: npm run dev -- <path-to-repo-or-repos>"
  exit 1
fi

if [ ! -d "$TARGET_INPUT" ]; then
  echo "[dev] Path not found: $TARGET_INPUT"
  exit 1
fi

TARGET_PATH="$(cd "$TARGET_INPUT" && pwd)"

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
RUNTIME_LOG_DIR="${JIRANIMO_LOG_DIR:-$HOME/.jiranimo/logs}"
CHROME_LOG_FILE="$RUNTIME_LOG_DIR/chrome-dev.log"

# Construct Jira board URL
JIRA_BOARD_URL="${JIRA_BOARD_URL:-}"
if [ -z "$JIRA_BOARD_URL" ] && [ -n "$JIRA_HOST" ]; then
  JIRA_BOARD_URL="https://$JIRA_HOST/jira/software/c/projects/JTEST/boards/1"
fi

# Kill previous dev processes
if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

mkdir -p "$RUNTIME_LOG_DIR"

echo "[dev] Syncing shared assets..."
cd "$PROJECT_ROOT"
npm run assets:sync > /dev/null

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

echo "[dev] Starting Jiranimo server..."
echo "[dev] Target path: $TARGET_PATH"
cd "$SERVER_DIR"
npx tsx watch src/index.ts "$TARGET_PATH" &
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

if [ -n "$SERVER_ONLY" ]; then
  echo ""
  echo "[dev] Server is ready. Press Ctrl+C to stop."
  echo ""
  wait $SERVER_PID
  exit $?
fi

# Launch Chrome with dev profile + extension
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -f "$CHROME_APP" ]; then
  echo "[dev] Launching Chrome with dev profile..."
  echo "[dev] Chrome output: $CHROME_LOG_FILE"
  "$CHROME_APP" \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    --load-extension="$EXTENSION_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$DASHBOARD_URL" \
    ${JIRA_BOARD_URL:+"$JIRA_BOARD_URL"} \
    >> "$CHROME_LOG_FILE" 2>&1 &
  CHROME_PID=$!
  echo "$CHROME_PID" >> "$PID_FILE"
  echo "[dev] Chrome launched (profile: $CHROME_PROFILE_DIR)"
else
  echo "[dev] Chrome not found. Open manually:"
  echo "  Dashboard: $DASHBOARD_URL"
  [ -n "$JIRA_BOARD_URL" ] && echo "  Jira: $JIRA_BOARD_URL"
fi

echo ""
echo "[dev] Ready!"
echo "[dev] Press Ctrl+C to stop."
echo ""

# Keep the script running (server is in background)
wait $SERVER_PID
