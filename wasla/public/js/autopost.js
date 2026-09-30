/*
 * «النشر التلقائي»: «اقترح» fills the time pickers with the suggested times,
 * in order, and empties the rest.
 */
(function () {
  'use strict';

  const preset = document.querySelector('[data-times-preset]');
  if (!preset) return;
  preset.addEventListener('click', () => {
    const times = preset.getAttribute('data-times-preset').split(',');
    document.querySelectorAll('[data-time-slot]').forEach((input, i) => {
      input.value = times[i] || '';
    });
  });
})();
