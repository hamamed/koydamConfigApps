import { CLIP_FRAME } from './compose.js';

/**
 * The page a rendered clip's two layers are drawn from: exactly what sits
 * inside the app's detail box — the tier backdrop, and the artwork inset on it.
 *
 * No frame, border, glow or text. The app and the panel draw their own box
 * around a clip, and a clip that brought its own was a box inside a box with
 * the name printed twice. At 3:4 it fills either one edge to edge.
 *
 * Values from the app: the backdrop is Rarity.swift's — tier colour at 55%
 * down to its gradient end at 95%, over the canvas — and the artwork is inset
 * by the detail box's 20 pt padding on a box about 350 pt wide.
 *
 * The artwork is fitted by its drawn pixels, not its canvas: upstream renders
 * sit in a square with wide empty margins, which left the character small. The
 * transparent margin is measured and left out, so nothing drawn is ever cut.
 */

export const FRAME = CLIP_FRAME;

const ART_INSET = Math.round((CLIP_FRAME.width * 20) / 350);

/** Artwork is measured on a copy at most this many pixels on its long side. */
const SCAN_SIZE = 512;
/** Alpha at or below this is empty margin: anti-aliasing dust, not drawing. */
const ALPHA_THRESHOLD = 12;
/** Kept around the drawn pixels, as a share of the long side. */
const TRIM_MARGIN = 0.012;

/** @returns {string} a complete HTML document */
export function pageHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { --tier: 138, 138, 153; --tier-end: 53, 57, 66; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden; background: transparent; }

  .page {
    position: fixed; inset: 0;
    background: linear-gradient(to bottom, rgba(var(--tier), .55), rgba(var(--tier-end), .95)), #07070C;
  }
  .art {
    position: absolute; left: ${ART_INSET}px; top: ${ART_INSET}px;
    width: ${FRAME.width - 2 * ART_INSET}px; height: ${FRAME.height - 2 * ART_INSET}px;
    object-fit: contain;
  }

  body[data-layer="page"] .art { visibility: hidden; }
  body[data-layer="art"] .page { visibility: hidden; }
</style>
</head>
<body data-layer="all">
  <div class="page"></div>
  <img class="art" alt="">
<script>
  // The box, in the image's own pixels, that holds everything drawn in it —
  // or null for an image with nothing opaque.
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

  // Colours the backdrop and places the artwork; reports the artwork's box.
  window.renderCard = async (card) => {
    const root = document.documentElement.style;
    Object.entries(card.css).forEach(([name, value]) => root.setProperty(name, value));

    const art = document.querySelector('.art');
    art.style.objectViewBox = '';
    art.src = card.artUrl;
    await art.decode();

    const box = drawnBox(art);
    if (box) {
      art.style.objectViewBox = 'inset(' + box.top + 'px ' + box.right + 'px ' + box.bottom + 'px ' + box.left + 'px)';
    }

    const rect = art.getBoundingClientRect();
    return { art: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  };

  window.showLayer = (layer) => { document.body.dataset.layer = layer; };
</script>
</body></html>`;
}

const hexToRgb = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ');

/** The CSS custom properties that colour the backdrop for one tier. */
export function tierCss(tier) {
  return { '--tier': hexToRgb(tier.color), '--tier-end': hexToRgb(tier.gradientEnd) };
}
