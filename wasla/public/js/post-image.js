/*
 * «منشور اليوم» in the browser: draws the question at the two sizes the pages
 * want — a 1080 square post and a 1080 × 1920 story — with the drawing the
 * server's scheduled posts use too (post-draw.js), and offers each as a PNG.
 * Everything is drawn from what the page holds (the question, its picture from
 * this site's /media, the app icon), so the canvas is never tainted and always
 * downloadable.
 */
// The drawing is asked for with this file's own ?v=, so a deploy never pairs
// this page with a week-old cached copy of it.
const { drawPost } = await import(`./post-draw.js${new URL(import.meta.url).search}`);

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

// The reel is made on the server — the file a scheduled reel posts — so it is
// asked for only when wanted: it takes a few seconds the first time.
const reel = document.querySelector('[data-post-reel]');
const reelMake = document.querySelector('[data-post-reel-make]');
const reelDownload = document.querySelector('[data-post-reel-download]');
const reelUrl = () => `/admin/post/reel.mp4?id=${post.id}&credit=${!creditToggle || creditToggle.checked ? 1 : 0}`;

function playReel() {
  if (!reel || !reelMake) return;
  reelMake.disabled = true;
  reelMake.lastElementChild.textContent = 'يُصنع…';
  reel.addEventListener('loadeddata', () => { reelMake.hidden = true; }, { once: true });
  // `preload="none"` keeps the page from asking for it on load; asked now, it loads and plays.
  reel.preload = 'auto';
  reel.src = reelUrl();
  reel.play().catch(() => {});
  reel.addEventListener('error', () => {
    reelMake.disabled = false;
    reelMake.lastElementChild.textContent = 'تعذّر — أعد المحاولة';
  }, { once: true });
}

function syncReel() {
  if (reelDownload) reelDownload.href = `${reelUrl()}&download=1`;
  // A reel already showing is remade with the credit as now set.
  if (reel && reel.getAttribute('src')) playReel();
}

if (reelMake) reelMake.addEventListener('click', playReel);
syncReel();

if (creditToggle) creditToggle.addEventListener('change', () => { if (loaded) paint(); syncReel(); });

const copy = document.querySelector('[data-copy-caption]');
const caption = document.querySelector('[data-caption]');
if (copy && caption) {
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(caption.value); copy.textContent = 'نُسخ ✓'; } catch { caption.select(); }
    setTimeout(() => { copy.textContent = 'انسخ'; }, 1800);
  });
}

if (post) render();
