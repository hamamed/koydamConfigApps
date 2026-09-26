import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appAdsTxt } from '../src/app-ads.js';
import { siteHost } from '../src/middleware/site-host.js';

/**
 * AdMob checks the developer website named on the App Store listing for an
 * app-ads.txt that names this publisher; without it the app's ads are limited.
 */
test('app-ads.txt names this AdMob publisher as Google, direct, with Google\'s certification id', () => {
  const lines = appAdsTxt('ca-app-pub-5910154509514937~2951297666').trim().split('\n');
  assert.deepEqual(lines, ['google.com, pub-5910154509514937, DIRECT, f08c47fec0942fa0']);
});

test('no AdMob app id, no line: an empty file rather than a wrong one', () => {
  assert.equal(appAdsTxt(''), '');
  assert.equal(appAdsTxt('not an id'), '');
});

test('it is served on the site domain, where the App Store listing points', () => {
  const on = siteHost({ siteUrl: 'https://chabbek.com', publicUrl: 'https://wassla.hamaprojects.com' });
  let out = null;
  on({ method: 'GET', url: '/app-ads.txt', path: '/app-ads.txt', hostname: 'chabbek.com' },
    { redirect: (status, location) => { out = { status, location }; } }, () => { out = { next: true }; });
  assert.deepEqual(out, { next: true });
});
