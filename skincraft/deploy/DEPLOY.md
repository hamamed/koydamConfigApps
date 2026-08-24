# Deploying

Anything that gives you root SSH on **Ubuntu 22.04 or 24.04** works — Hetzner, Hostinger VPS,
DigitalOcean, a box under a desk. The provisioning script is plain Ubuntu; only the control-panel
steps below differ by provider.

**Shared hosting will not work.** Hostinger's Web/Cloud plans, cPanel hosting and similar run PHP
behind a managed process pool: no Node runtime, no long-lived process, no writable location for a
SQLite database. This needs all three.

---

## A. Adding it to a server that already runs something

The common case, and the easy one. nginx routes by `server_name`, so each project gets its own
subdomain, its own Node process on its own loopback port, and its own systemd service. Nothing is
shared but nginx and the machine.

```
                      ┌── api.example.com   → 127.0.0.1:3000   (existing app)
Internet → nginx :443 ┤
                      └── skins.example.com → 127.0.0.1:3001   (this app)
```

**1. Check what's in front.** This assumes nginx:

```bash
systemctl status nginx apache2 caddy 2>/dev/null | grep -E 'nginx|apache|caddy|active'
```

If the existing project is behind **Apache** or **Caddy**, don't install nginx alongside it — two
servers can't both hold port 443. Add a virtual host in whatever you already run, proxying the new
subdomain to `127.0.0.1:3001`. The app doesn't care what's in front; it only listens on loopback.

**2. Point the subdomain at the same IP** (see [DNS](#dns) below), then confirm:

```bash
dig +short skins.example.com
```

**3. Find a free port:**

```bash
ss -ltnp | grep -E 'node|:300|:400'
```

**4. Install:**

```bash
git clone https://github.com/hamamed/skincraft.git /srv/skincraft
cd /srv/skincraft
sudo PORT=3001 DOMAIN=skins.example.com EMAIL=you@example.com bash deploy/setup.sh
```

The script is written to be safe on a shared box. It refuses to start if the port is taken, leaves
an already-active firewall alone rather than reconfiguring it, and only clears nginx's default site
when this is the only site. Its service, user, nginx site and rate-limit zone are all named
`skincraft`, so they can't collide with an existing project.

certbot issues a **separate certificate** for the new subdomain and edits only the matching server
block. The existing site is untouched, and separate certificates renew independently — a problem
with one can't take the other offline.

---

## B. A fresh server

### Hetzner Cloud

In the [Cloud Console](https://console.hetzner.cloud):

- **Image** → Ubuntu 24.04. Not an "Apps" image; those come with their own stack.
- **SSH keys** → add yours at creation. Hetzner disables password login when a key is present,
  which is what you want.
- **Firewalls** → this is the one that catches people. A Hetzner Cloud Firewall is applied at the
  *network* level, before traffic reaches the server, and it's entirely separate from `ufw`. If you
  attach one, it must allow inbound **22, 80 and 443** or the server is unreachable no matter what
  `ufw` says. If you attach none, the server is open and `ufw` on the box is your only firewall —
  the setup script configures it.
- **Backups** → the console's backup option is a whole-disk snapshot. Worth having, but it restores
  the entire server; see [Backups](#backups) for per-app dumps.

Hetzner gives every server an IPv6 `/64` as well as an IPv4 address. The nginx config already
listens on `[::]:80` and `[::]:443`, so adding an `AAAA` record alongside the `A` record works with
no extra configuration.

### Hostinger VPS

hPanel → **VPS** → your server:

- **Operating System** → a plain **Ubuntu 24.04** template, not one bundled with CyberPanel,
  CloudPanel or Plesk — those run their own web server and will fight nginx over ports 80 and 443.
- **SSH Keys** → add your public key.
- **Firewall** → Hostinger's network firewall sits in front of `ufw`, same as Hetzner's. Allow
  22, 80 and 443 there too.

### Then, on any provider

```bash
git clone https://github.com/hamamed/skincraft.git /srv/skincraft
cd /srv/skincraft
sudo DOMAIN=skins.example.com EMAIL=you@example.com bash deploy/setup.sh
```

Or upload from your Mac instead of cloning, if the repo isn't set up yet:

```bash
bash deploy/push.sh root@YOUR_SERVER_IP
```

The script installs Node 22, creates the `skincraft` service user, installs dependencies, verifies
the native modules load, migrates, registers systemd, configures nginx, requests a TLS certificate
and schedules nightly backups. It's idempotent, and it never overwrites an existing `.env` or
database.

It prints a generated admin password at the end. Change it once you're in:

```bash
cd /srv/skincraft && sudo -u skincraft npm run create-admin -- admin 'your-new-password'
```

---

## DNS

Wherever the domain is managed — Hetzner DNS Console, your registrar, Cloudflare — add:

| Type | Name | Value |
| --- | --- | --- |
| A | `skins` | your IPv4 address |
| AAAA | `skins` | your IPv6 address (optional) |

Wait for it to resolve **before** running the script with `EMAIL=`. Let's Encrypt validates over
HTTP and will fail against a stale record. If it does fail the script leaves you on working HTTP
and prints the one command to retry.

Behind Cloudflare, set the record to **DNS only** (grey cloud) until the certificate is issued.
Proxied records break HTTP-01 validation.

---

## Pointing the app at it

```swift
// AppConfig.swift
static let baseURL = URL(string: "https://skins.example.com/api/v1")!
static let universalLinkHost = "skins.example.com"
```

And `SkinCraft.entitlements` → `applinks:skins.example.com`. For universal links, set your Apple
Team ID on the server too, then restart:

```bash
sudo nano /srv/skincraft/.env      # APPLE_TEAM_ID=ABCDE12345
sudo systemctl restart skincraft
curl https://skins.example.com/.well-known/apple-app-site-association
```

---

## Updates

Cloned from git — push to `main`, then on the server:

```bash
sudo bash /srv/skincraft/deploy/update.sh
```

Pulls, reinstalls, migrates and restarts. It runs git as the `skincraft` user: git refuses to
operate on a repository owned by someone else, and pulling as root leaves root-owned files the
service can't write.

Uploaded from your Mac — `bash deploy/push.sh root@YOUR_SERVER_IP`.

Either way `node_modules` is excluded: `better-sqlite3` and `sharp` ship native binaries, and the
ones built on macOS will not run on Linux. The database and uploaded media are excluded too, so a
deploy can never clobber your catalogue.

---

## Monitoring

```bash
systemctl status skincraft            # is it running
journalctl -u skincraft -f            # live logs, this app only
ls /etc/nginx/sites-enabled/          # every site on the box
nginx -t && systemctl reload nginx    # test before reloading, always
tail -f /var/log/nginx/skincraft.access.log
```

## Backups

`deploy/backup.sh` runs nightly at 03:00 via `/etc/cron.d/skincraft-backup`, writing to
`/var/backups/skincraft` and keeping 14 days. It uses SQLite's `.backup` rather than `cp` —
copying the file while the server is writing can capture a torn page. It only touches
`/srv/skincraft`, so it's safe on a server hosting several projects.

Pull one down:

```bash
scp root@YOUR_SERVER_IP:/var/backups/skincraft/skincraft-*.db ~/Downloads/
```

Provider snapshots are worth having as well, but they're a whole-disk restore — useful after a bad
upgrade, clumsy for recovering one accidentally deleted skin.

## If something goes wrong

**Service won't start** — `journalctl -u skincraft -n 40`. Usually `SESSION_SECRET` missing from
`.env`, which the app refuses to boot without in production.

**502 Bad Gateway** — nginx is up, the app isn't. Check the service, and that `HOST`/`PORT` in
`.env` match the `proxy_pass` in `/etc/nginx/sites-available/skincraft`.

**Port already in use** — the script says so and stops. Pick another with `PORT=3002`.

**certbot fails** — the record isn't resolving here yet. Confirm with `dig +short`, then re-run
`certbot --nginx -d skins.example.com`.

**Unreachable but the service is running** — check the *provider* firewall, not just `ufw`. Both
Hetzner and Hostinger filter ahead of the server.

**Uploads fail over ~12 MB** — raise `MAX_UPLOAD_MB` in `.env` *and* `client_max_body_size` in the
nginx config. nginx rejects the request before the app sees it, so raising only one does nothing.

**Images 404 but the API works** — nginx serves `/storage/` from disk, so the `alias` must match
`STORAGE_DIR` and the files must be readable by `www-data`.
