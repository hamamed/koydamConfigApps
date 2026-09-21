import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createDevices, readDeviceRegistration } from '../src/devices.js';
import { createNotifications, MAX_BODY, MAX_TITLE, NOT_SET_UP, readCompose } from '../src/notifications.js';

const KEYS = { keyPem: 'pem', keyId: 'ABC123DEFG', teamId: '652935W544', topic: 'koydam.wasla.crosswords' };

let db;
let devices;

const register = (device, token, environment = 'production', enabled = true) => devices.register(
  readDeviceRegistration({ device, token, platform: 'ios', environment, enabled }).registration,
);

beforeEach(() => {
  db = openDatabase(':memory:');
  devices = createDevices(db);
  register('device-prod-1', 'a1'.repeat(32));
  register('device-prod-2', 'a2'.repeat(32));
  register('device-sand-1', 'b1'.repeat(32), 'sandbox');
  register('device-off-01', 'c1'.repeat(32), 'production', false);
});

test('compose: title ≤ 60, body ≤ 180, a published level, a known target', () => {
  const ok = readCompose({ title: ' لغز جديد ', body: 'جرّبه الآن', level: '2', target: 'all' }, { publishedCount: 3 });
  assert.deepEqual(ok.message, { title: 'لغز جديد', body: 'جرّبه الآن', level: 2, target: 'all', device: null });
  assert.equal(readCompose({ title: 't', body: 'b', level: '', target: 'sandbox' }, { publishedCount: 0 }).message.level, null);
  assert.equal(readCompose({ title: 'ع'.repeat(MAX_TITLE), body: 'ب'.repeat(MAX_BODY), target: 'all' }, { publishedCount: 0 }).error, undefined);

  const bad = [
    [{ title: '', body: 'b' }, /عنوان/],
    [{ title: 'ع'.repeat(MAX_TITLE + 1), body: 'b' }, /60/],
    [{ title: 't', body: '  ' }, /الرسالة/],
    [{ title: 't', body: 'ب'.repeat(MAX_BODY + 1) }, /180/],
    [{ title: 't', body: 'b', level: '4' }, /لا يوجد لغز 4/],
    [{ title: 't', body: 'b', level: '0' }, /يُكتب برقمه/],
    [{ title: 't', body: 'b', level: '2.5' }, /يُكتب برقمه/],
    [{ title: 't', body: 'b', target: 'everyone' }, /يستقبله/],
    [{ title: 't', body: 'b', target: 'device', device: 'x' }, /معرّف الجهاز/],
  ];
  for (const [input, message] of bad) {
    assert.match(readCompose({ target: 'all', ...input }, { publishedCount: 3 }).error, message, JSON.stringify(input));
  }
});

test('without APNs set up, sending says so and records nothing', async () => {
  let called = false;
  const notifications = createNotifications(db, {
    devices, credentials: { load: () => null }, sender: { send: async () => { called = true; } },
  });
  const result = await notifications.send({ title: 't', body: 'b', level: null, target: 'all', device: null });
  assert.equal(result.error, NOT_SET_UP);
  assert.match(result.error, /Set up APNs first/);
  assert.equal(called, false);
  assert.deepEqual(notifications.history(), []);
});

test('audience counts enabled devices for the target', () => {
  const notifications = createNotifications(db, { devices, credentials: { load: () => KEYS }, sender: {} });
  assert.equal(notifications.audience({ target: 'all' }), 3);
  assert.equal(notifications.audience({ target: 'sandbox' }), 1);
  assert.equal(notifications.audience({ target: 'device', device: 'device-prod-2' }), 1);
  assert.equal(notifications.audience({ target: 'device', device: 'device-off-01' }), 0);
});

test('a send applies the outcomes to devices and is recorded with its counts', async () => {
  const seen = [];
  const sender = {
    send: async ({ credentials, devices: targets, payload }) => {
      seen.push({ credentials, targets: targets.map((d) => d.device), payload });
      return {
        total: 3, sent: 1, failed: 1, disabled: 1, errors: { Unregistered: 1, TooManyRequests: 1 },
        results: [
          { device: 'device-prod-1', outcome: 'sent', reason: null },
          { device: 'device-prod-2', outcome: 'disable', reason: 'Unregistered' },
          { device: 'device-sand-1', outcome: 'failed', reason: 'TooManyRequests' },
        ],
      };
    },
  };
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'x')").run();
  const notifications = createNotifications(db, { devices, credentials: { load: () => KEYS }, sender });

  const result = await notifications.send({ title: 'لغز جديد', body: 'العب', level: 2, target: 'all', device: null }, { userId: 1 });

  assert.deepEqual(seen[0].targets, ['device-prod-1', 'device-prod-2', 'device-sand-1']);
  assert.equal(seen[0].credentials, KEYS);
  assert.deepEqual(seen[0].payload, { aps: { alert: { title: 'لغز جديد', body: 'العب' }, sound: 'default' }, level: 2 });
  assert.deepEqual([result.summary.sent, result.summary.failed, result.summary.disabled], [1, 1, 1]);

  assert.equal(devices.get('device-prod-2').enabled, false);
  assert.deepEqual([devices.get('device-sand-1').failures, devices.get('device-sand-1').lastError], [1, 'TooManyRequests']);
  assert.equal(devices.get('device-prod-1').failures, 0);

  const [row] = notifications.history();
  assert.deepEqual(
    [row.id, row.title, row.level, row.target, row.total, row.sent, row.failed, row.disabled, row.createdBy],
    [result.id, 'لغز جديد', 2, 'all', 3, 1, 1, 1, 'admin'],
  );
  assert.deepEqual(row.errors, { Unregistered: 1, TooManyRequests: 1 });
});

test('a test send to an unknown or switched-off device sends nothing', async () => {
  const notifications = createNotifications(db, {
    devices, credentials: { load: () => KEYS }, sender: { send: async () => assert.fail('should not send') },
  });
  for (const device of ['device-off-01', 'device-missing']) {
    const result = await notifications.send({ title: 't', body: 'b', level: null, target: 'device', device });
    assert.match(result.error, /not registered|turned off/);
  }
  assert.deepEqual(notifications.history(), []);
});
