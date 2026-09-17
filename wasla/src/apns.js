/**
 * Apple Push Notification service, over HTTP/2 with token auth, and nothing
 * but Node itself.
 *
 * A provider token is a JWT signed ES256 with the team's .p8 key. Apple wants
 * one reused for up to an hour and refuses more than one new token every 20
 * minutes, so it is cached for 50 minutes. Each device is sent to the host for
 * its own environment: a build from Xcode has a sandbox token, which the
 * production host rejects as BadDeviceToken.
 */

import crypto from 'node:crypto';
import http2 from 'node:http2';

export const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

export const TOKEN_TTL_MS = 50 * 60 * 1000;
export const CONCURRENCY = 20;
const REQUEST_TIMEOUT_MS = 15_000;

/** Reasons that mean the token will never work again: stop sending to it. */
const DEAD_TOKEN_REASONS = ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'];

const base64url = (input) => Buffer.from(input).toString('base64url');

/**
 * `header.claims.signature` for APNs. `dsaEncoding: 'ieee-p1363'` makes
 * crypto.sign return the raw 64-byte r‖s JOSE wants, not the DER Node
 * produces by default.
 */
export function buildProviderToken({ keyPem, keyId, teamId, now = Date.now() }) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: keyPem, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** A provider token reused until it is `ttl` old, or the credentials change. */
export function createTokenCache({ ttl = TOKEN_TTL_MS, clock = () => Date.now() } = {}) {
  let cached = null;
  return {
    get(credentials) {
      const now = clock();
      const fingerprint = `${credentials.keyId}:${credentials.teamId}:${crypto.createHash('sha256').update(credentials.keyPem).digest('hex')}`;
      if (!cached || cached.fingerprint !== fingerprint || now - cached.at >= ttl) {
        cached = { fingerprint, at: now, token: buildProviderToken({ ...credentials, now }) };
      }
      return cached.token;
    },
    clear() { cached = null; },
  };
}

/** What the app receives: `{ aps: { alert, sound }, level? }`. */
export function buildPayload({ title, body, level = null }) {
  const payload = { aps: { alert: { title, body }, sound: 'default' } };
  if (Number.isInteger(level) && level > 0) payload.level = level;
  return payload;
}

/**
 * `{ outcome, reason }` for one APNs response: `sent`, `disable` (the token is
 * dead) or `failed` (anything else, counted and retried on the next send).
 */
export function classifyResponse(status, body) {
  if (status === 200) return { outcome: 'sent', reason: null };
  let reason = null;
  try {
    reason = body ? JSON.parse(body).reason ?? null : null;
  } catch {
    reason = null;
  }
  if (status === 410) return { outcome: 'disable', reason: reason || 'Unregistered' };
  if (status === 400 && DEAD_TOKEN_REASONS.includes(reason)) return { outcome: 'disable', reason };
  return { outcome: 'failed', reason: reason || `HTTP ${status}` };
}

/** Runs `worker` over `items`, at most `limit` at a time. */
export async function eachLimited(items, limit, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** One POST on an open session. Resolves `{ status, body }`, rejects on a stream error. */
function request(session, headers, payload) {
  return new Promise((resolve, reject) => {
    const stream = session.request(headers);
    let status = 0;
    const chunks = [];
    stream.setTimeout?.(REQUEST_TIMEOUT_MS, () => {
      stream.close?.(http2.constants?.NGHTTP2_CANCEL);
      reject(new Error('Timeout'));
    });
    stream.on('response', (h) => { status = Number(h[':status']); });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
    stream.on('error', reject);
    stream.end(payload);
  });
}

/**
 * The sender. `connect(origin)` defaults to http2.connect; tests pass a fake.
 *
 * `send({ credentials, devices, payload })` resolves a summary
 * `{ total, sent, failed, disabled, errors: { reason: count }, results }` and
 * never rejects for a device's failure — only a missing credential is thrown.
 */
export function createApnsSender({ connect = http2.connect, tokens = createTokenCache(), concurrency = CONCURRENCY } = {}) {
  async function send({ credentials, devices, payload }) {
    if (!credentials?.keyPem || !credentials.keyId || !credentials.teamId || !credentials.topic) {
      throw new Error('APNs is not set up.');
    }
    const body = JSON.stringify(payload);
    const sessions = new Map();
    const sessionFor = (environment) => {
      const origin = HOSTS[environment] ?? HOSTS.production;
      let session = sessions.get(origin);
      if (!session || session.closed || session.destroyed) {
        session = connect(origin);
        // A connection error surfaces on each request; without a listener it would crash the process.
        session.on?.('error', () => {});
        sessions.set(origin, session);
      }
      return session;
    };

    const summary = { total: devices.length, sent: 0, failed: 0, disabled: 0, errors: {}, results: [] };
    const count = (reason) => { summary.errors[reason] = (summary.errors[reason] ?? 0) + 1; };

    try {
      await eachLimited(devices, concurrency, async (device) => {
        const headers = {
          ':method': 'POST',
          ':path': `/3/device/${device.token}`,
          authorization: `bearer ${tokens.get(credentials)}`,
          'apns-topic': credentials.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        };
        let result;
        try {
          const { status, body: text } = await request(sessionFor(device.environment), headers, body);
          result = classifyResponse(status, text);
          // An expired or refused provider token: make a new one next time.
          if (status === 403 && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason)) tokens.clear?.();
        } catch (err) {
          result = { outcome: 'failed', reason: err?.code || err?.message || 'NetworkError' };
        }
        if (result.outcome === 'sent') summary.sent++;
        else if (result.outcome === 'disable') { summary.disabled++; count(result.reason); }
        else { summary.failed++; count(result.reason); }
        summary.results.push({ device: device.device, ...result });
      });
    } finally {
      for (const session of sessions.values()) session.close?.();
    }
    return summary;
  }

  return { send };
}
