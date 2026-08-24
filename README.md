# koydamConfigApps

Everything that runs on the VPS, in one repository. Three Node services behind
nginx on a single box, sharing one sign-in and one design system.

| Directory | What it is | Domain | Port | Store |
|---|---|---|---|---|
| [`platform-api/`](platform-api/) | Config dashboard, single sign-on, AdMob settings for every app | config.hamaprojects.com | 8090 | Postgres |
| [`brawl-vps/`](brawl-vps/) | Brawl Stars API — Supercell proxy, meta crawler, wallpapers | api.hamaprojects.com | 8080 | Postgres + Redis |
| [`skincraft/`](skincraft/) | Skin catalogue and admin | skincraft.hamaprojects.com | 3000 | SQLite |

---

## The short version

**Deploying is a push and one command.**

```bash
git push                       # here
sudo /opt/deploy.sh            # on the box
```

**One login covers all three.** Accounts live in `platform-api`; the other two
ask it who you are. There are no separate passwords and no admin key in a URL.

**Nothing a deploy does can take your data.** `.env`, the databases, the
wallpapers and the uploads are excluded from every sync.

---

## What each service does

### platform-api

The control panel, at **config.hamaprojects.com**. It holds the accounts every
other panel authenticates against, and the remote configuration your apps
fetch at launch.

It serves one document per app per platform:

```
GET /v1/apps/brawl-stats/config?platform=ios
```

```json
{
  "ads": { "enabled": true, "testMode": false, "admobAppId": "…",
           "units": { "banner": "…", "interstitial": "…" },
           "pacing": { "interstitialCooldownSeconds": 180 } },
  "update": { "latestVersion": null, "minSupportedVersion": null },
  "maintenance": { "active": false },
  "flags": { "careerStats": true }
}
```

The panel can:

- edit ad unit IDs, pacing and feature flags per app per platform
- switch **test-ad mode** on, serving Google's units instead of yours
- **preview** the exact JSON a client will receive, with warnings
- **schedule** a change for later — ads off Friday, on Monday
- send **alerts** to Slack, Discord or Telegram when a service goes down
- show **backup age**, and go red when it is stale
- keep a **version history** of every change, with one-click restore
- record an **audit log** of who changed what
- grant someone admin over **one app** rather than all of them

### brawl-vps

The API behind the Brawl Stats iOS app, at **api.hamaprojects.com**.

- proxies the Supercell API, cached in Redis
- crawls the top players, then follows tags found in their battle logs to
  discover more — roughly 350 players per run rather than the top 200
- stores up to six months of battles in Postgres and prunes older ones
- serves wallpapers as static files
- publishes the privacy policy and terms the App Store requires

Client requests need an API key. `/health`, `/wallpapers/` and the legal pages
are public — an image widget sends no headers, and a privacy policy behind a
secret is not published.

### skincraft

Skin catalogue and admin at **skincraft.hamaprojects.com**. SQLite, EJS
templates, uploads on disk. Its theme and sign-in are replaced by the overlay
described below.

---

## Deploying

One script covers every service. It pulls this repository, so a release is a
push rather than an upload.

```bash
sudo /opt/deploy.sh              # everything
sudo /opt/deploy.sh brawl        # one service, or several
sudo /opt/deploy.sh list         # what is configured, and whether it is up
sudo /opt/deploy.sh verify       # files edited by hand on the server
sudo /opt/deploy.sh --dry-run    # what would change, including deletions
sudo /opt/deploy.sh rollback brawl 3a90b01
```

It updates itself: the copy at `/opt/deploy.sh` compares against the checkout
and re-execs when it is behind, because a deploy script that can silently be
older than the repo it deploys will eventually be exactly that.

Adding a service is a block in
[`platform-api/deploy/services.conf`](platform-api/deploy/services.conf) —
name, repo, subdir, target, unit, health URL. The script itself is not edited.

### Installing it, once

```bash
mkdir -p /opt/src
git clone https://github.com/hamamed/koydamConfigApps.git /opt/src/koydamConfigApps
install -m 755 /opt/src/koydamConfigApps/platform-api/deploy/deploy.sh  /opt/deploy.sh
install -m 755 /opt/src/koydamConfigApps/platform-api/deploy/backup.sh  /opt/backup.sh
install -m 755 /opt/src/koydamConfigApps/platform-api/deploy/cleanup.sh /opt/cleanup.sh
```

First installs of a service still use its own `setup.sh`, which creates the
database, the systemd unit and the nginx block. `deploy.sh` moves an existing
install forward, which is the thing done weekly.

### What a deploy never touches

`.env`, and anything a service wrote itself — Postgres, Redis, SQLite,
`wallpapers/`, `storage/`, `uploads/`. A service can name its own exceptions:
Brawl keeps `data/brawler-meta.json` (170KB, generated) while still receiving
`data/hypercharge-overrides.json` (hand-maintained, in the repo).

---

## Backups

```bash
sudo /opt/backup.sh              # write one
sudo /opt/backup.sh list         # what exists
sudo /opt/backup.sh verify <f>   # check an archive is readable and complete
```

Code is in git, so it is not backed up. What is: every Postgres database,
SkinCraft's SQLite file, the wallpapers, the generated brawler metadata, every
`.env`, and the TLS certificates.

Databases are enumerated rather than listed, so one added later cannot be
silently missing. A failed `pg_dump` aborts rather than writing an archive
without the data — a backup that looks like protection and is not is worse than
none. The archive is read back before the script exits. Seven are kept.

Run it on a timer:

```bash
echo '0 3 * * * root /opt/backup.sh >/dev/null 2>&1' > /etc/cron.d/hamaprojects-backup
```

---

## Single sign-on

`platform-api` owns the accounts. Its session cookie is set on
`.hamaprojects.com`, so the browser already sends it to the other two — what
they cannot do is *read* it. They ask:

```
POST /api/session/introspect   { sid }   X-Service-Token: …
```

Introspection rather than a signed token, because a signed token cannot be
revoked: disabling an account would leave that person signed into Brawl and
SkinCraft until it expired. Callers cache for a minute.

Roles: `owner` (everything, including accounts), `admin` (every app),
`app_admin` (only apps explicitly granted), `viewer` (read-only).

`deploy.sh` wires this up. It fills in `SERVICE_TOKEN`, `COOKIE_DOMAIN`,
`ALLOWED_REDIRECT_HOSTS` and `SECURE_COOKIES` on `platform-api` when absent,
generating the token, then copies it into each service declaring an `sso` slug.

### Lost the password

```bash
cd /opt/platform-api
sudo -u brawl npm run reset-password -- you@example.com
```

Prints a generated one. Clears the lockout and ends that account's sessions.
Signed-in users can change their own from the panel — click your email in the
sidebar footer.

---

## Shared code

`platform-api/deploy/` holds what the other services would otherwise duplicate:

```
shared/
  platform-auth.js      the SSO client both services import
  css/koydam.css        design tokens — identical in all three
  css/admin.css         dashboard chrome (ad-* classes)
  css/bootstrap.min.css vendored, so no panel needs a CDN
  logo/                 logo.png and logoText.png
overlays/
  brawl/manifest        what lands in /opt/brawl-vps
  skincraft/manifest    what lands in /opt/skincraft, plus its own files
```

Each service declares what it receives in a `manifest` — `source → destination`,
one per line. They are copied outward on every deploy, so three panels cannot
drift into three slightly different products.

SkinCraft keeps its own `admin.css`: its templates use `sc-*` class names while
the dashboards use `ad-*`, so the same tokens are expressed twice rather than
rewriting every view in a third-party repo with no tests.

`deploy.sh verify` reports any copy edited on the server.
`deploy/sync-overlays.sh` keeps the copies committed in each service identical
to the source here — they exist so each repo boots from a bare clone.

---

## Housekeeping

```bash
sudo /opt/cleanup.sh             # list what would go
sudo /opt/cleanup.sh --apply     # remove it
```

Removes uploaded archives, the directories they were unpacked into, superseded
checkouts and package caches. Dry run by default. Every path is checked against
a protected list twice — when listed and again at deletion — resolved through
symlinks first, so a link cannot walk out of a pattern into something that
matters. It stops no service and goes near no database.

---

## Local development

```bash
cd platform-api
cp .env.example .env             # set POSTGRES_URL at minimum
npm install
npm run migrate
npm run dev
```

Useful scripts:

| Service | Script | What it does |
|---|---|---|
| platform-api | `npm run migrate` | apply schema |
| | `npm run seed` | example apps |
| | `npm run reset-password -- <email>` | set or create an account |
| brawl-vps | `npm run sync:brawlers` | regenerate `data/brawler-meta.json` |
| | `npm run crawl:meta` | one crawl by hand |
| | `npm run db:migrate` | apply schema |
| skincraft | `npm run migrate` | apply schema |
| | `npm run regenerate-previews` | rebuild preview images |

---

## Things worth knowing

**The Flutter app does not read the config API.** It takes its AdMob unit IDs
from compile-time `--dart-define`. Changing a unit ID in the panel does not
reach users until the app fetches `/v1/apps/<slug>/config` at startup. Alerts,
scheduling, backups, audit and sign-in all work today regardless.

**AdMob IDs are still Google's test units.** Real ones go in the panel, and the
app needs the wiring above before they take effect.

**Shell scripts are pinned to LF** in `.gitattributes`. A CRLF shebang fails as
`bad interpreter`, which reads as a missing file.

**Health checks run every minute** and now tell someone. Configure a
destination under Alerts, then send a test — an alerting path nobody has tested
is not an alerting path.
