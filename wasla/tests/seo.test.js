import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SITE_PAGES, landingJsonLd, robotsTxt, sitemapXml } from '../src/seo.js';

const BASE = 'https://chabbek.com';

test('the sitemap lists every public page at its absolute address, and nothing else', () => {
  const xml = sitemapXml(BASE);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, SITE_PAGES.map((p) => `${BASE}${p.path}`));
  assert.ok(locs.includes(`${BASE}/`));
  assert.doesNotMatch(xml, /admin|api/);
});

test('robots.txt keeps crawlers out of the panel and API and points at the sitemap', () => {
  const txt = robotsTxt(BASE);
  assert.match(txt, /^User-agent: \*$/m);
  assert.match(txt, /^Disallow: \/admin$/m);
  assert.match(txt, /^Disallow: \/api\/$/m);
  assert.match(txt, /^Sitemap: https:\/\/chabbek.com\/sitemap.xml$/m);
  // Stylesheets, scripts and pictures stay crawlable: Google renders the page with them.
  assert.doesNotMatch(txt, /Disallow: \/assets/);
});

test('the landing page structured data describes the site, the app and who makes it', () => {
  const data = JSON.parse(landingJsonLd({ base: BASE, description: 'وصف', appStoreUrl: '' }));
  assert.equal(data['@context'], 'https://schema.org');
  const byType = Object.fromEntries(data['@graph'].map((n) => [n['@type'], n]));
  assert.equal(byType.WebSite.url, `${BASE}/`);
  assert.equal(byType.Organization.name, 'Koydam');
  const app = byType.MobileApplication;
  assert.equal(app.operatingSystem, 'iOS');
  assert.equal(app.applicationCategory, 'GameApplication');
  assert.equal(app.inLanguage, 'ar');
  assert.equal(app.offers.price, '0');
  assert.ok(app.screenshot.every((u) => u.startsWith(`${BASE}/assets/site/`)));
  // Never invented: a rating appears only once the store has real ones.
  assert.equal(app.aggregateRating, undefined);
  assert.equal(app.installUrl, undefined);
});

test('the store link joins the structured data once there is a listing', () => {
  const url = 'https://apps.apple.com/app/id123';
  const data = JSON.parse(landingJsonLd({ base: BASE, description: 'وصف', appStoreUrl: url }));
  const app = data['@graph'].find((n) => n['@type'] === 'MobileApplication');
  assert.equal(app.installUrl, url);
  assert.ok(app.sameAs.includes(url));
});

test('structured data cannot close its own script tag', () => {
  const json = landingJsonLd({ base: BASE, description: '</script><script>alert(1)</script>', appStoreUrl: '' });
  assert.doesNotMatch(json, /<\/script/i);
  assert.equal(JSON.parse(json)['@graph'].find((n) => n['@type'] === 'MobileApplication').description,
    '</script><script>alert(1)</script>');
});
