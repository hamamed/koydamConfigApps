/**
 * Schema definition shared by both engines.
 *
 * Portability rules applied throughout:
 *  - Dates and timestamps are stored as ISO-8601 TEXT ("YYYY-MM-DD",
 *    "YYYY-MM-DDTHH:mm:ss.sssZ"). Lexicographic ordering equals chronological
 *    ordering, so range filters behave identically on SQLite and PostgreSQL.
 *  - Booleans are INTEGER 0/1.
 *  - Money is INTEGER centimes (see utils/money.js).
 *  - Identity is the portal's own id, never the reference. Each buyer numbers
 *    its own avis, so "07/2026" appears once per commune — three times in five
 *    pages of the live listing. `reference` is indexed but not unique.
 *  - Awards carry no id and no detail page, so they are keyed on a hash of
 *    (reference, buyer, result date) and linked to a consultation through
 *    `match_key`. See utils/text.js#matchKey.
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
      source_id TEXT NOT NULL UNIQUE,
      reference TEXT NOT NULL,
      reference_raw TEXT,
      match_key TEXT,
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
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      date_annulation TEXT,
      motif_annulation TEXT,
      detail_url TEXT,
      detail_scraped_at TEXT,
      source_url TEXT,
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
    `CREATE TABLE IF NOT EXISTS article_translations (
      ${id},
      article_id INTEGER NOT NULL REFERENCES consultation_articles(id) ON DELETE CASCADE,
      locale TEXT NOT NULL,
      designation TEXT,
      description TEXT,
      -- Which model produced it, so a later upgrade can be told apart from a
      -- cached answer and re-run if it is ever worth re-translating.
      model TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (article_id, locale)
    )`,

    `CREATE TABLE IF NOT EXISTS consultation_documents (
      ${id},
      consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_name TEXT,
      url TEXT NOT NULL,
      source_file_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (consultation_id, url)
    )`,

    `CREATE TABLE IF NOT EXISTS consultation_results (
      ${id},
      result_key TEXT NOT NULL UNIQUE,
      reference TEXT NOT NULL,
      reference_raw TEXT,
      match_key TEXT,
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
      consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      note TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, consultation_id)
    )`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      ${id},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- The token is stored hashed. A reset link is a bearer credential; a
      -- database copy, a backup or a log line of the raw value would be enough
      -- to take over the account.
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`,

    // Somebody asking for an account. Access is by invitation — there is no
    // self-service registration — so without this the only way in was an e-mail
    // address on a landing page, which nothing tracked and nobody could audit.
    `CREATE TABLE IF NOT EXISTS access_requests (
      ${id},
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      ice TEXT,
      phone TEXT,
      reason TEXT,
      -- 'pending' | 'approved' | 'rejected'
      status TEXT NOT NULL DEFAULT 'pending',
      -- Kept for abuse triage: a burst from one address is the thing this table
      -- will see first. Not shown outside the admin screen.
      source_ip TEXT,
      review_note TEXT,
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    )`,

    // What is known about a company beyond the name the portal prints.
    //
    // The portal publishes no ICE, no address and no registry number for a
    // winning company — 0 of 21,748 award rows carry one — and Morocco has no
    // open company register to join against: OMPIC's data is sold through
    // DirectInfo, and OpenCorporates needs a key. So this is a store, not a
    // mirror: each row is something an administrator recorded or confirmed,
    // with where it came from and when it was checked.
    `CREATE TABLE IF NOT EXISTS company_records (
      ${id},
      -- The attributaire string exactly as the portal prints it, which is the
      -- only identifier a company has in this data.
      name TEXT NOT NULL UNIQUE,
      ice TEXT,
      registry_number TEXT,
      legal_form TEXT,
      address TEXT,
      city TEXT,
      phone TEXT,
      website TEXT,
      notes TEXT,
      -- Where this came from: 'manual', or the adapter that proposed it.
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT,
      -- Set only when a person confirmed it. A row proposed by a lookup and
      -- never reviewed is a guess, and the profile page says so.
      verified_at TEXT,
      verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS saved_searches (
      ${id},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      -- What this search watches for: new projects matching it, awards matching
      -- it, or deadlines approaching on what the user already tracks.
      notify_new INTEGER NOT NULL DEFAULT 1,
      notify_awards INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_notified_at TEXT,
      -- The high-water mark: rows first seen after this have not been sent yet.
      last_seen_cursor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS notifications (
      ${id},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      saved_search_id INTEGER REFERENCES saved_searches(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      payload_json TEXT,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS invoices (
      ${id},
      invoice_number TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
    `CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
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
      -- Per-source counts for the run, so the dashboard can say how many
      -- projects and how many awards a crawl actually brought in. The flat
      -- columns above only carry the combined total.
      detail_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    )`,
  ]
}
export function indexStatements() {
  return [
    'CREATE INDEX IF NOT EXISTS idx_consultations_reference ON consultations (reference)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_match_key ON consultations (match_key)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_acheteur ON consultations (acheteur)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_categorie ON consultations (categorie)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_nature ON consultations (nature_prestation)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_lieu ON consultations (lieu_execution)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_publication ON consultations (date_publication)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_limite ON consultations (date_limite)',
    'CREATE INDEX IF NOT EXISTS idx_consultations_status ON consultations (status)',
    'CREATE INDEX IF NOT EXISTS idx_articles_consultation ON consultation_articles (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_documents_consultation ON consultation_documents (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_translations_article ON article_translations (article_id, locale)',
    'CREATE INDEX IF NOT EXISTS idx_results_reference ON consultation_results (reference)',
    'CREATE INDEX IF NOT EXISTS idx_results_match_key ON consultation_results (match_key)',
    'CREATE INDEX IF NOT EXISTS idx_results_consultation ON consultation_results (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_results_acheteur ON consultation_results (acheteur)',
    'CREATE INDEX IF NOT EXISTS idx_results_categorie ON consultation_results (categorie)',
    'CREATE INDEX IF NOT EXISTS idx_results_publication ON consultation_results (date_publication_resultat)',
    'CREATE INDEX IF NOT EXISTS idx_result_lots_result ON result_lots (result_id)',
    'CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_favorites_consultation ON favorites (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_consultation ON invoices (consultation_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id)',
    'CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches (user_id, is_active)',
    'CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_company_records_ice ON company_records (ice)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status, created_at)',
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
    // 2026-09-06.007 — the portal publishes attachments, and a run's per-source
    // counts are worth keeping.
    { table: 'scrape_jobs', column: 'detail_json', definition: 'TEXT' },
    // 2026-09-06.002 — an avis can be published and then withdrawn, and the
    // portal publishes a VAT rate and required warranties per article.
    { table: 'consultations', column: 'is_cancelled', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'consultations', column: 'date_annulation', definition: 'TEXT' },
    { table: 'consultations', column: 'motif_annulation', definition: 'TEXT' },
    { table: 'consultations', column: 'detail_scraped_at', definition: 'TEXT' },
    { table: 'consultation_articles', column: 'tva_rate', definition: 'REAL' },
    { table: 'consultation_articles', column: 'garanties', definition: 'TEXT' },
  ]
}
export const SCHEMA_VERSION = '2026-09-07.012'
