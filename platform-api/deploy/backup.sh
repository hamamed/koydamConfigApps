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

# ── Offsite ─────────────────────────────────────────────────────────────────
#
# A backup on the same disk as the data is not a backup of the disk. This copies
# the archive somewhere else, configured in /etc/hamaprojects/backup.conf:
#
#   OFFSITE_KIND=rsync
#   OFFSITE_TARGET=backups@other-host:/srv/hamaprojects/
#   OFFSITE_SSH_KEY=/root/.ssh/backup_ed25519      # optional
#
#   OFFSITE_KIND=rclone
#   OFFSITE_TARGET=b2:my-bucket/hamaprojects       # any rclone remote
#
# Absent or OFFSITE_KIND=none means local only, and the script says so rather
# than staying quiet - "no offsite copy" should be a line you read, not a fact
# you assume was handled.

OFFSITE_CONF=/etc/hamaprojects/backup.conf

send_offsite() {
  local archive="$1"

  if [[ ! -f "$OFFSITE_CONF" ]]; then
    warn "no offsite copy - $OFFSITE_CONF does not exist"
    return 0
  fi

  # shellcheck disable=SC1090
  . "$OFFSITE_CONF"

  local kind="${OFFSITE_KIND:-none}"
  [[ "$kind" == "none" ]] && { info "offsite disabled in $OFFSITE_CONF"; return 0; }

  if [[ -z "${OFFSITE_TARGET:-}" ]]; then
    warn "OFFSITE_KIND=$kind but no OFFSITE_TARGET - skipping"
    return 1
  fi

  step "Copying offsite"

  case "$kind" in
    rsync)
      command -v rsync >/dev/null || { warn "rsync not installed"; return 1; }

      local ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
      [[ -n "${OFFSITE_SSH_KEY:-}" ]] && ssh_opts+=(-i "$OFFSITE_SSH_KEY")

      if rsync -a --timeout=120 -e "ssh ${ssh_opts[*]}" "$archive" "$OFFSITE_TARGET"; then
        ok "sent to $OFFSITE_TARGET"
        return 0
      fi
      warn "rsync to $OFFSITE_TARGET failed"
      return 1
      ;;

    rclone)
      command -v rclone >/dev/null || { warn "rclone not installed"; return 1; }

      if rclone copy --retries 2 "$archive" "$OFFSITE_TARGET"; then
        ok "sent to $OFFSITE_TARGET"
        return 0
      fi
      warn "rclone to $OFFSITE_TARGET failed"
      return 1
      ;;

    *)
      warn "unknown OFFSITE_KIND '$kind' - expected rsync, rclone or none"
      return 1
      ;;
  esac
}

# ── Telling someone ─────────────────────────────────────────────────────────
#
# Through the panel's own alert destinations rather than a URL configured here,
# so there is one place to change where alerts go.

alert() {
  local message="$1"
  [[ -x /usr/bin/node || -x /usr/local/bin/node ]] || return 0
  [[ -d /opt/platform-api ]] || return 0

  (cd /opt/platform-api && node src/scripts/notify.js "$message") >/dev/null 2>&1 || true
}

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
  # Listed into a variable first, not piped into grep.
  #
  # `grep -q` exits on its first match, tar takes SIGPIPE, and `pipefail` turns
  # that into a failed pipeline — so this check reported the database missing
  # exactly when it was present. Every backup warned about the one thing it had
  # done correctly.
  local listing
  listing=$(tar tzf "$f")
  if grep -q 'brawl-postgres.sql' <<< "$listing"; then
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
      alert "Backup FAILED on hamaprojects: pg_dump of '$db' returned an error. No archive was written."
      die "pg_dump of '$db' failed - stopping rather than writing a backup without it"
    fi
  done
else
  warn "pg_dump not found - no Postgres in this backup"
fi

# ── SQLite ──────────────────────────────────────────────────────────────────
#
# The same argument as pg_dump, for the same reason. Copying a .db file while
# the service is writing gives a file that may be missing whatever is still in
# the write-ahead log, or worse, half of it — fortnite's WAL alone runs to ten
# megabytes. `.backup` takes a consistent snapshot of a live database, which
# `cp` cannot.

sqlite_dump() {
  local label="$1" src="$2"
  [[ -f "$src" ]] || { info "$label: nothing at $src"; return 0; }

  if ! command -v sqlite3 >/dev/null 2>&1; then
    warn "sqlite3 not found - falling back to a file copy of $label, which may be inconsistent"
    mkdir -p "$WORK/files/$(dirname "$label")"
    cp -a "$src" "$WORK/files/$label"
    return 0
  fi

  local dest="$WORK/sqlite/$label.db"
  mkdir -p "$(dirname "$dest")"
  if sqlite3 "$src" ".backup '$dest'" 2>/dev/null; then
    ok "sqlite/$label  $(human "$(stat -c %s "$dest")")"
  else
    alert "Backup FAILED on hamaprojects: sqlite backup of '$label' returned an error. No archive was written."
    die "sqlite backup of '$label' failed - stopping rather than writing a backup without it"
  fi
}

# ── Files ───────────────────────────────────────────────────────────────────

# A second argument names a subdirectory to leave out. Used for caches: bytes
# that can be fetched again do not belong in an archive that has to be small
# enough to keep several of.
add() {
  local label="$1" path="$2" skip="${3:-}"
  [[ -e "$path" ]] || { info "$label: nothing at $path"; return 0; }
  local dest="$WORK/files/${label}"
  mkdir -p "$(dirname "$dest")"
  if [[ -n "$skip" && -d "$path" ]]; then
    mkdir -p "$dest"
    tar -C "$path" --exclude="$skip" -cf - . | tar -C "$dest" -xf -
  else
    cp -a "$path" "$dest"
  fi
  ok "$label  $(du -sh "$dest" | cut -f1)"
}

# The databases, snapshotted rather than copied.
sqlite_dump "skincraft"  /opt/skincraft/data/skincraft.db
sqlite_dump "minebox"    /opt/minebox/data/minebox.db
sqlite_dump "fortnite"   /opt/fortnite/data/fortnite.db

# Secrets first: these are unrecoverable, and were lost once already.
for svc in brawl-vps platform-api skincraft minebox fortnite; do
  add "env/$svc.env" "/opt/$svc/.env"
done

add "brawl/wallpapers"   /opt/brawl-vps/wallpapers
add "brawl/data"         /opt/brawl-vps/data
add "skincraft/storage"  /opt/skincraft/storage
# MineBox keeps the uploaded .mcaddon/.mcworld files under storage/files and the rendered
# previews under storage/previews. The files are the only copy there is — nothing regenerates
# an addon somebody uploaded — while previews can be rebuilt with `npm run regenerate-previews`.
add "minebox/storage"    /opt/minebox/storage
add "nginx"              /etc/nginx/sites-available
add "systemd"            /etc/systemd/system/brawl-api.service
add "systemd-platform"   /etc/systemd/system/platform-api.service
add "systemd-skincraft"  /etc/systemd/system/skincraft.service
# Everything under data/ except the image cache, which is thirty megabytes of
# pictures this service will re-fetch from their CDNs on demand.
add "fortnite/data"      /opt/fortnite/data          media
# The uploads. These have no other copy anywhere, and a deploy misconfiguration
# already destroyed them once.
add "fortnite/wallpapers" /opt/fortnite/wallpapers
add "systemd-minebox"    /etc/systemd/system/minebox.service
add "systemd-fortnite"   /etc/systemd/system/fortnite.service

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
if ! gzip -t "$ARCHIVE"; then
  alert "Backup FAILED on hamaprojects: the archive it just wrote is corrupt."
  die "archive verified as CORRUPT - do not rely on it"
fi
ok "verified readable"

ARCHIVE_LISTING=$(tar tzf "$ARCHIVE")
if ! grep -q 'brawl-postgres.sql' <<< "$ARCHIVE_LISTING"; then
  warn "no Brawl database in this archive - check pg_dump above"
fi

# ── Rotation ────────────────────────────────────────────────────────────────

if ! send_offsite "$ARCHIVE"; then
  # The local archive is fine; what failed is the copy that survives this disk.
  # Worth an alert precisely because everything looks healthy from here.
  alert "Backup WARNING on hamaprojects: the local archive was written but the offsite copy failed."
fi

mapfile -t old < <(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [[ ${#old[@]} -gt 0 ]]; then
  for f in "${old[@]}"; do
    rm -f "$f"
    info "removed old backup $(basename "$f")"
  done
fi

df -h /var | awk 'NR==2 {printf "  disk: %s used of %s (%s free)\n", $3, $2, $4}'
printf '\n'
