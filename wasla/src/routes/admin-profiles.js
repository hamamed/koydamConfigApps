/**
 * Player profiles: find a username, rename one that breaks the rules, hide a
 * player from the leaderboards (ban) or delete the profile.
 */
export function registerProfiles(router, { profiles }) {
  router.get('/profiles', (req, res) => {
    const search = String(req.query.q ?? '');
    res.render('profiles', { title: 'Profiles', search, rows: profiles.list({ search }), count: profiles.count() });
  });

  const back = (req) => `/admin/profiles${req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''}`;
  const load = (req, res) => {
    const profile = profiles.get(Number(req.params.id));
    if (!profile) {
      req.flash('danger', 'That profile no longer exists.');
      res.redirect(back(req));
    }
    return profile;
  };

  router.post('/profiles/:id/rename', (req, res) => {
    const profile = load(req, res);
    if (!profile) return;
    const result = profiles.update(profile, { username: req.body.username }, { force: true });
    req.flash(result.error ? 'danger' : 'success', result.error ?? `Renamed “${profile.username}” to “${result.profile.username}”.`);
    res.redirect(back(req));
  });

  router.post('/profiles/:id/ban', (req, res) => {
    const profile = load(req, res);
    if (!profile) return;
    const banned = req.body.banned === '1';
    profiles.setBanned(profile.id, banned);
    req.flash('success', banned ? `“${profile.username}” is hidden from the leaderboards and cannot post scores.` : `“${profile.username}” is back.`);
    res.redirect(back(req));
  });

  router.post('/profiles/:id/delete', (req, res) => {
    const profile = load(req, res);
    if (!profile) return;
    profiles.remove(profile);
    req.flash('success', `Deleted “${profile.username}” and its scores.`);
    res.redirect(back(req));
  });
}
