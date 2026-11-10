import { metaBoard, tierOf } from './report.js';

/**
 * Assembles the brawler, map and mode pages from query results. Pure: the
 * routes gather inputs, these do the arithmetic. Rates are fractions (0–1).
 */

const ratio = (a, b) => (b > 0 ? a / b : 0);
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const RANGES = ['0-499', '500-999', '1000+'];
const TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Mythic', 'Legendary', 'Masters', 'Pro'];

/** Minimum decided games for a win rate to be shown or ranked. */
export const MIN_GAMES = 30;

/** 1-based rank of `id` by win rate among rows with enough games, and the field size. */
export function winRateRank(rows, id, minGames = MIN_GAMES) {
  const ranked = rows.filter((r) => r.decided >= minGames).sort((a, b) => ratio(b.wins, b.decided) - ratio(a.wins, a.decided));
  const at = ranked.findIndex((r) => r.id === id);
  return { rank: at >= 0 ? at + 1 : null, of: ranked.length };
}

/** "123:NAME" → { id: 123, name: "NAME" }. */
const splitSubject = (s) => {
  const at = s.indexOf(':');
  return at < 0 ? { id: 0, name: s } : { id: Number(s.slice(0, at)) || 0, name: s.slice(at + 1) };
};

/** Rows of one per-brawler counter kind as `{ id, name, n, share }`, biggest first. */
function counterRows(counters, kind) {
  const rows = counters.filter((c) => c.kind === kind);
  const total = sum(rows, (r) => r.n);
  return {
    total,
    rows: rows
      .map((r) => ({ ...splitSubject(r.subject), n: r.n }))
      .map((r) => ({ ...r, share: ratio(r.n, total) }))
      .sort((a, b) => b.n - a.n),
  };
}

// ── Brawler ──────────────────────────────────────────────────────────────────

export function brawlerProfile({ id, totals, ranges, ranked, modes, maps, daily, counters }) {
  const own = totals.find((t) => t.id === id) ?? { picks: 0, decided: 0, wins: 0 };
  const overall = { winRate: ratio(own.wins, own.decided), games: own.decided, ...winRateRank(totals, id) };

  const byRange = RANGES.map((range) => {
    const rows = ranges.filter((r) => r.range === range);
    const mine = rows.find((r) => r.id === id) ?? { decided: 0, wins: 0 };
    return { range, winRate: ratio(mine.wins, mine.decided), games: mine.decided, ...winRateRank(rows, id) };
  });

  const mineRanked = ranked.filter((r) => r.id === id);
  const rankedDecided = sum(mineRanked, (r) => r.decided);
  const rankedTiers = TIERS.map((tier) => {
    const rows = mineRanked.filter((r) => tierOf(r.division) === tier);
    const d = sum(rows, (r) => r.decided);
    return { tier, winRate: ratio(sum(rows, (r) => r.wins), d), games: d };
  }).filter((t) => t.games > 0);

  const modeRows = modes
    .map((m) => ({ mode: m.mode, winRate: ratio(m.wins, m.decided), useRate: ratio(m.picks, m.modePicks), games: m.decided, picks: m.picks }))
    .filter((m) => m.picks > 0)
    .sort((a, b) => b.picks - a.picks);
  const modeRate = new Map(modeRows.map((m) => [m.mode, m.winRate]));
  const mapRows = maps
    .filter((m) => m.decided >= MIN_GAMES)
    .map((m) => {
      const winRate = ratio(m.wins, m.decided);
      return { map: m.map, mode: m.mode, winRate, games: m.decided, vsMode: winRate - (modeRate.get(m.mode) ?? winRate) };
    })
    .sort((a, b) => b.vsMode - a.vsMode);

  const starPowers = counterRows(counters, 'b.starpower');
  const gadgets = counterRows(counters, 'b.gadget');
  const gears = counterRows(counters, 'b.gear');
  const buffies = counterRows(counters, 'b.buffie');
  const skins = counterRows(counters, 'b.skin');
  const count = (kind) => sum(counters.filter((c) => c.kind === kind), (c) => c.n);

  return {
    id,
    overall,
    ranges: byRange,
    ranked: { winRate: ratio(sum(mineRanked, (r) => r.wins), rankedDecided), games: rankedDecided, tiers: rankedTiers },
    modes: modeRows,
    bestMaps: mapRows.slice(0, 8),
    worstMaps: mapRows.slice(-5).reverse(),
    daily: daily.map((d) => ({ day: d.day, winRate: ratio(d.wins, d.decided), games: d.decided, picks: d.picks })),
    build: {
      starPower: starPowers.rows[0] ? { ...starPowers.rows[0], of: starPowers.total } : null,
      gadget: gadgets.rows[0] ? { ...gadgets.rows[0], of: gadgets.total } : null,
      gears: gears.rows.slice(0, 2).map((g) => ({ ...g, of: gears.total })),
    },
    starPowers,
    gadgets,
    gears,
    buffies,
    skins: { total: skins.total, rows: skins.rows.slice(0, 10) },
    unlocks: { brawler: count('unlock.brawler'), hypercharge: count('unlock.hypercharge'), powerups: count('prog.powerup'), prestige: count('prog.prestige') },
  };
}

// ── Map ──────────────────────────────────────────────────────────────────────

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function distribution(values, bins = 12, max = 1) {
  const counts = Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.max(0, Math.floor((v / (max || 1)) * bins)))] += 1;
  return {
    median: median(values),
    average: values.length ? sum(values, (v) => v) / values.length : 0,
    max,
    bins: counts,
  };
}

/** Per-brawler rows for one trophy range ('all' merges them). */
function rangeRows(rows, range) {
  const picked = range === 'all' ? rows : rows.filter((r) => r.range === range);
  const byId = new Map();
  for (const r of picked) {
    const acc = byId.get(r.id) ?? { id: r.id, name: r.name, picks: 0, decided: 0, wins: 0, stars: 0 };
    acc.picks += r.picks; acc.decided += r.decided; acc.wins += r.wins; acc.stars += r.stars;
    byId.set(r.id, acc);
  }
  return [...byId.values()];
}

/**
 * Wilson lower bound of a win rate (95%). Ranks small samples honestly: 5-0
 * scores below 140-60, where sorting by raw win rate puts every 100% first.
 */
export function wilson(wins, games, z = 1.96) {
  if (games <= 0) return 0;
  const p = wins / games;
  const d = 1 + (z * z) / games;
  return (p + (z * z) / (2 * games) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * games)) / games)) / d;
}

/** Team stats: top line-ups and, for each brawler, its best teammates. */
export function teamStats(teams, { minGames = 10 } = {}) {
  const top = teams
    .filter((t) => t.games >= minGames)
    .map((t) => ({ ids: t.comp, games: t.games, winRate: ratio(t.wins, t.games), score: wilson(t.wins, t.games) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ score, ...t }) => t);
  const pairs = new Map();
  for (const t of teams) {
    for (let i = 0; i < t.comp.length; i++) {
      for (let j = 0; j < t.comp.length; j++) {
        if (i === j) continue;
        const key = `${t.comp[i]}:${t.comp[j]}`;
        const acc = pairs.get(key) ?? { a: t.comp[i], b: t.comp[j], games: 0, wins: 0 };
        acc.games += t.games; acc.wins += t.wins;
        pairs.set(key, acc);
      }
    }
  }
  const partnersOf = (id) => [...pairs.values()]
    .filter((p) => p.a === id && p.games >= minGames)
    .map((p) => ({ id: p.b, games: p.games, winRate: ratio(p.wins, p.games), score: wilson(p.wins, p.games) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score, ...p }) => p);
  return { top, partnersOf };
}

/** Rotation history: appearances, live hours, first seen, cadence, slots. */
export function rotationSummary(rotations, now = new Date()) {
  const windows = rotations.filter((r) => r.start).map((r) => ({
    start: new Date(r.start), end: r.end ? new Date(r.end) : null, slot: r.slot, mode: r.mode,
  }));
  if (!windows.length) return { appearances: 0, liveHours: 0, firstSeen: null, lastSeen: null, cadenceHours: null, live: false, slots: [], recent: [] };
  const hours = sum(windows, (w) => (w.end ? (w.end - w.start) / 3_600_000 : 0));
  const gaps = windows.slice(1).map((w, i) => (w.start - windows[i].start) / 3_600_000).filter((g) => g > 0);
  const last = windows[windows.length - 1];
  return {
    appearances: windows.length,
    liveHours: Math.round(hours),
    firstSeen: windows[0].start.toISOString(),
    lastSeen: (last.end ?? last.start).toISOString(),
    cadenceHours: gaps.length ? Math.round(median(gaps)) : null,
    live: Boolean(last.end && last.end > now && last.start <= now),
    slots: [...new Set(windows.map((w) => w.slot).filter((s) => s != null))],
    recent: windows.slice(-8).reverse().map((w) => ({ start: w.start.toISOString(), end: w.end?.toISOString() ?? null, slot: w.slot })),
  };
}

export function mapProfile({ map, range = 'all', rows, ranked, teams, summary, rotations, modeRows, now = new Date() }) {
  const brawlers = rangeRows(rows, range);
  const picks = sum(brawlers, (b) => b.picks);
  const decided = sum(brawlers, (b) => b.decided);
  const avg = ratio(sum(brawlers, (b) => b.wins), decided);
  const minGames = Math.max(8, Math.round(decided * 0.004));
  const stat = (b) => ({
    id: b.id, name: b.name, games: b.decided,
    winRate: ratio(b.wins, b.decided), useRate: ratio(b.picks, picks), starRate: ratio(b.stars, b.decided),
  });
  const rated = brawlers.filter((b) => b.decided >= minGames).map(stat);
  const byWin = [...rated].sort((a, b) => b.winRate - a.winRate);
  const byUse = brawlers.map(stat).sort((a, b) => b.useRate - a.useRate);

  // Best picks: the top 30 by both win and use rate, ranked by the sum of ranks.
  const winRank = new Map(byWin.map((b, i) => [b.id, i]));
  const useRank = new Map(byUse.map((b, i) => [b.id, i]));
  const best = rated
    .filter((b) => winRank.get(b.id) < 30 && useRank.get(b.id) < 30)
    .sort((a, b) => winRank.get(a.id) + useRank.get(a.id) - (winRank.get(b.id) + useRank.get(b.id)))
    .slice(0, 10);
  const notRecommended = rated
    .filter((b) => b.winRate < avg && b.useRate < 1 / Math.max(1, brawlers.length))
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 10);

  const top5 = byUse.slice(0, 5).reduce((t, b) => t + b.useRate, 0);
  const sleeper = rated.filter((b) => b.useRate < 0.03).sort((a, b) => b.winRate - a.winRate)[0] ?? null;
  const trap = rated.filter((b) => b.winRate < avg).sort((a, b) => b.useRate - a.useRate)[0] ?? null;

  const { top, partnersOf } = teamStats(teams);
  const pairs = best.slice(0, 3).map((b) => ({ id: b.id, name: b.name, winRate: b.winRate, games: b.games, partners: partnersOf(b.id) }));

  const modeMap = new Map(modeRows.map((m) => [m.id, m]));
  const vsMode = rated
    .map((b) => {
      const m = modeMap.get(b.id);
      return m && m.decided >= MIN_GAMES ? { id: b.id, name: b.name, here: b.winRate, mode: ratio(m.wins, m.decided), gap: b.winRate - ratio(m.wins, m.decided), games: b.games } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 8);

  const all = rangeRows(rows, 'all');
  const trophyRanges = RANGES.map((r) => {
    const rr = rangeRows(rows, r);
    const d = sum(rr, (b) => b.decided);
    return { range: r, winRate: ratio(sum(rr, (b) => b.wins), d), games: sum(rr, (b) => b.picks) };
  });

  const rankedRated = ranked.filter((r) => r.decided >= 10)
    .map((r) => ({ id: r.id, name: r.name, winRate: ratio(r.wins, r.decided), games: r.decided }))
    .sort((a, b) => b.winRate - a.winRate);

  return {
    map,
    mode: summary.mode,
    range,
    battles: summary.battles,
    picks,
    lastPlayed: summary.lastAt,
    avgDuration: summary.avgDuration,
    confidence: summary.battles >= 2000 ? 'high' : summary.battles >= 300 ? 'medium' : 'low',
    averageWinRate: avg,
    bestPicks: best,
    winners: byWin.slice(0, 10),
    mostUsed: byUse.slice(0, 10),
    notRecommended,
    snapshot: { top5Share: top5, sleeper, trap },
    topTeams: top,
    pairs,
    distributions: {
      winRate: distribution(rated.map((b) => b.winRate), 12, 1),
      useRate: distribution(byUse.map((b) => b.useRate), 12, Math.max(0.01, byUse[0]?.useRate ?? 0.01)),
      starRate: distribution(rated.map((b) => b.starRate), 12, Math.max(0.01, ...rated.map((b) => b.starRate))),
    },
    trophyRanges,
    vsMode,
    ranked: { games: sum(ranked, (r) => r.decided), top: rankedRated.slice(0, 10) },
    rotation: rotationSummary(rotations, now),
    sampleBrawlers: all.length,
  };
}

// ── Mode ─────────────────────────────────────────────────────────────────────

export function modeProfile({ mode, board, ranked, maps, summary, daily }) {
  const meta = metaBoard(board);
  const rankedBoard = metaBoard(ranked.map((r) => ({ ...r })), { limit: 16 });
  return {
    mode,
    battles: summary.battles,
    share: summary.share,
    avgDuration: summary.avgDuration,
    mapsPlayed: summary.maps,
    meta,
    ranked: { games: rankedBoard.decided, bestPicks: rankedBoard.bestPicks, averageWinRate: rankedBoard.averageWinRate },
    maps,
    daily,
  };
}
