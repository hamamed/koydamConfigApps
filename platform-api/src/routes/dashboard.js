import { Router } from 'express';

import {
  audit,
  canEditApp,
  canViewApp,
  hashPassword,
  isAdmin,
  isOwner,
  requireAdminRole,
  requireAuth,
  requireCsrf,
  requireOwner,
  verifyPassword,
  visibleApps,
} from '../auth.js';
import { isValidAppId, isValidUnitId, testPlacements } from '../ads.js';
import { log } from '../log.js';
import { backupStatus } from '../backups.js';
import { notify } from '../alerts.js';
import { query } from '../db/pool.js';
import {
  appConfig,
  appDetail,
  deleteAdUnit,
  deleteApp,
  deleteFlag,
  fetchStats,
  listApps,
  upsertAdUnit,
  upsertApp,
  upsertFlag,
  upsertPacing,
  upsertPlatform,
} from '../db/repo.js';
import { history, restore, snapshot } from '../db/versions.js';
import { serviceStatus } from '../health-monitor.js';

/**
 * The dashboard API.
 *
 * Every route is behind a session. Authorisation is checked per app, on the
 * server, on every request — not by hiding buttons, which only stops people
 * who were not going to try anything.
 */
export const dashboardRouter = Router();

dashboardRouter.use('/api', requireAuth, requireCsrf);

const PLATFORMS = new Set(['ios', 'android']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** 403 unless this user may write to this app. */
function denyEdit(req, res, slug) {
  if (canEditApp(req.user, slug)) return false;
  res.status(403).json({
    error: 'forbidden',
    message: `You do not have edit access to '${slug}'.`,
  });
  return true;
}

/**
 * Snapshots before a change and audits after it.
 *
 * Wrapping both together is what makes "who broke it and what did it look like
 * before" answerable from one place — the two halves are useless apart.
 */
async function recorded(req, slug, action, detail, work) {
  await snapshot(slug, req.user.email, action);
  const result = await work();
  await audit(req, action, { type: 'app', id: slug }, detail);
  return result;
}

// ── Session ─────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/me', (req, res) => {
  res.json({
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    grants: req.user.grants,
    csrf: req.user.csrf,
    can: {
      manageUsers: isOwner(req.user),
      manageAllApps: isAdmin(req.user),
    },
  });
});

// ── Overview ────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/overview', async (req, res) => {
  const scope = visibleApps(req.user);

  const [apps, services, stats] = await Promise.all([
    listApps(),
    // Services are infrastructure, not app data — only full admins see the
    // server list, since it names domains and systemd units.
    isAdmin(req.user) ? serviceStatus() : Promise.resolve([]),
    fetchStats({ days: 14 }),
  ]);

  const visible = scope === null ? apps : apps.filter((a) => scope.includes(a.slug));
  const slugs = new Set(visible.map((a) => a.slug));

  res.json({
    now: new Date().toISOString(),
    apps: visible,
    services,
    stats: stats.filter((s) => slugs.has(s.app)),
  });
});

// ── One app ─────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/apps/:slug', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!canViewApp(req.user, slug)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const detail = await appDetail(slug);
  if (!detail) return res.status(404).json({ error: 'unknown_app' });

  res.json({ ...detail, canEdit: canEditApp(req.user, slug), versions: await history(slug) });
});

dashboardRouter.post('/api/apps', requireAdminRole, async (req, res) => {
  const slug = String(req.body?.slug ?? '').toLowerCase().trim();
  const name = String(req.body?.name ?? '').trim();

  if (!SLUG.test(slug)) {
    return res.status(400).json({
      error: 'bad_slug',
      message: 'Lower-case letters, digits and hyphens; 2–49 characters.',
    });
  }
  if (!name) return res.status(400).json({ error: 'name_required' });

  await upsertApp({ slug, name, notes: req.body?.notes });
  await audit(req, 'app.create', { type: 'app', id: slug }, { name });

  res.json({ ok: true, slug });
});

dashboardRouter.delete('/api/apps/:slug', requireAdminRole, async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  // Snapshot first: deleting an app drops its config by cascade, and without
  // this there would be nothing to restore from.
  await snapshot(slug, req.user.email, 'before delete');
  const removed = await deleteApp(slug);
  await audit(req, 'app.delete', { type: 'app', id: slug });
  res.json({ ok: true, removed });
});

dashboardRouter.post('/api/apps/:slug/platforms/:platform', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const platform = String(req.params.platform).toLowerCase();
  if (denyEdit(req, res, slug)) return;
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: 'bad_platform' });

  await recorded(req, slug, 'platform.update', { platform }, () =>
    upsertPlatform(slug, platform, req.body ?? {}),
  );
  res.json({ ok: true });
});

dashboardRouter.post('/api/apps/:slug/ad-units/:platform', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const platform = String(req.params.platform).toLowerCase();
  if (denyEdit(req, res, slug)) return;
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: 'bad_platform' });

  const placement = String(req.body?.placement ?? '').trim();
  const unitId = String(req.body?.unitId ?? '').trim();
  if (!placement || !unitId) {
    return res.status(400).json({ error: 'placement_and_unit_required' });
  }

  // Checked here because nothing downstream will. A mistyped unit id is
  // accepted by the SDK, requested, and never filled - so it looks like poor
  // demand rather than a typo, and the revenue is gone until somebody
  // compares the string by eye.
  if (!isValidUnitId(unitId)) {
    return res.status(400).json({
      error: 'bad_unit_id',
      message:
        unitId.includes('~')
          ? 'That is an AdMob app id (it has a ~). A unit id uses a slash: ' +
            'ca-app-pub-0000000000000000/0000000000'
          : 'Expected ca-app-pub-0000000000000000/0000000000 - sixteen digits, ' +
            'a slash, then ten.',
    });
  }

  await recorded(req, slug, 'adunit.update', { platform, placement }, () =>
    upsertAdUnit(slug, platform, placement, unitId, req.body?.enabled ?? true),
  );
  res.json({ ok: true });
});

dashboardRouter.delete(
  '/api/apps/:slug/ad-units/:platform/:placement',
  async (req, res) => {
    const slug = String(req.params.slug).toLowerCase();
    if (denyEdit(req, res, slug)) return;

    const platform = String(req.params.platform).toLowerCase();
    const placement = String(req.params.placement);

    const removed = await recorded(
      req, slug, 'adunit.delete', { platform, placement },
      () => deleteAdUnit(slug, platform, placement),
    );
    res.json({ ok: true, removed });
  },
);

dashboardRouter.post('/api/apps/:slug/pacing/:platform', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const platform = String(req.params.platform).toLowerCase();
  if (denyEdit(req, res, slug)) return;
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: 'bad_platform' });

  await recorded(req, slug, 'pacing.update', { platform }, () =>
    upsertPacing(slug, platform, req.body?.settings ?? {}),
  );
  res.json({ ok: true });
});

dashboardRouter.post('/api/apps/:slug/flags', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (denyEdit(req, res, slug)) return;

  const key = String(req.body?.key ?? '').trim();
  if (!key) return res.status(400).json({ error: 'key_required' });

  const platform = req.body?.platform ? String(req.body.platform).toLowerCase() : null;
  if (platform && !PLATFORMS.has(platform)) {
    return res.status(400).json({ error: 'bad_platform' });
  }

  await recorded(req, slug, 'flag.set', { key, platform }, () =>
    upsertFlag(slug, platform, key, req.body?.value ?? null),
  );
  res.json({ ok: true });
});

dashboardRouter.delete('/api/apps/:slug/flags/:key', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (denyEdit(req, res, slug)) return;

  const platform = req.query.platform ? String(req.query.platform).toLowerCase() : null;
  const key = String(req.params.key);

  const removed = await recorded(req, slug, 'flag.delete', { key, platform }, () =>
    deleteFlag(slug, platform, key),
  );
  res.json({ ok: true, removed });
});

// ── Rollback ────────────────────────────────────────────────────────────────

dashboardRouter.post('/api/apps/:slug/restore/:versionId', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (denyEdit(req, res, slug)) return;

  const id = Number.parseInt(req.params.versionId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_version' });

  const result = await restore(id, req.user.email);
  if (result.error) return res.status(404).json(result);

  await audit(req, 'config.restore', { type: 'app', id: slug }, { version: id });
  res.json(result);
});

// ── Audit ───────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/audit', requireAdminRole, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '80', 10) || 80, 1), 300);

  const rows = await query(
    `SELECT at, user_email, action, target_type, target_id, detail, ip
       FROM audit_log ORDER BY at DESC LIMIT $1`,
    [limit],
  );

  res.json({ entries: rows?.rows ?? [] });
});

// ── Services ────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/services', requireAdminRole, async (_req, res) => {
  res.json({ services: await serviceStatus() });
});

// ── Users ───────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/users', requireOwner, async (_req, res) => {
  const rows = await query(
    `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at, u.last_login_at,
            COALESCE(json_agg(json_build_object('app', r.app_slug, 'role', r.role))
                     FILTER (WHERE r.app_slug IS NOT NULL), '[]') AS grants
       FROM users u
       LEFT JOIN user_app_roles r ON r.user_id = u.id
      GROUP BY u.id
      ORDER BY u.email`,
  );

  res.json({ users: rows?.rows ?? [] });
});

dashboardRouter.post('/api/users', requireOwner, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const role = String(req.body?.role ?? 'viewer');

  if (!email.includes('@')) return res.status(400).json({ error: 'bad_email' });
  if (password.length < 10) {
    return res.status(400).json({
      error: 'weak_password',
      message: 'At least 10 characters.',
    });
  }
  if (!['owner', 'admin', 'app_admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'bad_role' });
  }

  const hash = await hashPassword(password);
  const result = await query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
    [email, req.body?.name ?? null, hash, role],
  );

  if (!result?.rows?.length) {
    return res.status(409).json({ error: 'exists', message: 'That email already has an account.' });
  }

  await audit(req, 'user.create', { type: 'user', id: email }, { role });
  res.json({ ok: true });
});

dashboardRouter.post('/api/users/:id/grants', requireOwner, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const app = String(req.body?.app ?? '').toLowerCase();
  const role = String(req.body?.role ?? 'app_admin');

  if (!Number.isFinite(id) || !app) return res.status(400).json({ error: 'bad_request' });
  if (!['app_admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  await query(
    `INSERT INTO user_app_roles (user_id, app_slug, role) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, app_slug) DO UPDATE SET role = EXCLUDED.role`,
    [id, app, role],
  );

  await audit(req, 'user.grant', { type: 'user', id: String(id) }, { app, role });
  res.json({ ok: true });
});

dashboardRouter.delete('/api/users/:id/grants/:app', requireOwner, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const app = String(req.params.app).toLowerCase();

  await query('DELETE FROM user_app_roles WHERE user_id = $1 AND app_slug = $2', [id, app]);
  await audit(req, 'user.revoke', { type: 'user', id: String(id) }, { app });
  res.json({ ok: true });
});

dashboardRouter.post('/api/users/:id/disable', requireOwner, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const disabled = Boolean(req.body?.disabled);

  if (id === req.user.id) {
    // Locking yourself out of the only owner account leaves no way back in
    // short of editing the database by hand.
    return res.status(400).json({ error: 'cannot_disable_self' });
  }

  await query('UPDATE users SET disabled = $2 WHERE id = $1', [id, disabled]);
  // Disabling has to end their sessions too, or they stay signed in until
  // expiry — which is the entire point of doing it.
  if (disabled) await query('DELETE FROM sessions WHERE user_id = $1', [id]);

  await audit(req, disabled ? 'user.disable' : 'user.enable', {
    type: 'user',
    id: String(id),
  });
  res.json({ ok: true });
});

// ── Config preview ──────────────────────────────────────────────────────────

/**
 * Exactly what a client will receive, without waiting for one to ask.
 *
 * The panel edits a dozen rows across four tables; what the app actually gets
 * is one assembled document. Reading it back before trusting a change is the
 * difference between "I set the field" and "the app will see it".
 */
dashboardRouter.get('/api/apps/:slug/preview/:platform', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const platform = String(req.params.platform).toLowerCase();

  if (!canViewApp(req.user, slug)) return res.status(403).json({ error: 'forbidden' });
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: 'bad_platform' });

  const config = await appConfig(slug, platform);
  if (!config) return res.status(404).json({ error: 'not_found' });

  // Warnings rather than errors: none of these stop a client working, and a
  // half-configured app in development is normal. They are the things worth
  // noticing before a release, gathered in one place.
  const warnings = [];

  if (!config.ads.admobAppId) {
    warnings.push('No AdMob app id. The SDK needs one at launch; ads stay off.');
  } else if (!config.ads.testMode && !isValidAppId(config.ads.admobAppId)) {
    warnings.push('The AdMob app id is malformed. It should contain a ~, not a /.');
  }

  if (config.ads.enabled && !Object.keys(config.ads.units).length) {
    warnings.push('Ads are on but no placement is enabled, so nothing will show.');
  }

  if (config.ads.testMode) {
    warnings.push('Test mode: Google test ads are served. This earns nothing.');
  }

  if (config.maintenance.active) {
    warnings.push('Maintenance mode is on. Clients are told the app is unavailable.');
  }

  res.json({
    config,
    warnings,
    testPlacements: testPlacements(platform),
    url: `/v1/apps/${slug}/config?platform=${platform}`,
  });
});

// ── Scheduled changes ───────────────────────────────────────────────────────

dashboardRouter.get('/api/schedule', async (req, res) => {
  const scope = visibleApps(req.user);

  const result = await query(
    `SELECT id, app_slug, platform, kind, payload, run_at, created_by,
            created_at, applied_at, error, note
       FROM scheduled_changes
      WHERE run_at > now() - interval '30 days'
      ORDER BY applied_at NULLS FIRST, run_at`,
  );

  const rows = (result?.rows ?? []).filter(
    (r) => scope === null || scope.includes(r.app_slug),
  );

  res.json({ schedule: rows });
});

dashboardRouter.post('/api/schedule', async (req, res) => {
  const slug = String(req.body?.appSlug ?? '').toLowerCase();
  if (denyEdit(req, res, slug)) return;

  const kind = String(req.body?.kind ?? '');
  if (kind !== 'platform' && kind !== 'flag') {
    return res.status(400).json({ error: 'bad_kind', message: "kind must be 'platform' or 'flag'." });
  }

  const platform = req.body?.platform ? String(req.body.platform).toLowerCase() : null;
  if (platform && !PLATFORMS.has(platform)) {
    return res.status(400).json({ error: 'bad_platform' });
  }
  if (kind === 'platform' && !platform) {
    return res.status(400).json({ error: 'platform_required' });
  }

  const runAt = new Date(String(req.body?.runAt ?? ''));
  if (Number.isNaN(runAt.getTime())) {
    return res.status(400).json({ error: 'bad_run_at', message: 'Send an ISO timestamp.' });
  }

  // A change scheduled for the past would fire on the next sweep, seconds from
  // now, which is never what someone filling in a date meant.
  if (runAt.getTime() < Date.now() + 30_000) {
    return res.status(400).json({
      error: 'run_at_in_past',
      message: 'Pick a time at least a minute from now.',
    });
  }

  const payload = req.body?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'payload_required' });
  }
  if (kind === 'flag' && !payload.key) {
    return res.status(400).json({ error: 'flag_key_required' });
  }

  const inserted = await query(
    `INSERT INTO scheduled_changes
       (app_slug, platform, kind, payload, run_at, created_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      slug,
      platform,
      kind,
      JSON.stringify(payload),
      runAt.toISOString(),
      req.user.email,
      req.body?.note ? String(req.body.note).slice(0, 300) : null,
    ],
  );

  const id = inserted?.rows?.[0]?.id;
  if (!id) return res.status(500).json({ error: 'not_scheduled' });

  await audit(req, 'schedule.create', { type: 'app', id: slug }, { id, kind, runAt });
  res.json({ ok: true, id });
});

dashboardRouter.delete('/api/schedule/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });

  const found = await query('SELECT app_slug, applied_at FROM scheduled_changes WHERE id = $1', [id]);
  const row = found?.rows?.[0];
  if (!row) return res.status(404).json({ error: 'not_found' });

  // An applied change is history. Deleting it would remove the only record of
  // something that did happen.
  if (row.applied_at) {
    return res.status(409).json({
      error: 'already_applied',
      message: 'That change has already run and is kept as a record.',
    });
  }

  if (denyEdit(req, res, row.app_slug)) return;

  await query('DELETE FROM scheduled_changes WHERE id = $1', [id]);
  await audit(req, 'schedule.cancel', { type: 'app', id: row.app_slug }, { id });
  res.json({ ok: true });
});

// ── Alert destinations ──────────────────────────────────────────────────────

dashboardRouter.get('/api/alerts', requireAdminRole, async (_req, res) => {
  const result = await query(
    `SELECT id, kind, chat_id, enabled, created_at, last_sent_at, last_error
       FROM alert_targets ORDER BY id`,
  );

  // `target` is deliberately absent: for Telegram it is a bot token, and a
  // dashboard that shows it once has leaked it to every screenshot since.
  res.json({ alerts: result?.rows ?? [] });
});

dashboardRouter.post('/api/alerts', requireAdminRole, async (req, res) => {
  const kind = String(req.body?.kind ?? '');
  if (kind !== 'webhook' && kind !== 'telegram') {
    return res.status(400).json({ error: 'bad_kind' });
  }

  const target = String(req.body?.target ?? '').trim();
  if (!target) return res.status(400).json({ error: 'target_required' });

  if (kind === 'webhook') {
    let url;
    try {
      url = new URL(target);
    } catch {
      return res.status(400).json({ error: 'bad_url' });
    }
    if (url.protocol !== 'https:') {
      return res.status(400).json({
        error: 'https_required',
        message: 'Alerts can name a service being down. Send them over https.',
      });
    }
  }

  const chatId = req.body?.chatId ? String(req.body.chatId).trim() : null;
  if (kind === 'telegram' && !chatId) {
    return res.status(400).json({ error: 'chat_id_required' });
  }

  const inserted = await query(
    'INSERT INTO alert_targets (kind, target, chat_id) VALUES ($1,$2,$3) RETURNING id',
    [kind, target, chatId],
  );

  const id = inserted?.rows?.[0]?.id;
  await audit(req, 'alert.create', { type: 'alert', id: String(id) }, { kind });
  res.json({ ok: true, id });
});

dashboardRouter.post('/api/alerts/test', requireAdminRole, async (req, res) => {
  // Sent to every destination rather than one, because the question being
  // asked is "will I hear about an outage", not "is this row well-formed".
  const sent = await notify(
    `Test alert from hamaprojects, sent by ${req.user.email}. ` +
      'If you can read this, outage notifications will arrive here.',
  );

  await audit(req, 'alert.test', { type: 'alert' }, { delivered: sent });
  res.json({ ok: true, delivered: sent });
});

dashboardRouter.delete('/api/alerts/:id', requireAdminRole, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });

  await query('DELETE FROM alert_targets WHERE id = $1', [id]);
  await audit(req, 'alert.delete', { type: 'alert', id: String(id) });
  res.json({ ok: true });
});

// ── Your own password ───────────────────────────────────────────────────────

/**
 * Changing your own password, without a shell.
 *
 * Every account created from this panel was handed a password by whoever
 * created it, and until now there was no way to change it from inside - which
 * means one person knows everyone's password, and the only fix was SSH.
 */
dashboardRouter.post('/api/me/password', async (req, res) => {
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');

  if (next.length < 10) {
    return res.status(400).json({
      error: 'weak_password',
      message: 'Use at least 10 characters.',
    });
  }

  if (next === current) {
    return res.status(400).json({ error: 'same_password', message: 'That is the current password.' });
  }

  // Re-checked even though there is a valid session: an unattended laptop
  // should not be enough to lock the owner out of their own account.
  const row = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const hash = row?.rows?.[0]?.password_hash;

  const ok = await verifyPassword(current, hash);
  if (!ok) {
    log.warn('Password change refused', { user: req.user.email, ip: req.ip });
    return res.status(403).json({ error: 'wrong_password', message: 'Current password is incorrect.' });
  }

  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    req.user.id,
    await hashPassword(next),
  ]);

  // Every other session for this account, ended. If the reason for changing it
  // was that someone else had it, leaving their session alive defeats the act.
  const killed = await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [
    req.user.id,
    req.user.sid,
  ]);

  await audit(req, 'user.password', { type: 'user', id: String(req.user.id) });
  res.json({ ok: true, signedOutOtherSessions: killed?.rowCount ?? 0 });
});

// ── Backups ─────────────────────────────────────────────────────────────────

dashboardRouter.get('/api/backups', requireAdminRole, async (_req, res) => {
  res.json(await backupStatus());
});
