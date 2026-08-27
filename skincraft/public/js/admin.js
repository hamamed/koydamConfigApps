/*
 * Admin panel behaviour.
 *
 * Everything here is progressive enhancement — the panel is server-rendered and every action is
 * a real form submit, so it works with JavaScript disabled or still loading. This file only makes
 * the common paths quicker.
 */

(function () {
  'use strict';

  const iconsReady = () => window.lucide?.createIcons();
  iconsReady();

  // ── Sidebar (mobile) ────────────────────────────────────────────────────
  const sidebar = document.getElementById('scSidebar');
  const scrim = document.getElementById('scScrim');
  const toggle = document.getElementById('scMenuToggle');

  // is-open, not d-none. The stylesheet holds the scrim at opacity 0 with
  // pointer-events: none until it is opened, so removing d-none revealed an
  // invisible element nothing could click: the backdrop never appeared and
  // tapping outside the drawer did nothing.
  function closeSidebar() {
    sidebar?.classList.remove('is-open');
    scrim?.classList.remove('is-open');
  }

  toggle?.addEventListener('click', () => {
    const open = sidebar?.classList.toggle('is-open');
    scrim?.classList.toggle('is-open', Boolean(open));
  });
  scrim?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });

  // ── File drop zones ─────────────────────────────────────────────────────
  //
  // Showing the chosen file immediately is the single most useful thing here: uploading the
  // wrong template and only finding out on the detail page is the classic admin-panel mistake.
  document.querySelectorAll('[data-dropzone]').forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    const preview = document.getElementById(zone.dataset.preview);
    const empty = zone.querySelector('[data-dropzone-empty]');
    if (!input) return;

    const showPreview = (file) => {
      if (!file || !preview) return;
      const url = URL.createObjectURL(file);
      preview.src = url;
      preview.classList.remove('d-none');
      empty?.classList.add('d-none');
      // Release the blob once the browser has decoded it; these can be several megabytes.
      preview.onload = () => URL.revokeObjectURL(url);
    };

    input.addEventListener('change', () => showPreview(input.files?.[0]));

    ['dragenter', 'dragover'].forEach((type) =>
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('is-dragging');
      })
    );

    ['dragleave', 'drop'].forEach((type) =>
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove('is-dragging');
      })
    );

    zone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      // Assigning through DataTransfer is the only way to programmatically set a file input.
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      showPreview(file);
    });
  });

  // ── Tag suggestions ─────────────────────────────────────────────────────
  const tagInput = document.getElementById('tags');
  document.querySelectorAll('[data-tag-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!tagInput) return;
      const tag = button.dataset.tagSuggestion;
      const current = tagInput.value
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (current.includes(tag)) return;
      current.push(tag);
      tagInput.value = current.join(', ');
      tagInput.focus();
    });
  });

  // ── Filters submit on change ────────────────────────────────────────────
  document.querySelectorAll('[data-auto-submit]').forEach((control) => {
    control.addEventListener('change', () => control.form?.submit());
  });

  // ── Destructive action confirmation ─────────────────────────────────────
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  // ── Optimistic featured toggle ──────────────────────────────────────────
  //
  // Featuring is the action an editor repeats most while curating, and a full page reload for
  // each one loses scroll position. Post in the background and flip the button locally instead;
  // any failure falls back to a normal submit so the user is never left guessing.
  document.querySelectorAll('form[data-quick-action]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button?.setAttribute('disabled', 'disabled');

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-CSRF-Token': form.querySelector('[name="_csrf"]').value },
          body: new URLSearchParams(new FormData(form)),
        });
        if (!response.ok) throw new Error('Request failed');

        const payload = await response.json();
        const isOn = payload.data.featured ?? payload.data.published;
        button?.classList.toggle('is-on', Boolean(isOn));

        const icon = button?.querySelector('svg, i');
        if (icon) {
          icon.setAttribute('fill', isOn ? 'currentColor' : 'none');
        }
        // Reflect the change in the card's badge row without a reload.
        const card = form.closest('.ad-skin-card-wrap');
        const flags = card?.querySelector('.ad-skin-flags');
        const existing = flags?.querySelector('.ad-badge.featured');
        if (isOn && flags && !existing) {
          const badge = document.createElement('span');
          badge.className = 'ad-badge featured';
          badge.textContent = 'Featured';
          flags.prepend(badge);
        } else if (!isOn && existing) {
          existing.remove();
        }
      } catch {
        form.submit();
      } finally {
        button?.removeAttribute('disabled');
      }
    });
  });
})();
