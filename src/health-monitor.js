import { query } from './db/pool.js';
import { log } from './log.js';

/**
 * Pings every registered service and records the result.
 *
 * The dashboard's whole claim is "one page for everything on this box", and
 * that is only true if it knows whether each thing is answering. Reading
 * systemd would be more direct but only works for services on *this* machine;
 * an HTTP check works for anything, including a service moved elsewhere later.
 */

/** A service that has not answered in this long is down, not slow. */
const TIMEOUT_MS = 8000;

/** How long check history is kept. Long enough to see a week of flapping. */
const RETAIN_DAYS = 14;

export async function checkAllServices() {
  const res = await query(
    'SELECT slug, health_url FROM services WHERE health_url IS NOT NULL',
  );

  const services = res?.rows ?? [];
  if (!services.length) return 0;

  // In parallel: a dozen services checked in series would take as long as the
  // slowest chain, and the point of the interval is a current picture.
  await Promise.all(services.map((s) => checkOne(s.slug, s.health_url)));
  return services.length;
}

async function checkOne(slug, url) {
  const started = Date.now();
  let ok = false;
  let status = null;
  let error = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        // A health check that follows a redirect chain is measuring the wrong
        // thing — an HTTP→HTTPS hop still means the service answered.
        redirect: 'follow',
        headers: { 'User-Agent': 'platform-api health check' },
      });
      status = res.status;
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    error = err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message;
  }

  await query(
    `INSERT INTO service_checks (service_slug, ok, status_code, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [slug, ok, status, Date.now() - started, error?.slice(0, 300) ?? null],
  );

  if (!ok) log.warn('Service check failed', { slug, error });
}

/** Drops history past the retention window. */
export async function pruneChecks() {
  const res = await query(
    `DELETE FROM service_checks
      WHERE at < now() - ($1 || ' days')::interval`,
    [String(RETAIN_DAYS)],
  );
  return res?.rowCount ?? 0;
}

/**
 * Current status plus a 24-hour summary, for the dashboard.
 *
 * `DISTINCT ON` takes the newest row per service in one pass; the alternative
 * is a correlated subquery per service, which is a query per row on a page
 * that refreshes.
 */
export async function serviceStatus() {
  const res = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (service_slug)
              service_slug, at, ok, status_code, duration_ms, error
         FROM service_checks
        ORDER BY service_slug, at DESC
     ),
     day AS (
       SELECT service_slug,
              COUNT(*)::int                          AS checks,
              COUNT(*) FILTER (WHERE ok)::int        AS good,
              ROUND(AVG(duration_ms))::int           AS avg_ms
         FROM service_checks
        WHERE at > now() - interval '24 hours'
        GROUP BY service_slug
     )
     SELECT s.slug, s.name, s.domain, s.health_url, s.systemd_unit,
            s.notes, s.app_slug, s.sort_order,
            l.at AS checked_at, l.ok, l.status_code, l.duration_ms, l.error,
            d.checks, d.good, d.avg_ms
       FROM services s
       LEFT JOIN latest l ON l.service_slug = s.slug
       LEFT JOIN day    d ON d.service_slug = s.slug
      ORDER BY s.sort_order, s.name`,
  );

  return (res?.rows ?? []).map((r) => ({
    slug: r.slug,
    name: r.name,
    domain: r.domain,
    healthUrl: r.health_url,
    systemdUnit: r.systemd_unit,
    notes: r.notes,
    appSlug: r.app_slug,
    checkedAt: r.checked_at,
    ok: r.ok,
    statusCode: r.status_code,
    durationMs: r.duration_ms,
    error: r.error,
    // Null rather than 100% when nothing has been checked yet — an uptime
    // figure invented from zero samples is worse than an honest blank.
    uptime24h: r.checks ? r.good / r.checks : null,
    avgMs: r.avg_ms,
  }));
}
