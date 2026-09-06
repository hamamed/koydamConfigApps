/**
 * The handful of numbers the front door shows.
 *
 * Read at request time rather than cached: a landing page that claims a scale
 * the database no longer has is worse than one that claims none, and these are
 * four COUNT(*)s against indexed tables.
 */
export function createPublicService({ consultations, articles, results, analytics }) {
  async function stats() {
    const [avis, lines, awards, summary] = await Promise.all([
      consultations.countAll(),
      articles.countAll(),
      results.countAll(),
      analytics.summary({}),
    ])

    return [
      { label: 'public.stats.avis', value: format(avis) },
      { label: 'public.stats.articles', value: format(lines) },
      { label: 'public.stats.awards', value: format(awards) },
      { label: 'public.stats.buyers', value: format(summary.buyers) },
    ]
  }

  return { stats }
}

/** Thin space between groups: readable in all three locales, and not a comma,
 *  which means a decimal point to a French reader. */
const format = (value) => Number(value ?? 0).toLocaleString('fr-FR').replace(/ | /g, ' ')
