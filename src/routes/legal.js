import { Router } from 'express';

import { legalDocuments } from '../legal/documents.js';

/**
 * Public privacy policy and terms.
 *
 * App Store Connect requires a privacy policy at a **URL**, not just inside the
 * app — a reviewer opens it in a browser before the build is even installed.
 * The app also ships its own offline copy of this text; see the note in
 * src/legal/documents.js about keeping the two in step.
 *
 * Mounted ahead of the API-key gate for the obvious reason: a page that
 * demands a secret is not a published privacy policy.
 */
export const legalRouter = Router();

/** Minimal, self-contained, and readable on a phone. No external assets. */
function render(doc) {
  const sections = doc.sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.heading)}</h2>` +
        s.body
          .split('\n\n')
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join('') +
        `</section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)} — Brawl Stats</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 5rem;
    color: #14201a; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e7ede9; background: #14181a; }
    .meta { color: #93a49b; }
    h2 { color: #7fd6a0; }
  }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em;
       margin: 2.25rem 0 .5rem; color: #2a8a4e; }
  .meta { color: #5a6b60; font-size: .85rem; margin-bottom: 2rem; }
  .intro { background: rgba(55,164,95,.09); border-radius: 10px; padding: 1rem; }
  p { margin: 0 0 .85rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(doc.title)}</h1>
  <p class="meta">Brawl Stats · Updated ${escapeHtml(doc.updated)}</p>
  <div class="intro"><p>${escapeHtml(doc.intro)}</p></div>
  ${sections}
</body>
</html>`;
}

/**
 * The text is ours, but escaping it anyway costs nothing and means a future
 * edit containing an angle bracket cannot quietly break the page.
 */
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

for (const [path, doc] of Object.entries(legalDocuments)) {
  legalRouter.get(`/${path}`, (_req, res) => {
    res.type('html');
    // A store listing links here permanently, so let it cache — but not so long
    // that a correction takes a day to appear.
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(render(doc));
  });
}

/** The same text as JSON, for anything that would rather not parse HTML. */
legalRouter.get('/v1/legal', (_req, res) => res.json(legalDocuments));
