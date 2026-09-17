# Wasla

The backend for **وصلة**, an Arabic crossword quiz for iOS. Admins write
questions — an answer, a clue, a title and an optional picture — and group
them into levels; the service lays each level out as a crossword and serves it to the app.

## Run it

```bash
npm install
npm run seed                                  # the two sample levels
npm run create-admin -- admin 'a-long-password'
npm run dev                                   # http://localhost:3700/admin
npm test
```

## How a level is built

Pick questions for a level and **Save and build grid**. `src/layout.js` crosses
the answers on shared letters and picks the most compact arrangement; **Shuffle
grid** tries another. A word that shares no letter with the rest is listed as
not crossing, and the level cannot be published until it is removed or joined
by a word that shares its letters.

Changing an answer re-lays every level using it. A published level that no
longer connects is unpublished and the panel says which.

## Pictures and zoom

A question picture is shown square and filled. **Zoom** above ×1 turns it into
a close-up around the focus point (click the picture in the editor to set it) —
a "guess the zoomed picture" question. The app frames it with the same numbers.

## Hamza and alef

Answers are stored as spelled (`أسد`) and played folded: أ إ آ ٱ → ا, ؤ → و,
ئ ى → ي (ء and ة stay). Layout, crossings and the API's `answer` use the folded
form; `answerDisplay` carries the spelling. Folding happens on read, so older
rows need no migration. The question form shows "يُلعب: …" as you type.

## Question titles

Every question has a **title** (1–40 characters, e.g. حيوانات), shown above the
question in the app. The form requires one and offers the titles already in use.
It replaced the old *category*: on boot, a question without a title takes its
category once. The `category` column stays in the database, unused. A question
still without a title loads and publishes, and the API sends `"title": ""`.

## Question types

`text`, `image`, `emoji` (1–8 emoji) or `audio` (MP3/M4A/AAC/WAV ≤ 5 MB, sniffed
by bytes, stored in `storage/audio`, served at `/media/audio/`). Left on
**Automatic**, the type follows the media: audio, else picture, else emoji, else
text. A picture can start **blurred**. `image` is sent whenever a picture exists
(an older app shows it; an audio question may use it as a cover); `emoji` and
`audio` only for their own type.

## Level order, difficulty, daily puzzle

- **Levels are one numbered run** (1, 2, 3 …) in the order set on the Levels
  page. There are no packs or categories, and levels have no names: the panel
  calls each "Level N" by its place in the full list, and shows the app number
  beside it when drafts before it make the two differ. **Add level** appends the
  next one. (`levels.title` is unused legacy; the API's level `title` is
  `لغز رقم N`, and the daily puzzle's is `لغز اليوم`.) (The `packs` table and
  `levels.pack_id` column still exist in older databases and are unused.)
- **Difficulty** is easy / medium / hard per level. **Order by difficulty** on
  the Levels page sorts every level together: easy → medium → hard, then fewer
  words, then the current order.
- **Daily puzzle**: a level chosen per date, otherwise level
  `days since 1970-01-01 mod published count` — the same for everyone.

## Import

**Import** takes one UTF-8 CSV plus any number of pictures and sounds in one
upload (example at `/assets/import-example.csv`). Columns:
`answer,clue,title,type,emoji,image,zoom,focus_x,focus_y,blurred,audio,level`.
`level` is a level number as on the Levels page; one past the last level adds
it, and a bigger number is a row error. A `pack` column from an older CSV is
ignored, and an old `category` column stands in for a blank `title`.
Every row is checked with the question form's rules and previewed; confirming
imports the valid rows in one transaction and lays out each level they were
added to. Unconfirmed imports
and their unused files are removed after 24 hours.

## Stats

The app posts anonymous events (random per-install device id). **Stats** shows
per question: opens, solves, solve rate, average solve time, helps per open by
kind, times left unsolved, players — sortable, with a "hard questions" filter
(solve rate < 50 % over ≥ 10 opens) — and per level: completions, average time
and stars. Events older than `EVENT_RETENTION_DAYS` (180) are pruned daily.

## Level preview

**Preview** (on the Levels list and a level's page) draws the level in a 390 × 844
iPhone frame the way the app does: the mint board, the top bar, the teal
tiles right to left and the progress card. Tap a tile, or a word in the list
beside the phone, for its question page — title chip, picture (zoomed or
blurred as set), emoji, sound or text panel, clue, direction, empty answer
boxes, the 12-letter bank and the helps the app would offer. Sizes come from
the app's own layout code (`src/preview.js`). Drafts preview too.

## Players

**Players** is a dashboard over the same anonymous events: players today, in 7
and 30 days (distinct devices), levels and daily puzzles completed today,
devices with notifications on; players per day for 30 days as a chart (with a
table); the level funnel (devices that opened and completed each published
level, as a share of level 1 openers, with the biggest drop marked); helps by
kind over 30 days; and day-1 / day-7 retention over the last 30 complete
cohorts. Days are UTC days of when the server received the events.

## Push notifications

The app registers its APNs token with `POST /api/v1/devices`. **Notifications →
Setup** takes the `.p8` key from the Apple developer account and its Key ID
(Team ID `652935W544` and topic `koydam.wasla.crosswords` are prefilled). The
key is stored as `data/apns/AuthKey.p8`, mode 0600, and never shown again; the
ids live in the settings table. **Notifications** composes a title (≤ 60) and
message (≤ 180), optionally a level to open, and sends to every device with
notifications on, to sandbox devices only, or as a test to one device id —
after a confirmation step. Sending uses HTTP/2 and an ES256 provider token
(Node's own `http2` and `crypto`, no dependency), each device to the host for
its environment, 20 at a time. Dead tokens are switched off; the history
table lists every send with sent / failed / disabled counts.

## Challenge links

`/c/3?t=80&s=2` is a shareable page: "تحداك صديق: حل لغز رقم 3 في 1:20 — هل
تستطيع أسرع؟" with Open Graph tags, an **افتح في وصلة** button
(`wasla://c/3?t=80&s=2`) and an App Store button when a link is set (Settings →
Challenge links, or `APP_STORE_URL` in `.env`). The apple-app-site-association
file makes the same URL open the app directly once it is installed.

## API

Public; reads are cached for a minute. Errors are `{ "error": "…" }`. The full
contract is `docs/wasla-v2-contract.md` in the iOS repository.

| | |
|---|---|
| `GET /api/v1/levels` | Published levels, one numbered run: `number`, `title`, `wordCount`, `rows`, `cols`, `updatedAt`, `difficulty` |
| `GET /api/v1/levels/:number` | The grid: each word's `id`, `answer` (folded), `answerDisplay`, `title`, `clue`, `row`, `col`, `direction`, `type`, `image` (`url`, `zoom`, `focusX`, `focusY`, `blurred`) or `null`, `emoji`, `audio` (`url`) |
| `GET /api/v1/daily?date=YYYY-MM-DD` | A level with `number: 0`, `date`, `coins`; 400 on a bad date, 404 with nothing published |
| `GET /api/v1/config` | Rewards, streak bonus, streak freeze cost, timer, reminder hour, stars per level (Settings page) |
| `POST /api/v1/events` | `{ device, events[] }`, ≤ 100 events, 64 kB, 30 batches/min per IP → `202 { accepted }` |
| `POST /api/v1/devices` | `{ device, token, platform, environment, enabled, locale }`, upsert by device, 4 kB, 30/min per IP → `204` |
| `GET /c/:level?t=&s=` | Challenge landing page (Arabic, Open Graph tags, `wasla://` and App Store buttons); 404 page for an unpublished level |
| `GET /.well-known/apple-app-site-association`, `GET /apple-app-site-association` | Universal links for `/c/*`, `application/json`, cached 1 h |
| `GET /media/questions/<file>`, `GET /media/audio/<file>` | Pictures and sounds |
| `GET /privacy`, `GET /support` | Legal pages, Arabic then English |

`across` advances the column and `down` the row; the app draws column 0 at the
right edge, so across words read right to left.
