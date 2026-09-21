/*
 * Notifications compose form: character counts, and the live number of
 * devices each target reaches. The form works without it.
 */
(function () {
  'use strict';

  const form = document.querySelector('[data-compose]');
  if (!form) return;

  // Counted by code point, as the server counts: an emoji is one character.
  form.querySelectorAll('[data-max]').forEach((field) => {
    const out = form.querySelector(`[data-count-for="${field.name}"]`);
    const max = Number(field.dataset.max);
    const paint = () => {
      const n = [...field.value].length;
      out.textContent = `${n}/${max}`;
      out.classList.toggle('text-danger', n > max);
    };
    field.addEventListener('input', paint);
    paint();
  });

  const deviceInput = form.querySelector('[data-device-input]');
  let timer = null;

  async function refresh(target) {
    const badge = form.querySelector(`[data-audience="${target}"]`);
    if (!badge) return;
    const params = new URLSearchParams({ target });
    if (target === 'device') {
      const id = deviceInput.value.trim();
      if (!id) { badge.textContent = '—'; return; }
      params.set('device', id);
    }
    try {
      const res = await fetch(`/admin/notifications/audience?${params}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const { count } = await res.json();
      badge.textContent = target === 'device' ? (count ? 'مسجَّل' : 'غير موجود') : String(count);
    } catch {
      badge.textContent = '?';
    }
  }

  const refreshAll = () => ['all', 'sandbox', 'device'].forEach(refresh);

  deviceInput.addEventListener('input', () => {
    form.querySelector('input[name="target"][value="device"]').checked = true;
    clearTimeout(timer);
    timer = setTimeout(() => refresh('device'), 300);
  });
  form.querySelectorAll('input[name="target"]').forEach((radio) => radio.addEventListener('change', refreshAll));
  refreshAll();
  // Registrations keep arriving while the page is open.
  setInterval(refreshAll, 30_000);
})();
