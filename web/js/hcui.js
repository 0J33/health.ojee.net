/* Connections, Samsung Galaxy Watch: Samsung Health through Health
   Connect, read by the Android app (hc.js, server/hcsync.js). Connect,
   what came, Sync now, and letting go. Outside the Android app it says
   where to do it. */

import { api } from './api.js';
import { app, refreshMe } from './app.js';
import { html, mount, on, busy, toast, toastError } from './ui.js';
import * as f from './format.js';
import { stGrp, stLab, stNote, stDot, stRow, stHead, stProse, stPick } from './apps.js';
import { hcAvailable, hcConnect, hcSync, hcDisconnect, hcSettings, hcAskAgain } from './hc.js';

/* Each kind as Health Connect names it, its word here, and whether some came in the last 30 days. */
const KINDS = [
  ['sleep', 'Sleep', (c) => c.sleep], ['heartRate', 'Heart rate', (c) => c.heart], ['restingHeartRate', 'Resting heart rate', (c) => c.heart],
  ['heartRateVariability', 'HRV', (c) => c.hrv], ['oxygenSaturation', 'Blood oxygen', (c) => c.spo2], ['workouts', 'Workouts', (c) => c.workouts],
  ['totalCalories', 'Calories', () => 1], ['weight', 'Weight', (c) => c.weight], ['steps', 'Steps', (c) => c.steps],
];
/** What is not arriving, and the two places that decide it: Health Connect's permissions, and what Samsung Health shares. */
function missingPart(h) {
  const p = h.perms; const c = h.counts || {};
  if (!p) return '';
  const denied = KINDS.filter(([k]) => (p.denied || []).includes(k)).map(([, t]) => t);
  const silent = KINDS.filter(([k, , n]) => (p.granted || []).includes(k) && !n(c)).map(([, t]) => t);
  if (!denied.length && !silent.length) return '';
  return html`${stLab('Not arriving')}
    ${stGrp(html`
      ${denied.length ? stRow({ icon: 'lock', title: 'Not allowed in Health Connect', sub: denied.join(', '), top: true }) : ''}
      ${silent.length ? stRow({ icon: 'info', title: 'Allowed, but nothing came in 30 days', sub: `${silent.join(', ')}. Samsung Health may not be sharing these: in Samsung Health, open Settings, Health Connect, and allow everything for Samsung Health.`, top: true }) : ''}
      ${denied.length ? stRow({ btn: true, attrs: 'data-hc-ask', icon: 'key', title: 'Allow the missing ones' }) : ''}
      ${stRow({ btn: true, attrs: 'data-hc-hcs', icon: 'settings', title: 'Open Health Connect' })}`)}`;
}

export function hcModule(root) {
  let hc = null; let av = null;
  const paint = () => {
    const h = hc || {};
    const status = h.connected ? stDot('ok', 'Connected') : h.kept ? stDot('off', 'Let go of, kept') : stDot('off', 'Not connected');
    const r = h.lastResult;
    const both = app.me.sources?.google;
    mount(root, html`<div class="st-page">
      ${stHead({ icon: 'watch', fam: 'active', title: 'Samsung Health', status, sub: h.device && h.connected ? h.device : '' })}
      ${!h.connected ? html`
        <p class="st-lead">A Galaxy Watch's steps, sleep with its stages, heart rate, HRV, blood oxygen, workouts and weight, read from Samsung Health on your phone. No Google needed.</p>
        ${av?.ok ? html`
          ${stProse(html`<ol><li>In Samsung Health, open Settings, then Health Connect, and allow it to share your data.</li><li>Tap Connect below and allow reading in the Health Connect sheet that opens. Allow past data too, for your history.</li></ol>`)}
          <div class="btnrow" style="margin-top:14px"><button type="button" class="btn" data-hc-connect>Connect Samsung Health</button></div>`
        : av?.why === 'app' ? stProse(html`<p>This connects on your Android phone, inside the Health app: Samsung Health keeps a Galaxy Watch's data on the phone, where only the app can read it.</p><p>Install the Health app on your phone, sign in, and come back to this page there.</p>`)
          : av?.why === 'update' ? stProse(html`<p>Update the Health app on this phone: this version cannot read Health Connect yet.</p>`)
            : stProse(html`<p>Health Connect is not on this phone. On Android 13 and older, install <b>Health Connect</b> from the Play Store, then come back.</p>`)}` : html`
        ${stLab('Status')}
        ${stGrp(html`
          ${stRow({ icon: 'refresh', title: 'Last read', value: h.lastUpload ? f.ago(h.lastUpload) : 'Not yet', sub: 'Read while the Health app is open on this phone' })}
          ${r ? stRow({ icon: 'data', title: 'Last time it brought', sub: [f.plural(r.days || 0, 'day'), f.plural(r.nights || 0, 'night'), f.plural(r.workouts || 0, 'workout'), r.weighIns ? f.plural(r.weighIns, 'weigh-in') : ''].filter(Boolean).join(', ') }) : ''}`)}
        ${missingPart(h)}
        ${both ? html`${stLab('Settings')}${stGrp(stRow({ btn: true, attrs: 'data-hc-prefer', icon: 'balance', title: 'When Google has a number too', value: h.settings?.prefer === 'google' ? 'Google first' : 'Samsung first' }))}` : ''}
        ${stGrp(html`
          ${av?.ok ? stRow({ btn: true, attrs: 'data-hc-sync', icon: 'refresh', title: 'Sync now', chev: false }) : ''}
          ${stRow({ btn: true, attrs: 'data-hc-off', icon: 'unlink', title: 'Disconnect Samsung Health', danger: true, chev: false })}`, 'style="margin-top:16px"')}
        ${!av?.ok ? stNote('Open the Health app on your Android phone to bring in what is new.') : ''}`}
    </div>`);
  };
  const load = async () => {
    [hc, av] = await Promise.all([api.get('/api/hc').catch(() => hc), hcAvailable()]);
    paint();
  };
  on(root, 'click', '[data-hc-connect]', async (e, b) => {
    try {
      await busy(b, async () => {
        await hcConnect();
        await refreshMe();
        toast('Connected. Your history is coming in.');
        await hcSync({ force: true });
      });
      await refreshMe().catch(() => {});
      await load();
    } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-hc-ask]', async (e, b) => { try { await busy(b, () => hcAskAgain()); await busy(b, () => hcSync({ force: true })); await load(); } catch (err) { toastError(err); } });
  on(root, 'click', '[data-hc-hcs]', () => { hcSettings().catch((err) => toastError(err)); });
  on(root, 'click', '[data-hc-sync]', async (e, b) => {
    try { const r = await busy(b, () => hcSync({ force: true })); toast(r ? 'Up to date' : 'Nothing new'); await load(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-hc-prefer]', async () => {
    const v = await stPick({ title: 'When Google has a number too', options: [['hc', 'Samsung first', 'Google fills what Samsung does not have.'], ['google', 'Google first', 'Samsung fills what Google does not have.']], current: hc.settings?.prefer === 'google' ? 'google' : 'hc' });
    if (!v) return;
    try { hc = await api.patch('/api/hc/settings', { prefer: v }); paint(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-hc-off]', async () => {
    // Closing the sheet changes nothing: what it brought goes only when that is picked.
    const v = await stPick({ title: 'Disconnect Samsung Health', lead: 'Nothing new arrives from it.', options: [['keep', 'Keep what it brought', 'Its days, nights and workouts stay.'], ['remove', 'Remove what it brought', 'What only it brought goes.']], current: '' });
    if (!v) return;
    try { hc = await hcDisconnect({ keepData: v === 'keep' }); await refreshMe().catch(() => {}); paint(); toast('Samsung Health disconnected'); } catch (err) { toastError(err); }
  });
  load();
}
