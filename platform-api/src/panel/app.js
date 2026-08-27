// Dashboard.
//
// Served as a file, not inlined: the panel runs under `script-src 'self'` and
// an inline script is blocked outright — the page renders and nothing happens.
//
// Everything from the server is written as a text node, never as HTML. App
// names, flag keys, ad unit ids and audit entries are all operator input, and
// building markup by concatenation here would be stored XSS on the one page
// that can repoint a live app's ads.

// ── State ───────────────────────────────────────────────────────────────────

let me = null;
let csrf = '';
let overview = { apps: [], services: [], stats: [] };

const $ = (id) => document.getElementById(id);

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** `<use>` needs the SVG namespace, so this cannot go through el(). */
function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'lucide');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/panel/icons.svg#i-' + name);
  svg.append(use);
  return svg;
}

function toast(message, kind = 'ok') {
  // The stylesheet knows one modifier: is-error. Call sites have used 'err'
  // and 'bad' interchangeably, and neither matched anything - so every failure
  // has been rendering as an ordinary ink toast, indistinguishable from a
  // success. Mapped here rather than at thirty-four call sites.
  const t = el('div', 'ad-toast' + (kind === 'ok' ? '' : ' is-error'));
  t.append(icon(kind === 'ok' ? 'circle-check' : 'circle-alert', 15));
  t.append(el('span', null, message));
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

const fmt = (n) => (n ?? 0).toLocaleString();

function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// ── API ─────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // Double-submit CSRF. The cookie is SameSite=Lax already; this covers
      // what Lax does not and costs one header.
      'X-CSRF-Token': csrf,
      ...(options.headers ?? {}),
    },
  });

  if (res.status === 401) {
    location.replace('/login');
    throw new Error('signed out');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? 'HTTP ' + res.status);
  return body;
}

// ── Card scaffolding ────────────────────────────────────────────────────────

function card(title, iconName) {
  const c = el('div', 'ad-card mb-3');
  if (title) {
    const head = el('div', 'ad-card-head d-flex align-items-center gap-2');
    if (iconName) head.append(icon(iconName, 16));
    head.append(el('span', 'fw-semibold', title));
    c.append(head);
  }
  const body = el('div', 'ad-card-body');
  c.append(body);
  return { card: c, body, head: c.firstChild };
}

function table(headers, rows) {
  const wrap = el('div', 'ad-table-wrap');
  const t = el('table', 'ad-table');

  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) {
    const th = el('th', null, typeof h === 'string' ? h : h.label);
    if (typeof h === 'object' && h.align) th.style.textAlign = h.align;
    hr.append(th);
  }
  thead.append(hr);

  const tbody = el('tbody');
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'kd-faint small', 'Nothing here yet.');
    td.colSpan = headers.length;
    tr.append(td);
    tbody.append(tr);
  } else {
    for (const cells of rows) {
      const tr = el('tr');
      for (const cell of cells) {
        if (cell instanceof Node) {
          const td = el('td');
          td.append(cell);
          tr.append(td);
        } else if (cell && typeof cell === 'object') {
          const td = el('td', cell.className, cell.text);
          if (cell.align) td.style.textAlign = cell.align;
          tr.append(td);
        } else {
          tr.append(el('td', null, cell ?? '—'));
        }
      }
      tbody.append(tr);
    }
  }

  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

function statusDot(ok) {
  const s = el('span', 'ad-status ' + (ok === null ? 'ad-status-draft' : ok ? 'ad-status-published' : 'ad-status-archived'));
  s.textContent = ok === null ? 'unknown' : ok ? 'up' : 'down';
  return s;
}

// ── Views ───────────────────────────────────────────────────────────────────

/**
 * The age of the newest backup, fetched after the page has drawn.
 *
 * Its own request rather than part of the overview, because it reads the
 * filesystem and the dashboard should not wait on that. Only admins can ask;
 * for anyone else the line simply stays empty.
 */
async function loadBackupStatus(target) {
  try {
    const s = await api('/api/backups');

    const badge = el('span', 'ad-backup' + (s.stale ? ' stale' : ''));
    badge.append(icon(s.stale ? 'circle-alert' : 'circle-check', 14));

    if (!s.configured) {
      badge.append(el('span', null, 'No backups have ever run'));
    } else if (!s.latest) {
      badge.append(el('span', null, 'Backup directory is empty'));
    } else {
      const age = s.ageHours < 1
        ? 'less than an hour ago'
        : s.ageHours < 48
          ? Math.round(s.ageHours) + 'h ago'
          : Math.round(s.ageHours / 24) + ' days ago';
      badge.append(el('span', null, `Last backup ${age} · ${s.count} kept`));
    }

    target.replaceChildren(badge);
  } catch {
    // Not an admin, or the endpoint is unavailable. Neither is worth an error
    // on a dashboard whose other panels loaded fine.
    target.replaceChildren();
  }
}

function viewHome() {
  const root = el('div');

  const kpis = el('div', 'row g-3 mb-1');
  const totalFetches = overview.stats.reduce((n, s) => n + s.hits, 0);
  const down = overview.services.filter((s) => s.ok === false).length;

  const tiles = [
    ['Apps', fmt(overview.apps.length), 'layout-grid'],
    ['Services', fmt(overview.services.length), 'server'],
    ['Config fetches · 14d', fmt(totalFetches), 'chart-column'],
    ['Services down', fmt(down), down ? 'circle-alert' : 'circle-check'],
  ];

  // Filled in after the tiles render: the dashboard should not wait on a
  // filesystem read, and a missing answer is not worth blocking on.
  const backupLine = el('div', 'mb-3');
  loadBackupStatus(backupLine);

  for (const [label, value, ic] of tiles) {
    const col = el('div', 'col-6 col-xl-3');
    const c = el('div', 'ad-card ad-kpi');
    const top = el('div', 'd-flex align-items-center gap-2 mb-2');
    top.append(icon(ic, 17));
    top.append(el('span', 'ad-kpi-label', label));
    c.append(top, el('div', 'ad-kpi-value', value));
    col.append(c);
    kpis.append(col);
  }
  root.append(kpis, backupLine);

  // Apps
  const appsCard = card('Apps', 'layout-grid');
  appsCard.body.classList.add('p-0');
  appsCard.body.append(
    table(
      ['App', 'Platforms', 'Ads', 'Maintenance', ''],
      overview.apps.map((a) => {
        const platforms = a.platforms ?? [];
        const link = el('a', 'fw-semibold', a.name);
        link.href = '#/app/' + a.slug;

        const plats = el('div', 'd-flex gap-1');
        for (const p of platforms) plats.append(el('span', 'badge text-bg-light', p.platform));

        const adsOn = platforms.filter((p) => p.adsEnabled).length;
        const maint = platforms.filter((p) => p.maintenance).map((p) => p.platform);

        const open = el('a', 'btn btn-sm btn-outline-secondary', 'Open');
        open.href = '#/app/' + a.slug;

        return [
          link,
          plats,
          { text: `${adsOn}/${platforms.length}` },
          maint.length ? { text: maint.join(', '), className: 'text-danger small' } : { text: '—', className: 'kd-faint' },
          open,
        ];
      }),
    ),
  );
  root.append(appsCard.card);

  // Services — admins only; the API omits them otherwise.
  if (overview.services.length) {
    const svc = card('Services', 'server');
    svc.body.classList.add('p-0');
    svc.body.append(
      table(
        ['Service', 'Domain', 'Status', 'Uptime 24h', 'Response', 'Checked'],
        overview.services.map((s) => {
          const domain = s.domain
            ? Object.assign(el('a', 'kd-muted small', s.domain), {
                href: 'https://' + s.domain,
                target: '_blank',
                rel: 'noopener',
              })
            : el('span', 'kd-faint', '—');

          return [
            el('span', 'fw-semibold', s.name),
            domain,
            statusDot(s.ok ?? null),
            {
              text: s.uptime24h === null ? '—' : Math.round(s.uptime24h * 100) + '%',
              className: s.uptime24h !== null && s.uptime24h < 0.99 ? 'text-warning' : '',
            },
            { text: s.durationMs ? s.durationMs + 'ms' : '—', className: 'kd-faint small' },
            { text: ago(s.checkedAt), className: 'kd-faint small' },
          ];
        }),
      ),
    );
    root.append(svc.card);
  }

  return root;
}

async function viewApp(slug) {
  const detail = await api('/api/apps/' + encodeURIComponent(slug));
  const root = el('div');

  const head = el('div', 'd-flex align-items-center gap-2 mb-3');
  head.append(el('h2', 'kd-h4 mb-0', detail.name));
  head.append(el('span', 'kd-faint small', detail.slug));
  if (!detail.canEdit) {
    head.append(el('span', 'badge text-bg-light ms-2', 'read only'));
  }
  root.append(head);

  for (const platform of ['ios', 'android']) {
    root.append(platformCard(detail, platform));
  }

  root.append(flagsCard(detail));

  // Everything the panel can say to this app's users, below what it can
  // configure about it.
  root.append(announcementsCard(detail.slug));
  root.append(ratingCard(detail));
  root.append(releaseNotesCard(detail.slug));

  root.append(versionsCard(detail));
  return root;
}

// ── Announcements ───────────────────────────────────────────────────────────

/**
 * A banner the app shows, pushed without a release.
 *
 * Loaded after the page draws rather than folded into the app detail request:
 * this is a second table and the platform editors above are what someone came
 * for.
 */
function announcementsCard(slug) {
  const c = card('Announcement banner', 'circle-alert');

  c.body.append(
    el(
      'p',
      'kd-faint small',
      'One banner at a time. The most recent live one that matches the ' +
        'client’s platform and version wins.',
    ),
  );

  const list = el('div');
  c.body.append(list);

  const refresh = async () => {
    try {
      const { announcements } = await api(`/api/apps/${slug}/announcements`);

      list.replaceChildren(
        table(
          ['Title', 'Scope', 'Window', 'State', ''],
          announcements.map((a) => {
            const scope = [
              a.platform ?? 'both',
              a.min_version || a.max_version
                ? `${a.min_version ?? '…'}–${a.max_version ?? '…'}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ');

            const window =
              a.starts_at || a.ends_at
                ? `${a.starts_at ? new Date(a.starts_at).toLocaleDateString() : '…'} – ` +
                  `${a.ends_at ? new Date(a.ends_at).toLocaleDateString() : '…'}`
                : 'always';

            const state = a.live
              ? { text: 'live', className: 'text-success small fw-semibold' }
              : a.active
                ? { text: 'scheduled', className: 'kd-faint small' }
                : { text: 'off', className: 'kd-faint small' };

            const actions = el('div', 'd-flex gap-1');

            const toggle = el(
              'button',
              'btn btn-sm btn-outline-secondary',
              a.active ? 'Turn off' : 'Turn on',
            );
            toggle.addEventListener('click', async () => {
              try {
                await api(`/api/apps/${slug}/announcements/${a.id}/toggle`, { method: 'POST' });
                refresh();
              } catch (err) {
                toast(err.message, 'err');
              }
            });

            const del = el('button', 'btn btn-sm btn-outline-danger', 'Delete');
            del.addEventListener('click', async () => {
              try {
                await api(`/api/apps/${slug}/announcements/${a.id}`, { method: 'DELETE' });
                toast('Deleted');
                refresh();
              } catch (err) {
                toast(err.message, 'err');
              }
            });

            actions.append(toggle, del);

            const title = el('div');
            title.append(el('div', 'fw-semibold', a.title));
            if (a.body) title.append(el('div', 'kd-faint small', a.body.slice(0, 90)));

            return [title, { text: scope, className: 'kd-faint small' },
                    { text: window, className: 'kd-faint small' }, state, actions];
          }),
        ),
      );
    } catch (err) {
      list.replaceChildren(el('div', 'ad-empty', err.message));
    }
  };

  refresh();

  // ── New ──
  const form = el('div', 'row g-2 mt-3');

  const title = el('input', 'form-control form-control-sm');
  title.placeholder = 'Season 32 meta is live';

  const body = el('input', 'form-control form-control-sm');
  body.placeholder = 'Tier lists updated for the new balance changes.';

  const kind = el('select', 'form-select form-select-sm');
  for (const [v, l] of [['info', 'Info'], ['warning', 'Warning'], ['success', 'Good news']]) {
    const o = el('option', null, l);
    o.value = v;
    kind.append(o);
  }

  const platform = el('select', 'form-select form-select-sm');
  for (const [v, l] of [['', 'Both platforms'], ['ios', 'iOS only'], ['android', 'Android only']]) {
    const o = el('option', null, l);
    o.value = v;
    platform.append(o);
  }

  const linkUrl = el('input', 'form-control form-control-sm');
  linkUrl.placeholder = 'https://… (optional)';

  const minVersion = el('input', 'form-control form-control-sm');
  minVersion.placeholder = 'Min version';

  const maxVersion = el('input', 'form-control form-control-sm');
  maxVersion.placeholder = 'Max version';

  const startsAt = el('input', 'form-control form-control-sm');
  startsAt.type = 'datetime-local';

  const endsAt = el('input', 'form-control form-control-sm');
  endsAt.type = 'datetime-local';

  for (const [label, control, width] of [
    ['Title', title, 'col-12 col-md-6'],
    ['Body', body, 'col-12 col-md-6'],
    ['Style', kind, 'col-6 col-md-3'],
    ['Who sees it', platform, 'col-6 col-md-3'],
    ['Link', linkUrl, 'col-12 col-md-6'],
    ['From version', minVersion, 'col-6 col-md-3'],
    ['To version', maxVersion, 'col-6 col-md-3'],
    ['Show from', startsAt, 'col-6 col-md-3'],
    ['Show until', endsAt, 'col-6 col-md-3'],
  ]) {
    const col = el('div', width);
    col.append(el('label', 'form-label small kd-faint', label), control);
    form.append(col);
  }

  c.body.append(form);

  const dismissWrap = el('div', 'form-check mt-2');
  const dismissible = el('input', 'form-check-input');
  dismissible.type = 'checkbox';
  dismissible.id = 'annDismiss';
  dismissible.checked = true;
  const dismissLabel = el('label', 'form-check-label small', 'People can dismiss it');
  dismissLabel.htmlFor = 'annDismiss';
  dismissWrap.append(dismissible, dismissLabel);
  c.body.append(dismissWrap);

  const add = el('button', 'btn btn-sm btn-primary mt-2', 'Publish banner');
  add.addEventListener('click', async () => {
    if (!title.value.trim()) return toast('Give it a title', 'err');

    add.disabled = true;
    try {
      await api(`/api/apps/${slug}/announcements`, {
        method: 'POST',
        body: JSON.stringify({
          title: title.value.trim(),
          body: body.value.trim() || null,
          kind: kind.value,
          platform: platform.value || null,
          linkUrl: linkUrl.value.trim() || null,
          minVersion: minVersion.value.trim() || null,
          maxVersion: maxVersion.value.trim() || null,
          startsAt: startsAt.value ? new Date(startsAt.value).toISOString() : null,
          endsAt: endsAt.value ? new Date(endsAt.value).toISOString() : null,
          dismissible: dismissible.checked,
        }),
      });
      toast('Published');
      title.value = body.value = linkUrl.value = '';
      minVersion.value = maxVersion.value = startsAt.value = endsAt.value = '';
      refresh();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      add.disabled = false;
    }
  });
  c.body.append(add);

  return c.card;
}

// ── Rating prompt ───────────────────────────────────────────────────────────

function ratingCard(detail) {
  const c = card('Review prompt', 'circle-check');

  c.body.append(
    el(
      'p',
      'kd-faint small',
      'iOS allows a limited number of review prompts a year. Asking too early ' +
        'spends one on somebody who has barely used the app.',
    ),
  );

  for (const platform of ['ios', 'android']) {
    const existing =
      (detail.platforms ?? []).find((p) => p.platform === platform)?.ratingPrompt ?? {};

    const row = el('div', 'row g-2 align-items-end mb-2');

    const heading = el('div', 'col-12');
    heading.append(el('div', 'ad-section-label', platform.toUpperCase()));
    row.append(heading);

    const enabled = el('input', 'form-check-input');
    enabled.type = 'checkbox';
    enabled.checked = existing.enabled ?? false;

    const enabledCol = el('div', 'col-6 col-md-2');
    const check = el('div', 'form-check');
    check.append(enabled, el('label', 'form-check-label small', 'Ask'));
    enabledCol.append(check);
    row.append(enabledCol);

    const mk = (label, value, fallback) => {
      const input = el('input', 'form-control form-control-sm');
      input.type = 'number';
      input.min = '0';
      input.value = value ?? fallback;
      const col = el('div', 'col-6 col-md-3');
      col.append(el('label', 'form-label small kd-faint', label), input);
      row.append(col);
      return input;
    };

    const minSessions = mk('After N opens', existing.minSessions, 5);
    const minDays = mk('Not before day', existing.minDaysInstalled, 3);
    const cooldown = mk('Ask again after (days)', existing.cooldownDays, 90);

    const save = el('button', 'btn btn-sm btn-outline-secondary', 'Save');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api(`/api/apps/${detail.slug}/rating/${platform}`, {
          method: 'POST',
          body: JSON.stringify({
            enabled: enabled.checked,
            minSessions: Number(minSessions.value),
            minDaysInstalled: Number(minDays.value),
            cooldownDays: Number(cooldown.value),
          }),
        });
        toast(platform.toUpperCase() + ' saved');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        save.disabled = false;
      }
    });

    const saveCol = el('div', 'col-6 col-md-2');
    saveCol.append(save);
    row.append(saveCol);

    c.body.append(row);
  }

  return c.card;
}

// ── Release notes ───────────────────────────────────────────────────────────

function releaseNotesCard(slug) {
  const c = card("What's new", 'scroll-text');

  c.body.append(
    el(
      'p',
      'kd-faint small',
      'Shown once after an update, to whoever is running that version. Write ' +
        'them before the build ships and publish when it does.',
    ),
  );

  const list = el('div');
  c.body.append(list);

  const refresh = async () => {
    try {
      const { notes } = await api(`/api/apps/${slug}/release-notes`);

      list.replaceChildren(
        table(
          ['Version', 'Scope', 'Title', 'State', ''],
          notes.map((n) => {
            const del = el('button', 'btn btn-sm btn-outline-danger', 'Delete');
            del.addEventListener('click', async () => {
              try {
                await api(
                  `/api/apps/${slug}/release-notes/${encodeURIComponent(n.version)}`,
                  { method: 'DELETE' },
                );
                toast('Deleted');
                refresh();
              } catch (err) {
                toast(err.message, 'err');
              }
            });

            return [
              { text: n.version, className: 'fw-semibold' },
              { text: n.platform ?? 'both', className: 'kd-faint small' },
              { text: n.title ?? '—', className: 'small' },
              n.published
                ? { text: 'published', className: 'text-success small' }
                : { text: 'draft', className: 'kd-faint small' },
              del,
            ];
          }),
        ),
      );
    } catch (err) {
      list.replaceChildren(el('div', 'ad-empty', err.message));
    }
  };

  refresh();

  const form = el('div', 'row g-2 mt-3');

  const version = el('input', 'form-control form-control-sm');
  version.placeholder = '1.4.0';

  const platform = el('select', 'form-select form-select-sm');
  for (const [v, l] of [['', 'Both'], ['ios', 'iOS'], ['android', 'Android']]) {
    const o = el('option', null, l);
    o.value = v;
    platform.append(o);
  }

  const title = el('input', 'form-control form-control-sm');
  title.placeholder = "What's new in 1.4";

  const body = el('textarea', 'form-control form-control-sm');
  body.rows = 3;
  body.placeholder = 'Career stats now include your best three brawlers.';

  for (const [label, control, width] of [
    ['Version', version, 'col-6 col-md-2'],
    ['Platform', platform, 'col-6 col-md-2'],
    ['Title', title, 'col-12 col-md-8'],
    ['Notes', body, 'col-12'],
  ]) {
    const col = el('div', width);
    col.append(el('label', 'form-label small kd-faint', label), control);
    form.append(col);
  }
  c.body.append(form);

  const pubWrap = el('div', 'form-check mt-2');
  const published = el('input', 'form-check-input');
  published.type = 'checkbox';
  published.id = 'notesPublished';
  pubWrap.append(published, el('label', 'form-check-label small', 'Publish now'));
  c.body.append(pubWrap);

  const save = el('button', 'btn btn-sm btn-primary mt-2', 'Save notes');
  save.addEventListener('click', async () => {
    if (!version.value.trim()) return toast('Which version?', 'err');
    if (!body.value.trim()) return toast('Write the notes', 'err');

    save.disabled = true;
    try {
      await api(`/api/apps/${slug}/release-notes`, {
        method: 'POST',
        body: JSON.stringify({
          version: version.value.trim(),
          platform: platform.value || null,
          title: title.value.trim() || null,
          body: body.value.trim(),
          published: published.checked,
        }),
      });
      toast('Saved');
      version.value = title.value = body.value = '';
      published.checked = false;
      refresh();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
    }
  });
  c.body.append(save);

  return c.card;
}


function labelledInput(label, value, placeholder, disabled) {
  const wrap = el('div', 'mb-2');
  wrap.append(el('label', 'form-label small kd-muted mb-1', label));
  const input = el('input', 'form-control form-control-sm');
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  input.disabled = disabled;
  wrap.append(input);
  return { wrap, input };
}

function platformCard(detail, platform) {
  const existing = (detail.platforms ?? []).find((p) => p.platform === platform) ?? {};
  const ro = !detail.canEdit;

  const c = card(platform.toUpperCase(), platform === 'ios' ? 'apple' : 'smartphone');

  const grid = el('div', 'row g-2');
  const add = (label, value, ph, cls = 'col-12 col-md-6') => {
    const f = labelledInput(label, value, ph, ro);
    const col = el('div', cls);
    col.append(f.wrap);
    grid.append(col);
    return f.input;
  };

  const bundleId = add('Bundle id', existing.bundleId, 'com.example.app');
  const admobAppId = add('AdMob app id', existing.admobAppId, 'ca-app-pub-…~…');
  const storeUrl = add('Store URL', existing.storeUrl, 'https://apps.apple.com/…');
  const latest = add('Latest version', existing.latestVersion, '1.0.0', 'col-6 col-md-3');
  const minVer = add('Min supported', existing.minSupportedVersion, '1.0.0', 'col-6 col-md-3');
  c.body.append(grid);

  const toggles = el('div', 'd-flex flex-wrap gap-4 mt-2 mb-3');
  const mkToggle = (labelText, checked) => {
    const wrap = el('label', 'form-check form-switch d-flex align-items-center gap-2 mb-0');
    const box = el('input', 'form-check-input mt-0');
    box.type = 'checkbox';
    box.checked = checked;
    box.disabled = ro;
    wrap.append(box, el('span', 'small', labelText));
    toggles.append(wrap);
    return box;
  };
  const ads = mkToggle('Ads enabled', existing.adsEnabled ?? true);
  const testAds = mkToggle('Test ads', existing.testAds ?? false);
  const maint = mkToggle('Maintenance mode', existing.maintenance ?? false);
  c.body.append(toggles);

  c.body.append(
    el(
      'p',
      'kd-faint small mb-0',
      'Test ads serve Google’s own units instead of yours: the layout is ' +
        'exercised and nothing is earned. The setting to use while a build is ' +
        'in review, where a live advert risks a policy strike.',
    ),
  );

  const maintMsg = labelledInput('Maintenance message', existing.maintenanceMessage, 'Back shortly…', ro);
  c.body.append(maintMsg.wrap);

  const preview = el('a', 'btn btn-sm btn-outline-secondary mt-3', 'Preview what the app receives');
  preview.href = `#/preview/${detail.slug}/${platform}`;
  c.body.append(preview);

  // ── Ad units ──
  c.body.append(el('div', 'ad-section-label mt-3', 'Ad units'));
  const units = (detail.adUnits ?? []).filter((u) => u.platform === platform);
  const list = el('div', 'd-grid gap-1');

  if (!units.length) {
    list.append(el('div', 'kd-faint small', 'None — the app falls back to its built-in ids.'));
  }

  for (const u of units) {
    const row = el('div', 'd-flex align-items-center gap-2');
    row.append(el('span', 'badge text-bg-light', u.placement));
    const code = el('code', 'small kd-muted flex-grow-1 text-truncate', u.unit_id);
    row.append(code);

    if (!ro) {
      const rm = el('button', 'btn btn-sm btn-outline-danger py-0 px-1');
      rm.type = 'button';
      rm.append(icon('trash-2', 14));
      rm.addEventListener('click', async () => {
        try {
          await api(
            `/api/apps/${encodeURIComponent(detail.slug)}/ad-units/${platform}/${encodeURIComponent(u.placement)}`,
            { method: 'DELETE' },
          );
          toast('Removed ' + u.placement);
          route();
        } catch (err) {
          toast(err.message, 'bad');
        }
      });
      row.append(rm);
    }
    list.append(row);
  }

  if (!ro) {
    const addRow = el('div', 'd-flex gap-1 mt-2');
    const placement = el('select', 'form-select form-select-sm');
    placement.style.maxWidth = '9.5rem';
    for (const p of ['banner', 'interstitial', 'native', 'appOpen', 'rewarded']) {
      const o = el('option', null, p);
      o.value = p;
      placement.append(o);
    }
    const unitId = el('input', 'form-control form-control-sm');
    unitId.placeholder = 'ca-app-pub-…/…';

    const addBtn = el('button', 'btn btn-sm btn-primary', 'Add');
    addBtn.type = 'button';
    addBtn.addEventListener('click', async () => {
      if (!unitId.value.trim()) return;
      try {
        await api(`/api/apps/${encodeURIComponent(detail.slug)}/ad-units/${platform}`, {
          method: 'POST',
          body: JSON.stringify({ placement: placement.value, unitId: unitId.value.trim() }),
        });
        toast('Added ' + placement.value);
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    addRow.append(placement, unitId, addBtn);
    list.append(addRow);
  }
  c.body.append(list);

  // ── Pacing ──
  const pacingRow = (detail.pacing ?? []).find((p) => p.platform === platform);
  c.body.append(el('div', 'ad-section-label mt-3', 'Ad pacing (JSON)'));
  const pacing = el('textarea', 'form-control form-control-sm');
  pacing.rows = 4;
  pacing.disabled = ro;
  pacing.value = JSON.stringify(pacingRow?.settings ?? {}, null, 2);
  c.body.append(pacing);

  if (!ro) {
    const save = el('button', 'btn btn-sm btn-primary mt-3 d-flex align-items-center gap-2');
    save.type = 'button';
    save.append(icon('save', 15), el('span', null, 'Save ' + platform.toUpperCase()));

    save.addEventListener('click', async () => {
      let settings;
      try {
        settings = JSON.parse(pacing.value || '{}');
      } catch {
        // Refuse rather than store a broken blob every client would fetch and
        // fail to parse on launch.
        toast('Pacing is not valid JSON — nothing saved.', 'bad');
        return;
      }

      save.disabled = true;
      try {
        await api(`/api/apps/${encodeURIComponent(detail.slug)}/platforms/${platform}`, {
          method: 'POST',
          body: JSON.stringify({
            bundleId: bundleId.value.trim() || null,
            admobAppId: admobAppId.value.trim() || null,
            storeUrl: storeUrl.value.trim() || null,
            latestVersion: latest.value.trim() || null,
            minSupportedVersion: minVer.value.trim() || null,
            adsEnabled: ads.checked,
            testAds: testAds.checked,
            maintenance: maint.checked,
            maintenanceMessage: maintMsg.input.value.trim() || null,
          }),
        });
        await api(`/api/apps/${encodeURIComponent(detail.slug)}/pacing/${platform}`, {
          method: 'POST',
          body: JSON.stringify({ settings }),
        });
        toast(platform.toUpperCase() + ' saved');
        refresh();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        save.disabled = false;
      }
    });
    c.body.append(save);
  }

  return c.card;
}

function flagsCard(detail) {
  const ro = !detail.canEdit;
  const c = card('Feature flags', 'flag');
  const list = el('div', 'd-grid gap-1');

  if (!(detail.flags ?? []).length) {
    list.append(el('div', 'kd-faint small', 'None set.'));
  }

  for (const f of detail.flags ?? []) {
    const row = el('div', 'd-flex align-items-center gap-2');
    row.append(el('span', 'badge text-bg-light', f.platform ?? 'both'));
    row.append(el('span', 'fw-semibold small', f.key));
    row.append(el('code', 'small kd-muted flex-grow-1', JSON.stringify(f.value)));

    if (!ro) {
      const rm = el('button', 'btn btn-sm btn-outline-danger py-0 px-1');
      rm.type = 'button';
      rm.append(icon('trash-2', 14));
      rm.addEventListener('click', async () => {
        const q = f.platform ? '?platform=' + f.platform : '';
        try {
          await api(
            `/api/apps/${encodeURIComponent(detail.slug)}/flags/${encodeURIComponent(f.key)}${q}`,
            { method: 'DELETE' },
          );
          toast('Removed ' + f.key);
          route();
        } catch (err) {
          toast(err.message, 'bad');
        }
      });
      row.append(rm);
    }
    list.append(row);
  }

  if (!ro) {
    const addRow = el('div', 'd-flex gap-1 mt-2 flex-wrap');
    const scope = el('select', 'form-select form-select-sm');
    scope.style.maxWidth = '7rem';
    for (const [label, value] of [['both', ''], ['ios', 'ios'], ['android', 'android']]) {
      const o = el('option', null, label);
      o.value = value;
      scope.append(o);
    }
    const key = el('input', 'form-control form-control-sm');
    key.placeholder = 'flagKey';
    key.style.maxWidth = '12rem';
    const value = el('input', 'form-control form-control-sm');
    value.placeholder = 'true, 42, or "text"';

    const addBtn = el('button', 'btn btn-sm btn-primary', 'Set');
    addBtn.type = 'button';
    addBtn.addEventListener('click', async () => {
      if (!key.value.trim()) return;

      // Parsed so `true` is a boolean and `42` a number. Anything that is not
      // valid JSON is stored as the typed string, which is nearly always what
      // was meant.
      let parsed;
      try {
        parsed = JSON.parse(value.value);
      } catch {
        parsed = value.value;
      }

      try {
        await api(`/api/apps/${encodeURIComponent(detail.slug)}/flags`, {
          method: 'POST',
          body: JSON.stringify({ platform: scope.value || null, key: key.value.trim(), value: parsed }),
        });
        toast('Flag set');
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    addRow.append(scope, key, value, addBtn);
    list.append(addRow);
  }

  c.body.append(list);
  return c.card;
}

function versionsCard(detail) {
  const c = card('History', 'history');
  c.body.classList.add('p-0');

  c.body.append(
    table(
      ['When', 'By', 'Change', ''],
      (detail.versions ?? []).map((v) => {
        let action = el('span', 'kd-faint small', '—');

        if (detail.canEdit) {
          const btn = el('button', 'btn btn-sm btn-outline-secondary', 'Restore');
          btn.type = 'button';

          // Two taps rather than a browser dialog. Restoring rewrites an app's
          // whole configuration, so it deserves a confirmation - but a native
          // dialog is the one thing on the page that cannot be styled, and it
          // reads as the panel having broken rather than as a question.
          let armed = false;
          const disarm = () => {
            armed = false;
            btn.textContent = 'Restore';
            btn.classList.remove('btn-outline-danger');
            btn.classList.add('btn-outline-secondary');
          };

          btn.addEventListener('click', async () => {
            if (!armed) {
              armed = true;
              btn.textContent = 'Confirm restore';
              btn.classList.remove('btn-outline-secondary');
              btn.classList.add('btn-outline-danger');
              setTimeout(() => { if (armed) disarm(); }, 4000);
              return;
            }
            try {
              await api(`/api/apps/${encodeURIComponent(detail.slug)}/restore/${v.id}`, { method: 'POST' });
              toast('Restored');
              route();
            } catch (err) {
              toast(err.message, 'bad');
              // Back to a plain Restore, so a failed attempt does not leave the
              // button sitting armed for a stray click.
              disarm();
            }
          });
          action = btn;
        }

        return [
          { text: new Date(v.at).toLocaleString(), className: 'small' },
          { text: v.user ?? 'system', className: 'kd-muted small' },
          { text: v.note ?? '—', className: 'small' },
          action,
        ];
      }),
    ),
  );

  return c.card;
}

async function viewServices() {
  const { services } = await api('/api/services');
  const c = card('Services', 'server');
  c.body.classList.add('p-0');

  c.body.append(
    table(
      ['Service', 'Domain', 'Unit', 'Status', 'Uptime 24h', 'Avg', 'Last error'],
      services.map((s) => [
        el('span', 'fw-semibold', s.name),
        { text: s.domain ?? '—', className: 'kd-muted small' },
        { text: s.systemdUnit ?? '—', className: 'kd-faint small' },
        statusDot(s.ok ?? null),
        { text: s.uptime24h === null ? '—' : Math.round(s.uptime24h * 100) + '%' },
        { text: s.avgMs ? s.avgMs + 'ms' : '—', className: 'kd-faint small' },
        { text: s.error ?? '—', className: 'small text-danger text-truncate' },
      ]),
    ),
  );

  const root = el('div');
  root.append(c.card);
  return root;
}

async function viewAudit() {
  const { entries } = await api('/api/audit?limit=120');
  const c = card('Audit log', 'scroll-text');
  c.body.classList.add('p-0');

  c.body.append(
    table(
      ['When', 'Who', 'Action', 'Target', 'Detail', 'IP'],
      entries.map((e) => [
        { text: new Date(e.at).toLocaleString(), className: 'small' },
        { text: e.user_email ?? 'system', className: 'kd-muted small' },
        el('code', 'small', e.action),
        { text: e.target_id ?? '—', className: 'small' },
        { text: e.detail ? JSON.stringify(e.detail) : '—', className: 'kd-faint small text-truncate' },
        { text: e.ip ?? '—', className: 'kd-faint small' },
      ]),
    ),
  );

  const root = el('div');
  root.append(c.card);
  return root;
}

async function viewUsers() {
  const [{ users }] = await Promise.all([api('/api/users')]);
  const root = el('div');

  const c = card('Team', 'users');
  c.body.classList.add('p-0');

  c.body.append(
    table(
      ['Email', 'Role', 'App access', 'Last sign-in', ''],
      users.map((u) => {
        const grants = (u.grants ?? []).filter((g) => g.app);
        const gwrap = el('div', 'd-flex gap-1 flex-wrap');
        if (!grants.length) {
          gwrap.append(el('span', 'kd-faint small', u.role === 'owner' || u.role === 'admin' ? 'all apps' : 'none'));
        }
        for (const g of grants) {
          const b = el('span', 'badge text-bg-light', g.app);
          b.title = g.role;
          gwrap.append(b);
        }

        const actions = el('div', 'd-flex gap-1');

        const grant = el('button', 'btn btn-sm btn-outline-secondary', 'Grant app');
        grant.type = 'button';
        grant.addEventListener('click', () => grantDialog(u));
        actions.append(grant);

        if (u.email !== me.email) {
          const toggle = el('button', 'btn btn-sm btn-outline-danger', u.disabled ? 'Enable' : 'Disable');
          toggle.type = 'button';
          toggle.addEventListener('click', async () => {
            try {
              await api(`/api/users/${u.id}/disable`, {
                method: 'POST',
                body: JSON.stringify({ disabled: !u.disabled }),
              });
              toast(u.disabled ? 'Enabled' : 'Disabled — sessions ended');
              route();
            } catch (err) {
              toast(err.message, 'bad');
            }
          });
          actions.append(toggle);
        }

        return [
          el('span', 'fw-semibold', u.email),
          { text: u.role, className: 'small' },
          gwrap,
          { text: u.last_login_at ? ago(u.last_login_at) : 'never', className: 'kd-faint small' },
          actions,
        ];
      }),
    ),
  );
  root.append(c.card);

  // ── Add user ──
  const add = card('Add someone', 'user-plus');
  const row = el('div', 'row g-2');

  const mk = (ph, type, cls) => {
    const col = el('div', cls);
    const i = el('input', 'form-control form-control-sm');
    i.placeholder = ph;
    i.type = type;
    col.append(i);
    row.append(col);
    return i;
  };

  const email = mk('email@example.com', 'email', 'col-12 col-md-4');
  const name = mk('Name (optional)', 'text', 'col-12 col-md-3');
  const password = mk('Password — 10+ characters', 'text', 'col-12 col-md-3');

  const roleCol = el('div', 'col-12 col-md-2');
  const role = el('select', 'form-select form-select-sm');
  for (const r of ['viewer', 'app_admin', 'admin', 'owner']) {
    const o = el('option', null, r);
    o.value = r;
    role.append(o);
  }
  role.value = 'app_admin';
  roleCol.append(role);
  row.append(roleCol);

  add.body.append(row);

  const hint = el('div', 'kd-faint small mt-2',
    'app_admin sees only the apps you grant. admin sees every app but cannot manage the team. owner can do everything.');
  add.body.append(hint);

  const create = el('button', 'btn btn-sm btn-primary mt-2', 'Create account');
  create.type = 'button';
  create.addEventListener('click', async () => {
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          email: email.value.trim(),
          name: name.value.trim() || null,
          password: password.value,
          role: role.value,
        }),
      });
      toast('Account created');
      route();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  add.body.append(create);
  root.append(add.card);

  return root;
}

async function grantDialog(user) {
  const slug = prompt(
    `Grant ${user.email} access to which app?\n\n` +
      overview.apps.map((a) => '· ' + a.slug).join('\n'),
  );
  if (!slug) return;

  try {
    await api(`/api/users/${user.id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ app: slug.trim().toLowerCase(), role: 'app_admin' }),
    });
    toast('Granted');
    route();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ── Config preview ──────────────────────────────────────────────────────────

/**
 * What the app will actually receive.
 *
 * The editor above changes rows in four tables; this is the one document they
 * add up to. Reading it back is the difference between "I set the field" and
 * "the app will see it".
 */
async function viewPreview(slug, platform) {
  const wrap = el('div');
  const { card: c, body } = card(`Preview — ${platform}`, 'scroll-text');

  body.append(el('div', 'ad-loading kd-faint small', 'Loading…'));
  wrap.append(c);

  try {
    const data = await api(`/api/apps/${slug}/preview/${platform}`);
    body.replaceChildren();

    for (const w of data.warnings ?? []) {
      const note = el('div', 'ad-warn d-flex align-items-start gap-2 mb-2');
      note.append(icon('circle-alert', 15));
      note.append(el('span', null, w));
      body.append(note);
    }

    const url = el('div', 'kd-faint small mb-2');
    url.append(el('span', null, 'GET '), el('code', null, data.url));
    body.append(url);

    const pre = el('pre', 'ad-json');
    pre.textContent = JSON.stringify(data.config, null, 2);
    body.append(pre);

    const copy = el('button', 'btn btn-sm btn-outline-secondary mt-2', 'Copy JSON');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(data.config, null, 2));
        toast('Copied');
      } catch {
        // Clipboard access is refused in some contexts; selecting the text is
        // still possible, so this is a note rather than a failure.
        toast('Select the text and copy manually', 'err');
      }
    });
    body.append(copy);
  } catch (err) {
    body.replaceChildren(el('div', 'ad-empty', err.message));
  }

  return wrap;
}

// ── Schedule ────────────────────────────────────────────────────────────────

async function viewSchedule() {
  const wrap = el('div');
  const { schedule } = await api('/api/schedule');

  const pending = schedule.filter((s) => !s.applied_at);
  const done = schedule.filter((s) => s.applied_at);

  // ── New ──
  const { card: form, body: fb } = card('Schedule a change', 'history');

  const grid = el('div', 'row g-2');

  const appSel = el('select', 'form-select form-select-sm');
  for (const a of overview.apps) {
    const o = el('option', null, a.name);
    o.value = a.slug;
    appSel.append(o);
  }

  const platSel = el('select', 'form-select form-select-sm');
  for (const p of ['ios', 'android']) {
    const o = el('option', null, p);
    o.value = p;
    platSel.append(o);
  }

  const whatSel = el('select', 'form-select form-select-sm');
  for (const [value, label] of [
    ['ads-off', 'Turn ads OFF'],
    ['ads-on', 'Turn ads ON'],
    ['test-on', 'Test ads ON'],
    ['test-off', 'Test ads OFF'],
    ['maint-on', 'Maintenance ON'],
    ['maint-off', 'Maintenance OFF'],
  ]) {
    const o = el('option', null, label);
    o.value = value;
    whatSel.append(o);
  }

  const when = el('input', 'form-control form-control-sm');
  when.type = 'datetime-local';

  const note = el('input', 'form-control form-control-sm');
  note.placeholder = 'Why (optional)';

  for (const [label, control] of [
    ['App', appSel],
    ['Platform', platSel],
    ['Change', whatSel],
    ['When', when],
    ['Note', note],
  ]) {
    const col = el('div', 'col-12 col-md');
    col.append(el('label', 'form-label small kd-faint', label), control);
    grid.append(col);
  }

  fb.append(grid);

  const add = el('button', 'btn btn-sm btn-primary mt-2', 'Schedule');
  add.addEventListener('click', async () => {
    const map = {
      'ads-off': { adsEnabled: false },
      'ads-on': { adsEnabled: true },
      'test-on': { testAds: true },
      'test-off': { testAds: false },
      'maint-on': { maintenance: true },
      'maint-off': { maintenance: false },
    };

    if (!when.value) return toast('Pick a time', 'err');

    add.disabled = true;
    try {
      await api('/api/schedule', {
        method: 'POST',
        body: JSON.stringify({
          appSlug: appSel.value,
          platform: platSel.value,
          kind: 'platform',
          // datetime-local has no zone; the browser's own offset is what the
          // person filling it in meant.
          runAt: new Date(when.value).toISOString(),
          payload: map[whatSel.value],
          note: note.value || null,
        }),
      });
      toast('Scheduled');
      route();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      add.disabled = false;
    }
  });
  fb.append(add);
  wrap.append(form);

  // ── Pending ──
  const { card: p, body: pb } = card('Pending', 'refresh-cw');
  pb.append(
    table(
      ['When', 'App', 'Change', 'By', ''],
      pending.map((s) => {
        const cancel = el('button', 'btn btn-sm btn-outline-danger', 'Cancel');
        cancel.addEventListener('click', async () => {
          try {
            await api('/api/schedule/' + s.id, { method: 'DELETE' });
            toast('Cancelled');
            route();
          } catch (err) {
            toast(err.message, 'err');
          }
        });

        return [
          new Date(s.run_at).toLocaleString(),
          s.app_slug + (s.platform ? ' · ' + s.platform : ''),
          describeChange(s),
          { text: s.created_by ?? '—', className: 'kd-faint small' },
          cancel,
        ];
      }),
    ),
  );
  wrap.append(p);

  // ── History ──
  if (done.length) {
    const { card: h, body: hb } = card('Already applied', 'circle-check');
    hb.append(
      table(
        ['When', 'App', 'Change', 'Result'],
        done.slice(0, 20).map((s) => [
          new Date(s.applied_at).toLocaleString(),
          s.app_slug + (s.platform ? ' · ' + s.platform : ''),
          describeChange(s),
          s.error
            ? { text: s.error, className: 'text-danger small' }
            : { text: 'applied', className: 'kd-faint small' },
        ]),
      ),
    );
    wrap.append(h);
  }

  return wrap;
}

/** A schedule row in words rather than JSON. */
function describeChange(s) {
  const p = s.payload ?? {};
  if (s.kind === 'flag') return `flag ${p.key} = ${JSON.stringify(p.value)}`;

  const parts = [];
  if ('adsEnabled' in p) parts.push(p.adsEnabled ? 'ads on' : 'ads off');
  if ('testAds' in p) parts.push(p.testAds ? 'test ads on' : 'test ads off');
  if ('maintenance' in p) parts.push(p.maintenance ? 'maintenance on' : 'maintenance off');
  return parts.join(', ') || JSON.stringify(p);
}

// ── Alerts ──────────────────────────────────────────────────────────────────

async function viewAlerts() {
  const wrap = el('div');
  const { alerts } = await api('/api/alerts');

  const { card: c, body } = card('Where outage alerts go', 'circle-alert');

  body.append(
    el(
      'p',
      'kd-faint small',
      'A message is sent when a service changes state — down, and again when ' +
        'it recovers. A service that stays down is one message, not one a minute.',
    ),
  );

  body.append(
    table(
      ['Type', 'Chat', 'Last sent', 'Last error', ''],
      alerts.map((a) => {
        const del = el('button', 'btn btn-sm btn-outline-danger', 'Remove');
        del.addEventListener('click', async () => {
          try {
            await api('/api/alerts/' + a.id, { method: 'DELETE' });
            toast('Removed');
            route();
          } catch (err) {
            toast(err.message, 'err');
          }
        });

        return [
          a.kind,
          { text: a.chat_id ?? '—', className: 'kd-faint small' },
          { text: ago(a.last_sent_at), className: 'kd-faint small' },
          a.last_error
            ? { text: a.last_error, className: 'text-danger small' }
            : { text: '—', className: 'kd-faint small' },
          del,
        ];
      }),
    ),
  );

  // ── Add ──
  const row = el('div', 'row g-2 mt-2');

  const kind = el('select', 'form-select form-select-sm');
  for (const [v, l] of [['webhook', 'Webhook (Slack / Discord)'], ['telegram', 'Telegram']]) {
    const o = el('option', null, l);
    o.value = v;
    kind.append(o);
  }

  const target = el('input', 'form-control form-control-sm');
  target.placeholder = 'https://hooks.slack.com/… or a Telegram bot token';

  const chat = el('input', 'form-control form-control-sm');
  chat.placeholder = 'Telegram chat id';

  for (const [label, control] of [['Type', kind], ['Target', target], ['Chat id', chat]]) {
    const col = el('div', 'col-12 col-md');
    col.append(el('label', 'form-label small kd-faint', label), control);
    row.append(col);
  }
  body.append(row);

  const buttons = el('div', 'd-flex gap-2 mt-2');

  const add = el('button', 'btn btn-sm btn-primary', 'Add');
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/api/alerts', {
        method: 'POST',
        body: JSON.stringify({
          kind: kind.value,
          target: target.value.trim(),
          chatId: chat.value.trim() || null,
        }),
      });
      toast('Added');
      route();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      add.disabled = false;
    }
  });

  const test = el('button', 'btn btn-sm btn-outline-secondary', 'Send a test');
  test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const r = await api('/api/alerts/test', { method: 'POST' });
      toast(
        r.delivered
          ? `Delivered to ${r.delivered} destination(s)`
          : 'Nothing was delivered — check the errors above',
        r.delivered ? 'ok' : 'err',
      );
      route();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      test.disabled = false;
    }
  });

  buttons.append(add, test);
  body.append(buttons);
  wrap.append(c);

  return wrap;
}

// ── Account ─────────────────────────────────────────────────────────────────

async function viewAccount() {
  const wrap = el('div');
  const { card: c, body } = card('Change your password', 'shield');

  const current = el('input', 'form-control form-control-sm');
  current.type = 'password';
  current.autocomplete = 'current-password';

  const next = el('input', 'form-control form-control-sm');
  next.type = 'password';
  next.autocomplete = 'new-password';

  const again = el('input', 'form-control form-control-sm');
  again.type = 'password';
  again.autocomplete = 'new-password';

  const row = el('div', 'row g-2');
  for (const [label, control] of [
    ['Current password', current],
    ['New password', next],
    ['Repeat it', again],
  ]) {
    const col = el('div', 'col-12 col-md-4');
    col.append(el('label', 'form-label small kd-faint', label), control);
    row.append(col);
  }
  body.append(row);

  body.append(
    el(
      'p',
      'kd-faint small mt-2 mb-0',
      'At least 10 characters. Changing it signs out your other sessions.',
    ),
  );

  const save = el('button', 'btn btn-sm btn-primary mt-2', 'Change password');
  save.addEventListener('click', async () => {
    if (next.value !== again.value) return toast('The two new passwords differ', 'err');
    if (next.value.length < 10) return toast('At least 10 characters', 'err');

    save.disabled = true;
    try {
      const r = await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }),
      });
      toast(
        r.signedOutOtherSessions
          ? `Changed. Signed out ${r.signedOutOtherSessions} other session(s).`
          : 'Changed.',
      );
      current.value = next.value = again.value = '';
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
    }
  });
  body.append(save);

  wrap.append(c);
  return wrap;
}

/** The services whose settings the panel can edit. */
const SERVICES = ['brawl', 'skincraft', 'platform'];

// ── Service settings ────────────────────────────────────────────────────────

/**
 * The settings that used to be edited by SSH-ing in and opening .env.
 *
 * Each field shows whether it is set here or falling through to .env, because
 * that distinction is the whole question when something is not behaving as the
 * form says it should.
 */
async function viewSettings(service) {
  const wrap = el('div');
  const data = await api('/api/settings/' + service);

  $('pageTitle').textContent = data.name + ' settings';

  if (!data.encryptionReady) {
    const warn = el('div', 'ad-warn d-flex align-items-start gap-2 mb-3');
    warn.append(icon('circle-alert', 15));
    warn.append(
      el(
        'span',
        null,
        'SETTINGS_KEY is not set on platform-api, so secrets cannot be stored. ' +
          'Add it to /opt/platform-api/.env and restart. Everything else works.',
      ),
    );
    wrap.append(warn);
  }

  const tabs = el('div', 'd-flex gap-2 mb-3 flex-wrap');
  for (const s of SERVICES) {
    const b = el('a', 'btn btn-sm ' + (s === service ? 'btn-primary' : 'btn-outline-secondary'), s);
    b.href = '#/settings/' + s;
    tabs.append(b);
  }
  wrap.append(tabs);

  for (const group of data.groups) {
    if (!group.settings.length) continue;

    const { card: c, body } = card(group.title, 'settings');

    for (const spec of group.settings) {
      body.append(settingRow(service, spec));
    }

    wrap.append(c);
  }

  // ── History ──
  if (data.changes.length) {
    const { card: h, body: hb } = card('Recent changes', 'history');
    hb.append(
      table(
        ['When', 'Setting', 'Changed to', 'By'],
        data.changes.map((ch) => [
          { text: ago(ch.changed_at), className: 'kd-faint small' },
          { text: ch.key, className: 'small' },
          ch.is_secret
            ? { text: '(secret)', className: 'kd-faint small' }
            : {
                text: ch.new_value === null ? 'cleared' : JSON.stringify(ch.new_value),
                className: 'small',
              },
          { text: ch.changed_by ?? '—', className: 'kd-faint small' },
        ]),
      ),
    );
    wrap.append(h);
  }

  return wrap;
}

/** One field, with its state and its save and clear controls. */
function settingRow(service, spec) {
  const row = el('div', 'row g-2 align-items-end py-2 border-bottom');

  // ── Label ──
  const labelCol = el('div', 'col-12 col-md-4');
  labelCol.append(el('div', 'fw-semibold small', spec.label));

  const meta = el('div', 'kd-faint ad-meta');
  meta.append(el('span', null, spec.key));
  if (spec.restart) {
    meta.append(el('span', 'badge text-bg-light ms-1', 'restart'));
  }
  labelCol.append(meta);

  if (spec.help) labelCol.append(el('div', 'kd-faint ad-meta mt-1', spec.help));
  row.append(labelCol);

  // ── Control ──
  const inputCol = el('div', 'col-12 col-md-5');
  let input;

  if (spec.type === 'boolean') {
    input = el('select', 'form-select form-select-sm');
    for (const [v, l] of [['true', 'On'], ['false', 'Off']]) {
      const o = el('option', null, l);
      o.value = v;
      if (String(spec.value) === v) o.selected = true;
      input.append(o);
    }
  } else if (spec.type === 'select') {
    input = el('select', 'form-select form-select-sm');
    for (const opt of spec.options ?? []) {
      const o = el('option', null, opt);
      o.value = opt;
      if (spec.value === opt) o.selected = true;
      input.append(o);
    }
  } else {
    input = el('input', 'form-control form-control-sm');
    if (spec.type === 'number') {
      input.type = 'number';
      if (spec.min != null) input.min = String(spec.min);
      if (spec.max != null) input.max = String(spec.max);
    } else if (spec.type === 'secret') {
      input.type = 'password';
      input.autocomplete = 'new-password';
      // Never prefilled: the value has not been sent to this page, and a
      // placeholder that looks like a value invites saving the mask back.
      input.placeholder = spec.isSet ? spec.masked + ' — type a new value to replace' : 'Not set';
    }
    if (spec.type !== 'secret' && spec.value != null) input.value = String(spec.value);
  }

  inputCol.append(input);
  row.append(inputCol);

  // ── State and actions ──
  const actionCol = el('div', 'col-12 col-md-3 d-flex align-items-center gap-2');

  const state = el(
    'span',
    'ad-meta ' + (spec.isSet ? 'text-success' : 'kd-faint'),
    spec.isSet ? 'set here' : 'from .env',
  );
  actionCol.append(state);

  const save = el('button', 'btn btn-sm btn-outline-secondary ms-auto', 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api(`/api/settings/${service}/${spec.key}`, {
        method: 'POST',
        body: JSON.stringify({ value: input.value }),
      });
      toast(r.restart ? 'Saved — restart the service to apply' : 'Saved');
      route();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
    }
  });
  actionCol.append(save);

  if (spec.isSet) {
    const reset = el('button', 'btn btn-sm btn-link kd-faint p-0', 'reset');
    reset.title = 'Remove this override and fall back to .env';
    reset.addEventListener('click', async () => {
      try {
        await api(`/api/settings/${service}/${spec.key}`, { method: 'DELETE' });
        toast('Reset to the .env value');
        route();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    actionCol.append(reset);
  }

  row.append(actionCol);
  return row;
}

// ── Routing ─────────────────────────────────────────────────────────────────

const TITLES = {
  home: 'Dashboard',
  services: 'Services',
  audit: 'Audit log',
  users: 'Team',
  schedule: 'Scheduled changes',
  settings: 'Settings',
  alerts: 'Alerts',
  account: 'Your account',
};

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const view = $('view');

  // Mark the active nav entry before awaiting, so the click feels instant.
  for (const link of document.querySelectorAll('.ad-nav-link')) {
    link.classList.toggle('is-active', link.getAttribute('href') === '#' + hash);
  }

  try {
    if (hash.startsWith('/app/')) {
      const slug = decodeURIComponent(hash.slice(5));
      $('pageTitle').textContent = slug;
      view.replaceChildren(await viewApp(slug));
    } else if (hash.startsWith('/preview/')) {
      const [, , slug, platform] = hash.split('/');
      $('pageTitle').textContent = slug + ' preview';
      view.replaceChildren(await viewPreview(slug, platform));
    } else if (hash.startsWith('/settings')) {
      const service = hash.split('/')[2] || SERVICES[0];
      view.replaceChildren(await viewSettings(service));
    } else if (hash === '/schedule') {
      $('pageTitle').textContent = TITLES.schedule;
      view.replaceChildren(await viewSchedule());
    } else if (hash === '/alerts') {
      $('pageTitle').textContent = TITLES.alerts;
      view.replaceChildren(await viewAlerts());
    } else if (hash === '/account') {
      $('pageTitle').textContent = TITLES.account;
      view.replaceChildren(await viewAccount());
    } else if (hash === '/services') {
      $('pageTitle').textContent = TITLES.services;
      view.replaceChildren(await viewServices());
    } else if (hash === '/audit') {
      $('pageTitle').textContent = TITLES.audit;
      view.replaceChildren(await viewAudit());
    } else if (hash === '/users') {
      $('pageTitle').textContent = TITLES.users;
      view.replaceChildren(await viewUsers());
    } else {
      $('pageTitle').textContent = TITLES.home;
      view.replaceChildren(viewHome());
    }
  } catch (err) {
    view.replaceChildren(el('div', 'ad-empty', err.message));
  }
}

function renderAppNav() {
  const nav = $('appNav');
  nav.replaceChildren(
    ...overview.apps.map((a) => {
      const link = el('a', 'ad-nav-link');
      link.href = '#/app/' + a.slug;
      link.append(icon('smartphone'), el('span', null, a.name));
      return link;
    }),
  );
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function refresh() {
  const spin = $('refreshIcon');
  spin.classList.add('spin');
  try {
    overview = await api('/api/overview');
    renderAppNav();
    $('lastUpdated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    spin.classList.remove('spin');
  }
}

async function boot() {
  try {
    // Fetched without a CSRF header — GET is exempt, and this is where the
    // token comes from in the first place.
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) return location.replace('/login');
    me = await res.json();
    csrf = me.csrf;
  } catch {
    return location.replace('/login');
  }

  $('userEmail').textContent = me.email;
  $('userRole').textContent = me.role;

  // Hidden *and* enforced server-side. Hiding alone stops nobody who opens
  // devtools; the API checks the role on every request regardless.
  if (!me.can.manageAllApps) {
    for (const n of document.querySelectorAll('[data-admin-only]')) n.remove();
  }
  if (!me.can.manageUsers) {
    for (const n of document.querySelectorAll('[data-owner-only]')) n.remove();
  }

  await refresh();
  await route();
}

window.addEventListener('hashchange', route);
$('refresh').addEventListener('click', async () => {
  await refresh();
  await route();
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrf },
  });
  location.replace('/login');
});
$('menuToggle')?.addEventListener('click', () => $('sidebar').classList.toggle('open'));

boot();
