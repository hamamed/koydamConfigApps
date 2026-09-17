import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';

import { createAppConfig } from '../src/app-config.js';
import { createDaily } from '../src/daily.js';
import { openDatabase } from '../src/db/index.js';
import { createDevices, readDeviceRegistration } from '../src/devices.js';
import { createEvents } from '../src/events.js';
import { createRepository } from '../src/repository.js';
import { apiRouter } from '../src/routes/api.js';

const DEVICE = '8a1f5b2e-3c4d-4e5f-9a0b-1c2d3e4f5a6b';
const OTHER = 'b2c3d4e5-0000-4000-8000-000000000000';
const TOKEN = 'ab'.repeat(32);

const valid = (over = {}) => ({ device: DEVICE, token: TOKEN, platform: 'ios', environment: 'production', enabled: true, locale: 'ar', ...over });

let db;
let devices;

beforeEach(() => {
  db = openDatabase(':memory:');
  devices = createDevices(db);
});

test('a registration needs a device id, a hex token, ios and an environment', () => {
  assert.deepEqual(readDeviceRegistration(valid()).registration, {
    device: DEVICE, token: TOKEN, platform: 'ios', environment: 'production', enabled: 1, locale: 'ar',
  });
  const bad = [
    null, [], 'x',
    valid({ device: 'short' }), valid({ device: 'has spaces in it' }),
    valid({ token: 'ab'.repeat(31) }), valid({ token: 'a'.repeat(201) }), valid({ token: 'zz'.repeat(32) }), valid({ token: 42 }),
    valid({ platform: 'android' }), valid({ platform: undefined }),
    valid({ environment: 'development' }), valid({ environment: undefined }),
    valid({ enabled: 'yes' }), valid({ enabled: 1 }),
    valid({ locale: 'arabic language' }), valid({ locale: 7 }),
  ];
  for (const body of bad) assert.ok(readDeviceRegistration(body).error, JSON.stringify(body));
});

test('tokens are stored lower-case, enabled defaults on, locale is optional', () => {
  const { registration } = readDeviceRegistration(valid({ token: 'AB'.repeat(100), enabled: undefined, locale: undefined }));
  assert.equal(registration.token, 'ab'.repeat(100));
  assert.equal(registration.enabled, 1);
  assert.equal(registration.locale, null);
  assert.equal(readDeviceRegistration(valid({ locale: 'en-US' })).registration.locale, 'en-US');
});

test('registering again updates the same row; enabled false keeps it but stops sends', () => {
  devices.register(readDeviceRegistration(valid()).registration);
  devices.register(readDeviceRegistration(valid({ environment: 'sandbox', enabled: false })).registration);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
  const row = devices.get(DEVICE);
  assert.deepEqual([row.environment, row.enabled], ['sandbox', false]);
  assert.deepEqual(devices.targets('all'), []);
  assert.deepEqual(devices.targets('device', DEVICE), []);
  assert.deepEqual(devices.counts(), { total: 1, enabled: 0, sandbox: 0, production: 0 });
});

test('a new token clears the failure history; the same token keeps it', () => {
  devices.register(readDeviceRegistration(valid()).registration);
  devices.markFailed(DEVICE, 'TooManyRequests');
  devices.register(readDeviceRegistration(valid()).registration);
  assert.deepEqual([devices.get(DEVICE).failures, devices.get(DEVICE).lastError], [1, 'TooManyRequests']);

  devices.register(readDeviceRegistration(valid({ token: 'cd'.repeat(32) })).registration);
  assert.deepEqual([devices.get(DEVICE).failures, devices.get(DEVICE).lastError], [0, null]);
});

test('a token registered by a new install id replaces the old install', () => {
  devices.register(readDeviceRegistration(valid()).registration);
  devices.register(readDeviceRegistration(valid({ device: OTHER })).registration);
  assert.deepEqual(devices.targets('all').map((d) => d.device), [OTHER]);
});

test('targets: all enabled, sandbox only, or one enabled device', () => {
  devices.register(readDeviceRegistration(valid()).registration);
  devices.register(readDeviceRegistration(valid({ device: OTHER, token: 'cd'.repeat(32), environment: 'sandbox' })).registration);

  assert.equal(devices.targets('all').length, 2);
  assert.deepEqual(devices.targets('sandbox').map((d) => d.device), [OTHER]);
  assert.deepEqual(devices.targets('device', DEVICE).map((d) => d.device), [DEVICE]);
  assert.deepEqual(devices.targets('device', 'nobody-here'), []);
  assert.deepEqual(devices.targets('everyone'), []);
  assert.deepEqual(devices.counts(), { total: 2, enabled: 2, sandbox: 1, production: 1 });

  devices.disable(DEVICE, 'Unregistered');
  assert.deepEqual(devices.targets('all').map((d) => d.device), [OTHER]);
  assert.equal(devices.get(DEVICE).lastError, 'Unregistered');
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

let server;
let base;
let httpDb;

before(async () => {
  httpDb = openDatabase(':memory:');
  const repo = createRepository(httpDb);
  const app = express();
  app.use('/api/v1', apiRouter({
    repo,
    publicUrl: 'https://wasla.example',
    daily: createDaily(httpDb, repo),
    appConfig: createAppConfig(httpDb),
    events: createEvents(httpDb, repo),
    devices: createDevices(httpDb),
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => server.close());

const post = (body) => fetch(`${base}/devices`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('POST /devices answers 204 and stores the device; bad input is a 400 with an error', async () => {
  const ok = await post(valid());
  assert.equal(ok.status, 204);
  assert.equal(await ok.text(), '');
  assert.equal(httpDb.prepare('SELECT enabled FROM devices WHERE device = ?').get(DEVICE).enabled, 1);

  const off = await post(valid({ enabled: false }));
  assert.equal(off.status, 204);
  assert.equal(httpDb.prepare('SELECT enabled FROM devices WHERE device = ?').get(DEVICE).enabled, 0);

  const badToken = await post(valid({ token: 'nothex' }));
  assert.equal(badToken.status, 400);
  assert.match((await badToken.json()).error, /token/);

  const broken = await post('{"device":');
  assert.equal(broken.status, 400);
  assert.ok((await broken.json()).error);

  const big = await post({ ...valid(), pad: 'x'.repeat(8 * 1024) });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /4 kB/);
});

test('POST /devices is rate-limited per address', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await post(valid({ device: `device-${String(i).padStart(4, '0')}` }));
  assert.equal(last.status, 429);
  assert.ok((await last.json()).error);
});
