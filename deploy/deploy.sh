#!/usr/bin/env bash
#
# Deploys every service on this box, from GitHub. No upload, no archive.
#
#   sudo /opt/deploy.sh                 everything in services.conf
#   sudo /opt/deploy.sh brawl           just one (any number of names)
#   sudo /opt/deploy.sh list            what is configured, and its state
#   sudo /opt/deploy.sh verify          report files hand-edited on the box
#   sudo /opt/deploy.sh rollback brawl 3a90b01
#   sudo /opt/deploy.sh --dry-run       say what would happen, change nothing
#
# What it will not touch: .env, and any data a service wrote itself —
# databases, uploads, wallpapers. Those are excluded from every sync.
#
# First installs still use each service's own setup script. This moves an
# existing install forward, which is the thing you do every week.
#
set -euo pipefail

REPOS_DIR=/opt/src
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER=brawl

# Never synced. A deploy that wiped uploads or a database would be a restore
# from a backup that does not exist.
PRESERVE=(node_modules .git .env data storage wallpapers uploads)

DRY_RUN=0

# ── Output ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '  %s.%s %s\n' "$DIM" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    info "would: $*"
    return 0
  fi
  "$@"
}

# ── The registry ────────────────────────────────────────────────────────────

CONF=""
for candidate in "$SELF_DIR/services.conf" \
                 "$REPOS_DIR/platform/deploy/services.conf" \
                 /opt/platform-api/deploy/services.conf; do
  [[ -f "$candidate" ]] && { CONF="$candidate"; break; }
done
[[ -n "$CONF" ]] || die "services.conf not found."

declare -a NAMES=()
declare -A REPO SUBDIR TARGET TYPE UNIT HEALTH OVERLAY BUILD ENABLED
declare -A FETCHED

parse_conf() {
  local current="" key value line
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Strip comments and surrounding whitespace.
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue

    if [[ "$line" =~ ^\[(.+)\]$ ]]; then
      current="${BASH_REMATCH[1]}"
      NAMES+=("$current")
      ENABLED[$current]=yes
      continue
    fi

    [[ -n "$current" ]] || continue
    [[ "$line" == *=* ]] || continue

    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    case "$key" in
      repo)    REPO[$current]="$value" ;;
      subdir)  SUBDIR[$current]="$value" ;;
      target)  TARGET[$current]="$value" ;;
      type)    TYPE[$current]="$value" ;;
      unit)    UNIT[$current]="$value" ;;
      health)  HEALTH[$current]="$value" ;;
      overlay) OVERLAY[$current]="$value" ;;
      build)   BUILD[$current]="$value" ;;
      enabled) ENABLED[$current]="$value" ;;
      *)       warn "$current: unknown key '$key'" ;;
    esac
  done < "$CONF"
}

parse_conf

[[ ${#NAMES[@]} -gt 0 ]] || die "no services defined in $CONF"

# Catch a typo in the config now, rather than half way through a deploy.
for n in "${NAMES[@]}"; do
  [[ -n "${REPO[$n]:-}"   ]] || die "[$n] has no repo"
  [[ -n "${TARGET[$n]:-}" ]] || die "[$n] has no target"
  case "${TYPE[$n]:-node}" in
    node)   [[ -n "${UNIT[$n]:-}" ]] || die "[$n] is type node but has no unit" ;;
    static) ;;
    *)      die "[$n] has unknown type '${TYPE[$n]}'" ;;
  esac
done

# ── Guards ──────────────────────────────────────────────────────────────────

need_root() {
  [[ $EUID -eq 0 ]] || die "Run with sudo."
  command -v git   >/dev/null || die "git is not installed."
  command -v rsync >/dev/null || die "rsync is not installed."
}

# HOME because the service user was created with --no-create-home and npm
# needs somewhere writable for its cache. Setting it via env alone does not
# survive runuser's PAM session, so the directory has to exist.
as_app_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- env HOME="/home/$APP_USER" "$@"
  else
    sudo -u "$APP_USER" env HOME="/home/$APP_USER" "$@"
  fi
}

ensure_home() {
  [[ $DRY_RUN -eq 1 ]] && return 0
  mkdir -p "/home/$APP_USER"
  chown "$APP_USER:$APP_USER" "/home/$APP_USER"
  chmod 750 "/home/$APP_USER"
}

# ── Source checkouts ────────────────────────────────────────────────────────
#
# Keyed by repository, not by service: several services live in one repo, and
# cloning it once per service would mean three copies that can disagree.

repo_slug() {
  local u="${1%/}"
  u="${u##*/}"
  echo "${u%.git}"
}

src_dir() { echo "$REPOS_DIR/$(repo_slug "${REPO[$1]}")"; }

# The directory inside the checkout this service is built from.
src_path() {
  local sub="${SUBDIR[$1]:-}"
  if [[ -z "$sub" || "$sub" == "." ]]; then
    src_dir "$1"
  else
    echo "$(src_dir "$1")/$sub"
  fi
}

# Kept apart from the install directory. Cloning over the install would put
# .git beside a live .env, where one careless `git clean` takes the secrets.
fetch_source() {
  local name="$1" ref="${2:-}"
  local src slug
  src="$(src_dir "$name")"
  slug="$(repo_slug "${REPO[$name]}")"

  # Once per repository per run. Without this a three-service monorepo would
  # be fetched and hard-reset three times, and a rollback undone by the next
  # service that shares the checkout.
  if [[ -z "$ref" && -n "${FETCHED[$slug]:-}" ]]; then
    return 0
  fi
  FETCHED[$slug]=1

  if [[ -d "$src/.git" ]]; then
    run git -C "$src" fetch --quiet --tags origin \
      || warn "fetch failed, using the local checkout"
  else
    run mkdir -p "$REPOS_DIR"
    run git clone --quiet "${REPO[$name]}" "$src" \
      || die "clone failed - is the repo public, or is a deploy key set up?"
  fi

  [[ $DRY_RUN -eq 1 ]] && return 0

  if [[ -n "$ref" ]]; then
    git -C "$src" reset --hard --quiet "$ref" || die "no such commit: $ref"
  else
    git -C "$src" reset --hard --quiet origin/HEAD 2>/dev/null \
      || git -C "$src" reset --hard --quiet origin/main 2>/dev/null \
      || git -C "$src" reset --hard --quiet origin/master
  fi
}

# The overlay is only as current as this checkout. Deploying one service alone
# must not hand it files from whenever platform was last pulled.
refresh_overlay_source() { fetch_source platform; }

# ── Overlays ────────────────────────────────────────────────────────────────
#
# Some files inside the other services are owned by this repo: the SSO client
# they import, and the stylesheet every panel renders. Keeping one copy here
# and pushing it outward is what stops three design systems slowly becoming
# three different design systems. Each service declares what it receives in
# deploy/overlays/<name>/manifest.

overlay_dir() { echo "$(src_path platform)/deploy"; }

apply_overlay() {
  local name="$1" ov="${OVERLAY[$1]:-}"
  [[ -n "$ov" ]] || return 0

  local base target manifest applied=0 src dest
  base="$(overlay_dir)"
  target="${TARGET[$name]}"
  manifest="$base/overlays/$ov/manifest"

  [[ -f "$manifest" ]] || { warn "no manifest for overlay '$ov'"; return 0; }

  while read -r src dest; do
    [[ -z "$src" || "$src" == \#* ]] && continue
    if [[ ! -f "$base/$src" ]]; then
      warn "overlay source missing: $src"
      continue
    fi
    run mkdir -p "$(dirname "$target/$dest")"
    run cp "$base/$src" "$target/$dest"
    applied=$((applied + 1))
  done < "$manifest"

  run chown -R "$APP_USER:$APP_USER" "$target"
  ok "overlay '$ov' applied ($applied files)"
}

# Reports drift instead of fixing it. The copies committed inside each service
# exist so those repos boot from a bare clone; this finds the one that was
# edited in place and no longer matches.
cmd_verify() {
  step "Verifying overlays"
  refresh_overlay_source

  local base drift=0 name ov manifest src dest
  base="$(overlay_dir)"

  for name in "${NAMES[@]}"; do
    ov="${OVERLAY[$name]:-}"
    [[ -n "$ov" && -d "${TARGET[$name]}" ]] || continue

    manifest="$base/overlays/$ov/manifest"
    [[ -f "$manifest" ]] || continue

    while read -r src dest; do
      [[ -z "$src" || "$src" == \#* ]] && continue
      [[ -f "$base/$src" && -f "${TARGET[$name]}/$dest" ]] || continue
      if ! cmp -s "$base/$src" "${TARGET[$name]}/$dest"; then
        warn "$name: $dest differs from $src"
        drift=$((drift + 1))
      fi
    done < "$manifest"
  done

  [[ $drift -eq 0 ]] && ok "every overlay file matches source"
  return 0
}

cmd_list() {
  local name state
  printf '\n%s  %-14s %-8s %-24s %s%s\n' "$BOLD" NAME TYPE TARGET STATE "$RESET"
  for name in "${NAMES[@]}"; do
    if [[ "${ENABLED[$name]}" != "yes" ]]; then
      state="disabled"
    elif [[ ! -d "${TARGET[$name]}" ]]; then
      state="not installed"
    elif [[ "${TYPE[$name]:-node}" == node ]] \
      && ! systemctl is-active --quiet "${UNIT[$name]}" 2>/dev/null; then
      state="${RED}stopped${RESET}"
    else
      state="${GREEN}ok${RESET}"
    fi
    printf '  %-14s %-8s %-24s %b\n' \
      "$name" "${TYPE[$name]:-node}" "${TARGET[$name]}" "$state"
  done
  printf '\n  config: %s\n\n' "$CONF"
}

# ── Deploy ──────────────────────────────────────────────────────────────────

sync_files() {
  local name="$1" p
  local src target
  src="$(src_path "$name")"
  target="${TARGET[$name]}"

  [[ -d "$src" ]] || die "$name: ${SUBDIR[$name]:-.} does not exist in the repository"
  local args=(-a --delete)
  for p in "${PRESERVE[@]}"; do args+=(--exclude "$p"); done

  run rsync "${args[@]}" "$src"/ "$target"/
  run chown -R "$APP_USER:$APP_USER" "$target"
  ok "files synced"
}

install_deps() {
  local target="${TARGET[$1]}"
  [[ -f "$target/package.json" ]] || return 0
  [[ $DRY_RUN -eq 1 ]] && { info "would: npm install in $target"; return 0; }

  if [[ -f "$target/package-lock.json" ]]; then
    as_app_user bash -c "cd '$target' && npm ci --omit=dev --no-audit --fund=false" \
      || die "npm ci failed"
  else
    as_app_user bash -c "cd '$target' && npm install --omit=dev --no-audit --fund=false" \
      || die "npm install failed"
  fi
  ok "dependencies"
}

run_build() {
  local name="$1" cmd="${BUILD[$1]:-}"
  [[ -n "$cmd" ]] || return 0
  [[ $DRY_RUN -eq 1 ]] && { info "would build: $cmd"; return 0; }
  as_app_user bash -c "cd '${TARGET[$name]}' && $cmd" || die "build failed"
  ok "built"
}

run_migrations() {
  local target="${TARGET[$1]}"
  [[ -f "$target/package.json" ]] || return 0
  grep -q '"migrate"' "$target/package.json" 2>/dev/null || return 0
  [[ $DRY_RUN -eq 1 ]] && { info "would: npm run migrate"; return 0; }

  if as_app_user bash -c "cd '$target' && npm run --silent migrate"; then
    ok "migrated"
  else
    die "migration failed - service left running on the previous release"
  fi
}

restart_unit() {
  local name="$1" unit="${UNIT[$1]:-}"
  [[ "${TYPE[$name]:-node}" == node ]] || return 0
  [[ -n "$unit" ]] || return 0
  [[ $DRY_RUN -eq 1 ]] && { info "would: systemctl restart $unit"; return 0; }

  systemctl restart "$unit"
  sleep 2
  if systemctl is-active --quiet "$unit"; then
    ok "$unit running"
  else
    journalctl -u "$unit" -n 25 --no-pager || true
    die "$unit failed to start"
  fi
}

deploy_one() {
  local name="$1" ref="${2:-}"

  if [[ "${ENABLED[$name]}" != "yes" ]]; then
    info "$name is disabled in services.conf - skipping"
    return 0
  fi
  if [[ ! -d "${TARGET[$name]}" ]]; then
    warn "$name is not installed at ${TARGET[$name]} - run its setup script first"
    return 0
  fi

  step "$name"

  fetch_source "$name" "$ref"
  [[ $DRY_RUN -eq 0 ]] \
    && ok "source at $(git -C "$(src_dir "$name")" rev-parse --short HEAD)"

  sync_files "$name"
  install_deps "$name"
  run_build "$name"
  run_migrations "$name"

  if [[ -n "${OVERLAY[$name]:-}" ]]; then
    # After the sync: rsync --delete would otherwise remove overlay files that
    # are not in the service's own repository.
    refresh_overlay_source
    apply_overlay "$name"
  fi

  restart_unit "$name"
}

check_health() {
  local shown=0 name url code
  for name in "${NAMES[@]}"; do
    url="${HEALTH[$name]:-}"
    [[ -n "$url" && "${ENABLED[$name]}" == "yes" && -d "${TARGET[$name]}" ]] || continue
    [[ $shown -eq 0 ]] && { step "Health"; shown=1; }

    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
    if [[ "$code" =~ ^2 ]]; then
      ok "$name  $url"
    else
      warn "$name  $url -> $code"
    fi
  done
}

# ── Entry point ─────────────────────────────────────────────────────────────

ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY_RUN=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

case "${ARGS[0]:-}" in
  list)
    cmd_list
    exit 0
    ;;
  verify)
    need_root
    cmd_verify
    exit 0
    ;;
  rollback)
    need_root; ensure_home
    name="${ARGS[1]:-}"; ref="${ARGS[2]:-}"
    [[ -n "$name" && -n "$ref" ]] || die "usage: deploy.sh rollback <name> <commit>"
    [[ -n "${REPO[$name]:-}" ]] || die "unknown service '$name' - try: deploy.sh list"
    warn "rolling $name back to $ref"
    deploy_one "$name" "$ref"
    check_health
    exit 0
    ;;
esac

need_root
ensure_home
[[ $DRY_RUN -eq 1 ]] && step "Dry run - nothing will change"

if [[ ${#ARGS[@]} -eq 0 ]]; then
  TARGETS=("${NAMES[@]}")
else
  TARGETS=("${ARGS[@]}")
  for n in "${TARGETS[@]}"; do
    [[ -n "${REPO[$n]:-}" ]] || die "unknown service '$n' - try: deploy.sh list"
  done
fi

for name in "${TARGETS[@]}"; do
  deploy_one "$name"
done

check_health
printf '\n'
