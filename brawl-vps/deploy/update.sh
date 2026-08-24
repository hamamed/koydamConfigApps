#!/usr/bin/env bash
#
# Redeploys code changes to an already-provisioned server.
#
# Unlike setup.sh this touches nothing but the app: no packages, no nginx, no
# firewall, no .env. Run it after editing source.
#
#   cd /tmp/brawl-vps && sudo bash deploy/update.sh
#
# Flags:
#   --sync    Also re-sync brawler metadata (after a new brawler ships)
#   --crawl   Also kick off a meta crawl immediately

set -euo pipefail

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

step() { echo; echo "${BOLD}${BLUE}==>${RESET} ${BOLD}$*${RESET}"; }
ok()   { echo "    ${GREEN}✓${RESET} $*"; }
warn() { echo "    ${YELLOW}!${RESET} $*"; }
die()  { echo; echo "${RED}✗ $*${RESET}" >&2; exit 1; }

# Runs a command as the service user. See the note in setup.sh — `runuser` is
# preferred over `sudo` because it ships with util-linux (minimal Debian images
# often have no sudo) and needs no password. HOME=/tmp gives npm a writable
# cache, since the service user has no home directory.
as_app_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- env HOME=/tmp "$@"
  else
    sudo -u "$APP_USER" env HOME=/tmp "$@"
  fi
}

APP_DIR=/opt/brawl-vps
APP_USER=brawl
SERVICE=brawl-api

DO_SYNC=0
DO_CRAWL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync)  DO_SYNC=1; shift ;;
    --crawl) DO_CRAWL=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown flag: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash deploy/update.sh"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SRC_DIR/package.json" ]] || die "Run this from inside the project directory."
[[ -d "$APP_DIR" ]] || die "$APP_DIR not found. Run deploy/setup.sh first."
[[ -f "$APP_DIR/.env" ]] || die "$APP_DIR/.env missing. Run deploy/setup.sh first."

step "Deploying source"

if [[ "$SRC_DIR" == "$APP_DIR" ]]; then
  ok "already in place"
else
  # Replace src/ wholesale so deleted files don't linger, but never touch
  # .env or data/ — those hold the token and hand-maintained overrides.
  rm -rf "$APP_DIR/src"
  cp -r "$SRC_DIR/src" "$APP_DIR/"
  cp "$SRC_DIR/package.json" "$APP_DIR/"
  [[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
  cp -r "$SRC_DIR/deploy" "$APP_DIR/"
  [[ -f "$SRC_DIR/README.md" ]] && cp "$SRC_DIR/README.md" "$APP_DIR/"
  ok "src/ replaced (.env and data/ preserved)"
fi

step "Updating dependencies"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  # See setup.sh: npm's own error names the offending package, so it is shown
  # rather than swallowed.
  if ! NPM_OUT="$(npm ci --omit=dev --no-audit --fund=false 2>&1)"; then
    echo "$NPM_OUT" | tail -20
    die "npm ci failed — output above. A lock file out of sync with package.json is the usual cause; 'npm install' in $APP_DIR regenerates it."
  fi
else
  if ! NPM_OUT="$(npm install --omit=dev --no-audit --fund=false 2>&1)"; then
    echo "$NPM_OUT" | tail -20
    die "npm install failed — output above."
  fi
fi
ok "dependencies current"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Idempotent, and a no-op when POSTGRES_URL is unset. Run before the restart so
# a schema change lands before the new code that needs it.
step "Applying database schema"
if as_app_user npm run --silent db:migrate 2>&1 | tail -3; then
  ok "schema current"
else
  warn "migration failed — history and panel may be unavailable"
fi

if [[ $DO_SYNC -eq 1 ]]; then
  step "Re-syncing brawler metadata"
  as_app_user npm run --silent sync:brawlers 2>&1 | tail -3 \
    && ok "metadata refreshed" \
    || warn "sync failed — existing metadata retained"
fi

step "Restarting service"

# The unit sends SIGTERM, which triggers the graceful shutdown in server.js:
# stop accepting connections, drain in-flight requests, close Redis.
systemctl restart "$SERVICE"
sleep 4

if ! systemctl is-active --quiet "$SERVICE"; then
  echo
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "Service failed to start after update — log above."
fi
ok "service active"

HEALTH="$(curl -s --max-time 5 http://127.0.0.1:8080/health || echo '')"
if [[ -n "$HEALTH" ]]; then
  ok "health OK"
  command -v jq >/dev/null && echo "      $(echo "$HEALTH" | jq -c '{cache:.cache.backend,brawlers:.brawlerMeta.count,uptime:.uptimeSeconds}')"
else
  warn "health endpoint not responding"
fi

if [[ $DO_CRAWL -eq 1 ]]; then
  step "Running meta crawl"
  echo "    (a few hundred upstream calls — this takes a minute or two)"
  as_app_user npm run --silent crawl:meta 2>&1 | tail -5 \
    || warn "crawl failed"
fi

echo
echo "${BOLD}${GREEN}✓ Update complete${RESET}"
echo "  sudo journalctl -u $SERVICE -f"
echo
