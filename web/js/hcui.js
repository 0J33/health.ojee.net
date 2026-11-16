/* Connections, a watch whose app writes to Android's Health Connect:
   Samsung Health, Zepp (Amazfit), Mi Fitness (Xiaomi), Withings, Oura,
   Polar and the like; Huawei Health through a bridge (Health Sync). Read
   by the Android app (hc.js, server/hcsync.js). On an iPhone, the same
   screen is Apple Health, read by the iPhone app (an Apple Watch, or any
   watch whose app writes to Apple Health). Connect,
   what came, Sync now, and letting go. Outside the Android app it says
   where to do it. */

import { api } from './api.js';
import { app, refreshMe } from './app.js';
import { html, mount, on, busy, toast, toastError } from './ui.js';
import * as f from './format.js';
import { stGrp, stLab, stNote, stDot, stRow, stHead, stProse, stPick } from './apps.js';
import { hcAvailable, hcConnect, hcSync, hcDisconnect, hcSettings, hcAskAgain, onApple, hcRoutesAvailable, hcRoutesOn, hcRoutesSet } from './hc.js';
import { platform } from './pwa.js';

/* Each kind as Health Connect names it, its word here, and whether some came in the last 30 days. */
const KINDS = [
  ['sleep', 'Sleep', (c) => c.sleep], ['heartRate', 'Heart rate', (c) => c.heart], ['restingHeartRate', 'Resting heart rate', (c) => c.heart],
  ['heartRateVariability', 'HRV', (c) => c.hrv], ['oxygenSaturation', 'Blood oxygen', (c) => c.spo2], ['workouts', 'Workouts', (c) => c.workouts],
  ['totalCalories', 'Calories', () => 1], ['weight', 'Weight', (c) => c.weight], ['steps', 'Steps', (c) => c.steps],
];
/** Each brand's words: its app, where it shares with Health Connect, what its watch brings. */
const BRAND = {
  apple: { app: 'Apple Health', share: 'An Apple Watch saves to Apple Health by itself. Another watch: in its app, allow it to write to Apple Health.', what: 'Steps, sleep with its stages, heart rate, HRV, blood oxygen, workouts and weight from Apple Health' },
  samsung: { app: 'Samsung Health', share: 'In Samsung Health, open Settings, then Health Connect, and allow it to share your data.', what: 'A Galaxy Watch\'s steps, sleep with its stages, heart rate, HRV, blood oxygen, workouts and weight' },
  scale: { app: 'your scale\'s app', share: html`In your scale's app, find Health Connect in its settings (or its profile) and allow it to write your weight and body fat: <b>Renpho</b>, <b>Eufy</b> (EufyLife), <b>Wyze</b>, <b>Etekcity</b> (VeSync), <b>Omron</b> (Omron connect), <b>Withings</b>, <b>Zepp Life</b> and most others can.`, what: 'Your weigh-ins and body fat, from whichever scale app shares with Health Connect' },
  other: { app: 'your watch\'s app', share: html`<b>Zepp</b> (Amazfit): Profile, Settings, Health Connect, turn it on. <b>Mi Fitness</b> (Xiaomi): Profile, Settings, Health Connect. <b>Withings, Oura, Polar</b>: their settings, Health Connect. <b>Huawei Health</b> does not share with Health Connect itself: the <b>Health Sync</b> app copies it there.`, what: 'Steps, sleep, heart rate, workouts and weight from whichever watch app shares with Health Connect' },
};
/** What is not arriving, and the two places that decide it: Health Connect's permissions, and what the watch's app shares. */
function missingPart(h, b) {
  const p = h.perms; const c = h.counts || {};
  if (!p) return '';
  // Apple Health never tells an app what it may not read: only what has not come in is said there.
  const apple = b.app === 'Apple Health';
  const denied = apple ? [] : KINDS.filter(([k]) => (p.denied || []).includes(k)).map(([, t]) => t);
  const silent = KINDS.filter(([k, , n]) => (p.granted || []).includes(k) && !n(c)).map(([, t]) => t);
  if (!denied.length && !silent.length) return '';
  return html`${stLab('Not arriving')}
    ${stGrp(html`
      ${denied.length ? stRow({ icon: 'lock', title: 'Not allowed in Health Connect', sub: denied.join(', '), top: true }) : ''}
      ${silent.length ? stRow({ icon: 'info', title: apple ? 'Nothing came in 30 days' : 'Allowed, but nothing came in 30 days', sub: `${silent.join(', ')}. ${apple ? 'In the Health app, open Sharing, Apps, rep., and turn on what is missing. If it is on, nothing has written that kind to Apple Health.' : b.app === 'Samsung Health' ? 'Samsung Health may not be sharing these: in Samsung Health, open Settings, Health Connect, and allow everything for Samsung Health.' : 'Your watch\'s app may not be sharing these with Health Connect: check its Health Connect settings.'}`, top: true }) : ''}
      ${denied.length ? stRow({ btn: true, attrs: 'data-hc-ask', icon: 'key', title: 'Allow the missing ones' }) : ''}
      ${stRow({ btn: true, attrs: 'data-hc-hcs', icon: 'settings', title: apple ? 'Open the Health app' : 'Open Health Connect' })}`)}`;
}

export function hcModule(root, { brand = 'samsung' } = {}) {
  // On an iPhone it is Apple Health, whichever watch: its data reaches the phone's store the same way.
  const ios = platform.ios;
  const b = ios ? (brand === 'scale' ? { ...BRAND.apple, share: 'In your scale\'s app, allow it to write your weight and body fat to Apple Health (most scale apps can: Renpho, Eufy, Wyze, Etekcity, Omron, Withings, Zepp Life).', what: 'Your weigh-ins and body fat from Apple Health' } : BRAND.apple) : BRAND[brand] || BRAND.samsung;
  const name = ios ? 'Apple Health' : brand === 'samsung' ? 'Samsung Health' : 'Health Connect';
  const store = ios ? 'Apple Health' : 'Health Connect';
  let hc = null; let av = null; let routes = false;
  /** Routes recorded in rep., also saved to Health Connect (the Android app, Android 14 or later). */
  const routesPart = () => (routes ? html`${stLab('Your routes')}
    ${stGrp(stRow({ btn: true, attrs: 'data-hc-routes', icon: 'route', title: 'Save routes recorded in rep. to Health Connect', sub: 'Each run, walk or ride recorded here, with its map, for other apps that read Health Connect.', value: hcRoutesOn() ? 'On' : 'Off' }))}` : '');
  const paint = () => {
    const h = hc || {};
    const status = h.connected ? stDot('ok', 'Connected') : h.kept ? stDot('off', 'Let go of, kept') : stDot('off', 'Not connected');
    const r = h.lastResult;
    const both = app.me.sources?.google;
    mount(root, html`<div class="st-page">
      ${stHead({ icon: 'watch', fam: 'active', title: name, status, sub: h.device && h.connected ? h.device : '' })}
      ${!h.connected ? html`
        <p class="st-lead">${b.what}, read from ${store} on your ${ios ? 'iPhone' : 'Android phone'}. No Google needed.</p>
        ${av?.ok ? html`
          ${stProse(ios ? html`<ol><li>${b.share}</li><li>Tap Connect below and turn on every kind in the sheet that opens.</li></ol>` : html`<ol><li>${b.share}</li><li>Tap Connect below and allow reading in the Health Connect sheet that opens. Allow past data too, for your history.</li></ol>`)}
          <div class="btnrow" style="margin-top:14px"><button type="button" class="btn" data-hc-connect>Connect ${name}</button></div>`
        : av?.why === 'app' ? stProse(ios ? html`<p>This connects on your iPhone, inside the rep. app: Apple Health keeps your watch's data on the phone, where only an app can read it.</p><p>Install the rep. app from the App Store, sign in, and come back to this page there.</p>` : html`<p>This connects on your Android phone, inside the rep. app: ${b.app} keeps your watch's data on the phone, in Health Connect, where only an app can read it.</p><p>Install the rep. app on your phone, sign in, and come back to this page there.</p>`)
          : av?.why === 'update' ? stProse(html`<p>Update the rep. app on this phone: this version cannot read ${store} yet.</p>`)
            : stProse(html`<p>Health Connect is not on this phone. On Android 13 and older, install <b>Health Connect</b> from the Play Store, then come back.</p>`)}
        ${routesPart()}` : html`
        ${stLab('Status', '', 'Read while the rep. app is open on this phone')}
        ${stGrp(html`
          ${stRow({ icon: 'refresh', title: 'Last read', value: h.lastUpload ? f.ago(h.lastUpload) : 'Not yet' })}
          ${r ? stRow({ icon: 'data', title: 'Last time it brought', sub: [f.plural(r.days || 0, 'day'), f.plural(r.nights || 0, 'night'), f.plural(r.workouts || 0, 'workout'), r.weighIns ? f.plural(r.weighIns, 'weigh-in') : ''].filter(Boolean).join(', ') }) : ''}`)}
        ${missingPart(h, b)}
        ${routesPart()}
        ${both ? html`${stLab('Settings')}${stGrp(stRow({ btn: true, attrs: 'data-hc-prefer', icon: 'balance', title: 'When Google has a number too', value: h.settings?.prefer === 'google' ? 'Google first' : `${name} first` }))}` : ''}
        ${stGrp(html`
          ${av?.ok ? stRow({ btn: true, attrs: 'data-hc-sync', icon: 'refresh', title: 'Sync now', chev: false }) : ''}
          ${stRow({ btn: true, attrs: 'data-hc-off', icon: 'unlink', title: `Disconnect ${name}`, danger: true, chev: false })}`, 'style="margin-top:16px"')}
        ${!av?.ok ? stNote(`Open the rep. app on your ${ios || h.platform === 'ios' ? 'iPhone' : 'Android phone'} to bring in what is new.`) : ''}`}
    </div>`);
  };
  const load = async () => {
    [hc, av, routes] = await Promise.all([api.get('/api/hc').catch(() => hc), hcAvailable(), hcRoutesAvailable()]);
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
  on(root, 'click', '[data-hc-routes]', async (e, b) => {
    try { const on1 = await busy(b, () => hcRoutesSet(!hcRoutesOn())); toast(on1 ? 'Routes recorded here now go to Health Connect too' : 'Routes stay in rep. only'); } catch (err) { toastError(err); }
    paint();
  });
  on(root, 'click', '[data-hc-off]', async () => {
    // Closing the sheet changes nothing: what it brought goes only when that is picked.
    const v = await stPick({ title: `Disconnect ${name}`, lead: 'Nothing new arrives from it.', options: [['keep', 'Keep what it brought', 'Its days, nights and workouts stay.'], ['remove', 'Remove what it brought', 'What only it brought goes.']], current: '' });
    if (!v) return;
    try { hc = await hcDisconnect({ keepData: v === 'keep' }); await refreshMe().catch(() => {}); paint(); toast(`${name} disconnected`); } catch (err) { toastError(err); }
  });
  load();
}
