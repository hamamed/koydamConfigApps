import assert from 'node:assert/strict';
import { test } from 'node:test';

import { siteHost } from '../src/middleware/site-host.js';

const SITE = 'https://chabbek.com';
const OLD = 'wassla.hamaprojects.com';

/** Runs the middleware for one request; `{ next: true }` or `{ status, location }`. */
function run(middleware, host, url, method = 'GET') {
  let out = null;
  const res = { redirect: (status, location) => { out = { status, location }; } };
  middleware({ method, url, path: url.split('?')[0], hostname: host }, res, () => { out = { next: true }; });
  return out;
}

const on = siteHost({ siteUrl: SITE, legacyHosts: [OLD] });

test('the site domain serves everything: pages, the panel, the API, pictures, challenge links', () => {
  for (const url of ['/', '/privacy', '/support', '/credits', '/sitemap.xml', '/robots.txt', '/app-ads.txt',
    '/admin', '/admin/levels/1', '/api/v1/config', '/api/v1/levels/3', '/media/questions/a.png', '/media/audio/b.m4a',
    '/c/3?t=40', '/.well-known/apple-app-site-association', '/apple-app-site-association', '/assets/css/site.css', '/health']) {
    assert.deepEqual(run(on, 'chabbek.com', url), { next: true }, url);
  }
});

test('the old domain keeps working for the apps already out: API, pictures, panel, challenge links', () => {
  for (const url of ['/api/v1/config', '/media/questions/a.png', '/admin/levels', '/c/3?t=40',
    '/.well-known/apple-app-site-association', '/assets/css/site.css', '/health']) {
    assert.deepEqual(run(on, OLD, url), { next: true }, url);
  }
});

test('the old domain sends its public pages to the site, keeping the query', () => {
  assert.deepEqual(run(on, OLD, '/'), { status: 301, location: `${SITE}/` });
  assert.deepEqual(run(on, OLD, '/privacy'), { status: 301, location: `${SITE}/privacy` });
  assert.deepEqual(run(on, OLD, '/support?x=1'), { status: 301, location: `${SITE}/support?x=1` });
  assert.deepEqual(run(on, OLD, '/credits'), { status: 301, location: `${SITE}/credits` });
  assert.deepEqual(run(on, OLD, '/sitemap.xml'), { status: 301, location: `${SITE}/sitemap.xml` });
});

test('www goes to the bare site domain', () => {
  assert.deepEqual(run(on, 'www.chabbek.com', '/privacy'), { status: 301, location: `${SITE}/privacy` });
  assert.deepEqual(run(on, 'www.chabbek.com', '/api/v1/config'), { status: 301, location: `${SITE}/api/v1/config` });
});

test('a form post is never redirected, so it is not silently turned into a GET', () => {
  assert.deepEqual(run(on, OLD, '/', 'POST'), { next: true });
  assert.deepEqual(run(on, 'www.chabbek.com', '/api/v1/events', 'POST'), { next: true });
});

test('with no site configured nothing moves', () => {
  const off = siteHost({ siteUrl: '', legacyHosts: [OLD] });
  assert.deepEqual(run(off, OLD, '/'), { next: true });
  assert.deepEqual(run(off, 'localhost', '/privacy'), { next: true });
});

test('an unknown host, such as a local run, is left alone', () => {
  assert.deepEqual(run(on, 'localhost', '/'), { next: true });
});

test('the old domain is named, not guessed: a host not listed is left alone', () => {
  const none = siteHost({ siteUrl: SITE, legacyHosts: [] });
  assert.deepEqual(run(none, OLD, '/'), { next: true });
});

test('moving PUBLIC_URL to the site keeps the old domain listed, from LEGACY_HOSTS', async () => {
  const { config } = await import('../src/config.js');
  const saved = { legacy: process.env.LEGACY_HOSTS };
  const publicUrl = config.publicUrl;
  try {
    process.env.LEGACY_HOSTS = 'wassla.hamaprojects.com, Old.Example ';
    config.publicUrl = 'https://chabbek.com';
    config.siteUrl = 'https://chabbek.com';
    assert.deepEqual(config.legacyHosts.filter((h) => h !== 'chabbek.com'), ['wassla.hamaprojects.com', 'old.example']);
    const on = siteHost({ siteUrl: config.siteUrl, legacyHosts: config.legacyHosts });
    assert.deepEqual(run(on, 'wassla.hamaprojects.com', '/'), { status: 301, location: 'https://chabbek.com/' });
    assert.deepEqual(run(on, 'chabbek.com', '/'), { next: true }, 'the site is never its own old domain');
  } finally {
    if (saved.legacy === undefined) delete process.env.LEGACY_HOSTS; else process.env.LEGACY_HOSTS = saved.legacy;
    config.publicUrl = publicUrl;
    config.siteUrl = '';
  }
});
