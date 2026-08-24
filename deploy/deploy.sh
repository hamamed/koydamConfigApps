#!/usr/bin/env bash
#
# Deploys from GitHub. No upload, no archive.
#
# Run it on the VPS with no arguments and it updates every service that is
# already installed:
#
#   sudo /opt/deploy.sh
#
# Or name one:  sudo /opt/deploy.sh brawl | platform | skincraft
#
# The first install of each still uses its own setup script — this only knows
# how to move an existing install forward, which is the thing you do weekly.
#
set -euo pipefail

REPOS_DIR=/opt/src

# repo → install directory → post-update command
declare -A REPO=(
  [platform]=https://github.com/hamamed/platform-api.git
  [brawl]=https://github.com/hamamed/brawl-vps.git
  [skincraft]=https://github.com/hamamed/skincraft.git
)
declare -A TARGET=(
  [platform]=/opt/platform-api
  [brawl]=/opt/brawl-vps
  [skincraft]=/opt/skincraft
)
declare -A UNIT=(
  [platform]=platform-api
  [brawl]=brawl-api
  [skincraft]=skincraft
)

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
command -v git >/dev/null || die "git is not installed."

# HOME because the service user is created with --no-create-home and npm needs
# somewhere writable for its cache.
as_app_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u brawl -- env HOME=/home/brawl "$@"
  else
    sudo -u brawl env HOME=/home/brawl "$@"
  fi
}

mkdir -p /home/brawl && chown brawl:brawl /home/brawl && chmod 750 /home/brawl

deploy_one() {
  local name="$1"
  local repo="${REPO[$name]}"
  local target="${TARGET[$name]}"
  local unit="${UNIT[$name]}"
  local src="$REPOS_DIR/$name"

  if [[ ! -d "$target" ]]; then
    warn "$name is not installed at $target — run its setup script first. Skipping."
    return 0
  fi

  step "$name"

  # A bare checkout kept apart from the install directory. Cloning straight
  # over the install would put .git next to a live .env and make an accidental
  # `git clean` catastrophic.
  if [[ -d "$src/.git" ]]; then
    git -C "$src" fetch --quiet origin
    git -C "$src" reset --hard --quiet origin/HEAD 2>/dev/null \
      || git -C "$src" reset --hard --quiet origin/main
  else
    mkdir -p "$REPOS_DIR"
    git clone --quiet "$repo" "$src" || die "clone failed — is the repo public, or is a deploy key set up?"
  fi
  ok "source at $(git -C "$src" rev-parse --short HEAD)"

  # .env and any runtime data stay put. --delete keeps the install honest
  # otherwise: a file removed upstream should disappear here too.
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude .env \
    --exclude data --exclude storage --exclude wallpapers \
    "$src"/ "$target"/
  chown -R brawl:brawl "$target"
  ok "files synced"

  if [[ -f "$target/package-lock.json" ]]; then
    as_app_user bash -c "cd $target && npm ci --omit=dev --no-audit --fund=false" \
      || die "npm ci failed"
  else
    as_app_user bash -c "cd $target && npm install --omit=dev --no-audit --fund=false" \
      || die "npm install failed"
  fi
  ok "dependencies"

  if as_app_user bash -c "cd $target && npm run --silent migrate" 2>/dev/null; then
    ok "migrated"
  fi

  systemctl restart "$unit"
  sleep 2
  if systemctl is-active --quiet "$unit"; then
    ok "$unit running"
  else
    journalctl -u "$unit" -n 25 --no-pager || true
    die "$unit failed to start"
  fi
}

# SkinCraft's theme and SSO client live in this repo, not its own, and a fresh
# checkout would otherwise restore the upstream dark theme and local login.
reapply_skincraft_overlay() {
  local overlay="$REPOS_DIR/platform/deploy"
  [[ -d "$overlay/skincraft-theme" ]] || return 0
  [[ -d /opt/skincraft ]] || return 0

  cp "$overlay/skincraft-theme/css/"*.css /opt/skincraft/public/css/
  cp "$overlay/skincraft-theme/views/partials/head.ejs" /opt/skincraft/views/partials/
  [[ -d "$overlay/skincraft-auth" ]] && cp "$overlay/skincraft-auth/"*.js /opt/skincraft/src/middleware/
  chown -R brawl:brawl /opt/skincraft
  ok "skincraft overlay reapplied"
}

TARGETS=("${@:-platform brawl skincraft}")
# shellcheck disable=SC2206
TARGETS=(${TARGETS[@]})

for name in "${TARGETS[@]}"; do
  [[ -n "${REPO[$name]:-}" ]] || die "Unknown target '$name'. Use: platform, brawl, skincraft."
  deploy_one "$name"
  [[ "$name" == "skincraft" ]] && { reapply_skincraft_overlay; systemctl restart skincraft; }
done

step "Health"
for url in \
  https://config.hamaprojects.com/health \
  https://api.hamaprojects.com/health \
  https://skincraft.hamaprojects.com/api/v1/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
  [[ "$code" == 200 ]] && ok "$url" || warn "$url → $code"
done
