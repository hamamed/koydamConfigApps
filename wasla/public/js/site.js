/**
 * The landing page's screenshot strip.
 *
 * The swiping is the browser's: the strip scrolls and snaps on its own, so a
 * phone needs none of this. What is here is for a mouse — arrows to step by one
 * shot, and dots saying which one is in the middle. With script off, or before
 * this file loads, the strip still scrolls and snaps.
 */
(() => {
  const strip = document.querySelector('[data-gallery]');
  if (!strip) return;

  const shots = Array.from(strip.querySelectorAll('img'));
  if (shots.length < 2) return;

  const prev = document.querySelector('[data-gallery-prev]');
  const next = document.querySelector('[data-gallery-next]');
  const dotsRow = document.querySelector('[data-gallery-dots]');
  // The page reads right to left, where scrolling towards the next shot means
  // scrolling towards a *smaller* x. Read it rather than assume it.
  const towardsNext = getComputedStyle(strip).direction === 'rtl' ? -1 : 1;

  /** How far apart two shots are, gap included. */
  const pitch = () => Math.abs(shots[1].offsetLeft - shots[0].offsetLeft) || shots[0].clientWidth;

  let here = -1;

  const dots = shots.map((shot, index) => {
    if (!dotsRow) return null;
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'wz-gallery-dot';
    dot.setAttribute('aria-label', `الصورة ${index + 1} من ${shots.length}`);
    dot.addEventListener('click', () => {
      shot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
    dotsRow.appendChild(dot);
    return dot;
  });

  /**
   * Whether the strip is against one of its ends, measured from where the first
   * and last shot have landed rather than from `scrollLeft` — whose zero point
   * and sign in a right-to-left page differ between browsers.
   */
  function ends() {
    const box = strip.getBoundingClientRect();
    const first = shots[0].getBoundingClientRect();
    const last = shots[shots.length - 1].getBoundingClientRect();
    const rtl = towardsNext === -1;
    return {
      atStart: (rtl ? box.right - first.right : first.left - box.left) >= -2,
      atEnd: (rtl ? last.left - box.left : box.right - last.right) >= -2,
    };
  }

  function settle(index) {
    here = index;
    dots.forEach((dot, i) => dot && dot.classList.toggle('is-here', i === index));
    const edge = ends();
    if (prev) prev.disabled = edge.atStart;
    if (next) next.disabled = edge.atEnd;
  }

  // Which shot is the one being looked at: the one whose middle is nearest the
  // middle of the strip. Measured from the laid-out boxes rather than from a
  // scroll offset, whose sign differs between browsers in a right-to-left page
  // — and unlike "how much of it is showing", it cannot tie when two shots are
  // both fully on screen.
  function nearest() {
    const box = strip.getBoundingClientRect();
    const middle = box.left + box.width / 2;
    let best = 0;
    let bestGap = Infinity;
    shots.forEach((shot, index) => {
      const shotBox = shot.getBoundingClientRect();
      const gap = Math.abs(shotBox.left + shotBox.width / 2 - middle);
      if (gap < bestGap) { bestGap = gap; best = index; }
    });
    return best;
  }

  // Called straight from the scroll event rather than deferred to the next
  // frame. It is a handful of box reads, and a deferred version that never got
  // its frame — a background tab, or a browser that throttles them — would
  // latch on its "already queued" flag and stop updating for good.
  const onScroll = () => settle(nearest());
  strip.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  const step = (direction) => strip.scrollBy({ left: direction * towardsNext * pitch(), behavior: 'smooth' });
  if (prev) prev.addEventListener('click', () => step(-1));
  if (next) next.addEventListener('click', () => step(1));

  // The arrow keys, once the strip has been tabbed to. Left and right are the
  // keys' own directions, not the reading order's.
  strip.addEventListener('keydown', (event) => {
    const keyed = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (keyed === undefined) return;
    event.preventDefault();
    strip.scrollBy({ left: keyed * pitch(), behavior: 'smooth' });
  });

  settle(nearest());
})();
