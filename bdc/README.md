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
  i18n/            fr / en / ar dictionaries
  settings/        catalogue + runtime settings service
  views/panel/     server-rendered panel (EJS)
  views/partials/  sidebar shell and the inlined Lucide icons
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
| `consultation_documents` | attachments published with an avis, and its cancellation notice |
| `consultation_results` | awards, unique on `result_key`, FK `consultation_id` |
| `result_lots` | per-lot award detail (winner, amount, status) |
| `favorites` | `(user_id, consultation_id)` saved projects |
| `invoices` / `invoice_items` | generated invoices and their lines |
| `users` | accounts and their role (bcrypt hashes) |
| `site_settings` | runtime settings, falling back to `.env` |
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
else is a backlog, worked through by `npm run scrape:backfill`, by the
**Fetch missing details** button on the dashboard, or automatically at the end of
each scheduled run. `pendingDetails` on the dashboard is the size of the backlog.
A page that fails permanently is stamped rather than retried forever, so one
broken avis cannot stall the queue.

### Crawling: what the portal actually accepts

Verified against the live forms, because every one of these failed silently
before — the portal answers a malformed query with the *unfiltered* listing, or
with zero cards, and the crawl looks like it succeeded either way:

| | Consultations | Awards |
| --- | --- | --- |
| form root | `search_consultation_entreprise` | `search_consultation_resultats` |
| publication date | `dateMiseEnLigneStart` / `End` | `dateLimitePublicationStart` / `End` |
| deadline | `dateLimiteStart` / `End` | — |
| free text | `keyword`, `reference`, `objet` | same |
| page size | `pageSize` — **10, 20, 30 or 50** | same |

- **Dates must be ISO** `YYYY-MM-DD`. `dd/mm/yyyy` is accepted and then ignored.
- **`pageSize` must be on every request.** Without it the form binds to nothing
  and the page returns zero cards, which reads as "no results".
- `acheteur` is an autocomplete bound to a buyer id, so a name in it does
  nothing. Buyer filtering is applied to our own rows instead.

### Ordering

The project and award lists open in **the portal's own order — deadline first,
furthest away at the top** — so the first row here is the first row there. A
sort control offers closing-soonest, most recently published, and buyer.

Rows with no value in the sorted column always come last. Without an explicit
`IS NULL` key they would not: SQLite treats NULL as the smallest value and
PostgreSQL as the largest, so a descending sort put the empty rows at the bottom
on one engine and at the very top on the other. Ties break on `id`, so paging
cannot repeat or skip a row.

One difference from the portal remains, by design: **the portal drops an avis
once its deadline passes and we keep it.** So this list is a superset, and grows
past what the portal shows. Filter by `status=open` for the portal's live view.

### Both listings are ordered by deadline, not by date published

Page 1 holds the furthest deadlines and the last page holds today's, so **a newly
published avis does not appear near page 1**. Crawling "the first N pages" daily
would miss most new work. The daily run instead asks the portal for a
publication-date window:

```bash
node bin/scrape.js --source=all --since=7 --page-size=50 --max-pages=10
```

Seven days of overlap covers a missed run and anything published mid-crawl.

| Unit | What it does |
| --- | --- |
| `bdc-scrape.timer` | daily at 05:30 (jittered): the last 7 days, **10 pages per source at 50 rows**, then the detail backlog |
| `bdc-alerts.timer` | daily at 06:30: saved searches, deadline reminders, delivery |
| `bdc-backfill.service` | started by hand: every page of both listings, then every unread detail page |

The dashboard shows what the last run brought in — new projects, new awards,
awards linked, detail pages read, how long it took — and when the next one is
due. **The next-run time is read from a setting, not from systemd**: the app has
no business shelling out to `systemctl`, and reading it would tie the panel to
one init system. `scraper.dailyRunAt` and `scraper.dailySinceDays` label the
timer; changing them does not move it, so keep them in step with
`deploy/bdc-scrape.timer`.

The full load is `systemctl start bdc-backfill`. At 50 rows a page the
consultations listing is ~16 pages rather than 76; the slow part is one detail
page per avis, which takes hours at a polite pace and is resumable — it picks up
wherever the backlog stands.

**Paging drifts.** The listing is re-queried per page and re-sorted by deadline
each time, so items move between requests: one sweep of the 16 pages returns 758
cards but only ~593 distinct avis, and a few that existed never appear. This is
the portal's behaviour, not a bug here, and it means no single sweep is complete.
Two things cover it — upserts, so repeating a sweep only adds; and the daily
run's seven-day publication window, which re-encounters anything a sweep missed
within the week.

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

Forgotten passwords: `/forgot` → emailed link → `/reset`. The request endpoint
**answers identically whether or not the address is known** — anything else turns
it into a way to ask who has an account, and on a procurement tool who is
bidding is itself worth knowing. Tokens are stored **hashed**, expire in an
hour, are single use, and asking for a new link invalidates the previous one.

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

### Deadlines, exports and analysis

- Every row carries **how long is left to bid**, badged red inside three days,
  with a *closing within* filter. Deadlines here are commonly one to three weeks,
  so a bare date is not the useful thing.
- **CSV export** of any filtered list, at `/api/export/{consultations,awards,favorites}.csv`.
  Cells beginning `=`, `+`, `-` or `@` are prefixed with a tab — a spreadsheet
  treats them as formulas and this text is scraped from a third party — and the
  file carries a BOM, without which Excel mangles every Arabic and accented
  French character.
- **Insights** reads the award history for the questions a bidder has: what work
  like this goes for, who keeps winning it, which buyers publish it, and how
  often an avis ends unawarded. It reports the **median, not the mean** — a few
  very large contracts pull an average far above a typical bon de commande — and
  excludes unsuccessful and cancelled notices from every amount, since they have
  no price.

### Alerts

A saved search is a set of filters plus what to be told about: new projects
matching it, new awards matching it, or both. Projects you track also produce a
reminder as their deadline approaches — deadlines here are commonly one to three
weeks, and a tracked project that closes unnoticed is the failure that costs
money.

```bash
node bin/alerts.js          # or the bdc-alerts.timer, an hour after the crawl
```

Two decisions worth knowing:

- **A high-water mark, not a time window.** Each search records the instant it
  was last considered and reports only rows first seen after it. A window
  ("everything from the last 24 hours") double-sends when a run is late and skips
  entirely when one is missed — and this schedule is not guaranteed.
- **Recorded before delivered.** The notification row is written first and
  delivery is a status on it, so a mail server that is down loses nothing.

**With `SMTP_HOST` unset, alerts are still generated, recorded and marked sent —
written to the log instead of emailed.** The whole pipeline runs and can be
verified before any credentials exist. Set the SMTP variables in `.env` and the
same alerts start arriving by mail. The Alerts screen says plainly which mode it
is in.

### Crawler health

Every failure this scraper has had was silent: the job finished, reported
success, and the data quietly stopped arriving. The dashboard therefore judges
health on what a run *produced* — did it find anything, did the yield collapse
against recent runs, are the buyer, deadline and winner fields still parsing, is
the detail backlog growing, has the schedule stopped firing.

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
  `Accept-Language` decides, then the site's configured default, then French.
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

## The panel

Sign in at `/login`; everything lives under `/panel`. Server-rendered EJS with a
sidebar; icons are [Lucide](https://lucide.dev) SVGs inlined in
`src/views/partials/icon.ejs` rather than fetched from a CDN, so the panel keeps
its icons under a CSP with no external sources and with no second request before
first paint.

### Two tiers

| Screen | Who |
| --- | --- |
| Projects (`/panel`) — filterable list, star to track | any signed-in account |
| Awards (`/panel/awards`) — winners, amounts, link to the consultation | any signed-in account |
| Insights (`/panel/insights`) — median prices, top winners and buyers | any signed-in account |
| Alerts (`/panel/alerts`) — saved searches and deadline reminders | any signed-in account |
| Invoices (`/panel/invoices`) — build one from a project's articles, download the PDF | any signed-in account |
| Project detail — every article, the award, a private note | any signed-in account |
| Favorites (`/panel/favorites`) — what you track, with notes | any signed-in account |
| Dashboard (`/panel/dashboard`) — counters, manual crawls | **admin** |
| Users (`/panel/users`) — create, promote, deactivate, reset | **admin** |
| Settings (`/panel/settings`) | **admin** |

The split is enforced on the route, not by hiding links: an ordinary user asking
for `/panel/dashboard` is redirected to `/panel`, and `/admin/api/*` answers them
`403`. A test asserts both, because a hidden link is not an access control.

Favourites are per account. Each user tracks their own projects and keeps their
own note on each one; nobody sees anyone else's.

### Users

An **admin** additionally sees the three screens above — which can trigger crawls
against a public government service and change how the site behaves for
everyone. A **user** browses and tracks. Guards worth knowing: you cannot remove
your own administrator rights, deactivate or delete your own account, or remove
the last active administrator. Deactivating an account blocks sign-in
immediately.

### Settings

`/panel/settings` writes to `site_settings` and falls back to `.env` for anything
unset, so clearing a field restores the environment default. Changes apply to the
next crawl and the next invoice without a restart — the HTTP client re-reads the
delay, timeout and user agent before each request, and the invoice defaults and
the issuer block on the PDF are read at generation time.

Covered: site name and default language; crawler page cap, page size, delay,
detail concurrency, retries, timeout and user agent; invoice currency, VAT rate
and numbering prefix; and the issuer block printed on invoices.

**Secrets are deliberately not settings.** `JWT_SECRET` and the database
credentials stay in `.env`, where they are not one careless form submit away from
being changed by anyone who reaches the panel.

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
| `deploy/nginx.conf` | reverse proxy, **first-run template only** — certbot owns the installed copy |
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

- **Do not copy `deploy/nginx.conf` over a live site file.** Certbot rewrites the
  installed copy with the 443 server block and the certificate paths; replacing
  it drops HTTPS for the host and requests fall through to another site on the
  box, which shows up as a certificate mismatch rather than an obvious outage.
  Edit the installed file, or re-run `certbot install --cert-name <domain> --nginx`
  afterwards. `setup.sh` refuses to overwrite an existing one.
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
