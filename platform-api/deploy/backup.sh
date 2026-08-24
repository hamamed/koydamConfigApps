#!/usr/bin/env bash
#
# Backs up everything a deploy cannot rebuild.
#
#   sudo /opt/backup.sh                 write a new backup
#   sudo /opt/backup.sh list            what backups exist
#   sudo /opt/backup.sh verify <file>   check an archive is readable and complete
#
# Code is not backed up: it is in git. What is here is the data that only
# exists on this box — the Brawl Postgres database, SkinCraft's SQLite file,
# the wallpapers, the generated brawler metadata, and every .env.
#
# Run this before any cleanup, and on a timer afterwards.
#
set -euo pipefail

BACKUP_DIR=/var/backups/hamaprojects
KEEP=7

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

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }

cmd_list() {
  step "Backups in $BACKUP_DIR"
  if ! compgen -G "$BACKUP_DIR/*.tar.gz" >/dev/null 2>&1; then
    warn "none yet"
    return 0
  fi
  local f
  for f in "$BACKUP_DIR"/*.tar.gz; do
    printf '  %-44s %10s  %s\n' "$(basename "$f")" \
      "$(human "$(stat -c %s "$f")")" "$(date -r "$f" '+%Y-%m-%d %H:%M')"
  done
  printf '\n  total: %s\n\n' "$(du -sh "$BACKUP_DIR" | cut -f1)"
}

cmd_verify() {
  local f="${1:-}"
  [[ -n "$f" ]] || die "usage: backup.sh verify <file>"
  [[ -f "$f" ]] || f="$BACKUP_DIR/$f"
  [[ -f "$f" ]] || die "no such backup: $f"

  step "Verifying $(basename "$f")"

  # gzip -t reads the whole stream, so a truncated archive fails here rather
  # than at 3am during a restore.
  gzip -t "$f" || die "archive is corrupt"
  ok "checksum ok"

  local n
  n=$(tar tzf "$f" | wc -l)
  ok "$n entries"

  # An archive missing the database is worse than no archive: it looks like
  # protection and is not.
  if tar tzf "$f" | grep -q 'brawl-postgres.sql'; then
    ok "Brawl database present"
  else
    warn "no Brawl database in this archive"
  fi
  printf '\n'
}

case "${1:-}" in
  list)   cmd_list; exit 0 ;;
  verify) cmd_verify "${2:-}"; exit 0 ;;
esac

[[ $EUID -eq 0 ]] || die "Run with sudo."

STAMP=$(date '+%Y-%m-%d_%H%M%S')
WORK=$(mktemp -d)
# Even on failure. A half-written staging directory in /tmp is how a disk
# fills quietly.
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

step "Backing up"

# ── Postgres ────────────────────────────────────────────────────────────────
#
# pg_dump rather than copying the data directory: a file-level copy of a
# running cluster is not consistent, and this is the database that matters.

if command -v pg_dump >/dev/null 2>&1; then
  # Enumerated, not hardcoded. A database added later must not be silently
  # left out of every backup because nobody remembered to edit this list.
  mapfile -t DBS < <(sudo -u postgres psql -Atqc     "SELECT datname FROM pg_database
      WHERE NOT datistemplate AND datname <> 'postgres'
      ORDER BY datname" 2>/dev/null || true)

  if [[ ${#DBS[@]} -eq 0 ]]; then
    warn "no Postgres databases found - is the server running?"
  fi

  for db in "${DBS[@]}"; do
    [[ -n "$db" ]] || continue
    if sudo -u postgres pg_dump --no-owner --no-acl "$db" > "$WORK/$db-postgres.sql" 2>/dev/null; then
      ok "postgres/$db  $(human "$(stat -c %s "$WORK/$db-postgres.sql")")"
    else
      die "pg_dump of '$db' failed - stopping rather than writing a backup without it"
    fi
  done
else
  warn "pg_dump not found - no Postgres in this backup"
fi

# ── Files ───────────────────────────────────────────────────────────────────

add() {
  local label="$1" path="$2"
  [[ -e "$path" ]] || { info "$label: nothing at $path"; return 0; }
  local dest="$WORK/files/${label}"
  mkdir -p "$(dirname "$dest")"
  cp -a "$path" "$dest"
  ok "$label  $(du -sh "$dest" | cut -f1)"
}

# Secrets first: these are unrecoverable, and were lost once already.
for svc in brawl-vps platform-api skincraft; do
  add "env/$svc.env" "/opt/$svc/.env"
done

add "brawl/wallpapers"   /opt/brawl-vps/wallpapers
add "brawl/data"         /opt/brawl-vps/data
add "skincraft/storage"  /opt/skincraft/storage
add "skincraft/data"     /opt/skincraft/data
add "nginx"              /etc/nginx/sites-available
add "systemd"            /etc/systemd/system/brawl-api.service
add "systemd-platform"   /etc/systemd/system/platform-api.service
add "systemd-skincraft"  /etc/systemd/system/skincraft.service

# Certificates: reissuing is possible but rate-limited, and an expired site
# during a restore is an outage you did not need.
add "letsencrypt" /etc/letsencrypt

# ── Archive ─────────────────────────────────────────────────────────────────

ARCHIVE="$BACKUP_DIR/hamaprojects-$STAMP.tar.gz"
tar czf "$ARCHIVE" -C "$WORK" . || die "archive failed"
chmod 600 "$ARCHIVE"

step "Result"
ok "$ARCHIVE"
ok "$(human "$(stat -c %s "$ARCHIVE")")"

# Read it back before trusting it.
gzip -t "$ARCHIVE" || die "archive verified as CORRUPT - do not rely on it"
ok "verified readable"

if ! tar tzf "$ARCHIVE" | grep -q 'brawl-postgres.sql'; then
  warn "no Brawl database in this archive - check pg_dump above"
fi

# ── Rotation ────────────────────────────────────────────────────────────────

mapfile -t old < <(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [[ ${#old[@]} -gt 0 ]]; then
  for f in "${old[@]}"; do
    rm -f "$f"
    info "removed old backup $(basename "$f")"
  done
fi

df -h /var | awk 'NR==2 {printf "  disk: %s used of %s (%s free)\n", $3, $2, $4}'
printf '\n'
