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
  const sidebar = document.getElementById('mbSidebar');
  const scrim = document.getElementById('mbScrim');
  const toggle = document.getElementById('mbMenuToggle');

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
        // kd-tag-accent, not ad-badge: outside a nav link, .ad-badge is a class the
        // stylesheet does not define, so a badge built with it would render as bare text.
        const existing = flags?.querySelector('.kd-tag-accent');
        if (isOn && flags && !existing) {
          const badge = document.createElement('span');
          badge.className = 'kd-tag kd-tag-accent';
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

  // ── Selecting several items ─────────────────────────────────────────────
  //
  // Enhancement only. The checkboxes point at the bulk form through their
  // `form` attribute, so ticking and submitting already works without this —
  // what this adds is the count, the select-all, and being asked before
  // something irreversible happens to a dozen things at once.
  const bulkForm = document.querySelector('[data-bulk]');

  if (bulkForm) {
    const count = bulkForm.querySelector('[data-bulk-count]');
    const submit = bulkForm.querySelector('[data-bulk-delete]');
    const all = bulkForm.querySelector('[data-bulk-all]');
    const boxes = Array.from(document.querySelectorAll('.ad-skin-pick input[type="checkbox"]'));

    const selected = () => boxes.filter((b) => b.checked);

    function reflect() {
      const n = selected().length;
      count.textContent = n === 0
        ? 'None selected'
        : `${n} selected`;
      submit.disabled = n === 0;
      if (all) {
        all.checked = n > 0 && n === boxes.length;
        // Neither on nor off: some are ticked. Without this the header box
        // claims everything is selected the moment one card is.
        all.indeterminate = n > 0 && n < boxes.length;
      }
    }

    boxes.forEach((box) => box.addEventListener('change', reflect));

    all?.addEventListener('change', () => {
      boxes.forEach((box) => { box.checked = all.checked; });
      reflect();
    });

    bulkForm.addEventListener('submit', (event) => {
      const n = selected().length;
      if (n === 0) { event.preventDefault(); return; }
      // Named rather than counted when it is one, because "delete 1 item" reads
      // like a rounding error and this removes files.
      const what = n === 1
        ? `“${selected()[0].closest('.ad-skin-card-wrap')?.querySelector('.ad-skin-title')?.textContent?.trim() ?? 'this item'}”`
        : `${n} items`;
      if (!window.confirm(`Delete ${what}? This removes their files too and can't be undone.`)) {
        event.preventDefault();
      }
    });

    reflect();
  }

  // ── Preview tabs (item page) ────────────────────────────────────────────
  //
  // `hidden` rather than a class, so a panel that is not showing is genuinely
  // out of the layout rather than merely invisible — a hidden-by-class panel
  // still takes part in tab order and is still read out by a screen reader.
  const viewTabs = Array.from(document.querySelectorAll('[data-view-tab]'));

  viewTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const wanted = tab.dataset.viewTab;
      viewTabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('[data-view-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.viewPanel !== wanted;
      });
      // Anything that sizes itself from its element only has a size once it is
      // visible. Nudging resize makes it re-measure on first reveal.
      window.dispatchEvent(new Event('resize'));
    });
  });
})();
