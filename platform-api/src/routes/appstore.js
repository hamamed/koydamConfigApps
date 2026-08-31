import { Router } from 'express';

import {
  audit,
  canViewApp,
  isAdmin,
  requireAdminRole,
  requireAuth,
  requireCsrf,
} from '../auth.js';
import { decryptSecret, encryptSecret, isEncryptionConfigured } from '../secrets.js';
import { appDetail, listApps } from '../db/repo.js';
import { query } from '../db/pool.js';
import { downloads, forgetTokens, overview, request, signToken } from '../appstore.js';
import { log } from '../log.js';

export const appstoreRouter = Router();

appstoreRouter.use('/api', requireAuth, requireCsrf);

/** The iOS bundle id this app is configured with — how the API finds it. */
async function iosBundleId(slug) {
  const detail = await appDetail(slug);
  return detail?.platforms?.find((p) => p.platform === 'ios')?.bundleId ?? null;
}

/**
 * The one App Store Connect credential, shared by every app.
 *
 * Team-scoped by nature: the key is issued against an Apple team and the API
 * lists every app that team owns, so one key covers the whole estate and a new
 * app needs no setup at all.
 */
async function account() {
  const res = await query(
    `SELECT issuer_id, key_id, private_key, vendor_number FROM appstore_account WHERE id`,
  );
  const row = res?.rows?.[0];
  if (!row) return null;

  const privateKey = decryptSecret(row.private_key);
  if (!privateKey) {
    // A key that will not decrypt is a rotated or missing SETTINGS_KEY, not a
    // missing credential. Saying "not configured" would invite someone to
    // paste a new key over one that is merely unreadable.
    throw Object.assign(new Error('Stored key could not be decrypted. Check SETTINGS_KEY.'), {
      status: 500,
    });
  }

  return {
    issuerId: row.issuer_id,
    keyId: row.key_id,
    privateKey,
    vendorNumber: row.vendor_number,
  };
}

// ── The account, set once for everything ────────────────────────────────────

appstoreRouter.get('/api/appstore/account', async (req, res) => {
  const row = await query(
    `SELECT issuer_id, key_id, vendor_number, updated_at, updated_by
       FROM appstore_account WHERE id`,
  );
  const found = row?.rows?.[0] ?? null;

  res.json({
    configured: Boolean(found),
    // The issuer and key ids identify which key this is in App Store Connect,
    // and neither is a secret — the issuer id is the team's, and the key id is
    // printed beside the key in Apple's own list. The private key is never
    // returned: Apple hands it over exactly once, so a panel that could
    // redisplay it would be a better target than the panel is worth.
    issuerId: found?.issuer_id ?? null,
    keyId: found?.key_id ?? null,
    vendorNumber: found?.vendor_number ?? null,
    updatedAt: found?.updated_at ?? null,
    updatedBy: found?.updated_by ?? null,
    // Only admins may change it, but everyone may know whether it is set —
    // otherwise an app card cannot explain why it is empty.
    canEdit: isAdmin(req.user),
    encryptionReady: isEncryptionConfigured(),
  });
});

appstoreRouter.put('/api/appstore/account', requireAdminRole, async (req, res) => {
  if (!isEncryptionConfigured()) {
    return res.status(400).json({
      error: 'encryption_unavailable',
      message: 'SETTINGS_KEY is not set, so the private key cannot be stored safely.',
    });
  }

  const issuerId = String(req.body?.issuerId ?? '').trim();
  const keyId = String(req.body?.keyId ?? '').trim();
  const privateKey = String(req.body?.privateKey ?? '').trim();
  const vendorNumber = String(req.body?.vendorNumber ?? '').trim() || null;

  if (!issuerId || !keyId || !privateKey) {
    return res.status(400).json({
      error: 'incomplete',
      message: 'Issuer ID, Key ID and the .p8 private key are all required.',
    });
  }

  // Signed before it is stored. An unusable key saved successfully is a
  // support conversation days later; a rejected paste is one now.
  try {
    signToken({ issuerId, keyId, privateKey });
  } catch (err) {
    return res.status(400).json({ error: 'bad_key', message: err.message });
  }

  await query(
    `INSERT INTO appstore_account (id, issuer_id, key_id, private_key, vendor_number, updated_by)
     VALUES (TRUE, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       issuer_id     = EXCLUDED.issuer_id,
       key_id        = EXCLUDED.key_id,
       private_key   = EXCLUDED.private_key,
       vendor_number = EXCLUDED.vendor_number,
       updated_by    = EXCLUDED.updated_by,
       updated_at    = now()`,
    [issuerId, keyId, encryptSecret(privateKey), vendorNumber, req.user?.email ?? null],
  );

  forgetTokens();
  forgetDashboard();
  await audit(req, 'appstore.account.save', {}, `key ${keyId}`);
  res.json({ ok: true });
});

appstoreRouter.delete('/api/appstore/account', requireAdminRole, async (req, res) => {
  await query('DELETE FROM appstore_account WHERE id');
  forgetTokens();
  forgetDashboard();
  await audit(req, 'appstore.account.delete', {});
  res.json({ ok: true });
});

// ── Everything, across every app ────────────────────────────────────────────

/**
 * Apple's rate limit is per hour and generous, but a dashboard is the page
 * people leave open and come back to. Sixty seconds is long enough that
 * navigating away and back is free, and short enough that a build finishing
 * processing shows up while you are still watching for it.
 */
const CACHE_MS = 60_000;
let cached = null;

export function forgetDashboard() {
  cached = null;
}

appstoreRouter.get('/api/appstore/dashboard', async (req, res) => {
  let credentials;
  try {
    credentials = await account();
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: 'key_unreadable', message: err.message });
  }
  if (!credentials) return res.status(404).json({ error: 'not_configured' });

  if (!cached || cached.at + CACHE_MS < Date.now()) {
    const apps = (await listApps()).map((a) => ({
      slug: a.slug,
      name: a.name,
      bundleId: (a.platforms ?? []).find((p) => p.platform === 'ios')?.bundleId ?? null,
    }));

    // In parallel, and settled: one app whose record Apple cannot find must not
    // blank the others. An app with no iOS bundle id is not an error at all —
    // it is an Android-only app, and it says so rather than reporting a fault.
    const results = await Promise.all(
      apps.map(async (app) => {
        if (!app.bundleId) return { ...app, state: 'no_ios' };
        try {
          return { ...app, state: 'ok', ...(await overview(credentials, app.bundleId)) };
        } catch (err) {
          return {
            ...app,
            state: err.status === 404 ? 'no_record' : 'error',
            error: err.message,
          };
        }
      }),
    );

    // One request per day for the whole estate, not per app — so this costs
    // seven round trips total however many apps there are.
    const units = await downloads(credentials, { days: 7 });

    cached = { at: Date.now(), results, downloads: units };
  }

  // Filtered per request, not per cache entry: the expensive part is Apple, and
  // two people with different grants should not each pay for it.
  const allowed = cached.results.filter((r) => canViewApp(req.user, r.slug));

  // Downloads arrive keyed by SKU, which is the only handle the sales report
  // carries. Attach each app's own figure and total only what this person can
  // see, so a scoped user is not shown an estate-wide number.
  const units = cached.downloads ?? { ok: false };
  let visibleTotal = 0;
  for (const app of allowed) {
    const sku = app.app?.sku;
    app.downloads = units.ok && sku ? (units.bySku?.[sku] ?? 0) : null;
    if (typeof app.downloads === 'number') visibleTotal += app.downloads;
  }

  res.json({
    apps: allowed,
    downloads: units.ok
      ? { ok: true, days: units.days, total: visibleTotal, byDay: units.byDay,
          topCountries: units.topCountries }
      : units,
    fetchedAt: new Date(cached.at).toISOString(),
  });
});

// ── The data ────────────────────────────────────────────────────────────────

appstoreRouter.get('/api/apps/:slug/appstore', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!canViewApp(req.user, slug)) return res.status(403).json({ error: 'forbidden' });

  let credentials;
  try {
    credentials = await account();
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: 'key_unreadable', message: err.message });
  }
  if (!credentials) return res.status(404).json({ error: 'not_configured' });

  const bundleId = await iosBundleId(slug);
  if (!bundleId) {
    return res.status(400).json({
      error: 'no_bundle_id',
      message: 'This app has no iOS bundle id configured, so there is nothing to look up.',
    });
  }

  try {
    res.json(await overview(credentials, bundleId));
  } catch (err) {
    log.warn(`App Store Connect overview failed for ${slug}: ${err.message}`);
    res.status(err.status ?? 502).json({ error: 'appstore_error', message: err.message });
  }
});

/**
 * Sales and downloads.
 *
 * Separate from the overview because it is a different thing in every way: a
 * different role on the key (Finance or Sales), a vendor number the rest of the
 * API never mentions, and a gzipped TSV rather than JSON. Folding it into the
 * overview would mean the common case pays for the uncommon one.
 */
appstoreRouter.get('/api/apps/:slug/appstore/sales', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!canViewApp(req.user, slug)) return res.status(403).json({ error: 'forbidden' });

  let credentials;
  try {
    credentials = await account();
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: 'key_unreadable', message: err.message });
  }
  if (!credentials) return res.status(404).json({ error: 'not_configured' });
  if (!credentials.vendorNumber) {
    return res.status(400).json({
      error: 'no_vendor_number',
      message: 'Sales reports need the vendor number from App Store Connect → Payments and Financial Reports.',
    });
  }

  // Apple publishes a day's report the following day, and has no data at all
  // for an app that has never been on sale.
  const day = String(req.query.date ?? '').match(/^\d{4}-\d{2}-\d{2}$/)
    ? String(req.query.date)
    : new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

  try {
    const raw = await request(
      credentials,
      '/salesReports',
      {
        'filter[frequency]': 'DAILY',
        'filter[reportType]': 'SALES',
        'filter[reportSubType]': 'SUMMARY',
        'filter[vendorNumber]': credentials.vendorNumber,
        'filter[reportDate]': day,
      },
      { binary: true },
    );
    res.json({ date: day, rows: parseSalesReport(raw) });
  } catch (err) {
    // 404 here means "no report for that day", which is normal and not a fault.
    const status = err.status === 404 ? 200 : (err.status ?? 502);
    const body =
      err.status === 404
        ? { date: day, rows: [], note: 'No report published for that day yet.' }
        : { error: 'appstore_error', message: err.message };
    res.status(status).json(body);
  }
});

/** Tab-separated text, already un-gzipped by the client. */
function parseSalesReport(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map((h) => h.trim());
  const index = (name) => headers.indexOf(name);

  const sku = index('SKU');
  const units = index('Units');
  const type = index('Product Type Identifier');
  const country = index('Country Code');

  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return {
      sku: sku >= 0 ? cells[sku] : null,
      units: units >= 0 ? Number(cells[units]) || 0 : 0,
      productType: type >= 0 ? cells[type] : null,
      country: country >= 0 ? cells[country] : null,
    };
  });
}
