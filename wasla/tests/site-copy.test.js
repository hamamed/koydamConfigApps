import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { config } from '../src/config.js';

/**
 * The app shows AdMob adverts and asks for tracking. The public pages once
 * promised neither, and a privacy policy that contradicts the app is an App
 * Store rejection and a breach of AdMob's terms. These read the templates
 * themselves, so the promise cannot quietly come back.
 */
const read = (file) => fs.readFileSync(path.join(config.root, 'views', file), 'utf8');

const NO_ADS = [/بلا إعلانات/, /لا إعلانات/, /no advertising/i, /no ads/i, /ad-free/i];

test('no public page claims the game has no adverts', () => {
  for (const file of ['site/landing.ejs', 'legal/privacy.ejs', 'legal/support.ejs']) {
    const text = read(file);
    for (const claim of NO_ADS) assert.doesNotMatch(text, claim, `${file} still says ${claim}`);
  }
});

test('the privacy policy names AdMob, the advertising identifier and the tracking choice, in both languages', () => {
  const policy = read('legal/privacy.ejs');
  const [arabic, english] = policy.split('lang="en"');
  assert.match(arabic, /Google AdMob/);
  assert.match(arabic, /معرّف الإعلانات/);
  assert.match(arabic, /التتبع/);
  assert.match(english, /Google AdMob/);
  assert.match(english, /advertising identifier/i);
  assert.match(english, /Allow Apps to Request to Track|tracking/i);
  assert.match(policy, /policies\.google\.com\/technologies\/partner-sites/);
});
