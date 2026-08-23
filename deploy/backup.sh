#!/usr/bin/env bash
#
# Backs up the database and the storage tree.
#
# SQLite is a single file, but copying it while the server is writing can capture a torn page —
# `.backup` takes a consistent snapshot through the SQLite API instead. Run it from cron:
#
#   0 3 * * * /srv/skincraft/deploy/backup.sh >> /var/log/skincraft-backup.log 2>&1

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/skincraft}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/skincraft}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

sqlite3 "$APP_DIR/data/skincraft.db" ".backup '$BACKUP_DIR/skincraft-$STAMP.db'"
tar -czf "$BACKUP_DIR/storage-$STAMP.tar.gz" -C "$APP_DIR" storage

find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is) backup complete: skincraft-$STAMP.db + storage-$STAMP.tar.gz"
