/**
 * The drawings the games are played on, and where each one comes from.
 *
 * A source is one of three:
 *
 *   an emoji's English name   the Twemoji drawing of it — flat and bold
 *                             (CC BY 4.0, https://github.com/jdecked/twemoji)
 *   fluent:<Asset name>       Microsoft's Fluent Emoji, soft and rounded
 *                             (MIT, https://github.com/microsoft/fluentui-emoji)
 *   openclipart:<id>          a drawing of something emoji has none of —
 *                             الرمان، البامية، الجوافة — from Openclipart,
 *                             which is public domain (CC0, https://openclipart.org)
 *
 * A drawing is stored under a name made from its source, so the picture bank
 * and the question bank share one file for one drawing.
 */

import crypto from 'node:crypto';

const NAMES = 'https://unicode.org/Public/emoji/15.1/emoji-test.txt';
const TWEMOJI = (code) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${code}.svg`;
const OPENCLIPART = (id) => `https://openclipart.org/download/${id}/`;
const OPENCLIPART_PAGE = (id) => `https://openclipart.org/detail/${id}/`;
const FLUENT = (name) => 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/'
  // The file keeps the name's hyphens (t-shirt_color.svg) and turns the rest into _.
  + `${encodeURIComponent(name)}/Color/${name.toLowerCase().replace(/[^a-z0-9-]+/g, '_')}_color.svg`;

/** Sources that name a drawing rather than an emoji. */
export const CLIPART = /^openclipart:(\d+)$/;
export const FLUENT_SOURCE = /^fluent:(.+)$/;

export const SIDE = 512;
/** The margin the drawing keeps on every side, so no edge of it is clipped. */
export const MARGIN = 52;

/** `{ name: codepoints }` for every emoji Unicode lists, by its English name. */
export async function emojiNames() {
  const text = await (await fetch(NAMES)).text();
  const names = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('; fully-qualified')) continue;
    const [codes, rest] = line.split(';');
    const name = rest.match(/#\s+\S+\s+E\d+\.\d+\s+(.+?)\s*$/)?.[1];
    if (name) names.set(name.toLowerCase(), codes.trim().split(/\s+/).map((c) => c.toLowerCase()).join('-'));
  }
  return names;
}

/** What a written source fetches by: a drawing's name, or an emoji's codepoints. */
export const sourceOf = (written, names) => (CLIPART.test(written) || FLUENT_SOURCE.test(written)
  ? written
  : names.get(written.toLowerCase()));

/** The name a drawing is stored under: its source, and nothing else. */
export const fileFor = (source) => `${crypto.createHash('md5').update(source).digest('hex').slice(0, 24)}.png`;

/**
 * The drawing's file. Openclipart's `/download/<id>/` sometimes answers 500
 * rather than redirecting, so its page is read for the file's own address.
 */
async function fetchDrawing(source) {
  const fluent = source.match(FLUENT_SOURCE);
  if (fluent) return fetch(FLUENT(fluent[1]), { headers: { 'User-Agent': 'wasla-seed' } });

  const clipart = source.match(CLIPART);
  if (!clipart) return fetch(TWEMOJI(source), { headers: { 'User-Agent': 'wasla-seed' } });

  const direct = await fetch(OPENCLIPART(clipart[1]), { headers: { 'User-Agent': 'wasla-seed' } });
  if (direct.ok) return direct;
  const page = await fetch(OPENCLIPART_PAGE(clipart[1]), { headers: { 'User-Agent': 'wasla-seed' } });
  if (!page.ok) return direct;
  const file = (await page.text()).match(new RegExp(`/download/${clipart[1]}/[^"']+\\.svg`))?.[0];
  return file ? fetch(`https://openclipart.org${file}`, { headers: { 'User-Agent': 'wasla-seed' } }) : direct;
}

/**
 * The drawing at 512 px on nothing: it keeps its own shape, whatever shows it
 * provides the background, and it sits inside a margin so a rounded frame never
 * cuts a corner of it. Needs `sharp`, which only the drawing step does.
 */
export async function draw(source) {
  const svg = await fetchDrawing(source);
  if (!svg.ok) return null;
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(await svg.arrayBuffer()), { density: 600 })
    .resize(SIDE - MARGIN * 2, SIDE - MARGIN * 2, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .extend({
      top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/** Twemoji leaves the variation selector out of the files it ships. */
export const drawOrPlain = async (source) => await draw(source) ?? await draw(source.replace(/-fe0f/g, ''));
