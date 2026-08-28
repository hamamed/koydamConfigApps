# Working on this repository

Four Node services on one VPS, plus the control panel that configures them.
Read this before changing anything — several of the rules below exist because
breaking them took a service down.

## What is here

| Directory | What it is | Live at | Port | Store |
|---|---|---|---|---|
| `platform-api/` | Control panel, accounts, remote config for the mobile apps | config.hamaprojects.com | 8090 | Postgres |
| `brawl-vps/` | Brawl Stars API — Supercell proxy, meta crawler, wallpapers | api.hamaprojects.com | 8080 | Postgres + Redis |
| `skincraft/` | Roblox clothing catalogue, admin, AI designer | skincraft.hamaprojects.com | 3000 | SQLite |
| `minebox/` | Minecraft skins, addons, texture packs, worlds, seeds | minebox.hamaprojects.com | 3100 | SQLite |

The VPS is `46.224.86.198`, root over SSH. The Flutter app (`brawlStar`) is a
separate project and **not in this repository**.

## Running it locally

```bash
brew install node@20 postgresql@16 redis
brew services start postgresql@16 && brew services start redis

cd platform-api
cp .env.example .env          # POSTGRES_URL at minimum
npm install && npm run migrate
npm run reset-password -- you@example.com    # makes a local owner
npm run dev
```

`skincraft` and `minebox` each have two native modules (`sharp`,
`better-sqlite3`); `npm install` rebuilds them for Apple Silicon on its own.

`minebox` reads inside every uploaded `.mcaddon`/`.mcworld` and draws its own
card art, so `npm run seed 30` is worth running locally — it generates real
archives and real skin textures through the same pipeline an upload takes,
rather than writing rows straight into the database.

`.env` is deliberately not in git. A local one from `.env.example` is the right
thing — the Mac does not need the production Supercell token or AdMob keys, and
both services degrade honestly without them.

## Deploying

```bash
git push                # here
sudo /opt/deploy.sh     # on the VPS
```

`deploy.sh` updates itself from the checkout before running, so it is never
older than the repo. Other subcommands: `list`, `verify`, `--dry-run`,
`rollback <service> <commit>`.

**Always `--dry-run` first when the change adds or moves files.** It runs rsync
with `--itemize-changes` and lists what would be *deleted* — the deploy syncs
with `--delete`, and anything on the server that is not in the repo goes.

## Rules that are not obvious

**Never edit a panel's `src/panel/css/`.** Those are copies. The source is
`platform-api/deploy/shared/css/`, distributed on every deploy by the overlay
manifests in `platform-api/deploy/overlays/*/manifest`. After changing shared
CSS run `./deploy/sync-overlays.sh --write` so the committed copies match, or
CI fails.

**Exclude patterns for data directories must be anchored.** `--exclude
wallpapers` matches a directory of that name at *any* depth, so `src/wallpapers/`
was silently dropped from a deploy and the service died on a missing import.
Write `/wallpapers`. `deploy/check-excludes.sh` enforces this.

**Use the class names the stylesheet defines, not near-misses.** `.is-active`
and `.is-error` were styled and never produced for months because the markup
said `active` and `err`. Bootstrap defines `.active` too, so nothing errored and
nothing highlighted. `deploy/check-state-classes.sh` enforces this.

**Use the design system's buttons.** `btn-kd` (ink: create, confirm),
`btn-kd-accent` (indigo: saves only), `btn-kd-outline`, `btn-kd-ghost`,
`btn-kd-danger`. Not `btn-primary` or `btn-outline-secondary` — those are
styled by Bootstrap, not by `koydam.css`, and look close but wrong.

**No inline `style=""` in the panel markup.** platform-api and brawl-vps run
under a CSP with no `'unsafe-inline'`; a style attribute cannot be allowed by a
hash or nonce, so it is silently dropped and the element renders unstyled. Add
a class to `deploy/shared/css/admin.css` instead. SkinCraft and MineBox allow
inline in their own CSP, and their EJS views use it — that is deliberate, not an
oversight.

**Migrations run on every boot** and must be idempotent (`IF NOT EXISTS`).
There are five; CI applies them to a real Postgres twice.

**The panels layer three stylesheets**: Bootstrap → `koydam.css` (tokens,
buttons, chips) → `admin.css` (shell, tables, components). The admin never
invents a colour, radius or duration; it reads them from the tokens.

**Two `ad-*` names are traps.** `.ad-badge` is only styled *inside*
`.ad-nav-link`; anywhere else it renders as bare text. `.ad-range` sets
`accent-color` for a range input and does nothing for a row of links. SkinCraft
uses both that way and has been rendering unstyled chips and pickers for as long
as it has had them. Use `kd-tag` / `kd-tag-accent` for chips, `ad-status
ad-status-draft` for state, and a Bootstrap button group for a picker.

## Where things live

- Shared across services: `platform-api/deploy/shared/` — the SSO client, the
  stylesheets, the logo, `remote-settings.js`. One copy, pushed outward.
- What each service receives: `platform-api/deploy/overlays/<name>/manifest`
- Which services exist and how they deploy: `platform-api/deploy/services.conf`
- What settings moved out of `.env`: `platform-api/src/settings-catalogue.js`

## Operations

```bash
sudo /opt/backup.sh              # every database, .env, wallpapers, certs
sudo /opt/backup.sh verify <f>   # read an archive back
sudo /opt/watchdog.sh            # disk, TLS expiry, backup freshness
sudo /opt/cleanup.sh             # dry run; --apply to act
```

Backups are nightly at 03:00 by systemd timer, watchdog twice daily. Alerts go
to whatever is configured under **Alerts** in the panel.

## State of play

Working and live: single sign-on across all four panels, remote config, ad
settings, feature flags, scheduled changes, announcements, review-prompt
timing, release notes, audit and rollback, alerting, encrypted settings in the
panel, wallpaper upload, the AI skin designer, server resource monitoring.

**The Flutter app does not read the config API.** It takes AdMob unit IDs from
compile-time `--dart-define`, so announcements, rating prompts, what's-new,
test-ad mode and every unit ID are built, tested, and reaching nobody. Closing
that is one file in the app: fetch `/v1/apps/brawl-stats/config?platform=ios`
at launch, cache it, fall back to the compiled values. It is the highest-value
outstanding change and it unblocks four other finished features.

**AdMob is still on Google's test publisher** (`ca-app-pub-3940256099942544`),
so the app currently earns nothing. Real IDs go in the panel — and only take
effect after the wiring above.

Not built: TOTP, session revocation UI, anomaly alerts (stale crawler,
collapsed config fetches, flapping services), a public status page, AdMob
earnings via their reporting API.

## Verifying your work

CI runs on every push: JavaScript and shell parse, shell scripts are LF,
migrations apply twice to a real Postgres, overlay manifests resolve,
`services.conf` is valid, no inline styles, every panel class is defined, no
committed secrets, no unanchored excludes, every state class is set by
something.

Run the two shell checks locally before pushing:

```bash
bash platform-api/deploy/check-excludes.sh
bash platform-api/deploy/check-state-classes.sh
```

For anything visual, render it and check the output rather than trusting the
markup — most of the bugs in this repo's history were a class the CSS did not
style, or markup the CSS did not expect.
