import express from 'express';
import { config } from '../config.js';
import { getItem, toApiShape, recordDownload } from '../services/items.js';
import { pathFor } from '../services/files.js';
import { clientFingerprint } from './api.js';
import { safeDownloadName } from '../utils/ids.js';
import { FORMATS, KIND_LABELS, CATEGORY_LABELS, INSTALL_HINTS } from '../utils/validate.js';

export const shareRouter = express.Router();

/**
 * Apple App Site Association.
 *
 * Served from the domain root so iOS will honour `applinks:` for this host. Two things bite
 * here: it must be served as `application/json` with **no** `.json` extension in the path, and
 * it must be reachable over HTTPS without any redirect — Apple's CDN follows neither redirects
 * nor a 404-to-index fallback.
 */
shareRouter.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').json({
    applinks: {
      details: [
        {
          appIDs: [`${config.appleTeamID}.${config.iosBundleID}`],
          components: [
            { '/': '/s/*', comment: 'A shared link opens that item in the app' },
          ],
        },
      ],
    },
  });
});

/**
 * `GET /d/:id` — the file itself.
 *
 * Served by the application rather than straight off the storage tree, for one reason that
 * matters and one that follows from it.
 *
 * The reason: Minecraft names an imported pack after the file it came in. On disk that file is
 * `dragon-mounts-a7f3c9d2.mcaddon`, because two uploads called `pack.mcaddon` must not collide
 * — so nginx serving the storage directory directly would put the id fragment in every
 * player's pack list. The Content-Disposition header set here restores the name the creator
 * gave it.
 *
 * What follows: this is also the honest place to count a download, since it is the moment the
 * bytes actually leave. The separate `POST /items/:id/download` remains for seeds and shares,
 * and both go through the same per-client-per-day collapse, so using both cannot double-count.
 *
 * Previews are *not* served this way — they are the bulk of the traffic by a wide margin, they
 * need no header of ours, and nginx serves them from disk.
 */
shareRouter.get('/d/:id', (req, res, next) => {
  const found = getItem(req.params.id, { published: true });
  if (!found) return next();

  const { row } = found;
  if (!row.file_name) {
    // A seed. There is nothing to send, and a 404 would suggest the item is gone.
    return res.status(409).json({
      status: 'error',
      message: 'This is a seed — copy the code rather than downloading it.',
    });
  }

  const absolute = pathFor(row.file_name);
  if (!absolute) return next();

  recordDownload(row.id, clientFingerprint(req));

  const filename = safeDownloadName(row.original_name, `${row.id}${row.file_ext || ''}`);

  // Content-Type is deliberately generic for the archive formats. iOS decides which app can
  // open a download from its *extension*, not from the MIME type, and Minecraft registers
  // .mcpack/.mcaddon/.mcworld with the system. Inventing a type here changes nothing for the
  // better and risks a browser deciding it knows how to display one.
  res.type(FORMATS[row.file_ext]?.mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=3600');

  return res.download(absolute, filename, (error) => {
    // The usual cause is the client hanging up mid-transfer, which is not a server fault and
    // must not be handed to the error page — the headers are long gone by then.
    if (error && !res.headersSent) next(error);
  });
});

/**
 * `GET /s/:id` — the landing page a shared link points at.
 *
 * This is what makes sharing a growth loop rather than a dead end. Someone with the app is
 * deep-linked straight to the item; someone without it gets a page showing what they were sent
 * and where to get it. The Open Graph tags matter as much as the page: Discord, iMessage and X
 * all render the preview from them, so the link unfurls as artwork instead of a bare URL.
 */
shareRouter.get('/s/:id', (req, res, next) => {
  const found = getItem(req.params.id, { published: true });
  if (!found) return next();

  const item = toApiShape(found.row, found.tags);
  res.type('html').send(landingPage(item));
});

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/**
 * The share page.
 *
 * Styled like the app rather than like the admin: a blocky pixel wordmark, hard square edges,
 * a raised border that reads as a Minecraft button. Nothing here is rounded, and nothing has a
 * blur — both are the visual language of the panel, and a share link is the first thing most
 * people will ever see of MineBox.
 *
 * The attribution line at the bottom is not optional. Mojang's brand guidelines require every
 * unofficial Minecraft product to carry it, and the App Store enforces the same rule at review.
 */
function landingPage(item) {
  const title = escapeHTML(item.title);
  const kind = KIND_LABELS[item.kind] || 'Item';
  const category = CATEGORY_LABELS[item.category] || '';
  const hint = item.install ? INSTALL_HINTS[item.install.method] : null;

  const description = item.kind === 'seed'
    ? `A Minecraft seed for ${item.mc_version ? `version ${item.mc_version}` : 'Bedrock'} — ${item.seed?.code}.`
    : `A free Minecraft ${kind.toLowerCase()}${category ? ` (${category.toLowerCase()})` : ''} — `
      + `${item.downloads.toLocaleString()} downloads.`;

  const url = `${config.publicUrl}/s/${item.id}`;
  const action = item.kind === 'seed'
    ? `<div class="seed"><span class="seed-label">Seed</span><code>${escapeHTML(item.seed?.code)}</code></div>`
    : `<a class="cta" href="${escapeHTML(item.file_url)}">Download</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · MineBox</title>
<meta name="description" content="${escapeHTML(description)}">

<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${escapeHTML(description)}">
<meta property="og:image" content="${escapeHTML(item.preview_url)}">
<meta property="og:url" content="${escapeHTML(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${escapeHTML(description)}">
<meta name="twitter:image" content="${escapeHTML(item.preview_url)}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Silkscreen:wght@400;700&display=swap" rel="stylesheet">

<style>
  :root {
    color-scheme: dark;
    --grass: #7fb238;
    --dirt: #79553a;
    --stone: #4a4a4a;
    --ink: #1d1d21;
    --paper: #e8e6e3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    font-family: 'Silkscreen', ui-monospace, 'SF Mono', Menlo, monospace;
    background: var(--ink);
    /* A tiled block field rather than a gradient: two offset checkers at 32px, which reads as
       terrain from a distance and as pixels up close. */
    background-image:
      linear-gradient(45deg, rgba(255,255,255,0.022) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.022) 75%),
      linear-gradient(45deg, rgba(255,255,255,0.022) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.022) 75%);
    background-size: 32px 32px;
    background-position: 0 0, 16px 16px;
    color: var(--paper);
    /* Nothing on this page is anti-aliased on purpose. */
    image-rendering: pixelated;
  }
  .card {
    width: 100%; max-width: 380px; text-align: center;
    background: #2a2a30;
    /* The Minecraft button bevel: light on the top and left, dark on the bottom and right.
       A border-image would be closer to the game's nine-slice, but this is two shadows. */
    border: 3px solid #14141a;
    box-shadow: inset 3px 3px 0 rgba(255,255,255,0.14), inset -3px -3px 0 rgba(0,0,0,0.45);
    padding: 1.25rem;
  }
  .wordmark {
    font-family: 'Press Start 2P', 'Silkscreen', monospace;
    font-size: 0.8rem; letter-spacing: 1px; color: var(--grass);
    text-shadow: 3px 3px 0 #3c5a1b; margin-bottom: 1rem;
  }
  img {
    /* height:auto is load-bearing. The width/height attributes on the tag are
       presentational hints for the CSS properties of the same name, so without this the
       height stays pinned at 800px and aspect-ratio is never consulted. */
    width: 100%; height: auto; aspect-ratio: 4 / 5; object-fit: cover; display: block;
    border: 3px solid #14141a; image-rendering: pixelated;
  }
  h1 {
    font-family: 'Press Start 2P', 'Silkscreen', monospace;
    font-size: 0.95rem; line-height: 1.5; margin: 1rem 0 0.5rem;
    text-shadow: 2px 2px 0 rgba(0,0,0,0.6);
  }
  p { margin: 0; color: #a8a49e; font-size: 0.95rem; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.35rem; justify-content: center; margin-top: 0.9rem; }
  .tag {
    font-size: 0.8rem; color: #cfcbc4; padding: 0.15rem 0.5rem;
    background: #3a3a42; border: 2px solid #14141a;
  }
  .cta, .seed {
    display: block; margin-top: 1.1rem; padding: 0.8rem 1rem;
    font-family: 'Press Start 2P', 'Silkscreen', monospace; font-size: 0.7rem;
    background: var(--grass); color: #12200a; text-decoration: none;
    border: 3px solid #14141a;
    box-shadow: inset 3px 3px 0 rgba(255,255,255,0.3), inset -3px -3px 0 rgba(0,0,0,0.28);
  }
  .cta:active { box-shadow: inset -3px -3px 0 rgba(255,255,255,0.2), inset 3px 3px 0 rgba(0,0,0,0.3); }
  .seed { background: #d9a334; color: #2a1d05; }
  .seed-label { display: block; font-size: 0.55rem; opacity: 0.8; margin-bottom: 0.4rem; }
  .seed code { font-family: inherit; font-size: 0.85rem; word-break: break-all; }
  .hint {
    margin-top: 0.9rem; font-size: 0.85rem; color: #8f8b85; line-height: 1.5;
    border-top: 2px solid #14141a; padding-top: 0.8rem;
  }
  .fine { margin-top: 1rem; font-size: 0.72rem; color: #6a665f; line-height: 1.6; }
</style>
</head>
<body>
  <main class="card">
    <div class="wordmark">MINEBOX</div>
    <img src="${escapeHTML(item.preview_url)}" alt="${title}" width="640" height="800">
    <h1>${title}</h1>
    <p>${escapeHTML(kind)}${category ? ` · ${escapeHTML(category)}` : ''} · ${item.downloads.toLocaleString()} downloads</p>
    ${item.tags.length ? `<div class="tags">${item.tags.map((tag) => `<span class="tag">#${escapeHTML(tag)}</span>`).join('')}</div>` : ''}
    ${action}
    ${hint ? `<p class="hint">${escapeHTML(hint)}</p>` : ''}
    <p class="fine">
      NOT AN OFFICIAL MINECRAFT PRODUCT.<br>
      NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
    </p>
  </main>
</body>
</html>`;
}
