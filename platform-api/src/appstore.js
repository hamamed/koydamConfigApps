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
    // `include` rather than a follow-up call: the store listing belongs to a
    // version, and asking for it separately would mean fetching versions,
    // reading an id out, and going back — two round trips for one answer.
    request(credentials, `/apps/${id}/appStoreVersions`, {
      'fields[appStoreVersions]': 'versionString,appStoreState,platform,createdDate,releaseType',
      include: 'appStoreVersionLocalizations',
      'fields[appStoreVersionLocalizations]':
        'locale,keywords,description,promotionalText,whatsNew,marketingUrl,supportUrl',
      'limit[appStoreVersionLocalizations]': 20,
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
    listing: listingFrom(versions),
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

/**
 * The store listing as it is written today: keywords, subtitle copy, what's new.
 *
 * These arrive in the `included` array rather than under `data`, because they
 * are a relationship of the version rather than a field of it. One entry per
 * locale, so the primary one is not necessarily first — English is preferred
 * when present, and otherwise whichever came back first, because showing a
 * Japanese description to someone checking their keywords is worse than
 * showing nothing.
 *
 * Worth being clear about what this is: the keyword field *you* wrote, the
 * hundred characters Apple indexes. It is not a ranking, a search volume or a
 * competitor list — Apple's API publishes none of those, and anything claiming
 * to know them is estimating from outside.
 */
function listingFrom(result) {
  if (result.status !== 'fulfilled') {
    return { ok: false, error: result.reason?.message ?? 'Unavailable' };
  }

  const all = (result.value?.included ?? []).filter(
    (i) => i.type === 'appStoreVersionLocalizations',
  );
  if (!all.length) return { ok: true, locales: 0 };

  const preferred =
    all.find((i) => i.attributes?.locale === 'en-GB') ??
    all.find((i) => i.attributes?.locale === 'en-US') ??
    all.find((i) => String(i.attributes?.locale ?? '').startsWith('en')) ??
    all[0];

  const a = preferred.attributes ?? {};
  return {
    ok: true,
    locales: all.length,
    locale: a.locale ?? null,
    keywords: a.keywords ?? null,
    promotionalText: a.promotionalText ?? null,
    whatsNew: a.whatsNew ?? null,
    description: a.description ? String(a.description).slice(0, 400) : null,
    marketingUrl: a.marketingUrl ?? null,
    supportUrl: a.supportUrl ?? null,
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

/**
 * Downloads for the whole estate, by day.
 *
 * Sales reports are issued per *vendor*, not per app: one request returns every
 * app you publish for that day. So a week costs seven requests in total rather
 * than seven per app, and the result is keyed by SKU for the caller to match up.
 *
 * `Units` on a free app is a download. Apple splits first installs from updates
 * and re-downloads across its Product Type Identifiers, and the exact set of
 * codes varies by platform and has changed over the years — so rather than
 * assert a mapping that would quietly mislabel things, the breakdown is carried
 * through by code and only the families that are unambiguous get a name.
 */
export async function downloads(credentials, { days = 7 } = {}) {
  if (!credentials.vendorNumber) {
    return { ok: false, error: 'No vendor number set, so sales reports cannot be requested.' };
  }

  // Apple publishes a day's report the following day, and sometimes later than
  // that, so today and yesterday are usually absent rather than empty.
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(Date.now() - (i + 2) * 86_400_000).toISOString().slice(0, 10),
  );

  const reports = await Promise.all(
    dates.map(async (date) => {
      try {
        const raw = await request(
          credentials,
          '/salesReports',
          {
            'filter[frequency]': 'DAILY',
            'filter[reportType]': 'SALES',
            'filter[reportSubType]': 'SUMMARY',
            'filter[vendorNumber]': credentials.vendorNumber,
            'filter[reportDate]': date,
          },
          { binary: true },
        );
        return { date, rows: parseReport(raw) };
      } catch (err) {
        // 404 is "nothing published for that day", which is the normal answer
        // for a day with no sales or a day Apple has not produced yet.
        if (err.status === 404) return { date, rows: [] };
        return { date, rows: [], error: err.message };
      }
    }),
  );

  const refused = reports.find((r) => r.error);
  if (refused && reports.every((r) => !r.rows.length)) {
    return { ok: false, error: refused.error };
  }

  const bySku = new Map();
  const byDay = new Map();
  const byCountry = new Map();
  let total = 0;

  for (const report of reports) {
    let dayTotal = 0;
    for (const row of report.rows) {
      // In-app purchases are not downloads of the app.
      if (String(row.productType).startsWith('IA')) continue;

      total += row.units;
      dayTotal += row.units;
      bySku.set(row.sku, (bySku.get(row.sku) ?? 0) + row.units);
      if (row.country) byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + row.units);
    }
    byDay.set(report.date, dayTotal);
  }

  return {
    ok: true,
    days,
    total,
    bySku: Object.fromEntries(bySku),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    topCountries: [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

/** One tab-separated report, already un-gzipped by `request`. */
function parseReport(raw) {
  const lines = String(raw ?? '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map((h) => h.trim());
  const at = (name) => headers.indexOf(name);
  const sku = at('SKU');
  const units = at('Units');
  const type = at('Product Type Identifier');
  const country = at('Country Code');

  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return {
      sku: sku >= 0 ? cells[sku] : null,
      units: units >= 0 ? Number(cells[units]) || 0 : 0,
      productType: type >= 0 ? cells[type] : '',
      country: country >= 0 ? cells[country] : null,
    };
  });
}
