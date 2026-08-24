#!/usr/bin/env bash
#
# Installs the systemd timers for the backup and the watchdog.
#
#   sudo /opt/src/koydamConfigApps/platform-api/deploy/install-timers.sh
#
# Timers rather than cron entries: a failed run is visible in `systemctl status`
# and the journal rather than in a mail nobody reads, `OnBootSec` catches up
# after the box was off, and `RandomizedDelaySec` stops every VPS on a provider
# hitting an offsite target at exactly 03:00.
#
set -euo pipefail

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
command -v systemctl >/dev/null || die "systemd not found."

[[ -x /opt/backup.sh ]] || warn "/opt/backup.sh is not installed yet"
[[ -x /opt/watchdog.sh ]] || warn "/opt/watchdog.sh is not installed yet"

step "Writing units"

# ── Backup ──────────────────────────────────────────────────────────────────

cat > /etc/systemd/system/hamaprojects-backup.service <<'UNIT'
[Unit]
Description=Back up hamaprojects databases and files
# Postgres must be up, or pg_dump fails and the run aborts by design.
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/backup.sh
# It writes an archive of the whole estate; a slow offsite copy should not be
# killed half way through.
TimeoutStartSec=3600
UNIT

cat > /etc/systemd/system/hamaprojects-backup.timer <<'UNIT'
[Unit]
Description=Nightly hamaprojects backup

[Timer]
OnCalendar=*-*-* 03:00:00
# A box that was off at 03:00 still gets its backup rather than skipping a day.
Persistent=true
# So every machine does not hit the offsite target on the same second.
RandomizedDelaySec=900

[Install]
WantedBy=timers.target
UNIT

ok "hamaprojects-backup.timer (daily, 03:00)"

# ── Watchdog ────────────────────────────────────────────────────────────────

cat > /etc/systemd/system/hamaprojects-watchdog.service <<'UNIT'
[Unit]
Description=Check disk, certificates and backup freshness
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# --quiet so the journal carries problems, not a clean bill of health twice a
# day. It exits non-zero when something is wrong, which systemd records.
ExecStart=/opt/watchdog.sh --quiet
TimeoutStartSec=300
UNIT

cat > /etc/systemd/system/hamaprojects-watchdog.timer <<'UNIT'
[Unit]
Description=Twice-daily hamaprojects watchdog

[Timer]
# Twice a day: enough notice on a certificate with two weeks left, and rare
# enough that a full disk is not announced forty times before anyone reads it.
OnCalendar=*-*-* 07:30:00
OnCalendar=*-*-* 19:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
UNIT

ok "hamaprojects-watchdog.timer (07:30 and 19:30)"

# ── Enable ──────────────────────────────────────────────────────────────────

step "Enabling"

systemctl daemon-reload
systemctl enable --now hamaprojects-backup.timer >/dev/null
systemctl enable --now hamaprojects-watchdog.timer >/dev/null

ok "enabled"

step "Next runs"
systemctl list-timers 'hamaprojects-*' --no-pager | head -5

cat <<'NEXT'

  Run one now without waiting:

    sudo systemctl start hamaprojects-backup.service
    sudo systemctl start hamaprojects-watchdog.service

  See what happened:

    journalctl -u hamaprojects-backup.service -n 40 --no-pager
    journalctl -u hamaprojects-watchdog.service -n 40 --no-pager

NEXT
