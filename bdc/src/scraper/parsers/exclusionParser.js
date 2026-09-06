import * as cheerio from 'cheerio'
import { clean, cleanOrNull } from '../../utils/text.js'
import { parseDate } from '../../utils/dates.js'

/**
 * The official list of companies excluded from public procurement.
 *
 * Read by the `headers` attribute on each cell rather than by column position.
 * The portal marks every cell with the field it holds — `registreCommerce`,
 * `motif`, `dateDebutExclusion` — which is a contract that survives a column
 * being added or reordered. Positional parsing of this table would break the
 * first time somebody inserted a column, silently and in a way that looks like
 * a data change rather than a bug.
 */

/** The date cell packs three facts: start, end, and how wide the ban is. */
const START = /D\s*:\s*(\d{2}\/\d{2}\/\d{4})/
const END = /F\s*:\s*(\d{2}\/\d{2}\/\d{4})/
const SCOPE = /Port[ée]e\s+(\w+)/i
/** The download link carries the decision document's id. */
const DOCUMENT_ID = /[?&]id=(\d+)/

export function parseExclusionList(html, sourceUrl = '') {
  const $ = cheerio.load(html)
  const items = []

  $('table tr').each((_index, element) => {
    const row = $(element)
    if (row.find('td').length === 0) return

    const cell = (name) => row.find(`td[headers="${name}"]`)
    const text = (name) => clean(cell(name).text())

    const raisonSociale = text('libelleFournisseur')
    const entitePublique = text('entitePublique')
    // A row with neither is the "no results" placeholder, not an exclusion.
    if (!raisonSociale && !entitePublique) return

    const dates = cell('dateDebutExclusion').text()
    const documentHref = cell('document').find('a').attr('href') ?? ''

    items.push({
      raison_sociale: raisonSociale,
      entite_publique: entitePublique || null,
      registre_commerce: cleanOrNull(text('registreCommerce')),
      motif: cleanOrNull(text('motif')),
      date_debut: parseDate(dates.match(START)?.[1] ?? null),
      date_fin: parseDate(dates.match(END)?.[1] ?? null),
      portee: cleanOrNull(dates.match(SCOPE)?.[1] ?? null),
      document_id: documentHref.match(DOCUMENT_ID)?.[1] ?? null,
      source_url: sourceUrl || null,
    })
  })

  return { items, total: readTotal($), sourceUrl }
}

/**
 * How many the portal says there are, which is what a run is judged against —
 * a parser that returns 12 of 290 has failed, and only this number says so.
 */
function readTotal($) {
  const label = $('*:contains("Nombre de résultats")').last().text()
  const match = label.match(/Nombre de r[ée]sultats\s*:?\s*([\d\s]+)/)
  if (match) return Number(match[1].replace(/\s/g, ''))
  const span = clean($('[id$="nombreResultat"], [id*="nombreRe"]').first().text())
  return span ? Number(span.replace(/\s/g, '')) : null
}
