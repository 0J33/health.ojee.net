/* Me: account, connections, privacy, notifications, goals and units, data,
   admin, theme, sign out, about. A list on phones; a list beside the open
   section on wide screens. Every page under it is grouped rows (the kit in
   ../apps.js): a heading, a group, rows that go one tap deeper into a page
   or a sheet. */

import { api } from '../api.js';
import { app, setMe, refreshMe, go, listen } from '../app.js';
import { html, raw, esc, mount, ic, head, skeleton, errorState, on, sheet, confirm, field, fieldError, busy, toast, toastError, copyText, errText } from '../ui.js';
import { push, install, platform, checkForUpdate, applyUpdate, handoff } from '../pwa.js';
import * as f from '../format.js';
import { avatar, accountName } from './shared.js';
import { liveControl, bindLive } from './liveui.js';
import { groupsModule, groupsOf, groupOf, groupGrantToast } from '../groups.js';
import { appsModule, stGrp, stLab, stNote, stDot, stRow, stSwitch, stRadio, stHead, stInfo, stProse, stPick } from '../apps.js';

const SECTIONS = [
  ['account', 'Account', 'me', 'recovery'],
  ['connections', 'Connections', 'link', 'active'],
  ['privacy', 'Privacy', 'shield', 'steps'],
  ['notifications', 'Notifications', 'bell', 'heart'],
  ['goals', 'Goals', 'target', 'energy'],
  ['data', 'Your data', 'data', 'sleep'],
  ['admin', 'Admin', 'admin', 'body'],
];
const wide = () => matchMedia('(min-width: 960px)').matches;
const lead = (text, style = '') => html`<p class="st-lead" ${raw(style ? `data-style="${esc(style)}"` : '')}>${text}</p>`;
const warnRow = (title, text) => stRow({ icon: 'alert', fam: 'bad', title, sub: text, top: true });

/* ── pieces shared with onboarding ──────────────────────────── */

export const ACCENTS = ['#2fbf71', '#e2574c', '#f29f3d', '#e8c93a', '#3aa6e8', '#6c7cf0', '#b46cf0', '#e86cb4', '#3ac8c0', '#8d9a6a'];

/** How to get each kind of device's data into Google Health: one row each, the steps in a sheet. */
const TIPS = {
  fitbit: ['Fitbit or Pixel Watch', 'Nothing to set up', html`<p>Nothing to do. These already save to Google Health. Just connect the same Google account you use on the watch.</p>`],
  apple: ['Apple Watch or Apple Health', 'Through the Google Health app', html`<ol>
    <li>Install the Google Health app on your iPhone and sign in.</li>
    <li>When it asks, allow it to read from Apple Health. Turn on every category you want here: steps, heart rate, sleep, workouts.</li>
    <li>Open Google Health once a day or leave background refresh on, so it keeps copying.</li>
  </ol>`],
  android: ['Garmin, Samsung, Xiaomi and others', 'Through Health Connect', html`<ol>
    <li>In the watch's own app (Garmin Connect, Samsung Health, Mi Fitness, Zepp), turn on syncing to Health Connect.</li>
    <li>Open Health Connect in Android settings and check the watch app is allowed to write.</li>
    <li>Open the Google Health app and allow it to read from Health Connect.</li>
  </ol><p>What arrives depends on the watch. Some do not pass on HRV, blood oxygen or sleep stages; the app tells you what is missing.</p>`],
  phone: ['Just a phone', 'Steps and distance', html`<p>Steps and distance still work. On Android, Google Health counts them by itself. On iPhone, install Google Health and allow it to read steps from Apple Health. Heart rate and sleep need something on your wrist.</p>`],
};
export function deviceTips() {
  return stGrp(Object.entries(TIPS).map(([id, [title, sub]]) => stRow({ btn: true, attrs: `data-tip="${id}"`, icon: id === 'phone' ? 'phone' : 'watch', title, sub })));
}
// One listener for every tip row, wherever deviceTips() is drawn.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-tip]');
  if (!b || !TIPS[b.dataset.tip]) return;
  const [title, , body] = TIPS[b.dataset.tip];
  stInfo(title, stProse(body));
});

/** What other people can see for a given privacy object. */
export function privacyPreview(pv) {
  const pub = pv.account !== 'private';
  const item = (on1, text) => html`<li class="${on1 ? 'is-on' : 'is-off'}">${ic(on1 ? 'check' : 'eyeoff')}<span>${text}</span></li>`;
  return html`<div class="preview" aria-live="polite">
    ${pub ? html`<ul>
      ${item(true, 'Your name, colour and profile page')}
      ${item(pv.activity, pv.activity ? 'Steps, active minutes and distance, on the leaderboards and your profile' : 'Steps, active minutes, distance: hidden. You are off those leaderboards')}
      ${item(pv.workouts, pv.workouts ? 'Workout count, times and recent workouts' : 'Workouts: hidden')}
      ${item(pv.workouts && pv.feed !== false, pv.workouts && pv.feed !== false ? 'Each workout as a post in your friends\' feed' : 'Feed posts: none')}
      ${item(pv.sleep, pv.sleep ? 'Average sleep and sleep consistency' : 'Sleep: hidden')}
      ${item(pv.heart, pv.heart ? 'Resting heart rate and HRV' : 'Heart: hidden')}
      ${item(pv.body, pv.body ? 'Weight and body fat' : 'Body: hidden')}
    </ul>` : html`<ul>${item(false, 'Nothing. No profile page, no leaderboards. Only you see your numbers.')}</ul>`}
  </div>`;
}

const CATS = [
  ['activity', 'Activity', 'Steps, active minutes, distance', 'steps', 'steps'],
  ['workouts', 'Workouts', 'How many, how long, recent ones', 'strength', 'energy'],
  ['sleep', 'Sleep', 'Average time asleep, consistency', 'moon', 'sleep'],
  ['heart', 'Heart', 'Resting heart rate, HRV', 'heart', 'heart'],
  ['body', 'Body', 'Weight, body fat', 'scale', 'body'],
];
const ALWAYS = html`<p>Some things have no switch, because they are never shared:</p>
  <ul><li>What you log by hand: water, food, mood, stress, symptoms, a cycle</li><li>ECG readings, blood glucose, body temperature</li><li>Stress and Body Battery from a Garmin</li></ul>
  <p>They never appear on your profile, the leaderboard or compare.</p>`;

/** The privacy controls. Saves on every change; calls `changed()` after. */
export function privacyControls(pane, { changed } = {}) {
  function paint() {
    const pv = app.me.privacy || {};
    const priv = pv.account === 'private';
    mount(pane, html`<div class="st-page">
      ${stLab('Who can see you')}
      ${stGrp(html`${stRadio('account', 'public', !priv, 'Public', 'Friends see your profile and what you share.')}${stRadio('account', 'private', priv, 'Private', 'No profile, no leaderboards.')}`, 'role="radiogroup" aria-label="Who can see your account"')}
      ${stLab('What you share', priv ? 'Off while private' : '')}
      ${stGrp(CATS.map(([id, label, text, icon, fam]) => stSwitch(`cat-${id}`, Boolean(pv[id]) && !priv, label, text, { icon, fam, disabled: priv, label: `Share ${label.toLowerCase()}` })))}
      ${stLab('Feed')}
      ${stGrp(stSwitch('cat-feed', pv.feed !== false && Boolean(pv.workouts) && !priv, 'Post my workouts', priv ? 'Off while private' : !pv.workouts ? 'Needs workouts shared' : 'Friends see each workout in their feed and can cheer it', { icon: 'cheer', fam: 'energy', disabled: priv || !pv.workouts, label: 'Post my workouts to friends\' feeds' }))}
      ${stGrp(html`
        ${stRow({ btn: true, attrs: 'data-pv="preview"', icon: 'eye', title: 'What other people see' })}
        ${stRow({ btn: true, attrs: 'data-pv="always"', icon: 'lock', title: 'Always private', sub: 'What you log by hand, ECG and more' })}`)}
    </div>`);
  }
  async function save(patch) {
    try {
      setMe(await api.patch('/api/settings', { privacy: patch }));
      toast('Privacy updated');
      changed?.();
    } catch (err) { toastError(err); }
    paint();
  }
  on(pane, 'change', 'input[name="account"]', (e, input) => save({ account: input.value }));
  on(pane, 'change', 'input[name^="cat-"]', (e, input) => save({ [input.name.slice(4)]: input.checked }));
  on(pane, 'click', '[data-pv]', (e, b) => {
    if (b.dataset.pv === 'preview') stInfo('What other people see', privacyPreview(app.me.privacy || {}));
    else stInfo('Always private', stProse(ALWAYS));
  });
  paint();
}

/* Units: the same segmented control as the Me screen (`data-sg`, `data-v`). */
const UNITS = [
  ['volume', 'Training volume', [['t', 'Tonnes'], ['kg', 'kg'], ['lb', 'lb']]],
  ['weight', 'Body weight', [['kg', 'kg'], ['lb', 'lb']]],
  ['distance', 'Distance', [['km', 'km'], ['mi', 'mi']]],
  ['temp', 'Temperature', [['c', '°C'], ['f', '°F']]],
  ['water', 'Water', [['ml', 'ml'], ['oz', 'fl oz']]],
  ['clock', 'Time', [['24', '24-hour'], ['12', '12-hour']]],
];
/** A segmented control: `data-sg` names it, `data-v` is the value. */
const sg = (name, options, current, label) => html`<span class="me-sg" role="group" aria-label="${label}">${options.map(([v, t]) => html`<button type="button" data-sg="${name}" data-v="${v}" aria-pressed="${String(String(v) === String(current))}">${t}</button>`)}</span>`;
/** Every unit as a row with its control; `data-sg` is `u-<key of me.units>`. */
export function unitRows(u = {}) {
  return stGrp(UNITS.map(([key, title, opts]) => stRow({ title, end: sg(`u-${key}`, opts, u[key] || opts[0][0], `${title} unit`) })), 'data-units');
}

/** Notifications on this browser: turns on, turns off, or says why it cannot. */
export function thisDevice(pane, { getData, setData }) {
  function paint() {
    const d = getData();
    const state = push.support();
    const id = push.deviceId();
    const dev = d?.devices?.find((x) => x.id === id);
    const isOn = state === 'granted' && Boolean(dev) && dev.enabled !== false;
    const why = (icon, title, sub) => stRow({ icon, title, sub, top: true });
    let inner;
    if (state === 'native') inner = why('bell', 'Not from this app yet', 'Notifications come from the Home Screen web app: open health.ojee.net in Safari, add it to your Home Screen and turn them on there. Turn on "Open in the Health iPhone app" there too, and a tap brings you here.');
    else if (state === 'needs-install') inner = why('phone', 'Add Health to your Home Screen first', `On iPhone and iPad, notifications only work from the Home Screen app. ${platform.safari ? 'Tap Share, then Add to Home Screen' : 'Open this site in Safari, tap Share, then Add to Home Screen'}, and open Health from there.`);
    else if (state === 'unsupported') inner = why('bell', 'This browser cannot get notifications', 'Try Chrome, Edge, Firefox or Safari, or install the app on your phone.');
    else if (state === 'denied') inner = why('alert', 'Notifications are blocked', 'Allow them for this site in your browser or system settings, then reload.');
    else {
      inner = html`${stSwitch('push-here', isOn, 'Notifications', isOn ? `On${dev?.label ? `, as "${dev.label}"` : ''}` : 'Off. Your browser asks once.', { icon: 'bell', label: 'Notifications on this device' })}
        ${handoff.possible ? stSwitch('push-handoff', handoff.on, 'Open in the Health iPhone app', 'A tap opens that app, where live heart rate works. Only if it is installed.', { icon: 'phone', label: 'Open notifications in the Health iPhone app' }) : ''}`;
    }
    mount(pane, stGrp(inner));
  }
  on(pane, 'change', 'input[name="push-handoff"]', (e, input) => {
    handoff.set(input.checked);
    toast(input.checked ? 'Notifications open in the Health iPhone app' : 'Notifications open here');
  });
  on(pane, 'change', 'input[name="push-here"]', async (e, input) => {
    input.disabled = true;
    try {
      if (input.checked) {
        const r = await push.enable(app.me.push?.publicKey || getData()?.publicKey);
        setData(r); toast('Notifications are on');
      } else {
        const r = await push.disable();
        if (r) setData(r);
        toast('Notifications are off on this device');
      }
      refreshMe().catch(() => {});
    } catch (err) { toast(err.message || 'That did not work. Try again.', { tone: 'bad', ms: 8000 }); }
    paint();
  });
  paint();
  return paint;
}

/** A sheet with one form: fields, then Cancel and Save. `save(form)` returns true to close. */
function formSheet({ title, body, yes = 'Save', save }) {
  const id = `fs${Date.now().toString(36)}`;
  const s = sheet({
    title,
    body: html`<form class="form st-sheet" id="${id}" novalidate>${body}</form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="${id}">${yes}</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await busy(s.el.querySelector('button[type="submit"]'), () => save(form));
    if (ok) s.close(true);
  });
  return s;
}

/* ── sections ───────────────────────────────────────────────── */

async function account(pane) {
  function paint() {
    const me = app.me;
    const p = me.profile;
    mount(pane, html`<div class="st-page">
      <a class="st-me" href="/u/${encodeURIComponent(me.user.username)}">${avatar({ ...p, username: me.user.username }, { large: true })}
        <span class="st-b"><span class="st-me__n">${p.displayName || me.user.username}</span><span class="st-me__u">@${me.user.username} · See my profile</span></span>
        <span class="st-chev">${ic('chev_r', { size: 's' })}</span></a>
      ${stLab('Profile')}
      ${stGrp(html`
        ${stRow({ btn: true, attrs: 'data-edit="displayName"', icon: 'person', title: 'Display name', value: p.displayName || me.user.username })}
        ${stRow({ btn: true, attrs: 'data-edit="bio"', icon: 'text', title: 'Bio', value: p.bio || 'None' })}
        ${stRow({ btn: true, attrs: 'data-edit="accent"', icon: 'sun', title: 'Your colour', value: p.accent ? '' : 'Not chosen', end: p.accent ? html`<span class="st-sw" data-style="--sw:${p.accent}"></span>` : '' })}
        ${stRow({ btn: true, attrs: 'data-edit="tz"', icon: 'globe', title: 'Time zone', value: String(p.tz || '').replace(/_/g, ' ') })}`)}
      ${stNote('Your username and password cannot be changed here.')}
    </div>`);
  }
  const saveProfile = async (patch, okText = 'Saved') => {
    const r = await api.patch('/api/profile', patch);
    setMe(r); toast(okText); paint();
    return true;
  };
  on(pane, 'click', '[data-edit]', (e, b) => {
    const p = app.me.profile;
    const k = b.dataset.edit;
    if (k === 'displayName') {
      formSheet({
        title: 'Display name',
        body: field({ label: 'Display name', name: 'displayName', value: p.displayName || '', attrs: 'required maxlength="40" autocomplete="nickname" autofocus', hint: 'What friends see on leaderboards.' }),
        save: async (form) => {
          const v = form.elements.displayName.value.trim();
          fieldError(form, 'displayName', '');
          if (!v) { fieldError(form, 'displayName', 'Enter a name.'); return false; }
          try { return await saveProfile({ displayName: v }); } catch (err) { fieldError(form, 'displayName', errText(err)); return false; }
        },
      });
    } else if (k === 'bio') {
      formSheet({
        title: 'Bio',
        body: field({ label: 'Bio', name: 'bio', value: p.bio || '', attrs: 'maxlength="200" autocomplete="off" autofocus', hint: 'One line on your profile. Up to 200 characters. Leave it empty for none.' }),
        save: async (form) => { try { return await saveProfile({ bio: form.elements.bio.value.trim() }); } catch (err) { fieldError(form, 'bio', errText(err)); return false; } },
      });
    } else if (k === 'accent') {
      const cur = (p.accent || '').toLowerCase();
      const s = sheet({
        title: 'Your colour',
        body: html`<div class="st-sheet">${lead('For your avatar on leaderboards and your profile.')}
          <div class="swatches st-swatches" role="radiogroup" aria-label="Your colour">${ACCENTS.map((c) => html`<label class="swatch"><input type="radio" name="accent" value="${c}" ${cur === c ? 'checked' : ''} aria-label="Colour ${c}"><span class="swatch__c" data-style="--sw:${c}"></span></label>`)}</div></div>`,
      });
      s.el.addEventListener('change', async (ev) => {
        if (ev.target.name !== 'accent') return;
        try { await saveProfile({ accent: ev.target.value }, 'Colour saved'); s.close(); } catch (err) { toastError(err); }
      });
    } else if (k === 'tz') {
      const zones = f.listTimeZones();
      if (!zones.includes(p.tz)) zones.unshift(p.tz);
      formSheet({
        title: 'Time zone',
        body: field({ label: 'Time zone', name: 'tz', value: p.tz, options: zones.map((z) => [z, z.replace(/_/g, ' ')]), hint: `Your days and weeks follow this. This device is in ${f.browserTz().replace(/_/g, ' ')}.` }),
        save: async (form) => { try { return await saveProfile({ tz: form.elements.tz.value }); } catch (err) { fieldError(form, 'tz', errText(err)); return false; } },
      });
    }
  });
  paint();
}

async function connectionsDetail(pane, ctx, part) {
  let link = null;
  const googlePane = document.createElement('div');
  const linkPane = document.createElement('div');

  const STATE = { ok: ['ok', 'Connected'], needs_auth: ['off', 'Not connected'], expired: ['bad', 'Needs reconnecting'], unconfigured: ['warn', 'Not available'] };
  const dotOf = (state) => { const s = STATE[state] || ['off', 'Unknown']; return stDot(s[0], s[1]); };
  const RET = '/settings/connections/accounts/google';
  const connectRow = (title, { account = '', ret = RET, icon = 'link', sub = '' } = {}) => stRow({ action: 'connect-google', attrs: `data-return="${esc(ret)}" ${account ? `data-account="${esc(account)}"` : ''}`, icon, title, sub });
  const devLine = (d) => (d ? `${d.name || 'Tracker'}${f.isNum(d.battery) ? `, ${d.battery}%` : ''}${d.lastSync ? `, seen ${f.ago(d.lastSync)}` : ''}` : '');

  /** "More" about the connection: permissions, gaps, how data gets in. */
  function moreRows(g, many, anyOk) {
    const scopes = g.scopes?.length && g.state !== 'needs_auth' && g.state !== 'unconfigured' ? g.scopes : null;
    const gaps = app.me.capsMeta?.missing?.length && (g.state === 'ok' || anyOk) ? app.me.capsMeta.missing : null;
    return html`${stLab('More')}${stGrp(html`
      ${scopes ? stRow({ btn: true, attrs: 'data-g="scopes"', icon: 'key', title: many ? 'What your main account allowed' : 'What you allowed', value: `${scopes.filter((s) => s.granted).length} of ${scopes.length}` }) : ''}
      ${gaps ? stRow({ btn: true, attrs: 'data-g="gaps"', icon: 'info', title: `What your ${many ? 'trackers do' : 'device does'} not report`, value: String(gaps.length) }) : ''}
      ${stRow({ btn: true, attrs: 'data-g="tips"', icon: 'watch', title: 'Getting your data into Google Health' })}`)}`;
  }

  const MERGE = {
    activity: ['Steps and activity', [['auto', 'Automatic', 'Each quarter-hour counts the tracker that recorded more.'], ['sum', 'Add them up', 'For trackers never worn at the same time.'], ['max', 'The higher of the two', 'For two trackers worn together all day.'], ['primary', 'Main account only', 'The other counts only on days the main one has nothing.']], 'Calories always count your resting burn once, plus the activity of both.'],
    overnight: ['Overnight readings', null, 'Resting heart rate, HRV, blood oxygen, skin temperature and breathing rate.'],
    workouts: ['A workout both recorded', [['merge', 'Keep one', 'Overlapping by half or more: the fuller record stays.'], ['keep', 'Keep both', 'Every workout from every tracker is listed.']], ''],
  };
  const mergeOptions = (k, accts) => (k === 'overnight'
    ? [['auto', 'The tracker you slept in', 'When both did, the longer sleep.'], ...accts.filter((a) => a.include).map((a) => [a.id, `Always ${accountName(a)}`, 'Whenever it has them.'])]
    : MERGE[k][1]);

  function paintGoogle() {
    const g = app.me.google || { state: 'unconfigured' };
    // On a device's page: only whether Google Health is connected, and the way to it.
    if (part.compactGoogle) {
      mount(googlePane, html`${stLab('Google Health')}${stGrp(html`
        ${stRow({ icon: 'globe', title: 'Google Health', value: dotOf(g.state) })}
        ${g.state === 'ok' ? html`${stRow({ icon: 'person', title: 'Account', value: g.email || 'Connected' })}
          ${app.me.device ? stRow({ icon: 'watch', title: 'Device seen', value: `${app.me.device.name}${f.isNum(app.me.device.battery) ? ` · ${app.me.device.battery}%` : ''}` }) : ''}
          ${stRow({ icon: 'refresh', title: 'Last sync', value: app.me.sync?.lastOk ? f.ago(app.me.sync.lastOk) : 'Not yet' })}`
          : stRow({ icon: 'info', title: 'Not connected yet', sub: 'Nothing from the device arrives until it is.' })}
        ${g.state === 'needs_auth' || g.state === 'expired' ? connectRow(g.state === 'expired' ? 'Reconnect Google' : 'Connect Google', { ret: location.pathname }) : ''}
        ${stRow({ href: RET, icon: 'settings', title: 'Manage Google Health' })}`)}`);
      return;
    }
    const accts = app.me.googleAccounts || [];
    const many = accts.length > 1;
    const included = accts.filter((a) => a.include).length;
    const anyOk = accts.some((a) => a.include && a.state === 'ok');
    const status = many ? (accts.every((a) => !a.include || a.state === 'ok') ? stDot('ok', 'All connected') : anyOk ? stDot('warn', 'Needs attention') : dotOf(g.state)) : dotOf(g.state);
    const sync = app.me.sync;
    const r = app.me.merge || {};
    mount(googlePane, html`<div class="st-page">
      ${stHead({ icon: 'globe', fam: 'active', title: 'Google Health', status, sub: many ? `${accts.length} accounts` : g.state === 'ok' && g.email ? g.email : '' })}
      ${g.state === 'unconfigured' ? lead('The server is not set up to connect to Google yet. Ask ojee to finish the setup.', 'margin-top:14px') : ''}
      ${many ? html`
        ${stLab('Accounts')}
        ${stGrp(html`${accts.map((a) => stRow({
          btn: true, attrs: `data-acct="${esc(a.id)}"`, icon: a.device ? 'watch' : 'person',
          title: html`${accountName(a)}${a.primary ? html`<span class="st-tag">Main</span>` : ''}`,
          sub: [!a.include ? 'Left out' : a.lastOk ? `Synced ${f.ago(a.lastOk)}` : a.state === 'ok' ? 'First sync running' : 'Not syncing', a.device ? `${a.device.name || 'Tracker'}${f.isNum(a.device.battery) ? `, ${a.device.battery}%` : ''}` : ''].filter(Boolean).join(' · '),
          value: a.include && a.state !== 'ok' ? dotOf(a.state) : '',
        }))}
          ${g.state !== 'unconfigured' ? connectRow('Add another Google account', { account: 'new', icon: 'plus', sub: 'For another tracker' }) : ''}`)}
        ${stNote('Workouts, weigh-ins and what you log are saved to the main account.')}
        ${stLab('Putting the trackers together')}
        ${stGrp(html`
          ${[['activity', 'steps', 'steps'], ['overnight', 'moon', 'sleep'], ['workouts', 'strength', 'energy']].map(([k, icon, fam]) => stRow({ btn: true, attrs: `data-merge="${k}"`, icon, fam, title: MERGE[k][0], value: (mergeOptions(k, accts).find(([v]) => v === r[k]) || mergeOptions(k, accts)[0])[1] }))}
          ${stRow({ btn: true, attrs: 'data-g="merge"', icon: 'info', title: 'How they are put together' })}`)}` : html`
        ${g.state === 'needs_auth' ? html`
          ${lead('All your numbers come from Google Health. Connect the Google account your watch or phone uses.', 'margin-top:14px')}
          <div class="st-cta"><button type="button" class="btn" data-action="connect-google" data-return="${RET}">${ic('link', { size: 's' })}Connect Google</button></div>
          ${stNote('Google shows a screen saying this app is not verified, once: choose Advanced, then continue.')}` : ''}
        ${g.state === 'expired' ? html`<div data-style="margin-top:16px">${stGrp(html`${warnRow('Google stopped sharing your data', g.testingExpiry ? 'Google signs this app out every 7 days for now. Reconnect and everything carries on.' : `The connection was removed or has expired${g.expiredAt ? ` (${f.dateTime(g.expiredAt)})` : ''}. Your history is safe.`)}${connectRow('Reconnect Google', { icon: 'refresh' })}`)}</div>` : ''}
        ${g.state === 'ok' ? html`
          ${stLab('Status')}
          ${stGrp(html`
            ${stRow({ icon: 'calendar', title: 'Connected', value: g.connectedAt ? f.dateFull(f.instDay(g.connectedAt)) : f.DASH })}
            ${stRow({ icon: 'refresh', title: 'Last sync', value: sync?.lastOk ? f.ago(sync.lastOk) : 'Not yet' })}
            ${app.me.device ? stRow({ icon: 'watch', title: 'Device', value: `${app.me.device.name}${f.isNum(app.me.device.battery) ? ` · ${app.me.device.battery}%` : ''}` }) : ''}`)}
          ${stGrp(html`${connectRow('Reconnect', { icon: 'refresh' })}${connectRow('Add another Google account', { account: 'new', icon: 'plus', sub: 'Wear two trackers? Add the second one\'s account.' })}`)}` : ''}`}
      ${g.state !== 'unconfigured' && g.state !== 'needs_auth' || many ? moreRows(g, many, anyOk) : g.state === 'needs_auth' ? html`${stGrp(stRow({ btn: true, attrs: 'data-g="tips"', icon: 'watch', title: 'Getting your data into Google Health' }), 'data-style="margin-top:20px"')}` : ''}
      ${!many && (g.state === 'ok' || g.state === 'expired') ? stGrp(stRow({ btn: true, attrs: 'data-action="g-disconnect"', icon: 'unlink', title: 'Disconnect Google', danger: true, chev: false }), 'data-style="margin-top:20px"') : ''}
    </div>`);
  }

  /** One account of several: what it is, and what can be done to it, in a sheet. */
  function accountSheet(a) {
    const accts = app.me.googleAccounts || [];
    const included = accts.filter((x) => x.include).length;
    const acts = [
      a.state === 'ok' ? '' : connectRow(a.state === 'expired' ? 'Reconnect' : 'Connect', { account: a.id, icon: 'link' }),
      a.primary || !a.include ? '' : stRow({ btn: true, attrs: 'data-act="main"', icon: 'check', title: 'Make main', chev: false }),
      stRow({ btn: true, attrs: 'data-act="rename"', icon: 'edit', title: 'Rename' }),
      a.include && included <= 1 ? '' : stRow({ btn: true, attrs: `data-act="${a.include ? 'leave' : 'count'}"`, icon: a.include ? 'eyeoff' : 'eye', title: a.include ? 'Leave out' : 'Count it again', chev: false }),
      a.state === 'ok' || a.state === 'expired' ? stRow({ btn: true, attrs: 'data-act="disconnect"', icon: 'unlink', title: 'Disconnect', chev: false }) : '',
    ];
    const s = sheet({
      title: accountName(a),
      body: html`<div class="st-sheet">
        ${stGrp(html`
          ${stRow({ icon: 'globe', title: 'Status', value: a.include ? dotOf(a.state) : stDot('off', 'Left out: not counted') })}
          ${a.label && a.email ? stRow({ icon: 'person', title: 'Account', value: a.email }) : ''}
          ${stRow({ icon: 'refresh', title: 'Last sync', value: a.lastOk ? f.ago(a.lastOk) : a.state === 'ok' ? 'First sync running' : 'Not syncing' })}
          ${a.device ? stRow({ icon: 'battery', title: a.device.name || 'Tracker', value: devLine({ ...a.device, name: '' }).replace(/^, /, '') }) : ''}
          ${a.state === 'expired' ? warnRow('Not connected', a.testingExpiry ? 'Google signs this app out every 7 days for now. Reconnect and it carries on.' : `The connection was removed or has expired${a.expiredAt ? ` (${f.dateTime(a.expiredAt)})` : ''}. What it brought is kept.`) : ''}
          ${a.lastError && a.state === 'ok' && a.include ? warnRow('Last try', a.lastError.message || 'Google returned an error') : ''}`)}
        ${stGrp(acts.join(''))}
        ${stGrp(stRow({ btn: true, attrs: 'data-act="remove"', icon: 'trash', title: 'Remove', danger: true, chev: false }))}
      </div>`,
    });
    on(s.el, 'click', '[data-act]', async (e, b) => {
      const what = b.dataset.act;
      s.close();
      await s.closed;
      ACCT[what]?.(a);
    });
  }

  function paintLink() {
    if (!link) { mount(linkPane, ''); return; }
    mount(linkPane, html`<div class="st-page">
      ${stHead({ icon: 'key', title: 'Console health module', status: link.active ? stDot('ok', 'Linked') : stDot('off', 'Not linked') })}
      ${lead('Only with the ojee console. A link key lets its health module and this app keep the same workouts, so answering a question in one settles it in the other.', 'margin-top:14px')}
      ${link.detector ? html`<div data-style="margin-top:12px">${stGrp(stRow({ icon: 'wave', title: 'The module is detecting workouts', sub: 'While it is linked and detecting, this app does not run its own detection.', top: true }))}</div>` : ''}
      ${stLab('Link keys', link.keys?.length ? String(link.keys.length) : '')}
      ${stGrp(html`${(link.keys || []).map((k) => stRow({
        btn: true, attrs: `data-action="link-revoke" data-id="${esc(k.id)}" data-label="${esc(k.label || 'this key')}"`, icon: 'key',
        title: `${k.label || 'Link key'} •••• ${k.last4}`,
        sub: `Made ${f.dayShort(f.instDay(k.createdAt))} · ${k.lastSeenAt ? `used ${f.ago(k.lastSeenAt)}` : 'never used'}`,
        value: 'Revoke', chev: false,
      }))}
        ${stRow({ action: 'link-create', icon: 'plus', title: 'Make a link key' })}`)}
    </div>`);
  }

  // One screen of Connections at a time: `part` says which blocks it has.
  const has = (k) => part.blocks.includes(k);
  mount(pane, html`<div class="st-page cx-one">
    ${part.intro || ''}
    ${has('g') ? html`<div data-s="g"></div>` : ''}
    ${has('apps') ? html`<div data-s="apps"></div>` : ''}${has('more') ? html`<div data-s="more"></div>` : ''}
    ${has('hr') ? html`<div data-s="hr">${liveControl()}</div>` : ''}${has('l') ? html`<div data-s="l"></div>` : ''}
  </div>`);
  if (has('hr')) ctx.onLeave(bindLive(pane.querySelector('[data-s="hr"]')));
  pane.querySelector('[data-s="g"]')?.append(googlePane);
  pane.querySelector('[data-s="l"]')?.append(linkPane);
  paintGoogle();
  // Hevy, Strava, the scale, Garmin (web/js/apps.js).
  if (has('apps')) appsModule(pane.querySelector('[data-s="apps"]'), { query: ctx.query, onLeave: ctx.onLeave, only: part.only });
  // The optional groups: what can be logged by hand, and ECG readings.
  const more = has('more') ? groupsModule(pane.querySelector('[data-s="more"]'), { ret: '/settings/connections/extra' }) : { paint: () => {} };

  const gq = ctx.query.get('google');
  if (gq) {
    history.replaceState(history.state, '', location.pathname);
    const grant = groupGrantToast(gq);
    if (grant) toast(grant.text, { tone: grant.tone, ms: 7000 });
    else if (gq === 'connected') toast('Google connected. The first sync has started.');
    else if (gq === 'added') toast('Account added. Its first sync has started; its numbers join the rest in a minute or two.', { ms: 7000 });
    else if (gq === 'already') toast('That Google account was already connected here. Its connection has been refreshed.', { ms: 7000 });
    else if (gq === 'cancelled') toast('Google was not connected. You can try again any time.');
    else toast(ctx.query.get('message') || 'Google could not be connected. Try again.', { tone: 'bad', ms: 8000 });
  }

  on(pane, 'click', '[data-g]', (e, b) => {
    const g = app.me.google || {};
    const many = (app.me.googleAccounts || []).length > 1;
    if (b.dataset.g === 'scopes') {
      stInfo(many ? 'What your main account allowed' : 'What you allowed', html`
        ${stGrp(g.scopes.map((s) => stRow({ icon: s.granted ? 'check' : 'x', fam: s.granted ? 'active' : 'bad', title: s.label, sub: s.granted ? '' : 'Not allowed' })))}
        ${g.missing?.length ? stNote(`${g.missing.join('. ')}.`) : ''}`);
    } else if (b.dataset.g === 'gaps') {
      stInfo(`What your ${many ? 'trackers do' : 'device does'} not report`, stProse(html`<ul>${app.me.capsMeta.missing.map((m) => html`<li>${m.text}</li>`)}</ul>`));
    } else if (b.dataset.g === 'tips') {
      stInfo('Getting your data into Google Health', deviceTips());
    } else if (b.dataset.g === 'merge') {
      stInfo('How they are put together', stProse(html`<p>Calories always count your resting burn once, plus the activity of both.</p>
        <p>Sleep that both recorded is counted once, and a night split across the two adds up. A weigh-in that reached both accounts appears once.</p>
        <p>Workouts, weigh-ins and what you log here are saved to your main account.</p>`));
    }
  });
  on(pane, 'click', '[data-merge]', async (e, b) => {
    const k = b.dataset.merge;
    const accts = app.me.googleAccounts || [];
    const cur = (app.me.merge || {})[k] || mergeOptions(k, accts)[0][0];
    const v = await stPick({ title: MERGE[k][0], options: mergeOptions(k, accts), current: cur, foot: MERGE[k][2] });
    if (!v || v === cur) return;
    acct(() => api.patch('/api/google/merge', { [k]: v }), 'Updated. Your numbers have been worked out again.');
  });
  on(pane, 'click', '[data-acct]', (e, b) => { const a = byId(b.dataset.acct); if (a) accountSheet(a); });
  on(pane, 'click', '[data-action="g-disconnect"]', async () => {
    const yes = await confirm({ title: 'Disconnect Google?', text: 'New data stops arriving and this app loses its access at Google. Everything already here is kept.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    try { setMe(await api.post('/api/google/disconnect')); toast('Google disconnected'); paintGoogle(); more.paint(); } catch (err) { toastError(err); }
  });
  /* ── several accounts ── */
  const byId = (id) => (app.me.googleAccounts || []).find((a) => a.id === id);
  async function acct(call, okText) {
    try { await call(); await refreshMe(); paintGoogle(); more.paint(); if (okText) toast(okText); } catch (err) { toastError(err); }
  }
  const ACCT = {
    main: (a) => acct(() => api.patch(`/api/google/accounts/${a.id}`, { primary: true }), `${accountName(a)} is the main account now`),
    rename: (a) => formSheet({
      title: 'Name this account',
      body: field({ label: 'Name', name: 'label', value: a.label || '', attrs: 'maxlength="30" placeholder="Work watch" autocomplete="off" autofocus', hint: a.email ? `For ${a.email}. Leave it empty to show the address.` : 'Leave it empty to show the address.' }),
      save: async (form) => { await acct(() => api.patch(`/api/google/accounts/${a.id}`, { label: form.elements.label.value.trim() }), 'Saved'); return true; },
    }),
    leave: async (a) => {
      const yes = await confirm({ title: `Leave out ${accountName(a)}?`, text: 'Its numbers stop counting and it is not synced, until you count it again. Nothing is deleted.', yes: 'Leave out' });
      if (yes) acct(() => api.patch(`/api/google/accounts/${a.id}`, { include: false }), `${accountName(a)} left out`);
    },
    count: (a) => acct(() => api.patch(`/api/google/accounts/${a.id}`, { include: true }), `${accountName(a)} counts again`),
    disconnect: async (a) => {
      const yes = await confirm({ title: `Disconnect ${accountName(a)}?`, text: 'Its tracker stops being read and this app loses its access at Google. What it brought is kept.', yes: 'Disconnect', danger: true });
      if (yes) acct(() => api.post(`/api/google/accounts/${a.id}/disconnect`), 'Disconnected');
    },
    remove: async (a) => {
      const yes = await confirm({ title: `Remove ${accountName(a)}?`, text: `Its access is removed, and so is everything only it brought: its steps, sleep, heart rate and workouts.${a.primary ? ' Another account becomes the main one.' : ''} What your other trackers recorded stays. This cannot be undone.`, yes: 'Remove', danger: true });
      if (yes) acct(() => api.del(`/api/google/accounts/${a.id}`), 'Account removed');
    },
  };

  on(pane, 'click', '[data-action="link-create"]', () => {
    formSheet({
      title: 'Make a link key',
      yes: 'Make key',
      body: field({ label: 'Name (optional)', name: 'label', attrs: 'maxlength="40" placeholder="HP box" autocomplete="off"', hint: 'So you can tell keys apart later.' }),
      save: async (form) => {
        try {
          const label = form.elements.label.value.trim();
          const r = await api.post('/api/link/keys', label ? { label } : {});
          link = r; paintLink();
          setTimeout(() => {
            const shown = sheet({
              title: 'Your link key',
              body: html`<div class="st-sheet">
                ${lead('Copy it now: this is the only time it is shown. Lost it? Revoke it and make another.')}
                <p class="st-key" data-key data-style="margin-top:12px">${r.key}</p>
                ${stLab('Give the module these, then restart it')}
                <p class="st-key">HEALTH_WEB_URL=${r.url || location.origin}<br>HEALTH_WEB_KEY=${r.key}</p>
              </div>`,
              foot: html`<button type="button" class="btn btn--tonal" data-copy>${ic('copy', { size: 's' })}Copy key</button><button type="button" class="btn" data-close>Done</button>`,
            });
            shown.el.querySelector('[data-copy]').addEventListener('click', () => copyText(r.key));
          }, 250);
          return true;
        } catch (err) { toastError(err); return false; }
      },
    });
  });
  on(pane, 'click', '[data-action="link-revoke"]', async (e, btn) => {
    const yes = await confirm({ title: `Revoke ${btn.dataset.label}?`, text: 'The module using it stops syncing straight away. This cannot be undone; you would make a new key.', yes: 'Revoke', danger: true });
    if (!yes) return;
    try { link = await api.del(`/api/link/keys/${encodeURIComponent(btn.dataset.id)}`); toast('Key revoked'); paintLink(); refreshMe().catch(() => {}); } catch (err) { toastError(err); }
  });

  try { link = await api.get('/api/link'); paintLink(); } catch { /* the block stays out; the rest of the page works */ }
}

async function privacy(pane) {
  const inner = document.createElement('div');
  mount(pane, html`<div class="st-page"><div data-in></div>
    ${stGrp(stRow({ href: `/u/${encodeURIComponent(app.me.user.username)}`, icon: 'person', title: 'See my profile as others do' }), 'data-style="margin-top:8px"')}
    ${stNote('Changes apply straight away, leaderboards included.')}</div>`);
  pane.querySelector('[data-in]').append(inner);
  privacyControls(inner);
}

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const DAY_CHIPS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

/** Why the sitting nudge is quiet right now, in a line. */
function sittingNote(st) {
  if (!st) return '';
  switch (st.state) {
    case 'outside': return 'Outside your hours right now.';
    case 'quiet': return 'Quiet hours right now.';
    case 'workout': return 'Paused while a workout is running.';
    case 'waiting': return 'Waiting for the next step reading.';
    case 'stale': return 'Your newest step data is more than 20 minutes old, so it is staying quiet until fresh data arrives.';
    case 'warming': return 'In the first hour of your window there is no full hour to judge yet.';
    case 'ok': case 'low': return f.isNum(st.steps) ? `${f.plural(st.steps, 'step')} in the hour up to ${f.clock(st.asOf)}, at the last reading.` : '';
    default: return '';
  }
}
const timeIn = (name, value, label) => html`<input class="st-in" type="time" name="${name}" value="${value}" aria-label="${label}">`;
const daysText = (days = []) => (days.length === 7 ? 'Every day' : days.join(',') === 'mon,tue,wed,thu,fri' ? 'Weekdays' : DAY_CHIPS.filter(([id]) => days.includes(id)).map(([, l]) => l).join(', ') || 'No days');

async function notifications(pane, ctx) {
  const typesPage = ctx.params.sub === 'types';
  let d = null;
  mount(pane, skeleton('list'));
  try { d = await api.get('/api/push'); } catch (err) { mount(pane, errorState(err)); on(pane, 'click', '[data-action="retry"]', () => go(location.pathname, { replace: true })); return; }

  mount(pane, html`<div class="st-page">${typesPage ? '' : html`${stLab('This device')}<div data-here></div>`}<div data-rest></div></div>`);
  const here = pane.querySelector('[data-here]');
  const rest = pane.querySelector('[data-rest]');
  let paintHere = () => {};

  function paint() {
    const p = d.prefs || {};
    const quiet = p.quiet;
    const myId = push.deviceId();
    const types = d.types || [];
    const isOn = (t) => t.available !== false && (p.types?.[t.id] ?? t.default);
    if (typesPage) {
      const sit = p.sitting || {};
      mount(rest, html`
        ${stGrp(types.map((t) => {
          // A type this person's device cannot carry: shown, switched off, and why.
          const cannot = t.available === false;
          return html`${stSwitch(`type-${t.id}`, isOn(t), t.label, cannot && t.reason ? `${t.reason}.` : t.description, { disabled: cannot })}
            ${t.id === 'sitting' && isOn(t) ? stRow({ btn: true, attrs: 'data-sitting', icon: 'chair', title: 'Sitting nudge settings', value: `${f.hhmm(sit.from || '09:00')} to ${f.hhmm(sit.to || '18:00')}`, sub: `${daysText(sit.days || [])} · under ${f.int(sit.threshold ?? 250)} steps an hour` }) : ''}`;
        }))}
        ${app.me.link?.detector ? stNote('Workout questions come from your console module while it is linked.') : ''}`);
      return;
    }
    const devs = d.devices || [];
    mount(rest, html`
      ${stLab('Alerts')}
      ${stGrp(stRow({ href: '/settings/notifications/types', icon: 'bell', title: 'What to tell you about', value: `${types.filter(isOn).length} of ${types.length} on` }))}
      ${stLab('Timing')}
      ${stGrp(html`
        ${stSwitch('quiet-on', Boolean(quiet), 'Quiet hours', quiet ? '' : 'Nothing is sent. It still shows in the app.', { icon: 'moon' })}
        ${quiet ? html`${stRow({ title: 'From', end: timeIn('quiet-from', quiet.from, 'Quiet from'), attrs: 'data-style="padding-left:42px"' })}${stRow({ title: 'Until', end: timeIn('quiet-to', quiet.to, 'Quiet until'), attrs: 'data-style="padding-left:42px"' })}` : ''}
        ${stRow({ icon: 'sun', title: 'Morning readiness', end: timeIn('morningAt', p.morningAt || '07:30', 'Morning readiness at') })}
        ${stRow({ icon: 'calendar', title: 'Weekly summary', end: html`<select class="st-in" name="weekly-day" aria-label="Weekly summary day">${DAYS.map(([v, l]) => html`<option value="${v}" ${(p.weeklyAt?.day || 'sun') === v ? 'selected' : ''}>${l}</option>`)}</select>` })}
        ${stRow({ title: 'At', end: timeIn('weekly-time', p.weeklyAt?.time || '18:00', 'Weekly summary time'), attrs: 'data-style="padding-left:42px"' })}`)}
      ${stLab('Your devices', devs.length ? String(devs.length) : '')}
      ${stGrp(html`${devs.length ? devs.map((dev) => stRow({
        btn: true, attrs: `data-dev="${esc(dev.id)}"`, icon: /phone|android/i.test(dev.label || '') ? 'phone' : 'screen',
        title: html`${dev.label || 'Device'}${dev.id === myId ? html`<span class="st-tag">This one</span>` : ''}`,
        sub: dev.lastError ? `Last try failed: ${dev.lastError}` : dev.lastOkAt ? `Last reached ${f.ago(dev.lastOkAt)}` : `Added ${f.dayShort(f.instDay(dev.createdAt))}`, subBad: Boolean(dev.lastError),
        value: dev.enabled === false ? 'Paused' : '',
      })) : stRow({ icon: 'devices', title: 'No devices yet', sub: 'Turn on notifications above, and on any other phone or computer you want them on.', top: true })}
        ${devs.length ? stRow({ btn: true, attrs: 'data-action="test-all"', icon: 'bell', title: 'Send a test to every device', chev: false }) : ''}`)}`);
  }

  const take = (r) => { if (r && r.prefs) { d = r; paint(); paintHere(); } };
  if (here) paintHere = thisDevice(here, { getData: () => d, setData: take });
  paint();

  const savePrefs = async (body) => {
    try { take(await api.put('/api/push/prefs', body)); return true; } catch (err) {
      toastError(err); paint();
      // Refused because the device cannot carry it: the switches now say so.
      if (err.status === 409) api.get('/api/push').then(take).catch(() => {});
      return false;
    }
  };
  const tell = (text) => { toast(text, { tone: 'bad' }); paint(); };
  on(rest, 'change', 'input[name^="type-"]', (e, input) => savePrefs({ types: { [input.name.slice(5)]: input.checked } }));
  on(rest, 'change', 'input[name="quiet-on"]', (e, input) => savePrefs({ quiet: input.checked ? { from: '22:30', to: '07:00' } : null }));
  on(rest, 'change', 'input[name="quiet-from"], input[name="quiet-to"]', () => {
    const from = rest.querySelector('[name="quiet-from"]').value; const to = rest.querySelector('[name="quiet-to"]').value;
    if (from && to) savePrefs({ quiet: { from, to } });
  });
  on(rest, 'change', 'input[name="morningAt"]', (e, input) => { if (input.value) savePrefs({ morningAt: input.value }); });
  on(rest, 'change', '[name="weekly-time"], [name="weekly-day"]', () => {
    const time = rest.querySelector('[name="weekly-time"]').value; const day = rest.querySelector('[name="weekly-day"]').value;
    if (time && day) savePrefs({ weeklyAt: { day, time } });
  });

  /* The sitting nudge's own settings, in a sheet: hours, days, how few steps. */
  on(rest, 'click', '[data-sitting]', () => {
    const sit = d.prefs?.sitting || {};
    const lim = d.limits?.sitting?.threshold || {};
    const min = lim.min ?? 50; const max = lim.max ?? 2000;
    const note = sittingNote(d.status?.sitting);
    const s = sheet({
      title: 'Sitting nudge',
      body: html`<div class="st-sheet">
        ${stGrp(html`
          ${stRow({ title: 'From', end: timeIn('sit-from', sit.from || '09:00', 'From') })}
          ${stRow({ title: 'Until', end: timeIn('sit-to', sit.to || '18:00', 'Until') })}
          ${stRow({ title: 'Under this many steps an hour', end: html`<input class="st-in" type="number" name="sit-threshold" value="${sit.threshold ?? 250}" min="${min}" max="${max}" step="${lim.step ?? 50}" inputmode="numeric" aria-label="Steps an hour">` })}`)}
        ${stLab('Days')}
        <div class="chips chips--week" role="group" aria-label="Days">${DAY_CHIPS.map(([id, label]) => html`<button type="button" class="chip" data-day="${id}" aria-pressed="${String((sit.days || []).includes(id))}">${label}</button>`)}</div>
        ${stNote(`From ${f.int(min)} to ${f.int(max)} steps. It needs step data from the last 20 minutes, so a nudge can come late or not at all.${note ? ` ${note}` : ''}`)}
      </div>`,
    });
    const el = s.el;
    on(el, 'change', 'input[name="sit-from"], input[name="sit-to"]', () => {
      const from = el.querySelector('[name="sit-from"]').value; const to = el.querySelector('[name="sit-to"]').value;
      if (!from || !to) return;
      if (from >= to) { toast('Until has to be later than From.', { tone: 'bad' }); return; }
      savePrefs({ sitting: { from, to } });
    });
    on(el, 'click', '[data-day]', (e, btn) => {
      const days = [...el.querySelectorAll('[data-day]')].filter((b) => (b === btn ? b.getAttribute('aria-pressed') !== 'true' : b.getAttribute('aria-pressed') === 'true')).map((b) => b.dataset.day);
      if (!days.length) { toast('Keep at least one day.', { tone: 'bad' }); return; }
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      savePrefs({ sitting: { days } });
    });
    on(el, 'change', 'input[name="sit-threshold"]', (e, input) => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < min || n > max) { toast(`Choose a whole number from ${f.int(min)} to ${f.int(max)}.`, { tone: 'bad' }); return; }
      savePrefs({ sitting: { threshold: n } });
    });
  });

  /* One device, in a sheet: pause, test, remove. */
  const test = async (btn, body) => {
    try {
      const r = await busy(btn, () => api.post('/api/push/test', body));
      if (r === undefined) return;
      if (r.sent > 0 && !r.failed) toast(r.sent === 1 ? 'Test sent. It should arrive in a few seconds.' : `Test sent to ${r.sent} devices.`);
      else if (r.sent > 0) toast(`Sent to ${r.sent}, but ${r.failed} could not be reached.`, { tone: 'bad' });
      else toast(r.removed ? 'That device is no longer reachable and was removed.' : `The test could not be delivered.${r.errors?.[0] ? ` ${r.errors[0]}` : ''}`, { tone: 'bad' });
      if (r.removed) take(await api.get('/api/push'));
    } catch (err) { toast(err.status === 409 ? 'There is no device to send to. Turn on notifications first.' : errText(err), { tone: 'bad' }); }
  };
  on(rest, 'click', '[data-action="test-all"]', (e, btn) => test(btn, {}));
  on(rest, 'click', '[data-dev]', (e, b) => {
    const dev = (d.devices || []).find((x) => x.id === b.dataset.dev);
    if (!dev) return;
    const mine = dev.id === push.deviceId();
    const label = dev.label || 'this device';
    const s = sheet({
      title: dev.label || 'Device',
      body: html`<div class="st-sheet">
        ${stGrp(html`
          ${mine ? stRow({ icon: 'check', fam: 'active', title: 'This device' }) : ''}
          ${stRow({ icon: 'calendar', title: 'Added', value: f.dayShort(f.instDay(dev.createdAt)) })}
          ${stRow({ icon: 'bell', title: 'Last reached', value: dev.lastOkAt ? f.ago(dev.lastOkAt) : 'Not yet' })}
          ${dev.lastError ? warnRow('Last try failed', dev.lastError) : ''}`)}
        ${stGrp(html`
          ${stRow({ btn: true, attrs: 'data-d="toggle"', icon: dev.enabled === false ? 'play' : 'pause', title: dev.enabled === false ? 'Resume' : 'Pause', chev: false })}
          ${stRow({ btn: true, attrs: 'data-d="test"', icon: 'bell', title: 'Send a test', chev: false })}`)}
        ${stGrp(stRow({ btn: true, attrs: 'data-d="remove"', icon: 'trash', title: 'Remove', danger: true, chev: false }))}
      </div>`,
    });
    on(s.el, 'click', '[data-d="toggle"]', async (ev, btn) => {
      try { take(await busy(btn, () => api.patch(`/api/push/devices/${encodeURIComponent(dev.id)}`, { enabled: dev.enabled === false }))); s.close(); toast(dev.enabled === false ? 'Resumed' : 'Paused'); } catch (err) { toastError(err); }
    });
    on(s.el, 'click', '[data-d="test"]', (ev, btn) => test(btn, { deviceId: dev.id }));
    on(s.el, 'click', '[data-d="remove"]', async () => {
      s.close();
      const yes = await confirm({ title: `Remove ${label}?`, text: mine ? 'Notifications stop on this device. You can turn them on again here.' : 'Notifications stop on that device. Turn them on again from that device.', yes: 'Remove', danger: true });
      if (!yes) return;
      try {
        if (mine) { const r = await push.disable(); take(r || await api.get('/api/push')); }
        else take(await api.del(`/api/push/devices/${encodeURIComponent(dev.id)}`));
        toast('Device removed'); refreshMe().catch(() => {});
      } catch (err) { toastError(err); }
    });
  });
}

const OZ = 29.5735;

async function goals(pane) {
  const water = () => groupOf('nutrition')?.mode && groupOf('nutrition').mode !== 'off';
  const oz = () => f.waterUnit() === 'fl oz';
  function paint() {
    const g = app.me.goals || {};
    const sm = g.sleepMinutes || 450;
    mount(pane, html`<div class="st-page">
      ${stLab('Every day')}
      ${stGrp(html`
        ${stRow({ btn: true, attrs: 'data-goal="steps"', icon: 'footprint', fam: 'steps', title: 'Steps', value: f.int(g.steps ?? 8000) })}
        ${stRow({ btn: true, attrs: 'data-goal="activeMinutes"', icon: 'bolt', fam: 'active', title: 'Active minutes', value: `${f.int(g.activeMinutes ?? 22)} min` })}
        ${stRow({ btn: true, attrs: 'data-goal="sleep"', icon: 'moon', fam: 'sleep', title: 'Sleep', value: f.dur(sm) })}
        ${water() ? stRow({ btn: true, attrs: 'data-goal="waterMl"', icon: 'drop', fam: 'water', title: 'Water', value: oz() ? `${f.int(Math.round((g.waterMl ?? 2000) / OZ))} fl oz` : `${f.int(g.waterMl ?? 2000)} ml` }) : ''}`)}
      ${stLab('Every week')}
      ${stGrp(stRow({ btn: true, attrs: 'data-goal="cardioWeek"', icon: 'heart', fam: 'heart', title: 'Cardio minutes', value: `${f.int(g.cardioWeek ?? 150)} min` }))}
      ${stNote(html`150 cardio minutes a week, about 22 active minutes a day, is the usual health guideline. Units are on <a class="link" href="/settings">Me</a>.`)}
    </div>`);
  }
  const ONE = {
    steps: ['Steps a day', 'steps', 1000, 50000, 500, '1,000 to 50,000 a day.'],
    activeMinutes: ['Active minutes a day', 'min', 5, 240, 1, '5 to 240 a day. 22 a day is the usual guideline of 150 a week.'],
    cardioWeek: ['Cardio minutes a week', 'min', 30, 600, 5, '30 to 600, Monday to Sunday. Counted by this app from your zone or active minutes.'],
  };
  const saveGoal = async (patch) => { const r = await api.patch('/api/settings', { goals: patch }); setMe(r); toast('Goal saved'); paint(); return true; };
  on(pane, 'click', '[data-goal]', (e, b) => {
    const g = app.me.goals || {};
    const k = b.dataset.goal;
    if (k === 'sleep') {
      const sm = g.sleepMinutes || 450;
      formSheet({
        title: 'Sleep a night',
        body: html`<div class="field--row" role="group" aria-label="Sleep goal">
            <select class="select" name="sleepH" aria-label="Hours">${[4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => html`<option value="${h}" ${Math.floor(sm / 60) === h ? 'selected' : ''}>${h} hours</option>`)}</select>
            <select class="select" name="sleepM" aria-label="Minutes">${[0, 15, 30, 45].map((m) => html`<option value="${m}" ${Math.round((sm % 60) / 15) * 15 === m ? 'selected' : ''}>${m} minutes</option>`)}</select>
          </div><div data-err="sleepH"></div>${stNote('4 to 12 hours a night.')}`,
        save: async (form) => {
          const sleepMinutes = Number(form.elements.sleepH.value) * 60 + Number(form.elements.sleepM.value);
          fieldError(form, 'sleepH', '');
          if (sleepMinutes < 240 || sleepMinutes > 720) { fieldError(form, 'sleepH', 'Between 4 and 12 hours.'); return false; }
          try { return await saveGoal({ sleepMinutes }); } catch (err) { toastError(err); return false; }
        },
      });
      return;
    }
    if (k === 'waterMl') {
      const inOz = oz();
      formSheet({
        title: 'Water a day',
        body: inOz
          ? field({ label: 'Fluid ounces', name: 'waterMl', type: 'number', value: Math.round((g.waterMl ?? 2000) / OZ), attrs: 'inputmode="numeric" min="17" max="202" step="1" required autofocus', hint: '17 to 202 fl oz a day, counted from what you log here.' })
          : field({ label: 'Millilitres', name: 'waterMl', type: 'number', value: g.waterMl ?? 2000, attrs: 'inputmode="numeric" min="500" max="6000" step="50" required autofocus', hint: '500 to 6,000 ml a day, counted from what you log here.' }),
        save: async (form) => {
          let v = Number(form.elements.waterMl.value);
          fieldError(form, 'waterMl', '');
          const [lo, hi] = inOz ? [17, 202] : [500, 6000];
          if (!f.isNum(v) || v < lo || v > hi) { fieldError(form, 'waterMl', inOz ? 'Between 17 and 202 fl oz.' : 'Between 500 and 6,000.'); return false; }
          if (inOz) v = Math.min(6000, Math.max(500, Math.round(v * OZ)));
          try { return await saveGoal({ waterMl: Math.round(v) }); } catch (err) { fieldError(form, 'waterMl', errText(err)); return false; }
        },
      });
      return;
    }
    const [title, unit, lo, hi, step, hint] = ONE[k];
    const def = { steps: 8000, activeMinutes: 22, cardioWeek: 150 }[k];
    formSheet({
      title,
      body: field({ label: unit === 'steps' ? 'Steps' : 'Minutes', name: k, type: 'number', value: g[k] ?? def, attrs: `inputmode="numeric" min="${lo}" max="${hi}" step="${step}" required autofocus`, hint }),
      save: async (form) => {
        const v = Number(form.elements[k].value);
        fieldError(form, k, '');
        if (!f.isNum(v) || v < lo || v > hi) { fieldError(form, k, `Between ${f.int(lo)} and ${f.int(hi)}.`); return false; }
        try { return await saveGoal({ [k]: Math.round(v) }); } catch (err) { fieldError(form, k, errText(err)); return false; }
      },
    });
  });
  paint();
}

async function data(pane) {
  const username = app.me.user.username;
  mount(pane, html`<div class="st-page">
    ${stLab('Export')}
    ${stGrp(html`
      ${platform.native
    ? stRow({ action: 'export', icon: 'download', title: 'Everything', sub: 'JSON: profile, settings, every day, sleep, weight, workouts', chev: false })
    : stRow({ href: '/api/export', attrs: 'download data-native', icon: 'download', title: 'Everything', sub: 'JSON: profile, settings, every day, sleep, weight, workouts', chev: false })}
      ${stRow({ href: '/api/export?format=csv', attrs: 'download', icon: 'download', title: 'The daily table', sub: 'CSV, for a spreadsheet', chev: false })}`)}
    ${stNote('No passwords, tokens or keys are in either file.')}
    ${stLab('Delete')}
    ${stGrp(stRow({ action: 'delete-data', icon: 'trash', title: 'Delete my health data', danger: true }))}
    ${stNote('Google Health itself is not touched.')}
  </div>`);
  // The Health app has nowhere to download to, so the file goes to the
  // phone's share sheet instead (Save to Files, AirDrop, Mail).
  let exportFile = null;
  const shareExport = async () => {
    try {
      if (!navigator.canShare?.({ files: [exportFile] })) {
        toast('This phone cannot save the file from the app. Open health.ojee.net in Safari and download it there.', { tone: 'bad', ms: 9000 });
        return;
      }
      await navigator.share({ files: [exportFile] });
    } catch (err) {
      if (err?.name === 'AbortError') return;   // the share sheet was closed
      // Fetching took long enough that the phone wants a fresh tap.
      if (err?.name === 'NotAllowedError') toast('Your file is ready.', { action: 'Save it', onAction: shareExport, ms: 20000 });
      else toastError(err);
    }
  };
  on(pane, 'click', '[data-action="export"]', async (e, btn) => {
    try {
      if (!exportFile) {
        await busy(btn, async () => {
          const res = await fetch('/api/export', { credentials: 'same-origin' });
          if (!res.ok) throw new Error('The export could not be made. Try again.');
          const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'health-export.json';
          exportFile = new File([await res.blob()], name, { type: 'application/json' });
        });
      }
      if (exportFile) await shareExport();
    } catch (err) { toastError(err); }
  });
  on(pane, 'click', '[data-action="delete-data"]', () => {
    const s = sheet({
      title: 'Delete your health data?',
      body: html`<form class="form st-sheet" id="del-form" novalidate>
        ${lead('Your history, workouts, profile, leaderboard entries, notification devices, link keys and saved key go, and Google\'s access is revoked. You stay signed in and can start again from empty.')}
        ${stNote('This cannot be undone. Download your data first if you want it.')}
        <div data-style="margin-top:16px">${field({ label: `Type ${username} to confirm`, name: 'confirm', attrs: 'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required' })}</div>
      </form>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Keep my data</button><button type="submit" class="btn btn--solid-danger" form="del-form" disabled>Delete everything</button>`,
    });
    const form = s.el.querySelector('form');
    const btn = s.el.querySelector('button[type="submit"]');
    form.elements.confirm.addEventListener('input', (e) => { btn.disabled = e.target.value.trim().toLowerCase() !== username.toLowerCase(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      try {
        const r = await busy(btn, () => api.post('/api/account/delete-data', { confirm: form.elements.confirm.value.trim() }));
        if (r === undefined) return;
        try { await push.disable(); } catch { /* the device row is already gone */ }
        s.close();
        await refreshMe();
        toast('Your health data was deleted');
        go('/', { replace: true });
      } catch (err) { fieldError(form, 'confirm', errText(err, 'It could not be deleted. Try again.')); }
    });
  });
}

async function admin(pane) {
  let d = null;
  mount(pane, skeleton('list'));
  const G = { ok: ['ok', 'Connected'], needs_auth: ['off', 'No Google'], expired: ['bad', 'Expired'] };
  const syncErr = (p) => (p.syncError ? (typeof p.syncError === 'string' ? p.syncError : (p.syncError.message || p.syncError.code || 'Sync error')) : '');
  function paint() {
    const sv = d.server || {};
    const people = d.people || [];
    mount(pane, html`<div class="st-page">
      ${stGrp(stSwitch('reg-open', d.registrationOpen, 'Registration', d.registrationOpen ? 'Open: anyone can make an account.' : 'Closed: no new accounts. People here carry on.', { icon: 'users', label: 'Registration open' }))}
      ${stLab('People', f.int(people.length))}
      ${stGrp(people.map((p) => {
        const g = G[p.google] || ['off', p.google || 'Unknown'];
        return stRow({
          btn: true, attrs: `data-person="${esc(p.username)}"`, media: avatar(p),
          title: p.displayName || p.username,
          sub: syncErr(p) || `Seen ${f.ago(p.lastSeenAt)} · synced ${p.lastSyncAt ? f.ago(p.lastSyncAt) : 'never'}`, subBad: Boolean(syncErr(p)),
          value: p.google === 'ok' ? '' : stDot(g[0], g[1]),
        });
      }))}
      ${stNote('Only whether things work. No health data is shown here.')}
      ${stLab('Server')}
      ${stGrp(html`
        ${stRow({ icon: 'info', title: 'Version', value: `${sv.version || ''}${sv.demo ? ' (demo)' : ''}` })}
        ${stRow({ icon: 'clock', title: 'Running for', value: f.isNum(sv.uptimeS) ? f.dur(sv.uptimeS / 60) : f.DASH })}
        ${stRow({ icon: 'gauge', title: 'Memory', value: f.isNum(sv.memoryMb) ? `${f.int(sv.memoryMb)} MB` : f.DASH })}
        ${stRow({ icon: 'refresh', title: 'Syncs', value: sv.scheduler ? `${f.int(sv.scheduler.runs)} run, ${f.int(sv.scheduler.failures)} failed` : f.DASH })}
        ${stRow({ icon: 'globe', title: 'Google sign-in', value: sv.google?.configured ? stDot('ok', 'Set up') : stDot('warn', 'Not set up') })}
        ${stRow({ icon: 'bell', title: 'Notifications', value: sv.push?.configured ? stDot('ok', 'Set up') : stDot('warn', 'Not set up') })}
        ${stRow({ icon: 'data', title: 'Accounts database', value: sv.mongo?.ok ? stDot('ok', 'Reachable') : stDot('bad', 'Not reachable') })}`)}
    </div>`);
  }
  on(pane, 'click', '[data-person]', (e, b) => {
    const p = (d.people || []).find((x) => x.username === b.dataset.person);
    if (!p) return;
    const g = G[p.google] || ['off', p.google || 'Unknown'];
    stInfo(p.displayName || p.username, html`${stGrp(html`
      ${stRow({ icon: 'person', title: 'Username', value: `@${p.username}` })}
      ${stRow({ icon: 'eye', title: 'Last seen', value: f.ago(p.lastSeenAt) })}
      ${stRow({ icon: 'refresh', title: 'Last sync', value: p.lastSyncAt ? f.ago(p.lastSyncAt) : 'Never' })}
      ${stRow({ icon: 'globe', title: 'Google', value: stDot(g[0], g[1]) })}
      ${stRow({ icon: 'lock', title: 'Account', value: p.private ? 'Private' : 'Public' })}
      ${stRow({ icon: 'wave', title: 'Workout detection', value: p.detection ? 'On' : 'Off' })}
      ${stRow({ icon: 'bell', title: 'Notification devices', value: f.int(p.pushDevices || 0) })}
      ${stRow({ icon: 'key', title: 'Console link', value: p.linkKeys ? 'Linked' : 'No' })}
      ${stRow({ icon: 'spark', title: 'Own AI key', value: p.aiKey ? 'Yes' : 'No' })}
      ${syncErr(p) ? warnRow('Sync error', syncErr(p)) : ''}`)}`);
  });
  on(pane, 'change', 'input[name="reg-open"]', async (e, input) => {
    if (!input.checked) {
      const yes = await confirm({ title: 'Close registration?', text: 'Nobody new can join until you open it again. People already here are not affected.', yes: 'Close registration' });
      if (!yes) { paint(); return; }
    }
    try { d = await api.post('/api/admin/registration', { open: input.checked }); toast(d.registrationOpen ? 'Registration is open' : 'Registration is closed'); refreshMe().catch(() => {}); } catch (err) { toastError(err); }
    paint();
  });
  on(pane, 'click', '[data-action="retry"]', () => go('/settings/admin', { replace: true }));
  try { d = await api.get('/api/admin'); paint(); } catch (err) {
    mount(pane, err.status === 403 ? stGrp(stRow({ icon: 'lock', title: 'Admins only', sub: 'This page is for the people who run the site.', top: true })) : errorState(err));
  }
}

/* ── Connections: a hub, then devices and accounts ─────────────────── */

/** Every screen of Connections: its address, title, parent, and what it shows. */
const TRACKERS = [
  ['fitbit', 'Fitbit', 'watch', 'Saves to Google Health by itself'],
  ['pixel', 'Pixel Watch', 'watch', 'Saves to Google Health by itself'],
  ['apple', 'Apple Watch', 'watch', 'Through Apple Health and Google Health'],
  ['samsung', 'Samsung Galaxy Watch', 'watch', 'Through Health Connect'],
  ['garmin', 'Garmin', 'watch', 'Connects here directly'],
  ['other', 'Xiaomi, Amazfit, Huawei and others', 'watch', 'Through Health Connect or Apple Health'],
  ['phone', 'Just a phone', 'phone', 'Steps and distance'],
];
const SCALES = [
  ['xiaomi', 'Xiaomi Body Composition Scale S400', 'scale', 'Connects here directly, full body composition'],
  ['other', 'Withings, Renpho, Eufy, Garmin and others', 'scale', 'Through Health Connect or Apple Health'],
];
const HOW = {
  fitbit: html`<p>Nothing to set up: Fitbit already saves everything to Google Health. Connect the same Google account the Fitbit app uses.</p>`,
  pixel: html`<p>Nothing to set up: the Pixel Watch already saves everything to Google Health. Connect the same Google account the watch uses.</p>`,
  apple: html`<ol><li>Install the Google Health app on your iPhone and sign in with the Google account you connect here.</li><li>When it asks, allow it to read from Apple Health: steps, heart rate, sleep, workouts, weight.</li><li>Leave background refresh on, so it keeps copying.</li></ol>`,
  samsung: html`<ol><li>In Samsung Health, Settings, turn on Health Connect and allow it to write.</li><li>In the Google Health app, allow it to read from Health Connect.</li><li>Connect that Google account below.</li></ol><p>Sleep stages and HRV can be missing.</p>`,
  other: html`<ol><li>In the watch's own app (Mi Fitness, Zepp, Huawei Health), turn on syncing to Health Connect on Android, or to Apple Health on iPhone.</li><li>Let the Google Health app read from it.</li><li>Connect that Google account below.</li></ol><p>What arrives depends on the watch; this app tells you what is missing.</p>`,
  phone: html`<p>Steps and distance still work. On Android, Google Health counts them by itself. On iPhone, install Google Health and let it read steps from Apple Health. Heart rate and sleep need something on your wrist.</p>`,
  scaleOther: html`<ol><li>Let the scale's app write weight and body fat to Health Connect (Android) or Apple Health (iPhone).</li><li>Let the Google Health app read them.</li><li>They arrive with your other weigh-ins.</li></ol><p>Muscle, water and the rest stay in the scale's app: only a Xiaomi S400 sends those here.</p>`,
};
const howTo = (body) => html`${stLab('How it gets here')}${stProse(body)}`;
function cxPart(sub, item, brand) {
  const T = (k, list) => list.find((x) => x[0] === k);
  if (!sub) return { title: 'Connections', hub: 'root' };
  if (sub === 'devices' && !item) return { title: 'Devices', back: '/settings/connections', hub: 'devices' };
  if (sub === 'accounts' && !item) return { title: 'Accounts', back: '/settings/connections', hub: 'accounts' };
  if (sub === 'extra' && !item) return { title: 'Logging and extra readings', back: '/settings/connections', blocks: ['more'] };
  if (sub === 'devices' && item === 'tracker' && !brand) return { title: 'Watch or tracker', back: '/settings/connections/devices', hub: 'tracker' };
  if (sub === 'devices' && item === 'tracker' && brand === 'garmin') return { title: 'Garmin', back: '/settings/connections/devices/tracker', blocks: ['apps'], only: 'garmin' };
  if (sub === 'devices' && item === 'tracker' && T(brand, TRACKERS)) return { title: T(brand, TRACKERS)[1], back: '/settings/connections/devices/tracker', blocks: ['g'], intro: howTo(HOW[brand]), compactGoogle: true };
  if (sub === 'devices' && item === 'scale' && !brand) return { title: 'Smart scale', back: '/settings/connections/devices', hub: 'scale' };
  if (sub === 'devices' && item === 'scale' && brand === 'xiaomi') return { title: 'Xiaomi S400', back: '/settings/connections/devices/scale', blocks: ['apps'], only: 'scale' };
  if (sub === 'devices' && item === 'scale' && brand === 'other') return { title: 'Other scales', back: '/settings/connections/devices/scale', blocks: ['g'], compactGoogle: true, intro: howTo(HOW.scaleOther) };
  if (sub === 'devices' && item === 'hr' && !brand) return { title: 'Heart-rate sensor', back: '/settings/connections/devices', blocks: ['hr'], intro: lead('A Bluetooth chest strap or armband shows your heart rate live during a workout. Polar, Garmin HRM, Wahoo, Coospo: they all work.') };
  if (sub === 'accounts' && !brand) {
    const A = { google: { title: 'Google Health', blocks: ['g'] }, garmin: { title: 'Garmin', blocks: ['apps'], only: 'garmin' }, hevy: { title: 'Hevy', blocks: ['apps'], only: 'hevy' }, strava: { title: 'Strava', blocks: ['apps'], only: 'strava' }, console: { title: 'Console health module', blocks: ['l'] } };
    if (A[item]) return { ...A[item], back: '/settings/connections/accounts' };
  }
  return null;
}

/** Which brand of TRACKERS a device name Google reports is. */
const seenBrand = (name) => { const n = String(name || '').toLowerCase(); return !n ? null : /pixel/.test(n) ? 'pixel' : /fitbit|charge|versa|sense|inspire|luxe|air/.test(n) ? 'fitbit' : /apple|iphone/.test(n) ? 'apple' : /galaxy|samsung/.test(n) ? 'samsung' : /garmin|forerunner|fenix|venu|vivo/.test(n) ? 'garmin' : 'other'; };

async function connectionsHub(pane, part) {
  const me = app.me;
  const g = me.google?.state;
  const gDot = g === 'ok' ? stDot('ok', 'On') : g === 'expired' ? stDot('bad', 'Reconnect') : g === 'needs_auth' ? stDot('accent', 'Connect') : '';
  const onDot = (x) => (x ? stDot('ok', 'On') : '');
  const battery = me.device ? `${me.device.name}${f.isNum(me.device.battery) ? ` · ${me.device.battery}%` : ''}` : '';
  if (part.hub === 'root') {
    const accounts = [me.google?.state === 'ok' && 'Google Health', me.garmin?.connected && 'Garmin', me.hevy?.connected && 'Hevy', me.strava?.connected && 'Strava'].filter(Boolean);
    const groupsOn = groupsOf().filter((x) => x.mode !== 'off').length;
    mount(pane, html`<div class="st-page">
      ${lead('Where your numbers come from.')}
      ${stGrp(html`
        ${stRow({ href: '/settings/connections/devices', icon: 'devices', title: 'Devices', sub: 'What you wear or stand on', value: battery || (me.xiaomi?.connected ? 'Xiaomi scale' : '') })}
        ${stRow({ href: '/settings/connections/accounts', icon: 'account', title: 'Accounts', sub: accounts.length ? accounts.join(', ') : 'Google Health, Garmin, Hevy, Strava', value: g === 'expired' ? stDot('bad', 'Reconnect') : me.garmin?.lost ? stDot('bad', 'New key') : '' })}`, 'data-style="margin-top:12px"')}
      ${stGrp(stRow({ href: '/settings/connections/extra', icon: 'log', title: 'Logging and extra readings', sub: 'Water, food, mood, symptoms, cycle, ECG', value: groupsOf().length ? `${groupsOn} on` : '' }))}
    </div>`);
  } else if (part.hub === 'devices') {
    mount(pane, html`<div class="st-page">${stGrp(html`
      ${stRow({ href: '/settings/connections/devices/tracker', icon: 'watch', fam: 'active', title: 'Watch or tracker', sub: battery || 'Fitbit, Pixel, Apple, Samsung, Garmin and more', value: me.garmin?.connected && g !== 'ok' ? onDot(true) : gDot })}
      ${stRow({ href: '/settings/connections/devices/scale', icon: 'scale', fam: 'body', title: 'Smart scale', sub: me.xiaomi?.connected ? 'Xiaomi S400' : 'Xiaomi S400, or any other', value: onDot(me.xiaomi?.connected) })}
      ${stRow({ href: '/settings/connections/devices/hr', icon: 'heart', fam: 'heart', title: 'Heart-rate sensor', sub: 'Live during a workout' })}`)}
    </div>`);
  } else if (part.hub === 'accounts') {
    mount(pane, html`<div class="st-page">
      ${stGrp(html`
        ${stRow({ href: '/settings/connections/accounts/google', icon: 'globe', fam: 'active', title: 'Google Health', sub: 'Your devices\' data, and what you log', value: gDot })}
        ${stRow({ href: '/settings/connections/accounts/garmin', icon: 'watch', fam: 'active', title: 'Garmin', sub: 'Read directly, with your own key', value: me.garmin?.lost ? stDot('bad', 'New key') : onDot(me.garmin?.connected) })}
        ${stRow({ href: '/settings/connections/accounts/hevy', icon: 'strength', fam: 'energy', title: 'Hevy', sub: 'Workouts, routines, measurements', value: onDot(me.hevy?.connected) })}
        ${stRow({ href: '/settings/connections/accounts/strava', icon: 'route', fam: 'energy', title: 'Strava', sub: 'Runs, rides and walks with routes', value: onDot(me.strava?.connected) })}`)}
      ${stLab('Advanced')}
      ${stGrp(stRow({ href: '/settings/connections/accounts/console', icon: 'key', title: 'Console health module', sub: 'Only with the ojee console' }))}
    </div>`);
  } else {
    const list = part.hub === 'tracker' ? TRACKERS : SCALES;
    mount(pane, html`<div class="st-page">
      ${lead(part.hub === 'tracker' ? 'Which do you wear? A Garmin connects here directly; the rest come through Google Health.' : 'Which scale? A Xiaomi S400 connects here directly; any other comes through Google Health.')}
      ${stGrp(list.map(([id, name, icon, text]) => stRow({
        href: `/settings/connections/devices/${part.hub}/${id}`, icon, title: name, sub: text,
        value: (id === 'xiaomi' && me.xiaomi?.connected) || (id === 'garmin' && part.hub === 'tracker' && me.garmin?.connected) ? stDot('ok', 'On') : part.hub === 'tracker' && seenBrand(me.device?.name) === id ? stDot('ok', 'Yours') : '',
      })), 'data-style="margin-top:12px"')}
    </div>`);
  }
}

async function connections(pane, ctx) {
  const { sub = '', item = '', brand = '' } = ctx.params;
  // Back from Google's or Strava's sign-in at the old address: the screen it belongs to.
  if (!sub && ctx.query.get('google')) { go(`/settings/connections/accounts/google${location.search}`, { replace: true }); return; }
  if (!sub && ctx.query.get('strava')) { go(`/settings/connections/accounts/strava${location.search}`, { replace: true }); return; }
  const part = cxPart(sub, item, brand);
  if (!part) { go('/settings/connections', { replace: true }); return; }
  if (part.hub) { await connectionsHub(pane, part); return; }
  await connectionsDetail(pane, ctx, part);
}

const RENDER = { account, connections, privacy, notifications, goals, data, admin };
/** Pages below a section other than Connections: title and parent. */
const SUBPAGES = { notifications: { types: { title: 'What to tell you about', back: '/settings/notifications' } } };

/* ── the page ───────────────────────────────────────────────── */

/* Me (2026-10-31 redesign): a profile card, then grouped rows. Appearance,
   where the workout card lives and every unit are switched right here;
   the sections open their own pages. */

const WCARD = 'health.wcard';
const wcardOn = () => { try { return localStorage.getItem(WCARD) === 'train' ? 'train' : 'today'; } catch { return 'today'; } };

/** One settings row: what it is (and a line under it), then its control. */
const srow = (title, control, sub = '') => html`<div class="me-srow"><div class="me-srow__b"><p class="me-srow__t">${title}</p>${sub ? html`<p class="me-srow__d">${sub}</p>` : ''}</div>${control}</div>`;
/** A row into a page. */
const lrow = ({ href = '', action = '', icon, title, value = '', fam = '', attrs = '' }) => {
  const tag = href ? 'a' : 'button';
  const a = href ? `href="${esc(href)}"` : `type="button" ${action ? `data-action="${esc(action)}"` : ''}`;
  return html`<${raw(tag)} class="me-row press" ${raw(a)} ${raw(attrs)}>
    <span class="me-row__ic ${fam ? `me-ic--${fam}` : ''}">${ic(icon)}</span><span class="me-row__t">${title}</span>
    ${value !== '' && value !== null && value !== undefined ? html`<span class="me-row__v">${value}</span>` : ''}${href ? html`<span class="me-row__chev">${ic('chev_r', { size: 's' })}</span>` : ''}
  </${raw(tag)}>`;
};

/** "Fitbit Air · synced 7:20 · Hevy linked". */
function profileLine() {
  const me = app.me;
  const bits = [];
  if (me.device?.name) bits.push(me.device.name);
  if (me.google?.state === 'ok' || me.garmin?.connected) {
    const t = Math.max(me.google?.state === 'ok' ? me.sync?.lastOk || 0 : 0, me.garmin?.connected ? me.garmin.lastSync || 0 : 0) || null;
    bits.push(me.sync?.running || app.syncing ? 'syncing now' : t ? `synced ${f.instDay(t) === f.today() ? f.clock(t) : f.ago(t)}` : 'not synced yet');
    if (me.garmin?.connected && me.google?.state !== 'ok') bits.push('Garmin');
  } else if (me.google?.state === 'expired') bits.push('Google needs reconnecting');
  else if (me.garmin?.lost) bits.push('Garmin needs a new key');
  else bits.push('Not connected yet');
  if (me.hevy?.connected) bits.push('Hevy linked');
  if (me.strava?.connected) bits.push('Strava linked');
  return bits.join(' · ');
}

function profileCard() {
  const me = app.me;
  const name = me.profile.displayName || me.user.username;
  return html`<a class="me-pcard press" href="/u/${encodeURIComponent(me.user.username)}" aria-label="${name}: see my profile">
    <span class="me-pcard__av" aria-hidden="true">${f.initials(name).slice(0, 1).toUpperCase()}</span>
    <span class="me-pcard__b"><span class="me-pcard__n">${name}</span><span class="me-pcard__d" data-me-line>${profileLine()}</span></span>
    <span class="me-row__chev">${ic('chev_r', { size: 's' })}</span>
  </a>`;
}

function meHome(active = '') {
  const me = app.me;
  const u = me.units || {};
  const g = me.google?.state;
  const theme = window.healthTheme?.get() || 'system';
  const dev = me.device;
  const inst = install.state();
  const cur = (id) => (active === id ? 'aria-current="page"' : '');
  return html`
    ${profileCard()}
    <p class="me-lab">Appearance</p>
    <div class="me-grp">${srow('Theme', sg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], theme, 'Theme'))}</div>
    <p class="me-lab">Today</p>
    <div class="me-grp">
      ${srow('Workout card', sg('wcard', [['today', 'Today'], ['train', 'Train']], wcardOn(), 'Where a running workout shows'), 'Where a running workout shows')}
    </div>
    <p class="me-lab">Units</p>
    <div class="me-grp" data-units>${UNITS.map(([key, title, opts]) => srow(title, sg(`u-${key}`, opts, u[key] || opts[0][0], `${title} unit`)))}</div>
    <p class="me-lab">You and your data</p>
    <nav class="me-grp me-grp--rows" aria-label="Settings">
      ${lrow({ href: '/settings/account', icon: 'person', title: 'Account', value: `@${me.user.username}`, attrs: cur('account') })}
      ${lrow({ href: '/settings/connections', icon: 'link', title: 'Connections', value: g === 'expired' ? html`<span class="badge badge--bad">Reconnect</span>` : me.garmin?.lost ? html`<span class="badge badge--bad">New key</span>` : g === 'ok' || me.garmin?.connected ? 'Connected' : g === 'needs_auth' ? html`<span class="badge badge--accent">Connect</span>` : '', attrs: cur('connections') })}
      ${lrow({ href: '/settings/connections/devices', icon: 'watch', title: 'Devices', value: dev?.name ? `${dev.name}${f.isNum(dev.battery) ? ` · ${dev.battery}%` : ''}` : '' })}
      ${lrow({ href: '/settings/privacy', icon: 'shield', title: 'Privacy', value: me.privacy?.account === 'private' ? 'Private' : 'Public', attrs: cur('privacy') })}
      ${lrow({ href: '/settings/notifications', icon: 'bell', title: 'Notifications', value: me.push?.devices ? f.plural(me.push.devices, 'device') : 'Off', attrs: cur('notifications') })}
      ${lrow({ href: '/settings/goals', icon: 'target', title: 'Goals', value: `${f.int(me.goals?.steps ?? 8000)} steps`, attrs: cur('goals') })}
      ${lrow({ href: '/settings/data', icon: 'data', title: 'Your data', value: 'Export, delete', attrs: cur('data') })}
      ${me.user.admin ? lrow({ href: '/settings/admin', icon: 'admin', title: 'Admin', attrs: cur('admin') }) : ''}
    </nav>
    <p class="me-lab">App</p>
    <div class="me-grp me-grp--rows">
      ${lrow({ icon: 'spark', title: 'Ask AI about your data', attrs: 'data-ai="ask" data-ai-title="Ask AI"' })}
      ${inst === 'prompt' ? lrow({ action: 'install', icon: 'addbox', title: 'Install the app', value: 'Home screen' }) : ''}
      ${inst === 'ios' ? html`<div class="me-row"><span class="me-row__ic">${ic('addbox')}</span><span class="me-row__t">Add to Home Screen<span class="me-row__s">In Safari: tap Share, then Add to Home Screen</span></span></div>` : ''}
      ${lrow({ action: 'check-update', icon: 'refresh', title: 'Check for updates', value: `${me.version || ''}${app.build ? ` · ${app.build}` : ''}` })}
      ${lrow({ action: 'signout', icon: 'logout', title: 'Sign out' })}
    </div>
    <p class="me-foot">Health ${me.version || ''}${me.demo ? ' · demo mode, nothing here is real' : ''} </p>`;
}

/** The Me screen's controls: theme, the workout card, live pinning, units. */
function bindMe(root) {
  on(root, 'click', '[data-sg]', async (e, b) => {
    const name = b.dataset.sg; const v = b.dataset.v;
    const group = [...root.querySelectorAll(`[data-sg="${name}"]`)];
    const press = () => group.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
    if (name === 'theme') { window.healthTheme?.set(v); press(); return; }
    if (name === 'wcard') {
      try { localStorage.setItem(WCARD, v); } catch { /* private mode: stays where it is */ }
      press(); toast(v === 'train' ? 'A running workout shows on Train' : 'A running workout shows on Today');
      return;
    }
    if (name.startsWith('u-')) {
      if (b.getAttribute('aria-pressed') === 'true') return;
      const key = name.slice(2);
      press();
      try {
        setMe(await api.patch('/api/settings', { units: { [key]: v } }));
        toast('Units updated');
        const line = root.querySelector('[data-me-line]');
        if (line) line.textContent = profileLine();
      } catch (err) { toastError(err); group.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === String(app.me.units?.[key])))); }
    }
  });
}

export default async function settings(ctx) {
  const { root } = ctx;
  const me = app.me;
  let section = ctx.params.section || '';
  if (section && (!RENDER[section] || (section === 'admin' && !me.user.admin))) { go('/settings', { replace: true }); return; }
  const isWide = wide();
  const shown = section || (isWide ? 'account' : '');
  const cx = section === 'connections' && ctx.params.sub ? cxPart(ctx.params.sub, ctx.params.item || '', ctx.params.brand || '')
    : section && ctx.params.sub ? SUBPAGES[section]?.[ctx.params.sub] || null : null;
  if (section && section !== 'connections' && ctx.params.sub && !cx) { go(`/settings/${section}`, { replace: true }); return; }
  const title = cx?.title || (shown ? SECTIONS.find(([id]) => id === shown)[1] : 'Me');
  document.title = `${section ? title : 'Me'} · Health`;

  if (isWide) {
    mount(root, html`${head({ title: 'Me' })}
      <div class="settings me-wide">
        <div class="settings__nav me">${meHome(shown)}</div>
        <div>${cx?.back ? html`<a class="cx-back link small" href="${cx.back}">${ic('left', { size: 's' })}Back</a>` : ''}<h2 class="head__title" data-style="font-size:1.375rem;margin:4px 4px 16px" tabindex="-1">${title}</h2><div data-pane></div></div>
      </div>`);
  } else if (!section) {
    const from = history.state?.from;
    const back = from && !from.startsWith('/settings') ? from : '/';
    const BACKS = { '/': 'Today', '/trends': 'Health', '/workouts': 'Train', '/ranks': 'People' };
    mount(root, html`<header class="me-nav"><a class="me-nav__back" href="${back}">${ic('chev_l', { size: 's' })}<span>${BACKS[back] || 'Back'}</span></a><h1 class="me-nav__t" tabindex="-1">Me</h1><span></span></header>
      <div class="me">${meHome()}</div>`);
  } else {
    mount(root, html`${head({ title, back: cx?.back || '/settings' })}<div data-pane></div>`);
  }
  bindMe(root);

  on(root, 'click', '[data-action="check-update"]', async (e, b) => {
    const r = await busy(b, () => checkForUpdate(app.build));
    if (!r) return;
    if (r.state === 'offline') { toast('Could not reach the server. Check your connection and try again.', { tone: 'bad' }); return; }
    if (r.state === 'ready') { toast('A new version is here. Updating…'); setTimeout(applyUpdate, 600); return; }
    toast(`You have the latest version${r.build ? ` (build ${r.build})` : ''}.`);
  });
  on(root, 'click', '[data-action="install"]', async () => {
    const r = await install.prompt();
    if (r === 'accepted') toast('Installed. Look for Health on your home screen.');
  });

  const pane = root.querySelector('[data-pane]');
  if (pane && shown) {
    try { await RENDER[shown](pane, ctx); } catch (err) { mount(pane, errorState(err)); on(pane, 'click', '[data-action="retry"]', () => go(location.pathname, { replace: true })); }
  }
  // If the viewport crosses the phone/desktop line, lay the page out again.
  const mq = matchMedia('(min-width: 960px)');
  const flip = () => { if (ctx.alive() && wide() !== isWide) go(location.pathname + location.search, { replace: true }); };
  mq.addEventListener('change', flip);
  ctx.onLeave(() => mq.removeEventListener('change', flip));
  ctx.onLeave(listen('changed', () => {}));
}
