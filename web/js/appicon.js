/* The app's own icon, chosen in Me > Appearance. Only an installed app can
   change it: the Android and iPhone apps (the AppIcon plugin in
   ojee-health-app) and the desktop app (window.ojeeDesktop.appIcon). */

import { html, sheet, toast } from './ui.js';
import { ICONS } from './appicons-list.js';

const bridge = () => (window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.AppIcon : null) || window.ojeeDesktop?.appIcon || null;
const onDesktop = () => !!window.ojeeDesktop?.appIcon;
export const canChangeIcon = () => !!bridge();

/** The icons for this device. No-background ones lead on the desktop; a phone cannot use them. On the desktop the default has no background, so the off-black tile is an option of its own. */
function choices() {
  const plain = ICONS.filter((i) => !i.desktop);
  if (!onDesktop()) return plain;
  return [
    ...ICONS.filter((i) => i.desktop),
    ...plain.flatMap((i) => (i.id === 'default' ? [{ ...i, label: 'No background', src: 'clear' }, { id: 'offblack', label: 'Off-black', group: i.group, src: 'default' }] : [i])),
  ];
}

async function openPicker() {
  const b = bridge();
  if (!b) return;
  let now = 'default';
  try { now = (await b.current())?.id || 'default'; } catch { /* shows no tick */ }
  const list = choices();
  const groups = [...new Set(list.map((i) => i.group))];
  const s = sheet({
    title: 'App icon',
    body: html`<div class="st-sheet">${groups.map((g) => html`
      <p class="st-lab"><span>${g}</span></p>
      <div class="ai-grid">${list.filter((i) => i.group === g).map((i) => html`
        <button type="button" class="ai-b ${i.desktop || i.src === 'clear' ? 'ai-b--clear' : ''}" data-icon="${i.id}" aria-pressed="${i.id === now ? 'true' : 'false'}">
          <img src="/app-icons/${i.src || i.id}.png?v=3" alt="" width="72" height="72" loading="lazy"><span>${i.label}</span>
        </button>`)}</div>`)}</div>`,
  });
  s.el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-icon]');
    if (!btn || btn.getAttribute('aria-pressed') === 'true') return;
    const id = btn.dataset.icon;
    try {
      await b.choose({ id });
      for (const x of s.el.querySelectorAll('[data-icon]')) x.setAttribute('aria-pressed', x === btn ? 'true' : 'false');
      if (window.Capacitor?.getPlatform?.() === 'android') toast('Icon changed. Your home screen can take a few seconds to catch up.');
      else if (onDesktop()) toast('Icon changed.');
    } catch (err) { toast(err?.message || 'That icon could not be set.', { tone: 'bad' }); }
  });
}

document.addEventListener('click', (e) => { if (e.target.closest?.('[data-appicon]')) openPicker(); });
