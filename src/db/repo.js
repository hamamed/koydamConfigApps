import { applyTestUnits, testAppId } from '../ads.js';
import { query } from './pool.js';

/**
 * Reads and writes for the config store.
 *
 * The read path is one function: [appConfig] assembles everything a client
 * needs in a single response, because a launching app should make one request,
 * not five. The write path is a handful of upserts driven by the admin panel.
 */

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Everything one app on one platform should know at launch.
 *
 * Returns null when the app or platform is unknown, which the route turns into
 * a 404 — better than an empty config the client would read as "ads off".
 */
export async function appConfig(slug, platform) {
  const res = await query(
    `SELECT a.slug, a.name,
            p.bundle_id, p.store_url, p.admob_app_id, p.ads_enabled,
            p.latest_version, p.min_supported_version,
            p.maintenance, p.maintenance_message, p.test_ads
       FROM apps a
       JOIN app_platforms p ON p.app_slug = a.slug
      WHERE a.slug = $1 AND p.platform = $2`,
    [slug, platform],
  );

  const row = res?.rows?.[0];
  if (!row) return null;

  const [units, pacing, flags] = await Promise.all([
    adUnits(slug, platform),
    adPacing(slug, platform),
    featureFlags(slug, platform),
  ]);

  return {
    app: row.slug,
    name: row.name,
    platform,
    ads: {
      // Both must hold for a client to request anything. The per-unit switch
      // handles "this one placement is a problem"; this one handles "stop all
      // of it, now", which is the response to an AdMob policy warning.
      enabled: row.ads_enabled && Boolean(row.admob_app_id),
      // In test mode the client is handed Google's units instead of the real
      // ones. Substituted here rather than in the app, so a review build can be
      // switched over without a release - and so it shows up in the payload the
      // panel previews rather than hiding in client logic.
      testMode: row.test_ads,
      admobAppId: row.test_ads ? testAppId(platform) : row.admob_app_id,
      units: row.test_ads ? applyTestUnits(units, platform) : units,
      pacing,
    },
    update: {
      latestVersion: row.latest_version,
      minSupportedVersion: row.min_supported_version,
      storeUrl: row.store_url,
    },
    maintenance: {
      active: row.maintenance,
      message: row.maintenance_message,
    },
    flags,
  };
}

/** Enabled placements only — a disabled unit is absent, not present-and-false. */
async function adUnits(slug, platform) {
  const res = await query(
    `SELECT placement, unit_id FROM ad_units
      WHERE app_slug = $1 AND platform = $2 AND enabled
      ORDER BY placement`,
    [slug, platform],
  );

  return Object.fromEntries(
    (res?.rows ?? []).map((r) => [r.placement, r.unit_id]),
  );
}

async function adPacing(slug, platform) {
  const res = await query(
    `SELECT settings FROM ad_pacing WHERE app_slug = $1 AND platform = $2`,
    [slug, platform],
  );
  return res?.rows?.[0]?.settings ?? {};
}

/**
 * Flags for this platform merged over the ones that apply to both.
 *
 * Platform-specific wins, which is the whole point of allowing a NULL
 * platform: set a flag once for everywhere, then override the one platform
 * that has to differ. The ORDER BY is what makes the override land last.
 */
async function featureFlags(slug, platform) {
  const res = await query(
    `SELECT key, value, platform FROM feature_flags
      WHERE app_slug = $1 AND (platform IS NULL OR platform = $2)
      ORDER BY platform NULLS FIRST`,
    [slug, platform],
  );

  const out = {};
  for (const r of res?.rows ?? []) out[r.key] = r.value;
  return out;
}

/** Every app, with its platforms rolled up. For the panel's list. */
export async function listApps() {
  const res = await query(
    `SELECT a.slug, a.name, a.notes, a.updated_at,
            COALESCE(json_agg(
              json_build_object(
                'platform', p.platform,
                'bundleId', p.bundle_id,
                'admobAppId', p.admob_app_id,
                'adsEnabled', p.ads_enabled,
                'latestVersion', p.latest_version,
                'minSupportedVersion', p.min_supported_version,
                'maintenance', p.maintenance,
                'maintenanceMessage', p.maintenance_message,
                'testAds', p.test_ads
              ) ORDER BY p.platform
            ) FILTER (WHERE p.platform IS NOT NULL), '[]') AS platforms
       FROM apps a
       LEFT JOIN app_platforms p ON p.app_slug = a.slug
      GROUP BY a.slug
      ORDER BY a.name`,
  );

  return res?.rows ?? [];
}

/** Full detail for one app, for the panel's editor. */
export async function appDetail(slug) {
  const [apps, units, pacing, flags] = await Promise.all([
    listApps(),
    query(
      `SELECT platform, placement, unit_id, enabled FROM ad_units
        WHERE app_slug = $1 ORDER BY platform, placement`,
      [slug],
    ),
    query(`SELECT platform, settings FROM ad_pacing WHERE app_slug = $1`, [slug]),
    query(
      `SELECT platform, key, value FROM feature_flags
        WHERE app_slug = $1 ORDER BY key`,
      [slug],
    ),
  ]);

  const app = apps.find((a) => a.slug === slug);
  if (!app) return null;

  return {
    ...app,
    adUnits: units?.rows ?? [],
    pacing: pacing?.rows ?? [],
    flags: flags?.rows ?? [],
  };
}

// ── Write ───────────────────────────────────────────────────────────────────

export async function upsertApp({ slug, name, notes }) {
  const res = await query(
    `INSERT INTO apps (slug, name, notes) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()`,
    [slug, name, notes ?? null],
  );
  return res?.rowCount ?? 0;
}

export async function upsertPlatform(slug, platform, fields) {
  const res = await query(
    `INSERT INTO app_platforms (
       app_slug, platform, bundle_id, store_url, admob_app_id, ads_enabled,
       latest_version, min_supported_version, maintenance, maintenance_message,
       test_ads
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (app_slug, platform) DO UPDATE SET
       bundle_id             = EXCLUDED.bundle_id,
       store_url             = EXCLUDED.store_url,
       admob_app_id          = EXCLUDED.admob_app_id,
       ads_enabled           = EXCLUDED.ads_enabled,
       latest_version        = EXCLUDED.latest_version,
       min_supported_version = EXCLUDED.min_supported_version,
       maintenance           = EXCLUDED.maintenance,
       maintenance_message   = EXCLUDED.maintenance_message,
       test_ads              = EXCLUDED.test_ads,
       updated_at            = now()`,
    [
      slug,
      platform,
      fields.bundleId ?? null,
      fields.storeUrl ?? null,
      fields.admobAppId ?? null,
      fields.adsEnabled ?? true,
      fields.latestVersion ?? null,
      fields.minSupportedVersion ?? null,
      fields.maintenance ?? false,
      fields.maintenanceMessage ?? null,
      fields.testAds ?? false,
    ],
  );
  return res?.rowCount ?? 0;
}

export async function upsertAdUnit(
  slug,
  platform,
  placement,
  unitId,
  enabled = true,
) {
  const res = await query(
    `INSERT INTO ad_units (app_slug, platform, placement, unit_id, enabled)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (app_slug, platform, placement) DO UPDATE
       SET unit_id = EXCLUDED.unit_id,
           enabled = EXCLUDED.enabled,
           updated_at = now()`,
    [slug, platform, placement, unitId, enabled],
  );
  return res?.rowCount ?? 0;
}

export async function deleteAdUnit(slug, platform, placement) {
  const res = await query(
    `DELETE FROM ad_units
      WHERE app_slug = $1 AND platform = $2 AND placement = $3`,
    [slug, platform, placement],
  );
  return res?.rowCount ?? 0;
}

export async function upsertPacing(slug, platform, settings) {
  const res = await query(
    `INSERT INTO ad_pacing (app_slug, platform, settings) VALUES ($1,$2,$3)
     ON CONFLICT (app_slug, platform) DO UPDATE
       SET settings = EXCLUDED.settings, updated_at = now()`,
    [slug, platform, JSON.stringify(settings ?? {})],
  );
  return res?.rowCount ?? 0;
}

/**
 * The unique index is on `(app_slug, key, COALESCE(platform, '*'))`, so the
 * ON CONFLICT target has to be spelled the same way — naming the columns alone
 * would not match the index and the insert would fail.
 */
export async function upsertFlag(slug, platform, key, value) {
  const res = await query(
    `INSERT INTO feature_flags (app_slug, platform, key, value)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (app_slug, key, COALESCE(platform, '*')) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now()`,
    [slug, platform ?? null, key, JSON.stringify(value)],
  );
  return res?.rowCount ?? 0;
}

export async function deleteFlag(slug, platform, key) {
  const res = await query(
    `DELETE FROM feature_flags
      WHERE app_slug = $1 AND key = $2
        AND COALESCE(platform, '*') = COALESCE($3, '*')`,
    [slug, key, platform ?? null],
  );
  return res?.rowCount ?? 0;
}

export async function deleteApp(slug) {
  const res = await query(`DELETE FROM apps WHERE slug = $1`, [slug]);
  return res?.rowCount ?? 0;
}

// ── Telemetry ───────────────────────────────────────────────────────────────

/**
 * Counters only. Nothing here identifies a device or a person — it exists to
 * answer "did the rollout reach anyone" and "is this app still alive", which
 * needs totals and nothing else.
 */
export async function recordFetch(slug, platform, version) {
  await query(
    `INSERT INTO config_fetches (app_slug, platform, day, app_version, hits)
     VALUES ($1, $2, CURRENT_DATE, $3, 1)
     ON CONFLICT (app_slug, platform, day, app_version)
       DO UPDATE SET hits = config_fetches.hits + 1`,
    [slug, platform, version ?? 'unknown'],
  );
}

export async function fetchStats({ days = 14 } = {}) {
  const res = await query(
    `SELECT app_slug, platform, SUM(hits)::bigint AS hits,
            COUNT(DISTINCT day)::int AS active_days,
            MAX(day) AS last_seen
       FROM config_fetches
      WHERE day > CURRENT_DATE - ($1 || ' days')::interval
      GROUP BY app_slug, platform
      ORDER BY hits DESC`,
    [String(days)],
  );

  return (res?.rows ?? []).map((r) => ({
    app: r.app_slug,
    platform: r.platform,
    hits: Number(r.hits),
    activeDays: r.active_days,
    lastSeen: r.last_seen,
  }));
}
