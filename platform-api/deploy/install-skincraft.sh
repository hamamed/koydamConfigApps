#!/usr/bin/env bash
#
# Installs SkinCraft alongside Brawl and platform-api on this VPS.
#
# SkinCraft ships deploy scripts aimed at a Hostinger box. This one targets
# *this* server instead, and reuses what is already here — Node, nginx, certbot
# and the `brawl` service user — rather than re-provisioning any of it.
#
# SkinCraft uses SQLite, not Postgres, so it brings its own storage and shares
# nothing with the other services. That is a feature: three apps, three failure
# domains.
#
# Usage:
#   sudo ./deploy/install-skincraft.sh \
#        --domain skincraft.hamaprojects.com --email you@example.com
#
set -euo pipefail

SERVICE=skincraft
APP_DIR=/opt/skincraft
REPO=https://github.com/hamamed/skincraft.git
PORT=3000
DOMAIN=""
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --port)   PORT="$2";   shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
[[ -n "$DOMAIN" ]] || die "--domain is required, e.g. --domain skincraft.hamaprojects.com"

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

existing_env() {
  [[ -f "$APP_DIR/.env" ]] || return 0
  grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true
}

step "Checking prerequisites"
command -v node >/dev/null || die "node is not installed."
command -v git  >/dev/null || apt-get install -y -qq git
command -v nginx >/dev/null || die "nginx is not installed."
id brawl &>/dev/null || die "service user 'brawl' does not exist."
ok "node $(node -v), git, nginx"

# sharp compiles native bindings; without these the npm install fails with a
# node-gyp error that says nothing about the missing headers.
ensure_home

step "Build dependencies for sharp"
apt-get install -y -qq build-essential python3 libvips-dev >/dev/null 2>&1 || \
  warn "could not install libvips-dev — sharp may fall back to a prebuilt binary"
ok "ready"

# ── Source ───────────────────────────────────────────────────────────────────

step "Fetching source"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard --quiet origin/main
  ok "updated from origin/main"
else
  mkdir -p "$APP_DIR"
  git clone --quiet --depth 1 "$REPO" "$APP_DIR"
  ok "cloned"
fi

# ── Shared theme ─────────────────────────────────────────────────────────────
#
# Reapplied after every clone, because the clone resets the working tree to
# origin/main and would otherwise restore the upstream dark theme. These files
# put SkinCraft on the same Koydam design system as the other panels on this
# box — same tokens, same indigo, same typeface.
#
# Only three files: the tokens, a rewrite of the panel's own stylesheet in terms
# of them, and the <head> that loads both. The ~55 sc-* class names are
# unchanged, so no template needed editing.
THEME_DIR="$(cd "$(dirname "$0")" && pwd)/skincraft-theme"

if [[ -d "$THEME_DIR" ]]; then
  cp "$THEME_DIR/css/koydam.css" "$APP_DIR/public/css/koydam.css"
  cp "$THEME_DIR/css/admin.css"  "$APP_DIR/public/css/admin.css"
  cp "$THEME_DIR/views/partials/head.ejs" "$APP_DIR/views/partials/head.ejs"
  ok "shared theme applied"
fi

# The SSO client, and the middleware that uses it. Same reason as the theme:
# a fresh clone resets the tree, so both are reapplied every deploy.
AUTH_DIR="$(cd "$(dirname "$0")" && pwd)/skincraft-auth"
if [[ -d "$AUTH_DIR" ]]; then
  cp "$AUTH_DIR/platform-auth.js" "$APP_DIR/src/middleware/platform-auth.js"
  cp "$AUTH_DIR/auth.js"          "$APP_DIR/src/middleware/auth.js"
  ok "single sign-on wired in"
else
  warn "no theme directory beside this script — SkinCraft keeps its own dark theme"
fi

# Uploads and the SQLite file live here and must survive every redeploy.
mkdir -p "$APP_DIR/storage/previews" "$APP_DIR/storage/templates" "$APP_DIR/data"

# ── .env ─────────────────────────────────────────────────────────────────────

step "Configuration"

SESSION_SECRET="$(existing_env SESSION_SECRET)"
[[ -z "$SESSION_SECRET" ]] && SESSION_SECRET="$(openssl rand -hex 32)"

ADMIN_USERNAME="$(existing_env ADMIN_USERNAME)"
[[ -z "$ADMIN_USERNAME" ]] && ADMIN_USERNAME="admin"

ADMIN_PASSWORD="$(existing_env ADMIN_PASSWORD)"
FRESH_PASSWORD=0
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  FRESH_PASSWORD=1
fi

# Taken from platform-api's own .env rather than asked for: the two must match
# exactly, and a token copied by hand is a token eventually mistyped.
PLATFORM_TOKEN=""
if [[ -f /opt/platform-api/.env ]]; then
  PLATFORM_TOKEN="$(grep -E '^SERVICE_TOKEN=' /opt/platform-api/.env | cut -d= -f2- || true)"
fi

if [[ -n "$PLATFORM_TOKEN" ]]; then
  ok "single sign-on: sharing platform-api's service token"
else
  warn "platform-api not found — SkinCraft keeps its own local login"
fi

# PUBLIC_URL must match how clients actually reach the server: every
# preview_url and template_url in the catalogue is built from it, so a wrong
# value produces a gallery of broken images in the iOS app.
cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
HOST=127.0.0.1
NODE_ENV=production

PUBLIC_URL=https://$DOMAIN

SESSION_SECRET=$SESSION_SECRET

ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD

DATA_DIR=./data
STORAGE_DIR=./storage
MAX_UPLOAD_MB=12

# Blank allows all origins, which is what a mobile client needs — apps send no
# Origin header at all.
CORS_ORIGINS=

# Single sign-on. With PLATFORM_URL set this panel has no login of its own —
# it accepts the session from config.hamaprojects.com. Leave blank to fall back
# to the local username and password.
PLATFORM_URL=${PLATFORM_TOKEN:+https://config${DOMAIN#*.}}
SERVICE_TOKEN=$PLATFORM_TOKEN
PLATFORM_APP_SLUG=skincraft
EOF

chmod 600 "$APP_DIR/.env"
chown -R brawl:brawl "$APP_DIR"
ok ".env written (mode 600)"

step "Dependencies"
as_app_user bash -c "cd $APP_DIR && npm install --omit=dev --no-audit --fund=false" \
  || die "npm install failed — see the output above."
ok "installed"

step "Schema"
as_app_user bash -c "cd $APP_DIR && npm run migrate" || die "migration failed."
ok "migrated"

# ── systemd ──────────────────────────────────────────────────────────────────

step "Service"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=SkinCraft — catalogue API and admin panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brawl
Group=brawl
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node src/server.js

Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# Uploads and the SQLite database are written here.
ReadWritePaths=$APP_DIR

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ${SERVICE} >/dev/null 2>&1 || systemctl restart ${SERVICE}
sleep 3

if systemctl is-active --quiet ${SERVICE}; then
  ok "${SERVICE} running on port ${PORT}"
else
  journalctl -u ${SERVICE} -n 30 --no-pager || true
  die "${SERVICE} failed to start — log above."
fi

# ── nginx ────────────────────────────────────────────────────────────────────

step "nginx"

cat > /etc/nginx/sites-available/${SERVICE} <<EOF
upstream skincraft_app {
    server 127.0.0.1:${PORT};
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Must stay above MAX_UPLOAD_MB or uploads fail at nginx with a 413 that
    # never reaches the app, and the admin panel reports nothing useful.
    client_max_body_size 16m;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://skincraft_app;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # AI generation, and nothing else, gets a long window.
    #
    # It is one synchronous request that calls the image provider once per
    # image — up to three on "Detailed", each with its own 120s ceiling in
    # provider.js. Under the 60s above, nginx hung up first: the browser got a
    # gateway error while the generation carried on server-side and saved a
    # draft nobody was told about, so the same prompt got run again and billed
    # again.
    #
    # The rule is that the front door must outlast the app's own budget, so the
    # app is what gives up and the user gets its sentence instead of a gateway
    # page with none. 420s clears 3 x 120s plus composing and storing.
    location /admin/skins/ai {
        proxy_pass http://skincraft_app;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 420s;
        proxy_send_timeout 420s;
        # A progress indicator that arrives all at once at the end is not one.
        proxy_buffering off;
    }

    # Generated previews and templates. A separate location so image traffic
    # never competes with the API for the same limits — the same lesson the
    # Brawl wallpapers taught.
    location /storage/ {
        proxy_pass http://skincraft_app;
        proxy_set_header Host \$host;
        expires 7d;
        add_header Cache-Control "public";
    }
}
EOF

ln -sf /etc/nginx/sites-available/${SERVICE} /etc/nginx/sites-enabled/${SERVICE}
nginx -t >/dev/null || die "nginx config invalid — not reloading."
systemctl reload nginx
ok "nginx configured for ${DOMAIN}"

# ── TLS ──────────────────────────────────────────────────────────────────────

step "TLS"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [[ -z "$RESOLVED" ]]; then
  warn "$DOMAIN does not resolve yet — skipping certbot."
  warn "Add an A record, then: certbot --nginx -d $DOMAIN"
  warn "PUBLIC_URL in .env already says https, so images stay broken until TLS is on."
else
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  ARGS=(--nginx -d "$DOMAIN" --redirect --agree-tos --non-interactive)
  [[ -n "$EMAIL" ]] && ARGS+=(-m "$EMAIL") || ARGS+=(--register-unsafely-without-email)
  certbot "${ARGS[@]}" && ok "certificate issued" || warn "certbot failed — site still on HTTP."
fi

# ── Done ─────────────────────────────────────────────────────────────────────

cat <<EOF

${BOLD}SkinCraft is up.${RESET}

  API   : https://${DOMAIN}/api/v1/health
  Admin : https://${DOMAIN}/admin

EOF

if [[ $FRESH_PASSWORD -eq 1 ]]; then
  cat <<EOF
  ${BOLD}First admin account${RESET}
    username: ${ADMIN_USERNAME}
    password: ${ADMIN_PASSWORD}

  Change it: cd ${APP_DIR} && npm run create-admin -- ${ADMIN_USERNAME} 'new-password'
EOF
else
  echo "  Admin credentials unchanged — they were already in ${APP_DIR}/.env."
fi
