#!/usr/bin/env bash
#
# Adds an unthrottled `location /wallpapers/` to the live nginx site.
#
# Why this is a script rather than "open the file and paste":
#
#  * After certbot runs there are usually **two** server blocks — the port 80
#    redirect and the port 443 one — and the block has to go in the one that
#    actually proxies. Getting that wrong looks like it worked and changes
#    nothing.
#  * `update.sh` deliberately does not rewrite nginx, because certbot owns that
#    file once TLS is on. So this stays a separate, explicit step.
#
# What it fixes: `location /` carries `limit_req zone=brawl_api rate=10r/s
# burst=40`. A gallery screen requests one file per visible tile, so opening it
# is dozens of requests in one second — past the burst, nginx returns 503 and
# the app renders a broken-image icon on every tile.
#
# Idempotent: running it twice changes nothing the second time.
#
# Usage:
#   sudo ./deploy/add-wallpaper-location.sh
#
set -euo pipefail

SITE=/etc/nginx/sites-available/brawl-api

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
[[ -f "$SITE" ]]  || die "No nginx site at $SITE — run setup.sh first."

if grep -q 'location /wallpapers/' "$SITE"; then
  ok "Already present — nothing to do."
  exit 0
fi

# The anchor. `location = /health` sits inside every server block that proxies,
# and never inside a bare redirect block — which makes it a better marker than
# counting braces.
if ! grep -q 'location = /health' "$SITE"; then
  die "Could not find 'location = /health' to anchor against. Add the block by hand — see the README."
fi

BACKUP="${SITE}.bak.$(date +%s)"
cp "$SITE" "$BACKUP"
ok "Backed up to $BACKUP"

# Inserted *before* each /health block. awk rather than sed: this is a
# multi-line insertion and sed's syntax for that differs between GNU and BSD.
awk '
  /location = \/health/ && !done {
    print "    # Wallpaper files, unthrottled. A sibling location inherits no"
    print "    # limit_req from '\''location /'\'', which is the point: a gallery"
    print "    # requests one file per tile, so one screen open is dozens of"
    print "    # requests in a second and most of them would 503."
    print "    location /wallpapers/ {"
    print "        proxy_pass http://brawl_api;"
    print "        proxy_set_header Host $host;"
    print "        proxy_set_header X-Real-IP $remote_addr;"
    print "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
    print "        proxy_set_header X-Forwarded-Proto $scheme;"
    print "        expires 7d;"
    print "        add_header Cache-Control \"public\";"
    print "    }"
    print ""
    done = 1
  }
  { print }
' "$BACKUP" > "$SITE"

if ! grep -q 'location /wallpapers/' "$SITE"; then
  cp "$BACKUP" "$SITE"
  die "Insertion produced no change — restored the backup."
fi
ok "Block inserted"

if nginx -t 2>/dev/null; then
  ok "nginx config valid"
else
  cp "$BACKUP" "$SITE"
  nginx -t || true
  die "Config invalid — restored the backup, nginx untouched."
fi

systemctl reload nginx
ok "nginx reloaded"

cat <<EOF

${BOLD}Done.${RESET} Check it from your machine:

  curl -sI https://api.hamaprojects.com/wallpapers/ | head -1

Then pull-to-refresh the Wallpapers screen — the app caches failed image loads,
so tiles that already failed keep showing the error icon until it refetches.
EOF
