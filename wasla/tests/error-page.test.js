import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import ejs from 'ejs';

import { config } from '../src/config.js';
import { createPanelIcons } from '../src/panel-icons.js';

/**
 * The error page is rendered by the 404 handler, which sits outside the admin
 * router — so it only ever has what server.js puts on `app.locals`. It shares
 * the panel's head and foot, and those reach for more than the page does.
 *
 * This has broken twice: once on `assetVersion`, once on `icon`. Each time the
 * error page itself threw while rendering, and every missing file on the whole
 * service answered 500 instead of 404. So the locals are asserted here rather
 * than discovered in production.
 */

/** Exactly what src/server.js sets app-wide, and nothing else. */
function appLocals() {
  const icons = createPanelIcons();
  return {
    assetVersion: config.assetVersion,
    icon: (name, size) => icons.lucide(name, size),
  };
}

const render = (view, locals) => ejs.renderFile(path.join(config.root, 'views', view), locals, { async: false });

test('the 404 page renders with only the locals a public request has', async () => {
  const html = await render('error.ejs', {
    ...appLocals(),
    title: 'غير موجودة',
    status: 404,
    message: 'هذه الصفحة غير موجودة.',
    detail: null,
  });
  assert.match(html, /404/);
  assert.match(html, /هذه الصفحة غير موجودة/);
  // The foot's icon is what threw last time; it has to come out as markup.
  assert.match(html, /data-lucide="arrow-up"/);
});

test('the 500 page renders too, and keeps the stack out of production', async () => {
  const html = await render('error.ejs', {
    ...appLocals(),
    title: 'خطأ في الخادم',
    status: 500,
    message: 'حدث خطأ من جهتنا.',
    detail: null,
  });
  assert.match(html, /500/);
  assert.doesNotMatch(html, /at Object|\.js:\d+:\d+/, 'no stack reaches the page');
});
