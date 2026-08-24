#!/usr/bin/env bash
#
# Provisions a bare Ubuntu/Debian VPS to run the Brawl Stats API.
#
# Installs Node 22, Redis and nginx; creates a locked-down service user;
# writes .env; syncs brawler metadata; installs a systemd unit; configures the
# reverse proxy and firewall; optionally gets a TLS certificate.
#
# Safe to re-run — every step checks before acting, and an existing token in
# .env is preserved rather than overwritten.
#
# Usage (from the uploaded project directory, as root or with sudo):
#
#   sudo bash deploy/setup.sh
#   sudo bash deploy/setup.sh --token AAAA... --domain api.example.com
#   sudo bash deploy/setup.sh --token AAAA... --no-tls --yes
#
# Flags:
#   --token <t>     Supercell API token (prompted if omitted)
#   --domain <d>    Domain for nginx + TLS. Omit to serve plain HTTP on port 80
#   --api-key <k>   Shared secret clients must send. Omit to run the API open
#   --no-tls        Skip certbot even when a domain is given
#   --no-firewall   Skip ufw configuration
#   --yes           Don't prompt; fail instead of asking

set -euo pipefail

# ── Presentation ─────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

step()  { echo; echo "${BOLD}${BLUE}==>${RESET} ${BOLD}$*${RESET}"; }
ok()    { echo "    ${GREEN}✓${RESET} $*"; }
warn()  { echo "    ${YELLOW}!${RESET} $*"; }
info()  { echo "      $*"; }
die()   { echo; echo "${RED}✗ $*${RESET}" >&2; exit 1; }

# Runs a command as the unprivileged service user.
#
# `runuser` is preferred over `sudo`: it ships with util-linux so it's always
# present, needs no password, and is the correct tool for root→user. Minimal
# Debian images often have no sudo at all.
#
# HOME=/tmp because the service user has no home directory and npm needs
# somewhere writable for its cache.
as_app_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- env HOME=/tmp "$@"
  else
    sudo -u "$APP_USER" env HOME=/tmp "$@"
  fi
}

# ── Defaults ─────────────────────────────────────────────────────────────────

APP_DIR=/opt/brawl-vps
APP_USER=brawl
NODE_MAJOR=22
SERVICE=brawl-api

TOKEN=''
DOMAIN=''
API_KEY=''
WANT_TLS=1
WANT_FIREWALL=1
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)       TOKEN="${2:-}"; shift 2 ;;
    --domain)      DOMAIN="${2:-}"; shift 2 ;;
    --api-key)     API_KEY="${2:-}"; shift 2 ;;
    --no-tls)      WANT_TLS=0; shift ;;
    --no-firewall) WANT_FIREWALL=0; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    # Prints the header comment block as usage. Range ends at the last flag
    # line — widen it if you add more documentation above `set -euo pipefail`.
    -h|--help)     sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "Unknown flag: $1  (try --help)" ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────

step "Checking environment"

[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash deploy/setup.sh"

command -v apt-get >/dev/null 2>&1 \
  || die "This script targets Debian/Ubuntu (apt-get not found).
      For other distros, follow the manual steps in README.md."

# Must be run from the project directory — that's where the source is copied from.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SRC_DIR/package.json" ]] \
  || die "Can't find package.json.
      Upload the project first, then run this from inside it:
        scp -r brawl-vps root@YOUR_VPS:/tmp/
        ssh root@YOUR_VPS 'cd /tmp/brawl-vps && bash deploy/setup.sh'"

grep -q '"name": *"brawl-vps"' "$SRC_DIR/package.json" \
  || die "$SRC_DIR does not look like the brawl-vps project."

. /etc/os-release 2>/dev/null || true
ok "${PRETTY_NAME:-Debian-family} · $(uname -m)"
ok "source: $SRC_DIR"

PUBLIC_IP="$(curl -4 -fsS --max-time 10 ifconfig.me 2>/dev/null || echo '')"
if [[ -n "$PUBLIC_IP" ]]; then
  ok "public IPv4: ${BOLD}${PUBLIC_IP}${RESET}"
else
  warn "Could not determine public IP — you'll need it for the token"
fi

# ── Token ────────────────────────────────────────────────────────────────────

step "Supercell API token"

# Reads a value out of the existing .env, so re-running preserves generated
# secrets instead of silently rotating them. A regenerated database password
# would leave the app unable to log in to its own data.
existing_env() {
  [[ -f "$APP_DIR/.env" ]] || return 0
  grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true
}

# Re-running shouldn't force the token to be re-entered.
EXISTING_TOKEN="$(existing_env BRAWL_API_TOKEN)"

if [[ -z "$TOKEN" && -n "$EXISTING_TOKEN" ]]; then
  TOKEN="$EXISTING_TOKEN"
  ok "reusing token from existing $APP_DIR/.env"
fi

if [[ -z "$TOKEN" ]]; then
  if [[ $ASSUME_YES -eq 1 ]]; then
    die "No token. Pass --token, or drop --yes to be prompted."
  fi
  echo
  info "Create a key at ${BOLD}https://developer.brawlstars.com/#/account${RESET}"
  info "It is IP-locked — enter this exact IP as the allowed address:"
  info ""
  info "        ${BOLD}${PUBLIC_IP:-<run: curl -4 ifconfig.me>}${RESET}"
  info ""
  info "A token bound to any other IP returns 403 on every request."
  echo
  read -rsp "    Paste token (hidden): " TOKEN
  echo
  [[ -n "$TOKEN" ]] || die "No token entered."
fi

# Supercell tokens are long JWTs; a short string is almost certainly a paste error.
if [[ ${#TOKEN} -lt 100 ]]; then
  warn "Token is only ${#TOKEN} chars — these are normally 500+. Check the paste."
fi
ok "token accepted (${#TOKEN} chars)"

# ── Packages ─────────────────────────────────────────────────────────────────

step "Installing system packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg jq >/dev/null
ok "base tools"

# Node: distro packages are usually far too old (Ubuntu 22.04 ships Node 12),
# so install from NodeSource unless a new enough version is already present.
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$CURRENT_MAJOR" -ge 20 ]]; then
    NEED_NODE=0
    ok "node $(node -v) already installed"
  else
    warn "node $(node -v) is too old (need 20+), upgrading"
  fi
fi

if [[ $NEED_NODE -eq 1 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 \
    || die "NodeSource setup failed. Install Node ${NODE_MAJOR} manually and re-run."
  apt-get install -y -qq nodejs >/dev/null
  ok "node $(node -v)"
fi

apt-get install -y -qq redis-server nginx postgresql postgresql-contrib >/dev/null
ok "redis + nginx + postgres"

if [[ -n "$DOMAIN" && $WANT_TLS -eq 1 ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  ok "certbot"
fi

# ── Redis ────────────────────────────────────────────────────────────────────

step "Configuring Redis"

# Cache-only workload: cap memory and evict LRU rather than letting Redis grow
# until the kernel OOM-kills it. No persistence — all of this is rebuildable.
REDIS_CONF=/etc/redis/redis.conf
if [[ -f "$REDIS_CONF" ]] && ! grep -q '# brawl-vps' "$REDIS_CONF"; then
  cat >> "$REDIS_CONF" <<'EOF'

# brawl-vps — cache-only tuning
maxmemory 256mb
maxmemory-policy allkeys-lru
save ""
appendonly no
EOF
  ok "capped at 256mb, allkeys-lru, persistence off"
else
  ok "already configured"
fi

systemctl enable --now redis-server >/dev/null 2>&1 || systemctl enable --now redis >/dev/null 2>&1 || true
if redis-cli ping >/dev/null 2>&1; then
  ok "redis responding"
else
  warn "redis not responding — the app will fall back to in-memory cache"
fi

# ── Service user + files ─────────────────────────────────────────────────────

step "Creating service user and deploying files"

if id "$APP_USER" >/dev/null 2>&1; then
  ok "user $APP_USER exists"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "created system user $APP_USER (no login shell)"
fi

mkdir -p "$APP_DIR"

# Copy source, but never clobber .env or the data dir on a re-run.
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  cp -r "$SRC_DIR/src" "$APP_DIR/"
  cp "$SRC_DIR/package.json" "$APP_DIR/"
  [[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
  cp -r "$SRC_DIR/deploy" "$APP_DIR/"
  [[ -f "$SRC_DIR/README.md" ]] && cp "$SRC_DIR/README.md" "$APP_DIR/"

  mkdir -p "$APP_DIR/data"
  # The hypercharge list is hand-maintained; don't overwrite local edits.
  if [[ -f "$SRC_DIR/data/hypercharge-overrides.json" && ! -f "$APP_DIR/data/hypercharge-overrides.json" ]]; then
    cp "$SRC_DIR/data/hypercharge-overrides.json" "$APP_DIR/data/"
  fi
  ok "source deployed to $APP_DIR"
else
  ok "already running from $APP_DIR"
fi

# ── .env ─────────────────────────────────────────────────────────────────────

step "Provisioning Postgres"

# Preserved across re-runs: rotating this would lock the app out of its own
# database, and the schema holds crawl history that cannot be re-fetched.
PG_PASSWORD="$(existing_env POSTGRES_URL | sed -n 's#.*://brawl:\([^@]*\)@.*#\1#p')"

if [[ -z "$PG_PASSWORD" ]]; then
  PG_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  ok "generated a database password"
else
  ok "reusing the existing database password"
fi

systemctl enable --now postgresql >/dev/null 2>&1 || true

# Role and database, both idempotent. `psql -c` as the postgres system user is
# the standard path and needs no password.
if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='brawl'\"" | grep -q 1; then
  su - postgres -c "psql -qc \"ALTER ROLE brawl WITH LOGIN PASSWORD '$PG_PASSWORD'\"" >/dev/null
  ok "role 'brawl' updated"
else
  su - postgres -c "psql -qc \"CREATE ROLE brawl WITH LOGIN PASSWORD '$PG_PASSWORD'\"" >/dev/null
  ok "role 'brawl' created"
fi

if su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='brawl'\"" | grep -q 1; then
  ok "database 'brawl' already exists"
else
  su - postgres -c "createdb -O brawl brawl" >/dev/null
  ok "database 'brawl' created"
fi

POSTGRES_URL="postgres://brawl:$PG_PASSWORD@127.0.0.1:5432/brawl"

# ── Admin key ────────────────────────────────────────────────────────────────

step "Admin panel key"

ADMIN_KEY="$(existing_env ADMIN_KEY)"
if [[ -z "$ADMIN_KEY" ]]; then
  ADMIN_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  ok "generated an admin key"
else
  ok "reusing the existing admin key"
fi

step "Writing configuration"

if [[ -z "$API_KEY" && $ASSUME_YES -eq 0 && ! -f "$APP_DIR/.env" ]]; then
  echo
  info "An API key stops strangers pointing their app at your VPS and"
  info "burning your Supercell rate limit. Leave blank to run open."
  read -rp "    Optional API key (blank = none): " API_KEY || true
fi

cat > "$APP_DIR/.env" <<EOF
# Generated by deploy/setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Re-running setup.sh preserves BRAWL_API_TOKEN.

BRAWL_API_TOKEN=$TOKEN

NODE_ENV=production
PORT=8080
HOST=127.0.0.1

PUBLIC_API_KEY=$API_KEY

REDIS_URL=redis://127.0.0.1:6379
REDIS_PREFIX=bs:

TTL_PLAYER=60
TTL_BATTLELOG=60
TTL_CLUB=300
TTL_BRAWLERS=86400
TTL_EVENTS=900
TTL_META=3600
TTL_NOT_FOUND=120

RATE_WINDOW_MS=60000
RATE_MAX=120

CRAWLER_ENABLED=true
CRAWLER_INTERVAL_MIN=60
CRAWLER_REGIONS=global
CRAWLER_PLAYERS=200
CRAWLER_CONCURRENCY=4
CRAWLER_MIN_SAMPLE=20

BRAWLER_META_URL=https://api.brawlapi.com/v1/brawlers
BRAWLER_META_REFRESH_H=24

# Durable storage for crawl history. Preserved across re-runs of setup.sh —
# rotating the password would lock the app out of data it cannot re-fetch.
POSTGRES_URL=$POSTGRES_URL
POSTGRES_POOL=8
POSTGRES_RETENTION_DAYS=45

# Guards /admin. Unset would disable the panel entirely rather than open it.
ADMIN_KEY=$ADMIN_KEY

LOG_LEVEL=info
EOF

chmod 600 "$APP_DIR/.env"
ok ".env written (mode 600 — contains the token)"
[[ -n "$API_KEY" ]] && ok "API key required for client requests" || warn "API open (no PUBLIC_API_KEY)"

# ── Dependencies ─────────────────────────────────────────────────────────────

step "Installing dependencies"

cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  # Output is captured rather than discarded. `npm ci` fails flatly when
  # package.json and the lock file disagree, and its message says exactly which
  # package is missing — throwing that away turns a ten-second fix into a hunt.
  if ! NPM_OUT="$(npm ci --omit=dev --no-audit --fund=false 2>&1)"; then
    echo "$NPM_OUT" | tail -20
    die "npm ci failed — output above. If it mentions the lock file being out of sync, run 'npm install' in $APP_DIR to regenerate it."
  fi
else
  if ! NPM_OUT="$(npm install --omit=dev --no-audit --fund=false 2>&1)"; then
    echo "$NPM_OUT" | tail -20
    die "npm install failed — output above."
  fi
fi
ok "$(ls node_modules | wc -l) packages"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── Database schema ──────────────────────────────────────────────────────────

step "Applying database schema"

# The server also migrates on boot; doing it here means a failure surfaces now,
# with the output in front of you, rather than in a log after the fact.
if as_app_user npm run --silent db:migrate 2>&1 | tail -3; then
  ok "schema ready"
else
  warn "Migration failed. The API still runs — Postgres is optional — but"
  info "meta history and the admin panel will be unavailable. Retry with:"
  info "  cd $APP_DIR && runuser -u $APP_USER -- npm run db:migrate"
fi

# ── Brawler metadata ─────────────────────────────────────────────────────────

step "Syncing brawler metadata"

# Run as the service user so the written file has the right owner.
if as_app_user npm run --silent sync:brawlers 2>&1 | tail -3; then
  if [[ -f "$APP_DIR/data/brawler-meta.json" ]]; then
    COUNT="$(jq -r '.count // 0' "$APP_DIR/data/brawler-meta.json" 2>/dev/null || echo '?')"
    ok "$COUNT brawlers (rarity, class, portraits, gadget/star-power totals)"
  fi
else
  warn "Metadata sync failed. The API still works, but brawlers will show as"
  info "Common / Damage Dealer with no portraits. Retry later with:"
  info "  cd $APP_DIR && runuser -u $APP_USER -- npm run sync:brawlers"
fi

# ── Upstream check ───────────────────────────────────────────────────────────

step "Verifying the Supercell token"

# This is where an IP-allowlist mistake surfaces, so it gets a dedicated check
# with an actionable message rather than being left to first request.
HTTP_CODE="$(curl -s -o /tmp/bs-probe.json -w '%{http_code}' --max-time 15 \
  -H "Authorization: Bearer $TOKEN" \
  https://api.brawlstars.com/v1/brawlers 2>/dev/null || echo 000)"

case "$HTTP_CODE" in
  200)
    ok "token valid — upstream reachable"
    ;;
  403)
    echo
    warn "${BOLD}403 Forbidden — the token's allowed IP does not match this server.${RESET}"
    info ""
    info "This server's public IPv4 is: ${BOLD}${PUBLIC_IP:-unknown}${RESET}"
    info "Create a new key for that exact IP at:"
    info "  https://developer.brawlstars.com/#/account"
    info "Then:  sudo nano $APP_DIR/.env   (update BRAWL_API_TOKEN)"
    info "       sudo systemctl restart $SERVICE"
    info ""
    warn "Continuing setup — everything else will be configured."
    ;;
  000)
    warn "Could not reach api.brawlstars.com (network/DNS). Check later with:"
    info "  cd $APP_DIR && runuser -u $APP_USER -- npm run health -- YOURTAG"
    ;;
  *)
    warn "Upstream returned HTTP $HTTP_CODE"
    [[ -s /tmp/bs-probe.json ]] && info "$(head -c 200 /tmp/bs-probe.json)"
    ;;
esac
rm -f /tmp/bs-probe.json

# ── systemd ──────────────────────────────────────────────────────────────────

step "Installing systemd service"

NODE_BIN="$(command -v node)"

# The shipped unit hardcodes /usr/bin/node; rewrite it to wherever node actually
# is, since systemd has no PATH from your shell profile.
sed "s|^ExecStart=.*|ExecStart=${NODE_BIN} src/server.js|" \
  "$APP_DIR/deploy/${SERVICE}.service" > "/etc/systemd/system/${SERVICE}.service"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
ok "unit installed (ExecStart=${NODE_BIN} src/server.js)"

# Give it a moment to bind before probing.
sleep 4

if systemctl is-active --quiet "$SERVICE"; then
  ok "service active"
else
  echo
  journalctl -u "$SERVICE" -n 25 --no-pager || true
  die "Service failed to start — log above. Common causes: bad token format, port 8080 in use."
fi

HEALTH="$(curl -s --max-time 5 http://127.0.0.1:8080/health || echo '')"
if [[ -n "$HEALTH" ]]; then
  ok "health endpoint responding"
  info "$(echo "$HEALTH" | jq -c '{cache: .cache.backend, brawlers: .brawlerMeta.count}' 2>/dev/null || echo "$HEALTH")"
else
  warn "health endpoint not responding yet"
fi

# ── nginx ────────────────────────────────────────────────────────────────────

step "Configuring nginx"

# limit_req_zone is only valid in the http block. Injected into nginx.conf
# rather than the site file, which is why this can't just be a template copy.
if ! grep -qr 'zone=brawl_api' /etc/nginx/nginx.conf /etc/nginx/conf.d/ 2>/dev/null; then
  echo 'limit_req_zone $binary_remote_addr zone=brawl_api:10m rate=10r/s;' \
    > /etc/nginx/conf.d/brawl-limit.conf
  ok "rate-limit zone added (10 r/s per IP)"
else
  ok "rate-limit zone present"
fi

SERVER_NAME="${DOMAIN:-_}"

# Port 80 only. certbot rewrites this file to add the 443 block and the
# redirect, so writing our own TLS server block here would conflict with it.
cat > /etc/nginx/sites-available/${SERVICE} <<EOF
upstream brawl_api {
    server 127.0.0.1:8080;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    access_log /var/log/nginx/brawl-api.access.log;
    error_log  /var/log/nginx/brawl-api.error.log;

    client_max_body_size 16k;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        limit_req zone=brawl_api burst=40 nodelay;
        limit_req_status 429;

        proxy_pass http://brawl_api;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        # The app sets 'trust proxy 1' and reads this to rate-limit per real
        # client IP. Without it every request looks like 127.0.0.1.
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";

        proxy_connect_timeout 5s;
        proxy_send_timeout    20s;
        proxy_read_timeout    20s;
        proxy_pass_header     X-Cache;
    }

    # No limit_req here on purpose. It's declared inside 'location /', and this
    # is a SIBLING location rather than a nested one, so it never inherits the
    # limit — health checks are exempt without needing to disable anything.
    # (There is no 'limit_req off;' in nginx: that directive takes no 'off'
    # parameter and fails config validation with 'invalid parameter "off"'.)
    location = /health {
        access_log off;
        proxy_pass http://brawl_api;
        proxy_set_header Host \$host;
    }

    # Wallpaper files, unthrottled for the same reason as /health — a sibling
    # location inherits no limit_req. A gallery requests one file per visible
    # tile, so one screen open is dozens of requests in a second; against
    # rate=10r/s that is a 503 on most of them and a broken-image icon on every
    # tile. Static bytes from local disk, and nothing to do with the upstream
    # API the limit protects.
    location /wallpapers/ {
        proxy_pass http://brawl_api;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        expires 7d;
        add_header Cache-Control "public";
    }
}
EOF

ln -sf /etc/nginx/sites-available/${SERVICE} /etc/nginx/sites-enabled/${SERVICE}

# Debian's default site claims server_name _ on port 80 and would shadow ours.
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  ok "removed nginx default site (was shadowing port 80)"
fi

if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  ok "nginx configured for server_name '${SERVER_NAME}'"
else
  nginx -t || true
  die "nginx config test failed — see output above."
fi

# ── Firewall ─────────────────────────────────────────────────────────────────

if [[ $WANT_FIREWALL -eq 1 ]] && command -v ufw >/dev/null 2>&1; then
  step "Configuring firewall"

  # Allow SSH BEFORE enabling ufw. Enabling first would drop the session and
  # lock you out of the box — the one genuinely unrecoverable mistake here.
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ok "SSH allowed (before enabling — avoids locking you out)"

  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "HTTP/HTTPS allowed"

  # 8080 is deliberately NOT opened: the app binds 127.0.0.1 and nginx proxies
  # to it, so exposing it would only bypass TLS and rate limiting.
  if ufw status | grep -q 'Status: active'; then
    ok "ufw already active"
  else
    ufw --force enable >/dev/null 2>&1 && ok "ufw enabled" || warn "could not enable ufw"
  fi
fi

# ── TLS ──────────────────────────────────────────────────────────────────────

BASE_URL="http://${DOMAIN:-$PUBLIC_IP}"

if [[ -n "$DOMAIN" && $WANT_TLS -eq 1 ]]; then
  step "Requesting TLS certificate"

  # Certbot's HTTP-01 challenge needs the domain already pointing here.
  RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || echo '')"
  if [[ -n "$PUBLIC_IP" && -n "$RESOLVED" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
    warn "$DOMAIN resolves to $RESOLVED, not $PUBLIC_IP"
    info "DNS must point here before certbot can validate. Skipping."
    info "Once DNS propagates:  sudo certbot --nginx -d $DOMAIN"
  elif [[ -z "$RESOLVED" ]]; then
    warn "$DOMAIN does not resolve yet. Skipping TLS."
    info "Once DNS propagates:  sudo certbot --nginx -d $DOMAIN"
  else
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
         --register-unsafely-without-email --redirect >/dev/null 2>&1; then
      ok "certificate issued, HTTP redirects to HTTPS"
      ok "auto-renewal via certbot.timer"
      BASE_URL="https://${DOMAIN}"
    else
      warn "certbot failed. Run manually to see why:"
      info "  sudo certbot --nginx -d $DOMAIN"
    fi
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo
echo "${BOLD}${GREEN}────────────────────────────────────────────────────────────${RESET}"
echo "${BOLD}${GREEN} Setup complete${RESET}"
echo "${BOLD}${GREEN}────────────────────────────────────────────────────────────${RESET}"
echo
echo "  ${BOLD}Service${RESET}     $SERVICE  ($(systemctl is-active $SERVICE))"
echo "  ${BOLD}Directory${RESET}   $APP_DIR"
echo "  ${BOLD}Base URL${RESET}    ${BASE_URL}/v1"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "  ${BOLD}${YELLOW}Token${RESET}       ${YELLOW}NOT VERIFIED (HTTP $HTTP_CODE) — see the 403 note above${RESET}"
fi
echo
echo "  ${BOLD}Point the app at it:${RESET}"
echo "    flutter run \\"
echo "      --dart-define=BRAWL_API_BASE=${BASE_URL}/v1${API_KEY:+ \\}"
[[ -n "$API_KEY" ]] && echo "      --dart-define=BRAWL_API_KEY=${API_KEY}"
echo
echo "  ${BOLD}Verify:${RESET}"
echo "    curl -s ${BASE_URL}/health | jq"
echo "    cd $APP_DIR && runuser -u $APP_USER -- npm run health -- YOURTAG"
echo
echo "  ${BOLD}Admin panel:${RESET}"
echo "    ${BASE_URL}/admin?key=${ADMIN_KEY}"
echo "    ${YELLOW}Save that key — it is in $APP_DIR/.env and nowhere else.${RESET}"
echo
echo "  ${BOLD}Operate:${RESET}"
echo "    sudo journalctl -u $SERVICE -f          # logs"
echo "    sudo systemctl restart $SERVICE         # restart"
echo "    sudo bash $APP_DIR/deploy/update.sh     # redeploy after code changes"
echo
echo "  The tier list is empty until the first crawl finishes (~1 min after boot),"
echo "  and the panel's charts need a second crawl before they have a trend."
echo
