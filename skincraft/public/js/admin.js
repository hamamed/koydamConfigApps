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

  // ── AI generation progress ──────────────────────────────────────────────
  //
  // Generation is a single request that can run for minutes. Left as a plain
  // form post, the only sign anything is happening is the browser's tab
  // spinner — so the page looks frozen, people submit again, and every retry
  // is another image billed to the key.
  //
  // Posting it in the background instead lets the wait say what it is doing,
  // and lets a failure land on this page with the provider's own words rather
  // than as a gateway error page with none.
  const aiForm = document.querySelector('form[data-ai-form]');

  if (aiForm) {
    const status = aiForm.querySelector('[data-ai-status]');
    const statusTitle = aiForm.querySelector('[data-ai-status-title]');
    const statusDetail = aiForm.querySelector('[data-ai-status-detail]');
    const errorBox = aiForm.querySelector('[data-ai-error]');
    const errorText = aiForm.querySelector('[data-ai-error-text]');
    const submit = aiForm.querySelector('[data-ai-submit]');

    // What the wait is actually spending time on. Each image is a separate
    // round trip to the provider, so "Detailed" is genuinely three times the
    // wait — saying so is what stops it reading as a hang.
    const images = { simple: 1, standard: 2, detailed: 3 };

    let ticker = null;
    // Set once the result is in and the browser is on its way to the draft.
    // Without it the `finally` below tears the busy state down mid-navigation:
    // the spinner vanishes and the button comes back live for the moment
    // before the page unloads, which is exactly long enough to submit again
    // and pay for a second generation.
    let navigating = false;

    const stopTicker = () => {
      if (ticker) window.clearInterval(ticker);
      ticker = null;
    };

    aiForm.addEventListener('submit', async (event) => {
      if (!aiForm.reportValidity()) return;
      event.preventDefault();

      const count = images[aiForm.querySelector('[name="quality"]')?.value] ?? 2;
      const started = Date.now();

      errorBox.hidden = true;
      status.hidden = false;
      status.classList.add('is-busy');
      statusTitle.textContent = count === 1 ? 'Generating 1 image…' : `Generating ${count} images…`;
      submit.setAttribute('disabled', 'disabled');
      iconsReady();

      const tick = () => {
        const seconds = Math.round((Date.now() - started) / 1000);
        statusDetail.textContent =
          `${seconds}s elapsed — drawing the artwork, then composing the template. ` +
          'Leaving this page cancels nothing, but you will not see the result.';
      };
      tick();
      ticker = window.setInterval(tick, 1000);

      try {
        const response = await fetch(aiForm.action, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'X-CSRF-Token': aiForm.querySelector('[name="_csrf"]').value,
          },
          body: new URLSearchParams(new FormData(aiForm)),
        });

        // Read the body before checking `ok`: the useful sentence — which
        // provider failed and why — is in the error payload, not the status.
        const payload = await response.json().catch(() => null);

        if (response.ok && payload?.data?.location) {
          navigating = true;
          statusTitle.textContent = 'Done — opening the draft';
          statusDetail.textContent = '';
          stopTicker();
          window.location.assign(payload.data.location);
          return;
        }

        throw new Error(
          payload?.message ||
            `The server returned ${response.status} and no explanation. ` +
            'Check the SkinCraft log for what happened.',
        );
      } catch (error) {
        // A dropped connection is the likeliest failure on a request this
        // long, and it means the generation may well have finished anyway.
        const message =
          error instanceof TypeError
            ? 'Lost the connection while generating. It may still have completed — check Drafts before trying again, so you are not billed twice.'
            : error.message;

        errorText.textContent = message;
        errorBox.hidden = false;
        iconsReady();
      } finally {
        stopTicker();
        if (!navigating) {
          status.hidden = true;
          status.classList.remove('is-busy');
          submit.removeAttribute('disabled');
        }
      }
    });
  }
})();
