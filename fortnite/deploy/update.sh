#!/usr/bin/env bash
#
# Updates a git-deployed install. Run ON THE SERVER:
#
#   sudo bash /opt/fortnite/deploy/update.sh
#
# For an rsync-deployed install use deploy/push.sh from your Mac instead.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fortnite}"
# Matched to setup.sh: the shared platform account where there is one, Fortnite's
# own where there is not. Running this as the wrong user leaves files the service
# cannot read back.
if id -u brawl >/dev/null 2>&1; then
  APP_USER="${APP_USER:-brawl}"
else
  APP_USER="${APP_USER:-fortnite}"
fi
BRANCH="${BRANCH:-main}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

cd "$APP_DIR"

if [[ ! -d .git ]]; then
  echo "$APP_DIR is not a git checkout — use deploy/push.sh from your Mac instead." >&2
  exit 1
fi

echo "==> Pulling $BRANCH"
# As the owning user: git refuses to operate on a repository owned by someone else
# ("dubious ownership"), and running as root would leave root-owned files behind.
sudo -u "$APP_USER" git fetch --quiet origin "$BRANCH"
sudo -u "$APP_USER" git reset --hard --quiet "origin/$BRANCH"

echo "==> Installing dependencies"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund

if ! sudo -u "$APP_USER" node -e 'require("better-sqlite3"); require("sharp")' >/dev/null 2>&1; then
  echo "    rebuilding native modules"
  sudo -u "$APP_USER" npm rebuild better-sqlite3 sharp
fi

echo "==> Migrating"
sudo -u "$APP_USER" node src/db/migrate.js

echo "==> Restarting"
systemctl restart fortnite
sleep 2

if systemctl is-active --quiet fortnite; then
  echo "==> Done — $(git -C "$APP_DIR" log --oneline -1)"
else
  echo "    service failed to start: journalctl -u fortnite -n 40" >&2
  exit 1
fi
