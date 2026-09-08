import { serializeRow, serializeRows } from './serializers.js'
import { ValidationError } from '../utils/errors.js'
import { clean } from '../utils/text.js'

const FIELDS = ['ice', 'registry_number', 'legal_form', 'address', 'city', 'phone', 'website', 'notes']
const MAX = { ice: 40, registry_number: 60, legal_form: 80, address: 300, city: 80, phone: 40, website: 200, notes: 1000 }
/** Morocco's ICE is fifteen digits. Anything else is a typo worth catching. */
const ICE = /^\d{15}$/

/**
 * What is known about a company beyond its name.
 *
 * There is no open Moroccan company register to join against, so nothing here
 * arrives automatically: every field is either typed by an administrator or
 * copied from a lookup they reviewed. Each record therefore carries where it
 * came from and whether a person has confirmed it, and the profile page shows
 * the difference.
 */
export function createCompanyRecordService({ companyRecords, companyLookup, btp }) {
  /** The stored fields, or null when every one of them was cleared — an empty
   *  row labelled "verified" says something was checked when nothing is there. */
  async function find(name) {
    const row = serializeRow(await companyRecords.findByName(name))
    if (!row) return null
    return FIELDS.some((key) => row[key]) ? row : null
  }

  async function save(name, input, reviewer) {
    const patch = {
      ice: field(input.ice, 'ice'),
      registry_number: field(input.registryNumber, 'registry_number'),
      legal_form: field(input.legalForm, 'legal_form'),
      address: field(input.address, 'address'),
      city: field(input.city, 'city'),
      phone: field(input.phone, 'phone'),
      website: field(input.website, 'website'),
      notes: field(input.notes, 'notes'),
      source: clean(input.source) || 'manual',
      source_url: field(input.sourceUrl, 'website'),
    }
    if (patch.ice && !ICE.test(patch.ice.replace(/\s/g, ''))) {
      throw new ValidationError('An ICE is fifteen digits')
    }
    if (patch.ice) patch.ice = patch.ice.replace(/\s/g, '')

    // Saving from the form is the act of confirming it.
    return serializeRow(await companyRecords.upsert(name, patch, { verifiedBy: reviewer?.id ?? null }))
  }

  const remove = (name) => companyRecords.remove(name)

  /**
   * Candidates from the public register, for a person to choose between.
   * Never written automatically — see enrichment/openCorporates.js.
   */
  const lookup = (name) => companyLookup.search(name)
  const lookupConfigured = () => companyLookup.isConfigured()

  const qualificationsFor = async (name) => serializeRows(await btp.findForCompany(name))

  return { find, save, remove, lookup, lookupConfigured, qualificationsFor }
}

function field(value, key) {
  const cleaned = clean(value)
  return cleaned ? cleaned.slice(0, MAX[key] ?? 200) : null
}
