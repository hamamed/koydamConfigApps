import * as cheerio from 'cheerio'
import { clean, cleanOrNull } from '../../utils/text.js'

/**
 * The Ministry of Equipment's register of BTP companies qualified and classified
 * for public works.
 *
 * This is the one official, free, login-free Moroccan source that carries the
 * things an award row never does: a trade-register number, a street address, a
 * city and a telephone. Each row is a block of loose markup rather than one cell
 * per field, so it is read by shape — bold name, then address, then labelled
 * `Ville :`, `Tél :` and `Fax :` — with the register number taken from the
 * detail link, which is where the portal itself puts it.
 */

/** The "Afficher" link carries the register number and the city. */
const DETAIL = /[?&]NRC=(\d+)(?:&Ville=([^"&]*))?/i
const TOTAL = /Nombre d'entreprises trouv[ée]es\s*:?\s*([\d\s]+)/i

export function parseBtpList(html, sourceUrl = '') {
  const $ = cheerio.load(html)
  const items = []

  $('a[href*="NRC="]').each((_index, element) => {
    const link = $(element)
    const match = (link.attr('href') ?? '').match(DETAIL)
    if (!match) return

    // The name, address and contact line live in an earlier cell of the same row.
    const row = link.closest('tr')
    const block = row.find('td').filter((_i, cell) => $(cell).find('b').length > 0).first()
    const name = clean(block.find('b').first().text())
    if (!name) return

    items.push({
      raison_sociale: name,
      registre_commerce: match[1],
      ville: cleanOrNull(decodeURIComponent(match[2] ?? '')) ?? labelled(block.text(), 'Ville'),
      adresse: addressOf($, block),
      telephone: labelled(block.text(), 'Tél'),
      fax: labelled(block.text(), 'Fax'),
      // The qualification code the ministry assigns, e.g. "AH/30".
      code: cleanOrNull(row.find('td.codeEntrep2').first().text()),
      source_url: sourceUrl || null,
    })
  })

  return { items, total: readTotal($), pager: pagerTargets($), sourceUrl }
}

/**
 * The street address: the text between the company name and the `Ville :`
 * label. Taken from the raw HTML of the block rather than its text, because the
 * only thing separating the two is a <br>.
 */
function addressOf($, block) {
  const html = block.html() ?? ''
  const afterName = html.split(/<\/b>/i).slice(1).join('</b>')
  const beforeCity = afterName.split(/<b>\s*Ville/i)[0] ?? ''
  const text = cheerio.load(`<div>${beforeCity}</div>`)('div').text()
  return cleanOrNull(text)
}

/** Reads `Label : value` out of the contact line. */
function labelled(text, label) {
  const match = text.match(new RegExp(`${label}\\s*:\\s*([^-\\n]*)`, 'i'))
  return match ? cleanOrNull(match[1]) : null
}

/**
 * The pager's postback targets, keyed by the page number they show.
 *
 * The window slides as you advance, so "the third link" means different pages
 * on different pages. Keying by the label is what a reader does, and it is the
 * only thing that stays true.
 */
function pagerTargets($) {
  const targets = {}
  $('a[href*="__doPostBack"]').each((_index, element) => {
    const label = clean($(element).text())
    const match = ($(element).attr('href') ?? '').match(/__doPostBack\('([^']+)'/)
    if (match && /^\d+$/.test(label)) targets[label] = match[1].replace(/&#39;/g, "'")
  })
  return targets
}

function readTotal($) {
  const match = $.root().text().match(TOTAL)
  return match ? Number(match[1].replace(/\s/g, '')) : null
}
