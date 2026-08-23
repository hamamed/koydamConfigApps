# SkinCraft VPS

Catalogue API and admin panel behind the **SkinCraft for Roblox** iOS app.

Node + Express · SQLite · sharp · EJS · Bootstrap 5 · Lucide icons.

---

Repository: <https://github.com/hamamed/skincraft>

## Quick start

```bash
git clone https://github.com/hamamed/skincraft.git skincraft-vps
cd skincraft-vps
npm install
cp .env.example .env         # then edit it — see below
npm run migrate              # creates the schema + first admin
npm run seed 24              # optional: 24 generated skins with real artwork
npm start
```

- Admin panel → <http://localhost:3000/admin>
- API → <http://localhost:3000/api/v1/skins>

### Environment

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | **Must match how clients reach the server.** Every `preview_url` and `template_url` is built from it, so a wrong value produces a catalogue of broken images. |
| `SESSION_SECRET` | Signs session cookies. The app refuses to boot in production with the default. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | First admin, created by `npm run migrate` **only when no users exist** — re-running migrations can't reset a live password. |
| `MAX_UPLOAD_MB` | Upload ceiling (default 12). Keep nginx's `client_max_body_size` above it. |
| `CORS_ORIGINS` | Comma-separated allowlist. Leave blank for a mobile client — apps send no `Origin` header. |

Later admins: `npm run create-admin -- <username> <password>` (also resets an existing one).

Upgrading an existing install: `npm run migrate` adds the new columns in place, then
`npm run backfill-colors` samples the dominant colour for skins uploaded before that existed.
It only touches rows where `color_hex` is null, so it's safe to re-run.

## API

The response envelope is exactly what the iOS client decodes.

```
GET  /api/v1/skins?category=shirts&page=1&limit=20&q=neon&sort=trending&featured=true&color=blue
GET  /api/v1/skins/:id
GET  /api/v1/skins/:id/related?limit=8
POST /api/v1/skins/:id/download
POST /api/v1/skins/:id/report        { "reason": "sizing", "note": "…" }
GET  /api/v1/report-reasons
GET  /api/v1/tags
GET  /api/v1/colors
GET  /api/v1/health
```

```json
{
  "status": "success",
  "data": [{
    "id": "skin_a7f3c9d2e1b4",
    "title": "Cyberpunk Neon Hoodie",
    "category": "shirt",
    "downloads": 1420,
    "preview_url": "https://vps.yourdomain.com/storage/previews/cyberpunk-neon-hoodie-a7f3c9d2e1b4.webp",
    "template_url": "https://vps.yourdomain.com/storage/templates/cyberpunk-neon-hoodie-a7f3c9d2e1b4.png",
    "is_featured": true,
    "tags": ["cyberpunk", "neon", "hoodie"]
  }],
  "meta": { "page": 1, "limit": 20, "total": 480, "has_more": true }
}
```

Notes:

- `category` accepts either spelling (`shirt` or `shirts`); items always come back singular.
- `sort` is `trending` | `newest` | `mostDownloaded`. **Trending** weighs the last 7 days of downloads against age, so a three-year-old hit doesn't sit at the top forever.
- `limit` is clamped to 60. Without a cap, `?limit=100000` is a free denial of service against your own database.
- Unpublished skins are invisible to the API — the panel's draft state is a real gate, not a label.
- `color` filters by the garment's dominant colour, sampled at upload time. Nine buckets, listed
  with their swatch values at `/colors`; `mono` is defined by *absence* of saturation rather than
  by hue, because a black hoodie's hue is meaningless and would otherwise land under a random chip.
- `/skins/:id/related` ranks by shared tag count, then same category, then popularity, and tops the
  result up with popular same-category skins so a skin with unusual tags never returns an empty row.
- `POST /skins/:id/report` takes one of six fixed reasons. A repeat from the same client on the
  same day answers success but records nothing — that isn't a failure the reporter should see, and
  telling them otherwise invites a second report. Uniqueness is a database index rather than a
  read-then-write, which would race under concurrent submissions.
- Download counts are **de-duplicated per client per day** via a daily-salted hash of IP + user agent. The raw IP is never stored; the counter measures reach rather than button taps.

## Admin panel

| Page | What it does |
| --- | --- |
| **Dashboard** | Totals, week-on-week trend, 14-day download chart, category split, storage use, trending table, audit feed |
| **Skins** | Grid with search, category / status / sort filters, inline feature toggle, pagination |
| **Upload** | Drag-and-drop with live preview, tag suggestions, publish + feature switches |
| **Design** | Compose a skin in the browser — colour, pattern, stickers, emoji, photo import — and publish it straight to the catalogue |
| **Detail** | Card art, template with transparency checkerboard, per-skin history, every stored field, the live API URL |
| **Analytics** | Range picker, downloads vs unique people, biggest movers, tag performance, search demand, quality signal |
| **Reports** | Player-submitted problems, safety reasons floated to the top, resolve/dismiss/reopen |
| **Tags** | Usage-weighted tag cloud, each linking to its filtered list |

Two analytics decisions worth knowing about:

- **Unique downloaders, not just downloads.** The counter measures actions; the unique count
  measures people. They diverge exactly when it matters — a day where a handful of users grab
  twenty skins each looks identical to a day of real growth if you only watch the total.
- **Reports are ranked per thousand downloads**, not by raw count. A popular skin naturally
  attracts more of both, so a raw leaderboard would just re-rank the catalogue by popularity.

The dashboard's **Search demand** panel is the one to watch: every page-one search is logged with
its result count, and the zero-result terms are a ranked list of what people want that the
catalogue can't answer — far better product direction than guessing from what already sells. Only
page one is logged; paging through results is the same intent, and counting it twice would make
popular searches look more popular than they are.

### Designing in the browser

`/admin/skins/design` composes a template on an HTML canvas: base colour, a pattern, emoji and
vector stickers dragged onto the sheet, and an optional photo import.

**Composition happens in the browser, not on the server, and that's deliberate.** Rendering emoji
server-side means librsvg needs a colour-emoji font installed; a bare Ubuntu VPS has none, so every
sticker would come out as a tofu box. The browser already has the fonts. It draws the 585×559
canvas and posts the finished PNG through the **same endpoint a manual upload uses** — so the
derived card artwork, the dominant-colour sampling and every validation happen exactly as they do
for any other skin, with no second code path to keep in step.

Stickers clip to whichever face they're dropped on, so one dragged onto a sleeve can't bleed into
the neighbouring region of the sheet and reappear on the wrong body part. Guides are drawn on the
canvas but stripped before export.

**Photo import** quantises the image to a coarse grid and counts buckets rather than averaging —
an average turns a vivid photo into mud, whereas the most frequent bucket is usually the colour a
person would name if you asked them what the picture is. Near-greys and near-blacks are skipped,
so a photo shot against a white wall doesn't hand back grey and white as its palette. The image can
also be dropped in as a chest graphic.

One thing it doesn't do: show a 3D preview. That would mean a WebGL renderer in the admin; publish
and open the skin in the app to see it worn.

### Uploading

Drop a template PNG, give it a title and category, publish. That's the whole flow.

**Card artwork is optional.** Leave it empty and the server derives one: it crops the garment's front face out of the template, blows it up with a nearest-neighbour kernel over a blurred, darkened copy of itself, and adds a bottom scrim so the title the app draws stays legible. The crop coordinates are the *same* R6 unwrap coordinates the iOS renderer samples ([`src/services/images.js`](src/services/images.js)), so a card and its 3D preview can never disagree about what the garment looks like.

Every upload is re-encoded through sharp. That strips EXIF, proves the bytes really are an image rather than something renamed to `.png`, and normalises the colour profile.

Templates that aren't 585 × 559 are **flagged, not rejected** — an avatar texture legitimately isn't, and a creator shouldn't be blocked because our validator is stricter than Roblox.

## Architecture

```
src/
  server.js            Express app, security headers, static serving, graceful shutdown
  config.js            Environment, with production guards
  db/                  Schema, migrations, admin bootstrap, seeder
  middleware/          Auth + CSRF, SQLite session store, uploads, error handling
  services/            skins (queries), images (sharp pipeline), stats (dashboard)
  routes/              api.js (public), admin.js (panel)
  utils/               ids, validation, view formatters
views/                 EJS templates
public/                Admin CSS + progressive-enhancement JS
deploy/                systemd unit, nginx config, backup script
```

### Notable decisions

**SQLite, not Postgres.** One file to back up, no second daemon, and `better-sqlite3` is synchronous so there's no connection pool to misconfigure. WAL mode is on because the admin panel and public API hit the same file — without it you get "database is locked" under any real traffic. Sessions live in the same database, so a restart doesn't sign every admin out.

**Denormalised download counter.** `skins.downloads` is a running total; `download_events` keeps the log. The API reads one integer, the dashboard aggregates the log. Aggregating the whole log on every catalogue request is the first thing that would fall over.

**One definition of the template geometry.** `src/utils/template-layout.js` owns the R6 unwrap.
The seeder, the preview deriver and the browser designer all read it — the designer gets it as JSON
injected into the page. It used to be duplicated between the seeder and the image service, which is
how a preview crop quietly stops matching what the 3D renderer paints.

**Tags in their own table.** Search hits an index rather than scanning a JSON blob, and one query loads tags for a whole page — a lookup per skin turns a 20-item page into 21 round trips.

**Dominant colour is sampled from the hero crop, not the whole sheet.** A template is mostly
transparent padding; averaging that in pulls every skin toward the same washed-out grey. Note that
`sharp.stats()` reads the *input* image and ignores pipeline operations, so the crop has to be
materialised into its own buffer first — otherwise every skin reports the colour of the full sheet.

**Server-rendered charts.** Fourteen data points don't justify shipping a charting library; `sparklinePath()` emits an SVG polyline and the dashboard renders completely without client-side JavaScript.

**CSRF is checked after multer on upload routes.** A multipart form's fields don't exist on `req.body` until the stream is parsed, so a token check that runs first sees nothing. The middleware fails closed with an explanatory error if it's ever chained in the wrong order, rather than silently skipping the check.

**Session id rotates on login.** Otherwise a session fixed before sign-in stays valid after it. Failed logins hash a dummy value so response time doesn't reveal which usernames exist.

## Share links

`GET /s/:id` is the page a shared card links to. Someone with the app is deep-linked straight to
the skin; someone without it gets a page showing what they were sent. The Open Graph tags matter
as much as the page — Discord, iMessage and X render the preview from them, so a shared link
unfurls as artwork rather than as a bare URL.

`GET /.well-known/apple-app-site-association` backs the universal link. Two things bite:

- It must be served as `application/json`, with **no** `.json` extension on the path.
- It must be reachable over HTTPS with **no redirect**. Apple's CDN follows neither redirects nor
  a 404-to-index fallback.

Set `APPLE_TEAM_ID` and `IOS_BUNDLE_ID` to match the shipping app. A mismatch fails silently: iOS
just opens Safari instead of the app.

## Deploying

**On a Hostinger VPS?** See [deploy/DEPLOY-HOSTINGER.md](deploy/DEPLOY-HOSTINGER.md) — two commands,
plus the hPanel specifics (which OS template to pick, DNS, firewall). Note that Hostinger's *shared*
and *Cloud* hosting cannot run this: no Node runtime, no long-lived process, no writable database.

Generic Ubuntu:

```bash
sudo adduser --system --group --home /srv/skincraft skincraft
sudo -u skincraft git clone <repo> /srv/skincraft
cd /srv/skincraft
sudo -u skincraft npm ci --omit=dev
sudo -u skincraft cp .env.example .env && sudo -u skincraft nano .env
sudo -u skincraft npm run migrate

sudo cp deploy/skincraft.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now skincraft

sudo cp deploy/nginx.conf /etc/nginx/sites-available/skincraft
sudo ln -s /etc/nginx/sites-available/skincraft /etc/nginx/sites-enabled/
sudo certbot --nginx -d vps.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

nginx serves `/storage/` straight from disk, so Node never touches a byte of image traffic — which is the overwhelming majority of this app's bandwidth.

Back up with `deploy/backup.sh` from cron. It uses SQLite's `.backup` rather than `cp`: copying the file while the server is writing can capture a torn page.

## Pointing the iOS app at it

In the app's `AppConfig.swift`:

```swift
static let baseURL = URL(string: "https://vps.yourdomain.com/api/v1")!
```

Release builds use the live API by default. To test a debug build against this server instead of its bundled sample catalogue, add `-SkinCraftForceLive` to the scheme's launch arguments.

## Not affiliated with Roblox

Fan-made tooling. Not affiliated with, endorsed by, or sponsored by Roblox Corporation.
