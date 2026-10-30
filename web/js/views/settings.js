/* Me: account, connections, privacy, notifications, goals and units, data,
   admin, theme, sign out, about. A list on phones; a list beside the open
   section on wide screens. */

import { api } from '../api.js';
import { app, setMe, refreshMe, go, listen } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, empty, banner, on, seg, sheet, confirm, field, formValues, fieldError, busy, toast, toastError, toggle, row, copyText, errText } from '../ui.js';
import { push, install, platform, openOutside, checkForUpdate, applyUpdate, handoff } from '../pwa.js';
import * as f from '../format.js';
import { avatar, accountName } from './shared.js';
import { liveControl, bindLive } from './liveui.js';
import { groupsModule, groupOf, groupGrantToast } from '../groups.js';
import { appsModule } from '../apps.js';

const SECTIONS = [
  ['account', 'Account', 'me', 'recovery'],
  ['connections', 'Connections', 'link', 'active'],
  ['privacy', 'Privacy', 'shield', 'steps'],
  ['notifications', 'Notifications', 'bell', 'heart'],
  ['goals', 'Goals and units', 'target', 'energy'],
  ['data', 'Your data', 'data', 'sleep'],
  ['admin', 'Admin', 'admin', 'body'],
];
const wide = () => matchMedia('(min-width: 960px)').matches;

/* ── pieces shared with onboarding ──────────────────────────── */

export const ACCENTS = ['#2fbf71', '#e2574c', '#f29f3d', '#e8c93a', '#3aa6e8', '#6c7cf0', '#b46cf0', '#e86cb4', '#3ac8c0', '#8d9a6a'];

/** How to get each kind of device's data into Google Health. */
export function deviceTips() {
  const tip = (iconName, title, body, open = false) => html`<details class="acc" ${open ? 'open' : ''}>
    <summary><span class="row__ic">${ic(iconName)}</span><span>${title}</span><span class="row__chev">${ic('right', { size: 's' })}</span></summary>
    <div class="acc__body">${body}</div>
  </details>`;
  return html`<div class="group">
    ${tip('watch', 'Fitbit or Pixel Watch', html`<p>Nothing to do. These already save to Google Health. Just connect the same Google account you use on the watch.</p>`)}
    ${tip('watch', 'Apple Watch, or anything that writes to Apple Health', html`<ol>
      <li>Install the Google Health app on your iPhone and sign in.</li>
      <li>When it asks, allow it to read from Apple Health. Turn on every category you want here: steps, heart rate, sleep, workouts.</li>
      <li>Open Google Health once a day or leave background refresh on, so it keeps copying.</li>
    </ol>`)}
    ${tip('watch', 'Garmin, Samsung, Xiaomi and other Android watches', html`<ol>
      <li>In the watch's own app (Garmin Connect, Samsung Health, Mi Fitness, Zepp), turn on syncing to Health Connect.</li>
      <li>Open Health Connect in Android settings and check the watch app is allowed to write.</li>
      <li>Open the Google Health app and allow it to read from Health Connect.</li>
    </ol><p data-style="margin-top:8px">What arrives depends on the watch. Some do not pass on HRV, blood oxygen or sleep stages; the app tells you what is missing.</p>`)}
    ${tip('phone', 'Just a phone', html`<p>Steps and distance still work. On Android, Google Health counts them by itself. On iPhone, install Google Health and allow it to read steps from Apple Health. Heart rate and sleep need something on your wrist.</p>`)}
  </div>`;
}

/** What other people can see for a given privacy object. */
export function privacyPreview(pv) {
  const pub = pv.account !== 'private';
  const item = (on, text) => html`<li class="${on ? 'is-on' : 'is-off'}">${ic(on ? 'check' : 'eyeoff')}<span>${text}</span></li>`;
  return html`<div class="preview" aria-live="polite">
    <p class="preview__k">What other people see</p>
    ${pub ? html`<ul>
      ${item(true, 'Your name, colour and profile page')}
      ${item(pv.activity, pv.activity ? 'Steps, active minutes and distance, on the leaderboards and your profile' : 'Steps, active minutes, distance: hidden. You are off those leaderboards')}
      ${item(pv.workouts, pv.workouts ? 'Workout count, times and recent workouts' : 'Workouts: hidden')}
      ${item(pv.sleep, pv.sleep ? 'Average sleep and sleep consistency' : 'Sleep: hidden')}
      ${item(pv.heart, pv.heart ? 'Resting heart rate and HRV' : 'Heart: hidden')}
      ${item(pv.body, pv.body ? 'Weight and body fat' : 'Body: hidden')}
    </ul>` : html`<ul>${item(false, 'Nothing. No profile page, no leaderboards. Only you see your numbers.')}</ul>`}
  </div>`;
}

const CATS = [
  ['activity', 'Activity', 'Steps, active minutes, distance, calories'],
  ['workouts', 'Workouts', 'How many, how long, and your recent ones'],
  ['sleep', 'Sleep', 'Average time asleep and consistency'],
  ['heart', 'Heart', 'Resting heart rate and HRV'],
  ['body', 'Body', 'Weight and body fat'],
];

/** The privacy controls. Saves on every change; calls `changed()` after. */
export function privacyControls(pane, { changed } = {}) {
  function paint() {
    const pv = app.me.privacy || {};
    const priv = pv.account === 'private';
    mount(pane, html`<div class="stack">
      <div class="group" role="radiogroup" aria-label="Who can see your account">
        <label class="radio"><input type="radio" name="account" value="public" ${priv ? '' : 'checked'}><span><span class="radio__t">Public</span><br><span class="radio__d">Friends can see your profile and the categories you share below.</span></span></label>
        <label class="radio"><input type="radio" name="account" value="private" ${priv ? 'checked' : ''}><span><span class="radio__t">Private</span><br><span class="radio__d">No profile, no leaderboards. Everything stays with you.</span></span></label>
      </div>
      <div>
        <div class="sec__head"><h2 class="h2">Share by category</h2>${priv ? html`<span class="sec__note">Off while private</span>` : ''}</div>
        <div class="group">
          ${CATS.map(([id, label, text]) => html`<div class="row"><span class="row__body"><span class="row__t">${label}</span><span class="row__d">${text}</span></span>${toggle(`cat-${id}`, Boolean(pv[id]) && !priv, { label: `Share ${label.toLowerCase()}`, disabled: priv })}</div>`)}
        </div>
      </div>
      ${privacyPreview(pv)}
      <p class="private">${ic('lock', { size: 's' })}<span><b>Always private, so there is no switch for them:</b> what you log by hand (water, food, mood, symptoms, a cycle), ECG readings, blood glucose and body temperature. They never appear on your profile, the leaderboard or compare.</span></p>
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
  paint();
}

/** One segmented control per unit; `data-seg` is `u-<key of me.units>`. */
export function unitRows(u = {}) {
  const one = (key, title, options, label) => html`<div class="row"><span class="row__body"><span class="row__t">${title}</span></span>${seg(`u-${key}`, options, u[key] || options[0][0], { fit: true, label })}</div>`;
  return html`${one('distance', 'Distance', [['km', 'km'], ['mi', 'mi']], 'Distance unit')}
    ${one('weight', 'Weight', [['kg', 'kg'], ['lb', 'lb']], 'Weight unit')}
    ${one('temp', 'Temperature', [['c', '°C'], ['f', '°F']], 'Temperature unit')}`;
}

/** Notifications on this browser: explains, turns on, turns off. */
export function thisDevice(pane, { getData, setData }) {
  function paint() {
    const d = getData();
    const state = push.support();
    const id = push.deviceId();
    const dev = d?.devices?.find((x) => x.id === id);
    const isOn = state === 'granted' && Boolean(dev) && dev.enabled !== false;
    let inner;
    if (state === 'native') {
      inner = html`<div class="na">${ic('bell')}<div><p class="na__t">Not from this app yet</p>
        <p class="na__d">Notifications come from the Home Screen web app. Open health.ojee.net in Safari, add it to your Home Screen, and turn them on there. Then turn on "Open in the Health iPhone app" there too, and tapping a notification brings you here.</p></div></div>`;
    } else if (state === 'needs-install') {
      inner = html`<div class="na">${ic('phone')}<div><p class="na__t">Add Health to your Home Screen first</p>
        <p class="na__d">On iPhone and iPad, notifications only work from the Home Screen app. ${platform.safari ? 'Tap Share, then Add to Home Screen' : 'Open this site in Safari, tap Share, then Add to Home Screen'}, open Health from there, and come back to this page.</p></div></div>`;
    } else if (state === 'unsupported') {
      inner = html`<div class="na">${ic('bell')}<div><p class="na__t">This browser cannot receive notifications</p><p class="na__d">Try Chrome, Edge, Firefox or Safari, or install the app on your phone.</p></div></div>`;
    } else if (state === 'denied') {
      inner = html`<div class="na">${ic('alert')}<div><p class="na__t">Notifications are blocked</p><p class="na__d">Your browser is blocking them for this site. Allow notifications for Health in your browser or system settings, then reload this page.</p></div></div>`;
    } else {
      inner = html`<div class="row row--top">
        <span class="row__body"><span class="row__t">Notifications on this device</span>
        <span class="row__d">${isOn ? `On${dev?.label ? ` as "${dev.label}"` : ''}.` : 'Off. Turn it on and your browser asks for permission once.'}</span></span>
        ${toggle('push-here', isOn, { label: 'Notifications on this device' })}
      </div>
      ${handoff.possible ? html`<div class="row row--top">
        <span class="row__body"><span class="row__t">Open in the Health iPhone app</span>
        <span class="row__d">Tapping a notification opens the Health iPhone app instead of this one, where live heart rate works. Turn on only if that app is installed.</span></span>
        ${toggle('push-handoff', handoff.on, { label: 'Open notifications in the Health iPhone app' })}
      </div>` : ''}`;
    }
    mount(pane, html`<div class="group">${inner}</div>`);
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

/* ── sections ───────────────────────────────────────────────── */

async function account(pane) {
  const me = app.me;
  const p = me.profile;
  const zones = f.listTimeZones();
  if (!zones.includes(p.tz)) zones.unshift(p.tz);
  mount(pane, html`<form class="form" id="acc-form" novalidate>
    <div class="group me-card">${avatar({ ...p, username: me.user.username }, { large: true })}
      <div><p class="h2">${p.displayName || me.user.username}</p><p class="muted small">@${me.user.username}</p>
      <a class="link small" href="/u/${encodeURIComponent(me.user.username)}">See my profile</a></div>
    </div>
    <div class="group group--pad"><div class="form">
      ${field({ label: 'Display name', name: 'displayName', value: p.displayName || '', attrs: 'required maxlength="40" autocomplete="nickname"', hint: 'What friends see on leaderboards.' })}
      ${field({ label: 'Bio (optional)', name: 'bio', value: p.bio || '', attrs: 'maxlength="200" autocomplete="off"', hint: 'One line on your profile. Up to 200 characters.' })}
      <fieldset class="field" data-style="border:0;padding:0;margin:0;min-width:0">
        <legend class="field__label" data-style="padding:0;margin-bottom:8px">Your colour</legend>
        <div class="swatches">${ACCENTS.map((c) => html`<label class="swatch"><input type="radio" name="accent" value="${c}" ${(p.accent || '').toLowerCase() === c ? 'checked' : ''} aria-label="Colour ${c}"><span class="swatch__c" data-style="--sw:${c}"></span></label>`)}</div>
        <p class="field__hint" data-style="margin-top:6px">Used for your avatar on leaderboards and your profile.</p>
      </fieldset>
      ${field({ label: 'Time zone', name: 'tz', value: p.tz, options: zones.map((z) => [z, z.replace(/_/g, ' ')]), hint: `Your days and weeks follow this. This device is in ${f.browserTz().replace(/_/g, ' ')}.` })}
    </div></div>
    <div class="btnrow"><button type="submit" class="btn">Save</button></div>
    <p class="muted small">Your username and password belong to your ojee.net account, shared with mtg and dnd. They cannot be changed from here.</p>
  </form>`);
  on(pane, 'submit', '#acc-form', async (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    fieldError(form, 'displayName', '');
    if (!v.displayName.trim()) { fieldError(form, 'displayName', 'Enter a name.'); form.elements.displayName.focus(); return; }
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.patch('/api/profile', { displayName: v.displayName.trim(), bio: v.bio.trim(), tz: v.tz, ...(v.accent ? { accent: v.accent } : {}) }));
      if (r === undefined) return;
      setMe(r); toast('Saved');
      mount(pane.querySelector('.me-card'), html`${avatar({ ...r.profile, username: r.user.username }, { large: true })}<div><p class="h2">${r.profile.displayName}</p><p class="muted small">@${r.user.username}</p><a class="link small" href="/u/${encodeURIComponent(r.user.username)}">See my profile</a></div>`);
    } catch (err) {
      if (/name/i.test(err.message)) fieldError(form, 'displayName', err.message); else toastError(err);
    }
  });
}

async function connectionsDetail(pane, ctx, part) {
  let link = null;
  const googlePane = document.createElement('div');
  const rulesPane = document.createElement('div');
  const linkPane = document.createElement('div');

  const STATE = { ok: ['Connected', 'badge--ok'], needs_auth: ['Not connected', ''], expired: ['Needs reconnecting', 'badge--bad'], unconfigured: ['Not available', 'badge--warn'] };

  /** "Add another account": for a second tracker on its own Google account. */
  function addBlock(many) {
    return html`<div class="group group--pad"><div class="stack">
      ${many ? '' : html`<p class="h3">Wear more than one tracker?</p>`}
      <p class="prose small">${many
        ? 'Add another Google account for another tracker. Each one is read on its own and put together with the rest.'
        : 'The Google Health app takes one tracker per Google account. If you wear two, say one at home and one at work, add the second tracker\'s Google account here. Both are read, and time they both recorded is counted once.'}</p>
      <div class="btnrow"><button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-account="new" data-return="/settings/connections/accounts/google">${ic('plus', { size: 's' })}Add another Google account</button></div>
    </div></div>`;
  }

  /** One account of several, with what can be done to it. */
  function accountCard(a, n) {
    const b = STATE[a.state] || ['Unknown', ''];
    const d = a.device;
    return html`<div class="group" data-acct="${a.id}">
      <div class="row">
        <span class="row__ic">${ic(d ? 'watch' : 'me')}</span>
        <span class="row__body"><span class="row__t">${accountName(a)}${a.primary ? html` <span class="badge">Main</span>` : ''}</span>
        <span class="row__d">${a.label && a.email ? `${a.email} · ` : ''}${!a.include ? 'Left out: not counted' : a.lastOk ? `Synced ${f.ago(a.lastOk)}` : a.state === 'ok' ? 'First sync running' : 'Not syncing'}</span></span>
        <span class="badge ${b[1]}">${b[0]}</span>
      </div>
      ${d ? row({ iconName: 'battery', title: d.name || 'Tracker', value: `${f.isNum(d.battery) ? `${d.battery}%` : ''}${d.lastSync ? `${f.isNum(d.battery) ? ' · ' : ''}seen ${f.ago(d.lastSync)}` : ''}` }) : ''}
      ${a.state === 'expired' ? html`<div class="row"><span class="row__body"><span class="row__d">${a.testingExpiry ? 'Google signs this app out every 7 days for now. Reconnect and it carries on.' : `The connection was removed or has expired${a.expiredAt ? ` (${f.dateTime(a.expiredAt)})` : ''}. What it brought is kept.`}</span></span></div>` : ''}
      ${a.lastError && a.state === 'ok' && a.include ? html`<div class="row"><span class="row__body"><span class="row__d">Last try: ${a.lastError.message || 'Google returned an error'}</span></span></div>` : ''}
      <div class="btnrow" data-style="padding:12px 16px">
        ${a.state === 'ok' ? '' : html`<button type="button" class="btn btn--s" data-action="connect-google" data-account="${a.id}" data-return="/settings/connections/accounts/google">${a.state === 'expired' ? 'Reconnect' : 'Connect'}</button>`}
        ${a.primary || !a.include ? '' : html`<button type="button" class="btn btn--tonal btn--s" data-action="acct-main" data-id="${a.id}">Make main</button>`}
        <button type="button" class="btn btn--tonal btn--s" data-action="acct-rename" data-id="${a.id}">Rename</button>
        ${a.include && n.included <= 1 ? '' : html`<button type="button" class="btn btn--tonal btn--s" data-action="acct-include" data-id="${a.id}" data-on="${a.include ? '0' : '1'}">${a.include ? 'Leave out' : 'Count it again'}</button>`}
        ${a.state === 'ok' || a.state === 'expired' ? html`<button type="button" class="btn btn--tonal btn--s" data-action="acct-disconnect" data-id="${a.id}">Disconnect</button>` : ''}
        <button type="button" class="btn btn--danger btn--s" data-action="acct-remove" data-id="${a.id}">Remove</button>
      </div>
    </div>`;
  }

  /** How the trackers are put together. */
  function rulesBlock(accts) {
    const r = app.me.merge || {};
    const opt = (name, value, title, text) => html`<label class="radio"><input type="radio" name="${name}" value="${value}" ${r[name.slice(2)] === value ? 'checked' : ''}><span><span class="radio__t">${title}</span><br><span class="radio__d">${text}</span></span></label>`;
    return html`<div class="stack">
      <div class="sec__head"><h2 class="h2">Putting the trackers together</h2></div>
      <div>
        <p class="h3" data-style="margin:4px 4px 8px">Steps and activity</p>
        <div class="group" role="radiogroup" aria-label="Steps and activity">
          ${opt('r-activity', 'auto', 'Automatic', 'Each quarter-hour counts the tracker that recorded more. Right whether you wear one at a time or both at once.')}
          ${opt('r-activity', 'sum', 'Add them up', 'For trackers that are never worn at the same time.')}
          ${opt('r-activity', 'max', 'The higher of the two', 'For two trackers worn together all day.')}
          ${opt('r-activity', 'primary', 'Main account only', 'The other tracker counts only on days the main one has nothing.')}
        </div>
        <p class="muted small" data-style="margin:8px 4px 0">Calories always count your resting burn once, plus the activity of both.</p>
      </div>
      <div>
        <p class="h3" data-style="margin:4px 4px 8px">Overnight readings</p>
        <div class="group" role="radiogroup" aria-label="Overnight readings">
          ${opt('r-overnight', 'auto', 'The tracker you slept in', 'Resting heart rate, HRV, blood oxygen, skin temperature and breathing rate come from the tracker that recorded the night. When both did, the longer sleep.')}
          ${accts.filter((a) => a.include).map((a) => opt('r-overnight', a.id, `Always ${accountName(a)}`, 'Taken from this account whenever it has them.'))}
        </div>
      </div>
      <div>
        <p class="h3" data-style="margin:4px 4px 8px">A workout both trackers recorded</p>
        <div class="group" role="radiogroup" aria-label="Workouts both trackers recorded">
          ${opt('r-workouts', 'merge', 'Keep one', 'Two workouts that overlap by half or more are the same one. The record with more in it (heart rate, calories) stays.')}
          ${opt('r-workouts', 'keep', 'Keep both', 'Every workout from every tracker is listed.')}
        </div>
      </div>
      <p class="muted small" data-style="margin:0 4px">Sleep that both recorded is counted once, and a night split across the two adds up. A weigh-in that reached both accounts appears once. Workouts, weigh-ins and what you log here are saved to your main account.</p>
    </div>`;
  }

  function paintGoogle() {
    const g = app.me.google || { state: 'unconfigured' };
    // On a device's page: only whether Google Health is connected, and the way to it.
    if (part.compactGoogle) {
      const b = STATE[g.state] || ['Unknown', ''];
      mount(googlePane, html`<div class="sec__head"><h2 class="h2">Google Health</h2><span class="badge ${b[1]}">${b[0]}</span></div>
        <div class="stack">
          ${g.state === 'ok' ? html`<div class="group">${row({ iconName: 'me', title: 'Account', value: g.email || 'Connected' })}${app.me.device ? row({ iconName: 'watch', title: 'Device seen', value: `${app.me.device.name}${f.isNum(app.me.device.battery) ? ` · ${app.me.device.battery}%` : ''}` }) : ''}${row({ iconName: 'refresh', title: 'Last sync', value: app.me.sync?.lastOk ? f.ago(app.me.sync.lastOk) : 'Not yet' })}</div>`
            : html`<p class="prose small">Not connected yet: nothing from the device reaches this app until it is.</p>`}
          <div class="btnrow">
            ${g.state === 'needs_auth' || g.state === 'expired' ? html`<button type="button" class="btn" data-action="connect-google" data-return="${location.pathname}">${g.state === 'expired' ? 'Reconnect Google' : 'Connect Google'}</button>` : ''}
            <a class="btn btn--tonal btn--s" href="/settings/connections/accounts/google">Manage Google Health</a>
          </div>
        </div>`);
      return;
    }
    const accts = app.me.googleAccounts || [];
    const many = accts.length > 1;
    const included = accts.filter((a) => a.include).length;
    const anyOk = accts.some((a) => a.include && a.state === 'ok');
    const badge = many ? (accts.every((a) => !a.include || a.state === 'ok') ? ['All connected', 'badge--ok'] : anyOk ? ['Needs attention', 'badge--warn'] : STATE[g.state] || ['Unknown', '']) : STATE[g.state] || ['Unknown', ''];
    const sync = app.me.sync;
    mount(googlePane, html`
      <div class="sec__head"><h2 class="h2">Google Health</h2><span class="badge ${badge[1]}">${badge[0]}</span></div>
      <div class="stack">
        ${g.state === 'unconfigured' ? banner({ tone: 'warn', title: 'Not available yet', text: 'The server has not been set up to connect to Google. Ask ojee to finish the setup.' }) : ''}
        ${many ? html`<p class="prose small">${accts.length} Google accounts, one tracker each. The main account is the one workouts, weigh-ins and logged entries are saved to.</p>
          ${accts.map((a) => accountCard(a, { included }))}` : html`
        ${g.state === 'expired' ? banner({ tone: 'bad', title: 'Google stopped sharing your data', text: g.testingExpiry ? 'Google signs this app out every 7 days for now. Reconnect and everything carries on.' : `The connection was removed or has expired${g.expiredAt ? ` (${f.dateTime(g.expiredAt)})` : ''}. Reconnect to carry on; your history is safe.` }) : ''}
        ${g.state === 'needs_auth' ? html`<p class="prose">All your numbers come from Google Health. Connect the Google account your watch or phone uses. Google shows a screen saying this app is not verified, once: choose Advanced, then continue. That is expected for a small private app.</p>` : ''}
        ${g.state === 'ok' ? html`<div class="group">
          ${row({ iconName: 'me', title: 'Account', value: g.email || 'Connected' })}
          ${row({ iconName: 'calendar', title: 'Connected', value: g.connectedAt ? f.dateFull(f.instDay(g.connectedAt)) : f.DASH })}
          ${row({ iconName: 'refresh', title: 'Last sync', value: sync?.lastOk ? f.ago(sync.lastOk) : 'Not yet' })}
          ${app.me.device ? row({ iconName: 'watch', title: 'Device', value: `${app.me.device.name}${f.isNum(app.me.device.battery) ? ` · ${app.me.device.battery}%` : ''}` }) : ''}
        </div>` : ''}
        <div class="btnrow">
          ${g.state === 'needs_auth' ? html`<button type="button" class="btn" data-action="connect-google" data-return="/settings/connections/accounts/google">Connect Google</button>` : ''}
          ${g.state === 'expired' || g.state === 'ok' ? html`<button type="button" class="btn ${g.state === 'ok' ? 'btn--tonal' : ''} btn--s" data-action="connect-google" data-return="/settings/connections/accounts/google">Reconnect</button>` : ''}
          ${g.state === 'ok' || g.state === 'expired' ? html`<button type="button" class="btn btn--danger btn--s" data-action="g-disconnect">Disconnect</button>` : ''}
        </div>`}
        ${g.state !== 'unconfigured' && (many || g.state === 'ok') ? addBlock(many) : ''}
        ${g.scopes?.length && g.state !== 'needs_auth' && g.state !== 'unconfigured' ? html`<div>
          <p class="h3" data-style="margin:4px 4px 8px">${many ? 'What your main account allowed' : 'What you allowed'}</p>
          <div class="group">${g.scopes.map((s) => html`<div class="row"><span class="row__ic">${ic(s.granted ? 'check' : 'x')}</span><span class="row__body"><span class="row__t">${s.label}</span>${s.granted ? '' : html`<span class="row__d">Not allowed</span>`}</span></div>`)}</div>
          ${g.missing?.length ? html`<p class="muted small" data-style="margin:8px 4px 0">${g.missing.join('. ')}.</p>` : ''}
        </div>` : ''}
        ${app.me.capsMeta?.missing?.length && (g.state === 'ok' || anyOk) ? html`<details class="more"><summary>${ic('right', { size: 's' })}What your ${many ? 'trackers do' : 'device does'} not report</summary><ul class="muted small" data-style="list-style:disc;padding:0 0 8px 20px;display:grid;gap:4px">${app.me.capsMeta.missing.map((m) => html`<li>${m.text}</li>`)}</ul></details>` : ''}
        <details class="more"><summary>${ic('right', { size: 's' })}Getting your device's data into Google Health</summary>${deviceTips()}</details>
      </div>`);
    mount(rulesPane, many ? rulesBlock(accts) : '');
  }

  function paintLink() {
    if (!link) { mount(linkPane, ''); return; }
    mount(linkPane, html`
      <div class="sec__head"><h2 class="h2">Console health module</h2>${link.active ? html`<span class="badge badge--ok">Linked</span>` : ''}</div>
      <div class="stack">
        <p class="prose small">Only for people who also run the health module in the ojee console. A link key lets that module and this app keep the same workouts, so answering a question in one settles it in the other.</p>
        ${link.detector ? banner({ iconName: 'wave', title: 'The module is detecting workouts', text: 'While it is linked and detecting, this app does not run its own detection.' }) : ''}
        ${link.keys?.length ? html`<div class="group">${link.keys.map((k) => html`<div class="row">
          <span class="row__ic">${ic('key')}</span>
          <span class="row__body"><span class="row__t">${k.label || 'Link key'} <span class="muted">····${k.last4}</span></span>
          <span class="row__d">Made ${f.dayShort(f.instDay(k.createdAt))} · ${k.lastSeenAt ? `last used ${f.ago(k.lastSeenAt)}` : 'never used'}</span></span>
          <button type="button" class="btn btn--danger btn--s" data-action="link-revoke" data-id="${k.id}" data-label="${k.label || 'this key'}">Revoke</button>
        </div>`)}</div>` : ''}
        <div class="btnrow"><button type="button" class="btn btn--tonal btn--s" data-action="link-create">${ic('plus', { size: 's' })}Make a link key</button></div>
      </div>`);
  }

  // One screen of Connections at a time: `part` says which blocks it has.
  const has = (k) => part.blocks.includes(k);
  mount(pane, html`<div class="stack stack--l cx-one">
    ${part.intro || ''}
    ${has('g') ? html`<div data-s="g"></div>` : ''}${has('rules') ? html`<div data-s="rules"></div>` : ''}
    ${has('apps') ? html`<div data-s="apps"></div>` : ''}${has('more') ? html`<div data-s="more"></div>` : ''}
    ${has('hr') ? html`<div data-s="hr">${liveControl()}</div>` : ''}${has('l') ? html`<div data-s="l"></div>` : ''}
    ${part.outro || ''}
  </div>`);
  if (has('hr')) ctx.onLeave(bindLive(pane.querySelector('[data-s="hr"]')));
  pane.querySelector('[data-s="g"]')?.append(googlePane);
  pane.querySelector('[data-s="rules"]')?.append(rulesPane);
  pane.querySelector('[data-s="l"]')?.append(linkPane);
  paintGoogle();
  // Hevy, Strava, the scale (web/js/apps.js).
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

  on(pane, 'click', '[data-action="g-disconnect"]', async () => {
    const yes = await confirm({ title: 'Disconnect Google?', text: 'New data stops arriving and this app loses its access at Google. Everything already here is kept. You can connect again any time.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    try { setMe(await api.post('/api/google/disconnect')); toast('Google disconnected'); paintGoogle(); more.paint(); } catch (err) { toastError(err); }
  });
  /* ── several accounts ── */
  const byId = (id) => (app.me.googleAccounts || []).find((a) => a.id === id);
  async function acct(call, okText) {
    try { await call(); await refreshMe(); paintGoogle(); more.paint(); if (okText) toast(okText); } catch (err) { toastError(err); }
  }
  on(pane, 'click', '[data-action="acct-main"]', (e, btn) => {
    const a = byId(btn.dataset.id);
    acct(() => api.patch(`/api/google/accounts/${a.id}`, { primary: true }), `${accountName(a)} is the main account now`);
  });
  on(pane, 'click', '[data-action="acct-rename"]', (e, btn) => {
    const a = byId(btn.dataset.id);
    const s = sheet({
      title: 'Name this account',
      body: html`<form class="form" id="acct-form" novalidate>${field({ label: 'Name', name: 'label', value: a.label || '', attrs: 'maxlength="30" placeholder="Work watch" autocomplete="off"', hint: a.email ? `For ${a.email}. Leave it empty to show the address.` : 'Leave it empty to show the address.' })}</form>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="acct-form">Save</button>`,
    });
    s.el.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const label = ev.target.elements.label.value.trim();
      await busy(s.el.querySelector('button[type="submit"]'), () => acct(() => api.patch(`/api/google/accounts/${a.id}`, { label }), 'Saved'));
      s.close();
    });
  });
  on(pane, 'click', '[data-action="acct-include"]', async (e, btn) => {
    const a = byId(btn.dataset.id);
    const on1 = btn.dataset.on === '1';
    if (!on1) {
      const yes = await confirm({ title: `Leave out ${accountName(a)}?`, text: 'Its numbers stop counting and it is not synced, until you count it again. Nothing is deleted.', yes: 'Leave out' });
      if (!yes) return;
    }
    acct(() => api.patch(`/api/google/accounts/${a.id}`, { include: on1 }), on1 ? `${accountName(a)} counts again` : `${accountName(a)} left out`);
  });
  on(pane, 'click', '[data-action="acct-disconnect"]', async (e, btn) => {
    const a = byId(btn.dataset.id);
    const yes = await confirm({ title: `Disconnect ${accountName(a)}?`, text: 'Its tracker stops being read and this app loses its access at Google. What it brought so far is kept. You can connect it again any time.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    acct(() => api.post(`/api/google/accounts/${a.id}/disconnect`), 'Disconnected');
  });
  on(pane, 'click', '[data-action="acct-remove"]', async (e, btn) => {
    const a = byId(btn.dataset.id);
    const yes = await confirm({ title: `Remove ${accountName(a)}?`, text: `Its access at Google is removed, and so is everything only it brought: its steps, sleep, heart rate and workouts leave your history.${a.primary ? ' Another account becomes the main one.' : ''} What your other trackers recorded stays. This cannot be undone.`, yes: 'Remove', danger: true });
    if (!yes) return;
    acct(() => api.del(`/api/google/accounts/${a.id}`), 'Account removed');
  });
  on(pane, 'change', 'input[name^="r-"]', (e, input) => {
    acct(() => api.patch('/api/google/merge', { [input.name.slice(2)]: input.value }), 'Updated. Your numbers have been worked out again.');
  });

  on(pane, 'click', '[data-action="link-create"]', async () => {
    const s = sheet({
      title: 'Make a link key',
      body: html`<form class="form" id="lk-form" novalidate>${field({ label: 'Name (optional)', name: 'label', attrs: 'maxlength="40" placeholder="HP box" autocomplete="off"', hint: 'So you can tell keys apart later.' })}</form>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="lk-form">Make key</button>`,
    });
    s.el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const label = e.target.elements.label.value.trim();
        const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/link/keys', label ? { label } : {}));
        if (r === undefined) return;
        link = r; paintLink(); s.close();
        const shown = sheet({
          title: 'Your link key',
          body: html`<div class="stack">
            ${banner({ tone: 'warn', title: 'Copy it now', text: 'This is the only time the key is shown. If you lose it, revoke it and make another.' })}
            <p class="code" data-key>${r.key}</p>
            <p class="small muted">Give the module these two settings, then restart it:</p>
            <p class="code">HEALTH_WEB_URL=${r.url || location.origin}<br>HEALTH_WEB_KEY=${r.key}</p>
          </div>`,
          foot: html`<button type="button" class="btn btn--tonal" data-copy>${ic('copy', { size: 's' })}Copy key</button><button type="button" class="btn" data-close>Done</button>`,
        });
        shown.el.querySelector('[data-copy]').addEventListener('click', () => copyText(r.key));
      } catch (err) { toastError(err); }
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
  mount(pane, html`<div class="stack"><div data-in></div>
    <p class="muted small" data-style="padding:0 4px">Changes apply straight away, including on leaderboards. <a class="link" href="/u/${encodeURIComponent(app.me.user.username)}">See my profile as others do</a></p></div>`);
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

/** The sitting nudge's own settings: hours, days, and how few steps. */
function sittingControls(sit, lim, status) {
  const days = sit.days || [];
  const min = lim.min ?? 50; const max = lim.max ?? 2000;
  const note = sittingNote(status);
  return html`<div class="pad" data-sitting>
    <div class="field--row">
      ${field({ label: 'From', name: 'sit-from', type: 'time', value: sit.from || '09:00' })}
      ${field({ label: 'Until', name: 'sit-to', type: 'time', value: sit.to || '18:00' })}
    </div>
    <div class="field" data-style="margin-top:12px">
      <span class="field__label" id="sit-days-label">Days</span>
      <div class="chips chips--week" role="group" aria-labelledby="sit-days-label">
        ${DAY_CHIPS.map(([id, label]) => html`<button type="button" class="chip" data-day="${id}" aria-pressed="${String(days.includes(id))}">${label}</button>`)}
      </div>
    </div>
    <div data-style="margin-top:12px">${field({ label: 'Nudge under this many steps in an hour', name: 'sit-threshold', type: 'number', value: sit.threshold ?? 250, hint: `From ${f.int(min)} to ${f.int(max)}. It needs step data from the last 20 minutes, so a nudge can come late or not at all.`, attrs: `min="${min}" max="${max}" step="${lim.step ?? 50}" inputmode="numeric"` })}</div>
    ${note ? html`<p class="muted small" data-style="margin-top:12px">${note}</p>` : ''}
  </div>`;
}

async function notifications(pane) {
  let d = null;
  mount(pane, skeleton('list'));
  try { d = await api.get('/api/push'); } catch (err) { mount(pane, errorState(err)); on(pane, 'click', '[data-action="retry"]', () => go('/settings/notifications', { replace: true })); return; }

  mount(pane, html`<div class="stack stack--l"><div data-here></div><div data-rest></div></div>`);
  const here = pane.querySelector('[data-here]');
  const rest = pane.querySelector('[data-rest]');
  let paintHere = () => {};

  function paint() {
    const p = d.prefs || {};
    const quiet = p.quiet;
    const myId = push.deviceId();
    mount(rest, html`<div class="stack stack--l">
      <section>
        <div class="sec__head"><h2 class="h2">What to tell you about</h2></div>
        <div class="group">${(d.types || []).map((t) => {
          // A type this person's device cannot carry: shown, switched off, and why.
          const cannot = t.available === false;
          const isOn = !cannot && (p.types?.[t.id] ?? t.default);
          return html`<div class="row row--top"><span class="row__body"><span class="row__t">${t.label}</span><span class="row__d">${t.description}</span>${cannot && t.reason ? html`<span class="row__d row__d--why">${t.reason}.</span>` : ''}</span>${toggle(`type-${t.id}`, isOn, { label: t.label, disabled: cannot })}</div>
          ${t.id === 'sitting' && isOn ? sittingControls(p.sitting || {}, d.limits?.sitting?.threshold || {}, d.status?.sitting) : ''}`;
        })}</div>
        ${app.me.link?.detector ? html`<p class="muted small" data-style="margin:8px 4px 0">Workout questions come from your console module while it is linked.</p>` : ''}
      </section>
      <section>
        <div class="sec__head"><h2 class="h2">Timing</h2></div>
        <div class="group">
          <div class="row row--top"><span class="row__body"><span class="row__t">Quiet hours</span><span class="row__d">Nothing is sent between these times. It still shows inside the app.</span></span>${toggle('quiet-on', Boolean(quiet), { label: 'Quiet hours' })}</div>
          ${quiet ? html`<div class="pad"><div class="field--row">
            ${field({ label: 'From', name: 'quiet-from', type: 'time', value: quiet.from })}
            ${field({ label: 'Until', name: 'quiet-to', type: 'time', value: quiet.to })}
          </div></div>` : ''}
          <div class="pad"><div class="field--row">
            ${field({ label: 'Morning readiness at', name: 'morningAt', type: 'time', value: p.morningAt || '07:30' })}
            ${field({ label: 'Weekly summary time', name: 'weekly-time', type: 'time', value: p.weeklyAt?.time || '18:00' })}
          </div>
          <div data-style="margin-top:12px">${field({ label: 'Weekly summary day', name: 'weekly-day', value: p.weeklyAt?.day || 'sun', options: DAYS })}</div></div>
        </div>
      </section>
      <section>
        <div class="sec__head"><h2 class="h2">Devices</h2><span class="sec__note">${f.plural((d.devices || []).length, 'device')}</span></div>
        ${(d.devices || []).length ? html`<div class="group">${d.devices.map((dev) => html`<div class="row row--top">
          <span class="row__ic">${ic(/phone|android/i.test(dev.label || '') ? 'phone' : 'screen')}</span>
          <span class="row__body"><span class="row__t">${dev.label || 'Device'}${dev.id === myId ? html` <span class="badge badge--accent">This device</span>` : ''}</span>
          <span class="row__d">${dev.lastError ? `Last try failed: ${dev.lastError}` : dev.lastOkAt ? `Last reached ${f.ago(dev.lastOkAt)}` : `Added ${f.dayShort(f.instDay(dev.createdAt))}`}${dev.enabled === false ? ' · paused' : ''}</span>
          <span class="btnrow" data-style="margin-top:8px">
            <button type="button" class="btn btn--tonal btn--s" data-action="dev-toggle" data-id="${dev.id}" data-on="${dev.enabled !== false}">${dev.enabled === false ? 'Resume' : 'Pause'}</button>
            <button type="button" class="btn btn--tonal btn--s" data-action="dev-test" data-id="${dev.id}">Send a test</button>
            <button type="button" class="btn btn--danger btn--s" data-action="dev-remove" data-id="${dev.id}" data-label="${dev.label || 'this device'}">Remove</button>
          </span></span>
        </div>`)}</div>
        <div class="btnrow" data-style="margin-top:12px"><button type="button" class="btn btn--tonal btn--s" data-action="test-all">${ic('bell', { size: 's' })}Send a test to every device</button></div>`
        : html`<div class="group">${empty({ inline: true, title: 'No devices yet', text: 'Turn on notifications on this device above. Do the same on any other phone or computer you want them on.' })}</div>`}
      </section>
    </div>`);
  }

  const take = (r) => { if (r && r.prefs) { d = r; paint(); paintHere(); } };
  paintHere = thisDevice(here, { getData: () => d, setData: take });
  paint();

  const savePrefs = async (body) => {
    try { take(await api.put('/api/push/prefs', body)); } catch (err) {
      toastError(err); paint();
      // Refused because the device cannot carry it: the switches now say so.
      if (err.status === 409) api.get('/api/push').then(take).catch(() => {});
    }
  };
  const tell = (text) => { toast(text, { tone: 'bad' }); paint(); };
  on(rest, 'change', 'input[name="sit-from"], input[name="sit-to"]', () => {
    const from = rest.querySelector('[name="sit-from"]').value; const to = rest.querySelector('[name="sit-to"]').value;
    if (!from || !to) return;
    if (from >= to) { tell('Until has to be later than From.'); return; }
    savePrefs({ sitting: { from, to } });
  });
  on(rest, 'click', '[data-day]', (e, btn) => {
    const days = [...rest.querySelectorAll('[data-day]')].filter((b) => (b === btn ? b.getAttribute('aria-pressed') !== 'true' : b.getAttribute('aria-pressed') === 'true')).map((b) => b.dataset.day);
    if (!days.length) { tell('Keep at least one day.'); return; }
    savePrefs({ sitting: { days } });
  });
  on(rest, 'change', 'input[name="sit-threshold"]', (e, input) => {
    const n = Number(input.value); const lim = d.limits?.sitting?.threshold || {};
    const min = lim.min ?? 50; const max = lim.max ?? 2000;
    if (!Number.isInteger(n) || n < min || n > max) { tell(`Choose a whole number from ${f.int(min)} to ${f.int(max)}.`); return; }
    savePrefs({ sitting: { threshold: n } });
  });
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
  on(rest, 'click', '[data-action="dev-toggle"]', async (e, btn) => {
    try { take(await busy(btn, () => api.patch(`/api/push/devices/${encodeURIComponent(btn.dataset.id)}`, { enabled: btn.dataset.on !== 'true' }))); } catch (err) { toastError(err); }
  });
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
  on(rest, 'click', '[data-action="dev-test"]', (e, btn) => test(btn, { deviceId: btn.dataset.id }));
  on(rest, 'click', '[data-action="test-all"]', (e, btn) => test(btn, {}));
  on(rest, 'click', '[data-action="dev-remove"]', async (e, btn) => {
    const mine = btn.dataset.id === push.deviceId();
    const yes = await confirm({ title: `Remove ${btn.dataset.label}?`, text: mine ? 'Notifications stop on this device. You can turn them on again here.' : 'Notifications stop on that device. Turn them on again from that device.', yes: 'Remove', danger: true });
    if (!yes) return;
    try {
      if (mine) { const r = await push.disable(); take(r || await api.get('/api/push')); }
      else take(await api.del(`/api/push/devices/${encodeURIComponent(btn.dataset.id)}`));
      toast('Device removed'); refreshMe().catch(() => {});
    } catch (err) { toastError(err); }
  });
}

async function goals(pane) {
  function paint() {
    const g = app.me.goals || {};
    const u = app.me.units || {};
    const sm = g.sleepMinutes || 450;
    const water = groupOf('nutrition')?.mode && groupOf('nutrition').mode !== 'off';
    mount(pane, html`<form class="form" id="goal-form" novalidate>
      <section>
        <div class="sec__head"><h2 class="h2">Daily goals</h2></div>
        <div class="group group--pad"><div class="form">
          ${field({ label: 'Steps', name: 'steps', type: 'number', value: g.steps ?? 8000, attrs: 'inputmode="numeric" min="1000" max="50000" step="500" required', hint: '1,000 to 50,000 a day.' })}
          ${field({ label: 'Active minutes', name: 'activeMinutes', type: 'number', value: g.activeMinutes ?? 22, attrs: 'inputmode="numeric" min="5" max="240" step="1" required', hint: '5 to 240 a day. 22 a day is the usual health guideline of 150 a week.' })}
          <div class="field">
            <span class="field__label" id="sl-l">Sleep</span>
            <div class="field--row" role="group" aria-labelledby="sl-l">
              <select class="select" name="sleepH" aria-label="Hours">${[4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => html`<option value="${h}" ${Math.floor(sm / 60) === h ? 'selected' : ''}>${h} hours</option>`)}</select>
              <select class="select" name="sleepM" aria-label="Minutes">${[0, 15, 30, 45].map((m) => html`<option value="${m}" ${Math.round((sm % 60) / 15) * 15 === m ? 'selected' : ''}>${m} minutes</option>`)}</select>
            </div>
            <p class="field__hint">4 to 12 hours a night.</p>
            <div data-err="sleepH"></div>
          </div>
          ${water ? field({ label: 'Water (ml)', name: 'waterMl', type: 'number', value: g.waterMl ?? 2000, attrs: 'inputmode="numeric" min="500" max="6000" step="50" required', hint: '500 to 6,000 ml a day, counted from what you log here.' }) : ''}
        </div></div>
      </section>
      <section>
        <div class="sec__head"><h2 class="h2">Weekly target</h2></div>
        <div class="group group--pad"><div class="form">
          ${field({ label: 'Cardio minutes a week', name: 'cardioWeek', type: 'number', value: g.cardioWeek ?? 150, attrs: 'inputmode="numeric" min="30" max="600" step="5" required', hint: '30 to 600 minutes, Monday to Sunday. 150 is the usual health guideline. The count is calculated by this app from your zone or active minutes.' })}
        </div></div>
      </section>
      <section>
        <div class="sec__head"><h2 class="h2">Units</h2></div>
        <div class="group">
          ${unitRows(u)}
        </div>
      </section>
      <div class="btnrow"><button type="submit" class="btn">Save goals</button></div>
    </form>`);
  }
  on(pane, 'click', '[data-seg^="u-"]', async (e, b) => {
    try { setMe(await api.patch('/api/settings', { units: { [b.dataset.seg.slice(2)]: b.dataset.value } })); toast('Units updated'); paint(); } catch (err) { toastError(err); }
  });
  on(pane, 'submit', '#goal-form', async (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    let bad = false;
    const chk = (name, lo, hi, msg) => { fieldError(form, name, ''); if (!f.isNum(v[name]) || v[name] < lo || v[name] > hi) { fieldError(form, name, msg); bad = true; } };
    chk('steps', 1000, 50000, 'Between 1,000 and 50,000.');
    chk('activeMinutes', 5, 240, 'Between 5 and 240.');
    chk('cardioWeek', 30, 600, 'Between 30 and 600.');
    const hasWater = Boolean(form.elements.waterMl);
    if (hasWater) chk('waterMl', 500, 6000, 'Between 500 and 6,000.');
    const sleepMinutes = Number(v.sleepH) * 60 + Number(v.sleepM);
    fieldError(form, 'sleepH', '');
    if (sleepMinutes < 240 || sleepMinutes > 720) { fieldError(form, 'sleepH', 'Between 4 and 12 hours.'); bad = true; }
    if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.patch('/api/settings', { goals: { steps: Math.round(v.steps), activeMinutes: Math.round(v.activeMinutes), sleepMinutes, cardioWeek: Math.round(v.cardioWeek), ...(hasWater ? { waterMl: Math.round(v.waterMl) } : {}) } }));
      if (r === undefined) return;
      setMe(r); toast('Goals saved'); paint();
    } catch (err) {
      const hit = ['steps', 'activeMinutes', 'cardioWeek', 'waterMl'].find((k) => (err.message || '').includes(`goals.${k}`));
      if (hit && form.elements[hit]) fieldError(form, hit, err.message); else toastError(err);
    }
  });
  paint();
}

async function data(pane) {
  const username = app.me.user.username;
  mount(pane, html`<div class="stack stack--l">
    <section>
      <div class="sec__head"><h2 class="h2">Export</h2></div>
      <div class="group group--pad"><div class="stack">
        <p class="prose small">Everything this app holds about you, in two formats: JSON with the whole set (profile and settings, every daily number, sleep, weight, workouts with sets), or CSV of the daily table for a spreadsheet. No passwords, tokens or keys.</p>
        <div class="btnrow">${platform.native
    ? html`<button type="button" class="btn btn--tonal btn--s" data-action="export">${ic('download', { size: 's' })}Download JSON</button>`
    : html`<a class="btn btn--tonal btn--s" href="/api/export" download data-native>${ic('download', { size: 's' })}Download JSON</a>`}
          <a class="btn btn--tonal btn--s" href="/api/export?format=csv" download>${ic('download', { size: 's' })}Download CSV</a></div>
      </div></div>
    </section>
    <section>
      <div class="sec__head"><h2 class="h2">Delete my health data</h2></div>
      <div class="group group--pad"><div class="stack">
        <p class="prose small">Removes everything here: your history, workouts, profile, leaderboard entries, notification devices, link keys and saved key. This app's access at Google is revoked. What is in Google Health itself is not touched.</p>
        <p class="prose small">Your ojee.net account stays, because mtg and dnd use it. You stay signed in and can start again from empty.</p>
        <div class="btnrow"><button type="button" class="btn btn--danger btn--s" data-action="delete-data">Delete my health data</button></div>
      </div></div>
    </section>
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
      title: 'Delete all your health data?',
      body: html`<form class="form" id="del-form" novalidate>
        ${banner({ tone: 'bad', title: 'This cannot be undone', text: 'Consider downloading your data first.' })}
        ${field({ label: `Type your username (${username}) to confirm`, name: 'confirm', attrs: 'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required' })}
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
  const G = { ok: ['Connected', 'badge--ok'], needs_auth: ['No Google', ''], expired: ['Expired', 'badge--bad'] };
  function paint() {
    const sv = d.server || {};
    mount(pane, html`<div class="stack stack--l">
      <div class="group"><div class="row row--top">
        <span class="row__body"><span class="row__t">Registration is ${d.registrationOpen ? 'open' : 'closed'}</span>
        <span class="row__d">${d.registrationOpen ? 'Anyone can make an account here and start a health profile.' : 'No new accounts or health profiles. People already here carry on as before.'}</span></span>
        ${toggle('reg-open', d.registrationOpen, { label: 'Registration open' })}
      </div></div>
      <section>
        <div class="sec__head"><h2 class="h2">People</h2><span class="sec__note">${f.int((d.people || []).length)}</span></div>
        <div class="group">${(d.people || []).map((p) => {
          const g = G[p.google] || [p.google || 'Unknown', ''];
          const flags = [p.private ? 'private' : null, p.detection ? 'detection on' : null, p.pushDevices ? f.plural(p.pushDevices, 'device') : null, p.linkKeys ? 'linked' : null, p.aiKey ? 'AI key' : null].filter(Boolean);
          return html`<div class="row row--top">
            ${avatar(p)}
            <span class="row__body"><span class="row__t">${p.displayName || p.username} <span class="muted">@${p.username}</span></span>
            <span class="row__d">Seen ${f.ago(p.lastSeenAt)} · synced ${p.lastSyncAt ? f.ago(p.lastSyncAt) : 'never'}${flags.length ? ` · ${flags.join(', ')}` : ''}</span>
            ${p.syncError ? html`<span class="row__d" data-style="color:var(--bad)">${typeof p.syncError === 'string' ? p.syncError : (p.syncError.message || p.syncError.code || 'Sync error')}</span>` : ''}</span>
            <span class="badge ${g[1]}">${g[0]}</span>
          </div>`;
        })}</div>
        <p class="muted small" data-style="margin:8px 4px 0">No health data is shown here, only whether things are working.</p>
      </section>
      <section>
        <div class="sec__head"><h2 class="h2">Server</h2></div>
        <div class="group">
          ${row({ title: 'Version', value: `${sv.version || ''}${sv.demo ? ' (demo)' : ''}` })}
          ${row({ title: 'Running for', value: f.isNum(sv.uptimeS) ? f.dur(sv.uptimeS / 60) : f.DASH })}
          ${row({ title: 'Memory', value: f.isNum(sv.memoryMb) ? `${f.int(sv.memoryMb)} MB` : f.DASH })}
          ${row({ title: 'Syncs', value: sv.scheduler ? `${f.int(sv.scheduler.runs)} run, ${f.int(sv.scheduler.failures)} failed` : f.DASH })}
          ${row({ title: 'Google sign-in', value: sv.google?.configured ? 'Set up' : 'Not set up' })}
          ${row({ title: 'Notifications', value: sv.push?.configured ? 'Set up' : 'Not set up' })}
          ${row({ title: 'Accounts database', value: sv.mongo?.ok ? 'Reachable' : 'Not reachable' })}
        </div>
      </section>
    </div>`);
  }
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
    mount(pane, err.status === 403 ? html`<div class="group">${empty({ iconName: 'lock', title: 'Admins only', text: 'This page is for the people who run the site.' })}</div>` : errorState(err));
  }
}

/* ── Connections: a hub, then devices and accounts ─────────────────── */

/** Every screen of Connections: its address, title, parent, and what it shows. */
const TRACKERS = [
  ['fitbit', 'Fitbit', 'watch', 'Saves to Google Health by itself'],
  ['pixel', 'Pixel Watch', 'watch', 'Saves to Google Health by itself'],
  ['apple', 'Apple Watch', 'watch', 'Through Apple Health and the Google Health app'],
  ['samsung', 'Samsung Galaxy Watch', 'watch', 'Through Health Connect'],
  ['garmin', 'Garmin', 'watch', 'Through Health Connect'],
  ['other', 'Xiaomi, Amazfit, Huawei and others', 'watch', 'Through Health Connect or Apple Health'],
  ['phone', 'Just a phone', 'phone', 'Steps and distance'],
];
const SCALES = [
  ['xiaomi', 'Xiaomi Body Composition Scale S400', 'scale', 'Connects here directly, with full body composition'],
  ['other', 'Withings, Renpho, Eufy, Garmin and others', 'scale', 'Through Health Connect or Apple Health'],
];
const HOW = {
  fitbit: html`<p>Nothing to set up on the watch: Fitbit already saves everything to Google Health. Connect the same Google account the Fitbit app uses, below.</p>`,
  pixel: html`<p>Nothing to set up on the watch: the Pixel Watch already saves everything to Google Health. Connect the same Google account the watch uses, below.</p>`,
  apple: html`<ol><li>Install the Google Health app on your iPhone and sign in with the Google account you connect here.</li><li>When it asks, allow it to read from Apple Health: steps, heart rate, sleep, workouts, weight.</li><li>Leave background refresh on, so it keeps copying.</li></ol>`,
  samsung: html`<ol><li>In Samsung Health, Settings, turn on Health Connect and allow it to write.</li><li>In the Google Health app, allow it to read from Health Connect.</li><li>Connect that Google account below.</li></ol><p>Samsung passes on most things; sleep stages and HRV can be missing.</p>`,
  garmin: html`<ol><li>In Garmin Connect, open Settings, Connected apps, Health Connect, and turn it on.</li><li>In the Google Health app, allow it to read from Health Connect.</li><li>Connect that Google account below.</li></ol><p>Garmin sends workouts, steps, heart rate and sleep; not HRV or blood oxygen. Runs and rides with a route come in better through Strava (Accounts, Strava).</p>`,
  other: html`<ol><li>In the watch's own app (Mi Fitness, Zepp, Huawei Health), turn on syncing to Health Connect on Android, or to Apple Health on iPhone.</li><li>Let the Google Health app read from it.</li><li>Connect that Google account below.</li></ol><p>What arrives depends on the watch; this app tells you what is missing.</p>`,
  phone: html`<p>Steps and distance still work. On Android, Google Health counts them by itself. On iPhone, install Google Health and let it read steps from Apple Health. Heart rate and sleep need something on your wrist.</p>`,
  scaleOther: html`<ol><li>Let the scale's app write weight and body fat to Health Connect (Android) or Apple Health (iPhone).</li><li>Let the Google Health app read them.</li><li>They arrive with your other weigh-ins. Muscle, water and the rest stay in the scale's app: only a Xiaomi S400 sends those here.</li></ol>`,
};
function cxPart(sub, item, brand) {
  const T = (k, list) => list.find((x) => x[0] === k);
  if (!sub) return { title: 'Connections', hub: 'root' };
  if (sub === 'devices' && !item) return { title: 'Devices', back: '/settings/connections', hub: 'devices' };
  if (sub === 'accounts' && !item) return { title: 'Accounts', back: '/settings/connections', hub: 'accounts' };
  if (sub === 'extra' && !item) return { title: 'Logging and extra readings', back: '/settings/connections', blocks: ['more'] };
  if (sub === 'devices' && item === 'tracker' && !brand) return { title: 'Fitness tracker or watch', back: '/settings/connections/devices', hub: 'tracker' };
  if (sub === 'devices' && item === 'tracker' && T(brand, TRACKERS)) return { title: T(brand, TRACKERS)[1], back: '/settings/connections/devices/tracker', blocks: ['g'], intro: html`<div class="group group--pad"><div class="stack"><p class="h3">How it gets here</p><div class="prose small cx-how">${HOW[brand]}</div></div></div>`, compactGoogle: true };
  if (sub === 'devices' && item === 'scale' && !brand) return { title: 'Smart scale', back: '/settings/connections/devices', hub: 'scale' };
  if (sub === 'devices' && item === 'scale' && brand === 'xiaomi') return { title: 'Xiaomi S400', back: '/settings/connections/devices/scale', blocks: ['apps'], only: 'scale' };
  if (sub === 'devices' && item === 'scale' && brand === 'other') return { title: 'Other scales', back: '/settings/connections/devices/scale', blocks: ['g'], compactGoogle: true, intro: html`<div class="group group--pad"><div class="stack"><p class="h3">How it gets here</p><div class="prose small cx-how">${HOW.scaleOther}</div></div></div>` };
  if (sub === 'devices' && item === 'hr' && !brand) return { title: 'Heart-rate sensor', back: '/settings/connections/devices', blocks: ['hr'], intro: html`<p class="prose small">A Bluetooth chest strap or armband (Polar, Garmin HRM, Wahoo, Coospo and the rest: they all speak the same standard) shows your heart rate live on the workout you are doing, beat by beat. Pair it here, in a browser that has Bluetooth (Chrome on Android or a computer).</p>` };
  if (sub === 'accounts' && !brand) {
    const A = { google: { title: 'Google Health', blocks: ['g', 'rules'] }, hevy: { title: 'Hevy', blocks: ['apps'], only: 'hevy' }, strava: { title: 'Strava', blocks: ['apps'], only: 'strava' }, console: { title: 'Console health module', blocks: ['l'] } };
    if (A[item]) return { ...A[item], back: '/settings/connections/accounts' };
  }
  return null;
}

/** Which brand of TRACKERS a device name Google reports is. */
const seenBrand = (name) => { const n = String(name || '').toLowerCase(); return !n ? null : /pixel/.test(n) ? 'pixel' : /fitbit|charge|versa|sense|inspire|luxe|air/.test(n) ? 'fitbit' : /apple|iphone/.test(n) ? 'apple' : /galaxy|samsung/.test(n) ? 'samsung' : /garmin|forerunner|fenix|venu|vivo/.test(n) ? 'garmin' : 'other'; };

const tile = (href, iconName, title, text, value = '') => html`<a class="cx-tile" href="${href}"><span class="cx-tile__ic">${ic(iconName)}</span><span><span class="cx-tile__t">${title}</span><br><span class="cx-tile__d">${text}</span></span><span>${value}${ic('right', { size: 's' })}</span></a>`;

async function connectionsHub(pane, part) {
  const me = app.me;
  const g = me.google?.state;
  const gBadge = g === 'ok' ? html`<span class="badge badge--ok">On</span>` : g === 'expired' ? html`<span class="badge badge--bad">Reconnect</span>` : g === 'needs_auth' ? html`<span class="badge badge--accent">Connect</span>` : '';
  const on1 = (x) => (x ? html`<span class="badge badge--ok">On</span>` : '');
  if (part.hub === 'root') {
    const accounts = [me.google?.state === 'ok' && 'Google Health', me.hevy?.connected && 'Hevy', me.strava?.connected && 'Strava'].filter(Boolean);
    mount(pane, html`<div class="stack stack--l">
      <p class="prose small">Where your numbers come from. Devices are what you wear or stand on; accounts are the apps this one reads from and writes to.</p>
      <div class="cx-hub">
        ${tile('/settings/connections/devices', 'devices', 'Devices', `Watch or tracker, scale, heart-rate sensor${me.device?.name ? `. ${me.device.name}` : ''}${me.xiaomi?.connected ? ', Xiaomi scale' : ''}`)}
        ${tile('/settings/connections/accounts', 'account', 'Accounts', accounts.length ? `${accounts.join(', ')} connected` : 'Google Health, Hevy, Strava', g === 'expired' ? html`<span class="badge badge--bad">Reconnect</span>` : '')}
        ${tile('/settings/connections/extra', 'log', 'Logging and extra readings', 'Water and food, mood, symptoms, cycle, ECG: what you log here and where it goes')}
      </div>
    </div>`);
  } else if (part.hub === 'devices') {
    mount(pane, html`<div class="stack stack--l"><div class="cx-hub">
      ${tile('/settings/connections/devices/tracker', 'watch', 'Fitness tracker or watch', me.device?.name ? `${me.device.name}${f.isNum(me.device.battery) ? `, ${me.device.battery}%` : ''}` : 'Fitbit, Pixel, Apple, Samsung, Garmin and more', gBadge)}
      ${tile('/settings/connections/devices/scale', 'scale', 'Smart scale', me.xiaomi?.connected ? 'Xiaomi S400 connected' : 'Xiaomi S400, or any scale that writes to Health Connect or Apple Health', on1(me.xiaomi?.connected))}
      ${tile('/settings/connections/devices/hr', 'heart', 'Heart-rate sensor', 'A Bluetooth chest strap or armband, live during a workout')}
    </div></div>`);
  } else if (part.hub === 'accounts') {
    mount(pane, html`<div class="stack stack--l"><div class="cx-hub">
      ${tile('/settings/connections/accounts/google', 'globe', 'Google Health', 'Where everything from your devices comes from, and where what you log goes', gBadge)}
      ${tile('/settings/connections/accounts/hevy', 'strength', 'Hevy', 'Workouts, sets, routines and measurements, both ways', on1(me.hevy?.connected))}
      ${tile('/settings/connections/accounts/strava', 'route', 'Strava', 'Runs, rides and walks with their routes', on1(me.strava?.connected))}
      ${tile('/settings/connections/accounts/console', 'key', 'Console health module', 'Only with the ojee console')}
    </div></div>`);
  } else {
    const list = part.hub === 'tracker' ? TRACKERS : SCALES;
    mount(pane, html`<div class="stack stack--l">
      <p class="prose small">${part.hub === 'tracker' ? 'Which do you wear? Everything from a watch or tracker reaches this app through Google Health; each one gets there its own way.' : 'Which scale? A Xiaomi S400 connects here directly; any other reaches this app through Google Health.'}</p>
      <div class="group">${list.map(([id, name, icon, text]) => html`<a class="row" href="/settings/connections/devices/${part.hub}/${id}"><span class="row__ic">${ic(icon)}</span><span class="row__body"><span class="row__t">${name}</span><span class="row__d">${text}</span></span>${(id === 'xiaomi' && me.xiaomi?.connected) || (part.hub === 'tracker' && seenBrand(me.device?.name) === id) ? html`<span class="badge badge--ok">${id === 'xiaomi' ? 'On' : 'Yours'}</span>` : ''}<span class="row__chev">${ic('right', { size: 's' })}</span></a>`)}</div>
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

/* ── the page ───────────────────────────────────────────────── */

function navList(active) {
  const me = app.me;
  const g = me.google?.state;
  const values = {
    connections: g === 'ok' ? 'Connected' : g === 'expired' ? html`<span class="badge badge--bad">Reconnect</span>` : g === 'needs_auth' ? html`<span class="badge badge--accent">Connect</span>` : '',
    privacy: me.privacy?.account === 'private' ? 'Private' : 'Public',
    notifications: me.push?.devices ? f.plural(me.push.devices, 'device') : 'Off',
  };
  return html`<nav class="group" aria-label="Settings">
    ${SECTIONS.filter(([id]) => id !== 'admin' || me.user.admin).map(([id, label, icon, fam]) => html`<a class="row row--badge fam fam-${fam}" href="/settings/${id}" ${raw(active === id ? 'aria-current="page"' : '')}>
      <span class="row__ic">${ic(icon)}</span><span class="row__body"><span class="row__t">${label}</span></span>
      ${values[id] ? html`<span class="row__v">${values[id]}</span>` : ''}<span class="row__chev">${ic('right', { size: 's' })}</span></a>`)}
  </nav>`;
}

function appBlock() {
  const theme = window.healthTheme?.get() || 'system';
  const inst = install.state();
  return html`
    <div class="group">
      <div class="row row--wrap"><span class="row__ic">${ic('sun')}</span><span class="row__body"><span class="row__t">Theme</span></span>${seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], theme, { fit: true, label: 'Theme' })}</div>
      ${inst === 'prompt' ? row({ action: 'install', iconName: 'addbox', title: 'Install the app', text: 'Put Health on your home screen', chevron: true }) : ''}
      ${inst === 'ios' ? row({ iconName: 'addbox', title: 'Add to Home Screen', text: 'In Safari: tap Share, then Add to Home Screen' }) : ''}
    </div>
    <div class="group">
      ${row({ action: 'check-update', iconName: 'refresh', title: 'Check for updates', text: `Version ${app.me.version || ''}${app.build ? `, build ${app.build}` : ''}` })}
    </div>
    <div class="group">
      ${row({ action: 'signout', iconName: 'logout', title: 'Sign out', text: 'Also signs you out of mtg and dnd' })}
    </div>
    <p class="muted small" data-style="padding:0 4px">Health ${app.me.version || ''}${app.me.demo ? ' · demo mode, nothing here is real' : ''} · made for ojee and friends</p>`;
}

export default async function settings(ctx) {
  const { root } = ctx;
  const me = app.me;
  let section = ctx.params.section || '';
  if (section && (!RENDER[section] || (section === 'admin' && !me.user.admin))) { go('/settings', { replace: true }); return; }
  const isWide = wide();
  const shown = section || (isWide ? 'account' : '');
  const cx = section === 'connections' && ctx.params.sub ? cxPart(ctx.params.sub, ctx.params.item || '', ctx.params.brand || '') : null;
  const title = cx?.title || (shown ? SECTIONS.find(([id]) => id === shown)[1] : 'Me');
  document.title = `${section ? title : 'Me'} · Health`;

  const card = html`<a class="group me-card" href="/u/${encodeURIComponent(me.user.username)}">
    ${avatar({ ...me.profile, username: me.user.username }, { large: true })}
    <span class="row__body"><span class="h2">${me.profile.displayName || me.user.username}</span><br><span class="muted small">@${me.user.username} · see my profile</span></span>
    <span class="row__chev">${ic('right', { size: 's' })}</span>
  </a>`;

  if (isWide) {
    mount(root, html`${head({ title: 'Me' })}
      <div class="settings">
        <div class="settings__nav stack">${card}${navList(shown)}${appBlock()}</div>
        <div>${cx?.back ? html`<a class="cx-back link small" href="${cx.back}">${ic('left', { size: 's' })}Back</a>` : ''}<h2 class="head__title" data-style="font-size:1.375rem;margin:4px 4px 16px" tabindex="-1">${title}</h2><div data-pane></div></div>
      </div>`);
  } else if (!section) {
    mount(root, html`${head({ title: 'Me' })}<div class="stack">${card}${navList('')}${appBlock()}</div>`);
  } else {
    mount(root, html`${head({ title, back: cx?.back || '/settings' })}<div data-pane></div>`);
  }

  on(root, 'click', '[data-seg="theme"]', (e, b) => {
    window.healthTheme?.set(b.dataset.value);
    root.querySelectorAll('[data-seg="theme"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
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
