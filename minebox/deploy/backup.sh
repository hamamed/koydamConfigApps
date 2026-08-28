#!/usr/bin/env bash
#
# Backs up the database and the storage tree.
#
# On the hamaprojects box this is the *second* line of defence: /opt/backup.sh runs nightly and
# archives every service together, MineBox included. This one exists for a standalone install,
# and is harmless alongside the other.
#
# SQLite is a single file, but copying it while the server is writing can capture a torn page —
# `.backup` takes a consistent snapshot through the SQLite API instead. Run it from cron:
#
#   0 3 * * * /opt/minebox/deploy/backup.sh >> /var/log/minebox-backup.log 2>&1

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/minebox}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/minebox}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

sqlite3 "$APP_DIR/data/minebox.db" ".backup '$BACKUP_DIR/minebox-$STAMP.db'"
tar -czf "$BACKUP_DIR/storage-$STAMP.tar.gz" -C "$APP_DIR" storage

find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is) backup complete: minebox-$STAMP.db + storage-$STAMP.tar.gz"
