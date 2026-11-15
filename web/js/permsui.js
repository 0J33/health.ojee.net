/* Me → Permissions: everything rep. may use, in one place. What this phone or
   browser lets it use (notifications, location, camera, Bluetooth, Health
   Connect / Apple Health), each with its state now and a way to allow it, or
   where to change it when it was refused; then what the account has let rep.
   reach (Google Health's groups, linked apps, AI, API keys, who sees what),
   each a row into the page that changes it. Nothing is asked for on opening
   the page: only when a button says so. */

import { app } from './app.js';
import { html, mount, on, toast, busy } from './ui.js';
import { push, platform } from './pwa.js';
import { groupsOf } from './groups.js';
import { stGrp, stLab, stNote, stDot, stRow } from './apps.js';
import * as f from './format.js';

const cap = () => window.Capacitor || null;
const plugin = (name) => (cap()?.isPluginAvailable?.(name) ? cap().Plugins[name] : null);

/** What the browser says of one permission: 'granted' | 'prompt' | 'denied' | null (it will not say). */
async function query(name) {
  try { return (await navigator.permissions.query({ name })).state; } catch { return null; }
}

/** Where a refused permission is turned back on, in words for this device. */
function whereToChange() {
  if (platform.native && platform.android) return 'Allow it in Android\'s Settings, Apps, rep., Permissions.';
  if (platform.native && platform.ios) return 'Allow it in the iPhone\'s Settings, rep.';
  if (platform.desktop) return 'Allow it in your computer\'s privacy settings.';
  if (platform.ios) return 'Allow it in Settings, Safari, then the setting for this site (or aA in the address bar, Website Settings).';
  return 'Allow it in the browser: the icon left of the address, then Site settings.';
}

const STATE = {
  granted: ['ok', 'Allowed'],
  prompt: ['off', 'Not asked yet'],
  default: ['off', 'Not asked yet'],
  denied: ['bad', 'Blocked'],
  unsupported: ['off', 'Not on this device'],
  each: ['off', 'Asked for each one'],
  install: ['warn', 'Install the app first'],
  unknown: ['off', 'Asked when needed'],
};
const dot = (k) => stDot(...(STATE[k] || STATE.unknown));

/** Every device permission, read now (asks nothing). */
async function readDevice() {
  // Notifications: the same reading the Notifications page uses.
  let note = push.support();
  try { if (push.app) note = await push.refresh(); } catch { /* keep */ }
  const notify = note === 'granted' ? 'granted' : note === 'denied' ? 'denied' : note === 'needs-install' ? 'install'
    : note === 'unsupported' || note === 'native' ? 'unsupported' : note === 'desktop' ? 'granted' : 'prompt';

  const geoHas = 'geolocation' in navigator || !!plugin('BackgroundGeolocation');
  const location = !geoHas ? 'unsupported' : (await query('geolocation')) || 'unknown';

  const camHas = !!navigator.mediaDevices?.getUserMedia;
  const camera = !camHas ? 'unsupported' : (await query('camera')) || 'unknown';

  // Bluetooth: the browser asks for each sensor when it is paired; the apps ask once.
  const bleNative = plugin('BluetoothLe');
  let bluetooth = 'unsupported';
  if (bleNative) bluetooth = 'unknown';
  else if (platform.desktop || navigator.bluetooth) bluetooth = 'each';

  // Health Connect (Android app) or Apple Health (iPhone app).
  const hc = platform.native ? (app.me.hc?.connected ? 'granted' : 'prompt') : null;
  return { notify, location, camera, bluetooth, hc, bleNative };
}

/** Ask for one: the browser's own question. Resolves the new state. */
const ask = {
  location: () => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve(e.code === 1 ? 'denied' : 'granted'), { maximumAge: 600_000, timeout: 20_000 });
  }),
  camera: async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      return 'granted';
    } catch (e) { return e?.name === 'NotAllowedError' ? 'denied' : 'unsupported'; }
  },
};

/** The phone's own settings for the app, where the app can open them. */
async function openAppSettings() {
  const ble = plugin('BluetoothLe');
  const bg = plugin('BackgroundGeolocation');
  try {
    if (ble?.openAppSettings) { await ble.openAppSettings(); return true; }
    if (bg?.openSettings) { await bg.openSettings(); return true; }
  } catch { /* fall through */ }
  return false;
}

export async function permissionsPage(pane, ctx) {
  let d = await readDevice();
  const me = app.me;
  const canOpen = platform.native && !!(plugin('BluetoothLe')?.openAppSettings || plugin('BackgroundGeolocation')?.openSettings);

  /** A device row: what it is for, its state, and its one action. */
  const devRow = ({ key, icon, title, use, state, action = '', href = '' }) => {
    const blocked = state === 'denied';
    const sub = blocked ? html`${use} ${whereToChange()}` : use;
    // Its state beside its name, so the words under it keep the row's width on a phone.
    const t = html`<span class="perm-t">${title}${dot(state)}</span>`;
    if (href) return stRow({ href, icon, fam: 'recovery', title: t, sub });
    if (action) return stRow({ btn: true, attrs: `data-perm="${key}"`, icon, fam: 'recovery', title: t, sub, chev: false, end: html`<span class="btn btn--sm btn--tonal perm-act">${action}</span>` });
    return stRow({ icon, fam: 'recovery', title: t, sub });
  };

  function paint() {
    const groups = groupsOf();
    const gOn = groups.filter((g) => g.mode && g.mode !== 'off').length;
    const g = me.google?.state;
    const linked = [me.strava?.connected && 'Strava', me.hevy?.connected && 'Hevy', me.garmin?.connected && 'Garmin', me.xiaomi?.connected && 'Xiaomi'].filter(Boolean);
    const ai = me.consent?.ai;
    const aiKinds = Object.keys(me.consent?.aiKinds || {}).length;
    const keys = me.apiKeys ?? null;
    const pv = me.privacy || {};
    const askable = (k) => (d[k] === 'prompt' || d[k] === 'unknown') && ask[k];

    mount(pane, html`<div class="st-page perms">
      <p class="st-lead">What rep. may use, and what you have let it reach. Each is asked for only when something needs it, and you can take any of it back.</p>

      ${stLab(platform.native ? 'This phone' : platform.desktop ? 'This computer' : 'This browser')}
      ${stGrp(html`
        ${devRow({ key: 'notify', icon: 'bell', title: 'Notifications', use: 'Cheers, comments, requests and the reminders you choose.', state: d.notify, href: '/settings/notifications' })}
        ${devRow({ key: 'location', icon: 'locate', title: 'Location', use: platform.native ? 'Recording a route, also with the screen off, and the weather where you are.' : 'Recording a route, and the weather where you are.', state: d.location, action: askable('location') ? 'Allow' : '' })}
        ${d.camera !== 'unsupported' ? devRow({ key: 'camera', icon: 'barcode', title: 'Camera', use: 'Scanning a food\'s barcode. Photos come from the picker, which needs nothing.', state: d.camera, action: askable('camera') ? 'Allow' : '' }) : ''}
        ${devRow({ key: 'bluetooth', icon: 'sensor', title: 'Bluetooth', use: d.bluetooth === 'unsupported' ? 'Heart-rate straps and sensors. Not in this browser: use Chrome or Edge, or the rep. app.' : d.bluetooth === 'each' ? 'Heart-rate straps and sensors: you pick each one as you pair it.' : 'Heart-rate straps and sensors, paired in Devices.', state: d.bluetooth, href: d.bluetooth === 'unsupported' ? '' : '/settings/connections/devices/hr' })}
        ${d.hc ? devRow({ key: 'hc', icon: 'heart', title: platform.ios ? 'Apple Health' : 'Health Connect', use: platform.ios ? 'Reading your workouts, sleep and heart data from Apple Health.' : 'Reading what Samsung Health and other apps keep in Health Connect.', state: d.hc, href: '/settings/connections' }) : ''}
      `)}
      ${canOpen ? stGrp(stRow({ btn: true, attrs: 'data-perm="app-settings"', icon: 'settings', title: 'The phone\'s settings for rep.', sub: 'Every permission the phone holds for the app, to change or take back.' })) : ''}
      ${!platform.native ? stNote(`Turned off or blocked here only affects this ${platform.desktop ? 'computer' : 'browser'}. ${whereToChange()}`) : ''}

      ${stLab('Your account')}
      ${stGrp(html`
        ${stRow({ href: '/settings/connections/accounts/google', icon: 'heart', fam: 'heart', title: 'Google Health', sub: g === 'ok' ? `What rep. reads, and saves back, from Google Health${groups.length ? `: ${gOn} of ${groups.length} optional groups on` : ''}.` : 'Not connected: rep. reads nothing from Google.', value: g === 'ok' ? stDot('ok', 'Connected') : g === 'expired' ? stDot('bad', 'Reconnect') : stDot('off', 'Off') })}
        ${stRow({ href: '/settings/connections/accounts', icon: 'link', fam: 'active', title: 'Linked apps', sub: linked.length ? `${linked.join(', ')}: what each may read or send is on its page.` : 'Strava, Hevy, Garmin and the rest: none linked.', value: linked.length ? stDot('ok', f.plural(linked.length, 'app')) : stDot('off', 'None') })}
        ${stRow({ href: '/settings/privacy', icon: 'spark', fam: 'energy', title: 'AI', sub: ai ? `AI may read ${Object.values(ai.allow || {}).filter(Boolean).length} of ${aiKinds} kinds of your data when you ask it something. Never your name, never Strava's.` : 'Off: nothing of yours is sent to an AI.', value: ai ? stDot('ok', 'On') : stDot('off', 'Off') })}
        ${stRow({ href: '/settings/api', icon: 'key', fam: 'recovery', title: 'API keys and AI assistants', sub: 'Scripts and assistants (Claude, ChatGPT…) you gave a key to read, or log, your data.', value: Number.isFinite(keys) ? (keys ? stDot('ok', f.plural(keys, 'key')) : stDot('off', 'None')) : '' })}
        ${stRow({ href: '/settings/privacy', icon: 'shield', fam: 'steps', title: 'Who sees what', sub: 'Your account, workouts, heart, sleep and body data: you, friends, or everyone.', value: pv.account === 'private' ? 'Private' : 'Public' })}
      `)}
    </div>`);
  }
  paint();

  on(pane, 'click', '[data-perm]', async (e, b) => {
    const k = b.dataset.perm;
    if (k === 'app-settings') { if (!(await openAppSettings())) toast(whereToChange()); return; }
    if (!ask[k]) return;
    const got = await busy(b, () => ask[k]());
    d = { ...d, [k]: got };
    paint();
    if (got === 'denied') toast(`Not allowed. ${whereToChange()}`, { tone: 'bad' });
  });
  // Back from the phone's settings or another tab: read everything again.
  const again = async () => { if (document.visibilityState === 'visible' && pane.isConnected) { d = await readDevice(); paint(); } };
  document.addEventListener('visibilitychange', again);
  ctx?.onLeave?.(() => document.removeEventListener('visibilitychange', again));
}
