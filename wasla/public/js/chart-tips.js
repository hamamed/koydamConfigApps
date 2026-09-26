/*
 * The panel's chart tooltips: point at a bar (or tap it on a phone, or tab to
 * it) and a small plate says what it is and how much — "26/09: 7,104 حدثاً".
 * Anything with `data-tip` gets one; the charts put it on each day's column and
 * on each horizontal bar. Progressive enhancement: without it the numbers are
 * still in the page for screen readers (aria-label) and the cards' totals.
 */
(function () {
  'use strict';

  const tip = document.createElement('div');
  tip.className = 'wz-tip';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  document.body.appendChild(tip);

  let current = null;
  let hideTimer = null;
  /** When a finger last touched down: a tap also focuses the bar, and that focus is not a keyboard's. */
  let touchedAt = 0;

  /** Above the thing pointed at, centred on it, kept inside the screen. */
  function place(target) {
    const box = target.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const margin = 8;
    const left = Math.min(Math.max(box.left + box.width / 2 - width / 2, margin), window.innerWidth - width - margin);
    const above = box.top - height - 10;
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${(above > margin ? above : box.bottom + 10) + window.scrollY}px`;
  }

  function show(target) {
    clearTimeout(hideTimer);
    if (current && current !== target) current.classList.remove('is-tipped');
    current = target;
    target.classList.add('is-tipped');
    tip.textContent = target.getAttribute('data-tip');
    tip.hidden = false;
    place(target);
  }

  function hide() {
    if (current) current.classList.remove('is-tipped');
    current = null;
    tip.hidden = true;
  }

  const tipped = (event) => (event.target instanceof Element ? event.target.closest('[data-tip]') : null);

  document.addEventListener('pointerover', (event) => {
    const target = tipped(event);
    if (target && event.pointerType !== 'touch') show(target);
  });
  document.addEventListener('pointerout', (event) => {
    const target = tipped(event);
    if (target && event.pointerType !== 'touch' && !target.contains(event.relatedTarget)) hide();
  });
  // A finger has no hover: a tap shows it, and it goes by itself a moment later.
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    touchedAt = Date.now();
    const target = tipped(event);
    if (!target) { hide(); return; }
    show(target);
    hideTimer = setTimeout(hide, 2500);
  });
  // Tabbing to a bar shows it too — but not the focus a tap brings with it, which
  // would cancel the tap's own hiding and leave the plate up for good.
  const fromTouch = () => Date.now() - touchedAt < 1000;
  document.addEventListener('focusin', (event) => { const target = tipped(event); if (target && !fromTouch()) show(target); });
  document.addEventListener('focusout', (event) => { if (tipped(event) && !fromTouch()) hide(); });
  window.addEventListener('scroll', () => { if (current) place(current); }, { passive: true });
})();
