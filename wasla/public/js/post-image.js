/*
 * «منشور اليوم» in the browser: draws the question at the two sizes the pages
 * want — a 1080 square post and a 1080 × 1920 story — with the drawing the
 * server's scheduled posts use too (post-draw.js), and offers each as a PNG.
 * Everything is drawn from what the page holds (the question, its picture from
 * this site's /media, the app icon), so the canvas is never tainted and always
 * downloadable.
 */
import { drawPost } from './post-draw.js';

const holder = document.querySelector('[data-post]');
const post = holder ? JSON.parse(holder.getAttribute('data-post')) : null;

const load = (src) => new Promise((resolve) => {
  if (!src) return resolve(null);
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

function offer(canvas, kind) {
  const link = document.querySelector(`[data-post-download="${kind}"]`);
  if (!link) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    // A redraw (the credit switched) replaces the last file offered.
    if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(blob);
    link.download = `chabbek-${kind}-${post.id}.png`;
  }, 'image/png');
}

const creditToggle = document.querySelector('[data-post-credit]');
let loaded = null;

function paint() {
  const showCredit = !creditToggle || creditToggle.checked;
  for (const canvas of document.querySelectorAll('[data-post-canvas]')) {
    drawPost(canvas.getContext('2d'), canvas.width, canvas.height, post, { ...loaded, showCredit });
    offer(canvas, canvas.getAttribute('data-post-canvas'));
  }
}

async function render() {
  await Promise.all([
    document.fonts.load('400 60px Lalezar'), document.fonts.load('800 60px Tajawal'), document.fonts.load('600 30px Tajawal'),
  ].map((p) => p.catch(() => null)));
  const [icon, picture, badge] = await Promise.all([
    load('/assets/site/app-icon.png'), load(post.image), post.store ? load('/assets/site/badge-app-store.svg') : null,
  ]);
  loaded = { icon, picture, badge };
  paint();
}

if (creditToggle) creditToggle.addEventListener('change', () => { if (loaded) paint(); });

const copy = document.querySelector('[data-copy-caption]');
const caption = document.querySelector('[data-caption]');
if (copy && caption) {
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(caption.value); copy.textContent = 'نُسخ ✓'; } catch { caption.select(); }
    setTimeout(() => { copy.textContent = 'انسخ'; }, 1800);
  });
}

if (post) render();
