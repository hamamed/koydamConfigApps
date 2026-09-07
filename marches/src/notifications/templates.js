import { escapeHtml } from '../utils/text.js'

/**
 * Plain text and HTML for each alert.
 *
 * Both parts are produced: a procurement inbox is as likely to be Outlook as
 * Gmail, and the text part is what a rules-based filter and a screen reader
 * read. Everything interpolated is scraped from a third party, so it is escaped.
 */
const line = (label, value) => (value ? `${label}: ${value}\n` : '')

export function newProjectsEmail({ search, rows, baseUrl }) {
  const subject = `${rows.length} nouveau(x) projet(s) — ${search.name}`

  const text =
    `${rows.length} projet(s) correspondent à « ${search.name} ».\n\n` +
    rows
      .map(
        (row) =>
          `• ${row.reference} — ${row.objet ?? ''}\n` +
          line('  Acheteur', row.acheteur) +
          line('  Lieu', row.lieu_execution) +
          line('  Date limite', row.date_limite) +
          `  ${baseUrl}/panel/consultations/${row.id}\n`,
      )
      .join('\n')

  const html =
    `<p>${rows.length} projet(s) correspondent à «&nbsp;${escapeHtml(search.name)}&nbsp;».</p><ul>` +
    rows
      .map((row) => {
        const deadline = row.date_limite ? ` — clôture le ${escapeHtml(row.date_limite)}` : ''
        return (
          `<li><a href="${baseUrl}/panel/consultations/${row.id}"><strong>${escapeHtml(row.reference)}</strong></a> ` +
          `${escapeHtml(row.objet ?? '')}<br>` +
          `<small>${escapeHtml(row.acheteur ?? '')}${deadline}</small></li>`
        )
      })
      .join('') +
    '</ul>'

  return { subject, text, html }
}

export function deadlineEmail({ rows, baseUrl }) {
  const subject = `${rows.length} projet(s) suivi(s) arrivent à échéance`

  const text =
    'Ces projets que vous suivez ferment bientôt :\n\n' +
    rows
      .map(
        (row) =>
          `• ${row.reference} — clôture ${row.date_limite}` +
          ` (${row.deadline.days === 0 ? "aujourd'hui" : `dans ${row.deadline.days} jour(s)`})\n` +
          `  ${row.objet ?? ''}\n  ${baseUrl}/panel/consultations/${row.id}\n`,
      )
      .join('\n')

  const html =
    '<p>Ces projets que vous suivez ferment bientôt&nbsp;:</p><ul>' +
    rows
      .map(
        (row) =>
          `<li><a href="${baseUrl}/panel/consultations/${row.id}"><strong>${escapeHtml(row.reference)}</strong></a> — ` +
          `<strong>${row.deadline.days === 0 ? "clôture aujourd'hui" : `J-${row.deadline.days}`}</strong><br>` +
          `<small>${escapeHtml(row.objet ?? '')}</small></li>`,
      )
      .join('') +
    '</ul>'

  return { subject, text, html }
}

export function newAwardsEmail({ search, rows, baseUrl }) {
  const subject = `${rows.length} nouveau(x) résultat(s) — ${search.name}`

  const text =
    `${rows.length} résultat(s) correspondent à « ${search.name} ».\n\n` +
    rows
      .map(
        (row) =>
          `• ${row.reference} — ${row.attributaire ?? 'infructueux'}` +
          `${row.montant_attribue ? ` — ${row.montant_attribue} ${row.currency}` : ''}\n` +
          `  ${row.objet ?? ''}\n`,
      )
      .join('\n')

  const html =
    `<p>${rows.length} résultat(s) correspondent à «&nbsp;${escapeHtml(search.name)}&nbsp;».</p><ul>` +
    rows
      .map(
        (row) =>
          `<li><strong>${escapeHtml(row.reference)}</strong> — ${escapeHtml(row.attributaire ?? 'infructueux')}` +
          `${row.montant_attribue ? ` — ${escapeHtml(String(row.montant_attribue))} ${escapeHtml(row.currency)}` : ''}` +
          `<br><small>${escapeHtml(row.objet ?? '')}</small></li>`,
      )
      .join('') +
    `</ul><p><a href="${baseUrl}/panel/awards">Tous les résultats</a></p>`

  return { subject, text, html }
}
