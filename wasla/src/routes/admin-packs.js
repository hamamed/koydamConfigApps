import { PACK_COLORS, PACK_ICONS } from '../packs.js';

/** Packs: list, create, edit, reorder, delete. */
export function registerPacks(router, { repo }) {
  const blank = { title: '', slug: '', color: PACK_COLORS[0][0], icon: PACK_ICONS[1][0] };

  const renderForm = (res, pack, error = null) => res.render('pack-form', {
    title: pack.id ? 'Edit pack' : 'New pack',
    pack,
    colors: PACK_COLORS,
    icons: PACK_ICONS,
    // Shown in place of the session flash, so a refused form keeps what was typed.
    ...(error ? { flash: { type: 'danger', message: error } } : {}),
  });

  const readForm = (body) => ({ title: body.title, slug: body.slug, color: body.color, icon: body.icon });

  router.get('/packs', (_req, res) => {
    res.render('packs', { title: 'Packs', packs: repo.listPacks(), icons: new Map(PACK_ICONS) });
  });

  router.get('/packs/new', (_req, res) => renderForm(res, blank));

  router.get('/packs/:id', (req, res, next) => {
    const pack = repo.getPack(Number(req.params.id));
    if (!pack) return next();
    renderForm(res, pack);
  });

  router.post('/packs', (req, res) => {
    const input = readForm(req.body);
    const result = repo.createPack(input);
    if (result.error) return renderForm(res, input, result.error);
    req.flash('success', `Created the pack “${result.pack.title}”. Assign levels to it from each level's page.`);
    res.redirect('/admin/packs');
  });

  router.post('/packs/:id', (req, res) => {
    const id = Number(req.params.id);
    const input = readForm(req.body);
    const result = repo.updatePack(id, input);
    if (result.error) return renderForm(res, { ...input, id }, result.error);
    req.flash('success', 'Pack saved.');
    res.redirect('/admin/packs');
  });

  router.post('/packs/:id/move', (req, res) => {
    repo.movePack(Number(req.params.id), req.body.direction === 'up' ? 'up' : 'down');
    res.redirect('/admin/packs');
  });

  router.post('/packs/:id/delete', (req, res) => {
    const pack = repo.getPack(Number(req.params.id));
    if (pack) {
      repo.deletePack(pack.id);
      req.flash('success', `Deleted “${pack.title}”. Its ${pack.levelCount} level(s) are now in the general pack.`);
    }
    res.redirect('/admin/packs');
  });
}
