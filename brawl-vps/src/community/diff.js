/**
 * Community telemetry: what changed between two reads of the same profile or
 * club.
 *
 * The API reports state, never events. A player unlocking Vince, powering up
 * Shade or swapping their profile icon exists only as the difference between
 * two reads, so each read is compacted (`compactProfile`, `compactClub`), kept,
 * and the next read is diffed against it. Everything here is pure: no I/O, so
 * the rules are pinned down by tests rather than by a database.
 *
 * An event is `{ kind, id, subject }`: `id` is the game id when there is one
 * (brawler, gear, icon, badge), otherwise 0; `subject` is its display name or a
 * "from>to" label. The repo turns a list of these into daily counters.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ids = (list) => (Array.isArray(list) ? list.map((x) => num(x?.id)).filter(Boolean) : []);
const names = (list) =>
  new Map((Array.isArray(list) ? list : []).map((x) => [num(x?.id), String(x?.name ?? '')]));

/**
 * The part of a raw `/players/{tag}` response worth diffing, kept small: a few
 * hundred bytes per brawler would be most of the table.
 *
 * Brawler tuple: [power, rank, prestige, currentWinStreak, gadgetIds,
 * starPowerIds, gearIds, hyperchargeIds, skinId, buffieKeys].
 */
export function compactProfile(raw) {
  const brawlers = {};
  for (const b of Array.isArray(raw?.brawlers) ? raw.brawlers : []) {
    const id = num(b?.id);
    if (!id) continue;
    brawlers[id] = [
      num(b.power),
      num(b.rank),
      num(b.prestigeLevel),
      num(b.currentWinStreak),
      ids(b.gadgets),
      ids(b.starPowers),
      ids(b.gears),
      ids(b.hyperCharges),
      num(b.skin?.id),
      buffieKeys(b.buffies),
    ];
  }
  return {
    v: 1,
    icon: num(raw?.icon?.id),
    club: raw?.club?.tag ? String(raw.club.tag) : null,
    level: num(raw?.expLevel),
    brawlers,
  };
}

/**
 * Owned Buffies as sorted keys ("gadget", "starPower", "hyperCharge"). The API
 * reports them as booleans; anything else (absent, older payloads) is none.
 */
function buffieKeys(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).filter(([, v]) => v === true).map(([k]) => k).sort();
}

/** Ids in `next` that `prev` lacks. */
const added = (prev = [], next = []) => {
  const had = new Set(prev);
  return next.filter((id) => !had.has(id));
};

/**
 * Events between two compact profiles. `raw` is the read `next` came from, for
 * names (the compact form keeps ids only). No previous read means no events:
 * a first sighting says what someone owns, not what they just got.
 */
export function diffProfiles(prev, next, raw) {
  if (!prev || prev.v !== next?.v) return [];
  const events = [];
  const push = (kind, id, subject) => events.push({ kind, id: num(id), subject: String(subject ?? '') });

  const rawBrawlers = new Map(
    (Array.isArray(raw?.brawlers) ? raw.brawlers : []).map((b) => [num(b?.id), b]),
  );

  for (const [key, now] of Object.entries(next.brawlers ?? {})) {
    const id = Number(key);
    const r = rawBrawlers.get(id) ?? {};
    const name = String(r.name ?? '');
    const was = prev.brawlers?.[key];

    if (!was) {
      push('unlock.brawler', id, name);
      continue;
    }

    const [power, rank, prestige, streak, gadgets, starPowers, gears, hypercharges, skin, buffies] = now;
    const [pPower, pRank, pPrestige, pStreak, pGadgets, pStarPowers, pGears, pHyper, pSkin, pBuffies] = was;

    if (power > pPower) push('prog.powerup', id, name);
    if (rank > pRank) {
      push('prog.rankup', id, name);
      push('dist.rank', rank, String(rank));
    }
    if (prestige > pPrestige) push('prog.prestige', id, name);
    if (streak > pStreak) {
      push('prog.streak', id, name);
    } else if (streak < pStreak) {
      // The streak broke (and possibly restarted) between reads. Its length
      // when last seen is the best the API offers.
      push('prog.streakbreak', id, name);
      push('dist.streak', pStreak, String(pStreak));
    }

    // Each unlock is counted twice: once by the item (community totals) and
    // once against the brawler as "itemId:name" (the brawler's own page).
    const gadgetNames = names(r.gadgets);
    for (const g of added(pGadgets, gadgets)) {
      push('unlock.gadget', g, gadgetNames.get(g));
      push('b.gadget', id, `${g}:${gadgetNames.get(g) ?? ''}`);
    }
    const spNames = names(r.starPowers);
    for (const s of added(pStarPowers, starPowers)) {
      push('unlock.starpower', s, spNames.get(s));
      push('b.starpower', id, `${s}:${spNames.get(s) ?? ''}`);
    }
    const gearNames = names(r.gears);
    for (const g of added(pGears, gears)) {
      push('unlock.gear', g, gearNames.get(g));
      push('b.gear', id, `${g}:${gearNames.get(g) ?? ''}`);
    }
    // Counted against the brawler, which is how a hypercharge is known.
    if (added(pHyper, hypercharges).length) push('unlock.hypercharge', id, name);
    if (skin && skin !== pSkin) {
      push('skin', skin, r.skin?.name ?? '');
      push('b.skin', id, `${skin}:${r.skin?.name ?? ''}`);
    }
    for (const key of added(pBuffies ?? [], buffies ?? [])) push('b.buffie', id, key);
  }

  if (next.level > prev.level) {
    push('prog.levelup', 0, '');
    push('dist.level', next.level, String(next.level));
  }

  if (next.icon && prev.icon && next.icon !== prev.icon) {
    push('icon.gain', next.icon, '');
    push('icon.drop', prev.icon, '');
    push('icon.move', 0, `${prev.icon}>${next.icon}`);
  }

  if (prev.club !== next.club) {
    if (!prev.club) push('club.join', 0, '');
    else if (!next.club) push('club.leave', 0, '');
    else push('club.switch', 0, '');
  }

  return events;
}

/** The part of a raw `/clubs/{tag}` response worth diffing. */
export function compactClub(raw) {
  const members = {};
  for (const m of Array.isArray(raw?.members) ? raw.members : []) {
    if (m?.tag) members[m.tag] = String(m.role ?? 'member');
  }
  return { v: 1, type: String(raw?.type ?? ''), badge: num(raw?.badgeId), members };
}

/** Events between two compact clubs, seen from the club's side. */
export function diffClubs(prev, next) {
  if (!prev || prev.v !== next?.v) return [];
  const events = [];
  const push = (kind, id, subject) => events.push({ kind, id: num(id), subject: String(subject ?? '') });

  for (const [tag, role] of Object.entries(next.members ?? {})) {
    const was = prev.members?.[tag];
    if (!was) push('club.member_join', 0, '');
    else if (was !== role) push('club.role', 0, `${was}>${role}`);
  }
  for (const tag of Object.keys(prev.members ?? {})) {
    if (!next.members?.[tag]) push('club.member_leave', 0, '');
  }
  if (prev.type && next.type && prev.type !== next.type) push('club.type', 0, `${prev.type}>${next.type}`);
  if (prev.badge && next.badge && prev.badge !== next.badge) {
    push('club.badge', 0, `${prev.badge}>${next.badge}`);
    push('club.badge_to', next.badge, '');
    push('club.badge_from', prev.badge, '');
  }
  return events;
}

/** Collapses events into `{ kind, id, subject, events }` counters. */
export function tally(events) {
  const counts = new Map();
  for (const e of events) {
    const key = `${e.kind}\u0000${e.id}\u0000${e.subject}`;
    const row = counts.get(key) ?? { kind: e.kind, id: e.id, subject: e.subject, events: 0 };
    row.events += 1;
    counts.set(key, row);
  }
  return [...counts.values()];
}

/**
 * Brawlify-style icon category from the public icon catalog entry
 * (api.brawlapi.com/v1/icons): esports and fame by name, brawler icons by
 * their brawler link, shop icons by offer flag, everything else "other".
 */
export function iconCategory(entry) {
  if (!entry) return 'other';
  const label = `${entry.name ?? ''} ${entry.name2 ?? ''}`.toLowerCase();
  if (label.includes('esports')) return 'esports';
  if (label.includes('_fame_')) return 'fame';
  if (entry.brawler) return 'brawler';
  if (entry.isAvailableForOffers) return 'purchasable';
  return 'other';
}
