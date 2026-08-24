# koydamConfigApps

Every service that runs on the box, in one repository.

| Directory | What it is | Domain |
|---|---|---|
| [`platform-api/`](platform-api/) | Config dashboard, single sign-on, AdMob settings for every app | config.hamaprojects.com |
| [`brawl-vps/`](brawl-vps/) | Brawl Stars API — Supercell proxy, meta crawler, Postgres + Redis | api.hamaprojects.com |
| [`skincraft/`](skincraft/) | Skin catalogue and admin panel — SQLite | skincraft.hamaprojects.com |

One sign-in covers all three. `platform-api` holds the accounts; the other two
resolve a session against it, so there is no separate password anywhere.

## Deploying

One script, on the server:

```bash
sudo /opt/deploy.sh              # everything
sudo /opt/deploy.sh brawl        # one service
sudo /opt/deploy.sh list         # what is configured, and whether it is up
sudo /opt/deploy.sh verify       # files edited by hand on the server
sudo /opt/deploy.sh --dry-run    # say what would change, change nothing
sudo /opt/deploy.sh rollback brawl 3a90b01
```

It pulls this repository, so a release is a push rather than an upload.

Adding a service is a block in
[`platform-api/deploy/services.conf`](platform-api/deploy/services.conf) —
name, repo, subdir, target, type, unit, health URL. The script itself is never
edited.

### Installing it, once

```bash
mkdir -p /opt/src
git clone https://github.com/hamamed/koydamConfigApps.git /opt/src/koydamConfigApps
install -m 755 /opt/src/koydamConfigApps/platform-api/deploy/deploy.sh /opt/deploy.sh
```

### What a deploy will not touch

`.env`, and any data a service wrote itself — databases, uploads, wallpapers.
Those are excluded from every sync, so a deploy cannot take data with it. Each
service can name its own exceptions; Brawl does, because its `data/` holds both
hand-maintained source and generated state.

## Shared code

`platform-api/deploy/shared/` holds the files the other services import rather
than duplicate: the SSO client, and the stylesheet every panel renders. They
are copied outward on each deploy, and `deploy.sh verify` reports any copy that
has been edited on the server and no longer matches.
