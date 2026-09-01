#!/usr/bin/env bash
#
# One-shot provisioning for an Ubuntu 22.04 / 24.04 server (Hetzner, Hostinger, anywhere with
# root SSH). Nothing in here is provider-specific.
#
# Run as root, ON THE SERVER, after uploading the app:
#
#   sudo DOMAIN=fortnite.hamaprojects.com EMAIL=you@example.com bash deploy/setup.sh
#
# Idempotent — safe to re-run. It will not overwrite an existing .env or database.

set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/fortnite}"
# The account the service runs as.
#
# On a box running the platform this has to be the account platform-api deploys
# with, because deploy.sh chowns every service it manages to that one account.
# Given its own user, Fortnite starts fine and then dies on the first deploy:
# /opt/fortnite becomes the shared account\'s, the unit is still fortnite\'s, and
# SQLite reports "attempt to write a readonly database" — which reads like a
# permissions bug in the app rather than two installers disagreeing about who
# owns the directory.
#
# Standalone there is no such account, and Fortnite gets its own as before.
if id -u brawl >/dev/null 2>&1; then
  APP_USER="${APP_USER:-brawl}"
else
  APP_USER="${APP_USER:-fortnite}"
fi
NODE_MAJOR="${NODE_MAJOR:-22}"
# Each app on the box needs its own loopback port. 3000 is SkinCraft, 3100 MineBox,
# 8080 Brawl, 8090 the platform panel; 3200 is Fortnite's.
PORT="${PORT:-3200}"
# Set to 1 to leave an existing firewall completely alone.
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"

if [[ -z "$DOMAIN" ]]; then
  echo "DOMAIN is required.  e.g. sudo DOMAIN=fortnite.hamaprojects.com bash $0" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

SERVICE="fortnite"
RESTART_AFTER=0

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }

# A port collision shows up as a service that starts, crashes on EADDRINUSE and flaps forever,
# while nginx returns 502. Catching it here costs one command.
#
# Unless the listener is this service, which on any re-run it will be — the
# script is meant to be idempotent, and refusing to run because the thing it
# installed last time is running is the opposite of that. It is only a
# collision when something *else* holds the port.
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    say "Stopping $SERVICE to reconfigure it"
    systemctl stop "$SERVICE"
    RESTART_AFTER=1
  else
    echo "Port ${PORT} is already in use on this server." >&2
    echo "Something else is listening there — pick another, e.g.  sudo PORT=3001 ... bash $0" >&2
    exit 1
  fi
fi

# If we stopped it, it comes back — including when a later step fails.
#
# Without this, a re-run that stops the service and then dies on something
# unrelated (a broken nginx config elsewhere on the box, say) leaves a service
# that was working before the script ran stopped afterwards. The installer must
# not be able to make things worse than it found them.
restore_service() {
  if [[ "${RESTART_AFTER:-0}" -eq 1 ]] && ! systemctl is-active --quiet "$SERVICE"; then
    echo "    restarting $SERVICE" >&2
    systemctl start "$SERVICE" || true
  fi
}
trap restore_service EXIT

say "Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync sqlite3 ufw nginx

# ── Node ─────────────────────────────────────────────────────────────────────
# Ubuntu's own `nodejs` package lags several major versions behind; better-sqlite3
# ships prebuilt binaries only for current releases, so an old Node means a slow
# source build or an outright failure.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  say "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

# ── Service account ──────────────────────────────────────────────────────────
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  say "Creating service user '$APP_USER'"
  adduser --system --group --home "$APP_DIR" --no-create-home "$APP_USER"
fi

say "Preparing $APP_DIR"
mkdir -p "$APP_DIR"/data

# Install the code, if it is not there yet.
#
# This used to tell you to upload it first with deploy/push.sh — a script that
# does not exist in this repository and never has. The install path is a git
# checkout, and this script is inside it, so the source is one directory up
# from here and can simply be copied.
#
# The exclusions matter: .git beside a live .env means one careless `git clean`
# takes the secrets, node_modules is rebuilt by npm ci below, and data/ is the
# database — copying over it on a re-run would destroy the install this script
# promises not to touch.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$APP_DIR/package.json" ]]; then
  if [[ -f "$SRC/package.json" ]]; then
    say "Installing from $SRC"
    rsync -a --delete \
      --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude 'data' \
      "$SRC"/ "$APP_DIR"/
  else
    cat >&2 <<'MSG'

  No application found, and this script is not inside a checkout either.

  Clone the repository on the server and run this from within it:
      git clone https://github.com/hamamed/koydamConfigApps.git /opt/src/koydamConfigApps
      cd /opt/src/koydamConfigApps/fortnite
      sudo DOMAIN=... EMAIL=... bash deploy/setup.sh

MSG
    exit 1
  fi
fi

# ── Configuration ────────────────────────────────────────────────────────────
if [[ ! -f "$APP_DIR/.env" ]]; then
  say "Writing .env"
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  ADMIN_PW="$(node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))')"

  cat > "$APP_DIR/.env" <<ENV
PORT=${PORT}
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_URL=https://${DOMAIN}
SESSION_SECRET=${SECRET}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PW}
APPLE_TEAM_ID=TEAMID
IOS_BUNDLE_ID=com.koydam.fortnite
DATA_DIR=./data
MAX_UPLOAD_MB=64
CORS_ORIGINS=
ENV
  chmod 600 "$APP_DIR/.env"
  NEW_INSTALL=1
else
  say "Keeping the existing .env"
  NEW_INSTALL=0
fi

say "Installing dependencies"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

# `better-sqlite3` and `sharp` ship prebuilt binaries. When one is missing for this Node version
# or architecture — or npm declines to run install scripts — the package installs "successfully"
# and then throws "Could not locate the bindings file" at boot. Systemd flaps, the log is cryptic,
# and nothing points at the real cause. Catch it here, where the fix is obvious.
#
# Which modules to check is read from package.json rather than listed here. The
# list used to be hardcoded, and a service without sharp failed this check for
# a module it had never depended on — reporting a native-module fault, advising
# a Node version that was already correct, and aborting before the unit was
# installed, while better-sqlite3 was in fact working perfectly.
say "Verifying native modules"
NATIVE="$(node -e 'const d = require("./package.json").dependencies || {};
  console.log(["better-sqlite3", "sharp"].filter((m) => m in d).join(" "))')"

if [[ -n "$NATIVE" ]]; then
  # shellcheck disable=SC2086
  CHECK="$(printf 'require("%s");' $NATIVE)"

  if ! node -e "$CHECK" >/dev/null 2>&1; then
    echo "    prebuilt binaries unavailable — building from source"
    apt-get install -y -qq build-essential python3
    # shellcheck disable=SC2086
    npm rebuild $NATIVE

    if ! node -e "$CHECK" >/dev/null 2>&1; then
      echo "    native modules still won't load. Check the node version:" >&2
      echo "      node -v   (expected ${NODE_MAJOR}.x)" >&2
      exit 1
    fi
  fi
  echo "    $NATIVE load"
else
  echo "    none to check"
fi

say "Running migrations"
node src/db/migrate.js

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── systemd ──────────────────────────────────────────────────────────────────
say "Installing the service"
sed -e "s|/opt/fortnite|${APP_DIR}|g" \
    -e "s|User=fortnite|User=${APP_USER}|" \
    -e "s|Group=fortnite|Group=${APP_USER}|" \
    "$APP_DIR/deploy/fortnite.service" > /etc/systemd/system/fortnite.service
systemctl daemon-reload
systemctl enable --now fortnite
sleep 2
systemctl is-active --quiet fortnite && echo "    service is running" || {
  echo "    service failed to start — journalctl -u fortnite -n 40" >&2
  exit 1
}

# ── nginx ────────────────────────────────────────────────────────────────────
say "Configuring nginx for $DOMAIN"
sed -e "s|vps\.yourdomain\.com|${DOMAIN}|g" \
    -e "s|/opt/fortnite|${APP_DIR}|g" \
    -e "s|127\.0\.0\.1:3000|127.0.0.1:${PORT}|g" \
    "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/fortnite
ln -sf /etc/nginx/sites-available/fortnite /etc/nginx/sites-enabled/fortnite

# Only clear the stock placeholder when this is the only site. On a server already serving
# another project, removing enabled sites is somebody else's outage.
enabled_count=$(ls -1 /etc/nginx/sites-enabled 2>/dev/null | grep -cv '^fortnite$' || true)
if [[ "$enabled_count" -le 1 && -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

# certbot hasn't run yet, so the TLS block would reference certificates that don't
# exist and nginx would refuse to start. Serve plain HTTP until the cert is issued.
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  cat > /etc/nginx/sites-available/fortnite <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 16M;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }


    location / {
        proxy_pass http://127.0.0.1:${PORT};
        include /etc/nginx/proxy_params;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
NGINX
  mkdir -p /var/www/certbot
fi

nginx -t
systemctl reload nginx

# ── Firewall ─────────────────────────────────────────────────────────────────
say "Firewall"
if [[ "$SKIP_FIREWALL" == "1" ]]; then
  echo "    skipped (SKIP_FIREWALL=1)"
elif ufw status 2>/dev/null | grep -q "Status: active"; then
  # Already configured — enabling rules on someone else's firewall is how a working service
  # goes dark, or how you lock yourself out when SSH isn't on 22.
  echo "    ufw is already active — leaving it alone"
  echo "    make sure 80 and 443 are allowed:  ufw allow 'Nginx Full'"
else
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw --force enable >/dev/null
  echo "    22, 80, 443 open; everything else closed (${PORT} is loopback-only)"
fi

# ── TLS ──────────────────────────────────────────────────────────────────────
if [[ -n "$EMAIL" ]]; then
  say "Requesting a certificate for $DOMAIN"
  apt-get install -y -qq certbot python3-certbot-nginx
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    # Now that certificates exist, install the full config with HSTS and caching.
    sed -e "s|vps\.yourdomain\.com|${DOMAIN}|g" \
        -e "s|/opt/fortnite|${APP_DIR}|g" \
        "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/fortnite
    nginx -t && systemctl reload nginx
  else
    echo "    certbot failed — check the DNS A record points here, then re-run:" >&2
    echo "    certbot --nginx -d ${DOMAIN}" >&2
  fi
else
  say "Skipping TLS (no EMAIL given)"
  echo "    run later:  certbot --nginx -d ${DOMAIN}"
fi

# ── Backups ──────────────────────────────────────────────────────────────────
say "Scheduling nightly backups"
chmod +x "$APP_DIR/deploy/backup.sh"
cat > /etc/cron.d/fortnite-backup <<CRON
0 3 * * * root APP_DIR=${APP_DIR} ${APP_DIR}/deploy/backup.sh >> /var/log/fortnite-backup.log 2>&1
CRON

say "Done"
cat <<SUMMARY

    Admin panel   https://${DOMAIN}/admin
    API           https://${DOMAIN}/api/v1/skins
    Listening on  127.0.0.1:${PORT} (nginx proxies to it)

SUMMARY

if [[ "$NEW_INSTALL" == "1" ]]; then
  echo "    Admin login:  admin / $(grep ADMIN_PASSWORD "$APP_DIR/.env" | cut -d= -f2)"
  echo "    Change it after signing in:  npm run create-admin -- admin 'a-new-password'"
  echo
fi

echo "    Before universal links will work, set APPLE_TEAM_ID in $APP_DIR/.env"
echo "    and restart:  systemctl restart fortnite"
echo
