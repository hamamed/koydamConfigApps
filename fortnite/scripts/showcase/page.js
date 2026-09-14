import { pathToFileURL } from 'node:url';

/**
 * The page a showcase clip's layers are drawn from: a cosmetic the way the
 * app's detail sheet draws it, made to fill a 720×1280 frame — the artwork on
 * its tier card, then the tier chip and the name.
 *
 * Two scales. Card geometry uses --pt, 720 px over the 390 pt of an iPhone, so
 * the insets, corner radius, border and glow keep the app's proportions while
 * the card grows to fill the height. Type uses --tx, larger, because in a clip
 * the name is the headline rather than one line of a scrolling sheet; the chip
 * and name keep the app's ratio to each other. App values and sources:
 *
 *   frame     Rarity.swift `backdrop` — the tier gradient, full frame
 *   hero      DetailSheets.swift — 20 pt inset, radius 30, tier backdrop,
 *             2 pt tier border, glow radius 30, artwork fit with 20 pt padding
 *
 * One deliberate difference: the artwork is fitted by its drawn pixels, not by
 * its canvas. Upstream renders sit in a square with wide empty margins, which
 * in a tall card left the character at half its height. The transparent margin
 * is measured and left out, so nothing that is drawn — wings, capes, the floor
 * shadow — is ever cut.
 *   chip      Theme.swift `TierChip` — display face 10, kerning 0.6, 8 × 4 padding
 *   name      display face 26, primary text, 8 pt below the chip
 *
 * Layers are separated by toggling `data-layer` on the body, so one layout is
 * captured four times and the pieces line up exactly when ffmpeg stacks them.
 */

export const FRAME = { width: 720, height: 1280 };
const POINT = FRAME.width / 390;
const TEXT_POINT = 3.4;

/** A name that needs more than this many lines is set smaller until it fits. */
const MAX_NAME_LINES = 2;
const MIN_NAME_PX = 44;

/** Artwork is measured on a copy at most this many pixels on its long side. */
const SCAN_SIZE = 512;
/** Alpha at or below this is empty margin: anti-aliasing dust, not drawing. */
const ALPHA_THRESHOLD = 12;
/** Kept around the drawn pixels, as a share of the long side, so edges do not touch the padding. */
const TRIM_MARGIN = 0.012;

/**
 * @param {{ displayFont: string }} fonts absolute path of the app's display face
 * @returns {string} a complete HTML document
 */
export function pageHtml({ displayFont }) {
  const displayUrl = pathToFileURL(displayFont).href;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: AppDisplay; src: url("${displayUrl}"); }

  :root {
    --pt: ${POINT}px;
    --tx: ${TEXT_POINT}px;
    --tier: 138, 138, 153;
    --tier-end: 53, 57, 66;
    --glow: .35;
    --chip-bg: rgba(138, 138, 153, .85);
    --chip-ink: #fff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden; background: transparent; }

  /* The whole frame in the tier's colour: the app's tier backdrop — colour at
     55% down to its gradient end at 95%, over the canvas — stretched from the
     card to the frame, so every clip reads as its rarity at a glance. */
  .page {
    position: fixed; inset: 0;
    background: linear-gradient(to bottom, rgba(var(--tier), .55), rgba(var(--tier-end), .95)), #07070C;
  }

  .stack {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; gap: calc(20 * var(--pt));
    padding: calc(28 * var(--pt)) 0 calc(30 * var(--pt));
  }

  .hero-wrap { position: relative; flex: 1 1 auto; min-height: 0; margin: 0 calc(20 * var(--pt)); }
  .glow {
    position: absolute; inset: calc(4 * var(--pt));
    border-radius: calc(30 * var(--pt));
    background: rgb(var(--tier)); opacity: var(--glow);
    filter: blur(calc(30 * var(--pt)));
  }
  .hero { position: absolute; inset: 0; border-radius: calc(30 * var(--pt)); overflow: hidden; }
  .hero-fill { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(var(--tier), .55), rgba(var(--tier-end), .95)); }
  .art {
    position: absolute; inset: calc(20 * var(--pt));
    width: calc(100% - 40 * var(--pt)); height: calc(100% - 40 * var(--pt));
    object-fit: contain;
  }
  .hero-border {
    position: absolute; inset: 0; border-radius: inherit;
    padding: calc(2 * var(--pt));
    background: linear-gradient(to bottom right, rgba(var(--tier), .95), rgba(var(--tier), .35));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
  }

  .info {
    flex: 0 0 auto;
    display: flex; flex-direction: column; align-items: center; gap: calc(8 * var(--tx));
    padding: 0 calc(20 * var(--pt)); text-align: center;
  }
  .chip {
    font-family: AppDisplay; font-size: calc(10 * var(--tx)); letter-spacing: calc(.6 * var(--tx));
    padding: calc(4 * var(--tx)) calc(8 * var(--tx)); border-radius: 999px;
    background: var(--chip-bg); color: var(--chip-ink); line-height: 1.15;
  }
  .name {
    margin: 0; max-width: 100%;
    font-family: AppDisplay; font-weight: normal; font-size: calc(26 * var(--tx));
    line-height: 1.08; color: #fff; overflow-wrap: anywhere;
  }
  /* Who made the footage, for clips cut from a creator's showcase video.
     Readable at a glance, and quieter than the name it sits under. */
  .credit {
    margin-top: calc(-3 * var(--tx));
    font-family: AppDisplay; font-size: calc(7 * var(--tx)); letter-spacing: calc(.4 * var(--tx));
    color: rgba(255, 255, 255, .78);
  }

  body[data-layer="page"] .stack { visibility: hidden; }
  body[data-layer="card"] .page, body[data-layer="card"] .art, body[data-layer="card"] .info { visibility: hidden; }
  body[data-layer="art"] .page, body[data-layer="art"] .glow, body[data-layer="art"] .hero-fill,
  body[data-layer="art"] .hero-border, body[data-layer="art"] .info { visibility: hidden; }
  body[data-layer="info"] .page, body[data-layer="info"] .hero-wrap { visibility: hidden; }
</style>
</head>
<body data-layer="all">
  <div class="page"></div>
  <div class="stack">
    <div class="hero-wrap">
      <div class="glow"></div>
      <div class="hero">
        <div class="hero-fill"></div>
        <img class="art" alt="">
        <div class="hero-border"></div>
      </div>
    </div>
    <div class="info">
      <span class="chip"></span>
      <h1 class="name"></h1>
      <span class="credit" hidden></span>
    </div>
  </div>
<script>
  // The box, in the image's own pixels, that holds everything drawn in it —
  // or null for an image with nothing opaque. Read from a small copy: a 1024 px
  // render has a million pixels, and the margin is no less clear at 512.
  function drawnBox(image) {
    const scale = Math.min(1, ${SCAN_SIZE} / Math.max(image.naturalWidth, image.naturalHeight));
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, w, h);
    const { data } = context.getImageData(0, 0, w, h);

    let top = h, left = w, right = -1, bottom = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (data[(y * w + x) * 4 + 3] > ${ALPHA_THRESHOLD}) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (right < 0) return null;

    const pad = Math.round(Math.max(w, h) * ${TRIM_MARGIN});
    return {
      top: Math.max(0, top - pad) / scale,
      right: Math.max(0, w - 1 - right - pad) / scale,
      bottom: Math.max(0, h - 1 - bottom - pad) / scale,
      left: Math.max(0, left - pad) / scale,
    };
  }

  // Fills the card for one cosmetic and reports where the hero landed.
  // Text goes in through textContent only: names come from upstream.
  window.renderCard = async (card) => {
    const root = document.documentElement.style;
    Object.entries(card.css).forEach(([name, value]) => root.setProperty(name, value));

    document.querySelector('.chip').textContent = card.chip;
    const name = document.querySelector('.name');
    name.textContent = card.name;
    name.style.fontSize = '';

    const credit = document.querySelector('.credit');
    credit.textContent = card.credit ?? '';
    credit.hidden = !card.credit;

    const art = document.querySelector('.art');
    art.style.objectViewBox = '';
    art.src = card.artUrl;
    await art.decode();
    await document.fonts.ready;

    // object-fit still fits the result into the padded card; the view box just
    // stops the empty margin from counting towards the fit.
    const box = drawnBox(art);
    if (box) {
      art.style.objectViewBox = 'inset(' + box.top + 'px ' + box.right + 'px ' + box.bottom + 'px ' + box.left + 'px)';
    }

    // A long name steps down in size rather than taking a third line from the card.
    let size = parseFloat(getComputedStyle(name).fontSize);
    const tooBig = () => name.offsetHeight > size * 1.08 * ${MAX_NAME_LINES} + 2 || name.scrollWidth > name.clientWidth;
    while (tooBig() && size > ${MIN_NAME_PX}) {
      size -= 3;
      name.style.fontSize = size + 'px';
    }

    const hero = document.querySelector('.hero').getBoundingClientRect();
    return { nameSize: size, trimmed: Boolean(box), hero: { x: hero.x, y: hero.y, width: hero.width, height: hero.height } };
  };

  window.showLayer = (layer) => { document.body.dataset.layer = layer; };
</script>
</body></html>`;
}

const hexToRgb = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ');

/** The CSS custom properties that colour the card for one tier. */
export function tierCss(tier) {
  const rgb = hexToRgb(tier.color);
  return {
    '--tier': rgb,
    '--tier-end': hexToRgb(tier.gradientEnd),
    '--glow': String(tier.glowOpacity),
    '--chip-bg': `rgba(${rgb}, ${tier.prefersDarkText ? 0.92 : 0.85})`,
    '--chip-ink': tier.prefersDarkText ? 'rgba(0, 0, 0, .82)' : '#fff',
  };
}
