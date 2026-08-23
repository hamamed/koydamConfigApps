# Deploying to a Hostinger VPS

## First: check you have the right product

| Hostinger product | Works? |
| --- | --- |
| **VPS hosting** | Yes — you get root SSH, install whatever you like |
| Web / shared hosting | **No** |
| Cloud hosting | **No** |

Shared and Cloud hosting run PHP behind a managed process pool. There's no Node.js runtime, no way
to keep a long-lived process alive, and no writable location for a SQLite database. This app needs
all three. If hPanel shows you *Websites* rather than *VPS*, you'll need to upgrade before any of
what follows applies.

The rest of this assumes **hPanel → VPS**.

---

## 1. Prepare the server

In hPanel → **VPS** → your server:

- **Operating System** → choose a plain **Ubuntu 24.04** template.
  Avoid the templates that come with CyberPanel, CloudPanel or Plesk — they install and manage
  their own web server, which will fight the nginx config here over ports 80 and 443.
- **SSH Keys** → add your public key (`cat ~/.ssh/id_ed25519.pub`). Password login works too, but
  the upload script will ask for it on every deploy.
- **Firewall** → the setup script configures `ufw` on the server itself. If you also enable
  Hostinger's network firewall, allow **22, 80 and 443** there as well, or you'll lock yourself out.

Note the server's IP from the **Overview** tab.

## 2. Point the domain at it

If the domain is registered with Hostinger: **hPanel → Domains → DNS / Nameservers → DNS zone**.

| Type | Name | Points to |
| --- | --- | --- |
| A | `vps` (or `@` for the root domain) | your VPS IP |

Wait for it to resolve before requesting a certificate — Let's Encrypt validates over HTTP, and it
will fail against a stale record:

```bash
dig +short vps.yourdomain.com     # should print your VPS IP
```

## 3. Get the code onto the server

Two ways. **From GitHub** is the better one if the repo already exists — the server pulls
directly, and updates are one command with no laptop involved.

### From GitHub

```bash
ssh root@YOUR_SERVER_IP
apt-get update && apt-get install -y git
git clone https://github.com/hamamed/skincraft.git /srv/skincraft
```

A private repo will ask for credentials. Either use a
[fine-grained personal access token](https://github.com/settings/tokens) as the password, or add
a deploy key:

```bash
ssh-keygen -t ed25519 -f /root/.ssh/skincraft_deploy -N ""
cat /root/.ssh/skincraft_deploy.pub
# paste into GitHub → repo → Settings → Deploy keys → Add (read-only is enough)
git clone git@github.com:hamamed/skincraft.git /srv/skincraft
```

### From your Mac

```bash
bash deploy/push.sh root@YOUR_SERVER_IP
```

Uploads over rsync. Nothing needs to exist on GitHub.

## 4. Provision

From your Mac, in the project directory:

```bash
bash deploy/push.sh root@YOUR_SERVER_IP
```

```bash
cd /srv/skincraft
sudo DOMAIN=vps.yourdomain.com EMAIL=you@example.com bash deploy/hostinger-setup.sh
```

That single script installs Node 22, creates the `skincraft` service user, installs dependencies,
runs migrations, registers the systemd service, configures nginx, opens the firewall, requests a
TLS certificate and schedules nightly backups. It's idempotent — safe to re-run — and it will never
overwrite an existing `.env` or database.

It prints a generated admin password at the end. Change it once you're in:

```bash
cd /srv/skincraft && sudo -u skincraft npm run create-admin -- admin 'your-new-password'
```

## 5. Point the app at it

In the iOS project:

```swift
// AppConfig.swift
static let baseURL = URL(string: "https://vps.yourdomain.com/api/v1")!
static let universalLinkHost = "vps.yourdomain.com"
```

And `SkinCraft.entitlements` → `applinks:vps.yourdomain.com`.

For universal links, also set your Apple Team ID on the server, then restart:

```bash
sudo nano /srv/skincraft/.env      # APPLE_TEAM_ID=ABCDE12345
sudo systemctl restart skincraft
curl https://vps.yourdomain.com/.well-known/apple-app-site-association
```

## Subsequent deploys

**Deployed from GitHub** — push to `main`, then on the server:

```bash
sudo bash /srv/skincraft/deploy/update.sh
```

Pulls, reinstalls, migrates and restarts. It runs git as the `skincraft` user: git refuses to
operate on a repository owned by someone else, and running as root would leave root-owned files
behind for the service to trip over.

**Deployed by rsync** — from your Mac:

```bash
bash deploy/push.sh root@YOUR_SERVER_IP
```

Either way `node_modules` is excluded deliberately: `better-sqlite3` and `sharp` ship native
binaries, and the ones built on macOS will not run on Linux. The database and uploaded media are
excluded too, so a deploy can never clobber your catalogue.

## Running alongside another project

One VPS can serve any number of apps. nginx routes by `server_name`, so each project gets its own
subdomain, its own Node process on its own loopback port, and its own systemd service. Nothing is
shared except nginx and the machine.

```
                      ┌── api.hamaprojects.com   → 127.0.0.1:3000  (existing app)
Internet → nginx :443 ┤
                      └── skins.hamaprojects.com → 127.0.0.1:3001  (this app)
```

**1. Point the subdomain at the same IP.** In hPanel → Domains → DNS zone, add an `A` record for
`skins` → the same VPS IP the existing project uses. Confirm before asking for a certificate:

```bash
dig +short skins.hamaprojects.com
```

**2. Check what's already listening**, so you pick a free port:

```bash
ss -ltnp | grep -E 'node|:300|:400'
```

**3. Install on a different port.** The setup script takes `PORT`, refuses to start if it's already
in use, and won't touch a firewall that's already active or remove other enabled nginx sites:

```bash
git clone https://github.com/hamamed/skincraft.git /srv/skincraft
cd /srv/skincraft
sudo PORT=3001 DOMAIN=skins.hamaprojects.com EMAIL=you@example.com \
     bash deploy/hostinger-setup.sh
```

It creates `/etc/nginx/sites-available/skincraft` and its own `skincraft` systemd unit and service
user, all named so they can't collide with an existing project.

**4. Certificates.** certbot issues a separate certificate for the new subdomain and edits only the
matching server block. The existing site's certificate and config are untouched. A wildcard
certificate would also work, but there's no need — separate certificates renew independently, so a
problem with one can't take the other offline.

### If the existing project isn't behind nginx

Check first:

```bash
systemctl status nginx apache2 caddy 2>/dev/null | grep -E 'nginx|apache|caddy|active'
```

If it's **Apache** or **Caddy**, don't install nginx alongside it — two servers can't both hold
port 443. Either move this app behind the existing server as a reverse proxy (a virtual host for
`skins.hamaprojects.com` proxying to `127.0.0.1:3001`), or migrate the other project to nginx. The
app itself doesn't care: it listens on loopback and something in front terminates TLS.

### Managing both

```bash
systemctl status skincraft            # this app
journalctl -u skincraft -f            # its logs only
ls /etc/nginx/sites-enabled/          # every site on the box
nginx -t && systemctl reload nginx    # after any nginx change — test before reloading
```

Backups are per-app: `deploy/backup.sh` only touches `/srv/skincraft`.

## Checking on it

```bash
systemctl status skincraft          # is it running
journalctl -u skincraft -f          # live logs
journalctl -u skincraft -n 100      # recent logs
nginx -t && systemctl reload nginx  # after editing nginx config
tail -f /var/log/nginx/skincraft.access.log
```

## Backups

`deploy/backup.sh` runs nightly at 03:00 via `/etc/cron.d/skincraft-backup`, writing to
`/var/backups/skincraft` and keeping 14 days. It uses SQLite's `.backup` rather than `cp` —
copying the file while the server is writing can capture a torn page.

Pull one down to your Mac:

```bash
scp root@YOUR_SERVER_IP:/var/backups/skincraft/skincraft-*.db ~/Downloads/
```

Hostinger's own **VPS → Snapshots** are worth enabling as well, but they're a whole-disk restore —
useful after a bad upgrade, clumsy for recovering one accidentally deleted skin.

## If something goes wrong

**Service won't start** — `journalctl -u skincraft -n 40`. Usually `SESSION_SECRET` missing from
`.env`, which the app refuses to boot without in production.

**502 Bad Gateway** — nginx is up but the app isn't. Check the service; check `HOST=127.0.0.1` and
`PORT=3000` in `.env` match the `proxy_pass` in the nginx config.

**certbot fails** — the A record isn't resolving to this server yet. Confirm with `dig +short`,
then re-run `certbot --nginx -d vps.yourdomain.com`.

**Uploads fail over ~12 MB** — raise `MAX_UPLOAD_MB` in `.env` *and* `client_max_body_size` in the
nginx config. nginx rejects the request before the app ever sees it, so raising only one does
nothing.

**Images 404 but the API works** — nginx serves `/storage/` straight from disk, so the `alias`
path must match `STORAGE_DIR`, and the files must be readable by `www-data`.
