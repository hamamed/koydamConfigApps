import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { challengePage, formatDuration, parseChallenge, parseLevelNumber } from '../src/challenge.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';
import { challengeRouter } from '../src/routes/challenge.js';
import { createSiteSettings, readAppStoreUrl } from '../src/site-settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AASA = { applinks: { details: [{ appIDs: ['652935W544.koydam.wasla.crosswords'], components: [{ '/': '/c/*' }] }] } };

test('level numbers are plain positive integers', () => {
  assert.equal(parseLevelNumber('3'), 3);
  for (const raw of ['0', '03', '-1', '3.0', '1e2', 'abc', '', undefined, '12345678']) assert.equal(parseLevelNumber(raw), null, String(raw));
});

test('t is 1–86399 seconds and s is 0–3 stars, written exactly, else ignored', () => {
  assert.deepEqual(parseChallenge({ t: '80', s: '3' }), { seconds: 80, stars: 3 });
  assert.deepEqual(parseChallenge({ t: '86399', s: '0' }), { seconds: 86399, stars: 0 });
  assert.deepEqual(parseChallenge({}), { seconds: null, stars: null });
  for (const t of ['0', '86400', '-5', '1.5', '080', 'abc', '']) assert.equal(parseChallenge({ t }).seconds, null, t);
  for (const s of ['4', '-1', '2.0', '02', 'x', '']) assert.equal(parseChallenge({ s }).stars, null, s);
  assert.deepEqual(parseChallenge({ t: ['80', '90'], s: ['1'] }), { seconds: null, stars: null });
});

test('durations read m:ss, or h:mm:ss past an hour', () => {
  assert.equal(formatDuration(80), '1:20');
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('the page carries the contract title and both links with only valid parameters', () => {
  const page = challengePage({ level: 3, seconds: 80, stars: 2, publicUrl: 'https://wassla.hamaprojects.com' });
  assert.equal(page.title, 'تحداك صديق: حل لغز رقم 3 في 1:20 — هل تستطيع أسرع؟');
  assert.equal(page.url, 'https://wassla.hamaprojects.com/c/3?t=80&s=2');
  assert.equal(page.appUrl, 'wasla://c/3?t=80&s=2');
  const bare = challengePage({ level: 3, seconds: null, stars: null, publicUrl: 'https://x' });
  assert.equal(bare.appUrl, 'wasla://c/3');
  assert.equal(bare.title, 'تحداك صديق: حل لغز رقم 3 — هل تستطيع؟');
});

test('the App Store link must be https; empty clears it; the panel value beats the environment', () => {
  assert.equal(readAppStoreUrl('').value, '');
  assert.ok(readAppStoreUrl('http://apps.apple.com/app/id1').error);
  assert.ok(readAppStoreUrl('not a url').error);
  const settings = createSiteSettings(openDatabase(':memory:'), { envAppStoreUrl: 'https://apps.apple.com/app/id111' });
  assert.equal(settings.appStoreUrl(), 'https://apps.apple.com/app/id111');
  assert.equal(settings.saveAppStoreUrl('https://apps.apple.com/app/id222').error, undefined);
  assert.equal(settings.appStoreUrl(), 'https://apps.apple.com/app/id222');
  settings.saveAppStoreUrl('');
  assert.equal(settings.appStoreUrl(), 'https://apps.apple.com/app/id111');
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

let server;
let base;
let siteSettings;

before(() => {
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  for (let n = 0; n < 2; n++) {
    const ids = [['مصر', 'x'], ['مرس', 'y']].map(([answer, clue]) => repo.createQuestion({ title: 'عام', answer: n ? `${answer}ي` : answer, clue }).question.id);
    const level = repo.createLevel();
    repo.setLevelQuestions(level.id, ids);
    if (n === 0) assert.equal(repo.setPublished(level.id, true).error, undefined);
  }
  siteSettings = createSiteSettings(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.use(challengeRouter({ repo, publicUrl: 'https://wassla.hamaprojects.com', siteSettings, assetVersion: '1' }));
  app.use((_req, res) => res.status(404).send('fallthrough'));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('both association paths serve the exact JSON, as application/json, cacheable, no redirect', async () => {
  for (const p of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    const res = await fetch(`${base}${p}`, { redirect: 'manual' });
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    assert.deepEqual(await res.json(), AASA);
  }
});

test('a published level gets the landing page with preview tags and both buttons', async () => {
  siteSettings.saveAppStoreUrl('https://apps.apple.com/app/id123');
  const res = await fetch(`${base}/c/1?t=80&s=3`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /<meta property="og:title" content="تحداك صديق: حل لغز رقم 1 في 1:20 — هل تستطيع أسرع؟">/);
  assert.match(html, /<meta property="og:description" content="[^"]+">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/wassla.hamaprojects.com\/c\/1\?t=80&amp;s=3">/);
  assert.match(html, /<meta name="twitter:title" content="تحداك صديق/);
  assert.match(html, /href="wasla:\/\/c\/1\?t=80&amp;s=3">افتح في شبّك</);
  assert.match(html, /href="https:\/\/apps.apple.com\/app\/id123"/);
});

test('the App Store button is hidden without a link, and bad parameters are dropped', async () => {
  siteSettings.saveAppStoreUrl('');
  const html = await (await fetch(`${base}/c/1?t=abc&s=9`)).text();
  assert.doesNotMatch(html, /App Store/);
  assert.match(html, /href="wasla:\/\/c\/1">/);
  assert.match(html, /og:title" content="تحداك صديق: حل لغز رقم 1 — هل تستطيع؟"/);
});

test('an unknown, unpublished or malformed level is a friendly 404 page', async () => {
  for (const p of ['/c/2', '/c/999', '/c/0', '/c/abc', '/c/01']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
    assert.match(await res.text(), /لم نجد هذا اللغز/, p);
  }
});
