import { query } from './db/pool.js';
import { log } from './log.js';
import { upsertFlag, upsertPlatform } from './db/repo.js';
import { snapshot } from './db/versions.js';

/**
 * Applies changes that were scheduled for later.
 *
 * The case this exists for: ads off on Friday evening while a build is in
 * review, back on when it clears. Doing that by hand means being awake at the
 * right moment, and the alternative - leaving ads off over the weekend "to be
 * safe" - costs a weekend of revenue.
 *
 * ## Applied through the same functions the panel uses
 *
 * A scheduled change calls upsertPlatform and upsertFlag, not its own SQL. Two
 * write paths to the same field drift: one grows a validation rule or starts
 * taking a snapshot, the other does not, and the difference only shows up at
 * the worst time.
 */

/** How far past its time a change may still run. A service that was down for
 *  an hour should still apply what it missed; one down for a day should not
 *  suddenly enact a change nobody remembers scheduling. */
const GRACE_HOURS = 12;

export async function applyDueChanges() {
  const res = await query(
    `SELECT id, app_slug, platform, kind, payload, run_at, created_by, note
       FROM scheduled_changes
      WHERE applied_at IS NULL
        AND run_at <= now()
        AND run_at > now() - ($1 || ' hours')::interval
      ORDER BY run_at`,
    [String(GRACE_HOURS)],
  );

  const due = res?.rows ?? [];
  if (!due.length) return 0;

  let applied = 0;

  for (const change of due) {
    try {
      // Before the write, so the change is undoable from the versions list
      // exactly like one a person made.
      await snapshot(
        change.app_slug,
        change.created_by ?? 'scheduler',
        `before scheduled change #${change.id}`,
      );

      if (change.kind === 'platform') {
        if (!change.platform) throw new Error('platform change with no platform');

        // Merged over what is there now rather than written wholesale: a
        // schedule that says "ads off" must not also blank the store URL and
        // the version floor by omitting them.
        const current = await currentPlatform(change.app_slug, change.platform);
        await upsertPlatform(change.app_slug, change.platform, {
          ...current,
          ...change.payload,
        });
      } else if (change.kind === 'flag') {
        const { key, value } = change.payload ?? {};
        if (!key) throw new Error('flag change with no key');
        await upsertFlag(change.app_slug, change.platform ?? null, key, value);
      } else {
        throw new Error(`unknown kind '${change.kind}'`);
      }

      await query(
        'UPDATE scheduled_changes SET applied_at = now(), error = NULL WHERE id = $1',
        [change.id],
      );

      await query(
        `INSERT INTO audit_log (user_email, action, target_type, target_id, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          change.created_by ?? 'scheduler',
          'schedule.apply',
          'app',
          change.app_slug,
          JSON.stringify({ id: change.id, kind: change.kind, payload: change.payload }),
        ],
      ).catch(() => {});

      applied += 1;
      log.info('Applied scheduled change', {
        id: change.id,
        app: change.app_slug,
        kind: change.kind,
      });
    } catch (err) {
      // Recorded on the row and left unapplied. Marking it done would hide a
      // change that never happened; retrying forever would hammer a broken one
      // every minute, so the grace window above ends it.
      await query('UPDATE scheduled_changes SET error = $2 WHERE id = $1', [
        change.id,
        err.message.slice(0, 300),
      ]).catch(() => {});

      log.warn('Scheduled change failed', { id: change.id, error: err.message });
    }
  }

  return applied;
}

/** The platform row as it stands, in the shape upsertPlatform expects. */
async function currentPlatform(slug, platform) {
  const res = await query(
    `SELECT bundle_id, store_url, admob_app_id, ads_enabled, latest_version,
            min_supported_version, maintenance, maintenance_message, test_ads
       FROM app_platforms WHERE app_slug = $1 AND platform = $2`,
    [slug, platform],
  );

  const r = res?.rows?.[0];
  if (!r) return {};

  return {
    bundleId: r.bundle_id,
    storeUrl: r.store_url,
    admobAppId: r.admob_app_id,
    adsEnabled: r.ads_enabled,
    latestVersion: r.latest_version,
    minSupportedVersion: r.min_supported_version,
    maintenance: r.maintenance,
    maintenanceMessage: r.maintenance_message,
    testAds: r.test_ads,
  };
}

/**
 * Marks changes that sat past the grace window, so they are visibly abandoned
 * rather than quietly waiting to surprise someone.
 */
export async function expireStaleChanges() {
  const res = await query(
    `UPDATE scheduled_changes
        SET error = 'missed its window and was not applied'
      WHERE applied_at IS NULL
        AND error IS NULL
        AND run_at < now() - ($1 || ' hours')::interval`,
    [String(GRACE_HOURS)],
  );

  const n = res?.rowCount ?? 0;
  if (n) log.warn('Scheduled changes expired unapplied', { count: n });
  return n;
}
