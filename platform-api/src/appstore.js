import { createPrivateKey, createSign, createVerify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { log } from './log.js';

const BASE = 'https://api.appstoreconnect.apple.com/v1';
const AUDIENCE = 'appstoreconnect-v1';

/**
 * Apple caps token lifetime at 20 minutes and rejects anything longer outright.
 * Fifteen leaves room for a slow report download and for a clock that is a
 * little ahead, which is a 401 that looks exactly like a bad key.
 */
const TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN_REUSE_SECONDS = 13 * 60;

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Signs an App Store Connect JWT.
 *
 * ES256, signed with Node rather than a JWT library — the whole of it is two
 * base64url segments and a signature, and the one detail a library would be
 * hiding is the one that matters:
 *
 * `dsaEncoding: 'ieee-p1363'`. Node signs ECDSA in DER by default, which is a
 * variable-length structure. JWS wants the raw r||s pair, fixed at 64 bytes.
 * A DER signature is a perfectly valid signature that Apple will reject every
 * time with the same 401 as a wrong key, a wrong issuer or an expired token —
 * so it is the kind of mistake that costs a day.
 */
export function signToken({ issuerId, keyId, privateKey }) {
  if (!issuerId || !keyId || !privateKey) {
    throw new Error('App Store Connect credentials are incomplete.');
  }

  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `Expected an EC private key (the .p8 from App Store Connect), got ${key.asymmetricKeyType}.`,
    );
  }

  const issued = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: issued,
    exp: issued + TOKEN_TTL_SECONDS,
    aud: AUDIENCE,
  };

  const body = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('SHA256')
    .update(body)
    .sign({ key, dsaEncoding: 'ieee-p1363' });

  return {
    token: `${body}.${base64url(signature)}`,
    expiresAt: (issued + TOKEN_REUSE_SECONDS) * 1000,
  };
}

/** Exposed for the self-check: proves a token verifies against its own key. */
export function verifyToken(token, privateKey) {
  const [header, payload, signature] = String(token).split('.');
  if (!header || !payload || !signature) return false;
  return createVerify('SHA256')
    .update(`${header}.${payload}`)
    .verify(
      { key: createPrivateKey(privateKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );
}

export function decodeToken(token) {
  const [, payload] = String(token).split('.');
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

/** One cached token per key id — signing is cheap, but a new token per request
 *  makes Apple's rate limits arrive much sooner. */
const tokens = new Map();

function tokenFor(credentials) {
  const cached = tokens.get(credentials.keyId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const fresh = signToken(credentials);
  tokens.set(credentials.keyId, fresh);
  return fresh.token;
}

export function forgetTokens() {
  tokens.clear();
}

/**
 * One GET against the API.
 *
 * Apple's errors are a JSON array of objects with a title and a detail; the
 * detail is the useful half and the status alone tells you very little, so it
 * is carried through to the panel rather than collapsed into "request failed".
 */
export async function request(credentials, path, params = {}, { binary = false } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${BASE}${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenFor(credentials)}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach App Store Connect: ${err.message}`), {
      status: 503,
    });
  }

  // Read as bytes when the caller expects a file. Reports come back as
  // `application/a-gzip`: a gzip *file* in the body, not a gzip-encoded
  // transfer, so fetch does not unwrap it and `.text()` would mangle the
  // bytes beyond recovery. Errors are still JSON even on those endpoints,
  // which is why the failure path decodes as text either way.
  const buffer = binary ? Buffer.from(await response.arrayBuffer()) : null;
  const text = binary ? null : await response.text();

  if (!response.ok) {
    let errors = null;
    try {
      errors = JSON.parse(binary ? buffer.toString('utf8') : text)?.errors ?? null;
    } catch {
      errors = null;
    }
    const detail = errors?.map((e) => e.detail || e.title).filter(Boolean).join('; ');
    throw Object.assign(
      new Error(detail || `App Store Connect returned ${response.status}.`),
      { status: response.status, errors },
    );
  }

  if (binary) {
    // Trust the bytes, not the headers: gunzip when it starts with the gzip
    // magic number, pass it through when it does not.
    const gzipped = buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    return (gzipped ? gunzipSync(buffer) : buffer).toString('utf8');
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/**
 * Everything the panel shows for one app, in one call.
 *
 * Settled with `allSettled` rather than `all`: these are five independent
 * questions, and the answers are not equally available. Sales needs a Finance
 * role and TestFlight needs App Manager, so a key that is scoped to read app
 * metadata will legitimately fail two of them. Failing the whole page because
 * one section is out of scope would make the other three unreachable.
 */
export async function overview(credentials, bundleId) {
  const apps = await request(credentials, '/apps', {
    'filter[bundleId]': bundleId,
    'fields[apps]': 'name,bundleId,sku,primaryLocale',
    limit: 1,
  });

  const app = apps?.data?.[0];
  if (!app) {
    throw Object.assign(
      new Error(`No app with bundle id ${bundleId} is visible to this API key.`),
      { status: 404 },
    );
  }

  const id = app.id;
  const [versions, builds, reviews, groups] = await Promise.allSettled([
    request(credentials, `/apps/${id}/appStoreVersions`, {
      'fields[appStoreVersions]': 'versionString,appStoreState,platform,createdDate,releaseType',
      limit: 5,
    }),
    request(credentials, `/apps/${id}/builds`, {
      'fields[builds]': 'version,processingState,uploadedDate,expired,minOsVersion',
      limit: 5,
    }),
    request(credentials, `/apps/${id}/customerReviews`, {
      'fields[customerReviews]': 'rating,title,body,reviewerNickname,createdDate,territory',
      sort: '-createdDate',
      limit: 10,
    }),
    request(credentials, `/apps/${id}/betaGroups`, {
      'fields[betaGroups]': 'name,publicLinkEnabled,publicLinkLimit',
      limit: 10,
    }),
  ]);

  return {
    app: {
      id,
      name: app.attributes?.name ?? null,
      bundleId: app.attributes?.bundleId ?? null,
      sku: app.attributes?.sku ?? null,
      locale: app.attributes?.primaryLocale ?? null,
    },
    versions: section(versions, (d) => ({
      version: d.attributes?.versionString,
      state: d.attributes?.appStoreState,
      platform: d.attributes?.platform,
      releaseType: d.attributes?.releaseType,
      created: d.attributes?.createdDate,
    })),
    builds: section(builds, (d) => ({
      version: d.attributes?.version,
      state: d.attributes?.processingState,
      uploaded: d.attributes?.uploadedDate,
      expired: d.attributes?.expired,
      minOs: d.attributes?.minOsVersion,
    })),
    reviews: section(reviews, (d) => ({
      rating: d.attributes?.rating,
      title: d.attributes?.title,
      body: d.attributes?.body,
      author: d.attributes?.reviewerNickname,
      territory: d.attributes?.territory,
      at: d.attributes?.createdDate,
    })),
    testflight: section(groups, (d) => ({
      name: d.attributes?.name,
      publicLink: d.attributes?.publicLinkEnabled,
      limit: d.attributes?.publicLinkLimit,
    })),
  };
}

/** A settled section: the rows, or why they are missing. */
function section(result, shape) {
  if (result.status === 'fulfilled') {
    return { ok: true, items: (result.value?.data ?? []).map(shape) };
  }
  log.warn(`App Store Connect section unavailable: ${result.reason?.message}`);
  return { ok: false, items: [], error: result.reason?.message ?? 'Unavailable' };
}
