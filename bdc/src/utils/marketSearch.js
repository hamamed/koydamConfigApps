/**
 * Where to look for an article on the Moroccan market.
 *
 * These are outbound search links, opened by the reader in their own browser:
 * nothing here fetches, stores or republishes a retailer's data, so no site's
 * terms are engaged by using them.
 *
 * Every search path below was tested against the live shop rather than guessed
 * from its platform — the same query returns results on some as `?s=`, on
 * others as `/catalogsearch/result/?q=`, and on one as a PrestaShop
 * controller. Three of them refuse an automated request altogether, so their
 * pattern could not be confirmed; those are reached through a site-restricted
 * web search instead, which works whatever their URLs turn out to be. A link
 * that 404s is worse than no link.
 */

/** A search restricted to one shop, for shops whose own URLs we cannot verify. */
const viaWeb = (host) => (query) =>
  `https://www.google.com/search?gl=ma&hl=fr&q=${encodeURIComponent(`site:${host} ${query}`)}`

/**
 * The shops, each tagged with what it actually sells.
 *
 * `general` shops are offered for every article; the rest only when the
 * article looks like their trade, because a bookshop is noise under a
 * consignment of cement and a builders' merchant is noise under a novel.
 */
const MARKETPLACES = Object.freeze([
  // ---- general marketplaces -------------------------------------------
  Object.freeze({
    key: 'jumia', label: 'Jumia', kinds: ['general'],
    search: (query) => `https://www.jumia.ma/catalog/?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'marjane', label: 'Marjane', kinds: ['general'],
    // Trailing slash, as on its sibling site: the same platform serves the
    // slashless path a redirect. Neither this shop nor Avito answers an
    // automated request, so both were checked by shape rather than by
    // fetching them.
    search: (query) => `https://www.marjane.ma/catalogsearch/result/?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'marjanemall', label: 'Marjane Mall', kinds: ['general', 'it'],
    search: (query) => `https://www.marjanemall.ma/catalogsearch/result/?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'avito', label: 'Avito', kinds: ['general'],
    search: (query) => `https://www.avito.ma/fr/maroc/à_vendre?q=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'google', label: 'Google Shopping', kinds: ['general'],
    // Moroccan sellers only: a price in euros from France is not an answer to
    // "what does this cost here".
    search: (query) => `https://www.google.com/search?tbm=shop&gl=ma&hl=fr&q=${encodeURIComponent(query)}`,
  }),

  // ---- computers, hardware, electronics --------------------------------
  Object.freeze({
    key: 'ultrapc', label: 'UltraPC', kinds: ['it'],
    search: (query) => `https://www.ultrapc.ma/?s=${encodeURIComponent(query)}&post_type=product`,
  }),
  Object.freeze({
    key: 'purehardware', label: 'PureHardware', kinds: ['it'],
    search: (query) => `https://purehardware.ma/?s=${encodeURIComponent(query)}&post_type=product`,
  }),
  Object.freeze({
    key: 'highsense', label: 'HighSense Gaming', kinds: ['it'],
    search: (query) => `https://highsense-gaming.com/?s=${encodeURIComponent(query)}&post_type=product`,
  }),
  // Refuses automated requests, so its own search path could not be checked.
  Object.freeze({ key: 'setupgame', label: 'SetupGame', kinds: ['it'], search: viaWeb('setupgame.ma') }),
  Object.freeze({ key: 'iris', label: 'Iris', kinds: ['it'], search: viaWeb('iris.ma') }),

  // ---- books ------------------------------------------------------------
  Object.freeze({
    key: 'mabooko', label: 'Mabooko', kinds: ['books'],
    search: (query) => `https://mabooko.com/index.php?controller=search&s=${encodeURIComponent(query)}`,
  }),
  Object.freeze({
    key: 'almihbara', label: 'Al Mihbara', kinds: ['books'],
    search: (query) => `https://almihbara.ma/?s=${encodeURIComponent(query)}&post_type=product`,
  }),

  // ---- tools, hardware, building ---------------------------------------
  Object.freeze({
    key: 'bricoma', label: 'Bricoma', kinds: ['tools'],
    search: (query) => `https://www.bricoma.ma/catalogsearch/result/?q=${encodeURIComponent(query)}`,
  }),

  // ---- cameras and photography ------------------------------------------
  Object.freeze({
    key: 'rabattech', label: 'Rabat Tech Store', kinds: ['photo', 'it'],
    search: (query) => `https://rabattechstore.ma/?s=${encodeURIComponent(query)}&post_type=product`,
  }),
  // A hand-built site with no search endpoint of its own.
  Object.freeze({ key: 'saymonshop', label: 'SaymonShop', kinds: ['photo'], search: viaWeb('saymonshop.com') }),
])

/**
 * What trade an article belongs to, from the words the notice uses.
 *
 * First match wins, and the order matters: "toner pour photocopieuse" is
 * office supply before it is anything else, and "objectif" is a lens here
 * rather than an aim.
 */
const KINDS = Object.freeze([
  ['photo', /\b(appareil photo|camera|caméra|objectif|obturateur|tr[ée]pied|gimbal|stabilisateur|drone|flash|softbox|reflex|mirrorless|photographi|vid[ée]o surveillance|camescope)/i],
  ['books', /\b(livre|livres|ouvrage|ouvrages|manuel scolaire|roman|dictionnaire|encyclop[ée]die|revue|abonnement|biblioth[èe]que|كتاب)/i],
  ['it', /\b(ordinateur|pc\b|laptop|portable|serveur|imprimante|photocopieu|toner|cartouche|scanner|[ée]cran|moniteur|clavier|souris|disque dur|ssd|ram\b|processeur|carte m[èe]re|onduleur|switch|routeur|r[ée]seau|projecteur|tablette|smartphone|logiciel|licence|antivirus|cl[ée] usb)/i],
  ['tools', /\b(outil|outillage|perceuse|visseuse|meuleuse|marteau|tournevis|[ée]chelle|[ée]chafaudage|peinture|ciment|b[ée]ton|quincaillerie|tuyau|robinet|sanitaire|plomberie|menuiserie|soudure|disjoncteur|c[âa]ble|luminaire|lampe|led|climatiseur|groupe [ée]lectrog[èe]ne|pompe)/i],
])

/**
 * @param {string} designation
 * @returns {string} one of 'photo', 'books', 'it', 'tools', or 'general'.
 */
export function articleKind(designation) {
  const text = String(designation ?? '')
  const hit = KINDS.find(([, pattern]) => pattern.test(text))
  return hit ? hit[0] : 'general'
}

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
 * Where to look for this particular article.
 *
 * The shops that deal in its trade first, then the general marketplaces —
 * so a consignment of toner offers UltraPC before Bricoma, and a pallet of
 * cement the other way round.
 *
 * @param {string} designation
 * @returns {Array<{key: string, label: string, url: string, specialist: boolean}>}
 *   an empty list when the wording holds nothing a shop could search for.
 */
export function marketLinks(designation) {
  const query = searchQuery(designation)
  if (!query) return []

  const kind = articleKind(designation)
  const wanted = MARKETPLACES.filter((shop) => shop.kinds.includes(kind) || shop.kinds.includes('general'))
  const ordered = [
    ...wanted.filter((shop) => shop.kinds.includes(kind) && kind !== 'general'),
    ...wanted.filter((shop) => !(shop.kinds.includes(kind) && kind !== 'general')),
  ]

  return ordered.map((shop) => ({
    key: shop.key,
    label: shop.label,
    url: shop.search(query),
    specialist: shop.kinds.includes(kind) && kind !== 'general',
  }))
}

export { MARKETPLACES }
