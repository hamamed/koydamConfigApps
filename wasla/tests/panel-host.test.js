import assert from 'node:assert/strict';
import { test } from 'node:test';

import { panelSignIn } from '../src/panel-host.js';

const SITE = 'https://chabbek.com';
const PLATFORM = 'https://config.hamaprojects.com';
const req = (hostname) => ({ hostname });

test('on the service domain the panel keeps the platform sign-on', () => {
  assert.equal(panelSignIn(req('wassla.hamaprojects.com'), { siteUrl: SITE, platformUrl: PLATFORM }), 'platform');
});

test('on the site domain it signs in with its own accounts: the platform cookie never reaches it', () => {
  assert.equal(panelSignIn(req('chabbek.com'), { siteUrl: SITE, platformUrl: PLATFORM }), 'local');
  assert.equal(panelSignIn(req('CHABBEK.COM'), { siteUrl: SITE, platformUrl: PLATFORM }), 'local');
  assert.equal(panelSignIn(req('www.chabbek.com'), { siteUrl: SITE, platformUrl: PLATFORM }), 'local');
});

test('without a platform, every domain uses its own accounts, as a local copy always has', () => {
  assert.equal(panelSignIn(req('wassla.hamaprojects.com'), { siteUrl: SITE, platformUrl: '' }), 'local');
  assert.equal(panelSignIn(req('localhost'), { siteUrl: '', platformUrl: '' }), 'local');
});

test('with no site domain set, nothing changes anywhere', () => {
  assert.equal(panelSignIn(req('chabbek.com'), { siteUrl: '', platformUrl: PLATFORM }), 'platform');
});
