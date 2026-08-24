# Brawl VPS — API pipeline for the Brawl Stats app

Sits between the official Brawl Stars API and the Flutter client. It exists for
three reasons:

1. **The Supercell token is IP-locked.** It only works from a whitelisted IP, so
   the app can't call Supercell directly — and shipping a token inside an APK
   means anyone can extract it.
2. **The official API is missing fields the app needs.** No rarity, no class, no
   hypercharge, no portraits. This service joins them in.
3. **There is no meta endpoint.** Win rates have to be computed by sampling
   battle logs. That's the crawler.

---

## What the official API does and doesn't give you

This is the single most important thing to understand before changing anything.

`GET /players/{tag}` returns each brawler as:

```json
{ "id": 16000000, "name": "SHELLY", "power": 11, "rank": 35,
  "trophies": 1020, "highestTrophies": 1100,
  "gears": [...], "starPowers": [...], "gadgets": [...] }
```

Note what's absent: **no `rarity`, no `class`, no hypercharge, no image.** And
those arrays contain only what the player has *unlocked* — there's no total, so
"2 of 3 gadgets" is impossible from Supercell alone.

| Field | Source |
|---|---|
| trophies, wins, power, rank, gears | Official API |
| gadget/star-power **totals** | `api.brawlapi.com` |
| rarity, class, portraits | `api.brawlapi.com` |
| **hypercharge availability** | `data/hypercharge-overrides.json` (hand-maintained) |
| win rates, pick rates, tier list | Computed by the crawler |
| ranked tier / rating | **Not available** — see Known limits |

Two findings worth knowing, both verified against the live endpoints during
build:

- **Use `api.brawlapi.com`, not `api.brawlify.com`.** The latter sits behind a
  CDN that returns `403 Request Blocked` to non-browser clients — it will fail
  from a VPS. The former serves the same payload.
- **No free API exposes hypercharge availability.** Not the official one, not the
  community one. It's maintained by hand in
  `data/hypercharge-overrides.json` — a name list, currently 85 entries. Add a
  name when a new hypercharge ships. Unlisted brawlers default to `false`, which
  the app renders cleanly.

---

## Setup on a bare VPS

`deploy/setup.sh` takes a fresh Ubuntu/Debian box to a running service. It
installs Node 22, Redis and nginx, creates a locked-down service user, writes
`.env`, syncs metadata, installs a systemd unit, configures the reverse proxy and
firewall, and optionally gets a TLS certificate.

It is **safe to re-run** — every step checks before acting, and an existing token
is preserved.

### 1. Get the token first

Run this **on the VPS** and note the IP:

```bash
curl -4 ifconfig.me
```

Go to <https://developer.brawlstars.com/#/account> → **Create New Key** and enter
that **exact IP** as the allowed address.

> The token is IP-locked. One created for the wrong IP returns **403 on every
> call** — by far the most common setup failure. The script probes for this
> specifically and tells you how to fix it.

### 2. Upload and run

From your machine:

```bash
scp -r brawl-vps root@YOUR_VPS_IP:/tmp/
ssh root@YOUR_VPS_IP
```

Then on the VPS:

```bash
cd /tmp/brawl-vps

# If you copied from Windows, strip CRLF first — a CRLF shebang fails with
# "bad interpreter: /usr/bin/env bash^M". Harmless to run either way.
sed -i 's/\r$//' deploy/*.sh

bash deploy/setup.sh
```

It prompts for the token (hidden input) and an optional API key. Or pass
everything up front:

```bash
# With a domain — also requests a TLS certificate
bash deploy/setup.sh --token 'eyJ0eXAi...' --domain api.yourdomain.com

# IP only, no TLS, fully unattended
bash deploy/setup.sh --token 'eyJ0eXAi...' --no-tls --yes
```

| Flag | Effect |
|---|---|
| `--token <t>` | Supercell token (prompted if omitted) |
| `--domain <d>` | nginx `server_name` + certbot. Omit for plain HTTP on port 80 |
| `--api-key <k>` | Shared secret clients must send. Omit to run open |
| `--no-tls` | Skip certbot even with a domain |
| `--no-firewall` | Skip ufw |
| `--yes` | Never prompt; fail instead |

The script prints the exact `flutter run` command to point the app at it.

### 3. Verify

```bash
curl -s http://YOUR_VPS_IP/health | jq
cd /opt/brawl-vps && runuser -u brawl -- npm run health -- YOURTAG
```

`npm run health` checks the token, the IP allowlist, metadata coverage, and that
a real player transforms into the shape the Flutter client parses. **Run this
first whenever something breaks** — it isolates which layer failed.

### 4. Point the app at it

```bash
flutter run \
  --dart-define=BRAWL_API_BASE=https://api.yourdomain.com/v1 \
  --dart-define=BRAWL_API_KEY=<only if you set PUBLIC_API_KEY>
```

### Redeploying code changes

`update.sh` touches only the app — no packages, no nginx, no firewall, and it
never overwrites `.env` or `data/`:

```bash
scp -r brawl-vps root@YOUR_VPS:/tmp/
ssh root@YOUR_VPS 'cd /tmp/brawl-vps && bash deploy/update.sh'

bash deploy/update.sh --sync    # also refresh brawler metadata
bash deploy/update.sh --crawl   # also run a meta crawl now
```

### What the script decides for you

- **Node from NodeSource, not apt.** Ubuntu 22.04's `nodejs` package is Node 12;
  the app needs 20+. Skipped if a new enough Node is already present.
- **App binds `127.0.0.1`, nginx proxies to it.** Port 8080 is never opened —
  exposing it would only bypass TLS and rate limiting.
- **SSH is allowed before ufw is enabled.** Enabling first would drop your
  session and lock you out of the box. That's the one unrecoverable mistake here,
  so it's ordered deliberately.
- **`limit_req_zone` goes in `/etc/nginx/conf.d/`, not the site file.** It's only
  valid in nginx's `http` block, which is why this can't be a plain template copy.
- **The nginx default site is removed.** It claims `server_name _` on port 80 and
  would shadow ours.
- **Redis is capped at 256MB with `allkeys-lru` and no persistence.** It's a pure
  cache; everything in it is rebuildable from the API.

### Docker alternative

```bash
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f api
```

Compose overrides `HOST=0.0.0.0` (container loopback isn't reachable from the
host) and wires Redis by service name. The port publishes to `127.0.0.1:8080`
only, so nginx still fronts it.

### Manual install

If you'd rather not run the script, `deploy/setup.sh` is readable top to bottom
and every step is a plain command. `deploy/nginx.conf` is a standalone reference
config for the domain + TLS case.

---

## Endpoints

Mounted at both `/v1/*` and `/*`, so a misconfigured base URL still works.

| Route | TTL | Notes |
|---|---|---|
| `GET /health` | — | Unauthenticated, never rate-limited |
| `GET /player/:tag` | 60s | Brawlers enriched with rarity/class/portrait/totals |
| `GET /player/:tag/battlelog` | 60s | Normalised across 3v3 / showdown / duo |
| `GET /club/:tag` | 300s | Club + members, fetched in parallel |
| `GET /brawlers` | 24h | Codex: gadgets, star powers, hypercharge |
| `GET /events/rotation` | 15m | Each event carries a `metaKey` for the tier list |
| `GET /meta/tierlist` | 1h | `?mode=gem-grab` to filter. 503 until first crawl |
| `GET /meta/map/:mapId` | 1h | `mapId` is a `mode:map` slug from `metaKey` |

Every cached response carries `X-Cache: HIT | MISS | STALE`.

**Upstream status codes pass through unchanged.** The Flutter client's
`ApiException._fromStatus` maps 400/403/404/429/503 to specific user-facing copy,
so collapsing everything to 500 would turn "No player found with that tag" into
"Server error".

---

## The crawler

There is no meta endpoint, so win rates are computed: pull the top-N players from
`/rankings`, fetch each battle log (~25 matches), aggregate outcomes per
`(mode, map)`.

Three decisions worth knowing:

**Wilson lower bound, not raw win rate.** A brawler that went 3-0 has a 100% raw
win rate and would top every list. Wilson asks "given this sample size, what's
the lowest win rate consistent with the data?" — so 3-0 scores 43.8% and ranks
*below* a 120/200 record at 53.1%. Sample size earns confidence.

**Battles are deduped.** The same match appears in every participant's log, so
without a battle key the popular brawlers in a lobby get counted repeatedly.

**Friendlies are excluded.** No stakes, full of experimentation, poisons win
rates.

Cost is one upstream request per sampled player per cycle — 200 players hourly is
~200 calls/hour, well inside the rate limit. `CRAWLER_PLAYERS` is the dial.

To crawl from cron instead of in-process, set `CRAWLER_ENABLED=false` and:

```cron
17 * * * * cd /opt/brawl-vps && /usr/bin/npm run crawl:meta >> /var/log/brawl-crawl.log 2>&1
```

This **requires `REDIS_URL`** — with the memory fallback the cron process writes
to its own heap and exits, and the server never sees the result.

---

## Known limits

**Ranked tier/rating is unavailable.** Supercell removed the public Power League
endpoints. `rankedTier` is `null` and `rankedRating` is `0`; the app hides the
badge accordingly. If you later scrape standings, populate them in
`transformPlayer` and the UI lights up with no client change.

**`hyperchargeUnlocked` is inferred, not ground truth.** The player endpoint has
no hypercharge field, so it's derived from `power >= 11 && hasHypercharge`. This
over-reports for power-11 players who haven't bought it. It's the only field in
the response that isn't authoritative — flagged rather than hidden.

**Showdown win rates count appearances only.** Showdown reports one rank for the
log owner, not a per-player result, so attributing that outcome to all ten
players would be wrong. Pick rates are accurate; win rates in showdown buckets
are thinner than in 3v3.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `bad interpreter: /usr/bin/env bash^M` | CRLF from a Windows copy — `sed -i 's/\r$//' deploy/*.sh` |
| 403 on every request | Token's IP ≠ server IP. `curl -4 ifconfig.me`, make a new token |
| Brawlers show as Common / Damage Dealer | Metadata missing — `npm run sync:brawlers` |
| No hypercharge anywhere | `data/hypercharge-overrides.json` missing or empty |
| `/meta/tierlist` returns 503 | First crawl hasn't finished (starts 15s after boot) |
| Everyone rate-limited as one user | `trust proxy` / nginx not forwarding `X-Forwarded-For` |
| Metadata sync 403s | You're pointing at `brawlify.com` — use `brawlapi.com` |
| `npm run crawl:meta` has no effect | `REDIS_URL` unset; server can't see the result |
| Service won't start | `journalctl -u brawl-api -n 30` — usually a bad token or port 8080 taken |
| `502 Bad Gateway` from nginx | App isn't running: `systemctl status brawl-api` |

```bash
sudo journalctl -u brawl-api -f                          # logs
curl -s localhost:8080/health | jq                       # subsystem state
cd /opt/brawl-vps && runuser -u brawl -- npm run health -- YOURTAG
sudo systemctl restart brawl-api
```

### Uninstall

```bash
sudo systemctl disable --now brawl-api
sudo rm /etc/systemd/system/brawl-api.service /etc/nginx/sites-enabled/brawl-api
sudo rm -f /etc/nginx/conf.d/brawl-limit.conf
sudo systemctl daemon-reload && sudo systemctl reload nginx
sudo rm -rf /opt/brawl-vps
sudo userdel brawl
```

## Durable storage and the operations panel

The crawler now writes to Postgres as well as Redis. They answer different
questions and neither replaces the other:

| | Redis | Postgres |
|---|---|---|
| Holds | the current tier list | every crawl ever run |
| Answers | "what is the meta now" | "how has Kit moved in six weeks" |
| If lost | refetched within an hour | gone — upstream only reports *now* |

Postgres is **optional**. Without `POSTGRES_URL` the service behaves exactly as
it did before: Redis caches, the tier list serves, and only the history
endpoints and the panel go quiet. A database outage should not take down an API
that ran without one for months.

### What gets stored

- `crawl_runs` — one row per cycle: duration, sample size, status, error
- `battle_samples` — raw sampled battles, one row per brawler appearance,
  deduplicated on `(battle_key, brawler_id)` so overlapping crawls don't
  double-count. Pruned after `POSTGRES_RETENTION_DAYS` (default 45).
- `brawler_stats` — the tier list *as served* each run. Stored rather than
  recomputed, so changing `CRAWLER_MIN_SAMPLE` later can't silently rewrite
  history.
- `players_seen` — the sampling frame, for reach over time.

### New endpoints

```
GET /meta/brawler/:id/history?days=30[&mode=gemgrab]
GET /meta/movers?days=7&limit=10
```

Both return `503 history_unavailable` when no database is configured — a
deliberate distinction from "no data yet", which returns an empty list.

### The panel

```
https://your-host/admin?key=YOUR_ADMIN_KEY
```

Live crawl runs, totals, biggest movers and current standings, polled every 10s.
Set `ADMIN_KEY` to a long random string:

```bash
openssl rand -hex 32
```

**Leaving `ADMIN_KEY` unset disables `/admin` entirely** rather than leaving it
open, so forgetting it fails safe. The key is compared in constant time.

### Deploying this change

```bash
# on the VPS, after uploading and extracting
npm install                    # picks up the new pg dependency
docker compose up -d --build   # brings up the postgres service too

# or, without Docker:
export POSTGRES_URL=postgres://brawl:...@127.0.0.1:5432/brawl
npm run db:migrate             # creates the schema
systemctl restart brawl-api
```

Migrations are idempotent (`IF NOT EXISTS` throughout) and run on every boot, so
there is no versions table to get out of step. That stops being the right call
the moment a migration has to *change* something rather than create it — at
that point add a `schema_migrations` table rather than making the files
non-idempotent.

Nothing appears in the panel until the first crawl finishes. Force one with:

```bash
npm run crawl:meta
```
