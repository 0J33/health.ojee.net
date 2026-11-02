/* The design system gallery (web/design-system.html): light, dark or the device's theme. */
const root = document.documentElement;
const pick = (v) => {
  if (v === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', v);
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-pressed', String(b.dataset.themePick === v));
};
document.addEventListener('click', (e) => { const b = e.target.closest('[data-theme-pick]'); if (b) pick(b.dataset.themePick); });
pick('auto');
