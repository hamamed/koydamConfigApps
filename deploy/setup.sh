#!/usr/bin/env bash
#
# Provisions platform-api alongside the services already on this box.
#
# Assumes Postgres, nginx and Node are installed — brawl-vps's setup.sh put
# them there. This adds a database, a service user's directory, a systemd unit
# and an nginx server block, and touches nothing that already exists.
#
# Usage:
#   sudo ./deploy/setup.sh --domain config.hamaprojects.com --email you@example.com
#
# Re-running is safe: the database, the admin key and .env are all preserved.
#
set -euo pipefail

SERVICE=platform-api
APP_DIR=/opt/platform-api
DOMAIN=""
EMAIL=""
WANT_TLS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --no-tls) WANT_TLS=0;  shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
[[ -n "$DOMAIN" ]] || die "--domain is required, e.g. --domain config.hamaprojects.com"

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

# Reads a value out of the existing .env so a re-run preserves generated
# secrets rather than rotating them and locking you out of your own panel.
existing_env() {
  [[ -f "$APP_DIR/.env" ]] || return 0
  grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true
}

step "Checking prerequisites"
command -v node    >/dev/null || die "node is not installed — run brawl-vps setup.sh first."
command -v nginx   >/dev/null || die "nginx is not installed."
command -v psql    >/dev/null || die "postgres is not installed."
id brawl &>/dev/null || die "service user 'brawl' does not exist — run brawl-vps setup.sh first."
command -v rsync >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync; }
ok "node $(node -v), nginx, postgres, rsync, user 'brawl'"

# ── Database ─────────────────────────────────────────────────────────────────
#
# Its own database and its own role. Sharing the Brawl database would mean one
# mistaken migration could take the crawler's corpus with it, and it would make
# per-service backup and restore impossible.

step "Database"

PG_PASSWORD="$(existing_env POSTGRES_PASSWORD)"
if [[ -z "$PG_PASSWORD" ]]; then
  PG_PASSWORD="$(openssl rand -hex 24)"
  ok "generated a database password"
else
  ok "reusing the password from $APP_DIR/.env"
fi

if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='platform'\"" | grep -q 1; then
  su - postgres -c "psql -qc \"ALTER ROLE platform WITH LOGIN PASSWORD '$PG_PASSWORD'\"" >/dev/null
  ok "role 'platform' updated"
else
  su - postgres -c "psql -qc \"CREATE ROLE platform WITH LOGIN PASSWORD '$PG_PASSWORD'\"" >/dev/null
  ok "role 'platform' created"
fi

if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='platform'\"" | grep -q 1; then
  ok "database 'platform' already exists"
else
  su - postgres -c "createdb -O platform platform" >/dev/null
  ok "database 'platform' created"
fi

# ── App directory ────────────────────────────────────────────────────────────

step "Installing to $APP_DIR"

mkdir -p "$APP_DIR"
# Copies everything except node_modules and .env — the first is rebuilt by
# npm ci, the second must never be clobbered by a deploy.
SRC="$(cd "$(dirname "$0")/.." && pwd)"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .env \
  "$SRC"/ "$APP_DIR"/
ok "source copied"

# ── .env ─────────────────────────────────────────────────────────────────────

step "Configuration"

BOOTSTRAP_EMAIL="$(existing_env BOOTSTRAP_EMAIL)"
[[ -z "$BOOTSTRAP_EMAIL" ]] && BOOTSTRAP_EMAIL="${EMAIL:-admin@localhost}"

# Shared with every other panel on this box. Generated once and reused, because
# rotating it would sign everyone out of Brawl and SkinCraft at the same time.
SERVICE_TOKEN="$(existing_env SERVICE_TOKEN)"
if [[ -z "$SERVICE_TOKEN" ]]; then
  SERVICE_TOKEN="$(openssl rand -hex 32)"
  ok "generated the service token"
fi

# Everything under hamaprojects.com. Derived from the panel's own domain by
# dropping the first label, so config.example.com yields .example.com.
COOKIE_DOMAIN=".${DOMAIN#*.}"

BOOTSTRAP_PASSWORD="$(existing_env BOOTSTRAP_PASSWORD)"
FRESH_LOGIN=0
if [[ -z "$BOOTSTRAP_PASSWORD" ]]; then
  # 24 characters of base64url. Printed once at the end and stored in .env so a
  # re-run does not silently change the password you already wrote down.
  BOOTSTRAP_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  FRESH_LOGIN=1
  ok "generated the first owner password"
else
  ok "reusing the existing owner credentials"
fi

cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=8090
HOST=127.0.0.1
LOG_LEVEL=info

POSTGRES_URL=postgres://platform:$PG_PASSWORD@127.0.0.1:5432/platform
# Kept so a re-run can reuse it rather than rotating the database password.
POSTGRES_PASSWORD=$PG_PASSWORD

# First owner, created only when the users table is empty. It can never reset
# a live password or resurrect a deleted account.
BOOTSTRAP_EMAIL=$BOOTSTRAP_EMAIL
BOOTSTRAP_PASSWORD=$BOOTSTRAP_PASSWORD

# Session cookies carry Secure once TLS is on. Left true because certbot runs
# below; set false only if you deliberately serve this over plain HTTP.
SECURE_COOKIES=true

# One sign-in across every subdomain. Without this the cookie is scoped to this
# host and the other panels cannot see it.
COOKIE_DOMAIN=$COOKIE_DOMAIN

# Presented by the other services when they ask "who is this session".
SERVICE_TOKEN=$SERVICE_TOKEN

# Where a post-login redirect may return to. An open redirect on a login page
# is a phishing primitive, so only these are accepted.
ALLOWED_REDIRECT_HOSTS=${DOMAIN},api${COOKIE_DOMAIN},skincraft${COOKIE_DOMAIN}

CLIENT_CACHE_SECONDS=300
TRACK_FETCHES=true
RATE_WINDOW_MS=60000
RATE_MAX=600
EOF

chmod 600 "$APP_DIR/.env"
chown -R brawl:brawl "$APP_DIR"
ok ".env written (mode 600)"

ensure_home

step "Dependencies"
as_app_user bash -c "cd $APP_DIR && npm ci --omit=dev --no-audit --fund=false" \
  || die "npm ci failed — see the output above."
ok "installed"

step "Schema"
as_app_user bash -c "cd $APP_DIR && npm run migrate" \
  || die "migration failed."
ok "migrated"

# ── systemd ──────────────────────────────────────────────────────────────────

step "Service"
cp "$APP_DIR/deploy/platform-api.service" /etc/systemd/system/${SERVICE}.service
systemctl daemon-reload
systemctl enable --now ${SERVICE} >/dev/null 2>&1 || systemctl restart ${SERVICE}
sleep 2

if systemctl is-active --quiet ${SERVICE}; then
  ok "${SERVICE} running"
else
  journalctl -u ${SERVICE} -n 30 --no-pager || true
  die "${SERVICE} failed to start — log above."
fi

# ── nginx ────────────────────────────────────────────────────────────────────
#
# Port 80 only. certbot rewrites this file to add the 443 block and the
# redirect, so writing our own TLS block here would conflict with it.

step "nginx"

cat > /etc/nginx/sites-available/${SERVICE} <<EOF
upstream platform_api {
    server 127.0.0.1:8090;
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://platform_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    # Never throttled, so a load balancer cannot read the service as down.
    location = /health {
        access_log off;
        proxy_pass http://platform_api;
        proxy_set_header Host \$host;
    }
}
EOF

ln -sf /etc/nginx/sites-available/${SERVICE} /etc/nginx/sites-enabled/${SERVICE}
nginx -t >/dev/null || die "nginx config invalid — not reloading."
systemctl reload nginx
ok "nginx configured for ${DOMAIN}"

# ── TLS ──────────────────────────────────────────────────────────────────────

if [[ $WANT_TLS -eq 1 ]]; then
  step "TLS"

  RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  if [[ -z "$RESOLVED" ]]; then
    warn "$DOMAIN does not resolve yet — skipping certbot."
    warn "Add an A record, then: certbot --nginx -d $DOMAIN"
  else
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    ARGS=(--nginx -d "$DOMAIN" --redirect --agree-tos --non-interactive)
    [[ -n "$EMAIL" ]] && ARGS+=(-m "$EMAIL") || ARGS+=(--register-unsafely-without-email)

    if certbot "${ARGS[@]}"; then
      ok "certificate issued"
    else
      warn "certbot failed — the site still works over HTTP."
    fi
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────

cat <<EOF

${BOLD}platform-api is up.${RESET}

  Health:
    curl -s https://${DOMAIN}/health

  Dashboard:
    https://${DOMAIN}/

  What an app fetches:
    https://${DOMAIN}/v1/apps/<slug>/config?platform=ios

  ${BOLD}To put another panel behind this login${RESET}, add to its .env:
    PLATFORM_URL=https://${DOMAIN}
    SERVICE_TOKEN=${SERVICE_TOKEN}
    PLATFORM_APP_SLUG=<the app it administers>
EOF

if [[ $FRESH_LOGIN -eq 1 ]]; then
  cat <<EOF
  ${BOLD}Sign in with${RESET}
    email    : ${BOOTSTRAP_EMAIL}
    password : ${BOOTSTRAP_PASSWORD}

  Change it from the Team page once you are in. It is also in ${APP_DIR}/.env.
EOF
else
  cat <<EOF
  Credentials unchanged — they were already in ${APP_DIR}/.env.
EOF
fi

