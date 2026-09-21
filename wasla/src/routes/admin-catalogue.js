import { avatarCatalogue, BADGE_KIND_NOTES, BADGE_KIND_TITLES, BADGE_KINDS, BADGES, badgeTitle, frameCatalogue, readBadge } from '../catalogue.js';

const EARNERS = 40;

/**
 * The catalogue pages: which badge each player earned, and which avatar and
 * frame they are wearing.
 *
 * Nothing here changes anything — the app decides what is earned and what is
 * open. The panel could not see any of it before, so "why has nobody got the
 * streak badge" was a question only the database could answer.
 */
export function registerCatalogue(router, { db, profiles }) {
  const playerCount = () => db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE banned = 0').get().n;

  router.get('/badges', (req, res) => {
    const counts = new Map(db.prepare(`SELECT b.badge, COUNT(*) AS n FROM profile_badges b
        JOIN profiles p ON p.id = b.profile_id AND p.banned = 0 GROUP BY b.badge`).all().map((r) => [r.badge, r.n]));

    const chosen = BADGES.includes(String(req.query.badge)) ? String(req.query.badge) : null;
    const earners = chosen
      ? db.prepare(`SELECT p.username, p.avatar, p.stars, b.earned_at FROM profile_badges b
          JOIN profiles p ON p.id = b.profile_id AND p.banned = 0
          WHERE b.badge = ? ORDER BY b.earned_at LIMIT ?`).all(chosen, EARNERS)
      : [];

    // A badge the app sent that this catalogue does not know: a new one shipped
    // in the app, or a typo. Better shown than silently dropped.
    const unknown = [...counts.keys()].filter((id) => !BADGES.includes(id)).map((id) => ({ id, count: counts.get(id) }));

    res.render('badges', {
      title: 'الشارات',
      kinds: BADGE_KINDS.map((kind) => ({
        kind,
        title: BADGE_KIND_TITLES[kind],
        note: BADGE_KIND_NOTES[kind],
        badges: BADGES.filter((id) => readBadge(id).kind === kind)
          .map((id) => ({ id, title: badgeTitle(id), goal: readBadge(id).goal, count: counts.get(id) ?? 0 })),
      })),
      chosen: chosen ? { id: chosen, title: badgeTitle(chosen), count: counts.get(chosen) ?? 0 } : null,
      earners,
      earnersShown: EARNERS,
      players: playerCount(),
      unknown,
      earnedTotal: [...counts.values()].reduce((sum, n) => sum + n, 0),
    });
  });

  router.get('/avatars', (_req, res) => {
    const worn = new Map(db.prepare('SELECT avatar, COUNT(*) AS n FROM profiles WHERE banned = 0 GROUP BY avatar')
      .all().map((r) => [r.avatar, r.n]));
    const framed = new Map(db.prepare(`SELECT frame, COUNT(*) AS n FROM profiles
        WHERE banned = 0 AND frame IS NOT NULL AND frame <> '' GROUP BY frame`).all().map((r) => [r.frame, r.n]));

    const avatars = avatarCatalogue().map((a) => ({ ...a, worn: worn.get(a.id) ?? 0 }));
    res.render('avatars', {
      title: 'الصور والإطارات',
      avatars,
      locked: avatars.filter((a) => a.lock).length,
      frames: frameCatalogue().map((f) => ({ ...f, worn: framed.get(f.id) ?? 0 })),
      players: playerCount(),
      profilesWithFrame: [...framed.values()].reduce((sum, n) => sum + n, 0),
    });
  });
}
