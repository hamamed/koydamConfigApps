/**
 * Which app build each phone plays, and through which domain.
 *
 * The app names its build in every request (User-Agent "Wasla/2026092802
 * CFNetwork/…"), and a request says which domain it came in on. Once a day per
 * phone — from the events it sends while it plays — that pair is kept, so the
 * dashboard can say how many still play a version that talks to the old domain
 * (1.1 and 1.2 have wassla.hamaprojects.com built in), and when it can go.
 */
import { addDays } from './players.js';

/** The builds uploaded so far, by version; a build not listed shows as its number. */
export const BUILD_VERSIONS = Object.freeze({
  2026092401: '1.1',
  2026092502: '1.2',
  2026092801: '1.3',
  2026092802: '1.4',
});

const BUILD = /^Wasla\/(\d{6,12})(?:\s|$)/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** "2026092802" from the app's User-Agent, or null for anything else. */
export function buildFromUserAgent(userAgent) {
  return BUILD.exec(String(userAgent ?? '').trim())?.[1] ?? null;
}

export const versionOf = (build) => BUILD_VERSIONS[build] ?? build;

export function createAppBuilds(db, { siteHost = '', now = () => new Date() } = {}) {
  const upsert = db.prepare(`INSERT INTO app_builds (device, day, build, host) VALUES (?, ?, ?, ?)
    ON CONFLICT(device, day) DO UPDATE SET build = excluded.build, host = excluded.host`);
  // Each phone once: its latest day in the window, and the build and domain it used then.
  const latest = db.prepare(`SELECT b.build, b.host, COUNT(*) AS players FROM app_builds b
    JOIN (SELECT device, MAX(day) AS day FROM app_builds WHERE day >= ? GROUP BY device) l
      ON l.device = b.device AND l.day = b.day
    GROUP BY b.build, b.host`);
  const perDayRows = db.prepare(`SELECT day, COUNT(*) AS players, SUM(CASE WHEN host = ? THEN 0 ELSE 1 END) AS old
    FROM app_builds WHERE day >= ? GROUP BY day`);
  const firstDay = db.prepare('SELECT MIN(day) AS day FROM app_builds');
  const site = String(siteHost).toLowerCase();

  /** Keeps what this phone played today. Anything not the app is ignored. */
  function record({ device, userAgent, host }) {
    const build = buildFromUserAgent(userAgent);
    const domain = String(host ?? '').toLowerCase();
    if (!build || !device || !HOST.test(domain)) return false;
    upsert.run(device, now().toISOString().slice(0, 10), build, domain);
    return true;
  }

  /**
   * The last `days` days: each version with its players (a phone counted once,
   * at the build it played last) and the domain it uses, newest version first,
   * plus how many are still on the old domain.
   */
  function summary(days = 7, today = todayUtc()) {
    const rows = latest.all(addDays(today, -(days - 1)));
    const byBuild = new Map();
    for (const r of rows) {
      const entry = byBuild.get(r.build) ?? { build: r.build, version: versionOf(r.build), players: 0, old: 0 };
      entry.players += r.players;
      if (r.host !== site) entry.old += r.players;
      byBuild.set(r.build, entry);
    }
    const versions = [...byBuild.values()].sort((a, b) => b.build.localeCompare(a.build));
    const total = versions.reduce((sum, v) => sum + v.players, 0);
    const old = versions.reduce((sum, v) => sum + v.old, 0);
    return { days, total, old, oldShare: total ? old / total : 0, versions, since: firstDay.get().day };
  }

  /** Each of the last `days` days: phones seen, and those on the old domain. */
  function perDay(days = 14, today = todayUtc()) {
    const from = addDays(today, -(days - 1));
    const found = new Map(perDayRows.all(site, from).map((r) => [r.day, r]));
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      const row = found.get(date);
      return { date, players: row?.players ?? 0, old: row?.old ?? 0 };
    });
  }

  return { record, summary, perDay };
}
