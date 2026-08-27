import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';

import { currentUser } from '../auth.js';
import { safeRedirect } from './sso.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, '..', 'panel');
const ROOT = path.join(HERE, '..', '..');

/**
 * Serves the dashboard's HTML, CSS, JS and icons.
 *
 * Assets are public; the *data* behind them is not. There is nothing sensitive
 * in a stylesheet, and gating them would mean the login page could not style
 * itself — the browser sends no session cookie logic to a `<link>` decision.
 */
export const panelRouter = Router();

// ── Pages ───────────────────────────────────────────────────────────────────

/**
 * Never cache a response whose content depends on who is asking.
 *
 * Both pages below answer differently with and without a session: `/` is either
 * the dashboard or a redirect to the login. Without this a browser caches the
 * redirect and replays it after signing in - the cookie is set, the navigation
 * happens, and the login page comes straight back with no error shown, because
 * the server was never asked.
 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('Vary', 'Cookie');
  next();
}

panelRouter.get('/login', noStore, async (req, res) => {
  // Already signed in: skip the form and honour ?next=, which is how a panel
  // on another subdomain bounces someone here and gets them back.
  if (await currentUser(req)) {
    return res.redirect(safeRedirect(req.query.next) ?? '/');
  }
  res.sendFile(path.join(PANEL, 'login.html'));
});

panelRouter.get('/', noStore, async (req, res) => {
  if (!(await currentUser(req))) return res.redirect('/login');
  res.sendFile(path.join(PANEL, 'index.html'));
});

// ── Assets ──────────────────────────────────────────────────────────────────

/**
 * The shared design system.
 *
 * Served from deploy/shared/css rather than a copy under src/panel, because
 * that directory is the single source every panel on this box is deployed
 * from. A second copy here would be the one that drifted.
 */
panelRouter.use(
  '/panel/css',
  express.static(path.join(ROOT, 'deploy', 'shared', 'css'), {
    maxAge: '1h',
    fallthrough: false,
  }),
);

/**
 * The Koydam logo, from the same folder the stylesheet comes from.
 *
 * One copy for every panel on this box: the mark in each sidebar and the
 * lockup on the sign-in page are the same files the agency site serves, so
 * they cannot drift into three slightly different logos.
 */
panelRouter.use(
  '/panel/logo',
  express.static(path.join(ROOT, 'deploy', 'shared', 'logo'), {
    maxAge: '7d',
    fallthrough: false,
  }),
);

panelRouter.get('/panel/app.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(PANEL, 'app.js'));
});

panelRouter.get('/panel/login.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(PANEL, 'login.js'));
});

/**
 * Bootstrap, vendored.
 *
 * Served from this origin rather than a CDN because the panel runs under a
 * strict CSP — and because a dashboard that needs the public internet to
 * render is a dashboard you cannot use when the internet is the problem.
 */
panelRouter.get('/panel/vendor.css', (_req, res) => {
  res.type('text/css').sendFile(
    path.join(ROOT, 'node_modules', 'bootstrap', 'dist', 'css', 'bootstrap.min.css'),
  );
});

/**
 * Lucide icons as one inline sprite.
 *
 * A sprite rather than one request per glyph, and static symbols rather than
 * the Lucide runtime — that runtime rewrites the DOM from a script, which is a
 * dependency and an extra CSP surface for what is ultimately path data.
 */
const ICONS = [
  'layout-grid', 'smartphone', 'apple', 'server', 'gauge', 'flag', 'users',
  'user-plus', 'scroll-text', 'history', 'save', 'trash-2', 'refresh-cw',
  'circle-check', 'circle-alert', 'log-in', 'log-out', 'menu', 'chart-column',
  'plus', 'settings', 'shield', 'calendar-clock', 'bell', 'database', 'cpu',
];

let spriteCache = null;

panelRouter.get('/panel/icons.svg', async (_req, res) => {
  if (!spriteCache) {
    const dir = path.join(ROOT, 'node_modules', 'lucide-static', 'icons');
    const symbols = [];

    for (const name of ICONS) {
      try {
        const svg = await readFile(path.join(dir, `${name}.svg`), 'utf8');
        const inner = svg.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
        symbols.push(
          `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" ` +
            `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
            `stroke-linejoin="round">${inner}</symbol>`,
        );
      } catch {
        // A renamed icon costs one glyph, not the whole sprite.
        continue;
      }
    }

    spriteCache = `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
  }

  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(spriteCache);
});
