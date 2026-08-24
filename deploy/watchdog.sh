#!/usr/bin/env bash
#
# The checks that have no natural home in a running service.
#
#   sudo /opt/watchdog.sh            run every check, alert on anything wrong
#   sudo /opt/watchdog.sh --quiet    same, but print only problems (for cron)
#
# Three things the services cannot watch for themselves:
#
#   disk    a full volume stops Postgres writes, nginx logging and uploads at
#           once, and is discovered as a 500 rather than as a disk problem
#   tls     certbot renews on its own timer; when that quietly fails, all three
#           domains go down the same morning
#   backup  a backup job that stopped a month ago is the usual way to have no
#           backup, and the only symptom is an archive nobody looked at
#
# Alerts go through the panel's destinations, so there is one place to change
# where they land.
#
set -uo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

# ── Thresholds ──────────────────────────────────────────────────────────────

DISK_WARN_PERCENT=85
TLS_WARN_DAYS=14
BACKUP_WARN_HOURS=48

BACKUP_DIR=/var/backups/hamaprojects
DOMAINS=(config.hamaprojects.com api.hamaprojects.com skincraft.hamaprojects.com)

# ── Output ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

PROBLEMS=()

step() { [[ $QUIET -eq 1 ]] || printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { [[ $QUIET -eq 1 ]] || printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
bad()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; PROBLEMS+=("$1"); }

# ── Disk ────────────────────────────────────────────────────────────────────

check_disk() {
  step "Disk"

  local line used avail mount
  # Every real filesystem, skipping tmpfs and the like - those filling is a
  # different problem and not one a backup or a prune would fix.
  while read -r _ _ used avail pct mount; do
    pct="${pct%\%}"
    [[ "$pct" =~ ^[0-9]+$ ]] || continue

    if [[ "$pct" -ge "$DISK_WARN_PERCENT" ]]; then
      bad "disk $mount is ${pct}% full (${avail} free)"
    else
      ok "$mount ${pct}% used, ${avail} free"
    fi
  done < <(df -h -x tmpfs -x devtmpfs -x overlay --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2)
}

# ── TLS ─────────────────────────────────────────────────────────────────────

check_tls() {
  step "Certificates"

  command -v openssl >/dev/null || { bad "openssl not installed - cannot check certificates"; return; }

  local domain end_date end_epoch now days
  now=$(date +%s)

  for domain in "${DOMAINS[@]}"; do
    end_date=$(echo | timeout 10 openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

    if [[ -z "$end_date" ]]; then
      bad "$domain - could not read its certificate"
      continue
    fi

    end_epoch=$(date -d "$end_date" +%s 2>/dev/null || echo 0)
    if [[ "$end_epoch" -eq 0 ]]; then
      bad "$domain - certificate date unreadable ($end_date)"
      continue
    fi

    days=$(( (end_epoch - now) / 86400 ))

    if [[ "$days" -lt 0 ]]; then
      bad "$domain - certificate EXPIRED ${days#-} days ago"
    elif [[ "$days" -le "$TLS_WARN_DAYS" ]]; then
      bad "$domain - certificate expires in $days days"
    else
      ok "$domain - $days days left"
    fi
  done
}

# ── Backups ─────────────────────────────────────────────────────────────────

check_backups() {
  step "Backups"

  if [[ ! -d "$BACKUP_DIR" ]]; then
    bad "no backups have ever run ($BACKUP_DIR does not exist)"
    return
  fi

  local newest age_hours count
  newest=$(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1)

  if [[ -z "$newest" ]]; then
    bad "the backup directory is empty"
    return
  fi

  count=$(ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null | wc -l)
  age_hours=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))

  if [[ "$age_hours" -gt "$BACKUP_WARN_HOURS" ]]; then
    bad "the newest backup is ${age_hours}h old - is the timer running?"
  else
    ok "newest backup ${age_hours}h old, $count kept"
  fi

  # Readable, not merely present. A truncated archive looks fine in a listing
  # and fails at the moment it is needed.
  if ! gzip -t "$newest" 2>/dev/null; then
    bad "the newest backup is CORRUPT: $(basename "$newest")"
  else
    ok "newest backup verified readable"
  fi
}

# ── Run ─────────────────────────────────────────────────────────────────────

check_disk
check_tls
check_backups

if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
  [[ $QUIET -eq 1 ]] || printf '\n  %severything within thresholds%s\n\n' "$GREEN" "$RESET"
  exit 0
fi

printf '\n  %s%d problem(s)%s\n\n' "$RED" "${#PROBLEMS[@]}" "$RESET"

# One message for the batch. A disk filling usually also stops backups, and
# three alerts for one cause is how a channel becomes noise.
if [[ -d /opt/platform-api ]]; then
  message="⚠️ hamaprojects watchdog

$(printf '%s\n' "${PROBLEMS[@]}")"
  (cd /opt/platform-api && node src/scripts/notify.js "$message") >/dev/null 2>&1 || true
fi

exit 1
