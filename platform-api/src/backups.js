import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { log } from './log.js';

/**
 * How old the newest backup is.
 *
 * Read from the directory rather than tracked in the database, because the
 * thing worth knowing is whether the archive exists on disk - and a table
 * saying a backup happened is exactly what would survive the archive being
 * deleted. The filesystem is the source of truth for its own contents.
 *
 * This exists because /opt was lost once with no backup at all, and a number
 * on the dashboard turning red is what would have said so beforehand.
 */

const BACKUP_DIR = process.env.BACKUP_DIR || '/var/backups/hamaprojects';

/** Past this, the dashboard should be complaining rather than informing. */
const STALE_HOURS = 48;

export async function backupStatus() {
  let entries;

  try {
    entries = await readdir(BACKUP_DIR);
  } catch (err) {
    // A missing directory is the answer, not an error: it means no backup has
    // ever run here, which is precisely what the dashboard should say.
    if (err.code === 'ENOENT') {
      return { configured: false, count: 0, latest: null, ageHours: null, stale: true };
    }
    log.warn('Could not read the backup directory', { error: err.message });
    return { configured: false, count: 0, latest: null, ageHours: null, stale: true, error: err.message };
  }

  const archives = entries.filter((f) => f.endsWith('.tar.gz'));

  if (!archives.length) {
    return { configured: true, count: 0, latest: null, ageHours: null, stale: true };
  }

  let newest = null;

  for (const name of archives) {
    try {
      const info = await stat(path.join(BACKUP_DIR, name));
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { name, mtimeMs: info.mtimeMs, size: info.size };
      }
    } catch {
      // A file that vanished between listing and stat is a rotation running
      // right now, not a fault worth reporting.
      continue;
    }
  }

  if (!newest) {
    return { configured: true, count: archives.length, latest: null, ageHours: null, stale: true };
  }

  const ageHours = (Date.now() - newest.mtimeMs) / 3_600_000;

  return {
    configured: true,
    count: archives.length,
    latest: {
      name: newest.name,
      at: new Date(newest.mtimeMs).toISOString(),
      sizeBytes: newest.size,
    },
    ageHours: Math.round(ageHours * 10) / 10,
    stale: ageHours > STALE_HOURS,
    staleAfterHours: STALE_HOURS,
  };
}
