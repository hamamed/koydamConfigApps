import { query } from './pool.js';
import { appDetail } from './repo.js';

/**
 * Config history and rollback.
 *
 * A full snapshot per change rather than a diff. Config is small — a few
 * kilobytes per app — and a snapshot restores in one pass, while a chain of
 * diffs has to be replayed correctly. Replaying correctly is exactly what you
 * cannot rely on at the moment you need a rollback, which is usually 2am after
 * someone pasted the wrong ad unit id.
 */

/** Captures the current state of an app, before or after a change. */
export async function snapshot(slug, userEmail, note) {
  const detail = await appDetail(slug);
  if (!detail) return null;

  const res = await query(
    `INSERT INTO config_versions (app_slug, user_email, note, snapshot)
     VALUES ($1, $2, $3, $4)
     RETURNING id, at`,
    [slug, userEmail ?? null, note ?? null, JSON.stringify(detail)],
  );

  return res?.rows?.[0] ?? null;
}

/** History for one app, newest first. Snapshots are excluded — they are large
 *  and the list only needs to say when and who. */
export async function history(slug, { limit = 40 } = {}) {
  const res = await query(
    `SELECT id, at, user_email, note,
            jsonb_array_length(COALESCE(snapshot->'adUnits', '[]'::jsonb)) AS ad_units
       FROM config_versions
      WHERE app_slug = $1
      ORDER BY at DESC
      LIMIT $2`,
    [slug, limit],
  );

  return (res?.rows ?? []).map((r) => ({
    id: Number(r.id),
    at: r.at,
    user: r.user_email,
    note: r.note,
    adUnits: r.ad_units,
  }));
}

export async function getVersion(id) {
  const res = await query(
    'SELECT id, app_slug, at, user_email, note, snapshot FROM config_versions WHERE id = $1',
    [id],
  );
  return res?.rows?.[0] ?? null;
}

/**
 * Restores an app to a stored snapshot.
 *
 * Writes the *current* state first, so a rollback is itself undoable — the
 * mistake people make with rollback is discovering the thing they reverted was
 * actually correct, with no way back.
 *
 * Deletes then re-inserts rather than upserting: a snapshot is the whole truth
 * for that app, and an ad unit added since must disappear, not survive because
 * nothing overwrote it.
 */
export async function restore(id, userEmail) {
  const version = await getVersion(id);
  if (!version) return { error: 'unknown_version' };

  const slug = version.app_slug;
  const snap = version.snapshot;

  await snapshot(slug, userEmail, `before restoring #${id}`);

  const platforms = snap.platforms ?? [];
  const adUnits = snap.adUnits ?? [];
  const pacing = snap.pacing ?? [];
  const flags = snap.flags ?? [];

  // Children first, then re-insert. Everything is scoped to this one app, so
  // no other app's config can be touched by a restore.
  await query('DELETE FROM ad_units WHERE app_slug = $1', [slug]);
  await query('DELETE FROM ad_pacing WHERE app_slug = $1', [slug]);
  await query('DELETE FROM feature_flags WHERE app_slug = $1', [slug]);

  for (const p of platforms) {
    await query(
      `INSERT INTO app_platforms (
         app_slug, platform, bundle_id, store_url, admob_app_id, ads_enabled,
         latest_version, min_supported_version, maintenance, maintenance_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (app_slug, platform) DO UPDATE SET
         bundle_id = EXCLUDED.bundle_id,
         store_url = EXCLUDED.store_url,
         admob_app_id = EXCLUDED.admob_app_id,
         ads_enabled = EXCLUDED.ads_enabled,
         latest_version = EXCLUDED.latest_version,
         min_supported_version = EXCLUDED.min_supported_version,
         maintenance = EXCLUDED.maintenance,
         maintenance_message = EXCLUDED.maintenance_message,
         updated_at = now()`,
      [
        slug, p.platform, p.bundleId ?? null, p.storeUrl ?? null,
        p.admobAppId ?? null, p.adsEnabled ?? true,
        p.latestVersion ?? null, p.minSupportedVersion ?? null,
        p.maintenance ?? false, p.maintenanceMessage ?? null,
      ],
    );
  }

  for (const u of adUnits) {
    await query(
      `INSERT INTO ad_units (app_slug, platform, placement, unit_id, enabled)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (app_slug, platform, placement) DO NOTHING`,
      [slug, u.platform, u.placement, u.unit_id, u.enabled ?? true],
    );
  }

  for (const p of pacing) {
    await query(
      `INSERT INTO ad_pacing (app_slug, platform, settings) VALUES ($1,$2,$3)
       ON CONFLICT (app_slug, platform) DO UPDATE SET settings = EXCLUDED.settings`,
      [slug, p.platform, JSON.stringify(p.settings ?? {})],
    );
  }

  for (const f of flags) {
    await query(
      `INSERT INTO feature_flags (app_slug, platform, key, value)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_slug, key, COALESCE(platform, '*')) DO UPDATE
         SET value = EXCLUDED.value`,
      [slug, f.platform ?? null, f.key, JSON.stringify(f.value)],
    );
  }

  return { ok: true, slug, restoredFrom: id };
}
