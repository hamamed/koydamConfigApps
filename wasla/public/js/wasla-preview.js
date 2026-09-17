/*
 * Level preview: switches the phone between the grid and each word's question
 * page, the way swiping a word and going back does in the app.
 */
(function () {
  'use strict';

  const root = document.querySelector('[data-preview]');
  if (!root) return;

  const pages = root.querySelectorAll('[data-page]');
  const items = root.querySelectorAll('[data-show]');
  let current = 'grid';

  function stopAudio() {
    root.querySelectorAll('[data-audio]').forEach((audio) => {
      audio.pause();
      const glyph = audio.parentElement.querySelector('[data-play-glyph]');
      if (glyph) glyph.textContent = '▶';
    });
  }

  function show(name) {
    if (!root.querySelector(`[data-page="${name}"]`)) return;
    stopAudio();
    current = name;
    pages.forEach((page) => page.classList.toggle('is-shown', page.dataset.page === name));
    items.forEach((item) => item.classList.toggle('is-active', item.dataset.show === name));
    const screen = root.querySelector('.wp-screen');
    if (screen) screen.scrollTop = 0;
  }

  items.forEach((item) => item.addEventListener('click', () => show(item.dataset.show)));

  // A tile shared by two words opens the other one on a second tap.
  root.querySelectorAll('.wp-tile').forEach((tile) => tile.addEventListener('click', () => {
    const words = tile.dataset.words.split(',').map((i) => `word-${i}`);
    const at = words.indexOf(current);
    show(words[at === -1 ? 0 : (at + 1) % words.length]);
  }));

  root.querySelector('[data-back]')?.addEventListener('click', () => show('grid'));

  root.querySelectorAll('[data-play]').forEach((button) => {
    const audio = button.parentElement.querySelector('[data-audio]');
    const glyph = button.querySelector('[data-play-glyph]');
    button.addEventListener('click', () => {
      if (audio.paused) {
        audio.play().then(() => { glyph.textContent = '❚❚'; }).catch(() => { glyph.textContent = '!'; });
      } else {
        audio.pause();
        glyph.textContent = '▶';
      }
    });
    audio.addEventListener('ended', () => { glyph.textContent = '▶'; });
  });

  // ?word=N opens a question page straight away (used for screenshots and links).
  const start = new URLSearchParams(location.search).get('word');
  if (start !== null) show(`word-${Number(start)}`);
})();
