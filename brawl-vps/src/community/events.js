/**
 * Assembles GET /events/overview: each live event with its map's best picks,
 * most used, top teams, battles and match length, predicted next maps, a
 * trophy-band breakdown, and the ranked map pool by tier. Pure.
 */

const ratio = (a, b) => (b > 0 ? a / b : 0);
const BANDS = ['0-99', '100-299', '300-499', '500-699', '700-899', '900-1099', '1100-1299', '1300+'];
const TIERS = ['All', 'Bronze', 'Silver', 'Gold', 'Diamond', 'Mythic', 'Legendary', 'Masters', 'Pro'];

/** One live event card from its map profile (null when the map has no sample). */
export function eventStats(profile) {
  if (!profile || !profile.battles) return null;
  const n = Math.max(1, profile.sampleBrawlers ?? 1);
  return {
    battles: profile.battles,
    avgDuration: profile.avgDuration,
    confidence: profile.confidence,
    bestPicks: profile.bestPicks.slice(0, 6).map((b) => ({ id: b.id, name: b.name, winRate: b.winRate, delta: b.winRate - profile.averageWinRate })),
    mostUsed: profile.mostUsed.slice(0, 6).map((b) => ({ id: b.id, name: b.name, useRate: b.useRate, delta: b.useRate - 1 / n })),
    topTeams: profile.topTeams.slice(0, 3),
  };
}

export function trophyBreakdown(rows) {
  const total = rows.reduce((t, r) => t + r.n, 0);
  return { total, bands: BANDS.map((label, i) => ({ label, n: rows.find((r) => r.band === i)?.n ?? 0 })) };
}

/** Ranked pool: per map, battles and the best picks per tier (vs that tier's average on the map). */
export function rankedPool(rows, { top = 8, minGames = 20 } = {}) {
  const maps = new Map();
  for (const r of rows) {
    const m = maps.get(r.map) ?? { map: r.map, mode: r.mode, picks: 0, byTier: new Map() };
    m.picks += r.picks;
    for (const tier of ['All', r.tier]) {
      const t = m.byTier.get(tier) ?? new Map();
      const b = t.get(r.id) ?? { id: r.id, name: r.name, decided: 0, wins: 0 };
      b.decided += r.decided; b.wins += r.wins;
      t.set(r.id, b);
      m.byTier.set(tier, t);
    }
    maps.set(r.map, m);
  }
  return [...maps.values()]
    .map((m) => ({
      map: m.map,
      mode: m.mode,
      battles: Math.round(m.picks / 6),
      tiers: Object.fromEntries(TIERS.filter((t) => m.byTier.has(t)).map((t) => {
        const list = [...m.byTier.get(t).values()];
        const avg = ratio(list.reduce((s, b) => s + b.wins, 0), list.reduce((s, b) => s + b.decided, 0));
        const best = list.filter((b) => b.decided >= minGames)
          .map((b) => ({ id: b.id, name: b.name, winRate: ratio(b.wins, b.decided), delta: ratio(b.wins, b.decided) - avg }))
          .sort((a, b) => b.winRate - a.winRate).slice(0, top);
        return [t, best];
      })),
    }))
    .sort((a, b) => b.battles - a.battles);
}
