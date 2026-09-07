import * as cheerio from 'cheerio'
import { clean, normalize, normalizeReference } from '../../utils/text.js'
import { parseAmountToCentimes } from '../../utils/money.js'
import { parseDate, nowIso } from '../../utils/dates.js'

/**
 * The appel d'offres side of marchespublics.gov.ma.
 *
 * A different portal from the bons de commande listing, and a different
 * procedure: these are the marchés that go before a commission, get opened in
 * séance publique, and are awarded on the prix de référence of article 44. The
 * page is PRADO, so paging is a form postback rather than a query string, and
 * the state needed to make that postback is parsed out here alongside the rows.
 */

const PAGER_NEXT = 'ctl0$CONTENU_PAGE$resultSearch$PagerTop$ctl2'
const PAGE_SIZE_CONTROL = 'ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop'
const LISTING_URL = 'https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseAdvancedSearch&AllCons'

/** What free-text search matches on, normalised the same way a query is. */
const searchText = (row) =>
  normalize([row.reference_raw, row.objet, row.acheteur, row.lieu_execution, row.categorie].filter(Boolean).join(' '))

/**
 * Every hidden input on the page, which is what a PRADO postback has to echo
 * back — `PRADO_PAGESTATE` above all, a base64 blob the server uses to rebuild
 * the page it thinks you are on. Dropping any of it returns page 1 forever.
 * @returns {Record<string,string>}
 */
export function parseFormState(html) {
  const $ = cheerio.load(html)
  const state = {}
  $('input[type="hidden"][name]').each((_, node) => {
    state[$(node).attr('name')] = $(node).attr('value') ?? ''
  })
  return state
}

/** The controls a caller needs to drive the pager, so the scraper hardcodes none of them. */
export const POSTBACK = Object.freeze({ next: PAGER_NEXT, pageSize: PAGE_SIZE_CONTROL })

/**
 * How many consultations the search matched in total.
 * @returns {number|null} null when the portal prints no count, which is what a
 *   search with no results does — distinguishable from a genuine zero.
 */
export function parseTotal(html) {
  const $ = cheerio.load(html)
  const text = clean($.root().text())
  const match = text.match(/Nombre de r[ée]sultats\s*:?\s*([\d\s ]+)/i)
  if (!match) return null
  const digits = match[1].replace(/\D/g, '')
  return digits ? Number(digits) : null
}

/**
 * One page of the marchés listing.
 *
 * The listing is ordered by closing date descending, so the consultations still
 * open come first and the ones closing soonest sit at the *end* of that run.
 * A crawl that stops early therefore drops the most urgent rows, not the least
 * interesting ones — the caller decides when to stop, and is told each row's
 * deadline so it can.
 *
 * @returns {{items: object[], total: number|null}}
 */
export function parseMarcheList(html) {
  const $ = cheerio.load(html)
  const items = []

  // Rows are addressed by the hidden pair the portal puts in the first cell;
  // together they form the only stable identity a consultation has here, and
  // they are also exactly what the detail URL needs.
  $('input[name*="$refCons"]').each((_, node) => {
    const $row = $(node).closest('tr')
    if ($row.length === 0) return

    const reference = $(node).attr('name').replace(/\$refCons$/, '')
    const sourceId = clean($(node).attr('value'))
    const org = clean($row.find(`input[name="${reference}$orgCons"]`).attr('value'))
    if (!sourceId || !org) return

    const cells = $row.find('> td').toArray().map((cell) => $(cell))
    const record = readRow($, cells)
    if (!record) return

    const timestamp = nowIso()
    const row = {
      source_id: sourceId,
      org_acronyme: org,
      detail_url: detailUrl(sourceId, org),
      source_url: LISTING_URL,
      ...record,
      lots_count: 0,
      // The lifecycle `status` is derived elsewhere from awards and expired
      // deadlines; a listing pass that wrote it would reset "awarded" on every
      // crawl, so the scraper reports only what the portal itself prints.
      first_seen_at: timestamp,
      last_seen_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    }
    row.search_text = searchText(row)
    items.push(row)
  })

  return { items, total: parseTotal(html) }
}

/** The public detail URL for a consultation. No session is needed to read it. */
export const detailUrl = (sourceId, org) =>
  `https://www.marchespublics.gov.ma/?page=entreprise.EntrepriseDetailsConsultation` +
  `&refConsultation=${encodeURIComponent(sourceId)}&orgAcronyme=${encodeURIComponent(org)}`

/**
 * Reads the content cells of a result row.
 *
 * Positional rather than keyed, because the portal labels almost nothing: the
 * cells carry a procedure block, an objet block, a place block and a closing
 * block, in that order, and only "Objet :" and "Acheteur public :" are named.
 *
 * Each cell is read as its sequence of text nodes rather than as flattened
 * text. The layout puts every value in its own element, so the text nodes are
 * the values — while `clean()` on the whole cell collapses the newlines that
 * separated them and leaves one unsplittable run.
 */
function readRow($, cells) {
  // cells[0] is the checkbox column that holds the hidden identity inputs.
  const [, procedureCell, objetCell, lieuCell, closingCell] = cells
  if (!procedureCell || !objetCell || !closingCell) return null

  const procedure = textNodes(procedureCell)
  const objet = textNodes(objetCell)
  const lieu = lieuCell ? textNodes(lieuCell) : []
  const closing = textNodes(closingCell)

  const isDate = (line) => /^\d{2}\/\d{2}\/\d{4}$/.test(line)

  return {
    // The reference leads the objet cell; everything after it is prose.
    reference: normalizeReference(objet[0] ?? null),
    reference_raw: objet[0] ?? null,
    // The portal prints an ellipsised objet in the cell and the whole of it in
    // a tooltip beside it, so the longest candidate is the real one — taking
    // the cell's first prose line stores a sentence ending in "…".
    objet: longest(objet.filter((line) => !isLabel(line) && !isEllipsis(line) && line !== objet[0])),
    acheteur: after(objet, /^Acheteur public/i),
    // The portal prints both: a short code in the corner ("AOO") and the
    // procedure spelled out beneath it ("Appel d'offres ouvert").
    mode_passation: procedure[0] ?? null,
    procedure_type: procedure.find((line) => /offres|concours|n[ée]goci|consultation/i.test(line)) ?? null,
    categorie: procedure.find((line) => /^(travaux|fournitures|services)$/i.test(line)) ?? null,
    date_publication: parseDate(procedure.find(isDate)),
    // "MAROC, TETOUAN" — the joined form, not the two lines it is built from.
    lieu_execution: lieu.find((line) => line.includes(',')) ?? longest(lieu.filter((l) => !isEllipsis(l) && l !== '-')),
    date_limite: parseDate(closing.find(isDate)),
    heure_limite: closing.find((line) => /^\d{2}:\d{2}$/.test(line)) ?? null,
  }
}

/**
 * The text nodes under an element, in document order, cleaned and non-empty.
 * @returns {string[]}
 */
function textNodes(selection) {
  const out = []
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === 'text') {
        const value = clean(child.data)
        if (value) out.push(value)
      } else if (child.type === 'tag') {
        walk(child)
      }
    }
  }
  for (const node of selection.toArray()) walk(node)
  return out
}

/** The line following the first one matching `label`. */
function after(linesOfCell, label) {
  const index = linesOfCell.findIndex((line) => label.test(line))
  return index === -1 ? null : (linesOfCell[index + 1] ?? null)
}

const isLabel = (line) => /^(Objet|Acheteur public)\s*:?$/i.test(line)
/** The portal's own truncation marker, and the "…" it leaves behind. */
const isEllipsis = (line) => /^[.\u2026]{1,3}$/.test(line)

const longest = (candidates) =>
  candidates.filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? null

/**
 * The consultation detail page — the only place the estimate is published.
 *
 * This is what makes the article 44 calculator automatic: the maître
 * d'ouvrage's estimate is the input every threshold is computed from, and here
 * it is public, on a page that needs no session at all.
 */
export function parseMarcheDetail(html) {
  const $ = cheerio.load(html)
  const text = clean($('body').text())

  const estimation = text.match(/Estimation\s*\(en Dhs TTC\)[^:]*:\s*([\d\s .,]+)/i)

  return {
    estimation_cents: estimation ? parseAmountToCentimes(estimation[1]) : null,
    qualifications: labelled(text, 'Qualifications'),
    // The commission's own workings. The portal emits the container and fills
    // it only for a signed-in company that bid on this consultation, so an
    // anonymous crawl always reads it empty — the competitors' prices are not
    // public, for us or for anyone selling this.
    has_commission_block: /Bloc Suivi des travaux de la commission/.test(html),
    commission_rows: [],
  }
}

/** A "Label : value" pair from the detail page's flattened text. */
function labelled(text, label) {
  const match = text.match(new RegExp(`${label}\\s*\\**\\s*:?\\s*([^:]{1,160}?)(?:\\s{2,}|$)`, 'i'))
  const value = match ? clean(match[1]) : null
  return value && value !== '-' ? value : null
}
