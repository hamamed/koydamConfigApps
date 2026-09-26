import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';
import { siteRouter } from '../src/routes/site.js';
import { createSiteSettings } from '../src/site-settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let db;
let siteSettings;
let server;
let base;

before(() => {
  db = openDatabase(':memory:');
  const repo = createRepository(db);
  siteSettings = createSiteSettings(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.use(siteRouter({ assetVersion: '1', siteSettings, repo }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const landing = async () => (await fetch(`${base}/`)).text();

test('the landing page answers at the root, in Arabic, and can be cached', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /max-age/);
  const html = await res.text();
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /شبّك/);
  assert.match(html, /لغز اليوم/);
});

test('a store badge is shown only while there is a listing to send someone to', async () => {
  let html = await landing();
  assert.doesNotMatch(html, /badge-app-store/, 'no App Store badge without a link');
  assert.doesNotMatch(html, /badge-google-play/, 'no Play badge without a link');
  assert.match(html, /قريباً على App Store/);
  assert.doesNotMatch(html, /Google Play/, 'no Android app: nothing is promised for Google Play');

  siteSettings.saveAppStoreUrl('https://apps.apple.com/app/id1234567890');
  html = await landing();
  assert.match(html, /badge-app-store\.svg/);
  assert.match(html, /https:\/\/apps\.apple\.com\/app\/id1234567890/);
  assert.doesNotMatch(html, /badge-google-play/, 'the Play badge waits for its own listing');

  siteSettings.savePlayUrl('https://play.google.com/store/apps/details?id=koydam.wasla');
  html = await landing();
  assert.match(html, /badge-google-play-ar\.png/, 'an Arabic page asks Google for its Arabic badge');
  assert.ok(html.indexOf('badge-app-store') < html.indexOf('badge-google-play'),
    'Apple asks for the App Store badge first in the lineup');
});

test('a link that is not https is refused, and clearing one takes its badge away', async () => {
  assert.ok(siteSettings.savePlayUrl('http://play.google.com/store').error, 'http is refused');
  assert.ok(siteSettings.savePlayUrl('not a url').error);
  assert.match(await landing(), /badge-google-play-ar\.png/, 'the stored link is untouched by a refused one');

  siteSettings.savePlayUrl('');
  assert.doesNotMatch(await landing(), /badge-google-play/);
  assert.doesNotMatch(await landing(), /Google Play/, 'and nothing is promised in its place');
});
