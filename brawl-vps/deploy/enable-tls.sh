#!/usr/bin/env bash
#
# Puts HTTPS in front of an already-running install.
#
# `setup.sh --domain` does this during a fresh provision. This exists for the
# case that actually happens: the box has been serving plain HTTP for weeks,
# there is real data on it, and re-running the full provisioner to get a
# certificate is more risk than the job deserves.
#
# Why it matters beyond good practice: iOS App Transport Security blocks
# cleartext HTTP outright. An app pointed at http:// launches and then fails to
# load anything on a real device, so this is the gate on shipping to the App
# Store at all.
#
# Usage:
#   sudo ./deploy/enable-tls.sh --domain api.example.com --email you@example.com
#
set -euo pipefail

SERVICE=brawl-api
DOMAIN=""
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
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
[[ -n "$DOMAIN" ]] || die "--domain is required, e.g. --domain api.example.com"

# ── Preflight ────────────────────────────────────────────────────────────────
#
# Every one of these failing produces a confusing certbot error several minutes
# later, so they are checked up front where the message can say what to do.

step "Checking prerequisites"

command -v nginx >/dev/null || die "nginx is not installed — run setup.sh first."
systemctl is-active --quiet "$SERVICE" \
  || warn "$SERVICE is not running; TLS will still be configured."

[[ -f "/etc/nginx/sites-available/${SERVICE}" ]] \
  || die "No nginx site for ${SERVICE}. Run setup.sh first."

# A certificate issued onto a port nobody can reach is the most demoralising way
# for this to fail: certbot reports success and the app still cannot connect.
step "Checking the firewall"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  for port in 80 443; do
    if ufw status | grep -qE "^${port}(/tcp)?[[:space:]]+ALLOW"; then
      ok "port ${port} open"
    else
      warn "port ${port} is not open in ufw — opening it"
      ufw allow "${port}/tcp" >/dev/null 2>&1 || warn "could not open ${port}"
    fi
  done
else
  ok "ufw not active — nothing to open here"
fi

# Let's Encrypt validates over HTTP on port 80, so the DNS record has to point
# here *before* this runs. Checking saves a rate-limited failed attempt.
step "Checking DNS"

SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"

if [[ -z "$RESOLVED" ]]; then
  die "$DOMAIN does not resolve. Add an A record pointing at ${SERVER_IP:-this server} and wait for it to propagate."
elif [[ -n "$SERVER_IP" && "$RESOLVED" != "$SERVER_IP" ]]; then
  warn "$DOMAIN resolves to $RESOLVED but this server is $SERVER_IP."
  warn "If you are behind a proxy (Cloudflare) that is expected; otherwise certbot will fail."
else
  ok "$DOMAIN -> $RESOLVED"
fi

# ── certbot ──────────────────────────────────────────────────────────────────

step "Installing certbot"
apt-get update -qq
apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
ok "certbot"

step "Pointing nginx at $DOMAIN"

# The provisioned site listens on port 80 with a catch-all server_name. certbot
# matches on server_name, so it has to be the real domain before we ask.
sed -i "s/^\(\s*server_name\).*/\1 ${DOMAIN};/" \
  "/etc/nginx/sites-available/${SERVICE}"

if ! grep -q "server_name ${DOMAIN};" "/etc/nginx/sites-available/${SERVICE}"; then
  # The provisioned file may have had no server_name at all.
  sed -i "0,/listen \[::\]:80;/s//listen [::]:80;\n    server_name ${DOMAIN};/" \
    "/etc/nginx/sites-available/${SERVICE}"
fi

nginx -t >/dev/null || die "nginx config is invalid — not reloading."
systemctl reload nginx
ok "nginx reloaded"

step "Requesting the certificate"

CERTBOT_ARGS=(--nginx -d "$DOMAIN" --redirect --agree-tos --non-interactive)
if [[ -n "$EMAIL" ]]; then
  CERTBOT_ARGS+=(-m "$EMAIL")
else
  # Without an address Let's Encrypt cannot warn about an expiry that failed to
  # renew, which is the one email worth receiving.
  warn "No --email given; you will get no expiry warnings."
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

if certbot "${CERTBOT_ARGS[@]}"; then
  ok "certificate issued and nginx switched to 443 with a redirect"
else
  die "certbot failed. Check that port 80 is open and $DOMAIN points here."
fi

# ── Renewal ──────────────────────────────────────────────────────────────────
#
# The package ships a timer, but an install where it is masked or disabled is a
# certificate that silently expires in 90 days and takes the app down with it.

step "Checking automatic renewal"

if systemctl list-timers --all 2>/dev/null | grep -q certbot; then
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  ok "certbot.timer is active"
else
  warn "No certbot timer found. Add a cron entry: 0 3 * * * certbot renew --quiet"
fi

certbot renew --dry-run >/dev/null 2>&1 \
  && ok "renewal dry-run passed" \
  || warn "renewal dry-run failed — check 'certbot renew --dry-run' by hand"

# ── Done ─────────────────────────────────────────────────────────────────────

cat <<EOF

${BOLD}HTTPS is on.${RESET}

  Verify:
    curl -fsS https://${DOMAIN}/health | head -c 200

  Build the app against it — this is the part that unblocks iOS:
    flutter build ipa --dart-define=BRAWL_API_BASE=https://${DOMAIN}/v1

  The legal pages App Store Connect asks for:
    https://${DOMAIN}/privacy
    https://${DOMAIN}/terms

  The old http://<ip> URL keeps working and now redirects to HTTPS, so an
  already-installed build does not break the moment you run this.
EOF
