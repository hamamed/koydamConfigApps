#!/usr/bin/env bash
#
# Redeploys platform-api over an existing install, from an uploaded copy.
#
# The normal path is now `deploy.sh`, which pulls from GitHub and handles every
# service. This remains for the case that one cannot: no network to github, a
# repo you cannot reach, or a change you need on the box before it is pushed.
#
# Preserves .env and the database. For a first install use setup.sh, which also
# creates the database, the service and the nginx block.
#
set -euo pipefail

SERVICE=platform-api
APP_DIR=/opt/platform-api

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -f "$APP_DIR/.env" ]] || { echo "No $APP_DIR/.env — run setup.sh first." >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"

# Runs a command as the service user.
#
# `runuser` rather than `sudo`: it ships with util-linux so it is always
# present, needs no password, and is the right tool for root→user. Minimal
# Debian images often have no sudo at all.
#
# HOME=/tmp because the service user is created with --no-create-home and npm
# needs somewhere writable for its cache — without this, `npm ci` dies with
# EACCES on /home/brawl after already half-unpacking node_modules.
# Give the service user a home directory.
#
# It was created with --no-create-home, and npm insists on a writable HOME for
# its cache: without one, `npm ci` half-unpacks node_modules and then dies with
# EACCES on /home/brawl. Passing HOME=/tmp through `env` is not reliable —
# runuser applies PAM and can reset it — so the directory is created instead.
# A real home is also what the other services on this box already assume.
ensure_home() {
  local home
  home="$(getent passwd brawl | cut -d: -f6)"
  [[ -z "$home" || "$home" == "/" ]] && home=/home/brawl

  if [[ ! -d "$home" ]]; then
    mkdir -p "$home"
    ok "created $home"
  fi

  chown brawl:brawl "$home"
  chmod 750 "$home"
  APP_USER_HOME="$home"
}

as_app_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u brawl -- env HOME="${APP_USER_HOME:-/home/brawl}" "$@"
  else
    sudo -u brawl env HOME="${APP_USER_HOME:-/home/brawl}" "$@"
  fi
}


command -v rsync >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync; }

echo "==> Copying source"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .env \
  "$SRC"/ "$APP_DIR"/
chown -R brawl:brawl "$APP_DIR"

ensure_home

echo "==> Dependencies"
# Output is shown rather than swallowed: a failing npm ci with a hidden reason
# cost an afternoon on the Brawl service.
as_app_user bash -c "cd $APP_DIR && npm ci --omit=dev --no-audit --fund=false" || {
  echo "npm ci failed — see above." >&2; exit 1; }

echo "==> Schema"
as_app_user bash -c "cd $APP_DIR && npm run migrate" || {
  echo "migration failed." >&2; exit 1; }

echo "==> Restarting"
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo "✓ $SERVICE running"
  curl -fsS http://127.0.0.1:8090/health | head -c 200; echo
else
  journalctl -u "$SERVICE" -n 30 --no-pager
  echo "✗ $SERVICE failed to start" >&2
  exit 1
fi
