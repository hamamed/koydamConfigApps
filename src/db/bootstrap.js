import { randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { log } from '../log.js';
import { hashPassword } from '../auth.js';
import { query } from './pool.js';

/**
 * Creates the first owner and registers the services on this box.
 *
 * Runs on every boot but does nothing once there is a user — the check is
 * "are there zero accounts", so it can never reset a live password or bring a
 * deleted owner back.
 */
export async function bootstrapOwner() {
  const res = await query('SELECT COUNT(*)::int AS n FROM users');
  if ((res?.rows?.[0]?.n ?? 0) > 0) return null;

  const email = config.bootstrapEmail || 'admin@localhost';

  // A generated password is printed once to the log rather than defaulted to
  // something guessable. A well-known default on a public dashboard is worse
  // than no dashboard.
  const password = config.bootstrapPassword || randomBytes(12).toString('base64url');
  const hash = await hashPassword(password);

  await query(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, $2, $3, 'owner')`,
    [email, 'Owner', hash],
  );

  log.warn('Created the first owner account', { email });
  if (!config.bootstrapPassword) {
    log.warn('GENERATED PASSWORD — copy it now, it is not stored anywhere', {
      password,
    });
  }

  return { email, password: config.bootstrapPassword ? null : password };
}

/**
 * The services running on this VPS.
 *
 * Seeded rather than discovered: reading systemd would tie the dashboard to
 * this specific box, and the list changes about twice a year. Upserted by
 * slug, so editing a row in the panel survives the next boot.
 */
const KNOWN_SERVICES = [
  {
    slug: 'brawl-api',
    name: 'Brawl Stats API',
    domain: 'api.hamaprojects.com',
    healthUrl: 'https://api.hamaprojects.com/health',
    systemdUnit: 'brawl-api',
    appSlug: 'brawl-stats',
    notes: 'Supercell proxy, meta crawler, Postgres + Redis.',
    sortOrder: 10,
  },
  {
    slug: 'platform-api',
    name: 'Platform config',
    domain: 'config.hamaprojects.com',
    healthUrl: 'https://config.hamaprojects.com/health',
    systemdUnit: 'platform-api',
    appSlug: null,
    notes: 'This dashboard. Remote config and AdMob settings for every app.',
    sortOrder: 20,
  },
  {
    slug: 'skincraft',
    name: 'SkinCraft',
    domain: 'skincraft.hamaprojects.com',
    healthUrl: 'https://skincraft.hamaprojects.com/api/v1/health',
    systemdUnit: 'skincraft',
    appSlug: 'skincraft',
    notes: 'Skin catalogue API and admin panel. SQLite.',
    sortOrder: 30,
  },
];

export async function seedServices() {
  for (const s of KNOWN_SERVICES) {
    await query(
      `INSERT INTO services (slug, name, domain, health_url, systemd_unit, notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         domain = EXCLUDED.domain,
         health_url = EXCLUDED.health_url,
         systemd_unit = EXCLUDED.systemd_unit
       -- notes and sort_order are left alone: both are editable in the panel,
       -- and a boot should not undo what someone typed.`,
      [s.slug, s.name, s.domain, s.healthUrl, s.systemdUnit, s.notes, s.sortOrder],
    );

    // Linked separately, because the app row may not exist yet on a fresh
    // install and a failed foreign key would abort the whole seed.
    if (s.appSlug) {
      await query(
        `UPDATE services SET app_slug = $2
          WHERE slug = $1 AND EXISTS (SELECT 1 FROM apps WHERE slug = $2)`,
        [s.slug, s.appSlug],
      );
    }
  }
}
