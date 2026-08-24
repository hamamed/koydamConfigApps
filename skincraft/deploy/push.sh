#!/usr/bin/env bash
#
# Uploads the app from your Mac to the VPS. Run locally, from the project root:
#
#   bash deploy/push.sh root@203.0.113.10
#
# Excludes everything that must not travel: local dependencies (the server builds its own
# native binaries), the local database, and uploaded media that only exists on the server.

set -euo pipefail

TARGET="${1:-}"
APP_DIR="${APP_DIR:-/srv/skincraft}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: bash deploy/push.sh user@host" >&2
  exit 1
fi

echo "==> Uploading to ${TARGET}:${APP_DIR}"

rsync -az --delete --info=stats1 \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'storage/templates/*' \
  --exclude 'storage/previews/*' \
  --exclude '.env' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  ./ "${TARGET}:${APP_DIR}/"

echo "==> Restarting"
# On a first run the service doesn't exist yet; that's expected, not a failure.
ssh "$TARGET" "cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund && node src/db/migrate.js && (systemctl restart skincraft 2>/dev/null || echo '    service not installed yet — run deploy/setup.sh')"

echo "==> Done"
