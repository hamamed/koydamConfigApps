import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAuth } from '../middleware/auth.js'
import { parseFilters } from '../filters.js'
import { toCsv, exportFilename } from '../../utils/csv.js'

/**
 * CSV exports of any filtered listing — procurement work happens in Excel.
 *
 * Signed in only. The data is public, but an unauthenticated endpoint that
 * serialises ten thousand rows on demand is a cheap way to load the box.
 */
const MAX_ROWS = 5000

const CONSULTATION_COLUMNS = [
  { key: 'reference', label: 'Référence' },
  { key: 'objet', label: 'Objet' },
  { key: 'acheteur', label: 'Acheteur' },
  { key: 'categorie', label: 'Catégorie' },
  { key: 'nature_prestation', label: 'Nature de prestation' },
  { key: 'lieu_execution', label: "Lieu d'exécution" },
  { key: 'date_publication', label: 'Mise en ligne' },
  { key: 'date_limite', label: 'Date limite' },
  { key: 'heure_limite', label: 'Heure limite' },
  { key: 'daysLeft', label: 'Jours restants' },
  { key: 'lots_count', label: 'Articles' },
  { key: 'status', label: 'État' },
  { key: 'attributaire', label: 'Attributaire' },
  { key: 'montant_attribue', label: 'Montant attribué' },
  { key: 'source_id', label: 'Identifiant portail' },
  { key: 'detail_url', label: 'Lien portail' },
]

const RESULT_COLUMNS = [
  { key: 'reference', label: 'Référence' },
  { key: 'objet', label: 'Objet' },
  { key: 'acheteur', label: 'Acheteur' },
  { key: 'attributaire', label: 'Attributaire' },
  { key: 'montant_attribue', label: 'Montant TTC' },
  { key: 'currency', label: 'Devise' },
  { key: 'nombre_offres', label: 'Devis reçus' },
  { key: 'date_publication_resultat', label: 'Publié le' },
  { key: 'result_status', label: 'Statut' },
  { key: 'consultation_id', label: 'Consultation liée' },
]

export function exportRoutes({ services }) {
  const router = Router()
  router.use(requireAuth(services.auth))

  const send = (res, prefix, columns, rows) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(prefix)}"`)
    res.send(toCsv(columns, rows))
  }

  router.get(
    '/consultations.csv',
    asyncHandler(async (req, res) => {
      const { data } = await services.consultations.search(parseFilters(req.query), {
        limit: MAX_ROWS,
        offset: 0,
        sort: req.query.sort,
      })
      send(
        res,
        'projets',
        CONSULTATION_COLUMNS,
        data.map((row) => ({
          ...row,
          daysLeft: row.deadline ? row.deadline.days : '',
          attributaire: row.result?.attributaire ?? '',
          montant_attribue: row.result?.montant_attribue ?? '',
        })),
      )
    }),
  )


  router.get(
    '/favorites.csv',
    asyncHandler(async (req, res) => {
      const { data } = await services.favorites.list(req.user.id, parseFilters(req.query), {
        limit: MAX_ROWS,
        offset: 0,
        sort: req.query.sort,
      })
      send(
        res,
        'favoris',
        [...CONSULTATION_COLUMNS, { key: 'note', label: 'Note' }],
        data.map((row) => ({
          ...row,
          daysLeft: row.deadline ? row.deadline.days : '',
          attributaire: row.result?.attributaire ?? '',
          montant_attribue: row.result?.montant_attribue ?? '',
          note: row.favorite?.note ?? '',
        })),
      )
    }),
  )

  return router
}
