# platform-api

Shared remote config for every app on the VPS. AdMob ids, kill switches,
forced-update floors and feature flags — served to the apps, edited in a panel,
changed without a store release.

Node + Express · Postgres · Bootstrap 5 · Lucide.

---

## Why this is a separate service

Brawl Stats and SkinCraft are unrelated apps with unrelated data. Putting
shared config inside either one would mean every future app depends on that
app's uptime, its deploys and its database. This runs on its own port, its own
systemd unit and its own Postgres database, so three apps are three failure
domains.

It is also the only piece that new apps need. App #4 is a row in a table, not a
deployment.

---

## What an app fetches

One request at launch:

```
GET /v1/apps/brawl-stats/config?platform=ios&version=1.0.0
```

```jsonc
{
  "app": "brawl-stats",
  "platform": "ios",
  "ads": {
    "enabled": true,                       // master switch AND admobAppId present
    "admobAppId": "ca-app-pub-…~…",
    "units": {                             // disabled placements are absent
      "banner": "ca-app-pub-…/…",
      "interstitial": "ca-app-pub-…/…"
    },
    "pacing": { "interstitialWarmup": 8, "interstitialCooldownSeconds": 180 }
  },
  "update": {
    "latestVersion": "1.1.0",
    "minSupportedVersion": "1.0.0",        // below this, block and prompt
    "storeUrl": "https://apps.apple.com/…"
  },
  "maintenance": { "active": false, "message": null },
  "flags": { "careerStats": true },
  "fetchedAt": "2026-…"
}
```

`?version=` is optional and used only for a per-day counter — it tells you
whether a rollout reached anyone.

### Why it is unauthenticated

The response contains AdMob unit ids, which are not secrets: they ship inside
every APK and IPA and can be read out of a binary in minutes. Gating it would
put a shared secret in every client for no protection, and a client that cannot
reach its config is a client with no kill switch.

The **write** side is a different matter: it lives behind a signed-in session
with per-app roles.

---

## Dashboard

```
https://config.hamaprojects.com/
```

Email and password, session cookie, **no key in the URL**. That change is not
cosmetic: a key in a query string ends up in browser history, bookmarks, nginx
access logs and every screenshot of the panel — and it is all-or-nothing, so
there is no way to hand someone one app.

Sessions live in Postgres rather than in a signed cookie, because the point of
having accounts is being able to revoke one *now* — and a self-contained token
cannot be un-issued.

### Roles

| Role | Can |
| --- | --- |
| `owner` | Everything, including the team |
| `admin` | Every app; not the team |
| `app_admin` | **Only the apps granted to them** |
| `viewer` | Read-only |

Enforced on the server on every request. The dashboard also hides what you
cannot use, but hiding alone stops nobody who opens devtools.

### What else it does

- **Audit log** — who changed what, when, from which IP. The email is stored
  alongside the id so the trail survives deleting the account.
- **History and rollback** — every change snapshots the app first, and a
  restore snapshots again, so a rollback is itself undoable.
- **Service monitoring** — every registered service pinged each minute, with
  24-hour uptime and response times on the dashboard.

---

## Install

Assumes Node, nginx, certbot and Postgres are already on the box — brawl-vps's
`setup.sh` put them there.

```bash
sudo ./deploy/setup.sh --domain config.hamaprojects.com --email you@example.com
```

Creates the `platform` role and database, writes `.env`, installs dependencies,
migrates, creates the first owner account, installs the systemd unit,
configures nginx and requests a certificate. It prints the sign-in details at
the end. Re-running preserves the database, the credentials and `.env`.

Redeploy later with `sudo ./deploy/update.sh`.

### SkinCraft on the same box

```bash
sudo ./deploy/install-skincraft.sh \
     --domain skincraft.hamaprojects.com --email you@example.com
```

Clones from GitHub, installs the sharp build dependencies, writes `.env` with a
generated session secret and first-admin password, and sets up its own service
and nginx block on port 3000. It uses SQLite, so it shares no storage with
anything else here.

---

## The layout this produces

| Subdomain | Service | Port | Storage |
| --- | --- | --- | --- |
| `api.hamaprojects.com` | brawl-api | 8080 | Postgres `brawl` + Redis |
| `config.hamaprojects.com` | platform-api | 8090 | Postgres `platform` |
| `skincraft.hamaprojects.com` | skincraft | 3000 | SQLite |

Each needs its own DNS A record pointing at the VPS **before** its setup script
runs — certbot validates over HTTP and a failed attempt is rate limited.

---

## Adding an app

1. Open the panel, enter a slug and a name.
2. Fill in the iOS and/or Android section; add ad units.
3. Point the client at
   `https://config.hamaprojects.com/v1/apps/<slug>/config?platform=…`.

Nothing is deployed. That is the point.

### Client guidance

- **Cache the response and ship a fallback.** The config is an optimisation,
  not a dependency: an app that cannot reach this should start with its
  compiled-in defaults rather than not start.
- **Respect `maintenance.active`** before anything else, and
  `update.minSupportedVersion` before letting the user in.
- `Cache-Control` is 5 minutes by default. Honour it — a kill switch is only as
  fast as the client's willingness to re-ask.

---

## Not verified

Written without a Postgres instance to test against, so the schema and every
query have only been reviewed, not executed. The first `npm run migrate` on the
server is the real test — see the verification block that `setup.sh` prints.
