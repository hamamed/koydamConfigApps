# marches-publics-api

Backend for scraping, cross-referencing and invoicing Moroccan public procurement
data from **marchespublics.gov.ma**.

Two datasets are crawled and joined on the consultation **reference**:

| Source | URL |
| --- | --- |
| Open consultations | `https://www.marchespublics.gov.ma/bdc/entreprise/consultation/` |
| Results / awards | `https://www.marchespublics.gov.ma/bdc/entreprise/consultation/resultat` |

## Quick start

```bash
npm install
cp .env.example .env          # then set JWT_SECRET and ADMIN_PASSWORD
npm run db:init               # create tables + indexes
npm run db:seed               # create the bootstrap admin account
npm run scrape -- --source=all --max-pages=3
npm start                     # API on :3000, admin panel on /admin
```

Runs on **SQLite** out of the box (via Node's built-in `node:sqlite` — no native
build step). Switch to PostgreSQL with `DB_CLIENT=postgres` + `DATABASE_URL`.

```bash
npm test              # 30 tests, no network access required
npm run test:coverage # ~90% line coverage
```

## Architecture

```
src/
  config/          environment loading + fail-fast validation
  db/              dialect-agnostic driver, schema, migrations
    drivers/       sqlite.js (node:sqlite) · postgres.js (pg)
    schema.js      table + index definitions          <- start here
    sql.js         placeholder rewriting, where/upsert builders
  scraper/
    httpClient.js  cookie jar, throttling, retry with backoff
    selectors.js   the portal markup contract          <- edit when the DOM changes
    parsers/       label-driven HTML -> record mapping
    consultationScraper.js · resultScraper.js
    matcher.js     reference-based cross-referencing
    runner.js      orchestration + scrape_jobs bookkeeping
  repositories/    parameterised SQL, one module per table
  services/        business logic (consultations, favorites, invoices, auth, admin)
  pdf/             pdfkit invoice document
  http/            filters, middleware, routes
  views/admin/     server-rendered admin panel (EJS)
bin/               db-init · db-seed · scrape (CLI)
tests/             unit + fixture-driven integration tests
```

Dependencies are injected through `src/container.js`, so every layer can be
tested against an in-memory database.

## Data model

| Table | Purpose |
| --- | --- |
| `consultations` | open procurement listings, unique on `source_id` (the portal's id) |
| `consultation_articles` | article breakdown of a consultation, FK `consultation_id` |
| `consultation_results` | awards, unique on `result_key`, FK `consultation_id` |
| `result_lots` | per-lot award detail (winner, amount, status) |
| `favorites` | `(user_id, consultation_id)` saved projects |
| `invoices` / `invoice_items` | generated invoices and their lines |
| `users` | admin + regular accounts (bcrypt hashes) |
| `scrape_jobs` | audit trail of every crawl |

Portability conventions, applied everywhere:

- **Identity is never a reference.** See below.
- **Dates** are ISO-8601 `TEXT` (`2026-06-02`) — lexicographic order equals
  chronological order, so range filters behave identically on both engines.
- **Money** is `INTEGER` centimes. Decimal amounts appear only in JSON payloads
  and PDFs, produced at the serialization boundary.
- **Booleans** are `INTEGER` 0/1.

### Identity and matching

**A reference is not an identity.** Every buyer numbers its own avis, so
`07/2026` appears three times in five pages of the live listing — once per
commune. Keying on it silently merged unrelated projects into one row.

| What | Identified by |
| --- | --- |
| Consultation | `source_id` — the portal's own id, from `/consultation/show/<id>` |
| Award | `result_key` — a hash of (reference, buyer, result date) |
| Link between them | `consultation_results.consultation_id`, a foreign key |

Awards get a derived key because the portal gives them nothing: the results
listing is a terminal card with no id, no detail page and no link. They are
matched to a consultation on `match_key`, the pair (reference, buyer), which is
the only signal both listings share.

After each crawl, `matcher.js`:

1. links awards whose `match_key` matches **exactly one** consultation, stamping
   `matched_at` and setting the foreign key;
2. flips `has_result` on the consultation;
3. recomputes every consultation's `status` from the facts on record —
   cancelled beats awarded, awarded beats a passed deadline, else open.

Three deliberate non-goals: no fuzzy matching on `objet`, no linking when a
`match_key` is ambiguous, and no scraper writes to `status`. An award attached to
the wrong consultation would corrupt every invoice built from it, so ambiguous
ones stay unlinked and are counted on the dashboard.

### Reading every project's detail page

The listing card carries reference, objet, buyer, deadline and location — and
nothing else. Category, nature of service and the whole article breakdown exist
only on the detail page, so a row is half a record until that page is read.

A crawl follows the detail page of rows it just created or changed. Everything
else is a backlog, worked through by:

```bash
npm run scrape:backfill                 # until the backlog is empty
node bin/scrape.js --backfill --limit=500   # a bounded sitting
```

or the **Fetch missing details** button on the dashboard, which runs it in the
background as a tracked job. `pendingDetails` on the dashboard is the size of the
backlog. A page that fails permanently is stamped rather than retried forever, so
one broken avis cannot stall the queue.

## Scraper design

Both listings — open consultations and results — are Bootstrap **cards**
(`.entreprise__card`), ten to a page, not tables. Nothing here relies on
positional selectors. `selectors.js` maps the *French label* onto a canonical
field name, and `listParser.js` reads that label in the three shapes the portal
mixes on the same page:

```
inline    <div><span>Acheteur :</span> COMMUNE MAGHRAOUA</div>
siblings  <span>Lieu d'exécution</span><span>AL HOCEIMA</span>
wrapped   <div>Caractéristiques et spécifications <span>…</span></div>
```

A new label is a one-line addition to `FIELD_SYNONYMS`; a class rename or a
reordered column is harmless.

### What lives where

The listing card carries only reference, objet, acheteur, deadline and location.
**Category, nature of service and publication date exist only on the detail
page**, so a listing-only crawl leaves them null rather than inventing them.
Results are the opposite — winner, amount and number of quotes received are all
on the card, and there is no detail page to follow.

Articles are an accordion on the detail page, with unit, quantity, VAT rate and
required warranties — but **no unit price**. These are calls for quotes: the
supplier proposes the price, which is exactly what the invoice generator asks
for.

### Things that bit, and are now tested

- **The WAF.** The portal answers `403` to any User-Agent that does not look like
  a browser. `SCRAPER_USER_AGENT` is a browser string with our own identity
  appended, so the crawler stays attributable. A 403 is raised, never parsed as
  an empty page — silently emptying the catalogue is the worse failure.
- **Colons inside times.** "…des devis 02/10/2026 15:00" split on the colon in
  `15:00`, producing the label "…devis 02/10/2026 15" and the value "00". Deadlines
  parsed as null with no error.
- **Values that quote their own field name.** A real cancellation motive reads
  "changement de la date limite pour la réception des devis". Read as a label, it
  made the parser store the *next* block as the deadline. Labels lead with their
  name and are short; sentences are neither.
- **Cancellations are a real state.** An avis can be published then withdrawn,
  with a date and a reason; `status` becomes `annule`.
- **Unsuccessful awards.** An avis with no winner prints "Avis d'achat
  infructueux" in the award panel rather than in a labelled field.

Other properties: politeness delay between requests, bounded concurrency on
detail pages, retry with exponential backoff on 429/5xx only, a cookie jar for
the portal session, and upserts keyed on `reference` that merge onto the stored
row so a sparse listing pass never erases richer detail-page fields.

> Every fixture under `tests/fixtures/live-*.html` is a page captured from the
> live portal, so the suite encodes the real markup contract. When the portal
> changes, re-capture a page and the failing assertion tells you what moved.

## Filters

Every listing endpoint accepts the portal's own form parameter names, so a UI can
forward its filter state verbatim. Three spellings work for each filter:

```
?search_consultation_resultats[acheteur]=ANCFCC     # portal form
?acheteur=ANCFCC                                    # flat alias
?buyer=ANCFCC                                       # short alias
```

| Filter | Parameter |
| --- | --- |
| Reference | `search_consultation_resultats[reference]` |
| Subject / object | `search_consultation_resultats[objet]` |
| Main category | `search_consultation_resultats[categorie]` |
| Nature of service | `search_consultation_resultats[naturePrestation]` |
| Buyer | `search_consultation_resultats[acheteur]` |
| Execution location | `search_consultation_resultats[lieuExecution]` |
| Publication range | `datePublicationStart` / `datePublicationEnd` |
| Closing range | `dateLimiteStart` / `dateLimiteEnd` |
| Free text | `q` (accent-insensitive) |
| Award state | `hasResult=true`, `status=open\|closed\|awarded\|all` |

Plus `page`, `perPage` (max 100) and `sort=column:asc|desc` on an allow-list of
columns. Malformed or inverted date ranges return `400` with details.

## API

All responses use one envelope: `{ success, data, error }`, plus `meta` on
paginated listings.

### Public

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness |
| `GET` | `/api/consultations` | filtered listing, each row joined to its award |
| `GET` | `/api/consultations/:id` | detail + articles + award + lots |
| `GET` | `/api/consultations/:id/articles` | article breakdown (invoice input) |
| `GET` | `/api/consultations/:id/result` | matched award |
| `GET` | `/api/consultations/by-reference/:reference` | every avis under a reference — a **list**, since references repeat across buyers |
| `GET` | `/api/results` | filtered awards listing |
| `GET` | `/api/results/:id` | award detail with per-lot breakdown |
| `GET` | `/api/i18n` | UI strings for the resolved locale |

Signed-in callers get an extra `isFavorite` flag on listing rows.

### Auth

`POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` ·
`POST /api/auth/password` · `POST /api/auth/users` (admin only).

JWT is returned in the body **and** set as an httpOnly cookie. Login is
rate-limited and returns an identical error for unknown accounts, wrong
passwords and deactivated accounts, so it cannot be used to enumerate users.

### Favorites tab

| Method | Route |
| --- | --- |
| `GET` | `/api/favorites` — saved projects, already joined to their awards |
| `GET` | `/api/favorites/count` — badge counter for the sub-tab |
| `POST` | `/api/favorites` — `{ consultationId, note?, tags? }` |
| `DELETE` | `/api/favorites/:consultationId` |

`GET /api/favorites` accepts the same filter parameters as the main listing, so
the UI can reuse its filter component inside the sub-tab. A favourite points at a
consultation id — it used to store the reference, which looked more durable but
was not an identity at all.

### Invoice generator

```http
POST /api/invoices
{
  "consultationId": 1234,
  "client": { "name": "SOCIETE TECHNO SARL", "ice": "001234567000045", "address": "Rabat" },
  "items": [
    { "articleId": 1, "quantity": 120, "unitPrice": 9500 },
    { "articleId": 2, "quantity": 35 },
    { "designation": "Installation et mise en service", "quantity": 1, "unitPrice": 15000 }
  ],
  "taxRate": 20, "discount": 0, "dueDate": "2026-10-30", "notes": "..."
}
```

An item either references a scraped article — designation, unit and fallback
price are copied from the database — or is free-form. Totals are always computed
server-side in centimes; client-sent totals are ignored. Invoice numbers are
sequential per year (`FCT-2026-0001`).

| Method | Route |
| --- | --- |
| `GET` | `/api/invoices` |
| `POST` | `/api/invoices` |
| `POST` | `/api/invoices/preview` — totals without persisting |
| `GET` | `/api/invoices/:id` |
| `GET` | `/api/invoices/:id/pdf` — streamed download (pdfkit) |
| `PATCH` | `/api/invoices/:id/status` |
| `DELETE` | `/api/invoices/:id` |

Validation covers empty item lists, non-positive quantities, negative prices,
out-of-range tax rates, unknown article ids, and articles belonging to a
different consultation.

## Languages

The interface is available in **French** (default), **English** and **Arabic**,
with Arabic rendered right-to-left.

- `?lang=fr|en|ar` switches and is remembered in a cookie; otherwise the browser's
  `Accept-Language` decides, falling back to French.
- `GET /api/i18n` returns the locale and its full dictionary, so a client that
  renders its own interface does not duplicate the strings.
- Dictionaries live in `src/i18n/`. A missing key falls back to French and then to
  the key itself, so an untranslated string is visible rather than blank — and a
  test asserts every locale answers for every key.

Only interface text is translated. **Scraped content is left exactly as the
portal published it** — an avis written in French stays in French, because
"translating" a published legal notice would be inventing text nobody wrote.

For Arabic the layout mirrors (`dir="rtl"`, logical CSS properties), and
references, dates and numbers are isolated `ltr` so the bidi algorithm cannot
reorder `6/2026` into `2026/6`.

## Admin panel

`/admin/login` → `/admin`. Server-rendered (EJS), admin role required; the HTML
routes redirect to the login page instead of returning a JSON 401.

- **Dashboard** — record counters, match rate, unmatched and ambiguous awards,
  how many detail pages are still unread, recent jobs.
- **Manual scrape** — pick a source, page cap, optional buyer filter, detail
  fetching on/off. Long crawls run in the background and are polled through
  `/admin/api/jobs`; a second run of the same source is refused while one is
  still running.
- **Records** — filterable consultation table with per-row *refresh detail page*
  and *delete*. Clicking a row opens the consultation, which shows every article
  read from its detail page — number, designation, specifications, quantity,
  unit, VAT and required warranties — alongside the matched award and a link
  back to the avis on the portal.

JSON API under `/admin/api`: `dashboard`, `jobs`, `scrape`, `rematch`, and CRUD
on `consultations` / `results`.

## Scraper CLI

```bash
npm run scrape -- --source=consultations --max-pages=3
npm run scrape -- --source=results --filter.acheteur=ANCFCC
npm run scrape -- --no-details          # skip detail pages (faster, no lots)
```

Same code path as the admin panel trigger, including `scrape_jobs` bookkeeping.

## Security notes

- Passwords: bcrypt, cost 12, minimum 12 characters.
- JWT secret is validated at boot; production refuses to start with the
  placeholder or a short secret.
- Every query is parameterised; no string-interpolated SQL, and sort columns come
  from an allow-list.
- `helmet`, CSP, CORS allow-list, 1 MB body cap, per-route rate limits.
- Only `AppError` messages reach clients; everything else is logged in full and
  returned as a generic 500.
- Internal columns (`raw_json`, `search_text`, `content_hash`, `password_hash`)
  are stripped at the serialization boundary.
- The admin panel's `next` parameter is validated against open redirects.

## Deployment

Live at **https://bdc.civictrust.ma**, port `3300` on the shared VPS
(`3000` SkinCraft, `3100` MineBox, `3200` Fortnite, `8080` Brawl, `8090` the
platform panel).

This is a service of `koydamConfigApps`, so it deploys the same way as the rest:

```bash
git push                        # from here
sudo /opt/deploy.sh bdc --dry-run   # always, when files were added or moved
sudo /opt/deploy.sh bdc
```

First install on a new box is `sudo DOMAIN=bdc.civictrust.ma EMAIL=... bash
deploy/setup.sh` — it creates the data directories, generates `.env` with a
fresh `JWT_SECRET`, installs the systemd units and the nginx site, and issues
the certificate.

| File | What it is |
| --- | --- |
| `deploy/bdc.service` | the API unit, runs as `brawl` under `ProtectSystem=strict` |
| `deploy/bdc-scrape.{service,timer}` | the crawl, 06:15 and 18:15, jittered |
| `deploy/nginx.conf` | reverse proxy; unbuffered PDF streaming, longer admin timeouts |
| `deploy/setup.sh` | first-time install, idempotent |
| `deploy/update.sh` | dependencies + schema + restart, if you are not using deploy.sh |

Operational commands on the box:

```bash
sudo -u brawl node bin/stats.js                                  # counts, match rate, recent jobs
sudo -u brawl node bin/scrape.js --source=consultations --max-pages=1
sudo -u brawl node bin/scrape.js --backfill                      # read every unread detail page
systemctl start bdc-scrape                                       # a full crawl now
journalctl -u bdc-scrape -n 100                                  # what the last crawl did
sudo -u brawl node bin/rebuild-scraped.js                        # dry run; --yes to rebuild
```

`rebuild-scraped.js` exists for an identity change that cannot be migrated. It
keeps accounts and job history and refuses outright if anyone has saved
favourites or invoices, which are the only rows a crawl cannot reproduce.

Operational notes:

- The app binds `127.0.0.1` in production (override with `HOST`), so nginx is
  the only way in.
- `data/` and `storage/` are `preserve`d in `services.conf`; a deploy syncs with
  `--delete` and would otherwise take the database and the invoice PDFs with it.
- SQLite runs on Node's built-in `node:sqlite`, so unlike `better-sqlite3` there
  is no native module to rebuild after a Node upgrade. It needs Node >= 22.5.0;
  `setup.sh` checks.
- **A column added to `schema.js` must also be listed in `additiveColumns()`.**
  `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so without
  that entry the column never reaches a database created by an earlier deploy,
  and every write fails at runtime long after the deploy reported success.
- `SCRAPER_USER_AGENT` must look like a browser or the portal's WAF answers 403
  to every request.
- Postgres is already on the box if this outgrows one file: set `DB_CLIENT=postgres`
  and `DATABASE_URL`, then run `node bin/db-init.js`.
- `SCRAPER_DELAY_MS` and `SCRAPER_DETAIL_CONCURRENCY` are the throttle knobs;
  keep them conservative against a public government service.
