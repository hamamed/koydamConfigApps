#!/usr/bin/env bash
#
# One-shot provisioning for an Ubuntu 22.04 / 24.04 server (Hetzner, Hostinger, anywhere with
# root SSH). Nothing in here is provider-specific.
#
# Run as root, ON THE SERVER, after uploading the app:
#
#   sudo DOMAIN=vps.yourdomain.com EMAIL=you@example.com bash deploy/setup.sh
#
# Idempotent — safe to re-run. It will not overwrite an existing .env or database.

set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/srv/skincraft}"
APP_USER="${APP_USER:-skincraft}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# Each app on the box needs its own loopback port. Override when 3000 is already taken.
PORT="${PORT:-3000}"
# Set to 1 to leave an existing firewall completely alone.
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"

if [[ -z "$DOMAIN" ]]; then
  echo "DOMAIN is required.  e.g. sudo DOMAIN=vps.yourdomain.com bash $0" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$1"; }

# A port collision shows up as a service that starts, crashes on EADDRINUSE and flaps forever,
# while nginx returns 502. Catching it here costs one command.
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Port ${PORT} is already in use on this server." >&2
  echo "Something else is listening there — pick another, e.g.  sudo PORT=3001 ... bash $0" >&2
  exit 1
fi

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
mkdir -p "$APP_DIR"/{data,storage/templates,storage/previews}

if [[ ! -f "$APP_DIR/package.json" ]]; then
  cat >&2 <<'MSG'

  No application found at that path.

  Upload it first, from your Mac:
      bash deploy/push.sh root@YOUR_SERVER_IP

  then re-run this script.

MSG
  exit 1
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
IOS_BUNDLE_ID=com.skincraft.roblox
DATA_DIR=./data
STORAGE_DIR=./storage
MAX_UPLOAD_MB=12
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
say "Verifying native modules"
if ! node -e 'require("better-sqlite3"); require("sharp")' >/dev/null 2>&1; then
  echo "    prebuilt binaries unavailable — building from source"
  apt-get install -y -qq build-essential python3
  npm rebuild better-sqlite3 sharp

  if ! node -e 'require("better-sqlite3"); require("sharp")' >/dev/null 2>&1; then
    echo "    native modules still won't load. Check the node version:" >&2
    echo "      node -v   (expected ${NODE_MAJOR}.x)" >&2
    exit 1
  fi
fi
echo "    better-sqlite3 and sharp load"

say "Running migrations"
node src/db/migrate.js

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── systemd ──────────────────────────────────────────────────────────────────
say "Installing the service"
sed -e "s|/srv/skincraft|${APP_DIR}|g" \
    -e "s|User=skincraft|User=${APP_USER}|" \
    -e "s|Group=skincraft|Group=${APP_USER}|" \
    "$APP_DIR/deploy/skincraft.service" > /etc/systemd/system/skincraft.service
systemctl daemon-reload
systemctl enable --now skincraft
sleep 2
systemctl is-active --quiet skincraft && echo "    service is running" || {
  echo "    service failed to start — journalctl -u skincraft -n 40" >&2
  exit 1
}

# ── nginx ────────────────────────────────────────────────────────────────────
say "Configuring nginx for $DOMAIN"
sed -e "s|vps\.yourdomain\.com|${DOMAIN}|g" \
    -e "s|/srv/skincraft|${APP_DIR}|g" \
    -e "s|127\.0\.0\.1:3000|127.0.0.1:${PORT}|g" \
    "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/skincraft
ln -sf /etc/nginx/sites-available/skincraft /etc/nginx/sites-enabled/skincraft

# Only clear the stock placeholder when this is the only site. On a server already serving
# another project, removing enabled sites is somebody else's outage.
enabled_count=$(ls -1 /etc/nginx/sites-enabled 2>/dev/null | grep -cv '^skincraft$' || true)
if [[ "$enabled_count" -le 1 && -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

# certbot hasn't run yet, so the TLS block would reference certificates that don't
# exist and nginx would refuse to start. Serve plain HTTP until the cert is issued.
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  cat > /etc/nginx/sites-available/skincraft <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 16M;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location /storage/ {
        alias ${APP_DIR}/storage/;
        expires 30d;
        access_log off;
    }

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
        -e "s|/srv/skincraft|${APP_DIR}|g" \
        "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/skincraft
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
cat > /etc/cron.d/skincraft-backup <<CRON
0 3 * * * root APP_DIR=${APP_DIR} ${APP_DIR}/deploy/backup.sh >> /var/log/skincraft-backup.log 2>&1
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
echo "    and restart:  systemctl restart skincraft"
echo
