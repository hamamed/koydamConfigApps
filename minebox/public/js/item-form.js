/*
 * The add/edit form.
 *
 * Five kinds share one form, and each needs a different part of it. This shows the right part
 * and nothing else.
 *
 * Progressive enhancement, as everywhere in this panel. With this file blocked or still
 * loading the form is complete rather than broken: every field is present, every category in
 * the catalogue is listed, and the server validates the combination it is sent. What this adds
 * is not being shown a seed code box while uploading a texture pack.
 *
 * It is a separate file rather than a script tag in the template because the panel runs under
 * a Content-Security-Policy with no 'unsafe-inline'. An inline script would not be reported —
 * it would simply never run, and the form would silently revert to the state described above.
 */

(function () {
  'use strict';

  const form = document.querySelector('[data-item-form]');
  if (!form) return;

  const kindSelect = form.querySelector('[data-kind-select]');
  const categorySelect = form.querySelector('[data-category-select]');
  if (!kindSelect) return;

  const accepted = readJson(form.dataset.accepted) || {};
  const hints = readJson(form.dataset.installHints) || {};

  function readJson(value) {
    try {
      return JSON.parse(value || 'null');
    } catch {
      return null;
    }
  }

  /** Show only the sections that belong to this kind. */
  function applyKind() {
    const kind = kindSelect.value;

    form.querySelectorAll('[data-kind-only]').forEach((section) => {
      section.hidden = section.dataset.kindOnly !== kind;
    });
    form.querySelectorAll('[data-kind-except]').forEach((section) => {
      section.hidden = section.dataset.kindExcept === kind;
    });

    // Only this kind's categories stay reachable. Disabling the group as well as hiding it
    // matters: a hidden optgroup is still selectable with a keyboard in several browsers, and
    // the selection it produces is one the server will reject.
    if (categorySelect) {
      let needsNewSelection = false;

      categorySelect.querySelectorAll('optgroup').forEach((group) => {
        const mine = group.dataset.kind === kind;
        group.hidden = !mine;
        group.disabled = !mine;
        if (!mine && group.querySelector('option:checked')) needsNewSelection = true;
      });

      // Switching kind leaves the old kind's category selected, which is now hidden — so the
      // control shows blank while still submitting the old value. Falling back to the first
      // valid option keeps what is displayed and what is sent the same thing.
      if (needsNewSelection || !categorySelect.value) {
        const first = categorySelect.querySelector(`optgroup[data-kind="${kind}"] option`);
        if (first) first.selected = true;
      }
    }

    const hint = form.querySelector('[data-accepted-hint]');
    if (hint) {
      const extensions = accepted[kind] || [];
      hint.textContent = extensions.length
        ? `Accepts ${extensions.join(', ')}. ${hints[installFor(extensions[0])] || ''}`.trim()
        : '';
    }
  }

  /** The install method the first accepted extension implies, for the hint under the dropzone. */
  function installFor(extension) {
    return {
      '.png': 'skin_png',
      '.mcpack': 'mcpack',
      '.mcaddon': 'mcaddon',
      '.mcworld': 'mcworld',
      '.mctemplate': 'mcworld',
      '.zip': 'zip',
    }[extension] || 'zip';
  }

  kindSelect.addEventListener('change', applyKind);
  applyKind();

  // ── The payload dropzone ──────────────────────────────────────────────────
  //
  // The shared dropzone code previews an *image*, which is right for the card art and useless
  // for a .mcworld. This shows the name and size instead — enough to catch the classic mistake
  // of uploading the wrong file and only discovering it from a player's report.
  const fileInput = form.querySelector('[data-file-input]');

  if (fileInput) {
    const zone = fileInput.closest('[data-file-drop]');
    const empty = zone?.querySelector('[data-dropzone-empty]');
    const chosen = zone?.querySelector('[data-file-chosen]');
    const nameEl = zone?.querySelector('[data-file-name]');
    const sizeEl = zone?.querySelector('[data-file-size]');

    const reflect = () => {
      const file = fileInput.files?.[0];
      if (!file || !chosen) return;
      if (nameEl) nameEl.textContent = file.name;
      if (sizeEl) sizeEl.textContent = formatBytes(file.size);
      chosen.classList.remove('d-none');
      empty?.classList.add('d-none');
    };

    fileInput.addEventListener('change', reflect);

    // The shared handler assigns dropped files to the input but fires no change event, so the
    // name would only appear when a file was chosen through the picker.
    zone?.addEventListener('drop', () => window.setTimeout(reflect, 0));
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  }

  // ── Seed coordinates ──────────────────────────────────────────────────────
  //
  // Rows are cloned rather than built, so the markup lives in the template alongside every
  // other field instead of being written twice in two languages.
  const highlights = form.querySelector('[data-highlights]');
  const addButton = form.querySelector('[data-add-highlight]');

  addButton?.addEventListener('click', () => {
    const rows = highlights.querySelectorAll('[data-highlight-row]');
    if (rows.length >= 8) return;

    const copy = rows[rows.length - 1].cloneNode(true);
    copy.querySelectorAll('input').forEach((input) => { input.value = ''; });
    highlights.appendChild(copy);
    copy.querySelector('input')?.focus();
  });
})();
