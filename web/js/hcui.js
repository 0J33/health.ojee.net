/* Connections, a watch whose app writes to Android's Health Connect:
   Samsung Health, Zepp (Amazfit), Mi Fitness (Xiaomi), Withings, Oura,
   Polar and the like; Huawei Health through a bridge (Health Sync). Read
   by the Android app (hc.js, server/hcsync.js). Connect,
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
/** Each brand's words: its app, where it shares with Health Connect, what its watch brings. */
const BRAND = {
  samsung: { app: 'Samsung Health', share: 'In Samsung Health, open Settings, then Health Connect, and allow it to share your data.', what: 'A Galaxy Watch\'s steps, sleep with its stages, heart rate, HRV, blood oxygen, workouts and weight' },
  other: { app: 'your watch\'s app', share: html`<b>Zepp</b> (Amazfit): Profile, Settings, Health Connect, turn it on. <b>Mi Fitness</b> (Xiaomi): Profile, Settings, Health Connect. <b>Withings, Oura, Polar</b>: their settings, Health Connect. <b>Huawei Health</b> does not share with Health Connect itself: the <b>Health Sync</b> app copies it there.`, what: 'Steps, sleep, heart rate, workouts and weight from whichever watch app shares with Health Connect' },
};
/** What is not arriving, and the two places that decide it: Health Connect's permissions, and what the watch's app shares. */
function missingPart(h, b) {
  const p = h.perms; const c = h.counts || {};
  if (!p) return '';
  const denied = KINDS.filter(([k]) => (p.denied || []).includes(k)).map(([, t]) => t);
  const silent = KINDS.filter(([k, , n]) => (p.granted || []).includes(k) && !n(c)).map(([, t]) => t);
  if (!denied.length && !silent.length) return '';
  return html`${stLab('Not arriving')}
    ${stGrp(html`
      ${denied.length ? stRow({ icon: 'lock', title: 'Not allowed in Health Connect', sub: denied.join(', '), top: true }) : ''}
      ${silent.length ? stRow({ icon: 'info', title: 'Allowed, but nothing came in 30 days', sub: `${silent.join(', ')}. ${b.app === 'Samsung Health' ? 'Samsung Health may not be sharing these: in Samsung Health, open Settings, Health Connect, and allow everything for Samsung Health.' : 'Your watch\'s app may not be sharing these with Health Connect: check its Health Connect settings.'}`, top: true }) : ''}
      ${denied.length ? stRow({ btn: true, attrs: 'data-hc-ask', icon: 'key', title: 'Allow the missing ones' }) : ''}
      ${stRow({ btn: true, attrs: 'data-hc-hcs', icon: 'settings', title: 'Open Health Connect' })}`)}`;
}

export function hcModule(root, { brand = 'samsung' } = {}) {
  const b = BRAND[brand] || BRAND.samsung;
  const name = brand === 'samsung' ? 'Samsung Health' : 'Health Connect';
  let hc = null; let av = null;
  const paint = () => {
    const h = hc || {};
    const status = h.connected ? stDot('ok', 'Connected') : h.kept ? stDot('off', 'Let go of, kept') : stDot('off', 'Not connected');
    const r = h.lastResult;
    const both = app.me.sources?.google;
    mount(root, html`<div class="st-page">
      ${stHead({ icon: 'watch', fam: 'active', title: name, status, sub: h.device && h.connected ? h.device : '' })}
      ${!h.connected ? html`
        <p class="st-lead">${b.what}, read from Health Connect on your Android phone. No Google needed.</p>
        ${av?.ok ? html`
          ${stProse(html`<ol><li>${b.share}</li><li>Tap Connect below and allow reading in the Health Connect sheet that opens. Allow past data too, for your history.</li></ol>`)}
          <div class="btnrow" style="margin-top:14px"><button type="button" class="btn" data-hc-connect>Connect ${name}</button></div>`
        : av?.why === 'app' ? stProse(html`<p>This connects on your Android phone, inside the Health app: ${b.app} keeps your watch's data on the phone, in Health Connect, where only an app can read it.</p><p>Install the Health app on your phone, sign in, and come back to this page there.</p>`)
          : av?.why === 'update' ? stProse(html`<p>Update the Health app on this phone: this version cannot read Health Connect yet.</p>`)
            : stProse(html`<p>Health Connect is not on this phone. On Android 13 and older, install <b>Health Connect</b> from the Play Store, then come back.</p>`)}` : html`
        ${stLab('Status')}
        ${stGrp(html`
          ${stRow({ icon: 'refresh', title: 'Last read', value: h.lastUpload ? f.ago(h.lastUpload) : 'Not yet', sub: 'Read while the Health app is open on this phone' })}
          ${r ? stRow({ icon: 'data', title: 'Last time it brought', sub: [f.plural(r.days || 0, 'day'), f.plural(r.nights || 0, 'night'), f.plural(r.workouts || 0, 'workout'), r.weighIns ? f.plural(r.weighIns, 'weigh-in') : ''].filter(Boolean).join(', ') }) : ''}`)}
        ${missingPart(h, b)}
        ${both ? html`${stLab('Settings')}${stGrp(stRow({ btn: true, attrs: 'data-hc-prefer', icon: 'balance', title: 'When Google has a number too', value: h.settings?.prefer === 'google' ? 'Google first' : `${name} first` }))}` : ''}
        ${stGrp(html`
          ${av?.ok ? stRow({ btn: true, attrs: 'data-hc-sync', icon: 'refresh', title: 'Sync now', chev: false }) : ''}
          ${stRow({ btn: true, attrs: 'data-hc-off', icon: 'unlink', title: `Disconnect ${name}`, danger: true, chev: false })}`, 'style="margin-top:16px"')}
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
    const v = await stPick({ title: 'When Google has a number too', options: [['hc', `${name} first`, `Google fills what ${name} does not have.`], ['google', 'Google first', `${name} fills what Google does not have.`]], current: hc.settings?.prefer === 'google' ? 'google' : 'hc' });
    if (!v) return;
    try { hc = await api.patch('/api/hc/settings', { prefer: v }); paint(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-hc-off]', async () => {
    // Closing the sheet changes nothing: what it brought goes only when that is picked.
    const v = await stPick({ title: `Disconnect ${name}`, lead: 'Nothing new arrives from it.', options: [['keep', 'Keep what it brought', 'Its days, nights and workouts stay.'], ['remove', 'Remove what it brought', 'What only it brought goes.']], current: '' });
    if (!v) return;
    try { hc = await hcDisconnect({ keepData: v === 'keep' }); await refreshMe().catch(() => {}); paint(); toast(`${name} disconnected`); } catch (err) { toastError(err); }
  });
  load();
}
