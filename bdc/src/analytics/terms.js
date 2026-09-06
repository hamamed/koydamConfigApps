import { normalize } from '../utils/text.js'

/**
 * Turning an avis into the handful of words worth matching other avis on.
 *
 * Award rows carry no category — the portal publishes one on a consultation and
 * not on its result, which was verified across ten thousand of them — so the
 * only thing two pieces of work can be compared on is what they are called.
 *
 * Two kinds of word are dropped. Ordinary French stopwords carry no meaning
 * anywhere; procurement boilerplate ("achat", "fourniture", "prestation",
 * "profit") appears in a large share of every objet on the portal and so
 * separates nothing while crowding out the words that do. What is left is the
 * subject: "rechanges", "telephonique", "carrieres".
 */
const STOPWORDS = new Set([
  'au', 'aux', 'avec', 'ce', 'ces', 'dans', 'de', 'des', 'du', 'en', 'et', 'la', 'le', 'les', 'lot',
  'ou', 'par', 'pour', 'sur', 'un', 'une', 'the', 'of', 'and', 'for', 'ses', 'son', 'leur', 'sous',
  // Boilerplate: present in a large fraction of every objet, so it separates nothing.
  'achat', 'achats', 'acquisition', 'fourniture', 'fournitures', 'livraison', 'prestation', 'prestations',
  'travaux', 'service', 'services', 'marche', 'marches', 'commande', 'commandes', 'bons',
  'profit', 'divers', 'compte', 'objet', 'relatif', 'relative', 'suite', 'annee', 'annees',
  'commune', 'province', 'prefecture', 'centre', 'direction', 'ministere', 'delegation', 'region',
])

/** Shorter than this and a token is noise: "cd", "iii", "n". */
const MIN_LENGTH = 4
/** More than a handful and the match becomes so narrow nothing comes back. */
const MAX_TERMS = 6

/**
 * @param {string} text an objet, or anything describing the work.
 * @param {{maxTerms?: number, exclude?: string}} [options] `exclude` is text
 *   whose words must not become terms — in practice the buyer's name.
 * @returns {string[]} distinct significant terms, longest first — a longer word
 *   is the more specific one far more often than not, and with no corpus to
 *   compute IDF from that is the best proxy available.
 */
export function significantTerms(text, { maxTerms = MAX_TERMS, exclude = '' } = {}) {
  const seen = new Set()
  // Most objets name the buyer inside themselves — "achat de pièces de rechange
  // pour le centre hospitalier provincial de Khénifra" — and those words are the
  // longest ones in the sentence, so they win the ranking below and the
  // "comparable" set collapses into "everything that buyer bought". Whoever is
  // buying is not what is being bought.
  const banned = new Set(normalize(exclude).split(/[^a-z0-9]+/).filter(Boolean))
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_LENGTH && !STOPWORDS.has(word) && !banned.has(word) && !/^\d+$/.test(word))
    .filter((word) => (seen.has(word) ? false : seen.add(word)))
    .sort((a, b) => b.length - a.length)
    .slice(0, maxTerms)
}

/**
 * How many of `terms` must appear before two avis count as comparable.
 *
 * One shared word is a coincidence — every second avis mentions "materiel" — so
 * anything with room for a second match requires two.
 */
export const requiredMatches = (terms) => (terms.length >= 3 ? 2 : terms.length > 0 ? 1 : 0)
