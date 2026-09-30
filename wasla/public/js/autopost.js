/*
 * «النشر التلقائي»: «اقترح» fills the rows with the suggested times and the
 * places each one posts to, and empties the rows left over.
 */
(function () {
  'use strict';

  const preset = document.querySelector('[data-slots-preset]');
  if (!preset) return;
  preset.addEventListener('click', () => {
    const slots = JSON.parse(preset.getAttribute('data-slots-preset'));
    document.querySelectorAll('[data-slot]').forEach((row, i) => {
      const slot = slots[i];
      row.querySelector('[data-slot-time]').value = slot ? slot.time : '';
      row.querySelectorAll('[data-slot-target]').forEach((box) => {
        box.checked = Boolean(slot && slot.targets.includes(box.value));
      });
    });
  });
})();
