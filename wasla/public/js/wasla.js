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
      out.textContent = letters.length ? `${letters.length} حروف: ${letters.join(' · ')}` : '';
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
    const labels = { text: 'نص', image: 'صورة', emoji: 'إيموجي', audio: 'صوت' };
    const show = () => {
      const type = has('[data-audio-file]') || kept('[data-audio-editor]', 'removeAudio') ? 'audio'
        : has('[data-zoom-file]') || kept('[data-zoom-editor]', 'removeImage') ? 'image'
          : form.querySelector('[data-emoji]')?.value.trim() ? 'emoji' : 'text';
      typeSelect.options[0].textContent = `تلقائي — ${labels[type]}`;
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

  // ── Generate levels ───────────────────────────────────────────────────────
  // The count beside a category is how many free questions it has at the chosen
  // difficulty, so it is clear before generating which category will run out first.
  document.querySelectorAll('[data-generator]').forEach((form) => {
    const difficulty = form.querySelector('[data-generator-difficulty]');
    const categories = [...form.querySelectorAll('[data-generator-category]')];
    // Nothing ticked means every category, so clearing is how you go back to that.
    form.querySelector('[data-generator-clear]')?.addEventListener('click', () => {
      categories.forEach((box) => { box.checked = false; });
    });
    // "Select all" ticks every category that still has a question at this difficulty;
    // the empty ones are disabled and stay untouched.
    const all = form.querySelector('[data-generator-all]');
    const allCount = form.querySelector('[data-generator-all-count]');
    const countable = () => categories.filter((box) => !box.disabled);
    all?.addEventListener('click', () => {
      countable().forEach((box) => { box.checked = true; });
    });
    const showCount = () => { if (allCount) allCount.textContent = countable().length; };
    if (!difficulty) return;

    difficulty.addEventListener('change', () => {
      const level = difficulty.value || 'any';
      categories.forEach((box) => {
        const free = Number(box.dataset[`free${level[0].toUpperCase()}${level.slice(1)}`] ?? 0);
        const label = box.closest('label');
        const tag = label?.querySelector('[data-generator-free]');
        if (tag) tag.textContent = free;
        // Nothing free at this difficulty: the category cannot be part of a level.
        box.disabled = free === 0;
        if (free === 0) box.checked = false;
        label?.classList.toggle('is-disabled', free === 0);
      });
      showCount();
    });
    showCount();
  });

  // ── Question picker ───────────────────────────────────────────────────────
  document.querySelectorAll('[data-picker]').forEach((picker) => {
    const filter = picker.querySelector('[data-picker-filter]');
    const count = picker.querySelector('[data-picker-count]');
    const items = [...picker.querySelectorAll('[data-picker-item]')];

    const chips = [...picker.querySelectorAll('[data-picker-category]')];
    // '' is the All chip: every category shows.
    let category = '';

    const groups = {
      in: picker.querySelector('[data-picker-group="in"]'),
      available: picker.querySelector('[data-picker-group="available"]'),
    };
    const refreshGroups = (filtering = false) => {
      Object.values(groups).forEach((group) => {
        if (!group) return;
        const shown = [...group.querySelectorAll('[data-picker-item]')].filter((item) => !item.hidden).length;
        const counter = group.querySelector('[data-picker-group-count]');
        const empty = group.querySelector('[data-picker-empty]');
        if (counter) counter.textContent = shown;
        if (!empty) return;
        // An empty group under a filter means "none here", not "none at all".
        if (!empty.dataset.emptyDefault) empty.dataset.emptyDefault = empty.textContent.trim();
        empty.textContent = filtering && empty.dataset.emptyFiltered ? empty.dataset.emptyFiltered : empty.dataset.emptyDefault;
        empty.hidden = shown > 0;
      });
    };

    /** Shows the questions matching both the typed words and the chosen category. */
    const applyFilter = () => {
      const term = filter ? filter.value.trim() : '';
      items.forEach((item) => {
        const matchesTerm = term === '' || item.dataset.text.includes(term);
        const matchesCategory = category === '' || item.dataset.title === category;
        item.hidden = !(matchesTerm && matchesCategory);
      });
      refreshGroups(term !== '' || category !== '');
    };

    filter?.addEventListener('input', applyFilter);

    chips.forEach((chip) => chip.addEventListener('click', () => {
      category = chip.dataset.pickerCategory;
      chips.forEach((other) => {
        const on = other === chip;
        other.classList.toggle('btn-kd', on);
        other.classList.toggle('btn-kd-outline', !on);
        other.setAttribute('aria-pressed', String(on));
      });
      applyFilter();
    }));
    picker.addEventListener('change', (event) => {
      count.textContent = picker.querySelectorAll('input[name="questions"]:checked').length;
      // Ticking moves a question into the level's group; unticking moves it back to the available ones.
      const item = event.target.closest('[data-picker-item]');
      const target = event.target.checked ? groups.in : groups.available;
      if (item && target) target.appendChild(item);
      // A question just ticked stays in view even when another category is chosen.
      if (item && event.target.checked) item.hidden = false;
      refreshGroups();
    });
  });
})();
