import { readFile, readdir, stat, statfs } from 'node:fs/promises';
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


/**
 * Every archive on disk, from the manifest the backup script leaves behind.
 *
 * Read from a small JSON index rather than the archives themselves, and that
 * is a security decision rather than a performance one. These archives hold
 * every service's .env — every secret on this box — so they stay root-only at
 * mode 600 in a directory the web application cannot list. Handing the panel
 * read access would mean a compromise here gives up everything.
 *
 * The manifest is written by root at the end of each run and is world
 * readable. It says what exists and what is in the newest archive; it contains
 * nothing sensitive itself.
 */
export async function backupInventory() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(BACKUP_DIR, 'inventory.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No manifest is not the same as no backups: a box backed up before this
      // existed has archives and no index. Say so precisely rather than
      // reporting "never", which would be a lie that reads like reassurance.
      return {
        configured: false,
        dir: BACKUP_DIR,
        archives: [],
        reason: 'No inventory.json yet — it is written at the end of the next backup run.',
      };
    }
    return { configured: false, dir: BACKUP_DIR, archives: [], error: err.message };
  }

  const archives = (manifest.archives ?? []).map((a) => ({
    ...a,
    ageHours: Math.round(((Date.now() - Date.parse(a.at)) / 3_600_000) * 10) / 10,
  }));

  let disk = null;
  try {
    const fs = await statfs(BACKUP_DIR);
    disk = { freeBytes: fs.bsize * fs.bavail, totalBytes: fs.bsize * fs.blocks };
  } catch {
    // A directory this process may traverse but not stat is not a reason to
    // hide the archive list.
  }

  return {
    configured: true,
    dir: BACKUP_DIR,
    generatedAt: manifest.generatedAt ?? null,
    archives,
    totalBytes: archives.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0),
    contents: manifest.contents?.length
      ? { fileCount: manifest.fileCount ?? 0, groups: manifest.contents }
      : null,
    disk,
    staleAfterHours: STALE_HOURS,
  };
}
