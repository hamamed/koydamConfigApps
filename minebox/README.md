# MineBox

Catalogue API and admin panel behind the **MineBox** iOS app — Minecraft skins, addons,
texture packs, worlds and seeds.

Node + Express · SQLite · sharp · EJS · Bootstrap 5 · Lucide icons. No other dependencies:
the ZIP reader that validates every `.mcaddon` and the Minecraft skin renderer that draws
every card are both in this repository.

> Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

---

## Quick start

```bash
cd minebox
npm install
cp .env.example .env          # then edit it — see below
npm run migrate               # creates the schema + the first admin
npm run seed 30               # optional: 30 generated items, with real files
npm start
```

- Admin panel → <http://localhost:3100/admin>
- API → <http://localhost:3100/api/v1/items>

`sharp` and `better-sqlite3` are native; `npm install` rebuilds them for Apple Silicon on its
own.

### Environment

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | **Must match how clients reach the server.** Every `preview_url` and `file_url` is built from it, so a wrong value produces a catalogue of broken images and downloads that 404. |
| `SESSION_SECRET` | Signs session cookies, and salts the client fingerprint. The app refuses to boot in production with the default. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | First admin, created by `npm run migrate` **only when no users exist**. Ignored once single sign-on is wired up. |
| `MAX_UPLOAD_MB` | Outer upload ceiling (default 64). Per-kind limits are tighter — see below. Keep nginx's `client_max_body_size` above this. |
| `CORS_ORIGINS` | Comma-separated allowlist. Leave blank for a mobile client — apps send no `Origin` header. |

Later admins: `npm run create-admin -- <username> <password>` (also resets an existing one).

On the VPS these are not used for sign-in at all: `deploy.sh` sets `PLATFORM_URL`,
`SERVICE_TOKEN` and `PLATFORM_APP_SLUG`, and the panel then authenticates against
config.hamaprojects.com like every other panel on the box.

---

## What it holds

Five kinds of content in one table, because everything the catalogue actually *does* — search,
tags, downloads, reactions, reports, featuring, trending — is the same for all of them.

| Kind | File | Installs by |
| --- | --- | --- |
| `skin` | `.png` (64×64 or a multiple), or `.mcpack` | Saving the image, then Minecraft → Profile → Skins → Import |
| `addon` | `.mcaddon`, `.mcpack`, `.zip` | Opening it in Minecraft — both halves at once |
| `texture` | `.mcpack`, `.zip` | Opening it in Minecraft → Global Resources |
| `world` | `.mcworld`, `.mctemplate`, `.zip` | Opening it in Minecraft → Worlds |
| `seed` | *none* | Copying the code into the world creator |

Each kind has its own categories (`utils/validate.js` is the only place that decides), its own
accepted extensions, and its own size ceiling — 2 MB for a skin, 64 MB for a world. A 40 MB
"skin" is not a skin.

**Java content is browse-only.** A `.jar` mod cannot be installed on a phone at all, so
`edition` is carried on every item and the app is told which is which rather than guessing.
Only Bedrock formats are accepted for upload.

---

## API

The response envelope is exactly what the iOS client decodes.

```
GET  /api/v1/items?kind=addons&category=mobs&version=1.21&page=1&limit=20&q=dragon&sort=trending
GET  /api/v1/items/:id
GET  /api/v1/items/:id/related?limit=8
POST /api/v1/items/:id/download
POST /api/v1/items/:id/reaction      { "value": 1 | -1 | 0 }
POST /api/v1/items/:id/report        { "reason": "version", "note": "…" }
GET  /api/v1/kinds                   the app's tab bar, with counts
GET  /api/v1/categories?kind=addons  the filter row, with counts
GET  /api/v1/versions?kind=worlds
GET  /api/v1/editions
GET  /api/v1/install-hints
GET  /api/v1/report-reasons
GET  /api/v1/tags
GET  /api/v1/colors
GET  /api/v1/health

GET  /d/:id                          the file, under its original name
GET  /s/:id                          the share landing page
```

```json
{
  "status": "success",
  "data": [{
    "id": "mb_a7f3c9d2e1b4",
    "kind": "addon",
    "title": "Dragon Mounts",
    "category": "mobs",
    "edition": "bedrock",
    "mc_version": "1.20.80",
    "downloads": 1420,
    "preview_url": "https://minebox.hamaprojects.com/storage/previews/dragon-mounts-a7f3c9d2.webp",
    "file_url": "https://minebox.hamaprojects.com/d/mb_a7f3c9d2e1b4",
    "file_name": "dragons.mcaddon",
    "install": { "method": "mcaddon", "hint": "Tap Open in Minecraft. It installs both halves…" },
    "skin": null,
    "pack": { "name": "Dragon Mounts", "version": "1.2.0", "min_engine_version": "1.20.0",
              "modules": ["data", "resources"] },
    "seed": null,
    "is_featured": true,
    "tags": ["dragons", "rideable"]
  }],
  "meta": { "page": 1, "limit": 20, "total": 480, "has_more": true }
}
```

Notes:

- `kind` accepts either spelling and several synonyms (`addons`, `mods`, `maps`, `shaders`);
  items always come back singular.
- A `category` sent **without** a `kind` is ignored. `survival` exists under both addons and
  worlds and means a different thing in each, so honouring it globally would mix them.
- `sort` is `trending` | `newest` | `mostDownloaded` | `mostLiked`. **Trending** weighs the last
  7 days of downloads against age, so a two-year-old hit doesn't sit at the top forever.
- `limit` is clamped to 60. Without a cap, `?limit=100000` is a free denial of service against
  your own database.
- Unpublished items are invisible to the API — the panel's draft state is a real gate, not a
  label.
- `install` is sent per item rather than derived in the app, because the same extension means
  different things under different kinds — and because correcting a wording then reaches every
  installed copy at once rather than at the next release.
- `edition: "both"` appears in the Bedrock list *and* the Java list. Filtering on equality alone
  would hide exactly the items that are safest to recommend.
- The kind-specific blocks (`skin`, `pack`, `seed`) are `null` rather than absent when they do
  not apply, so a decoder declares one optional property each instead of branching on `kind`
  before it knows which keys exist.
- Download counts are **de-duplicated per client per day** via a daily-salted hash of IP and
  user agent. The raw IP is never stored; the counter measures reach rather than button taps.
- A repeat report from the same client on the same day answers success and records nothing —
  that isn't a failure the reporter should see, and telling them otherwise invites a second one.

### Why downloads go through the application

`/d/:id` is served by Node, not by nginx off the storage tree, for one reason: **Minecraft names
an imported pack after the file it arrived in.** On disk that file is
`dragon-mounts-a7f3c9d2.mcaddon` — slug plus id fragment, because two uploads called
`pack.mcaddon` must not collide — so serving the directory directly would put the id in every
player's pack list. The `Content-Disposition` header restores the creator's name.

Counting the download there follows from it: that is the moment the bytes actually leave.
`POST /items/:id/download` remains for seeds (copied, never downloaded) and shares, and both go
through the same per-client-per-day collapse, so using both cannot double-count.

Preview images *are* served by nginx. They are the bulk of the traffic by a wide margin and need
no header of ours.

---

## Admin panel

| Page | What it does |
| --- | --- |
| **Dashboard** | Totals, week-on-week trend, 14-day download chart, split by kind, storage use, trending table, audit feed, search demand |
| **Catalogue** | Grid with search and kind / category / version / status / sort filters, inline feature toggle, bulk delete, pagination |
| **Add an item** | One form for all five kinds; the fields change with the kind, and the server validates the combination regardless |
| **Detail** | Card art, every stored field, **what is inside the archive**, per-item download history, its reports, and the live API / share / download URLs |
| **Analytics** | Range picker, downloads vs unique people, biggest movers, tag performance, search demand, report reasons |
| **Reports** | Player-submitted problems, safety reasons floated to the top, resolve / dismiss / reopen |
| **Tags** | Usage-weighted tag cloud, each linking to its filtered list |

Three things worth knowing about:

**Unique downloaders, not just downloads.** The counter measures actions; the unique count
measures people. They diverge exactly when it matters — a day where a handful of users grab
twenty items each looks identical to a day of real growth if you only watch the total.

**Reports are ranked per thousand downloads**, not by raw count. A popular item naturally
attracts more of both, so a raw leaderboard would just re-rank the catalogue by popularity.

**Search demand is the panel to watch.** Every page-one search is logged with its result count,
and the zero-result terms are a ranked list of what players want that the catalogue can't
answer — far better product direction than guessing from what already sells.

---

## Where the interesting code is

### Reading inside a Minecraft archive — [`src/utils/zip.js`](src/utils/zip.js), [`src/services/packs.js`](src/services/packs.js)

Every `.mc*` format is a ZIP with a different name. Before an upload is stored, the archive is
opened and checked against what Minecraft itself requires: a `.mcaddon` must contain a readable
`manifest.json` declaring at least one module, a `.mcworld` must contain a `level.dat`. Both
failures are otherwise **invisible** — the bytes are a well-formed archive, the extension is
right, and the game refuses it silently while the player reports the item as broken.

The line is drawn exactly at what the game requires. Anything short of that is a warning the
admin can act on, because being stricter than Minecraft would block content that works.

The pack's own `pack_icon.png` is lifted out of the archive at the same time and becomes the
card artwork, so nobody has to draw one. A `pack_icon.png` that turns out not to be an image is
a missing icon, not a failed upload.

The reader is ~230 lines of Node with `zlib` doing the actual decompression — a third native
module to read the central directory of a file already held in memory was a poor trade against
two that already carry a rebuild story on every deploy. ZIP64 is detected and *refused* rather
than misread: its sentinels are `0xffffffff`, which a reader that ignores the extension happily
treats as a four-gigabyte offset into a 40 MB buffer.

### Drawing a skin — [`src/utils/minecraft-skin.js`](src/utils/minecraft-skin.js)

A skin is one texture sheet the game wraps around a handful of boxes. Knowing where each face
sits gives two things:

- **Classic or slim**, inferred by looking at the strips of the sheet only a four-pixel arm
  uses. A slim skin leaves them empty. There is no flag in the file to read — Mojang stores the
  model against the player's account — and every tool that handles a bare PNG infers it this
  way. It is recorded per item because a slim skin worn on a classic body has a one-pixel seam
  down each arm.
- **The card portrait**: head, body, arms and legs composited with their overlay layers, at the
  texture's native scale, then upscaled once with a nearest-neighbour kernel. Done as a manual
  blit rather than as twelve `sharp` composites, because twelve decode/encode round trips is
  most of the cost of storing a skin — and because sharp cannot alpha-blend the overlay onto
  the base at 8×8 without a resize in between, which is precisely what must not happen to pixel
  art.

Legacy 64×32 sheets are handled by mirroring the right limbs onto the left, which is what the
game does.

### One form, five kinds — [`src/services/ingest.js`](src/services/ingest.js)

A skin is decoded and drawn, an archive is opened and checked, a seed has no file at all. One
place knows which, so every route reads as *validate the form, ingest the upload, write the
row*. It touches no database: it returns the columns to store, which is what lets the edit form
replace a file without duplicating any of it.

Card artwork comes from the first of these that works: an image the admin uploaded, the skin's
own texture, the pack's `pack_icon.png`, a generated card. The last one exists because
`preview_file` is `NOT NULL` — a card with no picture is worse than a plain one, since the app's
grid collapses around it and the item reads as broken rather than as unillustrated.

---

## Sample data

```bash
npm run seed 60
```

Generates real content: real 64×64 skin textures drawn face by face, real ZIP archives with real
manifests and icons inside them, plausible download histories. All of it goes through the same
ingest pipeline an upload does — so the seeded catalogue exercises the skin renderer, the
archive inspector and the icon lifter rather than side-stepping all three.

That is the point. Sample data that skips the code under development tells you the app looks
fine right up until the first real upload.

Randomness is seeded from each item's index, so two people looking at "the seeded addon with the
purple icon" are looking at the same thing.

---

## Maintenance

```bash
npm run migrate                      # apply the schema; safe on every boot
npm run create-admin -- <user> <pw>  # add or reset a local admin
npm run regenerate-previews          # redraw every card image from its source file
npm run regenerate-previews -- skin  # …just the skins
```

Run `regenerate-previews` after changing anything in `services/previews.js` or
`utils/minecraft-skin.js`. Previews are drawn once at upload time and never again, so a
rendering improvement reaches nothing already in the catalogue until it is run.

---

## Deploying

Part of [koydamConfigApps](../README.md), so a release is a push:

```bash
git push                       # here
sudo /opt/deploy.sh minebox    # on the box
```

First install only: [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

The panel takes its stylesheets, its logo, its SSO client and its `head.ejs` from
`platform-api/deploy/overlays/minebox/manifest` — do not edit those copies in place. The source
is `platform-api/deploy/shared/`.

---

## Two notes on the markup

**The catalogue cards use `ad-skin-*` class names.** In the shared stylesheet those describe a
catalogue card — thumbnail, body, title, meta, flags, actions, selection checkbox — rather than
anything skin-specific. Reusing them is deliberate: the alternative is a parallel set of
`ad-item-*` rules that look identical and drift apart, and this repository's rule is to use the
names the stylesheet defines rather than near-misses of them.

**`.ad-badge` is only styled inside `.ad-nav-link`.** Anywhere else it renders as bare text, so
this panel uses `kd-tag` / `kd-tag-accent` for chips and `ad-status ad-status-draft` for state.
The same is true of `.ad-range`, which styles `accent-color` for a range input and does nothing
for a row of links — the status and date pickers here are Bootstrap button groups instead.
