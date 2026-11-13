/* Which version of the installed app this page runs in: the Android and iPhone
   apps (Capacitor's App plugin) and the desktop app (window.ojeeDesktop.version).
   Shown at the foot of the Me page, beside the site's own version. */

import { html } from './ui.js';

let asked = null;

/** { label, version } of the app around this page, or null in a browser. Asked once. */
export function appVersion() {
  if (asked) return asked;
  asked = (async () => {
    const d = window.ojeeDesktop;
    if (d?.app === 'health-desktop') return d.version ? { label: 'Desktop app', version: String(d.version) } : null;
    const cap = window.Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    const label = cap.getPlatform?.() === 'ios' ? 'iPhone app' : 'Android app';
    try {
      const i = await cap.Plugins?.App?.getInfo?.();
      if (!i?.version) return null;
      return { label, version: i.build && i.build !== i.version ? `${i.version} (${i.build})` : i.version };
    } catch { return null; }
  })();
  return asked;
}

/** A place for the app's version; filled in once it is known. Empty in a browser. */
export function appVersionSlot() {
  appVersion().then((v) => {
    if (!v) return;
    const fill = () => { for (const el of document.querySelectorAll('[data-appver]:empty')) el.textContent = ` · ${v.label} ${v.version}`; };
    // Now, and again after the page is drawn, in case it was mounted after the answer came.
    fill(); requestAnimationFrame(fill);
  });
  return html`<span data-appver></span>`;
}
