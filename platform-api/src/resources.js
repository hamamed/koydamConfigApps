import { exec } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

import { query } from './db/pool.js';
import { log } from './log.js';

const run = promisify(exec);

/**
 * What this box is using, and how close it is to running out.
 *
 * Everything here comes from the kernel rather than from a metrics agent: one
 * VPS running three services does not need a time-series database to answer
 * "is the disk filling up".
 *
 * ## Why the numbers are the ones they are
 *
 * Memory is read from /proc/meminfo, not os.freemem(). On Linux "free" excludes
 * the page cache, which the kernel will hand back the moment anything asks - so
 * free memory on a healthy box reads as terrifyingly low and means nothing.
 * MemAvailable is the kernel's own estimate of what a new process could
 * actually get, and it is the only number worth showing.
 *
 * CPU is the load average rather than a percentage. A percentage over what
 * window? Load is what the kernel already tracks, and load per core is directly
 * readable: 1.0 per core means saturated, above that means work is queuing.
 */

/** Cached: reading /proc and running systemctl on every poll is wasteful, and
 *  none of these numbers change meaningfully inside ten seconds. */
const CACHE_MS = 10_000;
let cache = null;
let cachedAt = 0;

const isLinux = process.platform === 'linux';

// ── Memory ──────────────────────────────────────────────────────────────────

async function memory() {
  if (isLinux) {
    try {
      const text = await readFile('/proc/meminfo', 'utf8');
      const field = (name) => {
        const m = text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'));
        return m ? Number(m[1]) * 1024 : null;
      };

      const total = field('MemTotal');
      const available = field('MemAvailable');

      if (total && available != null) {
        return {
          total,
          available,
          used: total - available,
          percent: Math.round(((total - available) / total) * 100),
          swapTotal: field('SwapTotal') ?? 0,
          swapFree: field('SwapFree') ?? 0,
        };
      }
    } catch (err) {
      log.debug('Could not read /proc/meminfo', { error: err.message });
    }
  }

  // Elsewhere, and as a fallback. Marked so the panel can say the number is
  // the less useful one rather than quietly showing a worse answer.
  const total = os.totalmem();
  const available = os.freemem();
  return {
    total,
    available,
    used: total - available,
    percent: Math.round(((total - available) / total) * 100),
    approximate: true,
  };
}

// ── Disk ────────────────────────────────────────────────────────────────────

/**
 * The filesystems that matter, by what lives on them.
 *
 * Named rather than enumerated: a list of every mount includes loop devices and
 * tmpfs, and the question being asked is "can the database still write", not
 * "what is mounted".
 */
const WATCHED = [
  { path: '/', label: 'Root' },
  { path: '/var', label: 'Databases and logs' },
  { path: '/opt', label: 'Services' },
];

async function disks() {
  const seen = new Set();
  const out = [];

  for (const { path, label } of WATCHED) {
    try {
      const s = await statfs(path);
      const total = s.blocks * s.bsize;
      // bavail, not bfree: the difference is the root-reserved margin, which an
      // ordinary service cannot use and should not be counted as free.
      const free = s.bavail * s.bsize;

      // Several of these are usually one filesystem. Reporting it three times
      // would read as three disks, all suspiciously identical.
      const key = `${total}:${s.blocks}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        path,
        label,
        total,
        free,
        used: total - free,
        percent: total ? Math.round(((total - free) / total) * 100) : 0,
      });
    } catch {
      // A path that does not exist on this box is not an error.
      continue;
    }
  }

  return out;
}

// ── Per-service ─────────────────────────────────────────────────────────────

const UNITS = [
  { unit: 'platform-api', label: 'Platform config' },
  { unit: 'brawl-api', label: 'Brawl Stats API' },
  { unit: 'skincraft', label: 'SkinCraft' },
  { unit: 'minebox', label: 'MineBox' },
  { unit: 'postgresql', label: 'Postgres' },
  { unit: 'redis-server', label: 'Redis' },
  { unit: 'nginx', label: 'nginx' },
];

/**
 * Resident memory per service, from its main process.
 *
 * VmRSS in /proc is world-readable, so this needs no privilege. It is resident
 * set size, which double-counts shared pages across a process tree - fine for
 * "which of these is the big one", wrong for adding up to the host total, which
 * is why the panel never sums them.
 */
async function services() {
  if (!isLinux) return [];

  const out = [];

  for (const { unit, label } of UNITS) {
    try {
      const { stdout } = await run(
        `systemctl show ${unit} --property=MainPID,ActiveState,MemoryCurrent --value`,
        { timeout: 3000 },
      );

      const [pid, state, memoryCurrent] = stdout.trim().split('\n');
      if (!pid || pid === '0') continue;

      let rss = null;

      // systemd's own accounting when the cgroup has it; otherwise VmRSS.
      const fromSystemd = Number(memoryCurrent);
      if (Number.isFinite(fromSystemd) && fromSystemd > 0) {
        rss = fromSystemd;
      } else {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const m = status.match(/^VmRSS:\s+(\d+) kB/m);
          if (m) rss = Number(m[1]) * 1024;
        } catch {
          // The process exited between the two reads.
        }
      }

      out.push({ unit, label, pid: Number(pid), state, rss });
    } catch {
      continue;
    }
  }

  return out;
}

// ── Stores ──────────────────────────────────────────────────────────────────

/** How much disk each database is actually occupying. */
async function databases() {
  const res = await query(
    `SELECT datname AS name, pg_database_size(datname) AS bytes
       FROM pg_database
      WHERE NOT datistemplate AND datname <> 'postgres'
      ORDER BY bytes DESC`,
  );

  return (res?.rows ?? []).map((r) => ({ name: r.name, bytes: Number(r.bytes) }));
}

// ── Everything ──────────────────────────────────────────────────────────────

export async function resourceSnapshot() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;

  const cores = os.cpus().length || 1;
  const [oneMinute, fiveMinute, fifteenMinute] = os.loadavg();

  const [mem, fs, svc, db] = await Promise.all([
    memory(),
    disks(),
    services(),
    databases().catch(() => []),
  ]);

  cache = {
    at: new Date().toISOString(),
    platform: process.platform,
    uptimeSeconds: Math.round(os.uptime()),

    cpu: {
      cores,
      load1: oneMinute,
      load5: fiveMinute,
      load15: fifteenMinute,
      // The readable form: 1.0 per core is saturated.
      perCore: Math.round((oneMinute / cores) * 100) / 100,
      percent: Math.min(999, Math.round((oneMinute / cores) * 100)),
      // Load average is a Linux idea; on anything else it reads as zero and
      // would look like an idle box rather than an unavailable measurement.
      available: isLinux,
    },

    memory: mem,
    disks: fs,
    services: svc,
    databases: db,
  };

  cachedAt = Date.now();
  return cache;
}

/**
 * What is worth saying out loud, in the order someone should act on it.
 *
 * Thresholds rather than raw numbers: the panel shows both, but a page of
 * percentages leaves the reader to work out which one matters.
 */
export function pressure(snapshot) {
  const warnings = [];

  for (const d of snapshot.disks ?? []) {
    if (d.percent >= 90) {
      warnings.push({
        level: 'critical',
        text: `${d.label} is ${d.percent}% full. Postgres stops accepting writes on a full disk.`,
      });
    } else if (d.percent >= 80) {
      warnings.push({ level: 'warn', text: `${d.label} is ${d.percent}% full.` });
    }
  }

  const m = snapshot.memory;
  if (m?.percent >= 92) {
    warnings.push({
      level: 'critical',
      text: `Memory is ${m.percent}% used. The kernel will start killing processes.`,
    });
  } else if (m?.percent >= 85) {
    warnings.push({ level: 'warn', text: `Memory is ${m.percent}% used.` });
  }

  if (snapshot.cpu?.available && snapshot.cpu.perCore >= 2) {
    warnings.push({
      level: 'warn',
      text: `Load is ${snapshot.cpu.perCore} per core — work is queuing.`,
    });
  }

  const swapUsed = (m?.swapTotal ?? 0) - (m?.swapFree ?? 0);
  if (m?.swapTotal && swapUsed / m.swapTotal > 0.5) {
    warnings.push({
      level: 'warn',
      text: 'More than half of swap is in use, which usually means memory pressure.',
    });
  }

  return warnings;
}
