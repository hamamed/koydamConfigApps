/**
 * Schema definition shared by both engines.
 *
 * Portability rules applied throughout:
 *  - Dates and timestamps are stored as ISO-8601 TEXT ("YYYY-MM-DD",
 *    "YYYY-MM-DDTHH:mm:ss.sssZ"). Lexicographic ordering equals chronological
 *    ordering, so range filters behave identically on SQLite and PostgreSQL.
 *  - Booleans are INTEGER 0/1.
 *  - Money is INTEGER centimes (see utils/money.js).
 *  - `reference` is the business key linking consultations to their results.
 *    It is stored normalised (see utils/text.js#normalizeReference) so that the
 *    join survives the formatting noise present in the source HTML.
 */

const idColumn = (dialect) =>
  dialect === 'postgres' ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT'

export function tableStatements(dialect) {
  const id = idColumn(dialect)

  return [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS users (
      ${id},
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS consultations (
      ${id},
      reference TEXT NOT NULL UNIQUE,
      reference_raw TEXT,
      objet TEXT,
      acheteur TEXT,
      acheteur_service TEXT,
      categorie TEXT,
      nature_prestation TEXT,
      lieu_execution TEXT,
      procedure_type TEXT,
      mode_passation TEXT,
      date_publication TEXT,
      date_limite TEXT,
      heure_limite TEXT,
      date_ouverture_plis TEXT,
      estimation_cents INTEGER,
      caution_provisoire_cents INTEGER,
      qualification TEXT,
      agrement TEXT,
      lots_count INTEGER NOT NULL DEFAULT 0,
      date_annulation TEXT,
      motif_annulation TEXT,
      detail_url TEXT,
      source_url TEXT,
      source_id TEXT,
      search_text TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      has_result INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      content_hash TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS consultation_articles (
      ${id},
      consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      consultation_reference TEXT NOT NULL,
      lot_number TEXT,
      article_number TEXT,
      designation TEXT NOT NULL,
      description TEXT,
      categorie TEXT,
      quantity REAL,
      unit TEXT,
      unit_price_cents INTEGER,
      estimation_cents INTEGER,
      caution_cents INTEGER,
      tva_rate REAL,
      garanties TEXT,
      delai_execution TEXT,
      lieu_execution TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (consultation_id, lot_number, article_number, designation)
    )`,

    `CREATE TABLE IF NOT EXISTS consultation_results (
      ${id},
      reference TEXT NOT NULL UNIQUE,
      reference_raw TEXT,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      objet TEXT,
      acheteur TEXT,
      categorie TEXT,
      nature_prestation TEXT,
      lieu_execution TEXT,
      procedure_type TEXT,
      date_publication_resultat TEXT,
      date_attribution TEXT,
      attributaire TEXT,
      attributaire_ice TEXT,
      montant_attribue_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'MAD',
      nombre_offres INTEGER,
      result_status TEXT,
      detail_url TEXT,
      source_url TEXT,
      search_text TEXT,
      raw_json TEXT,
      content_hash TEXT,
      matched_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS result_lots (
      ${id},
      result_id INTEGER NOT NULL REFERENCES consultation_results(id) ON DELETE CASCADE,
      consultation_reference TEXT NOT NULL,
      lot_number TEXT,
      designation TEXT,
      attributaire TEXT,
      attributaire_ice TEXT,
      montant_cents INTEGER,
      lot_status TEXT,
      nombre_offres INTEGER,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (result_id, lot_number)
    )`,

    `CREATE TABLE IF NOT EXISTS favorites (
      ${id},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      consultation_reference TEXT NOT NULL,
      note TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, consultation_reference)
    )`,

    `CREATE TABLE IF NOT EXISTS invoices (
      ${id},
      invoice_number TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      consultation_reference TEXT,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      client_name TEXT NOT NULL,
      client_ice TEXT,
      client_address TEXT,
      issue_date TEXT NOT NULL,
      due_date TEXT,
      currency TEXT NOT NULL DEFAULT 'MAD',
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      pdf_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS invoice_items (
      ${id},
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      consultation_article_id INTEGER REFERENCES consultation_articles(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      lot_number TEXT,
      designation TEXT NOT NULL,
      description TEXT,
      unit TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      line_total_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS scrape_jobs (
      ${id},
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      triggered_by TEXT,
      params_json TEXT,
      pages_scraped INTEGER NOT NULL DEFAULT 0,
      items_found INTEGER NOT NULL DEFAULT 0,
      items_created INTEGER NOT NULL DEFAULT 0,
      items_updated INTEGER NOT NULL DEFAULT 0,
      matches_linked INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    )`,
  ]
}

export function indexStatements() {
  return [
    'CREATE INDEX IF NOT EXISTS idx_consultations_acheteur ON consultations (acheteur)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_categorie ON consultations (categorie)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_nature ON consultations (nature_prestation)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_lieu ON consultations (lieu_execution)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_publication ON consultations (date_publication)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_limite ON consultations (date_limite)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_status ON consultations (status)',
    'CREATE INDEX IF NOT EXISTS idx_articles_consultation ON consultation_articles (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_articles_reference ON consultation_articles (consultation_reference)',
    'CREATE INDEX IF NOT EXISTS idx_results_consultation ON consultation_results (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_results_acheteur ON consultation_results (acheteur)',
    'CREATE INDEX IF NOT EXISTS idx_results_categorie ON consultation_results (categorie)',
    'CREATE INDEX IF NOT EXISTS idx_results_publication ON consultation_results (date_publication_resultat)',
    'CREATE INDEX IF NOT EXISTS idx_result_lots_result ON result_lots (result_id)',
    'CREATE INDEX IF NOT EXISTS idx_result_lots_reference ON result_lots (consultation_reference)',
    'CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_favorites_reference ON favorites (consultation_reference)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_reference ON invoices (consultation_reference)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_scrape_jobs_source ON scrape_jobs (source, started_at)',
  ]
}

/**
 * Columns added after a table's first release.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
 * column added to the definition above never reaches a database created by an
 * earlier version — it fails at write time with "table X has no column named Y",
 * long after deploy reported success. Every column added later must also be
 * listed here.
 *
 * Additive only, and applied when missing, so running this on every boot is
 * idempotent.
 */
export function additiveColumns() {
  return [
    // 2026-09-06.002 — an avis can be published and then withdrawn, and the
    // portal publishes a VAT rate and required warranties per article.
    { table: 'consultations', column: 'date_annulation', definition: 'TEXT' },
    { table: 'consultations', column: 'motif_annulation', definition: 'TEXT' },
    { table: 'consultation_articles', column: 'tva_rate', definition: 'REAL' },
    { table: 'consultation_articles', column: 'garanties', definition: 'TEXT' },
  ]
}

export const SCHEMA_VERSION = '2026-09-06.002'
