/*
 * Wasla panel behaviour: the picture zoom editor, the answer's played form,
 * the question type, the sound preview and the level question picker.
 * Progressive enhancement — every form still submits without it.
 */
(function () {
  'use strict';

  // ── Zoom editor ───────────────────────────────────────────────────────────
  const editor = document.querySelector('[data-zoom-editor]');
  if (editor) {
    const form = editor.closest('form');
    const file = editor.querySelector('[data-zoom-file]');
    const panes = editor.querySelector('[data-zoom-panes]');
    const controls = editor.querySelector('[data-zoom-controls]');
    const source = editor.querySelector('[data-zoom-source]');
    const preview = editor.querySelector('[data-zoom-preview]');
    const zoom = form.querySelector('input[name="zoom"]');
    const fx = form.querySelector('input[name="focusX"]');
    const fy = form.querySelector('input[name="focusY"]');
    const value = editor.querySelector('[data-zoom-value]');

    const paint = () => {
      const x = `${(Number(fx.value) * 100).toFixed(1)}%`;
      const y = `${(Number(fy.value) * 100).toFixed(1)}%`;
      [preview, source].forEach((el) => {
        el.style.setProperty('--wz-x', x);
        el.style.setProperty('--wz-y', y);
      });
      preview.style.setProperty('--wz-zoom', zoom.value);
      value.textContent = `×${Number(zoom.value).toFixed(1)}`;
    };

    zoom.addEventListener('input', paint);

    source.addEventListener('click', (event) => {
      const box = source.getBoundingClientRect();
      fx.value = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)).toFixed(3);
      fy.value = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)).toFixed(3);
      // Setting a focus point means a close-up is wanted; nudge off ×1 so it shows.
      if (Number(zoom.value) === 1) zoom.value = '2';
      paint();
    });

    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      const url = URL.createObjectURL(chosen);
      editor.querySelectorAll('[data-zoom-img]').forEach((img) => { img.src = url; });
      panes.classList.remove('d-none');
      controls.classList.remove('d-none');
      fx.value = '0.5';
      fy.value = '0.5';
      zoom.value = '1';
      paint();
    });

    paint();
  }

  // ── Answer letter count ───────────────────────────────────────────────────
  document.querySelectorAll('[data-letters]').forEach((input) => {
    const out = document.querySelector(input.dataset.letters);
    const marks = /[ؐ-ًؚ-ٰٟۖ-ۭـ\s]/g;
    const show = () => {
      const letters = [...input.value.replace(marks, '')];
      out.textContent = letters.length ? `${letters.length} letters: ${letters.join(' · ')}` : '';
    };
    input.addEventListener('input', show);
    show();
  });

  // ── How the answer is played ────────────────────────────────────────────
  // Mirrors foldForPlay in src/arabic.js: the grid has one alef, waw and yaa.
  const FOLDS = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و', 'ئ': 'ي', 'ى': 'ي' };
  const fold = (text) => text.replace(/[أإآٱؤئى]/g, (ch) => FOLDS[ch]);

  document.querySelectorAll('[data-play]').forEach((input) => {
    const out = document.querySelector(input.dataset.play);
    const marks = /[ؐ-ًؚ-ٰٟۖ-ۭـ\s]/g;
    const show = () => {
      const written = input.value.replace(marks, '');
      const played = fold(written);
      out.replaceChildren();
      if (!written) return;
      const word = document.createElement('span');
      word.className = 'wz-answer';
      word.textContent = played;
      out.append('يُلعب: ', word);
      out.classList.toggle('is-folded', played !== written);
    };
    input.addEventListener('input', show);
    show();
  });

  // ── Question type: say what "Automatic" will pick ─────────────────────
  // Mirrors deriveType in src/question-types.js. The select is not changed —
  // an explicit choice stays the admin's — only the Automatic label follows.
  const typeSelect = document.querySelector('[data-type-select]');
  if (typeSelect) {
    const form = typeSelect.form;
    const has = (selector) => Boolean(form.querySelector(selector)?.files?.length);
    const kept = (editor, removeName) => Boolean(form.querySelector(`${editor}[data-has-file]`))
      && !form.querySelector(`input[name="${removeName}"]`)?.checked;
    const labels = { text: 'text', image: 'picture', emoji: 'emoji', audio: 'audio' };
    const show = () => {
      const type = has('[data-audio-file]') || kept('[data-audio-editor]', 'removeAudio') ? 'audio'
        : has('[data-zoom-file]') || kept('[data-zoom-editor]', 'removeImage') ? 'image'
          : form.querySelector('[data-emoji]')?.value.trim() ? 'emoji' : 'text';
      typeSelect.options[0].textContent = `Automatic — ${labels[type]}`;
    };
    form.addEventListener('change', show);
    form.addEventListener('input', show);
    show();
  }

  // ── Sound preview ───────────────────────────────────────────────────────
  document.querySelectorAll('[data-audio-editor]').forEach((editor) => {
    const file = editor.querySelector('[data-audio-file]');
    const player = editor.querySelector('[data-audio-preview]');
    let url = null;
    file?.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(chosen);
      player.src = url;
      player.classList.remove('d-none');
    });
  });

  // ── Blurred picture preview ─────────────────────────────────────────────
  document.querySelectorAll('[data-blur-toggle]').forEach((box) => {
    const preview = document.querySelector('[data-zoom-preview]');
    const paint = () => preview?.classList.toggle('is-blurred', box.checked);
    box.addEventListener('change', paint);
    paint();
  });

  // ── Question picker ───────────────────────────────────────────────────────
  document.querySelectorAll('[data-picker]').forEach((picker) => {
    const filter = picker.querySelector('[data-picker-filter]');
    const count = picker.querySelector('[data-picker-count]');
    const items = [...picker.querySelectorAll('[data-picker-item]')];

    filter?.addEventListener('input', () => {
      const term = filter.value.trim();
      items.forEach((item) => { item.hidden = term !== '' && !item.dataset.text.includes(term); });
    });
    const groups = {
      in: picker.querySelector('[data-picker-group="in"]'),
      available: picker.querySelector('[data-picker-group="available"]'),
    };
    const refreshGroups = () => {
      Object.values(groups).forEach((group) => {
        if (!group) return;
        const shown = group.querySelectorAll('[data-picker-item]').length;
        const counter = group.querySelector('[data-picker-group-count]');
        const empty = group.querySelector('[data-picker-empty]');
        if (counter) counter.textContent = shown;
        if (empty) empty.hidden = shown > 0;
      });
    };
    picker.addEventListener('change', (event) => {
      count.textContent = picker.querySelectorAll('input[name="questions"]:checked').length;
      // Ticking moves a question into the level's group; unticking moves it back to the available ones.
      const item = event.target.closest('[data-picker-item]');
      const target = event.target.checked ? groups.in : groups.available;
      if (item && target) target.appendChild(item);
      refreshGroups();
    });
  });
})();
