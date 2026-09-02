/**
 * Parsing a pasted list of creative maps.
 *
 * Built around the island code rather than around a layout. A code is
 * `1234-5678-9012` and nothing else on a page looks like that, so it is a
 * reliable anchor in markup this parser has never seen — a table, a grid of
 * cards, or a plain list all give up their codes the same way. Titles and
 * images are then found relative to each code.
 *
 * That matters more here than it did for weapons: fortnite.gg serves its
 * creative listing as cards rather than a table, and its markup is behind a
 * bot challenge, so this was written without ever seeing the page. Anchoring
 * on the one thing that cannot be mistaken is what makes that survivable.
 */

const CODE = /\b(\d{4})\s*-\s*(\d{4})\s*-\s*(\d{4})\b/g;

/** Words a title is never just made of, so a stray label is not mistaken for one. */
const NOT_A_TITLE = new Set([
  'copy', 'code', 'island code', 'play', 'players', 'favourite', 'favorite',
  'map', 'maps', 'creative', 'island', 'more', 'details', 'open',
]);

const clean = (value) =>
  String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

function looksLikeTitle(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 2 || t.length > 90) return false;
  if (NOT_A_TITLE.has(t.toLowerCase())) return false;
  // A run of digits and dashes is another code, or a player count.
  if (/^[\d\s\-.,kKmM+%]+$/.test(t)) return false;
  return /[a-z]/i.test(t);
}

function absolute(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return 'https://fortnite.gg' + (src.startsWith('/') ? src : '/' + src);
}

/**
 * Pulls one map out of the text surrounding a code.
 *
 * The window is deliberately generous and searched from the code outwards: in
 * a card the title sits above the code, in a table row it sits to the left,
 * and in a plain list it is on the same line. Nearest-first covers all three
 * without needing to know which one this is.
 */
function around(text, index, isHTML, bounds = {}) {
  // The window never crosses another island code.
  //
  // Without that, reading backwards from a card's link finds the *previous*
  // card's heading and every map is paired with its neighbour's name. Another
  // code is the clearest possible marker that a different card has begun, so
  // the search stops there.
  const floor = Math.max(0, bounds.start ?? 0, index - 1200);
  const ceiling = Math.min(text.length, bounds.end ?? text.length, index + 400);

  const before = text.slice(floor, index);
  const after = text.slice(index, ceiling);

  let title = null;
  let image = null;

  if (isHTML) {
    // Both sides of the code: a card puts its heading after the link but
    // before the label, and a table row puts it in the cell to the left.
    const harvest = (chunk) => [
      ...[...chunk.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => m[1]),
      ...[...chunk.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1]),
      ...[...chunk.matchAll(/alt=["']([^"']+)["']/gi)].map((m) => m[1]),
      ...[...chunk.matchAll(/title=["']([^"']+)["']/gi)].map((m) => m[1]),
      ...[...chunk.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]),
    ].map(clean).filter(looksLikeTitle);

    const behind = harvest(before);
    const ahead = harvest(after);

    // Nearest wins: the last thing before the code, else the first thing after.
    title = behind.length ? behind[behind.length - 1] : (ahead[0] ?? null);

    const images = [...before.matchAll(/<img[^>]+(?:data-)?src=["']([^"']+)["']/gi)].map((m) => m[1]);
    image = images.length
      ? images[images.length - 1]
      : (after.match(/<img[^>]+(?:data-)?src=["']([^"']+)["']/i)?.[1] ?? null);
  } else {
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart) + after.split('\n')[0];
    const withoutCode = clean(line.replace(CODE, ' ').replace(/\t/g, ' '));
    if (looksLikeTitle(withoutCode)) title = withoutCode;

    if (!title) {
      const previous = clean(before.slice(0, lineStart).split('\n').filter(Boolean).pop() ?? '');
      if (looksLikeTitle(previous)) title = previous;
    }
  }

  return { title, image: absolute(image) };
}

/**
 * The island-card layout, as fortnite.gg actually serves it.
 *
 * Each entry is one anchor:
 *
 *   <a class="island" href="/island/7865-8305-9184">
 *     <img src="…" alt="Star Wars Droid Tycoon">
 *     <h3 class="island-title">Star Wars Droid Tycoon</h3>
 *     <div class="ccu"><span>Players Now</span> 24,509</div>
 *
 * Parsed by anchor rather than by island code, because a third of the list has
 * no code at all: Epic's own modes are slugs — `/island/experience_br`,
 * `/island/campaign` — and a code-anchored reader skips them without a word.
 * They are still reported, as skipped, so the count adds up.
 */
function parseIslandCards(html) {
  const rows = [];
  const skipped = [];
  const seen = new Set();

  const blocks = [...html.matchAll(/<a\b[^>]*class="[^"]*\bisland\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];

  for (const block of blocks) {
    const whole = block[0];
    const inner = block[1];

    const href = whole.match(/href="([^"]+)"/i)?.[1] ?? '';
    const slug = href.split('/').filter(Boolean).pop() ?? '';

    const title =
      clean(inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '') ||
      clean(inner.match(/alt="([^"]*)"/i)?.[1] ?? '');

    // Epic's own playlists cannot be joined by code, so they are not creative
    // maps in the sense this list is for.
    if (!/^\d{4}-\d{4}-\d{4}$/.test(slug)) {
      if (title) skipped.push({ line: rows.length + skipped.length + 1, text: title, why: "Epic's own mode — no island code" });
      continue;
    }

    if (seen.has(slug)) continue;
    seen.add(slug);

    if (!title) {
      skipped.push({ line: rows.length + skipped.length + 1, text: slug, why: 'no title in the card' });
      continue;
    }

    const image = inner.match(/<img[^>]+(?:data-)?src="([^"]+)"/i)?.[1] ?? null;

    // "Players Now 24,509" — the live count, which is the one number that says
    // whether a map is worth featuring.
    const playersText = inner.match(/Players Now<\/span>\s*([\d,]+)/i)?.[1] ?? null;
    const players = playersText ? Number(playersText.replace(/,/g, '')) : null;

    rows.push({
      title,
      code: slug,
      category: null,
      description: null,
      image_url: absolute(image),
      players: Number.isFinite(players) ? players : null,
    });
  }

  return { rows, skipped, fromHTML: true, fromCards: true };
}

export function parseMaps(text) {
  // The card layout is unmistakable and carries more than a loose code scan
  // can — titles, images and player counts — so it is tried first.
  if (/<a\b[^>]*class="[^"]*\bisland\b/i.test(String(text ?? ''))) {
    return parseIslandCards(String(text));
  }

  const raw = String(text ?? '');
  const isHTML = /<[a-z][\s\S]*>/i.test(raw);

  // Every position each code appears at, in order.
  //
  // A card carries its island code more than once — in the link, in the label,
  // sometimes in a data attribute — and the occurrences are not equally useful.
  // The one inside an href sits *before* the card's title, so reading backwards
  // from it finds the previous card's name and pairs every map with its
  // neighbour's code. Keeping all positions and taking the first that yields a
  // title fixes that without needing to know which layout this is.
  const positions = new Map();

  CODE.lastIndex = 0;
  let match;
  while ((match = CODE.exec(raw)) !== null) {
    const code = `${match[1]}-${match[2]}-${match[3]}`;
    if (!positions.has(code)) positions.set(code, []);
    positions.get(code).push(match.index);
  }

  const rows = [];
  const skipped = [];

  // Every code position, so a window can be stopped at its neighbours.
  const all = [...positions.values()].flat().sort((a, b) => a - b);

  for (const [code, indexes] of positions) {
    let found = null;

    for (const index of indexes) {
      const previous = all.filter((p) => p < index).pop();
      const next = all.find((p) => p > index);
      const candidate = around(raw, index, isHTML, {
        // 14 characters clears the code itself, so the boundary does not sit
        // mid-number and leave a fragment in the window.
        start: previous != null ? previous + 14 : 0,
        end: next != null ? next : undefined,
      });

      if (candidate.title) { found = candidate; break; }
      // Keep an image even from an occurrence with no title, so a map is not
      // left pictureless because its name happened to sit elsewhere.
      if (candidate.image && !found) found = candidate;
    }

    if (!found?.title) {
      skipped.push({ line: rows.length + skipped.length + 1, text: code, why: 'no title found near the code' });
      continue;
    }

    rows.push({
      title: found.title,
      code,
      category: null,
      description: null,
      image_url: found.image ?? null,
      players: null,
    });
  }

  return { rows, skipped, fromHTML: isHTML };
}
