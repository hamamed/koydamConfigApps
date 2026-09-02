import { execFile } from 'node:child_process';
import { readdir, stat, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
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


const run = promisify(execFile);

/**
 * Every archive on disk, newest first, with what each one holds.
 *
 * Read from the filesystem rather than a table for the same reason
 * `backupStatus` is: a row saying a backup happened is exactly what would
 * survive the archive being deleted. What matters is the file.
 *
 * The contents come from `tar tzf`, which has to decompress the whole archive
 * to list it — so only the newest is opened. Listing seven 780 MB files on
 * every page load would make the page cost more than the backup.
 */
export async function backupInventory({ inspectNewest = true } = {}) {
  let entries;
  try {
    entries = await readdir(BACKUP_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return { configured: false, dir: BACKUP_DIR, archives: [], disk: null };
    return { configured: false, dir: BACKUP_DIR, archives: [], disk: null, error: err.message };
  }

  const archives = [];
  for (const name of entries.filter((f) => f.endsWith('.tar.gz'))) {
    try {
      const info = await stat(path.join(BACKUP_DIR, name));
      archives.push({
        name,
        sizeBytes: info.size,
        at: new Date(info.mtimeMs).toISOString(),
        ageHours: Math.round(((Date.now() - info.mtimeMs) / 3_600_000) * 10) / 10,
      });
    } catch {
      // Vanished between listing and stat: a rotation running right now.
    }
  }
  archives.sort((a, b) => b.at.localeCompare(a.at));

  let contents = null;
  if (inspectNewest && archives[0]) {
    contents = await summarise(path.join(BACKUP_DIR, archives[0].name));
  }

  let disk = null;
  try {
    const fs = await statfs(BACKUP_DIR);
    disk = { freeBytes: fs.bsize * fs.bavail, totalBytes: fs.bsize * fs.blocks };
  } catch {
    // A kernel without statfs is not a reason to hide the archive list.
  }

  return {
    configured: true,
    dir: BACKUP_DIR,
    archives,
    totalBytes: archives.reduce((sum, a) => sum + a.sizeBytes, 0),
    contents,
    disk,
    staleAfterHours: STALE_HOURS,
  };
}

/**
 * What is inside one archive, grouped into the things a restore would need.
 *
 * Grouped rather than listed file by file: an archive holds tens of thousands
 * of paths, and the question being asked is "is the Brawl database in there",
 * not "which certificate files were included".
 */
async function summarise(file) {
  let stdout;
  try {
    ({ stdout } = await run('tar', ['tzf', file], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    log.warn('Could not list a backup archive', { file, error: err.message });
    return null;
  }

  const paths = stdout.split('\n').filter(Boolean);
  const groups = new Map();

  for (const entry of paths) {
    const clean = entry.replace(/^\.\//, '');
    let key;
    if (clean.endsWith('-postgres.sql')) key = `postgres/${clean.replace('-postgres.sql', '')}`;
    else if (clean.startsWith('sqlite/')) key = clean.replace(/\.db$/, '');
    else if (clean.startsWith('files/')) key = `files/${clean.split('/')[1] ?? ''}`;
    else continue;
    if (!key) continue;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  return {
    fileCount: paths.length,
    groups: [...groups.entries()]
      .map(([name, files]) => ({ name, files }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
