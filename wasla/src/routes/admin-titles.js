/**
 * Titles: the list every title box in the panel offers, with how many
 * questions use each. Add (one per line), rename (on every question too) and
 * delete (only when unused).
 */
export function registerTitles(router, { titles }) {
  router.get('/titles', (_req, res) => {
    const list = titles.list();
    res.render('titles', {
      title: 'الفئات',
      titles: list,
      used: list.filter((t) => t.questions).length,
    });
  });

  router.post('/titles', (req, res) => {
    const { added, existing, errors } = titles.addMany(req.body.names);
    const parts = [
      added ? `أُضيفت ${added} فئة.` : 'لا فئات جديدة.',
      existing ? `${existing} already on the list.` : '',
      errors.length ? `لم تُضف: ${errors.join(' · ')}` : '',
    ];
    req.flash(errors.length ? 'warning' : added ? 'success' : 'warning', parts.filter(Boolean).join(' '));
    res.redirect('/admin/titles');
  });

  router.post('/titles/rename', (req, res) => {
    const result = titles.rename(req.body.from, req.body.to);
    if (result.error) req.flash('danger', result.error);
    else req.flash('success', `تغيّر الاسم. ${result.renamed} سؤالاً صار بالفئة الجديدة.`);
    res.redirect('/admin/titles');
  });

  router.post('/titles/delete', (req, res) => {
    const result = titles.remove(req.body.name);
    req.flash(result.error ? 'danger' : 'success', result.error ?? 'حُذفت الفئة من القائمة.');
    res.redirect('/admin/titles');
  });
}
