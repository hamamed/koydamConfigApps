#!/usr/bin/env bash
#
# Removes what the move to git deploys left behind.
#
#   sudo /opt/cleanup.sh            list what would go, delete nothing
#   sudo /opt/cleanup.sh --apply    actually delete it
#
# Scope is deliberately narrow: uploaded archives, the directories they were
# unpacked into, the per-repo checkouts the monorepo replaced, and package
# caches. It does not stop a service, does not touch a service directory, and
# does not go near a database.
#
# Dry run is the default because the last thing that removed files here removed
# the wrong ones.
#
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

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

[[ $EUID -eq 0 ]] || die "Run with sudo."

# ── What must never be deleted ──────────────────────────────────────────────
#
# Checked per path rather than trusted to the patterns below. The patterns are
# where a mistake would be made; this is the net under it.

PROTECTED=(
  /opt/brawl-vps
  /opt/platform-api
  /opt/skincraft
  /opt/src/koydamConfigApps
  /var/lib/postgresql
  /var/lib/redis
  /var/backups/hamaprojects
  /etc
  /home
  /root
  /usr
  /var/www
)

# Narrow holes in the net, listed one by one.
#
# The npm caches sit under /root and /home, which are protected wholesale and
# should stay that way. Naming the two exact directories is safer than removing
# those entries from the list above and relying on the patterns to be careful.
EXCEPTIONS=(
  /root/.npm/_cacache
  /home/brawl/.npm/_cacache
)

is_protected() {
  local p="$1" prot exc
  # Resolve first: a symlink or a .. in the path must not be able to walk out
  # of what the pattern intended and into something on this list.
  p=$(readlink -f "$p" 2>/dev/null || echo "$p")

  for exc in "${EXCEPTIONS[@]}"; do
    [[ "$p" == "$exc" ]] && return 1
  done

  for prot in "${PROTECTED[@]}"; do
    [[ "$p" == "$prot" || "$p" == "$prot"/* ]] && return 0
  done

  # Refuse anything dangerously shallow regardless of the list.
  case "$p" in
    / | /opt | /var | /tmp | /var/lib | /opt/src) return 0 ;;
  esac
  return 1
}

TOTAL=0
declare -a DOOMED=()

consider() {
  local path="$1" why="$2"
  [[ -e "$path" ]] || return 0

  if is_protected "$path"; then
    warn "refusing to touch $path (protected)"
    return 0
  fi

  local size
  size=$(du -sb "$path" 2>/dev/null | cut -f1 || echo 0)
  TOTAL=$((TOTAL + size))
  DOOMED+=("$path")

  printf '  %-52s %8s  %s\n' \
    "$path" "$(numfmt --to=iec --suffix=B "$size" 2>/dev/null || echo "$size")" "$why"
}

# ── Candidates ──────────────────────────────────────────────────────────────

step "Uploaded archives and their unpacked copies"
for f in /tmp/*.zip /tmp/*.tar.gz /root/*.zip /root/*.tar.gz; do
  consider "$f" "uploaded archive"
done
for d in /tmp/platform-api /tmp/brawl-vps /tmp/brawl-vps-deploy /tmp/skincraft \
         /tmp/platform-api-deploy /opt/brawl-vps-deploy; do
  consider "$d" "unpacked upload"
done

step "Checkouts the monorepo replaced"
# The old layout cloned one repo per service into /opt/src/<service>. Those are
# now all one repository at /opt/src/koydamConfigApps, which is protected above.
for d in /opt/src/platform /opt/src/brawl /opt/src/skincraft \
         /opt/src/platform-api /opt/src/brawl-vps; do
  consider "$d" "superseded by the monorepo"
done

step "Package caches"
consider /root/.npm/_cacache  "npm cache, rebuilt on demand"
consider /home/brawl/.npm/_cacache "npm cache, rebuilt on demand"

# ── Act ─────────────────────────────────────────────────────────────────────

step "Summary"

if [[ ${#DOOMED[@]} -eq 0 ]]; then
  ok "nothing to clean - the box is already tidy"
  printf '\n'
  exit 0
fi

printf '  %s items, %s\n' "${#DOOMED[@]}" \
  "$(numfmt --to=iec --suffix=B "$TOTAL" 2>/dev/null || echo "$TOTAL bytes")"

if [[ $APPLY -eq 0 ]]; then
  printf '\n'
  info "Dry run. Nothing was deleted."
  info "Re-run with --apply to remove the items listed above."
  printf '\n'
  exit 0
fi

step "Deleting"
for p in "${DOOMED[@]}"; do
  # Checked again at the moment of deletion, not only when it was listed.
  if is_protected "$p"; then
    warn "skipped $p (protected)"
    continue
  fi
  rm -rf -- "$p"
  ok "removed $p"
done

step "Result"
df -h / | awk 'NR==2 {printf "  disk: %s used of %s (%s free)\n", $3, $2, $4}'

# Services were never touched, but say so rather than leave it assumed.
for unit in platform-api brawl-api skincraft; do
  if systemctl list-unit-files --no-legend "$unit.service" >/dev/null 2>&1 \
     && systemctl is-active --quiet "$unit"; then
    ok "$unit still running"
  else
    warn "$unit is not running - it was not stopped by this script, check it"
  fi
done
printf '\n'

# Apt is left alone by default: `apt clean` is safe but its output is noisy and
# it is not what filled this disk.
info "Also available if you need more room: apt clean, journalctl --vacuum-time=7d"
printf '\n'
