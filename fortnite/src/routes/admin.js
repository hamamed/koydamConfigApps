import express from 'express';
import rateLimit from 'express-rate-limit';

import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  COLLECTIONS, collection, counts, deleteRow, getRow, insertRow, listRows,
  readForm, togglePublished, updateRow,
} from '../collections.js';
import { csrfProtect, csrfToken, requireAuth, verifyCredentials } from '../middleware/auth.js';
import { handleUploadErrors, uploadWallpaper } from '../middleware/upload.js';
import { forgetGallery, gallery } from './wallpapers.js';
import { deleteWallpaper, storeWallpaper } from '../wallpapers/store.js';
import { syncCosmetics, syncNews, syncShop, syncStatus } from '../upstream.js';
import { parseWeapons } from '../weapons-import.js';
import { parseMaps } from '../maps-import.js';

export const adminRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});

adminRouter.use(csrfToken);

// Every mutating request except the multipart one, which cannot be checked
// until multer has parsed the body — that route chains csrfProtect itself.
adminRouter.use((req, res, next) => {
  if (req.is('multipart/*')) return next();
  return csrfProtect(req, res, next);
});

// Every template needs these, and forgetting one is a 500 rather than a
// missing corner of a page — so they are set once here rather than per render.
adminRouter.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.collections = COLLECTIONS;
  res.locals.assetVersion = config.assetVersion;
  next();
});

// ── Sign in ─────────────────────────────────────────────────────────────────

adminRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.render('login', { title: 'Sign in', platformUrl: config.platformUrl });
});

adminRouter.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body ?? {};
  const user = verifyCredentials(String(username ?? ''), String(password ?? ''));

  if (!user) {
    req.flash('danger', 'That username and password did not match.');
    return res.redirect('/admin/login');
  }

  req.session.userId = user.id;
  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);
  res.redirect('/admin');
});

adminRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

adminRouter.use(requireAuth);

// ── Dashboard ───────────────────────────────────────────────────────────────

adminRouter.get('/', (_req, res) => {
  const catalogue = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cosmetics)     AS cosmetics,
              (SELECT COUNT(*) FROM shop_entries)  AS shop,
              (SELECT COUNT(*) FROM news)          AS news`,
    )
    .get();

  const rarities = db
    .prepare(
      `SELECT rarity, COUNT(*) AS count FROM cosmetics
        WHERE rarity IS NOT NULL GROUP BY rarity ORDER BY count DESC`,
    )
    .all();

  res.render('dashboard', {
    title: 'Dashboard',
    catalogue,
    rarities,
    feeds: syncStatus(),
    counts: counts(),
  });
});

/**
 * Pull one feed now.
 *
 * The loop already refreshes on a timer; this is for the moment after a patch
 * lands when waiting twelve hours for the cosmetics job is not acceptable.
 */
adminRouter.post('/sync/:feed', async (req, res) => {
  const jobs = { cosmetics: syncCosmetics, shop: syncShop, news: syncNews };
  const job = jobs[req.params.feed];
  if (!job) {
    req.flash('danger', 'Unknown feed.');
    return res.redirect('/admin');
  }

  try {
    const n = await job();
    req.flash('success', `Refreshed ${req.params.feed} — ${n} records.`);
  } catch (err) {
    req.flash('danger', `Could not refresh ${req.params.feed}: ${err.message}`);
  }
  res.redirect('/admin');
});

// ── The authored collections ────────────────────────────────────────────────
//
// One set of routes over all four. See collections.js for why.

adminRouter.get('/c/:slug', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();

  res.render('collection', {
    title: spec.label,
    slug: req.params.slug,
    spec,
    rows: listRows(spec),
  });
});

adminRouter.get('/c/:slug/new', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();

  res.render('collection-form', {
    title: `New ${spec.singular}`,
    slug: req.params.slug,
    spec,
    row: null,
    errors: [],
  });
});

adminRouter.post('/c/:slug/new', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();

  const { values, errors } = readForm(spec, req.body);
  if (errors.length) {
    return res.render('collection-form', {
      title: `New ${spec.singular}`,
      slug: req.params.slug,
      spec,
      row: req.body,
      errors,
    });
  }

  insertRow(spec, values);
  req.flash('success', `Added the ${spec.singular}.`);
  res.redirect(`/admin/c/${req.params.slug}`);
});

adminRouter.get('/c/:slug/:id/edit', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();

  const row = getRow(spec, req.params.id);
  if (!row) return next();

  res.render('collection-form', {
    title: `Edit ${spec.singular}`,
    slug: req.params.slug,
    spec,
    row,
    errors: [],
  });
});

adminRouter.post('/c/:slug/:id/edit', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();
  if (!getRow(spec, req.params.id)) return next();

  const { values, errors } = readForm(spec, req.body);
  if (errors.length) {
    return res.render('collection-form', {
      title: `Edit ${spec.singular}`,
      slug: req.params.slug,
      spec,
      row: { ...req.body, id: req.params.id },
      errors,
    });
  }

  updateRow(spec, req.params.id, values);
  req.flash('success', `Saved the ${spec.singular}.`);
  res.redirect(`/admin/c/${req.params.slug}`);
});

adminRouter.post('/c/:slug/:id/publish', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();

  togglePublished(spec, req.params.id);
  res.redirect(`/admin/c/${req.params.slug}`);
});

adminRouter.post('/c/:slug/:id/delete', (req, res, next) => {
  const spec = collection(req.params.slug);
  if (!spec) return next();

  deleteRow(spec, req.params.id);
  req.flash('success', `Deleted the ${spec.singular}.`);
  res.redirect(`/admin/c/${req.params.slug}`);
});

// ── Catalogue browser ───────────────────────────────────────────────────────
//
// Read-only on purpose: these rows are a mirror of upstream and any edit would
// be overwritten by the next sync without warning.

adminRouter.get('/cosmetics', (req, res) => {
  const search = String(req.query.search ?? '').trim().toLowerCase();
  const rarity = String(req.query.rarity ?? '').trim();

  const where = [];
  const params = {};
  if (search) {
    where.push('search_blob LIKE @search');
    params.search = `%${search}%`;
  }
  if (rarity) {
    where.push('rarity = @rarity');
    params.rarity = rarity;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, name, type_name, rarity, series, season, icon_url FROM cosmetics ${clause}
        ORDER BY added_at IS NULL, added_at DESC LIMIT 120`,
    )
    .all(params);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM cosmetics ${clause}`).get(params).n;

  res.render('cosmetics', {
    title: 'Catalogue',
    rows,
    total,
    search,
    rarity,
    rarities: db
      .prepare('SELECT rarity, COUNT(*) AS count FROM cosmetics WHERE rarity IS NOT NULL GROUP BY rarity ORDER BY count DESC')
      .all(),
  });
});

// ── Wallpapers ──────────────────────────────────────────────────────────────
//
// Files on disk rather than rows of URLs. A folder is a category, which means
// organising the gallery is moving files rather than editing records.

adminRouter.get('/wallpapers', async (req, res) => {
  const data = await gallery();
  res.render('wallpapers', {
    title: 'Wallpapers',
    items: data.items,
    categories: data.categories,
  });
});

adminRouter.post('/wallpapers', uploadWallpaper, handleUploadErrors, csrfProtect, async (req, res) => {
  if (!req.file) {
    req.flash('danger', 'Choose an image to upload.');
    return res.redirect('/admin/wallpapers');
  }

  const result = await storeWallpaper({
    buffer: req.file.buffer,
    filename: req.file.originalname,
    category: String(req.body?.category ?? '').trim(),
  });

  if (!result.ok) {
    req.flash('danger', result.reason);
  } else {
    forgetGallery();
    req.flash('success', `Uploaded ${result.id}.`);
  }
  res.redirect('/admin/wallpapers');
});

adminRouter.post('/wallpapers/delete', async (req, res) => {
  const result = await deleteWallpaper(String(req.body?.id ?? ''));
  if (!result.ok) {
    req.flash('danger', result.reason ?? 'That file could not be removed.');
  } else {
    forgetGallery();
    req.flash('success', 'Deleted.');
  }
  res.redirect('/admin/wallpapers');
});

// ── Bulk weapon import ──────────────────────────────────────────────────────
//
// Two steps on purpose. The parser guesses at columns when a paste has no
// header, and a bulk import that guesses silently is how forty rows of
// nonsense get into a panel at once. Nothing is written until the preview has
// been seen and confirmed.

adminRouter.get('/weapons/import', (req, res) => {
  res.render('weapons-import', {
    title: 'Import weapons',
    parsed: null,
    pasted: '',
    replace: false,
    vaulted: false,
  });
});

adminRouter.post('/weapons/import', (req, res) => {
  const pasted = String(req.body?.pasted ?? '');
  const replace = req.body?.replace === 'on';
  const parsed = parseWeapons(pasted, { includeVaulted: req.body?.vaulted === 'on' });

  if (!parsed.rows.length) {
    req.flash('danger', 'Nothing in that paste looked like a weapon row.');
  }

  res.render('weapons-import', {
    title: 'Import weapons',
    parsed,
    pasted,
    replace,
    vaulted: req.body?.vaulted === 'on',
  });
});

adminRouter.post('/weapons/import/confirm', (req, res) => {
  const parsed = parseWeapons(String(req.body?.pasted ?? ''), {
    includeVaulted: req.body?.vaulted === 'on',
  });
  if (!parsed.rows.length) {
    req.flash('danger', 'Nothing to import.');
    return res.redirect('/admin/weapons/import');
  }

  const replace = req.body?.replace === 'on';

  // One transaction: a half-finished import is worse than none, because there
  // is no way to tell which half went in.
  const insert = db.prepare(
    `INSERT INTO weapons (name, rarity, category, dps, damage, fire_rate, magazine,
                          reload_time, image_url, sort_order, is_published)
     VALUES (@name, @rarity, @category, @dps, @damage, @fire_rate, @magazine,
             @reload_time, @image_url, @sort_order, @is_published)`,
  );

  const run = db.transaction((rows) => {
    if (replace) db.prepare('DELETE FROM weapons').run();
    rows.forEach((row, index) => {
      insert.run({
        name: row.name,
        rarity: row.rarity ?? 'common',
        category: row.category ?? null,
        dps: row.dps ?? null,
        damage: row.damage ?? null,
        fire_rate: row.fire_rate ?? null,
        magazine: row.magazine ?? null,
        reload_time: row.reload_time ?? null,
        image_url: row.image_url ?? null,
        sort_order: index,
        // Vaulted weapons come in hidden. They are history, and an app that
        // lists a retired rifle beside a current one is telling players
        // something untrue about what they can find in a match.
        is_published: row.vaulted ? 0 : 1,
      });
    });
  });

  run(parsed.rows);
  req.flash('success',
    `Imported ${parsed.rows.length} weapon${parsed.rows.length === 1 ? '' : 's'}` +
    (replace ? ', replacing what was there.' : '.'));
  res.redirect('/admin/c/weapons');
});

// ── Bulk creative-map import ────────────────────────────────────────────────
//
// Anchored on the island code rather than on a layout — see maps-import.js.
// Same two steps as weapons: read, look, then save.

adminRouter.get('/maps/import', (req, res) => {
  res.render('maps-import', { title: 'Import maps', parsed: null, pasted: '', replace: false });
});

adminRouter.post('/maps/import', (req, res) => {
  const pasted = String(req.body?.pasted ?? '');
  const parsed = parseMaps(pasted);

  if (!parsed.rows.length) {
    req.flash('danger', 'No island codes found in that paste.');
  }
  res.render('maps-import', {
    title: 'Import maps',
    parsed,
    pasted,
    replace: req.body?.replace === 'on',
  });
});

adminRouter.post('/maps/import/confirm', (req, res) => {
  const parsed = parseMaps(String(req.body?.pasted ?? ''));
  if (!parsed.rows.length) {
    req.flash('danger', 'Nothing to import.');
    return res.redirect('/admin/maps/import');
  }

  const replace = req.body?.replace === 'on';

  const insert = db.prepare(
    `INSERT INTO creative_maps (title, code, category, description, image_url, sort_order, is_published)
     VALUES (@title, @code, @category, @description, @image_url, @sort_order, 1)`,
  );

  // An island code identifies a map, so re-importing a list that overlaps an
  // earlier one should update rather than duplicate. Without this the obvious
  // second import silently doubles the gallery.
  const existing = new Set(
    db.prepare('SELECT code FROM creative_maps').all().map((r) => r.code),
  );
  const update = db.prepare(
    `UPDATE creative_maps SET title = @title, image_url = COALESCE(@image_url, image_url)
      WHERE code = @code`,
  );

  let added = 0;
  let updated = 0;

  db.transaction((rows) => {
    if (replace) {
      db.prepare('DELETE FROM creative_maps').run();
      existing.clear();
    }
    rows.forEach((row, index) => {
      const values = {
        title: row.title,
        code: row.code,
        category: row.category ?? null,
        description: row.description ?? null,
        image_url: row.image_url ?? null,
        sort_order: index,
      };
      if (existing.has(row.code)) { update.run(values); updated += 1; }
      else { insert.run(values); added += 1; }
    });
  })(parsed.rows);

  req.flash('success',
    `${added} map${added === 1 ? '' : 's'} added` +
    (updated ? `, ${updated} updated` : '') + '.');
  res.redirect('/admin/c/creative-maps');
});
