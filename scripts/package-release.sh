#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/.artifacts/release"
EXTENSION_STAGE_DIR="$ARTIFACT_DIR/extension"
SERVER_STAGE_DIR="$ARTIFACT_DIR/server"

VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$ROOT_DIR/package.json")"

cd "$ROOT_DIR"

rm -f "$ARTIFACT_DIR"/jiranimo-extension-v*.zip
rm -f "$ARTIFACT_DIR"/jiranimo-server-node24-v*.zip
rm -f "$ARTIFACT_DIR"/jiranimo-*.tgz
rm -f "$ARTIFACT_DIR"/SHA256SUMS.txt

(
  cd "$EXTENSION_STAGE_DIR"
  zip -qr "$ARTIFACT_DIR/jiranimo-extension-v$VERSION.zip" .
)

(
  cd "$SERVER_STAGE_DIR"
  zip -qr "$ARTIFACT_DIR/jiranimo-server-node24-v$VERSION.zip" .
)

npm pack --workspace=server --pack-destination "$ARTIFACT_DIR" >/dev/null

(
  cd "$ARTIFACT_DIR"
  shasum -a 256 \
    "jiranimo-extension-v$VERSION.zip" \
    "jiranimo-server-node24-v$VERSION.zip" \
    "jiranimo-$VERSION.tgz" \
    > SHA256SUMS.txt
)
