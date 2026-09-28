import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createSiteSettings, readSocialUrl, SOCIAL_NETWORKS } from '../src/site-settings.js';

let settings;
beforeEach(() => { settings = createSiteSettings(openDatabase(':memory:')); });

test('the game\'s own pages: Facebook, Instagram and TikTok, none set to start with', () => {
  assert.deepEqual(SOCIAL_NETWORKS, ['facebook', 'instagram', 'tiktok']);
  assert.deepEqual(settings.socialLinks(), { facebook: '', instagram: '', tiktok: '' });
});

test('a link must be https and on that network\'s own site', () => {
  assert.equal(readSocialUrl('facebook', 'https://www.facebook.com/chabbek').value, 'https://www.facebook.com/chabbek');
  assert.equal(readSocialUrl('facebook', 'https://fb.com/chabbek').value, 'https://fb.com/chabbek');
  assert.equal(readSocialUrl('instagram', 'https://instagram.com/chabbek.game').value, 'https://instagram.com/chabbek.game');
  assert.equal(readSocialUrl('tiktok', 'https://www.tiktok.com/@chabbek').value, 'https://www.tiktok.com/@chabbek');
  assert.equal(readSocialUrl('facebook', '  ').value, '', 'empty clears it');
  for (const [network, raw] of [['facebook', 'http://facebook.com/x'], ['facebook', 'https://instagram.com/x'],
    ['instagram', 'https://evil-instagram.com/x'], ['tiktok', 'not a link'], ['facebook', 'https://facebook.com.evil.io/x']]) {
    assert.ok(readSocialUrl(network, raw).error, `${network}: ${raw}`);
  }
});

test('the three are saved together, or not at all', () => {
  assert.equal(settings.saveSocialLinks({ facebook: 'https://facebook.com/chabbek', instagram: 'https://instagram.com/chabbek', tiktok: '' }).error, undefined);
  assert.deepEqual(settings.socialLinks(), { facebook: 'https://facebook.com/chabbek', instagram: 'https://instagram.com/chabbek', tiktok: '' });
  assert.ok(settings.saveSocialLinks({ facebook: '', instagram: 'https://instagram.com/new', tiktok: 'https://example.com' }).error);
  assert.equal(settings.socialLinks().facebook, 'https://facebook.com/chabbek', 'a refused save changes nothing');
  settings.saveSocialLinks({ facebook: '', instagram: '', tiktok: '' });
  assert.deepEqual(settings.socialLinks(), { facebook: '', instagram: '', tiktok: '' });
});
