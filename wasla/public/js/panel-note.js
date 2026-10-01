/*
 * «ملاحظاتي»: the note under the panel's header. It opens to type in, saves
 * itself a moment after the typing stops, and remembers on this device whether
 * it was left open.
 */
(function () {
  'use strict';

  const note = document.querySelector('[data-note]');
  if (!note) return;
  const toggle = note.querySelector('[data-note-toggle]');
  const body = note.querySelector('.wz-note-body');
  const text = note.querySelector('[data-note-text]');
  const preview = note.querySelector('[data-note-preview]');
  const state = note.querySelector('[data-note-state]');
  const EMPTY = 'اكتب هنا ما تريد أن تتذكّره…';
  const OPEN_KEY = 'wasla.note.open';
  const SAVE_AFTER_MS = 700;

  function setOpen(open) {
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    note.classList.toggle('is-open', open);
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* private mode: not remembered */ }
    if (open) grow();
  }

  /** As tall as its text, so nothing scrolls inside the note. */
  function grow() {
    text.style.height = 'auto';
    text.style.height = `${text.scrollHeight + 2}px`;
  }

  function showPreview() {
    const first = text.value.split('\n').find((line) => line.trim());
    preview.textContent = first || EMPTY;
  }

  let timer = null;
  let saved = text.value;

  async function save() {
    const value = text.value;
    if (value === saved) return;
    state.textContent = 'يُحفظ…';
    try {
      const response = await fetch('/admin/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-CSRF-Token': note.getAttribute('data-note-csrf') },
        body: new URLSearchParams({ text: value }),
      });
      if (!response.ok) throw new Error(String(response.status));
      saved = value;
      state.textContent = 'حُفظت ✓';
    } catch {
      state.textContent = 'لم تُحفظ — تحقّق من الاتصال';
    }
  }

  toggle.addEventListener('click', () => setOpen(body.hidden));
  text.addEventListener('input', () => {
    grow();
    showPreview();
    state.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_AFTER_MS);
  });
  // Leaving the page or the box: what was typed is not left to the timer.
  text.addEventListener('blur', () => { clearTimeout(timer); save(); });
  window.addEventListener('pagehide', () => {
    if (text.value === saved) return;
    const data = new URLSearchParams({ text: text.value, _csrf: note.getAttribute('data-note-csrf') });
    navigator.sendBeacon('/admin/note', data);
  });

  let wasOpen = false;
  try { wasOpen = localStorage.getItem(OPEN_KEY) === '1'; } catch { /* closed */ }
  setOpen(wasOpen);
})();
