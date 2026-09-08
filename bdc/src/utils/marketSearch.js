/**
 * Where to look for an article on the Moroccan market.
 *
 * These are outbound search links, opened by the reader in their own browser:
 * nothing here fetches, stores or republishes a retailer's data, so no site's
 * terms are engaged by using them. That matters — of the three retailers
 * checked, one publishes a robots.txt permitting identified crawlers but
 * disallows exactly the `?q=` search path a price lookup would need, and one
 * sits behind a bot challenge that will not serve robots.txt at all. A link
 * the reader clicks is the honest way to cover all of them.
 *
 * Ordered by how likely they are to carry what a bon de commande asks for:
 * general marketplaces first, then the specialists.
 */
const MARKETPLACES = Object.freeze([
  Object.freeze({
    key: 'jumia', label: 'Jumia',
    search: (query) => `https://www.jumia.ma/catalog/?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'marjane', label: 'Marjane',
    search: (query) => `https://www.marjane.ma/catalogsearch/result?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'electroplanet', label: 'Electroplanet',
    search: (query) => `https://www.electroplanet.ma/catalogsearch/result/?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'avito', label: 'Avito',
    search: (query) => `https://www.avito.ma/fr/maroc/à_vendre?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'google', label: 'Google Shopping',
    // Restricted to Moroccan sellers: an article priced in euros from France
    // is not an answer to "what does this cost here".
    search: (query) => `https://www.google.com/search?tbm=shop&gl=ma&hl=fr&q=${encodeURIComponent(query)}`,
  }),
])

/** Words that describe the paperwork, not the thing being bought. */
const NOISE = /\b(fourniture|fournitures|fournir|acquisition|achat|installation|pose|mise en (?:service|profil|oeuvre|œuvre)|livraison|prestation|travaux|realisation|réalisation|lot|n°|numero|numéro)\b/gi

/** Grammar. Kept out of the query so the noun is not buried behind it. */
const STOPWORDS = new Set([
  'la', 'le', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'et', 'ou', 'en', 'au', 'aux',
  'sur', 'sous', 'par', 'pour', 'avec', 'sans', 'dans', 'chez', 'y', 'compris', 'toutes', 'tous',
  'toute', 'tout', 'divers', 'autres', 'autre', 'bon', 'bonne', 'qualite', 'qualité', 'etat', 'état',
  // Counts belong in the quantity column, not in a shop's search box.
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'marque',
  'parfaite', 'parfait', 'sujestion', 'sujétion', 'sujetion', 'ainsi', 'que', 'qui', 'ce', 'cet',
])

/**
 * Where a designation stops describing the thing and starts describing the
 * job: everything after one of these is about where or why, not about what.
 */
const TAIL = /\s(?:au niveau|pour (?:le|la|les|l')|dans (?:le|la|les|l')|destin[ée]|y compris|selon|conform[ée]ment)\b[\s\S]*$/i

/**
 * Turns an article's wording into something a shop's search box can answer.
 *
 * A designation is written for a procurement file — "FOURNITURE ET
 * INSTALLATION DE DEUX (02) CLIMATISEURS AU NIVEAU DU LOCAL TECHNIQUE" — and
 * pasted whole into a retailer it returns nothing. What describes the job
 * rather than the thing comes off the end, the administrative verbs and the
 * grammar come out, and what is left is the noun somebody can actually search.
 *
 * @param {string} designation the article as the portal wrote it.
 * @param {number} [maxWords] how much of it to keep.
 * @returns {string} a query, or '' when nothing usable is left.
 */
export function searchQuery(designation, maxWords = 6) {
  const text = String(designation ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(TAIL, ' ')
    .replace(NOISE, ' ')
    .replace(/[^\p{L}\p{N}\s.+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''

  const words = text.split(' ').filter((word) => {
    if (word.length < 2) return false
    return !STOPWORDS.has(word.toLowerCase().replace(/[.,-]+$/, ''))
  })
  return words.slice(0, maxWords).join(' ')
}

/**
 * @param {string} designation
 * @returns {Array<{key: string, label: string, url: string}>} one link per
 *   marketplace, or an empty list when there is nothing worth searching for.
 */
export function marketLinks(designation) {
  const query = searchQuery(designation)
  if (!query) return []
  return MARKETPLACES.map((market) => ({ key: market.key, label: market.label, url: market.search(query) }))
}

export { MARKETPLACES }
