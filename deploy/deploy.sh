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
# And to check nothing has been hand-edited on the box:
#
#   sudo /opt/deploy.sh verify
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

# ── Overlays ────────────────────────────────────────────────────────────────
#
# Some files that live inside Brawl and SkinCraft are owned by this repo: the
# SSO client both of them import, and the shared stylesheet all three panels
# render. Keeping one copy here and pushing it outward is what stops three
# design systems slowly becoming three different design systems.
#
# Each service declares what it receives in deploy/overlays/<name>/manifest.

# The overlay is only as current as this repo's checkout. Deploying just one
# service must not hand it files from whenever platform was last pulled.
refresh_overlay_source() {
  local src="$REPOS_DIR/platform"
  if [[ -d "$src/.git" ]]; then
    git -C "$src" fetch --quiet origin || warn "could not refresh overlay source"
    git -C "$src" reset --hard --quiet origin/HEAD 2>/dev/null       || git -C "$src" reset --hard --quiet origin/main || true
  else
    mkdir -p "$REPOS_DIR"
    git clone --quiet "${REPO[platform]}" "$src"       || die "overlay source unavailable — clone of platform-api failed"
  fi
}

apply_overlay() {
  local name="$1"
  local target="${TARGET[$name]}"
  local deploy_dir="$REPOS_DIR/platform/deploy"
  local manifest="$deploy_dir/overlays/$name/manifest"

  [[ -f "$manifest" ]] || return 0
  [[ -d "$target"   ]] || return 0

  local applied=0 src dest
  while read -r src dest; do
    # Blank lines and comments.
    [[ -z "$src" || "$src" == \#* ]] && continue

    if [[ ! -f "$deploy_dir/$src" ]]; then
      warn "overlay source missing: $src"
      continue
    fi

    mkdir -p "$(dirname "$target/$dest")"
    cp "$deploy_dir/$src" "$target/$dest"
    applied=$((applied + 1))
  done < "$manifest"

  chown -R brawl:brawl "$target"
  ok "overlay applied ($applied files)"
}

# Reports drift instead of fixing it. The copies committed inside brawl-vps and
# skincraft exist so those repos boot from a bare clone; this is how you find
# out one of them has been edited in place and no longer matches the source.
verify_overlays() {
  local deploy_dir="$REPOS_DIR/platform/deploy"
  local drift=0

  for name in brawl skincraft; do
    local manifest="$deploy_dir/overlays/$name/manifest"
    local target="${TARGET[$name]}"
    [[ -f "$manifest" && -d "$target" ]] || continue

    while read -r src dest; do
      [[ -z "$src" || "$src" == \#* ]] && continue
      [[ -f "$deploy_dir/$src" && -f "$target/$dest" ]] || continue

      if ! cmp -s "$deploy_dir/$src" "$target/$dest"; then
        warn "$name: $dest differs from $src"
        drift=$((drift + 1))
      fi
    done < "$manifest"
  done

  [[ $drift -eq 0 ]] && ok "all overlay files match source"
  return 0
}

if [[ "${1:-}" == "verify" ]]; then
  step "Verifying overlays"
  refresh_overlay_source
  verify_overlays
  exit 0
fi

TARGETS=("${@:-platform brawl skincraft}")
# shellcheck disable=SC2206
TARGETS=(${TARGETS[@]})

for name in "${TARGETS[@]}"; do
  [[ -n "${REPO[$name]:-}" ]] || die "Unknown target '$name'. Use: platform, brawl, skincraft."
  deploy_one "$name"

  # After the sync, because rsync --delete would otherwise remove overlay
  # files that are not in the service's own repository.
  refresh_overlay_source
  if [[ -f "$REPOS_DIR/platform/deploy/overlays/$name/manifest" ]]; then
    apply_overlay "$name"
    systemctl restart "${UNIT[$name]}"
  fi
done

step "Health"
for url in \
  https://config.hamaprojects.com/health \
  https://api.hamaprojects.com/health \
  https://skincraft.hamaprojects.com/api/v1/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
  [[ "$code" == 200 ]] && ok "$url" || warn "$url → $code"
done
