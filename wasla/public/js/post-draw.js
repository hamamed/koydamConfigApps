/*
 * «منشور اليوم»'s drawing, shared: the panel draws it in the browser
 * (post-image.js) and the server draws the same thing for scheduled posts
 * (src/post-render.js), so what is posted is what the page shows.
 *
 * `drawPost(ctx, W, H, post, assets)` paints a question as the game's own card
 * on the game's ground: 1080 square for a post, 1080 × 1920 for a story. It only
 * uses the 2D canvas API, which both sides have. The answer is never drawn.
 *
 * `post` is { title, clue, letters, image, credit, site, store }; `assets` is
 * { icon, picture, badge, showCredit } — images already loaded, or null.
 */
const INK = '#1f2d3a';
const MINT = '#d6eeea';
const TEAL = '#14a49e';
const INDIGO = '#4e4a8c';
const LAVENDER = '#eeedfb';
const MUTED = '#5d7c80';
// The app's six faint triangles (TriangleField), in the unit square.
const TRIANGLES = [
  [[0.34, -0.05], [0.42, -0.05], [0.38, 0.1], 0.10], [[0.03, 1.05], [0.39, 0.1], [0.75, 1.05], 0.28],
  [[0.24, 1.05], [0.63, -0.05], [1.02, 1.05], 0.22], [[0.42, -0.05], [0.63, -0.05], [0.5, 0.25], 0.30],
  [[0.63, -0.05], [1.1, -0.05], [1.1, 0.72], 0.12], [[-0.1, 0.2], [0.25, 0.62], [-0.1, 1.05], 0.16],
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A plate as the game draws them: a face, an ink border, and an ink ledge under it. */
function plate(ctx, x, y, w, h, r, face, ledge = 10) {
  roundRect(ctx, x, y + ledge, w, h, r);
  ctx.fillStyle = INK;
  ctx.fill();
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = face;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

/**
 * The site's address as the app draws its buttons: a teal capsule with an ink
 * border and ledge, the address in white, centred on (cx, cy).
 */
function siteChip(ctx, text, cx, cy, tall) {
  ctx.save();
  ctx.direction = 'ltr';
  ctx.font = `800 ${tall ? 44 : 32}px Tajawal, sans-serif`;
  const h = tall ? 84 : 58;
  const w = ctx.measureText(text).width + (tall ? 90 : 64);
  plate(ctx, cx - w / 2, cy - h / 2, w, h, h / 2, TEAL, tall ? 8 : 6);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, cx, cy + 2);
  ctx.restore();
}

/** Arabic lines that fit `width`, broken between words. */
function lines(ctx, text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { out.push(line); line = word; } else { line = next; }
  }
  if (line) out.push(line);
  return out;
}

export function drawPost(ctx, W, H, post, assets) {
  const tall = H > W;
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // The ground.
  ctx.fillStyle = MINT;
  ctx.fillRect(0, 0, W, H);
  for (const [a, b, c, white] of TRIANGLES) {
    ctx.beginPath();
    ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.lineTo(c[0] * W, c[1] * H);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${white})`;
    ctx.fill();
  }

  // The mark: the app icon and the name.
  let y = tall ? 170 : 90;
  const icon = tall ? 150 : 110;
  if (assets.icon) {
    ctx.save();
    roundRect(ctx, W / 2 - icon / 2, y - icon / 2, icon, icon, icon * 0.22);
    ctx.clip();
    ctx.drawImage(assets.icon, W / 2 - icon / 2, y - icon / 2, icon, icon);
    ctx.restore();
  }
  y += icon / 2 + (tall ? 70 : 45);
  ctx.fillStyle = INK;
  ctx.font = `400 ${tall ? 84 : 60}px Lalezar, Tajawal, sans-serif`;
  ctx.fillText('شبّك', W / 2, y);
  y += tall ? 110 : 70;

  // The card: the category on its indigo ribbon, then the picture or the clue.
  const cardX = 70;
  const cardW = W - 140;
  const cardTop = y;
  // A little shorter on the square post when the App Store badge needs room under it.
  const cardH = post.store ? (tall ? 980 : 490) : (tall ? 1080 : 620);
  plate(ctx, cardX, cardTop, cardW, cardH, 48, '#ffffff');
  if (post.title) {
    ctx.font = `400 ${tall ? 56 : 46}px Lalezar, Tajawal, sans-serif`;
    const chipW = Math.min(cardW - 80, ctx.measureText(post.title).width + 90);
    const chipH = tall ? 88 : 74;
    plate(ctx, W / 2 - chipW / 2, cardTop - chipH / 2, chipW, chipH, chipH / 2, INDIGO, 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(post.title, W / 2, cardTop + 2);
  }

  // A credited picture keeps a line under it for its credit, inside the card —
  // unless the credit is left off the picture (the caption always carries it).
  const credit = assets.showCredit ? post.credit : '';
  const creditRoom = credit ? (tall ? 56 : 44) : 0;
  const inner = { x: cardX + 50, y: cardTop + (tall ? 90 : 70), w: cardW - 100, h: cardH - (tall ? 290 : 220) - creditRoom };
  if (assets.picture) {
    const pic = assets.picture;
    const fit = Math.min(inner.w / pic.width, inner.h / pic.height);
    const pw = pic.width * fit;
    const ph = pic.height * fit;
    const px = W / 2 - pw / 2;
    const py = inner.y + (inner.h - ph) / 2;
    ctx.save();
    roundRect(ctx, px, py, pw, ph, 30);
    ctx.clip();
    ctx.drawImage(pic, px, py, pw, ph);
    ctx.restore();
    roundRect(ctx, px, py, pw, ph, 30);
    ctx.lineWidth = 12;
    ctx.strokeStyle = LAVENDER;
    ctx.stroke();
    // Its author and licence, as CC BY and CC BY-SA ask — right under it.
    if (credit) {
      ctx.fillStyle = MUTED;
      ctx.font = `600 ${tall ? 30 : 25}px Tajawal, sans-serif`;
      ctx.fillText(`الصورة: ${credit}`, W / 2, py + ph + creditRoom * 0.62);
    }
  } else {
    ctx.fillStyle = INK;
    ctx.font = `800 ${tall ? 72 : 60}px Tajawal, sans-serif`;
    const text = lines(ctx, post.clue, inner.w);
    const lh = tall ? 108 : 88;
    let ty = inner.y + inner.h / 2 - ((text.length - 1) * lh) / 2;
    for (const line of text) { ctx.fillText(line, W / 2, ty); ty += lh; }
  }

  // The answer's empty boxes, as the question page draws them — the count, not the word.
  const slots = Math.min(post.letters, 12);
  const box = Math.min(tall ? 92 : 78, (cardW - 120) / slots - 14);
  const gap = 14;
  const rowW = slots * box + (slots - 1) * gap;
  const by = cardTop + cardH - (tall ? 160 : 125);
  for (let i = 0; i < slots; i++) {
    const bx = W / 2 - rowW / 2 + i * (box + gap);
    roundRect(ctx, bx, by, box, box, box * 0.22);
    ctx.fillStyle = MINT;
    ctx.fill();
    ctx.setLineDash([12, 9]);
    ctx.lineWidth = 5;
    ctx.strokeStyle = TEAL;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The call, then — while the game is on the store — Apple's badge, then the link.
  y = cardTop + cardH + (post.store ? (tall ? 115 : 70) : (tall ? 150 : 80));
  ctx.fillStyle = INK;
  ctx.font = `800 ${tall ? 64 : 48}px Tajawal, sans-serif`;
  ctx.fillText(post.image ? 'ما هذا؟ الجواب في شبّك' : 'الجواب في شبّك', W / 2, y);
  if (post.store && assets.badge) {
    y += tall ? 80 : 55;
    ctx.fillStyle = MUTED;
    ctx.font = `700 ${tall ? 40 : 30}px Tajawal, sans-serif`;
    ctx.fillText('حمّلها مجاناً من App Store', W / 2, y);
    // Apple's own artwork, unchanged, at its own proportions (119.66 × 40).
    const bh = tall ? 120 : 78;
    const bw = bh * (119.66407 / 40);
    y += tall ? 45 : 27;
    ctx.drawImage(assets.badge, W / 2 - bw / 2, y, bw, bh);
    y += bh + (tall ? 75 : 42);
  } else {
    y += tall ? 95 : 70;
  }
  siteChip(ctx, post.site, W / 2, y, tall);
}

