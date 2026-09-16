# Wasla

The backend for **وصلة**, an Arabic crossword quiz for iOS. Admins write
questions — an answer, a clue and an optional picture — and group them into
levels; the service lays each level out as a crossword and serves it to the app.

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

## Question types

`text`, `image`, `emoji` (1–8 emoji) or `audio` (MP3/M4A/AAC/WAV ≤ 5 MB, sniffed
by bytes, stored in `storage/audio`, served at `/media/audio/`). Left on
**Automatic**, the type follows the media: audio, else picture, else emoji, else
text. A picture can start **blurred**. `image` is sent whenever a picture exists
(an older app shows it; an audio question may use it as a cover); `emoji` and
`audio` only for their own type.

## Packs, difficulty, daily puzzle

- **Packs** group levels, with a colour from the game palette and an SF Symbol
  from a fixed list (the panel draws a Lucide look-alike). Levels without one
  are in the built-in `general` pack.
- **Difficulty** is easy / medium / hard per level. **Order by difficulty** on
  the Levels page sorts inside each pack (difficulty, then word count, then the
  current order) while every pack keeps its slots in the overall order.
- **Daily puzzle**: a level chosen per date, otherwise level
  `days since 1970-01-01 mod published count` — the same for everyone.

## Import

**Import** takes one UTF-8 CSV plus any number of pictures and sounds in one
upload (example at `/assets/import-example.csv`). Columns:
`answer,clue,category,type,emoji,image,zoom,focus_x,focus_y,blurred,audio,pack,level`.
Every row is checked with the question form's rules and previewed; confirming
imports the valid rows in one transaction and lays out each level they were
added to (a missing level is created in the row's pack). Unconfirmed imports
and their unused files are removed after 24 hours.

## Stats

The app posts anonymous events (random per-install device id). **Stats** shows
per question: opens, solves, solve rate, average solve time, helps per open by
kind, times left unsolved, players — sortable, with a "hard questions" filter
(solve rate < 50 % over ≥ 10 opens) — and per level: completions, average time
and stars. Events older than `EVENT_RETENTION_DAYS` (180) are pruned daily.

## API

Public; reads are cached for a minute. Errors are `{ "error": "…" }`. The full
contract is `docs/wasla-v2-contract.md` in the iOS repository.

| | |
|---|---|
| `GET /api/v1/levels[?pack=slug]` | Published levels: `number`, `title`, `wordCount`, `rows`, `cols`, `updatedAt`, `pack`, `difficulty`, `packPosition` |
| `GET /api/v1/levels/:number` | The grid: each word's `id`, `answer` (folded), `answerDisplay`, `clue`, `row`, `col`, `direction`, `type`, `image` (`url`, `zoom`, `focusX`, `focusY`, `blurred`) or `null`, `emoji`, `audio` (`url`) |
| `GET /api/v1/packs` | Packs with published levels, `general` last |
| `GET /api/v1/daily?date=YYYY-MM-DD` | A level with `number: 0`, `date`, `coins`; 400 on a bad date, 404 with nothing published |
| `GET /api/v1/config` | Rewards, streak bonus, timer, reminder hour (Settings page) |
| `POST /api/v1/events` | `{ device, events[] }`, ≤ 100 events, 64 kB, 30 batches/min per IP → `202 { accepted }` |
| `GET /media/questions/<file>`, `GET /media/audio/<file>` | Pictures and sounds |
| `GET /privacy`, `GET /support` | Legal pages, Arabic then English |

`across` advances the column and `down` the row; the app draws column 0 at the
right edge, so across words read right to left.
