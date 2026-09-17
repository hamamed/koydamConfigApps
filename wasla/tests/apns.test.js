import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildPayload, buildProviderToken, classifyResponse, createApnsSender, createTokenCache, eachLimited, HOSTS } from '../src/apns.js';
import { checkIds, checkKeyFile, createApnsCredentials, DEFAULT_TEAM_ID, DEFAULT_TOPIC } from '../src/apns-credentials.js';
import { openDatabase } from '../src/db/index.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CREDENTIALS = { keyPem: privateKey, keyId: 'ABC123DEFG', teamId: '652935W544', topic: 'koydam.wasla.crosswords' };

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// ── Provider token ───────────────────────────────────────────────────────────

test('the provider token is an ES256 JWT that verifies with the public key', () => {
  const now = Date.UTC(2026, 8, 17, 10, 0, 0);
  const jwt = buildProviderToken({ ...CREDENTIALS, now });
  const [header, claims, signature] = jwt.split('.');

  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(decode(claims), { iss: '652935W544', iat: now / 1000 });
  const raw = Buffer.from(signature, 'base64url');
  // JOSE wants r‖s, 32 bytes each — not DER.
  assert.equal(raw.length, 64);
  assert.equal(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw), true);
  assert.equal(crypto.verify('sha256', Buffer.from(`${header}.x${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw), false);
});

test('the token is cached for 50 minutes and remade after, or when the key changes', () => {
  let now = Date.UTC(2026, 8, 17, 10, 0, 0);
  const cache = createTokenCache({ clock: () => now });
  const first = cache.get(CREDENTIALS);
  now += 49 * 60 * 1000;
  assert.equal(cache.get(CREDENTIALS), first);
  now += 60 * 1000;
  const second = cache.get(CREDENTIALS);
  assert.notEqual(second, first);
  assert.notEqual(cache.get({ ...CREDENTIALS, keyId: 'ZZZ123DEFG' }), second);
});

// ── Payload and responses ────────────────────────────────────────────────────

test('the payload is the contract shape, level only when given', () => {
  assert.deepEqual(buildPayload({ title: 'لغز جديد', body: 'جرّب اللغز 12', level: 12 }), {
    aps: { alert: { title: 'لغز جديد', body: 'جرّب اللغز 12' }, sound: 'default' }, level: 12,
  });
  assert.deepEqual(buildPayload({ title: 't', body: 'b' }), { aps: { alert: { title: 't', body: 'b' }, sound: 'default' } });
  assert.equal('level' in buildPayload({ title: 't', body: 'b', level: null }), false);
});

test('responses: 200 sent; 410 and dead-token 400s disable; the rest fail with a reason', () => {
  assert.deepEqual(classifyResponse(200, ''), { outcome: 'sent', reason: null });
  assert.deepEqual(classifyResponse(410, '{"reason":"Unregistered","timestamp":1}'), { outcome: 'disable', reason: 'Unregistered' });
  assert.deepEqual(classifyResponse(410, ''), { outcome: 'disable', reason: 'Unregistered' });
  assert.deepEqual(classifyResponse(400, '{"reason":"BadDeviceToken"}'), { outcome: 'disable', reason: 'BadDeviceToken' });
  assert.deepEqual(classifyResponse(400, '{"reason":"Unregistered"}'), { outcome: 'disable', reason: 'Unregistered' });
  assert.deepEqual(classifyResponse(400, '{"reason":"PayloadTooLarge"}'), { outcome: 'failed', reason: 'PayloadTooLarge' });
  assert.deepEqual(classifyResponse(403, '{"reason":"InvalidProviderToken"}'), { outcome: 'failed', reason: 'InvalidProviderToken' });
  assert.deepEqual(classifyResponse(429, '{"reason":"TooManyRequests"}'), { outcome: 'failed', reason: 'TooManyRequests' });
  assert.deepEqual(classifyResponse(500, 'not json'), { outcome: 'failed', reason: 'HTTP 500' });
});

test('eachLimited never runs more than the limit at once and visits every item', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await eachLimited(Array.from({ length: 50 }, (_, i) => i), 20, async (item) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(item);
    running--;
  });
  assert.equal(peak, 20);
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i));
});

// ── Sender over a fake HTTP/2 transport ──────────────────────────────────────

/** http2.connect stand-in: `respond(origin, headers, body)` → `{ status, body }` or throws. */
function fakeTransport(respond) {
  const calls = [];
  const sessions = [];
  const connect = (origin) => {
    const session = new EventEmitter();
    session.closed = false;
    session.close = () => { session.closed = true; };
    session.request = (headers) => {
      const stream = new EventEmitter();
      stream.end = (payload) => setImmediate(() => {
        calls.push({ origin, headers, payload: JSON.parse(payload) });
        let reply;
        try {
          reply = respond(origin, headers);
        } catch (err) {
          stream.emit('error', err);
          return;
        }
        stream.emit('response', { ':status': reply.status });
        if (reply.body) stream.emit('data', Buffer.from(reply.body));
        stream.emit('end');
      });
      return stream;
    };
    sessions.push({ origin, session });
    return session;
  };
  return { connect, calls, sessions };
}

const device = (name, token, environment = 'production') => ({ device: name, token, environment });

test('sends each device to its environment host with the APNs headers, and summarises', async () => {
  const transport = fakeTransport((origin, headers) => {
    const token = headers[':path'].split('/').pop();
    if (token === 'dead') return { status: 410, body: '{"reason":"Unregistered"}' };
    if (token === 'bad') return { status: 400, body: '{"reason":"BadDeviceToken"}' };
    if (token === 'busy') return { status: 429, body: '{"reason":"TooManyRequests"}' };
    if (token === 'offline') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return { status: 200 };
  });
  const sender = createApnsSender({ connect: transport.connect });
  const payload = buildPayload({ title: 'مرحبا', body: 'لغز جديد', level: 3 });

  const summary = await sender.send({
    credentials: CREDENTIALS,
    payload,
    devices: [device('p1', 'aa'), device('s1', 'bb', 'sandbox'), device('d1', 'dead'), device('b1', 'bad', 'sandbox'), device('r1', 'busy'), device('o1', 'offline')],
  });

  assert.deepEqual([summary.total, summary.sent, summary.failed, summary.disabled], [6, 2, 2, 2]);
  assert.deepEqual(summary.errors, { Unregistered: 1, BadDeviceToken: 1, TooManyRequests: 1, ECONNRESET: 1 });
  const byDevice = Object.fromEntries(summary.results.map((r) => [r.device, r.outcome]));
  assert.deepEqual(byDevice, { p1: 'sent', s1: 'sent', d1: 'disable', b1: 'disable', r1: 'failed', o1: 'failed' });

  const sandboxCall = transport.calls.find((c) => c.headers[':path'] === '/3/device/bb');
  assert.equal(sandboxCall.origin, HOSTS.sandbox);
  const productionCall = transport.calls.find((c) => c.headers[':path'] === '/3/device/aa');
  assert.equal(productionCall.origin, HOSTS.production);
  assert.equal(productionCall.headers[':method'], 'POST');
  assert.equal(productionCall.headers['apns-topic'], 'koydam.wasla.crosswords');
  assert.equal(productionCall.headers['apns-push-type'], 'alert');
  assert.equal(productionCall.headers['apns-priority'], '10');
  assert.match(productionCall.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(productionCall.payload, payload);

  // One connection per host, closed when the send is over.
  assert.deepEqual(transport.sessions.map((s) => s.origin).sort(), [HOSTS.production, HOSTS.sandbox]);
  assert.ok(transport.sessions.every((s) => s.session.closed));
  // One provider token for the whole send.
  assert.equal(new Set(transport.calls.map((c) => c.headers.authorization)).size, 1);
});

test('sending without credentials throws before connecting', async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  const sender = createApnsSender({ connect: transport.connect });
  await assert.rejects(sender.send({ credentials: null, devices: [device('p1', 'aa')], payload: {} }), /not set up/);
  assert.equal(transport.sessions.length, 0);
});

// ── Credentials ──────────────────────────────────────────────────────────────

test('a key file must be a PKCS#8 P-256 private key', () => {
  assert.equal(checkKeyFile(Buffer.from(privateKey)).keyPem.trim(), privateKey.trim());
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const sec1 = crypto.createPrivateKey(privateKey).export({ type: 'sec1', format: 'pem' });

  assert.match(checkKeyFile(Buffer.from('')).error, /Choose/);
  assert.match(checkKeyFile(Buffer.from('hello')).error, /BEGIN PRIVATE KEY/);
  assert.match(checkKeyFile(Buffer.from(publicKey)).error, /BEGIN PRIVATE KEY/);
  assert.match(checkKeyFile(Buffer.from(sec1)).error, /BEGIN PRIVATE KEY/);
  assert.match(checkKeyFile(Buffer.from(rsa)).error, /P-256/);
  assert.match(checkKeyFile(Buffer.from(p384)).error, /P-256/);
  assert.match(checkKeyFile(Buffer.from('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n')).error, /could not be read/);
});

test('ids: a 10-character Key ID; team and topic default to the app', () => {
  assert.deepEqual(checkIds({ keyId: ' abc123defg ' }).ids, { keyId: 'ABC123DEFG', teamId: DEFAULT_TEAM_ID, topic: DEFAULT_TOPIC });
  assert.ok(checkIds({ keyId: 'SHORT' }).error);
  assert.ok(checkIds({ keyId: 'ABC123DEFG', teamId: 'nope' }).error);
  assert.ok(checkIds({ keyId: 'ABC123DEFG', topic: 'not a topic' }).error);
});

test('credentials store the key 0600 under a 0700 directory, report only the Key ID, and can be removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wasla-apns-'));
  try {
    const dir = path.join(root, 'apns');
    const store = createApnsCredentials(openDatabase(':memory:'), { dir });
    assert.equal(store.status().configured, false);
    assert.equal(store.load(), null);
    assert.match(store.save({ keyId: 'ABC123DEFG' }).error, /\.p8/);

    const saved = store.save({ file: Buffer.from(privateKey), keyId: 'abc123defg' });
    assert.equal(saved.error, undefined);
    assert.equal(fs.statSync(store.keyPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const status = store.status();
    assert.deepEqual([status.configured, status.keyId, status.teamId, status.topic], [true, 'ABC123DEFG', DEFAULT_TEAM_ID, DEFAULT_TOPIC]);
    assert.equal(JSON.stringify(status).includes('PRIVATE'), false);
    assert.equal(store.load().keyPem.trim(), privateKey.trim());

    // Ids alone can change once a key is there.
    assert.equal(store.save({ keyId: 'ZZZ999YYYY', topic: 'koydam.wasla.other' }).error, undefined);
    assert.deepEqual([store.status().keyId, store.status().topic], ['ZZZ999YYYY', 'koydam.wasla.other']);
    // A bad replacement leaves the old key in place.
    assert.ok(store.save({ file: Buffer.from('junk'), keyId: 'ZZZ999YYYY' }).error);
    assert.equal(store.load().keyPem.trim(), privateKey.trim());

    store.remove();
    assert.equal(fs.existsSync(store.keyPath), false);
    assert.deepEqual([store.status().configured, store.status().keyId], [false, null]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
