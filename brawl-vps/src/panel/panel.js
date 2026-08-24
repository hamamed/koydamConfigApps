// Panel rendering. Served as a file rather than inlined because helmet sets a
// strict Content-Security-Policy ('script-src self') and an inline script is
// blocked outright — the page rendered but the script silently never ran.
// Relaxing the CSP with unsafe-inline was the other option; a separate file
// keeps the policy strict everywhere.
//
// Deliberately unauthenticated: it contains rendering logic and no secrets.
//
// Authentication is the platform session cookie, set on .hamaprojects.com by
// config.hamaprojects.com. Nothing here reads or holds it — the browser
// attaches it, and the server resolves it.

const $ = (id) => document.getElementById(id);
const num = (n) => (n ?? 0).toLocaleString();
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');

function ago(iso) {
  if (!iso) return 'never';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return Math.max(0, Math.round(secs)) + 's ago';
  if (secs < 3600) return Math.round(secs / 60) + 'm ago';
  if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
  return Math.round(secs / 86400) + 'd ago';
}

function bytes(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' kB';
  return n + ' B';
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
//
// Everything from the server is rendered as a text node, never as HTML.
// Brawler, player and club names come from user-controlled upstream data, so
// building markup by concatenation here would be an XSS hole in a page that, by
// definition, only an administrator opens.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** An icon from the sprite. `<use>` needs the SVG namespace, so not el(). */
function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  // koydam's admin.css sizes .lucide; a size can still be forced per call.
  svg.setAttribute('class', 'lucide' + (className ? ' ' + className : ''));
  svg.setAttribute('width', className === 'icon-lg' ? 20 : 16);
  svg.setAttribute('height', className === 'icon-lg' ? 20 : 16);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function statTile(label, value, iconName, colClass) {
  const col = el('div', colClass ?? 'col-6 col-md-4 col-xl-2');
  const card = el('div', 'ad-card ad-kpi');

  const head = el('div', 'd-flex align-items-center gap-2 mb-2');
  if (iconName) head.append(icon(iconName));
  head.append(el('span', 'ad-kpi-label', label));

  card.append(head, el('div', 'ad-kpi-value', value));
  col.append(card);
  return col;
}

function pill(node, text, tone) {
  // ad-status carries its own colour per state, so the tone maps onto the
  // published/draft/archived trio the design system already defines.
  const cls = tone === 'ok' ? 'ad-status-published'
    : tone === 'bad' ? 'ad-status-archived'
    : tone === 'warn' ? 'ad-status-draft'
    : 'ad-status-draft';
  node.className = 'ad-status ' + cls;
  node.replaceChildren(
    icon(
      tone === 'ok' ? 'circle-check' : tone === 'bad' ? 'circle-alert' : 'clock',
    ),
    el('span', null, text),
  );
}

function emptyRow(tbody, colspan, text) {
  const tr = el('tr');
  const td = el('td', 'kd-faint small py-3', text);
  td.colSpan = colspan;
  tr.append(td);
  tbody.replaceChildren(tr);
}

// ── Fetching ────────────────────────────────────────────────────────────────

async function getJson(path) {
  const res = await fetch(path, { credentials: 'same-origin' });

  // The server bounces an unauthenticated request to the platform login with a
  // redirect; fetch follows it and lands on HTML. Reloading hands the browser
  // the same redirect, which is what actually sends the person to sign in.
  if (res.redirected || res.status === 401 || res.status === 403) {
    location.reload();
    throw new Error('signed out');
  }

  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/**
 * Pulls the icon sprite into this document.
 *
 * `<use href="#id">` only resolves against symbols in the same document, so the
 * sprite cannot simply be linked — it has to be injected. Injected as markup
 * from our own endpoint, which is static server-generated SVG and carries no
 * request data.
 */
async function loadSprite() {
  try {
    const res = await fetch('/panel-icons.svg');
    $('sprite').innerHTML = await res.text();
  } catch {
    // Icons are decoration. A failed sprite should cost glyphs, not the panel.
  }
}

// ── Sections ────────────────────────────────────────────────────────────────

function renderTotals(data) {
  const s = data.summary ?? {};
  const u = data.universe ?? {};

  $('totals').replaceChildren(
    statTile('Crawl runs', num(s.runs), 'activity'),
    statTile('Battle samples', num(s.samples), 'layers'),
    statTile('Samples · 24h', num(s.samples24h), 'clock'),
    statTile('Battles · 24h', num(u.battles24h), 'swords'),
    statTile('Players seen', num(s.players), 'users'),
    statTile('Full profiles', num(u.profiled), 'search'),
  );
}

function renderHeader(data) {
  const s = data.summary ?? {};
  const c = data.crawler ?? {};

  const dbOk = data.db?.ok;
  pill($('db-pill'), dbOk ? 'db ok' : 'db down', dbOk ? 'ok' : 'bad');

  pill(
    $('crawl-pill'),
    c.enabled ? 'every ' + c.intervalMinutes + 'm' : 'crawler off',
    c.enabled ? 'ok' : 'mute',
  );

  const failures = s.failures ?? 0;
  $('subtitle').textContent =
    'last success ' + ago(s.lastOk) +
    ' · ' + (failures ? failures + ' failed runs' : 'no failures') +
    ' · ' + (c.regions ?? []).join(', ');

  // The switchover from battle_samples to battle_players happens on its own
  // once the new tables have data, so this is the only place it is visible.
  const src = data.analyticsSource;
  if (src) {
    const onNew = src === 'battle_players';
    pill(
      $('source-pill'),
      onNew ? 'per-player data' : 'legacy data',
      onNew ? 'ok' : 'warn',
    );
  }

  const d = data.discovery ?? {};
  $('footer').textContent =
    'discovery ' + num(d.perCycle) + '/cycle · searched ' + num(d.searchedPerCycle) +
    ' · profiles ' + num(d.profilesPerCycle) +
    ' · battles kept ' + num(d.battleRetentionDays) + 'd' +
    ' · samples kept ' + num(d.retentionDays) + 'd' +
    ' · updated ' + new Date(data.now).toLocaleTimeString();
}

function renderRuns(runs) {
  const tbody = $('runs');
  if (!runs.length) return emptyRow(tbody, 5, 'No crawls recorded yet.');

  tbody.replaceChildren(
    ...runs.map((r) => {
      const tr = el('tr');
      tr.append(el('td', null, ago(r.started_at ?? r.startedAt)));

      const status = r.status ?? 'unknown';
      const td = el('td');
      const cls = status === 'ok' ? 'ad-status-published'
        : status === 'running' ? 'ad-status-draft'
        : 'ad-status-archived';
      const p = el('span', 'ad-status ' + cls, status);
      td.append(p);
      tr.append(td);

      tr.append(el('td', 'text-end', num(r.players_sampled ?? r.playersSampled)));
      tr.append(el('td', 'text-end', num(r.battles_analysed ?? r.battlesAnalysed)));

      const ms = r.duration_ms ?? r.durationMs;
      tr.append(el('td', 'text-end', ms ? Math.round(ms / 1000) + 's' : '—'));
      return tr;
    }),
  );
}

function renderUniverse(u) {
  const cards = [
    ['Searched', num(u.searched), 'search'],
    ['Discovered', num(u.discovered), 'users'],
    ['From rankings', num(u.ranked), 'trophy'],
    ['Queued to crawl', num(u.queued), 'list'],
    ['Trophy snapshots', num(u.snapshots), 'chart-column'],
    // Windowed rather than total: battle_players is heading for tens of
    // millions of rows and counting all of them would scan the table on every
    // refresh.
    ['Participants · 24h', num(u.participants24h), 'swords'],
  ];

  $('universe').replaceChildren(
    ...cards.map(([label, value, ic]) => statTile(label, value, ic, 'col-6')),
  );
}

function renderSizes(sizes, counts) {
  const tbody = $('sizes');
  if (!sizes.length) return emptyRow(tbody, 3, 'No tables yet.');

  tbody.replaceChildren(
    ...sizes.map((s) => {
      const tr = el('tr');
      tr.append(el('td', null, s.table));
      tr.append(el('td', 'text-end', bytes(Number(s.bytes))));

      // Prefer the real count over pg_class.reltuples, which reads -1 until a
      // table has been analysed — that is why the old panel showed -1 for the
      // newest tables.
      const live = counts?.[s.table];
      const shown = live
        ? num(live.rows) + (live.capped ? '+' : '')
        : Number(s.rows) >= 0
          ? num(s.rows)
          : '—';

      tr.append(el('td', 'text-end', shown));
      return tr;
    }),
  );
}

function renderStandings(rows) {
  const tbody = $('standings');
  if (!rows.length) return emptyRow(tbody, 4, 'No standings yet.');

  tbody.replaceChildren(
    ...rows.map((r, i) => {
      const tr = el('tr');
      tr.append(el('td', 'kd-muted', String(i + 1)));
      tr.append(el('td', null, r.brawler_name ?? r.name ?? '—'));

      const rate = r.win_rate ?? r.winRate;
      const td = el('td');
      const wrap = el('div', 'd-flex align-items-center gap-2');
      const meter = el('div', 'progress flex-grow-1');
      meter.style.height = '6px';
      const fill = el('div', 'progress-bar');
      // Scaled across 35–65%, where real win rates live. Against a 0–100% axis
      // every bar sits near the middle and the differences vanish.
      const v = rate == null ? 0 : ((rate - 0.35) / 0.3) * 100;
      fill.style.width = Math.max(2, Math.min(100, v)) + '%';
      meter.append(fill);
      wrap.append(meter, el('span', 'small', pct(rate)));
      td.append(wrap);
      tr.append(td);

      tr.append(el('td', 'text-end', num(r.decided ?? r.battles)));
      return tr;
    }),
  );
}

function renderMovers(movers) {
  const box = $('movers');
  if (!movers.length) {
    return box.replaceChildren(
      el('div', 'kd-faint small', 'Nothing recorded yet — this needs a week of crawls.'),
    );
  }

  box.replaceChildren(
    ...movers.map((m) => {
      const rising = (m.now ?? 0) >= (m.then ?? 0);
      const delta = ((m.now ?? 0) - (m.then ?? 0)) * 100;

      const col = el('div', 'col-6 col-md-4 col-xl-3');
      const card = el('div', 'ad-card ad-kpi d-flex align-items-center gap-2');
      card.append(icon(rising ? 'trending-up' : 'trending-down', 'icon-lg'));

      const body = el('div');
      body.append(el('div', 'fw-semibold', m.name ?? '—'));
      body.append(
        el(
          'div',
          'kd-faint small',
          pct(m.then) + ' → ' + pct(m.now) + ' · ' + num(m.decided) + ' battles',
        ),
      );
      card.append(body);
      card.append(
        el(
          'div',
          'ms-auto fw-bold',
          (delta >= 0 ? '+' : '') + delta.toFixed(1),
        ),
      );

      col.append(card);
      return col;
    }),
  );
}

// ── Table browser ───────────────────────────────────────────────────────────

let activeTable = null;

function renderPicker(tables, counts) {
  $('table-picker').replaceChildren(
    ...tables.map((t) => {
      const btn = el('button', 'btn btn-sm btn-outline-secondary');
      btn.type = 'button';
      // Bootstrap's own active state, so the selected table reads the same as
      // every other toggle in the design system.
      if (t.name === activeTable) {
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-primary');
      }

      btn.append(el('span', null, t.label));
      const c = counts?.[t.name];
      if (c) {
        btn.append(
          el('span', 'badge text-bg-light ms-1', num(c.rows) + (c.capped ? '+' : '')),
        );
      }

      btn.addEventListener('click', () => {
        activeTable = t.name;
        renderPicker(tables, counts);
        loadTable(t.name);
      });

      return btn;
    }),
  );
}

async function loadTable(name) {
  $('table-note').textContent = 'Loading ' + name + '…';

  try {
    const data = await getJson('/admin/table/' + encodeURIComponent(name));

    $('browse-head').replaceChildren(
      ...data.columns.map((c) => el('th', null, c)),
    );

    const body = $('browse-body');
    if (!data.rows.length) {
      emptyRow(body, Math.max(1, data.columns.length), 'This table is empty.');
    } else {
      body.replaceChildren(
        ...data.rows.map((row) => {
          const tr = el('tr');
          for (const col of data.columns) {
            const value = row[col];
            const td =
              value === null
                ? el('td', 'kd-faint fst-italic', 'null')
                : el('td', 'text-truncate', value);
            // The full value on hover, since long ones are clipped.
            if (value !== null) td.title = value;
            tr.append(td);
          }
          return tr;
        }),
      );
    }

    $('table-note').textContent =
      data.label + ' · newest ' + data.rows.length + ' rows';
  } catch (err) {
    $('table-note').textContent = 'Could not load ' + name + ': ' + err.message;
  }
}

// ── Poll ────────────────────────────────────────────────────────────────────

let firstLoad = true;

async function refresh() {
  const spinner = $('refresh-icon');
  spinner.classList.add('spin');

  try {
    const data = await getJson('/admin/data');

    renderHeader(data);
    renderTotals(data);
    renderRuns(data.runs ?? []);
    renderUniverse(data.universe ?? {});
    renderSizes(data.sizes ?? [], data.counts);
    renderStandings(data.standings ?? []);
    renderMovers(data.movers ?? []);

    const tables = data.tables ?? [];
    if (tables.length) {
      // Open on the first table so the browser shows something without a click,
      // but never re-select on a later poll — that would yank the operator back
      // whenever the timer fired.
      if (firstLoad && !activeTable) {
        activeTable = tables[0].name;
        loadTable(activeTable);
      }
      renderPicker(tables, data.counts);
    }

    firstLoad = false;
  } catch (err) {
    $('subtitle').textContent = 'Cannot reach the server: ' + err.message;
    pill($('db-pill'), 'offline', 'bad');
  } finally {
    spinner.classList.remove('spin');
  }
}

$('refresh').addEventListener('click', refresh);

loadSprite().then(refresh);

// Ten seconds: fast enough to watch a crawl land, slow enough that the counters
// are not doing arithmetic nobody is reading.
setInterval(refresh, 10_000);
