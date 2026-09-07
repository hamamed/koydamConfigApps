import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAmountToCentimes, formatAmount, applyRate, lineTotalCentimes, toCentimes } from '../src/utils/money.js'
import { parseDate, parseTime, parseDateTime, isIsoDate } from '../src/utils/dates.js'
import { normalizeReference, normalize, extractReference, splitLabelled } from '../src/utils/text.js'
import { toPositionalPlaceholders, buildWhere, buildUpsert } from '../src/db/sql.js'

test('parses the French amount formats used by the portal', () => {
  assert.equal(parseAmountToCentimes('1 250 000,00 DH'), 125_000_000)
  assert.equal(parseAmountToCentimes('4 250,50'), 425_050)
  assert.equal(parseAmountToCentimes('1.234.567,89 MAD'), 123_456_789)
  assert.equal(parseAmountToCentimes('1234567.89'), 123_456_789)
  assert.equal(parseAmountToCentimes('9 500'), 950_000)
  assert.equal(parseAmountToCentimes(''), null)
  assert.equal(parseAmountToCentimes('non communiqué'), null)
})

test('money arithmetic stays exact in centimes', () => {
  assert.equal(toCentimes(1250.5), 125_050)
  assert.equal(lineTotalCentimes(3, 10.1 * 100), 3030)
  assert.equal(applyRate(100_000, 20), 20_000)
  assert.equal(applyRate(33_333, 20), 6_667)
})

test('formats amounts with the fr-MA convention', () => {
  const formatted = formatAmount(125_000_000, 'MAD')
  assert.match(formatted, /1[\s.\u202f]?250[\s.\u202f]?000,00 MAD/)
  // Formatting must round-trip back through the parser.
  assert.equal(parseAmountToCentimes(formatted), 125_000_000)
  assert.equal(formatAmount(null), '')
})

test('parses portal date and time formats into ISO strings', () => {
  assert.equal(parseDate('12/05/2026'), '2026-05-12')
  assert.equal(parseDate('02/06/2026 à 10 h 30'), '2026-06-02')
  assert.equal(parseDate('2026-06-02'), '2026-06-02')
  assert.equal(parseDate('32/13/2026'), null)
  assert.equal(parseTime('02/06/2026 à 10 h 30'), '10:30')
  assert.equal(parseTime('05/06/2026 à 09:00'), '09:00')
  assert.equal(parseDateTime('02/06/2026 à 10 h 30'), '2026-06-02T10:30:00')
  assert.equal(isIsoDate('2026-06-02'), true)
  assert.equal(isIsoDate('02/06/2026'), false)
})

test('the match key pairs a reference with its buyer', async () => {
  const { matchKey } = await import('../src/utils/text.js')
  assert.equal(matchKey('07/2026', 'Commune IZEMMOUREN'), '07/2026|communeizemmouren')
  // Same reference, different buyer — a different avis entirely.
  assert.notEqual(matchKey('07/2026', 'Commune A'), matchKey('07/2026', 'Commune B'))
  assert.equal(matchKey('07/2026', ''), null, 'a reference alone is not a key')
  assert.equal(matchKey('', 'Commune'), null)
})

test('normalises references so both datasets join on the same key', () => {
  assert.equal(normalizeReference('AOO 12/2026'), 'AOO12/2026')
  assert.equal(normalizeReference(' aoo  12 / 2026 '), 'AOO12/2026')
  assert.equal(normalizeReference('AOO_12/2026'), 'AOO12/2026')
  // Real portal data: an avis published with a leading separator must resolve to
  // the same key as its award, which carries no such prefix.
  assert.equal(normalizeReference('/69/2026/ISTAHTT'), '69/2026/ISTAHTT')
  assert.equal(normalizeReference('69/2026/ISTAHTT'), normalizeReference('/69/2026/ISTAHTT'))
  assert.equal(normalizeReference('53/2026-'), '53/2026')
  assert.equal(extractReference('Consultation AOO 12/2026 - fournitures'), 'CONSULTATION')
})

test('normalises accents for free-text search', () => {
  assert.equal(normalize('Marché de Fès  '), 'marche de fes')
  assert.deepEqual(splitLabelled('Acheteur : Commune de Fès'), ['Acheteur', 'Commune de Fès'])
})

test('rewrites placeholders for PostgreSQL without touching string literals', () => {
  assert.equal(toPositionalPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2')
  assert.equal(toPositionalPlaceholders("SELECT '?' AS q WHERE a = ?"), "SELECT '?' AS q WHERE a = $1")
})

test('builds parameterised WHERE clauses and skips inactive filters', () => {
  const { sql, params } = buildWhere([['a = ?', 1], false, ['b LIKE ?', '%x%'], null])
  assert.equal(sql, ' WHERE a = ? AND b LIKE ?')
  assert.deepEqual(params, [1, '%x%'])
})

test('builds an upsert that preserves the conflict key', () => {
  const { sql, params } = buildUpsert('t', { reference: 'R', objet: 'O' }, ['reference'])
  assert.match(sql, /ON CONFLICT \(reference\) DO UPDATE SET objet = excluded\.objet/)
  assert.deepEqual(params, ['R', 'O'])
})

test('an additive column migration reaches a database created by an earlier version', async () => {
  const { createSqliteDriver } = await import('../src/db/drivers/sqlite.js')
  const { initDatabase } = await import('../src/db/init.js')
  const { additiveColumns } = await import('../src/db/schema.js')

  const db = createSqliteDriver({ file: ':memory:' })

  // A table that predates the columns added later. `CREATE TABLE IF NOT EXISTS`
  // is a no-op against it, so only the ALTER pass can fix it — without one the
  // failure surfaces at write time as "no column named date_annulation", well
  // after the deploy reported success.
  await db.exec(`CREATE TABLE consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL UNIQUE,
    reference TEXT NOT NULL,
    match_key TEXT,
    objet TEXT, acheteur TEXT, categorie TEXT, nature_prestation TEXT,
    lieu_execution TEXT, date_publication TEXT, date_limite TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)

  await initDatabase(db)

  const columns = new Set((await db.all('PRAGMA table_info(consultations)')).map((row) => row.name))
  assert.ok(columns.has('date_annulation'))
  assert.ok(columns.has('motif_annulation'))

  // Running again must change nothing.
  await initDatabase(db)
  for (const { table, column } of additiveColumns()) {
    const present = new Set((await db.all(`PRAGMA table_info(${table})`)).map((row) => row.name))
    assert.ok(present.has(column), `${table}.${column} is missing`)
  }

  await db.close()
})
