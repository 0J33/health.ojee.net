/* Me: account, connections, privacy, notifications, goals and units, data,
   admin, theme, sign out, about. A list on phones; a list beside the open
   section on wide screens. */

import { api } from '../api.js';
import { app, setMe, refreshMe, go, listen } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, empty, banner, on, seg, sheet, confirm, field, formValues, fieldError, busy, toast, toastError, toggle, row, copyText, errText } from '../ui.js';
import { push, install, platform } from '../pwa.js';
import * as f from '../format.js';
import { avatar } from './shared.js';

const SECTIONS = [
  ['account', 'Account', 'me'],
  ['connections', 'Connections', 'link'],
  ['privacy', 'Privacy', 'shield'],
  ['notifications', 'Notifications', 'bell'],
  ['goals', 'Goals and units', 'flag'],
  ['data', 'Your data', 'data'],
  ['admin', 'Admin', 'admin'],
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

/** AI summaries need no setup; the person's own OpenCode key is optional: explain, save, test, remove. */
export function aiKeyBlock(pane, { changed } = {}) {
  function paint(note = '') {
    const ai = app.me.ai || {};
    mount(pane, html`<div class="stack">
      <p class="prose small">Summaries are written by free OpenCode models. There is nothing to set up. Adding your own OpenCode Zen key is optional; when you have one saved, it is used first.</p>
      <div class="group group--pad"><div class="form">
        <div class="row" data-style="padding:0;min-height:0">
          <span class="row__body"><span class="row__t">Your own OpenCode Zen key</span><span class="row__d">${ai.keySet ? `Saved, ending in ${ai.last4 || '····'}. Used first.` : 'Not added. Summaries use the free models.'}</span></span>
          <span class="badge ${ai.keySet ? 'badge--ok' : ''}">${ai.keySet ? 'Set' : 'Optional'}</span>
        </div>
        <form id="ai-form" class="form" novalidate>
          ${field({ label: ai.keySet ? 'Replace the key' : 'Paste your own key (optional)', name: 'key', type: 'password', attrs: 'autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="sk-..."' })}
          <div data-slot="note">${note}</div>
          <div class="btnrow">
            <button type="submit" class="btn btn--s">Save key</button>
            <button type="button" class="btn btn--tonal btn--s" data-action="ai-test">Test</button>
            ${ai.keySet ? html`<button type="button" class="btn btn--danger btn--s" data-action="ai-remove">Remove</button>` : ''}
          </div>
        </form>
      </div></div>
      <details class="more"><summary>${ic('right', { size: 's' })}How to get your own key</summary>
        <ol class="howto" data-style="margin:8px 0 4px">
          <li><span>Go to <b>opencode.ai</b> and sign in (it is free to make an account).</span></li>
          <li><span>Open <b>Zen</b>, then <b>API keys</b>, and create one.</span></li>
          <li><span>Copy it and paste it here. Only the free models are used, so it does not cost anything.</span></li>
        </ol>
        <p class="muted small">The key is stored encrypted and is never shown again. You do not need one: without it, summaries are still written by the free models.</p>
      </details>
    </div>`);
  }
  on(pane, 'submit', '#ai-form', async (e, form) => {
    e.preventDefault();
    const key = form.elements.key.value.trim();
    fieldError(form, 'key', '');
    if (!key) { fieldError(form, 'key', 'Paste the key first.'); return; }
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.put('/api/ai/key', { key }));
      if (r === undefined) return;
      setMe({ ...app.me, ai: { ...(app.me.ai || {}), ...r } });
      toast('Key saved');
      paint(); changed?.();
    } catch (err) { fieldError(form, 'key', errText(err, 'The key could not be saved.')); }
  });
  on(pane, 'click', '[data-action="ai-test"]', async (e, btn) => {
    const form = pane.querySelector('#ai-form');
    const key = form.elements.key.value.trim();
    const slot = form.querySelector('[data-slot="note"]');
    if (!key && !app.me.ai?.keySet) { fieldError(form, 'key', 'Paste a key to test.'); return; }
    try {
      const r = await busy(btn, () => api.post('/api/ai/test', key ? { key } : {}));
      if (r === undefined) return;
      mount(slot, r.ok
        ? banner({ tone: 'ok', iconName: 'check', title: 'The key works', text: `${r.model} answered in ${f.dec(r.ms / 1000, 1)} s.${key ? ' Press Save key to keep it.' : ''}` })
        : banner({ tone: 'bad', title: 'The key did not work', text: `${String(r.reason || 'OpenCode did not accept it').replace(/\.$/, '')}. Check that you copied all of it.` }));
    } catch (err) { mount(slot, banner({ tone: 'bad', title: errText(err, 'The test could not run.') })); }
  });
  on(pane, 'click', '[data-action="ai-remove"]', async () => {
    const yes = await confirm({ title: 'Remove the key?', text: 'Summaries carry on, written by the free OpenCode models. You can add a key again any time.', yes: 'Remove', danger: true });
    if (!yes) return;
    try {
      const r = await api.del('/api/ai/key');
      setMe({ ...app.me, ai: { ...(app.me.ai || {}), ...r } });
      toast('Key removed'); paint(); changed?.();
    } catch (err) { toastError(err); }
  });
  paint();
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
    if (state === 'needs-install') {
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
      </div>`;
    }
    mount(pane, html`<div class="group">${inner}</div>`);
  }
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

async function connections(pane, ctx) {
  let link = null;
  const googlePane = document.createElement('div');
  const aiPane = document.createElement('div');
  const linkPane = document.createElement('div');

  function paintGoogle() {
    const g = app.me.google || { state: 'unconfigured' };
    const badge = { ok: ['Connected', 'badge--ok'], needs_auth: ['Not connected', ''], expired: ['Needs reconnecting', 'badge--bad'], unconfigured: ['Not available', 'badge--warn'] }[g.state] || ['Unknown', ''];
    const sync = app.me.sync;
    mount(googlePane, html`
      <div class="sec__head"><h2 class="h2">Google Health</h2><span class="badge ${badge[1]}">${badge[0]}</span></div>
      <div class="stack">
        ${g.state === 'unconfigured' ? banner({ tone: 'warn', title: 'Not available yet', text: 'The server has not been set up to connect to Google. Ask ojee to finish the setup.' }) : ''}
        ${g.state === 'expired' ? banner({ tone: 'bad', title: 'Google stopped sharing your data', text: g.testingExpiry ? 'Google signs this app out every 7 days for now. Reconnect and everything carries on.' : `The connection was removed or has expired${g.expiredAt ? ` (${f.dateTime(g.expiredAt)})` : ''}. Reconnect to carry on; your history is safe.` }) : ''}
        ${g.state === 'needs_auth' ? html`<p class="prose">All your numbers come from Google Health. Connect the Google account your watch or phone uses. Google shows a screen saying this app is not verified, once: choose Advanced, then continue. That is expected for a small private app.</p>` : ''}
        ${g.state === 'ok' ? html`<div class="group">
          ${row({ iconName: 'me', title: 'Account', value: g.email || 'Connected' })}
          ${row({ iconName: 'calendar', title: 'Connected', value: g.connectedAt ? f.dateFull(f.instDay(g.connectedAt)) : f.DASH })}
          ${row({ iconName: 'refresh', title: 'Last sync', value: sync?.lastOk ? f.ago(sync.lastOk) : 'Not yet' })}
          ${app.me.device ? row({ iconName: 'watch', title: 'Device', value: `${app.me.device.name}${f.isNum(app.me.device.battery) ? ` · ${app.me.device.battery}%` : ''}` }) : ''}
        </div>` : ''}
        ${g.scopes?.length && g.state !== 'needs_auth' && g.state !== 'unconfigured' ? html`<div>
          <p class="h3" data-style="margin:4px 4px 8px">What you allowed</p>
          <div class="group">${g.scopes.map((s) => html`<div class="row"><span class="row__ic ${s.granted ? '' : ''}">${ic(s.granted ? 'check' : 'x')}</span><span class="row__body"><span class="row__t">${s.label}</span>${s.granted ? '' : html`<span class="row__d">Not allowed</span>`}</span></div>`)}</div>
          ${g.missing?.length ? html`<p class="muted small" data-style="margin:8px 4px 0">${g.missing.join('. ')}.</p>` : ''}
        </div>` : ''}
        ${app.me.capsMeta?.missing?.length && g.state === 'ok' ? html`<details class="more"><summary>${ic('right', { size: 's' })}What your device does not report</summary><ul class="muted small" data-style="list-style:disc;padding:0 0 8px 20px;display:grid;gap:4px">${app.me.capsMeta.missing.map((m) => html`<li>${m.text}</li>`)}</ul></details>` : ''}
        <div class="btnrow">
          ${g.state === 'needs_auth' ? html`<button type="button" class="btn" data-action="connect-google" data-return="/settings/connections">Connect Google</button>` : ''}
          ${g.state === 'expired' || g.state === 'ok' ? html`<button type="button" class="btn ${g.state === 'ok' ? 'btn--tonal' : ''} btn--s" data-action="connect-google" data-return="/settings/connections">Reconnect</button>` : ''}
          ${g.state === 'ok' || g.state === 'expired' ? html`<button type="button" class="btn btn--danger btn--s" data-action="g-disconnect">Disconnect</button>` : ''}
        </div>
        <details class="more"><summary>${ic('right', { size: 's' })}Getting your device's data into Google Health</summary>${deviceTips()}</details>
      </div>`);
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

  mount(pane, html`<div class="stack stack--l"><div data-s="g"></div><div data-s="ai"><div class="sec__head"><h2 class="h2">AI summaries</h2></div><div data-ai></div></div><div data-s="l"></div></div>`);
  pane.querySelector('[data-s="g"]').append(googlePane);
  pane.querySelector('[data-ai]').append(aiPane);
  pane.querySelector('[data-s="l"]').append(linkPane);
  paintGoogle();
  aiKeyBlock(aiPane);

  const gq = ctx.query.get('google');
  if (gq) {
    history.replaceState(history.state, '', '/settings/connections');
    if (gq === 'connected') toast('Google connected. The first sync has started.');
    else if (gq === 'cancelled') toast('Google was not connected. You can try again any time.');
    else toast(ctx.query.get('message') || 'Google could not be connected. Try again.', { tone: 'bad', ms: 8000 });
  }

  on(pane, 'click', '[data-action="g-disconnect"]', async () => {
    const yes = await confirm({ title: 'Disconnect Google?', text: 'New data stops arriving and this app loses its access at Google. Everything already here is kept. You can connect again any time.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    try { setMe(await api.post('/api/google/disconnect')); toast('Google disconnected'); paintGoogle(); } catch (err) { toastError(err); }
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
        <div class="group">${(d.types || []).map((t) => html`<div class="row row--top"><span class="row__body"><span class="row__t">${t.label}</span><span class="row__d">${t.description}</span></span>${toggle(`type-${t.id}`, p.types?.[t.id] ?? t.default, { label: t.label })}</div>`)}</div>
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

  const savePrefs = async (body) => { try { take(await api.put('/api/push/prefs', body)); } catch (err) { toastError(err); paint(); } };
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
    const sleepMinutes = Number(v.sleepH) * 60 + Number(v.sleepM);
    fieldError(form, 'sleepH', '');
    if (sleepMinutes < 240 || sleepMinutes > 720) { fieldError(form, 'sleepH', 'Between 4 and 12 hours.'); bad = true; }
    if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.patch('/api/settings', { goals: { steps: Math.round(v.steps), activeMinutes: Math.round(v.activeMinutes), sleepMinutes } }));
      if (r === undefined) return;
      setMe(r); toast('Goals saved'); paint();
    } catch (err) { toastError(err); }
  });
  paint();
}

async function data(pane) {
  const username = app.me.user.username;
  mount(pane, html`<div class="stack stack--l">
    <section>
      <div class="sec__head"><h2 class="h2">Export</h2></div>
      <div class="group group--pad"><div class="stack">
        <p class="prose small">One JSON file with everything this app holds about you: your profile and settings, every daily number, sleep, weight, workouts with sets, and summaries. No passwords, tokens or keys.</p>
        <div class="btnrow"><a class="btn btn--tonal btn--s" href="/api/export" download data-native>${ic('download', { size: 's' })}Download my data</a></div>
      </div></div>
    </section>
    <section>
      <div class="sec__head"><h2 class="h2">Delete my health data</h2></div>
      <div class="group group--pad"><div class="stack">
        <p class="prose small">Removes everything here: your history, workouts, summaries, profile, leaderboard entries, notification devices, link keys and saved key. This app's access at Google is revoked. What is in Google Health itself is not touched.</p>
        <p class="prose small">Your ojee.net account stays, because mtg and dnd use it. You stay signed in and can start again from empty.</p>
        <div class="btnrow"><button type="button" class="btn btn--danger btn--s" data-action="delete-data">Delete my health data</button></div>
      </div></div>
    </section>
  </div>`);
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
    ${SECTIONS.filter(([id]) => id !== 'admin' || me.user.admin).map(([id, label, icon]) => html`<a class="row" href="/settings/${id}" ${raw(active === id ? 'aria-current="page"' : '')}>
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
      ${row({ href: '/summary', iconName: 'text', title: 'Summary' })}
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
  const title = shown ? SECTIONS.find(([id]) => id === shown)[1] : 'Me';
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
        <div><h2 class="head__title" data-style="font-size:1.375rem;margin:4px 4px 16px" tabindex="-1">${title}</h2><div data-pane></div></div>
      </div>`);
  } else if (!section) {
    mount(root, html`${head({ title: 'Me' })}<div class="stack">${card}${navList('')}${appBlock()}</div>`);
  } else {
    mount(root, html`${head({ title, back: '/settings' })}<div data-pane></div>`);
  }

  on(root, 'click', '[data-seg="theme"]', (e, b) => {
    window.healthTheme?.set(b.dataset.value);
    root.querySelectorAll('[data-seg="theme"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
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
