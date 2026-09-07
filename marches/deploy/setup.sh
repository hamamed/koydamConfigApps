#!/usr/bin/env bash
#
# One-shot provisioning for this service on the box. Run as root, ON THE SERVER,
# after the code is in place:
#
#   sudo DOMAIN=marches.civictrust.ma EMAIL=admin@civictrust.ma bash deploy/setup.sh
#
# Idempotent — safe to re-run. It will not overwrite an existing .env or an
# existing database.

set -euo pipefail

DOMAIN="${DOMAIN:-marches.civictrust.ma}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/marches}"
SERVICE="marches"
# The shared platform account, because deploy.sh chowns every service it manages
# to that one. A service with its own user starts fine and then loses write
# access to its database on the first deploy.
if id -u brawl >/dev/null 2>&1; then
  APP_USER="${APP_USER:-brawl}"
else
  APP_USER="${APP_USER:-marches}"
fi
# Each app on the box needs its own loopback port: 3000 SkinCraft, 3100 MineBox,
# 3200 Fortnite, 8080 Brawl, 8090 the platform panel. 3300 bons de commande, 3400 is this one's.
PORT="${PORT:-3400}"
SKIP_TLS="${SKIP_TLS:-0}"

RESTART_AFTER=0
say() { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "$APP_DIR does not hold the application — deploy the code first." >&2
  exit 1
fi

# A port collision shows up as a service that starts, crashes on EADDRINUSE and
# flaps forever while nginx returns 502. Catching it here costs one command.
# It is only a collision when something *else* holds the port; on a re-run the
# listener is this service, and refusing to run then would defeat idempotency.
if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${PORT} "; then
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    say "Stopping $SERVICE to reconfigure it"
    systemctl stop "$SERVICE"
    RESTART_AFTER=1
  else
    echo "Port ${PORT} is already in use by something else. Pick another." >&2
    exit 1
  fi
fi

# If we stopped it, it comes back even when a later step fails: an installer
# must not be able to leave things worse than it found them.
restore_service() {
  if [[ "${RESTART_AFTER:-0}" -eq 1 ]] && ! systemctl is-active --quiet "$SERVICE"; then
    systemctl start "$SERVICE" || true
  fi
}
trap restore_service EXIT

say "Creating data directories"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data" "$APP_DIR/storage/invoices"

say "Checking the Node runtime"
# node:sqlite is the whole data layer and landed in 22.5.0.
node_major=$(node -p 'process.versions.node.split(".").map(Number)[0]')
node_minor=$(node -p 'process.versions.node.split(".").map(Number)[1]')
if (( node_major < 22 || (node_major == 22 && node_minor < 5) )); then
  echo "Node >= 22.5.0 is required for node:sqlite; this box has $(node -v)." >&2
  exit 1
fi
node -e 'require("node:sqlite")' 2>/dev/null || {
  echo "node:sqlite is not available on this Node build." >&2
  exit 1
}
echo "    $(node -v), node:sqlite available"

if [[ ! -f "$APP_DIR/.env" ]]; then
  say "Creating .env"
  sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
      "$APP_DIR/.env.example" > "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    generated, with a fresh JWT_SECRET"
else
  echo "    .env already exists — left alone"
fi

say "Installing dependencies"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund --prefix "$APP_DIR"

say "Applying the schema"
cd "$APP_DIR" && sudo -u "$APP_USER" node bin/db-init.js

say "Installing the systemd units"
install -m 644 "$APP_DIR/deploy/marches.service"        /etc/systemd/system/marches.service
install -m 644 "$APP_DIR/deploy/marches-scrape.service"   /etc/systemd/system/marches-scrape.service
install -m 644 "$APP_DIR/deploy/marches-scrape.timer"     /etc/systemd/system/marches-scrape.timer
install -m 644 "$APP_DIR/deploy/marches-alerts.service"   /etc/systemd/system/marches-alerts.service
install -m 644 "$APP_DIR/deploy/marches-alerts.timer"     /etc/systemd/system/marches-alerts.timer
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"

say "Installing the nginx site"
# Never overwrite an existing site file. Once certbot has run it owns that file:
# it holds the 443 server block and the certificate paths, none of which are in
# the repository copy. Replacing it silently drops HTTPS for this host and every
# request falls through to another site on the box.
if [[ -f "/etc/nginx/sites-available/${SERVICE}" ]]; then
  echo "    /etc/nginx/sites-available/${SERVICE} already exists — left alone"
  echo "    (edit it in place; the repository copy is the first-run template)"
else
  install -m 644 "$APP_DIR/deploy/nginx.conf" "/etc/nginx/sites-available/${SERVICE}"
fi
ln -sf "/etc/nginx/sites-available/${SERVICE}" "/etc/nginx/sites-enabled/${SERVICE}"
nginx -t
systemctl reload nginx

say "Starting $SERVICE"
systemctl restart "$SERVICE"
RESTART_AFTER=0

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "    healthy on 127.0.0.1:${PORT}"
    break
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  journalctl -u "$SERVICE" --no-pager --lines=40
  echo "Service did not become healthy — see the log above." >&2
  exit 1
fi

if [[ "$SKIP_TLS" != "1" ]]; then
  say "Issuing the TLS certificate"
  if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    echo "    certificate already present — left alone"
  elif [[ -z "$EMAIL" ]]; then
    echo "    EMAIL not set; skipping. Run afterwards:"
    echo "      certbot --nginx -d ${DOMAIN} --agree-tos -m you@example.com --redirect"
  else
    certbot --nginx -d "$DOMAIN" --agree-tos -m "$EMAIL" --redirect --non-interactive
    systemctl reload nginx
  fi
fi

cat <<NOTE

$SERVICE is installed and running.

  Health   https://${DOMAIN}/health
  Panel    https://${DOMAIN}/admin

Next:

  1. Create the admin account:
       cd ${APP_DIR}
       sudo -u ${APP_USER} ADMIN_PASSWORD='<a strong password>' node bin/db-seed.js

  2. Do the first crawl by hand and check what comes back, because the live
     portal's HTML labels are the real contract for the scraper:
       sudo -u ${APP_USER} node bin/scrape.js --source=marches --max-pages=1

  3. Load the whole catalogue once (hours, at a polite pace):

  4. Then enable the daily incremental crawl:
       systemctl enable --now marches-scrape.timer

NOTE
