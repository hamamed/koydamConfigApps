import { iconCategory } from './diff.js';

/**
 * Assembles GET /meta/community from the raw query results. Pure, so the
 * arithmetic (shares, deltas vs average, indexes, ratios) is tested without a
 * database; the route only gathers inputs and caches the result.
 *
 * Shares are fractions (0–1). Every list is already sorted for display.
 */

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Mythic', 'Legendary', 'Masters', 'Pro'];

const ratio = (a, b) => (b > 0 ? a / b : 0);
const sum = (list, f = (x) => x) => list.reduce((t, x) => t + f(x), 0);

/** Ranked division (1 = Bronze I … 22 = Pro) to its tier name. */
export function tierOf(division) {
  if (division >= 22) return 'Pro';
  return TIERS[Math.max(0, Math.ceil(division / 3) - 1)] ?? 'Bronze';
}

/** Best picks (win rate) and most used (pick rate), each measured against the field. */
export function metaBoard(brawlers, { limit = 16, minShare = 0.002 } = {}) {
  const picks = sum(brawlers, (b) => b.picks);
  const decided = sum(brawlers, (b) => b.decided);
  const wins = sum(brawlers, (b) => b.wins);
  const averageWinRate = ratio(wins, decided);
  const averageUseRate = brawlers.length ? 1 / brawlers.length : 0;
  const floor = Math.max(30, decided * minShare);

  const bestPicks = brawlers
    .filter((b) => b.decided >= floor)
    .map((b) => ({ id: b.id, name: b.name, winRate: ratio(b.wins, b.decided), decided: b.decided }))
    .map((b) => ({ ...b, delta: b.winRate - averageWinRate }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);

  const mostUsed = brawlers
    .map((b) => ({ id: b.id, name: b.name, useRate: ratio(b.picks, picks), picks: b.picks }))
    .map((b) => ({ ...b, delta: b.useRate - averageUseRate }))
    .sort((a, b) => b.useRate - a.useRate)
    .slice(0, limit);

  return { picks, decided, averageWinRate, averageUseRate, bestPicks, mostUsed };
}

/** Risers and fallers from the crawler's 7-day movers (win-rate points). */
export function momentum(movers, limit = 5) {
  const rows = movers.map((m) => ({ id: m.id, name: m.name, winRate: m.now, change: m.change }));
  return {
    risers: rows.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, limit),
    fallers: rows.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, limit),
  };
}

export function modeShares(rows, limit = 8) {
  const total = sum(rows, (r) => r.battles);
  return {
    total,
    rows: rows.slice(0, limit).map((r) => ({ mode: r.mode, battles: r.battles, share: ratio(r.battles, total) })),
  };
}

/** Each ranked tier's battle count and its four best brawlers by win rate. */
export function rankedTiers(rows, { top = 4, minDecided = 30 } = {}) {
  const tiers = new Map();
  for (const r of rows) {
    const name = tierOf(r.division);
    const tier = tiers.get(name) ?? { tier: name, battles: 0, brawlers: new Map() };
    tier.battles += r.battles;
    const b = tier.brawlers.get(r.id) ?? { id: r.id, name: r.name, decided: 0, wins: 0 };
    b.decided += r.decided;
    b.wins += r.wins;
    tier.brawlers.set(r.id, b);
    tiers.set(name, tier);
  }
  return TIERS.filter((t) => tiers.has(t)).map((t) => {
    const tier = tiers.get(t);
    const best = [...tier.brawlers.values()]
      .filter((b) => b.decided >= minDecided)
      .map((b) => ({ id: b.id, name: b.name, winRate: ratio(b.wins, b.decided) }))
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, top);
    // `battles` is summed per (division, brawler), so a lobby with three
    // players in one tier counts three times: it is ranked appearances.
    return { tier: t, appearances: tier.battles, top: best };
  });
}

/** Daily activity indexed to the week's average (100 = average day). */
export function rhythm(days) {
  const avg = ratio(sum(days, (d) => d.battles), days.length);
  const rows = days.map((d) => {
    const weekday = WEEKDAYS[new Date(`${d.day}T00:00:00Z`).getUTCDay()];
    return { day: d.day, weekday, battles: d.battles, index: Math.round(ratio(d.battles, avg) * 100) };
  });
  if (!rows.length) return { days: [], peak: null, quietest: null, weekday: 0, weekend: 0, weekendLift: 0 };
  const peak = rows.reduce((a, b) => (b.index > a.index ? b : a));
  const quietest = rows.reduce((a, b) => (b.index < a.index ? b : a));
  const isWeekend = (r) => r.weekday === 'SAT' || r.weekday === 'SUN';
  const weekdayRows = rows.filter((r) => !isWeekend(r));
  const weekendRows = rows.filter(isWeekend);
  const weekday = ratio(sum(weekdayRows, (r) => r.battles), weekdayRows.length);
  const weekend = ratio(sum(weekendRows, (r) => r.battles), weekendRows.length);
  return {
    days: rows,
    peak: { weekday: peak.weekday, index: peak.index },
    quietest: { weekday: quietest.weekday, index: quietest.index },
    weekendIndex: weekday > 0 && weekend > 0 ? Math.round((weekend / weekday) * 100) : 0,
    weekendLift: weekday > 0 && weekend > 0 ? weekend / weekday - 1 : 0,
  };
}

export function trophyBreakdown(days) {
  return {
    days,
    gained: sum(days, (d) => d.gained),
    lost: sum(days, (d) => d.lost),
    resultsPerDay: Math.round(ratio(sum(days, (d) => d.results), days.length)),
  };
}

// ── Community activity ─────────────────────────────────────────────────────────

function byKind(totals) {
  const map = new Map();
  for (const r of totals) {
    const k = map.get(r.kind) ?? { total: r.total, distinct: r.distinct, rows: [] };
    k.rows.push(r);
    map.set(r.kind, k);
  }
  return map;
}

const total = (kinds, kind) => kinds.get(kind)?.total ?? 0;

/** Top rows of one kind as `{ id, name, n, share }` (share of that kind). */
function top(kinds, kind, limit = 10) {
  const k = kinds.get(kind);
  if (!k) return [];
  return k.rows.slice(0, limit).map((r) => ({ id: r.id, name: r.subject, n: r.n, share: ratio(r.n, k.total) }));
}

/** "from>to" transitions as `{ from, to, n, share }`, plus how many more exist. */
function transitions(kinds, kind, limit) {
  const k = kinds.get(kind);
  if (!k) return { total: 0, rows: [], more: 0 };
  const rows = k.rows.slice(0, limit).map((r) => {
    const [from, to] = r.subject.split('>');
    return { from, to, n: r.n, share: ratio(r.n, k.total) };
  });
  return { total: k.total, rows, more: Math.max(0, k.distinct - rows.length) };
}

function composition(kinds, parts) {
  const all = sum(parts, (p) => total(kinds, p.kind));
  return parts
    .map((p) => ({ key: p.key, label: p.label, n: total(kinds, p.kind), share: ratio(total(kinds, p.kind), all) }))
    .sort((a, b) => b.n - a.n);
}

function distribution(kinds, kind) {
  const k = kinds.get(kind);
  if (!k) return [];
  return k.rows.map((r) => ({ value: r.id, n: r.n })).sort((a, b) => a.value - b.value);
}

/** Per-day series for the given kinds, every day present (0 when quiet). */
function series(daily, days, keys) {
  return days.map((day) => {
    const row = { day };
    for (const [key, kinds] of Object.entries(keys)) {
      row[key] = sum(daily.filter((d) => d.day === day && kinds.includes(d.kind)), (d) => d.n);
    }
    return row;
  });
}

const UNLOCKS = [
  { key: 'starpower', label: 'Star Powers', kind: 'unlock.starpower' },
  { key: 'gadget', label: 'Gadgets', kind: 'unlock.gadget' },
  { key: 'hypercharge', label: 'Hypercharges', kind: 'unlock.hypercharge' },
  { key: 'gear', label: 'Gears', kind: 'unlock.gear' },
  { key: 'brawler', label: 'Brawlers', kind: 'unlock.brawler' },
];
const PROGRESSION = [
  { key: 'rankup', label: 'Rank-Ups', kind: 'prog.rankup' },
  { key: 'streak', label: 'Win Streaks', kind: 'prog.streak' },
  { key: 'powerup', label: 'Power-Ups', kind: 'prog.powerup' },
  { key: 'prestige', label: 'Prestige', kind: 'prog.prestige' },
  { key: 'levelup', label: 'Level-Ups', kind: 'prog.levelup' },
];
const CLUB = [
  { key: 'memberLeave', label: 'Member Leaves', kind: 'club.member_leave' },
  { key: 'memberJoin', label: 'Member Joins', kind: 'club.member_join' },
  { key: 'switch', label: 'Club Switches', kind: 'club.switch' },
  { key: 'leave', label: 'Club Departures', kind: 'club.leave' },
  { key: 'join', label: 'Club Joins', kind: 'club.join' },
];
const ICON_CATEGORIES = [
  { key: 'other', label: 'Other Icons' },
  { key: 'purchasable', label: 'Purchasable Icons' },
  { key: 'brawler', label: 'Brawler Icons' },
  { key: 'fame', label: 'Fame Icons' },
  { key: 'esports', label: 'Esports Icons' },
];

function icons(kinds, daily, days, iconCatalog) {
  const categoryOf = (id) => iconCategory(iconCatalog?.[id]);
  const gained = kinds.get('icon.gain')?.rows ?? [];
  const dropped = kinds.get('icon.drop')?.rows ?? [];
  const all = sum(gained, (r) => r.n);

  const categories = ICON_CATEGORIES.map(({ key, label }) => {
    const g = gained.filter((r) => categoryOf(r.id) === key);
    const d = dropped.filter((r) => categoryOf(r.id) === key);
    const gTotal = sum(g, (r) => r.n);
    const dTotal = sum(d, (r) => r.n);
    const limit = key === 'esports' ? 25 : 10;
    const rows = (list, t) => list.slice(0, limit).map((r) => ({ id: r.id, n: r.n, share: ratio(r.n, t) }));
    return {
      key,
      label,
      gained: gTotal,
      abandoned: dTotal,
      share: ratio(gTotal, all),
      topGained: rows(g, gTotal),
      topAbandoned: rows(d, dTotal),
    };
  });

  return {
    total: all,
    composition: categories
      .map((c) => ({ key: c.key, label: c.label, n: c.gained, share: c.share }))
      .sort((a, b) => b.n - a.n),
    categories,
    hot: gained[0] ? { id: gained[0].id, n: gained[0].n, share: ratio(gained[0].n, all) } : null,
    daily: series(daily, days, { gained: ['icon.gain'], abandoned: ['icon.drop'] }),
    transitions: transitions(kinds, 'icon.move', 10),
  };
}

export function activity({ totals, daily, days, iconCatalog, trackingSince }) {
  const kinds = byKind(totals);
  const unlocks = UNLOCKS.map((u) => u.kind);
  const progression = PROGRESSION.map((p) => p.kind);
  const clubSide = ['club.join', 'club.leave', 'club.switch'];

  const unlockTotal = sum(unlocks, (k) => total(kinds, k));
  const progTotal = sum(progression, (k) => total(kinds, k));
  const skinTotal = total(kinds, 'skin');
  const clubTotal = sum(clubSide, (k) => total(kinds, k));
  const iconTotal = total(kinds, 'icon.gain');
  const everything = unlockTotal + progTotal + skinTotal + clubTotal + iconTotal;

  const built = total(kinds, 'prog.streak');
  const broken = total(kinds, 'prog.streakbreak');
  const clubJoins = total(kinds, 'club.join');
  const clubLeaves = total(kinds, 'club.leave');
  const memberJoins = total(kinds, 'club.member_join');
  const memberLeaves = total(kinds, 'club.member_leave');
  const switches = total(kinds, 'club.switch');

  return {
    ready: everything > 0,
    trackingSince,
    events: everything,
    overview: [
      { key: 'unlocks', label: 'Unlocks', n: unlockTotal },
      { key: 'progression', label: 'Progression', n: progTotal },
      { key: 'skins', label: 'Skins', n: skinTotal },
      { key: 'club', label: 'Club', n: clubTotal },
      { key: 'icons', label: 'Icons', n: iconTotal },
    ].map((r) => ({ ...r, share: ratio(r.n, everything) })).sort((a, b) => b.n - a.n),
    unlocks: {
      total: unlockTotal,
      composition: composition(kinds, UNLOCKS),
      top: Object.fromEntries(UNLOCKS.map((u) => [u.key, top(kinds, u.kind)])),
      totals: Object.fromEntries(UNLOCKS.map((u) => [u.key, total(kinds, u.kind)])),
      daily: series(daily, days, Object.fromEntries(UNLOCKS.map((u) => [u.key, [u.kind]]))),
    },
    progression: {
      total: progTotal,
      composition: composition(kinds, PROGRESSION),
      streaks: { built, broken, ratio: ratio(built, broken) },
      top: {
        powerup: top(kinds, 'prog.powerup'),
        prestige: top(kinds, 'prog.prestige'),
        streak: top(kinds, 'prog.streak'),
        streakbreak: top(kinds, 'prog.streakbreak'),
      },
      totals: {
        powerup: total(kinds, 'prog.powerup'),
        prestige: total(kinds, 'prog.prestige'),
        streak: built,
        streakbreak: broken,
      },
      distributions: {
        rank: distribution(kinds, 'dist.rank'),
        level: distribution(kinds, 'dist.level'),
        streak: distribution(kinds, 'dist.streak'),
      },
      daily: series(daily, days, Object.fromEntries(PROGRESSION.map((p) => [p.key, [p.kind]]))),
    },
    club: {
      total: sum(CLUB, (c) => total(kinds, c.kind)),
      composition: composition(kinds, CLUB),
      playersToClubs: { joins: clubJoins, leaves: clubLeaves, ratio: ratio(clubJoins, clubLeaves) },
      membersInOut: { joins: memberJoins, leaves: memberLeaves, ratio: ratio(memberJoins, memberLeaves) },
      players: {
        total: clubJoins + clubLeaves + switches,
        joins: ratio(clubJoins, clubJoins + clubLeaves + switches),
        departures: ratio(clubLeaves, clubJoins + clubLeaves + switches),
        switches: ratio(switches, clubJoins + clubLeaves + switches),
      },
      net: { membership: clubJoins - clubLeaves, members: memberJoins - memberLeaves },
      roles: transitions(kinds, 'club.role', 6),
      types: transitions(kinds, 'club.type', 6),
      badges: transitions(kinds, 'club.badge', 8),
      badgesTo: top(kinds, 'club.badge_to'),
      badgesFrom: top(kinds, 'club.badge_from'),
      daily: series(daily, days, {
        join: ['club.join'],
        leave: ['club.leave'],
        memberJoin: ['club.member_join'],
        memberLeave: ['club.member_leave'],
      }),
    },
    icons: icons(kinds, daily, days, iconCatalog),
  };
}

/** Every UTC day from `from` to `to` inclusive, as YYYY-MM-DD. */
export function dayRange(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function buildReport(input, now = new Date()) {
  const to = now.toISOString().slice(0, 10);
  const days = dayRange(input.from, to);
  return {
    generatedAt: now.toISOString(),
    range: { from: input.from, to, days: days.length },
    meta: metaBoard(input.brawlers),
    momentum: momentum(input.movers),
    modes: modeShares(input.modes),
    ranked: rankedTiers(input.ranked),
    trophies: trophyBreakdown(input.trophies),
    rhythm: rhythm(input.battlesPerDay),
    activity: activity({
      totals: input.activityTotals,
      daily: input.activityDaily,
      days,
      iconCatalog: input.iconCatalog,
      trackingSince: input.pipeline?.trackingSince ?? null,
    }),
    pipeline: input.pipeline,
  };
}
