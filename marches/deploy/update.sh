#!/usr/bin/env bash
#
# Restarts the service after a deploy and re-applies the schema. Run ON THE
# SERVER:
#
#   sudo bash /opt/marches/deploy/update.sh
#
# Normally you do not need this: `sudo /opt/deploy.sh marches` covers it.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/marches}"
if id -u brawl >/dev/null 2>&1; then
  APP_USER="${APP_USER:-brawl}"
else
  APP_USER="${APP_USER:-marches}"
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

cd "$APP_DIR"

echo "==> Installing dependencies"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund

echo "==> Applying the schema"
# Idempotent: every statement is IF NOT EXISTS.
sudo -u "$APP_USER" node bin/db-init.js

echo "==> Restarting"
systemctl restart marches
sleep 2

if systemctl is-active --quiet marches; then
  echo "==> Done"
else
  echo "    service failed to start: journalctl -u marches -n 40" >&2
  exit 1
fi
