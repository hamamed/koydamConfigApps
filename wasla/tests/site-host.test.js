import assert from 'node:assert/strict';
import { test } from 'node:test';

import { siteHost } from '../src/middleware/site-host.js';

const SITE = 'https://chabbek.com';
const SERVICE = 'https://wassla.hamaprojects.com';

/** Runs the middleware for one request; `{ next: true }` or `{ status, location }`. */
function run(middleware, host, url, method = 'GET') {
  let out = null;
  const res = { redirect: (status, location) => { out = { status, location }; } };
  middleware({ method, url, path: url.split('?')[0], hostname: host }, res, () => { out = { next: true }; });
  return out;
}

const on = siteHost({ siteUrl: SITE, publicUrl: SERVICE });

test('the public pages move from the service domain to the site, keeping the query', () => {
  assert.deepEqual(run(on, 'wassla.hamaprojects.com', '/'), { status: 301, location: `${SITE}/` });
  assert.deepEqual(run(on, 'wassla.hamaprojects.com', '/privacy'), { status: 301, location: `${SITE}/privacy` });
  assert.deepEqual(run(on, 'wassla.hamaprojects.com', '/support?x=1'), { status: 301, location: `${SITE}/support?x=1` });
  assert.deepEqual(run(on, 'wassla.hamaprojects.com', '/credits'), { status: 301, location: `${SITE}/credits` });
});

test('the API, media, panel and challenge links stay on the service domain', () => {
  for (const url of ['/api/v1/config', '/media/questions/a.png', '/admin', '/admin/levels/1', '/c/3?t=40',
    '/.well-known/apple-app-site-association', '/assets/css/site.css', '/health']) {
    assert.deepEqual(run(on, 'wassla.hamaprojects.com', url), { next: true }, url);
  }
});

test('the site serves its pages and their assets', () => {
  for (const url of ['/', '/privacy', '/support', '/credits', '/assets/site/app-icon.png', '/favicon.ico', '/robots.txt']) {
    assert.deepEqual(run(on, 'chabbek.com', url), { next: true }, url);
  }
});

test('anything else asked of the site goes to the service domain', () => {
  assert.deepEqual(run(on, 'chabbek.com', '/admin/levels'), { status: 301, location: `${SERVICE}/admin/levels` });
  assert.deepEqual(run(on, 'chabbek.com', '/c/3?t=40'), { status: 301, location: `${SERVICE}/c/3?t=40` });
  assert.deepEqual(run(on, 'chabbek.com', '/api/v1/levels'), { status: 301, location: `${SERVICE}/api/v1/levels` });
});

test('www goes to the bare site domain', () => {
  assert.deepEqual(run(on, 'www.chabbek.com', '/privacy'), { status: 301, location: `${SITE}/privacy` });
});

test('a form post is never redirected, so it is not silently turned into a GET', () => {
  assert.deepEqual(run(on, 'wassla.hamaprojects.com', '/', 'POST'), { next: true });
});

test('with no site configured nothing moves', () => {
  const off = siteHost({ siteUrl: '', publicUrl: SERVICE });
  assert.deepEqual(run(off, 'wassla.hamaprojects.com', '/'), { next: true });
  assert.deepEqual(run(off, 'localhost', '/privacy'), { next: true });
});

test('an unknown host, such as a local run, is left alone', () => {
  assert.deepEqual(run(on, 'localhost', '/'), { next: true });
});
