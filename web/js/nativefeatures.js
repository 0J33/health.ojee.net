/* What the installed apps do around the site: the widgets' key and the iPhone's widget set-up.
   Android hands its key straight to the app (the RepWidgets plugin). An iPhone widget lives in
   its own sandbox, so the code is pasted into it once. */

import { api } from './api.js';
import { html, sheet, toast } from './ui.js';
import { platform } from './pwa.js';

const plugin = () => (platform.native ? window.Capacitor?.Plugins?.RepWidgets : null) || null;
export const iosWidgetsOffered = () => platform.native && platform.ios;

let fed = false;
/** Once per open, signed in: Android's widgets get a key if they have none, then a fresh look. */
export async function keepWidgetsFed() {
  if (fed) return;
  const w = plugin();
  if (!w) return;
  fed = true;
  try {
    if (!(await w.hasKey())?.has) await w.setKey({ key: (await api.post('/api/keys/widget', { device: 'android' })).key });
    await w.refresh();
  } catch { fed = false; }
}

async function setupSheet() {
  const s = sheet({
    title: 'Widgets',
    body: html`<div class="st-sheet"><p class="st-lead">Add a rep. widget to your Home Screen or Lock Screen, then press and hold it, choose Edit Widget and paste this code. You only paste it into one widget; the others pick it up.</p>
      <button type="button" class="btn btn--block" data-copy-code>Copy widget code</button></div>`,
  });
  s.el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-copy-code]')) return;
    try {
      const { key } = await api.post('/api/keys/widget', { device: 'ios' });
      await navigator.clipboard.writeText(key);
      toast('Copied. It only lets a widget read today\'s numbers.');
    } catch (err) { toast(err?.message || 'The code could not be made.', { tone: 'bad' }); }
  });
}

document.addEventListener('click', (e) => { if (e.target.closest?.('[data-widget-code]')) setupSheet(); });
