# Putting MineBox on the box

MineBox lives in [koydamConfigApps](../../README.md) alongside the other three services, so
day-to-day releases are `git push` here and `sudo /opt/deploy.sh minebox` there. This document
covers the **first** install, which `deploy.sh` cannot do — it moves an existing install
forward, it does not create one.

Read the [repository README](../../README.md) first if you have not deployed here before.

---

## What you need

- The DNS record. `minebox.hamaprojects.com` → `46.224.86.198`, **before** you start, because
  certbot verifies it over HTTP and will not retry on its own.
- Root SSH to the box.
- Port 3100 free. It is MineBox's; 3000 is SkinCraft, 8080 is Brawl, 8090 is the platform panel.

---

## First install

```bash
ssh root@46.224.86.198

# The repository is already cloned at /opt/src/koydamConfigApps if any service is deployed.
cd /opt/src/koydamConfigApps && git pull

mkdir -p /opt/minebox
cp -a /opt/src/koydamConfigApps/minebox/. /opt/minebox/

cd /opt/minebox
sudo DOMAIN=minebox.hamaprojects.com EMAIL=you@example.com bash deploy/setup.sh
```

`setup.sh` is idempotent and will not overwrite an existing `.env` or database. It:

- installs Node 22 (Ubuntu's own package lags several majors, and `better-sqlite3` ships
  prebuilt binaries only for current releases)
- creates the `minebox` service account and the directory layout
- writes an `.env` with a generated `SESSION_SECRET` and a generated admin password, **which it
  prints once** — write it down
- verifies the native modules actually load, rather than letting a missing prebuilt binary
  surface later as a flapping service and a cryptic bindings error
- runs migrations, installs the systemd unit and the nginx block, and gets a certificate

---

## Then: wire it to the platform

Two steps, and the panel does not work without either.

**1. Register the app.** Sign in at <https://config.hamaprojects.com>, add an app with the slug
`minebox`. Without it, `app_admin` grants have nothing to point at — owners and admins can still
get in, but nobody can be given access to *just* MineBox.

**2. Run a deploy.** This is what actually wires single sign-on:

```bash
sudo /opt/deploy.sh minebox
```

It fills `PLATFORM_URL`, `SERVICE_TOKEN` and `PLATFORM_APP_SLUG` into `/opt/minebox/.env`, and
applies the overlay — the shared stylesheets, the logo, the SSO client and `head.ejs`. Until it
has run, the panel is on its own local login with the password `setup.sh` printed.

Confirm:

```bash
curl -s https://minebox.hamaprojects.com/api/v1/health
sudo /opt/deploy.sh list          # minebox should be listed and up
```

Then open <https://minebox.hamaprojects.com/admin> — it should bounce you to
config.hamaprojects.com and come straight back signed in. If it bounces twice, `COOKIE_DOMAIN`
on platform-api does not cover this host.

Once single sign-on works, remove `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `/opt/minebox/.env`
and delete the local account:

```bash
sudo -u minebox sqlite3 /opt/minebox/data/minebox.db \
  "DELETE FROM users WHERE platform_id IS NULL"
```

Leaving a local password in place means there are two ways in, and only one of them can be
disabled from the panel.

---

## Before the app ships

Two values in `/opt/minebox/.env` must match the shipping iOS app exactly, or universal links
fail **silently** — iOS just opens Safari:

```
APPLE_TEAM_ID=<from the Apple Developer portal, under Membership>
IOS_BUNDLE_ID=com.koydam.minebox
```

Check it landed:

```bash
curl -s https://minebox.hamaprojects.com/.well-known/apple-app-site-association
```

It must come back as `application/json`, over HTTPS, with no redirect. Apple's CDN follows
neither redirects nor a 404-to-index fallback.

---

## Day to day

```bash
git push                          # from your Mac
sudo /opt/deploy.sh minebox       # on the box
sudo /opt/deploy.sh --dry-run     # what would change, including deletions
```

**Always `--dry-run` first when the change adds or moves files.** The deploy syncs with
`--delete`, and anything on the server that is not in the repo goes. MineBox's `preserve` list
in `services.conf` protects `/storage` and `/data` — the uploaded files and the database — and
both patterns are anchored, because an unanchored `storage` would also match a `src/storage/`
added later.

Rolling back one release:

```bash
sudo /opt/deploy.sh rollback minebox <commit>
```

---

## Backups

Nightly at 03:00, by the shared `/opt/backup.sh`, which covers MineBox's `.env`, its database,
its storage tree and its systemd unit. Verify an archive can be read back:

```bash
sudo /opt/backup.sh list
sudo /opt/backup.sh verify <file>
```

**The uploaded files are the only copy there is.** Nothing regenerates an addon somebody
uploaded. Previews are different — `npm run regenerate-previews` rebuilds every one of them from
its source file, so a lost preview tree is an inconvenience rather than a loss.

`deploy/backup.sh` in this directory is a standalone equivalent, for an install that is not on
this box. Harmless alongside the shared one.

---

## When something is wrong

```bash
systemctl status minebox
journalctl -u minebox -n 80 --no-pager
sudo /opt/deploy.sh verify        # files edited by hand on the server
```

| Symptom | Usually |
| --- | --- |
| 502 from nginx | The service is not running. `journalctl -u minebox -n 40`. |
| Service flaps on boot | A native module did not build. `sudo -u minebox npm rebuild better-sqlite3 sharp`. |
| Every card image is broken | `PUBLIC_URL` does not match how clients reach the server. Every `preview_url` is built from it. |
| Downloads 404 | Same cause, or `/storage/files/` was un-blocked in nginx and something is linking to it directly. It is deliberately a 404 — files are served by `/d/:id`. |
| Uploads fail over ~50 MB | `client_max_body_size` in the nginx block is below `MAX_UPLOAD_MB`. |
| Panel renders unstyled | The overlay has not been applied. `sudo /opt/deploy.sh minebox`. |
| Sign-in bounces in a loop | `COOKIE_DOMAIN` on platform-api does not cover this host. |
| "you do not have access to 'minebox'" | The app slug is not registered in the panel, or your account has no grant for it. |
