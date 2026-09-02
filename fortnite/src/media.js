import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { db } from './db/index.js';

export const MEDIA_ROOT = path.resolve(config.dataDir, 'media');
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

/**
 * Upstream hosts this service will fetch a picture from.
 *
 * Defence in depth rather than the main control. A hash can only be fetched if
 * this service put it in the table itself, so an attacker has no way to point
 * the proxy anywhere — but if a future caller ever registers a URL from user
 * input, the damage stops here rather than becoming a request to an internal
 * address.
 */
const ALLOWED_HOSTS = new Set([
  'fortnite-api.com',
  'media.fortniteapi.io',
  'cdn-0001.qstv.on.epicgames.com',
  'cdn-live.prm.ol.epicgames.com',
  'fortnite.gg',
  'cdn2.unrealengine.com',
]);

function allowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    // A trailing-dot host and a subdomain both bypass a plain equality check.
    const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
    return ALLOWED_HOSTS.has(host);
  } catch {
    return false;
  }
}

const idFor = (url) => crypto.createHash('sha1').update(url).digest('hex');

// Prepared on first use, not at import.
//
// A statement built while the module loads has to be written after the table
// exists, which quietly makes importing this file depend on migrations having
// already run. Deferring it means the order stops mattering.
const statements = new Map();
const sql = (text) => {
  if (!statements.has(text)) statements.set(text, db.prepare(text));
  return statements.get(text);
};

const remember = () => sql(
  `INSERT INTO media (id, url) VALUES (@id, @url)
   ON CONFLICT(id) DO NOTHING`);

const lookup = () => sql('SELECT * FROM media WHERE id = ?');

const store = () => sql(
  `UPDATE media SET content_type = @content_type, bytes = @bytes,
                    fetched_at = datetime('now')
    WHERE id = @id`);

/**
 * Rewrites an upstream image URL to one on this service.
 *
 * The app is then a client of exactly one host. That is worth something on its
 * own — no third party sees the user's address, and a CDN that moves or
 * disappears breaks a picture here where it can be fixed, rather than in a
 * shipped build.
 *
 * Registering is cheap: a row, not a download. The file is fetched the first
 * time somebody actually asks for it, so a catalogue of sixteen thousand
 * cosmetics costs sixteen thousand rows and only the bytes people look at.
 */
export function proxied(url, origin) {
  if (!url) return url;
  const text = String(url);
  if (!allowed(text)) return text;

  const id = idFor(text);
  remember().run({ id, url: text });
  return `${origin}/api/v1/media/${id}`;
}

const filePath = (id) => path.join(MEDIA_ROOT, id.slice(0, 2), id);

/** The cached file for a registered id, fetching it once if it is not here yet. */
export async function fetchMedia(id) {
  const row = lookup().get(id);
  // Not a 404 for tidiness: an id this service never registered is the only
  // thing standing between a proxy and an open relay.
  if (!row) return null;

  const file = filePath(id);
  if (row.fetched_at && fs.existsSync(file)) {
    return { file, contentType: row.content_type || 'application/octet-stream' };
  }

  if (!allowed(row.url)) return null;

  const response = await fetch(row.url, {
    headers: { Accept: 'image/*,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;

  const type = response.headers.get('content-type') || 'application/octet-stream';
  // Only pictures. A proxy that will hand back whatever a CDN serves is a way
  // to host someone else's content under this domain.
  if (!/^image\//i.test(type)) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > config.media.maxBytes) return null;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside and moved, so a request that arrives mid-download reads a
  // whole file or none at all rather than a truncated image.
  const temporary = `${file}.${process.pid}.part`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);

  store().run({ id, content_type: type, bytes: bytes.length });
  return { file, contentType: type };
}

/** What the panel reports about the cache. */
export function mediaSummary() {
  return db
    .prepare(
      `SELECT COUNT(*) AS known,
              SUM(fetched_at IS NOT NULL) AS cached,
              COALESCE(SUM(bytes), 0) AS bytes
         FROM media`,
    )
    .get();
}

/**
 * Drops the least recently used files once the cache passes its budget.
 *
 * Rows are kept — they are tiny, and throwing one away would only mean
 * fetching the same picture again under a new id. Only the bytes go.
 */
export function pruneMedia({ maxBytes = config.media.budgetBytes } = {}) {
  const { bytes } = mediaSummary();
  if (bytes <= maxBytes) return 0;

  const rows = db
    .prepare(
      `SELECT id, bytes FROM media
        WHERE fetched_at IS NOT NULL
        ORDER BY fetched_at ASC`,
    )
    .all();

  const clear = sql(
    'UPDATE media SET fetched_at = NULL, bytes = NULL, content_type = NULL WHERE id = ?');

  let freed = 0;
  let dropped = 0;
  for (const row of rows) {
    if (bytes - freed <= maxBytes) break;
    try { fs.rmSync(filePath(row.id), { force: true }); } catch { /* already gone */ }
    clear.run(row.id);
    freed += row.bytes ?? 0;
    dropped += 1;
  }
  return dropped;
}
