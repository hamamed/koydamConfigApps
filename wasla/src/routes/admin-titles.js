/**
 * Titles: the list every title box in the panel offers, with how many
 * questions use each. Add (one per line), rename (on every question too) and
 * delete (only when unused).
 */
export function registerTitles(router, { titles }) {
  router.get('/titles', (_req, res) => {
    const list = titles.list();
    res.render('titles', {
      title: 'Titles',
      titles: list,
      used: list.filter((t) => t.questions).length,
    });
  });

  router.post('/titles', (req, res) => {
    const { added, existing, errors } = titles.addMany(req.body.names);
    const parts = [
      added ? `Added ${added} title(s).` : 'No new titles.',
      existing ? `${existing} already on the list.` : '',
      errors.length ? `Not added: ${errors.join(' · ')}` : '',
    ];
    req.flash(errors.length ? 'warning' : added ? 'success' : 'warning', parts.filter(Boolean).join(' '));
    res.redirect('/admin/titles');
  });

  router.post('/titles/rename', (req, res) => {
    const result = titles.rename(req.body.from, req.body.to);
    if (result.error) req.flash('danger', result.error);
    else req.flash('success', `Renamed. ${result.renamed} question(s) now have the new title.`);
    res.redirect('/admin/titles');
  });

  router.post('/titles/delete', (req, res) => {
    const result = titles.remove(req.body.name);
    req.flash(result.error ? 'danger' : 'success', result.error ?? 'Title removed from the list.');
    res.redirect('/admin/titles');
  });
}
