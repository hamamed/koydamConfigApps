import express from 'express';
import { config } from '../config.js';
import { getSkin, toApiShape } from '../services/skins.js';
import { CATEGORY_LABELS } from '../utils/validate.js';

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
          // From APPLE_TEAM_ID; boot warns if it is still the placeholder.
          appIDs: [`${config.appleTeamID}.${config.iosBundleID}`],
          components: [
            { '/': '/s/*', comment: 'Shared skin links open the skin in the app' },
          ],
        },
      ],
    },
  });
});

/**
 * `GET /s/:id` — the landing page a shared card links to.
 *
 * This is what makes sharing a growth loop rather than a dead end. Someone with the app gets
 * deep-linked straight to the skin; someone without it gets a page that shows what they were
 * sent and where to get it. The Open Graph tags matter as much as the page: Discord, iMessage
 * and X all render the preview from them, so the link unfurls as artwork instead of a bare URL.
 */
shareRouter.get('/s/:id', (req, res, next) => {
  const found = getSkin(req.params.id, { published: true });
  if (!found) return next();

  const skin = toApiShape(found.row, found.tags);
  const category = CATEGORY_LABELS[skin.category] || 'Skin';

  res.type('html').send(landingPage({ skin, category, publicUrl: config.publicUrl }));
});

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function landingPage({ skin, category, publicUrl }) {
  const title = escapeHTML(skin.title);
  const description = `A free ${category.toLowerCase()} template for your Roblox avatar — ${skin.downloads.toLocaleString()} downloads.`;
  const url = `${publicUrl}/s/${skin.id}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · SkinCraft</title>
<meta name="description" content="${escapeHTML(description)}">

<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${escapeHTML(description)}">
<meta property="og:image" content="${escapeHTML(skin.preview_url)}">
<meta property="og:url" content="${escapeHTML(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${escapeHTML(description)}">
<meta name="twitter:image" content="${escapeHTML(skin.preview_url)}">

<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
    background: #08080c;
    background-image:
      radial-gradient(50rem 34rem at 20% -10%, rgba(124, 92, 255, 0.28), transparent 60%),
      radial-gradient(42rem 30rem at 90% 10%, rgba(45, 226, 230, 0.16), transparent 60%);
    color: #f5f5fa;
  }
  .card {
    width: 100%; max-width: 380px; text-align: center;
    background: rgba(22, 22, 31, 0.7); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 22px; padding: 1.5rem; backdrop-filter: blur(18px);
  }
  img { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 14px; display: block; }
  h1 { font-size: 1.4rem; margin: 1rem 0 0.25rem; letter-spacing: -0.02em; }
  p { margin: 0; color: #9a9aae; font-size: 0.9rem; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: center; margin-top: 0.9rem; }
  .tag {
    font-size: 0.74rem; color: #9a9aae; padding: 0.2rem 0.6rem; border-radius: 999px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
  }
  .cta {
    display: block; margin-top: 1.25rem; padding: 0.85rem 1rem; border-radius: 14px;
    background: linear-gradient(135deg, #7c5cff, #2de2e6); color: #fff;
    font-weight: 600; text-decoration: none;
  }
  .fine { margin-top: 1rem; font-size: 0.7rem; color: #62627a; }
</style>
</head>
<body>
  <main class="card">
    <img src="${escapeHTML(skin.preview_url)}" alt="${title}" width="640" height="800">
    <h1>${title}</h1>
    <p>${category} · ${skin.downloads.toLocaleString()} downloads</p>
    ${skin.tags.length ? `<div class="tags">${skin.tags.map((tag) => `<span class="tag">#${escapeHTML(tag)}</span>`).join('')}</div>` : ''}
    <a class="cta" href="${escapeHTML(skin.template_url)}" download>Download the template</a>
    <p class="fine">Open in SkinCraft for a 3D preview. Not affiliated with Roblox Corporation.</p>
  </main>
</body>
</html>`;
}
