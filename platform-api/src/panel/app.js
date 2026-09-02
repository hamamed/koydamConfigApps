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

        const open = el('a', 'btn btn-sm btn-kd-outline', 'Open');
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

/**
 * One app, in tabs.
 *
 * It used to be one column: two platform editors, flags, three messaging
 * cards, the store card and the history, all stacked. Everything was reachable
 * and nothing was findable — checking a review meant scrolling past every
 * field you could edit by accident on the way down.
 *
 * The tab lives in the URL rather than in a variable, so a link to an app's
 * store data stays a link to its store data, and a refresh does not drop you
 * back at the top of the config.
 */
const APP_TABS = [
  { id: 'config', label: 'Configuration', icon: 'smartphone' },
  { id: 'messaging', label: 'Messaging', icon: 'circle-alert' },
  { id: 'store', label: 'App Store', icon: 'apple' },
  { id: 'history', label: 'History', icon: 'history' },
];

async function viewApp(slug, tab) {
  const active = APP_TABS.some((t) => t.id === tab) ? tab : 'config';
  const detail = await api('/api/apps/' + encodeURIComponent(slug));
  const root = el('div');

  const head = el('div', 'd-flex align-items-center gap-2 mb-3');
  head.append(el('h2', 'kd-h4 mb-0', detail.name));
  head.append(el('span', 'kd-faint small', detail.slug));
  if (!detail.canEdit) {
    head.append(el('span', 'badge text-bg-light ms-2', 'read only'));
  }
  root.append(head);

  const tabs = el('ul', 'nav nav-tabs mb-3');
  for (const t of APP_TABS) {
    const li = el('li', 'nav-item');
    const a = el('a', 'nav-link' + (t.id === active ? ' active' : ''));
    a.href = '#/app/' + encodeURIComponent(slug) + '/' + t.id;
    a.append(icon(t.icon, 14), el('span', 'ms-1', t.label));
    li.append(a);
    tabs.append(li);
  }
  root.append(tabs);

  // Only the visible tab is built. The store tab is four calls to Apple, and
  // someone editing an ad unit should not be paying for them.
  if (active === 'config') {
    for (const platform of ['ios', 'android']) root.append(platformCard(detail, platform));
    root.append(flagsCard(detail));
  } else if (active === 'messaging') {
    root.append(announcementsCard(detail.slug));
    root.append(ratingCard(detail));
    root.append(releaseNotesCard(detail.slug));
  } else if (active === 'store') {
    root.append(appstoreCard(detail.slug));
  } else {
    root.append(versionsCard(detail));
  }

  return root;
}

// ── App Store Connect ───────────────────────────────────────────────────────

/**
 * What Apple knows about this app: its record, versions and their review
 * state, recent builds, TestFlight groups and customer reviews.
 *
 * Loaded after the page draws, like the other secondary cards, and for the
 * same reason with more force: this one is four round trips to Apple's API,
 * and the platform editors above are what someone came for.
 */
function appstoreCard(slug) {
  const c = card('App Store Connect', 'apple');
  const body = c.body;
  body.append(el('div', 'kd-faint small', 'Loading…'));

  const render = async () => {
    body.replaceChildren();

    let status;
    try {
      status = await api('/api/appstore/account');
    } catch (err) {
      body.append(el('div', 'kd-faint small', err.message));
      return;
    }

    if (!status.configured) {
      // One key covers every app, so there is nothing to set up here — the
      // card says where it is set instead of offering a second place to set it.
      const note = el('div', 'kd-faint small');
      note.append('No App Store Connect key yet. ');
      if (status.canEdit) {
        const link = el('a', null, 'Add one');
        link.href = '#/control';
        note.append(link, ' and every app is covered, including ones added later.');
      } else {
        note.append('An owner or admin can add one, which covers every app at once.');
      }
      body.append(note);
      return;
    }

    let data;
    try {
      data = await api('/api/apps/' + encodeURIComponent(slug) + '/appstore');
    } catch (err) {
      body.append(el('div', 'alert alert-warning py-2 mb-0 small', err.message));
      return;
    }

    // Icon beside the name, the way it appears on a phone.
    const identity = el('div', 'd-flex align-items-center gap-3 mb-3');
    if (data.icon?.ok && data.icon.url) {
      identity.append(storeImage(data.icon.url, data.app.name ?? slug, 56, 'rounded-3'));
    }
    const words = el('div');
    words.append(el('div', 'fw-semibold', data.app.name ?? slug));
    words.append(el('div', 'kd-faint small',
      [data.app.sku && 'SKU ' + data.app.sku, data.app.locale, 'Apple ID ' + data.app.id]
        .filter(Boolean).join(' · ')));
    identity.append(words);
    body.append(identity);

    section('Versions', data.versions, ['Version', 'State', 'Platform'],
      (v) => [v.version ?? '—', prettyState(v.state), v.platform ?? '—']);

    section('Builds', data.builds, ['Build', 'State', 'Uploaded'],
      (b) => [b.version ?? '—', prettyState(b.state), b.uploaded ? ago(b.uploaded) : '—']);

    section('TestFlight', data.testflight, ['Group', 'Public link'],
      (g) => [g.name ?? '—', g.publicLink ? 'yes' : 'no']);

    section('Reviews', data.reviews, ['Rating', 'Title', 'Where', 'When'],
      (r) => ['★'.repeat(r.rating ?? 0) || '—', r.title ?? '—', r.territory ?? '—',
              r.at ? ago(r.at) : '—']);

    screenshots(data.screenshots);
    listing(data.listing);

    /** Every screenshot set that has images, grouped by device. */
    function screenshots(block) {
      if (!block) return;
      body.append(el('div', 'fw-semibold small mt-3 mb-1', 'Screenshots'));

      if (!block.ok) {
        body.append(el('div', 'kd-faint small', block.error ?? 'Unavailable for this key.'));
        return;
      }
      if (!block.sets?.length) {
        body.append(el('div', 'kd-faint small',
          'None uploaded for this version yet.'));
        return;
      }

      for (const set of block.sets) {
        body.append(el('div', 'kd-faint small mt-2 mb-1', set.device));
        // Horizontal, because a phone set is ten portrait images and stacking
        // them would bury everything below.
        const strip = el('div', 'd-flex gap-2 overflow-auto pb-2');
        for (const shot of set.images) {
          const link = el('a');
          link.href = shot.full;
          link.target = '_blank';
          link.rel = 'noopener';
          link.append(storeImage(shot.thumb, shot.name ?? 'Screenshot', 120, 'rounded-2 border'));
          strip.append(link);
        }
        body.append(strip);
      }
    }

    /**
     * The store listing as written. Keywords first, because it is the field
     * people actually want to check and the only place it is visible outside
     * App Store Connect itself.
     */
    function listing(block) {
      if (!block) return;
      body.append(el('div', 'fw-semibold small mt-3 mb-1', 'Store listing'));

      if (!block.ok) {
        body.append(el('div', 'kd-faint small', block.error ?? 'Unavailable for this key.'));
        return;
      }
      if (!block.locales) {
        body.append(el('div', 'kd-faint small', 'No listing written yet.'));
        return;
      }

      const rows = [];
      if (block.keywords) {
        const tags = el('div', 'd-flex flex-wrap gap-1');
        for (const word of block.keywords.split(',').map((w) => w.trim()).filter(Boolean)) {
          tags.append(el('span', 'badge text-bg-light', word));
        }
        rows.push(['Keywords', tags]);
        rows.push([
          'Keyword length',
          { text: block.keywords.length + ' / 100 characters',
            className: block.keywords.length > 100 ? 'text-danger' : 'kd-faint' },
        ]);
      } else {
        rows.push(['Keywords', { text: 'none set', className: 'kd-faint' }]);
      }
      if (block.promotionalText) rows.push(['Promotional text', { text: block.promotionalText }]);
      if (block.whatsNew) rows.push(["What's new", { text: block.whatsNew }]);
      if (block.description) rows.push(['Description', { text: block.description }]);
      rows.push([
        'Locale',
        { text: (block.locale ?? '—') + (block.locales > 1 ? ' (of ' + block.locales + ')' : ''),
          className: 'kd-faint' },
      ]);

      body.append(table(['', ''], rows));
    }

    function section(title, block, headers, shape) {
      body.append(el('div', 'fw-semibold small mt-3 mb-1', title));

      // A section can legitimately be unavailable: sales needs a Finance role
      // and TestFlight needs App Manager, so a key scoped to read metadata
      // will fail some of these. Saying why beats an empty table.
      if (!block.ok) {
        body.append(el('div', 'kd-faint small', block.error ?? 'Unavailable for this key.'));
        return;
      }
      if (!block.items.length) {
        body.append(el('div', 'kd-faint small', 'Nothing yet.'));
        return;
      }
      body.append(table(headers, block.items.map(shape)));
    }
  };

  render();
  return c.card;
}

/**
 * An image from Apple's CDN, with a visible fallback.
 *
 * These load cross-origin, so they depend on img-src allowing mzstatic. If
 * that is ever wrong the browser drops the request with no error anyone would
 * notice, and the page would just look like an app with no screenshots — so a
 * failure says so in words instead.
 */
function storeImage(url, alt, width, className) {
  const wrap = el('span', 'd-inline-block');
  const img = el('img', className ?? null);
  img.src = url;
  img.alt = alt;
  img.width = width;
  // setAttribute, not the property: the IDL attribute reflects in browsers but
  // not in every DOM implementation, and a screenshot strip that eagerly loads
  // forty images is the one place this actually matters.
  img.setAttribute('loading', 'lazy');
  img.style.height = 'auto';
  img.addEventListener('error', () => {
    wrap.replaceChildren(el('span', 'kd-faint small', 'image blocked'));
  });
  wrap.append(img);
  return wrap;
}

/** APP_STORE_REVIEW_IN_PROGRESS is not a thing to show a person. */
function prettyState(state) {
  if (!state) return '—';
  return String(state).toLowerCase().replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

// ── App Store Connect account ───────────────────────────────────────────────

/**
 * The single key, for the whole estate.
 *
 * One page rather than a field on every app, because an App Store Connect key
 * is issued against an Apple team and lists every app that team owns. Per-app
 * keys would have meant pasting the same secret once per app and giving every
 * new app a setup step before it could show anything.
 */
/** State strings Apple returns, in the words a person would use. */
const STORE_STATE = {
  READY_FOR_SALE: ['Live', 'text-bg-success'],
  PREPARE_FOR_SUBMISSION: ['Not submitted', 'text-bg-light'],
  WAITING_FOR_REVIEW: ['Waiting for review', 'text-bg-warning'],
  IN_REVIEW: ['In review', 'text-bg-warning'],
  PENDING_DEVELOPER_RELEASE: ['Approved — release it', 'text-bg-primary'],
  PENDING_APPLE_RELEASE: ['Approved', 'text-bg-primary'],
  REJECTED: ['Rejected', 'text-bg-danger'],
  METADATA_REJECTED: ['Metadata rejected', 'text-bg-danger'],
  DEVELOPER_REJECTED: ['Withdrawn', 'text-bg-secondary'],
  INVALID_BINARY: ['Invalid binary', 'text-bg-danger'],
  PROCESSING_FOR_APP_STORE: ['Processing', 'text-bg-info'],
};

function stateBadge(state) {
  const [label, cls] = STORE_STATE[state] ?? [prettyState(state), 'text-bg-light'];
  return el('span', 'badge ' + cls, label);
}

/**
 * Every app's App Store standing on one page.
 *
 * The per-app card answers "how is this app doing"; this answers "is anything
 * waiting on me", which is the question you actually open a dashboard to ask.
 * So the top of the page is counts of things that need action — in review,
 * approved and waiting for a release, rejected — rather than a total of apps.
 */
async function viewAppstore() {
  const root = el('div');
  const status = await api('/api/appstore/account');

  if (!status.configured) {
    root.append(appstoreKeyCard(status, { intro: true }));
    return root;
  }

  const holder = el('div');
  holder.append(el('div', 'kd-faint small', 'Asking Apple…'));
  root.append(holder, appstoreKeyCard(status, { intro: false }));

  let data;
  try {
    data = await api('/api/appstore/dashboard');
  } catch (err) {
    holder.replaceChildren(el('div', 'alert alert-warning py-2 small', err.message));
    return root;
  }

  holder.replaceChildren();
  const apps = data.apps ?? [];
  const connected = apps.filter((a) => a.state === 'ok');

  // ── Counts worth acting on ────────────────────────────────────────────────
  const versionsOf = (a) => (a.versions?.ok ? a.versions.items : []);
  const stateOf = (a) => versionsOf(a)[0]?.state ?? null;

  const live = connected.filter((a) => stateOf(a) === 'READY_FOR_SALE').length;
  const inReview = connected.filter((a) =>
    ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(stateOf(a))).length;
  const actionable = connected.filter((a) =>
    ['PENDING_DEVELOPER_RELEASE', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']
      .includes(stateOf(a))).length;
  const processing = connected.reduce((n, a) =>
    n + (a.builds?.ok ? a.builds.items.filter((b) => b.state === 'PROCESSING').length : 0), 0);

  const allReviews = connected.flatMap((a) =>
    (a.reviews?.ok ? a.reviews.items : []).map((r) => ({ ...r, app: a.name, slug: a.slug })));
  const rated = allReviews.filter((r) => typeof r.rating === 'number');
  const average = rated.length
    ? (rated.reduce((n, r) => n + r.rating, 0) / rated.length).toFixed(1)
    : '—';

  const units = data.downloads ?? { ok: false };

  const kpis = el('div', 'row g-3 mb-1');
  const tiles = [
    ['Downloads · 7d', units.ok ? fmt(units.total) : '—', 'download'],
    ['Live on the App Store', String(live), 'circle-check'],
    ['In review', String(inReview), 'history'],
    ['Needs you', String(actionable), actionable ? 'circle-alert' : 'circle-check'],
    ['Average rating', average, 'chart-column'],
  ];
  for (const [label, value, ic] of tiles) {
    const col = el('div', 'col-6 col-xl');
    const c = el('div', 'ad-card ad-kpi');
    const top = el('div', 'd-flex align-items-center gap-2 mb-2');
    top.append(icon(ic, 17), el('span', 'ad-kpi-label', label));
    c.append(top, el('div', 'ad-kpi-value', value));
    col.append(c);
    kpis.append(col);
  }
  holder.append(kpis);

  const notes = el('div', 'mb-3');
  if (processing) {
    notes.append(el('div', 'kd-faint small',
      processing + (processing === 1 ? ' build is' : ' builds are') + ' still processing at Apple.'));
  }
  if (units.ok && units.topCountries?.length) {
    notes.append(el('div', 'kd-faint small',
      'Top countries: ' + units.topCountries.map(([c, n]) => c + ' ' + fmt(n)).join(' · ')));
  }
  if (!units.ok && units.error) {
    // Almost always the missing vendor number, which is a setting rather than
    // a fault — so it reads as a prompt, not an error.
    notes.append(el('div', 'kd-faint small', 'Downloads: ' + units.error));
  }
  holder.append(notes);

  // ── One row per app ───────────────────────────────────────────────────────
  const appsCard = card('Apps', 'apple');
  appsCard.body.classList.add('p-0');
  appsCard.body.append(
    table(
      ['App', 'Status', 'Version', 'Downloads · 7d', 'Latest build', 'TestFlight', ''],
      apps.map((a) => {
        const link = el('a', 'fw-semibold', a.name);
        link.href = '#/app/' + a.slug;

        if (a.state !== 'ok') {
          const why = {
            no_ios: 'No iOS bundle id',
            no_record: 'Not in App Store Connect',
          }[a.state] ?? (a.error ?? 'Unavailable');
          return [link, el('span', 'badge text-bg-light', why),
                  { text: '—', className: 'kd-faint' }, { text: '—', className: 'kd-faint' },
                  { text: '—', className: 'kd-faint' }, { text: '—', className: 'kd-faint' }, ''];
        }

        const version = versionsOf(a)[0];
        const build = a.builds?.ok ? a.builds.items[0] : null;
        const groups = a.testflight?.ok ? a.testflight.items.length : null;

        const open = el('a', 'btn btn-sm btn-kd-outline', 'Open');
        open.href = '#/app/' + a.slug;

        return [
          link,
          version ? stateBadge(version.state) : { text: '—', className: 'kd-faint' },
          { text: version?.version ?? '—' },
          typeof a.downloads === 'number'
            ? { text: fmt(a.downloads) }
            : { text: '—', className: 'kd-faint' },
          build
            ? { text: build.version + ' · ' + prettyState(build.state) }
            : { text: '—', className: 'kd-faint' },
          groups === null
            ? { text: 'no access', className: 'kd-faint' }
            : { text: groups ? String(groups) + ' group' + (groups === 1 ? '' : 's') : 'none',
                className: groups ? '' : 'kd-faint' },
          open,
        ];
      }),
    ),
  );
  holder.append(appsCard.card);

  // ── Reviews, newest first, across everything ──────────────────────────────
  const reviewsCard = card('Latest reviews', 'users');
  if (!allReviews.length) {
    reviewsCard.body.append(el('div', 'kd-faint small',
      connected.length
        ? 'No reviews yet. They appear once an app is live and someone writes one.'
        : 'No apps connected yet.'));
  } else {
    reviewsCard.body.classList.add('p-0');
    allReviews.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    reviewsCard.body.append(
      table(
        ['App', 'Rating', 'Review', 'Where', 'When'],
        allReviews.slice(0, 15).map((r) => [
          { text: r.app },
          { text: '★'.repeat(r.rating ?? 0).padEnd(5, '☆') },
          { text: r.title || r.body || '—' },
          { text: r.territory ?? '—' },
          { text: r.at ? ago(r.at) : '—', className: 'kd-faint' },
        ]),
      ),
    );
  }
  holder.append(reviewsCard.card);

  if (data.fetchedAt) {
    holder.append(el('div', 'kd-faint small mb-3', 'From Apple ' + ago(data.fetchedAt) + '.'));
  }

  return root;
}

/**
 * The key itself. Below the data once there is data — it is set once and then
 * never touched, so it should not be the first thing on the page forever.
 */
function appstoreKeyCard(status, { intro }) {
  const c = card('App Store Connect key', 'settings');

  if (intro) {
    c.body.append(el('p', 'kd-faint small',
      'One key for every app, now and later. It is issued against your Apple team, so any app '
      + 'with an iOS bundle id is covered the moment it is added — there is nothing to set per app.'));
  }

  if (!status.encryptionReady) {
    c.body.append(el('div', 'alert alert-warning py-2 small mb-0',
      'SETTINGS_KEY is not set, so the private key cannot be stored safely. Set it and restart.'));
    return c.card;
  }

  if (status.configured) {
    const head = el('div', 'd-flex align-items-center gap-2 mb-3 flex-wrap');
    head.append(el('span', 'badge text-bg-light', 'Key ' + status.keyId));
    head.append(el('span', 'kd-faint small', 'issuer ' + (status.issuerId ?? '—')));
    if (status.updatedAt) {
      head.append(el('span', 'kd-faint small',
        'saved ' + ago(status.updatedAt) + (status.updatedBy ? ' by ' + status.updatedBy : '')));
    }
    c.body.append(head);
  }

  if (!status.canEdit) {
    c.body.append(el('div', 'kd-faint small',
      status.configured ? 'Only an owner or admin can replace it.' : 'Only an owner or admin can set it.'));
    return c.card;
  }

  const details = el('details');
  if (!status.configured) details.open = true;
  details.append(el('summary', 'small fw-semibold',
    status.configured ? 'Replace the key' : 'Add a key'));

  const inner = el('div', 'pt-3');
  inner.append(el('p', 'kd-faint small',
    'App Store Connect → Users and Access → Integrations → App Store Connect API. '
    + 'App Manager role for TestFlight; Developer is enough for read-only. Apple lets you '
    + 'download the .p8 once, so keep your copy.'));

  const issuer = labelledInput('Issuer ID', status.issuerId ?? '', '69a6de7e-…', false);
  const keyId = labelledInput('Key ID', status.keyId ?? '', 'ABCD123456', false);
  inner.append(issuer.wrap, keyId.wrap);

  const keyLabel = el('label', 'form-label small fw-semibold mt-2', 'Private key (.p8 contents)');
  const key = el('textarea', 'form-control font-monospace');
  key.rows = 5;
  key.placeholder = status.configured
    ? 'Paste a new .p8 to replace the stored one'
    : '-----BEGIN PRIVATE KEY-----';
  inner.append(keyLabel, key);

  const vendor = labelledInput('Vendor number (sales only)', status.vendorNumber ?? '', '80123456', false);
  inner.append(vendor.wrap);
  inner.append(el('div', 'kd-faint small',
    'App Store Connect → Payments and Financial Reports. The vendor number is shown at the '
    + 'top left of that page — eight digits, starting with 8. You need Account Holder, Admin '
    + 'or Finance access to see it. Leave blank unless you want sales figures.'));

  const row = el('div', 'd-flex gap-2 mt-3');
  const save = el('button', 'btn btn-sm btn-primary', status.configured ? 'Replace key' : 'Save key');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/api/appstore/account', {
        method: 'PUT',
        body: JSON.stringify({
          issuerId: issuer.input.value.trim(),
          keyId: keyId.input.value.trim(),
          privateKey: key.value.trim(),
          vendorNumber: vendor.input.value.trim(),
        }),
      });
      toast('Key saved — every app is covered');
      route();
    } catch (err) {
      toast(err.message, 'bad');
      save.disabled = false;
    }
  });
  row.append(save);

  if (status.configured) {
    const remove = el('button', 'btn btn-sm btn-outline-danger', 'Remove');
    remove.addEventListener('click', async () => {
      if (!confirm('Remove the App Store Connect key? Every app loses its store data.')) return;
      try {
        await api('/api/appstore/account', { method: 'DELETE' });
        toast('Key removed');
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    row.append(remove);
  }

  inner.append(row);
  details.append(inner);
  c.body.append(details);
  return c.card;
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
              'btn btn-sm btn-kd-outline',
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

            const del = el('button', 'btn btn-sm btn-kd-danger', 'Delete');
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

  const add = el('button', 'btn btn-sm btn-kd mt-2', 'Publish banner');
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

    const save = el('button', 'btn btn-sm btn-kd-accent', 'Save');
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
            const del = el('button', 'btn btn-sm btn-kd-danger', 'Delete');
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

  const save = el('button', 'btn btn-sm btn-kd-accent mt-2', 'Save notes');
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

  const preview = el('a', 'btn btn-sm btn-kd-outline mt-3', 'Preview what the app receives');
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
      const rm = el('button', 'btn btn-sm btn-kd-danger py-0 px-1');
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

    const addBtn = el('button', 'btn btn-sm btn-kd', 'Add');
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
    const save = el('button', 'btn btn-sm btn-kd mt-3 d-flex align-items-center gap-2');
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
      const rm = el('button', 'btn btn-sm btn-kd-danger py-0 px-1');
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

    const addBtn = el('button', 'btn btn-sm btn-kd', 'Set');
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
          const btn = el('button', 'btn btn-sm btn-kd-outline', 'Restore');
          btn.type = 'button';

          // Two taps rather than a browser dialog. Restoring rewrites an app's
          // whole configuration, so it deserves a confirmation - but a native
          // dialog is the one thing on the page that cannot be styled, and it
          // reads as the panel having broken rather than as a question.
          let armed = false;
          const disarm = () => {
            armed = false;
            btn.textContent = 'Restore';
            btn.classList.remove('btn-kd-danger');
            btn.classList.add('btn-kd-outline');
          };

          btn.addEventListener('click', async () => {
            if (!armed) {
              armed = true;
              btn.textContent = 'Confirm restore';
              btn.classList.remove('btn-kd-outline');
              btn.classList.add('btn-kd-danger');
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

/**
 * Every archive on disk: how big, how old, and what the newest one holds.
 *
 * The dashboard badge answers "is there a recent backup". This answers the
 * question you ask on the day you actually need one — which archive to restore
 * from, and whether the thing you lost is inside it.
 */
async function viewBackups() {
  const inv = await api('/api/backups/inventory');
  const root = el('div');

  if (!inv.configured) {
    const c = card('Backups', 'database');
    c.body.append(el('p', 'kd-muted', `Nothing has ever run. Expected archives in ${inv.dir}.`));
    root.append(c.card);
    return root;
  }

  const newest = inv.archives[0] ?? null;
  const stale = !newest || newest.ageHours > inv.staleAfterHours;

  // Age first: it is the number that matters, and the one that goes wrong
  // silently.
  const head = card('Backups', 'database');
  head.body.append(
    el('div', 'd-flex flex-wrap gap-4', [
      backupStat('Archives', String(inv.archives.length)),
      backupStat('Newest', newest ? relativeAge(newest.ageHours) : 'never',
                 stale ? 'text-danger' : 'text-success'),
      backupStat('Newest size', newest ? bytesLabel(newest.sizeBytes) : '—'),
      backupStat('All archives', bytesLabel(inv.totalBytes)),
      inv.disk ? backupStat('Disk free', bytesLabel(inv.disk.freeBytes)) : null,
    ].filter(Boolean)),
  );
  if (stale) {
    head.body.append(el('p', 'text-danger small mb-0 mt-3',
      `Nothing newer than ${inv.staleAfterHours} hours. A backup that stopped running looks exactly like one that is working.`));
  }
  root.append(head.card);

  const list = card('What is on disk', 'history');
  list.body.classList.add('p-0');
  list.body.append(table(
    ['Archive', 'Taken', 'Age', 'Size'],
    inv.archives.map((a) => [
      { text: a.name, className: 'font-monospace small' },
      { text: a.at.slice(0, 16).replace('T', ' '), className: 'kd-muted small' },
      { text: relativeAge(a.ageHours),
        className: a.ageHours > inv.staleAfterHours ? 'small text-warning' : 'small' },
      { text: bytesLabel(a.sizeBytes) },
    ]),
  ));
  root.append(list.card);

  if (inv.contents) {
    const what = card('Inside the newest archive', 'layout-grid');
    what.body.classList.add('p-0');
    what.body.append(table(
      ['Contents', 'Files'],
      inv.contents.groups.map((g) => [
        { text: g.name, className: 'font-monospace small' },
        { text: g.files.toLocaleString() },
      ]),
    ));
    what.body.append(el('p', 'kd-faint small p-3 mb-0',
      `${inv.contents.fileCount.toLocaleString()} files in total. Databases are dumped rather than copied, so they restore consistently.`));
    root.append(what.card);
  }

  return root;
}

/** A labelled number for the summary row. */
function backupStat(label, value, tone) {
  return el('div', null, [
    el('div', `fs-5 fw-semibold ${tone ?? ''}`, value),
    el('div', 'kd-faint small', label),
  ]);
}

function bytesLabel(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function relativeAge(hours) {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
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

        const grant = el('button', 'btn btn-sm btn-kd-outline', 'Grant app');
        grant.type = 'button';
        grant.addEventListener('click', () => grantDialog(u));
        actions.append(grant);

        if (u.email !== me.email) {
          const toggle = el('button', 'btn btn-sm btn-kd-danger', u.disabled ? 'Enable' : 'Disable');
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

  const create = el('button', 'btn btn-sm btn-kd mt-2', 'Create account');
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

  body.append(el('div', 'kd-faint small', 'Loading…'));
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

    const copy = el('button', 'btn btn-sm btn-kd-outline mt-2', 'Copy JSON');
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

  const add = el('button', 'btn btn-sm btn-kd mt-2', 'Schedule');
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
        const cancel = el('button', 'btn btn-sm btn-kd-danger', 'Cancel');
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
        const del = el('button', 'btn btn-sm btn-kd-danger', 'Remove');
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

  const add = el('button', 'btn btn-sm btn-kd', 'Add');
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

  const test = el('button', 'btn btn-sm btn-kd-outline', 'Send a test');
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

  const save = el('button', 'btn btn-sm btn-kd mt-2', 'Change password');
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
const SERVICES = ['brawl', 'skincraft', 'minebox', 'fortnite', 'platform'];

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
    const b = el('a', 'btn btn-sm ' + (s === service ? 'btn-kd' : 'btn-kd-outline'), s);
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

  const save = el('button', 'btn btn-sm btn-kd-accent ms-auto', 'Save');
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
    const reset = el('button', 'btn btn-sm btn-kd-ghost p-0', 'reset');
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


// ── Host resources ──────────────────────────────────────────────────────────

/** Bytes, at the scale a person reads. */
function gb(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
}

/**
 * A labelled bar. The number and the picture together, because a percentage
 * alone does not say whether 80% is 8GB or 800MB.
 */
function meter(label, percent, detail, tone) {
  const wrap = el('div', 'mb-3');

  const top = el('div', 'd-flex align-items-baseline gap-2 mb-1');
  top.append(el('span', 'small fw-semibold', label));
  top.append(el('span', 'kd-faint ad-meta ms-auto', detail));
  wrap.append(top);

  const track = el('div', 'ad-meter');
  const fill = el('div', 'ad-meter-fill' + (tone ? ' ' + tone : ''));
  // Clamped: a load average can exceed 100% of a core, and a bar wider than
  // its track pushes the layout apart.
  fill.style.width = Math.min(100, Math.max(0, percent)) + '%';
  track.append(fill);
  wrap.append(track);

  return wrap;
}

/** warn above the first threshold, bad above the second. */
function tone(percent, warnAt, badAt) {
  if (percent >= badAt) return 'is-bad';
  if (percent >= warnAt) return 'is-warn';
  return '';
}

async function viewResources() {
  const root = el('div');
  const data = await api('/api/resources');

  // ── What needs attention, first ──
  for (const w of data.warnings ?? []) {
    const note = el('div', 'ad-warn d-flex align-items-start gap-2 mb-2' +
      (w.level === 'critical' ? ' is-critical' : ''));
    note.append(icon('circle-alert', 15));
    note.append(el('span', null, w.text));
    root.append(note);
  }

  if (!data.warnings?.length) {
    const ok = el('div', 'kd-faint small mb-3 d-flex align-items-center gap-2');
    ok.append(icon('circle-check', 15));
    ok.append(el('span', null, 'Everything is within its thresholds.'));
    root.append(ok);
  }

  // ── The three that matter ──
  const { card: headline, body } = card('This server', 'server');

  const cpuDetail = data.cpu.available
    ? `load ${data.cpu.load1.toFixed(2)} across ${data.cpu.cores} cores`
    : 'load average is not reported on this platform';
  body.append(
    meter('CPU', data.cpu.available ? data.cpu.percent : 0, cpuDetail,
      tone(data.cpu.percent, 70, 100)),
  );

  body.append(
    meter('Memory',
      data.memory.percent,
      `${gb(data.memory.used)} of ${gb(data.memory.total)} used` +
        (data.memory.approximate ? ' (approximate)' : ''),
      tone(data.memory.percent, 85, 92)),
  );

  for (const d of data.disks ?? []) {
    body.append(
      meter(`Disk · ${d.label}`, d.percent,
        `${gb(d.used)} of ${gb(d.total)} used · ${gb(d.free)} free`,
        tone(d.percent, 80, 90)),
    );
  }

  if (data.memory.swapTotal) {
    const usedSwap = data.memory.swapTotal - data.memory.swapFree;
    const pct = Math.round((usedSwap / data.memory.swapTotal) * 100);
    body.append(meter('Swap', pct, `${gb(usedSwap)} of ${gb(data.memory.swapTotal)}`,
      tone(pct, 50, 80)));
  }

  body.append(
    el('div', 'kd-faint ad-meta',
      `Up ${Math.round(data.uptimeSeconds / 86400)} days · measured ${ago(data.at)}`),
  );

  root.append(headline);

  // ── Per service ──
  if (data.services?.length) {
    const { card: c, body: sb } = card('Memory by service', 'layout-grid');
    sb.classList.add('p-0');
    sb.append(
      table(
        ['Service', 'State', { label: 'Memory', align: 'right' }, { label: 'PID', align: 'right' }],
        data.services.map((s) => [
          { text: s.label, className: 'fw-semibold small' },
          s.state === 'active'
            ? { text: 'running', className: 'kd-faint small' }
            : { text: s.state, className: 'text-danger small' },
          { text: gb(s.rss), align: 'right', className: 'small' },
          { text: String(s.pid), align: 'right', className: 'kd-faint ad-meta' },
        ]),
      ),
    );
    // Resident memory double-counts shared pages, so the column does not add
    // up to the host figure above and should not be presented as if it did.
    sb.append(
      el('div', 'kd-faint ad-meta px-3 py-2',
        'Resident memory per process. Shared pages are counted more than once, ' +
          'so these do not sum to the total above.'),
    );
    root.append(c);
  }

  // ── Databases ──
  if (data.databases?.length) {
    const { card: c, body: db } = card('Database sizes', 'database');
    db.classList.add('p-0');
    db.append(
      table(
        ['Database', { label: 'On disk', align: 'right' }],
        data.databases.map((d) => [
          { text: d.name, className: 'small' },
          { text: gb(d.bytes), align: 'right', className: 'small' },
        ]),
      ),
    );
    root.append(c);
  }

  return root;
}

// ── Routing ─────────────────────────────────────────────────────────────────

const TITLES = {
  home: 'Dashboard',
  backups: 'Backups',
  services: 'Services',
  audit: 'Audit log',
  users: 'Team',
  schedule: 'Scheduled changes',
  settings: 'Settings',
  resources: 'Server resources',
  alerts: 'Alerts',
  account: 'Your account',
  appstore: 'App Control',
};

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const view = $('view');

  // Mark the active nav entry before awaiting, so the click feels instant.
  //
  // Prefix, not equality: an app's page has tabs under it now, so #/app/x/store
  // has to keep the sidebar entry for #/app/x lit. The boundary check is what
  // stops #/app/skin also matching #/app/skincraft.
  for (const link of document.querySelectorAll('.ad-nav-link')) {
    const target = (link.getAttribute('href') ?? '').replace(/^#/, '');
    const active =
      target === hash ||
      (target !== '/' && hash.startsWith(target) && hash[target.length] === '/');
    link.classList.toggle('is-active', active);
  }

  try {
    if (hash.startsWith('/app/')) {
      const [, , rawSlug, tab] = hash.split('/');
      const slug = decodeURIComponent(rawSlug ?? '');
      $('pageTitle').textContent = slug;
      view.replaceChildren(await viewApp(slug, tab));
    } else if (hash.startsWith('/preview/')) {
      const [, , slug, platform] = hash.split('/');
      $('pageTitle').textContent = slug + ' preview';
      view.replaceChildren(await viewPreview(slug, platform));
    } else if (hash.startsWith('/settings')) {
      const service = hash.split('/')[2] || SERVICES[0];
      view.replaceChildren(await viewSettings(service));
    } else if (hash === '/resources') {
      $('pageTitle').textContent = TITLES.resources;
      view.replaceChildren(await viewResources());
    } else if (hash === '/schedule') {
      $('pageTitle').textContent = TITLES.schedule;
      view.replaceChildren(await viewSchedule());
    } else if (hash === '/alerts') {
      $('pageTitle').textContent = TITLES.alerts;
      view.replaceChildren(await viewAlerts());
    } else if (hash === '/control' || hash === '/appstore') {
      $('pageTitle').textContent = TITLES.appstore;
      view.replaceChildren(await viewAppstore());
    } else if (hash === '/account') {
      $('pageTitle').textContent = TITLES.account;
      view.replaceChildren(await viewAccount());
    } else if (hash === '/backups') {
      $('pageTitle').textContent = TITLES.backups;
      view.replaceChildren(await viewBackups());
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

  // One chip: the address, with the role as its tooltip. Two lines of identity
  // in the sidebar foot was the only thing there, and it is not a destination.
  $('userChip').textContent = me.email;
  $('userChip').title = me.role;

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
