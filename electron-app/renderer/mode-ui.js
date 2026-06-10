(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JmlModeUi = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function syncModeUi(doc, whatif) {
    doc.querySelectorAll('.mode-btn').forEach(button => {
      button.classList.toggle('active', (button.dataset.mode === 'whatif') === whatif);
    });
    doc.querySelectorAll('.hard-mode-btn').forEach(button => {
      const active = (button.dataset.hard === 'whatif') === whatif;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    doc.getElementById('mode-banner-whatif')?.classList.toggle('hidden', !whatif);
    doc.getElementById('mode-banner-live')?.classList.toggle('hidden', whatif);
  }

  return { syncModeUi };
});
