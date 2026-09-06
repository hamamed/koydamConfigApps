import test from 'node:test'
import assert from 'node:assert/strict'
import { parseExclusionList } from '../src/scraper/parsers/exclusionParser.js'
import { matchName } from '../src/repositories/exclusionRepository.js'
import { createTestContainer, fixture } from './helpers.js'
import { createHttpClient } from '../src/scraper/httpClient.js'

const PAGE = fixture('live-societes-exclues.html')

test('the exclusion list is read by cell name, not by column position', () => {
  const { items, total } = parseExclusionList(PAGE, 'https://www.marchespublics.gov.ma/x')

  assert.equal(items.length, 12)
  // The portal states its own count, and it is larger than this trimmed
  // fixture — which is exactly the mismatch the scraper is meant to notice.
  assert.equal(total, 290)

  assert.deepEqual(items[0], {
    raison_sociale: 'LA SOCIETE SOUFOUH ATLAS SARL',
    entite_publique: "MINISTERE DE L'AGRICULTURE, DE LA PECHE MARITIME, DU DEVELOPPEMENT RURAL ET DES EAUX ET FORETS",
    registre_commerce: '51-404/3117',
    motif: 'acte frauduleux',
    date_debut: '2012-02-15',
    date_fin: '2014-02-16',
    portee: 'totale',
    document_id: '4',
    source_url: 'https://www.marchespublics.gov.ma/x',
  })

  // Every row carries the company and the body that excluded it; those two are
  // what the record is keyed on.
  assert.ok(items.every((row) => row.raison_sociale && row.entite_publique))
})

test('a company is matched despite the legal form and the "société" prefix', () => {
  // The two sources name the same business differently, and neither publishes
  // an identifier the other has.
  const same = ['LA SOCIETE SOUFOUH ATLAS SARL', 'SOUFOUH ATLAS', 'Ste Soufouh Atlas S.A.R.L', 'société  soufouh atlas au']
  const keys = new Set(same.map(matchName))
  assert.equal(keys.size, 1, `all spellings collapse: ${[...keys].join(' | ')}`)
  assert.equal([...keys][0], 'soufouh atlas')

  // But two genuinely different companies must not collapse into one.
  assert.notEqual(matchName('LIBRAIRIE PAPETERIE IGMIR'), matchName('LIBRAIRIE PAPETERIE DE PARIS'))
})

test('the scraper posts the form back and stores what it reads', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  const posts = []
  const http = createHttpClient({
    delayMs: 0,
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') posts.push(Object.fromEntries(new URLSearchParams(init.body)))
      return {
        ok: true, status: 200, url: String(url),
        headers: { getSetCookie: () => ['PHPSESSID=test; path=/'] },
        text: async () => PAGE,
      }
    },
  })

  const { createExclusionScraper } = await import('../src/scraper/exclusionScraper.js')
  const scraper = createExclusionScraper({ http, exclusions: container.repositories.exclusions })
  const stats = await scraper.scrape()

  assert.equal(stats.itemsFound, 12)
  // Eleven rows, not twelve: two of the fixture's rows are the same company,
  // body, date and register number and differ only in the attached document —
  // one exclusion listed twice. The collapse is counted rather than silent.
  assert.equal(stats.itemsCreated, 11)
  assert.equal(stats.itemsCollapsed, 1)

  // Two postbacks: run the search, then ask for the whole list in one page.
  assert.equal(posts.length, 2)
  assert.ok(posts[0].PRADO_PAGESTATE, 'the view state is carried back')
  assert.match(posts[0].PRADO_POSTBACK_TARGET, /tableauRechercheSocietesExclues/)
  assert.match(posts[1].PRADO_POSTBACK_TARGET, /nbResultsTop/)
  assert.equal(posts[1]['ctl0$CONTENU_PAGE$tableauAffichageSocietesExclues$nbResultsTop'], '500')

  // The fixture is a trimmed page, so it reports fewer rows than the portal
  // says exist. A crawl that quietly returned 12 of 290 is the failure this
  // whole project keeps hitting; it is recorded, not swallowed.
  assert.equal(stats.portalTotal, 290)
  assert.match(stats.errors[0].message, /parsed 12 of 290/)

  // Re-reading the same list changes nothing.
  const again = await scraper.scrape()
  assert.equal(again.itemsCreated, 0)
  assert.equal(again.itemsUpdated, 0, 'a list that has not changed reports no changes')
  assert.equal(again.itemsUnchanged, 11)
})

test('an exclusion reaches the company it belongs to, and says whether it still bites', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  await container.repositories.exclusions.upsert({
    raison_sociale: 'LA SOCIETE SOUFOUH ATLAS SARL', entite_publique: 'MINISTERE X',
    registre_commerce: '51-404/3117', motif: 'acte frauduleux',
    date_debut: '2012-02-15', date_fin: '2014-02-16', portee: 'totale',
  })
  await container.repositories.exclusions.upsert({
    raison_sociale: 'Soufouh Atlas', entite_publique: 'AGENCE Y',
    motif: 'falsification', date_debut: '2026-01-01', date_fin: '2030-01-01', portee: 'partielle',
  })

  // Found under a different spelling from either of the stored ones.
  const found = await container.services.companyRecords.exclusionsFor('STE SOUFOUH ATLAS SARL AU', '2026-09-07')
  assert.equal(found.length, 2, 'both decisions, whichever way the name was written')
  assert.equal(found.filter((row) => row.active).length, 1, 'one is still in force, one has run out')
  assert.equal(found.find((row) => row.active).entite_publique, 'AGENCE Y')

  assert.equal(await container.repositories.exclusions.countActive('2026-09-07'), 1)
  assert.equal(await container.repositories.exclusions.countAll(), 2)
})
