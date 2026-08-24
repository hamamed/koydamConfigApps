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
  const t = el('div', 'ad-toast ' + kind);
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
  root.append(kpis, el('div', 'mb-3'));

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
  root.append(versionsCard(detail));
  return root;
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
  const maint = mkToggle('Maintenance mode', existing.maintenance ?? false);
  c.body.append(toggles);

  const maintMsg = labelledInput('Maintenance message', existing.maintenanceMessage, 'Back shortly…', ro);
  c.body.append(maintMsg.wrap);

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
          btn.addEventListener('click', async () => {
            if (!confirm('Restore this app to how it looked at ' + new Date(v.at).toLocaleString() + '?')) return;
            try {
              await api(`/api/apps/${encodeURIComponent(detail.slug)}/restore/${v.id}`, { method: 'POST' });
              toast('Restored');
              route();
            } catch (err) {
              toast(err.message, 'bad');
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

// ── Routing ─────────────────────────────────────────────────────────────────

const TITLES = { home: 'Dashboard', services: 'Services', audit: 'Audit log', users: 'Team' };

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const view = $('view');

  // Mark the active nav entry before awaiting, so the click feels instant.
  for (const link of document.querySelectorAll('.ad-nav-link')) {
    link.classList.toggle('active', link.getAttribute('href') === '#' + hash);
  }

  try {
    if (hash.startsWith('/app/')) {
      const slug = decodeURIComponent(hash.slice(5));
      $('pageTitle').textContent = slug;
      view.replaceChildren(await viewApp(slug));
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
