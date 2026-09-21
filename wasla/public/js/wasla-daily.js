/*
 * The daily puzzle editor: a live preview of the board.
 *
 * Progressive enhancement. Without JavaScript the Preview and Shuffle buttons
 * post the form and the page comes back redrawn; with it, every change asks
 * the server for the same preview (POST …/preview) and swaps it in, so what is
 * shown is always what Save stores.
 */
(function () {
  'use strict';

  const form = document.getElementById('dailyEditor');
  if (!form) return;
  const preview = document.getElementById('dailyPreview');
  const saveButton = form.querySelector('[data-save]');
  const seedInput = form.querySelector('input[name="seed"]');
  const TYPING_DELAY_MS = 450;
  const MAX_SEED = 2147483646;

  // The server redraws on every change, so the explicit Preview button is only for no-JS.
  form.querySelector('[data-preview]')?.classList.add('d-none');

  /** Shows the chosen source's panel, and only the chosen theme's words (disabled ones are not posted). */
  function syncPanels() {
    const source = form.querySelector('input[name="source"]:checked')?.value ?? 'theme';
    form.querySelectorAll('[data-source-panel]').forEach((panel) => {
      panel.classList.toggle('d-none', panel.dataset.sourcePanel !== source);
    });
    const theme = form.querySelector('select[name="themeTitle"]')?.value ?? '';
    form.querySelectorAll('[data-theme-group]').forEach((group) => {
      const on = group.dataset.themeGroup === theme;
      group.classList.toggle('d-none', !on);
      group.querySelectorAll('input[type="checkbox"]').forEach((box) => { box.disabled = !on; });
    });
  }

  let timer = null;
  let controller = null;

  async function refresh() {
    controller?.abort();
    controller = new AbortController();
    const body = new URLSearchParams(new FormData(form));
    body.set('action', 'preview');
    preview.classList.add('ws-loading');
    try {
      const res = await fetch(form.dataset.previewUrl, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Preview failed (${res.status}).`);
      preview.innerHTML = data.html;
      saveButton.disabled = !data.canSave;
      window.lucide?.createIcons();
    } catch (err) {
      if (err.name === 'AbortError') return;
      saveButton.disabled = true;
      preview.innerHTML = '';
      const alert = document.createElement('div');
      alert.className = 'alert alert-danger small';
      alert.textContent = `${err.message} أعد تحميل الصفحة وحاول مرة أخرى.`;
      preview.append(alert);
    } finally {
      preview.classList.remove('ws-loading');
    }
  }

  const schedule = (delay) => {
    clearTimeout(timer);
    // A change not yet previewed must not be saved.
    saveButton.disabled = true;
    timer = setTimeout(refresh, delay);
  };

  form.addEventListener('change', (event) => {
    if (event.target.matches('textarea, input[type="text"]')) return;
    syncPanels();
    schedule(0);
  });
  form.addEventListener('input', (event) => {
    if (event.target.matches('textarea, input[type="text"]')) schedule(TYPING_DELAY_MS);
  });
  // Enter in the theme name would post the whole page; the preview is already live.
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input[type="text"]')) event.preventDefault();
  });

  form.querySelector('[data-shuffle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    seedInput.value = String(1 + Math.floor(Math.random() * MAX_SEED));
    schedule(0);
  });

  syncPanels();
})();
