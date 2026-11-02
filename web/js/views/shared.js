/* Pieces more than one screen uses: people, workout cards and their
   actions, the connection banner, chart framing. */

import { api } from '../api.js';
import { app, refreshMe, go } from '../app.js';
import { html, raw, ic, banner, sheet, confirm, toast, toastError, busy, on, field, formValues, fieldError, errText } from '../ui.js';
import * as f from '../format.js';
import * as live from '../live.js';
import { paintLive } from './liveui.js';
import { platform, openOutside, browserName } from '../pwa.js';

/* ── people ─────────────────────────────────────────────────── */

const HEX = /^#[0-9a-f]{6}$/i;
/** A person's round face: their profile photo when they have one (`avatar`,
    an address under /media/), their initials on their colour otherwise, and
    the initials again if the photo does not load. */
export function avatar(person, { large = false } = {}) {
  const style = person?.accent && HEX.test(person.accent) ? `data-style="--av:${person.accent}"` : '';
  const src = typeof person?.avatar === 'string' && /^\/media\/m_[0-9a-f]{10}$/.test(person.avatar) ? person.avatar : '';
  return html`<span class="avatar ${large ? 'avatar--l' : ''} ${src ? 'avatar--img' : ''}" ${raw(style)} aria-hidden="true">${f.initials(person?.displayName || person?.username)}${src ? html`<img class="avatar__img" src="${src}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
}
// A photo that does not load (signed out, made private since): the initials under it show.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img?.classList?.contains('avatar__img')) { img.closest('.avatar')?.classList.remove('avatar--img'); img.remove(); }
}, true);

/* ── charts ─────────────────────────────────────────────────── */

/**
 * A chart with its readout line and table alternative.
 * `svgSlot` is the ui.chart() slot; `hint` is what the readout says before
 * anything is touched.
 */
export function chartbox(svgSlot, { hint = 'Touch the chart to read a day.', table = '', legend = '', note = '' } = {}) {
  return html`<div class="chartbox">
    <p class="chart__read" aria-live="polite">${hint}</p>
    ${svgSlot}
    ${legend ? raw(legend) : ''}
    ${note ? html`<p class="chart__note">${note}</p>` : ''}
    ${table ? raw(table) : ''}
  </div>`;
}

export function legend(items) {
  return `<div class="legend">${items.map(([cls, text]) => `<span class="legend__i"><span class="legend__sw ${cls}"></span>${text}</span>`).join('')}</div>`;
}

/** "+12%" against the previous period, coloured by whether up is good. */
export function delta(pctChange, { goodUp = true, suffix = '' } = {}) {
  if (!f.isNum(pctChange)) return '';
  const r = Math.round(pctChange);
  if (r === 0) return html`<span class="delta">${ic('flat')}<span>No change${suffix}</span></span>`;
  const up = r > 0;
  const good = up === goodUp;
  return html`<span class="delta ${good ? 'delta--up' : 'delta--down'}">${ic(up ? 'up' : 'down')}<span>${Math.abs(r)}%${suffix}</span></span>`;
}

/* ── Google connection ──────────────────────────────────────── */

export function connectGoogle(ret = '/settings/connections', groups = [], account = '') {
  // Google refuses to show its sign-in inside an app's built-in browser,
  // so in the Health app this step is done in Safari.
  if (platform.native) { googleInSafari({ groups }); return; }
  // `groups`: optional groups to ask Google for as well (docs/API.md, /auth/google/start).
  // `account`: 'new' adds another Google account, an id reconnects that one.
  const g = (groups || []).filter(Boolean);
  // account 'pick': the main account, chosen again from Google's list (not the one connected suggested).
  const acct = account === 'pick' ? '&pick=1' : account ? `&account=${encodeURIComponent(account)}` : '';
  location.href = `/auth/google/start?return=${encodeURIComponent(ret)}${g.length ? `&groups=${encodeURIComponent(g.join(','))}` : ''}${acct}`;
}

/** The Health app: how to connect Google, and the button that opens Safari. */
export function googleInSafari({ groups = [] } = {}) {
  const extra = (groups || []).filter(Boolean).length > 0;
  let left = false;
  // Back from Safari: the account may be connected now.
  const back = () => {
    if (document.visibilityState !== 'visible' || !left) return;
    left = false;
    refreshMe().then(() => { if (app.me.google?.state === 'ok') { s.close(); toast('Google is connected.'); } }).catch(() => {});
  };
  document.addEventListener('visibilitychange', back);
  const s = sheet({
    title: platform.android ? 'Connect Google in your browser' : 'Connect Google in Safari',
    body: html`<div class="stack">
      <p class="prose">Google does not allow signing in from inside an app like this one, so this one step happens in ${browserName()}.</p>
      <ol class="howto">
        <li><span>Open <b>health.ojee.net</b> in ${browserName()} and sign in with the same account.</span></li>
        <li><span>Go to <b>Me</b>, <b>Connections</b>, and connect Google there.${extra ? html` The extra data you picked is on the same page, under <b>More data</b>: turn it on there too.` : ''}</span></li>
        <li><span>Come back to this app.</span></li>
      </ol>
      <p class="muted small">The connection belongs to your account, not to one device, so it works here as soon as it is made.</p>
    </div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Not now</button><button type="button" class="btn" data-open-safari>${ic('external', { size: 's' })}${platform.android ? 'Open in browser' : 'Open in Safari'}</button>`,
    onOpen: (el) => on(el, 'click', '[data-open-safari]', () => { left = true; openOutside('/settings/connections'); }),
  });
  s.closed.then(() => document.removeEventListener('visibilitychange', back));
  return s;
}

/**
 * The one banner that explains a connection problem and its fix, or '' when
 * everything is fine. Used on Today, Trends and Workouts.
 */
export function connectionBanner(ret = '/') {
  const me = app.me;
  const g = me.google;
  if (!g) return '';
  const btn = (label, account = '') => html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="${ret}" ${account ? raw(`data-account="${account}"`) : ''}>${label}</button>`;
  // Garmin, read directly: its key ran out, or is about to.
  const gm = me.garmin || {};
  const gmLink = (label) => html`<a class="btn btn--s" href="/settings/connections/accounts/garmin">${label}</a>`;
  if (gm.lost && g.state !== 'ok') {
    return banner({ tone: 'bad', title: 'Garmin stopped accepting your key', text: 'A key lasts as long as you chose when you made it. Make a new one in Garmin Connect and paste it in Connections; everything it brought is kept.', actions: gmLink('Paste a new key') });
  }
  if (gm.connected && f.isNum(gm.keyExpiresAt) && gm.keyExpiresAt - Date.now() < 5 * 86_400_000) {
    return banner({ tone: 'warn', iconName: 'clock', title: `Your Garmin key runs out ${f.dayRel(f.instDay(gm.keyExpiresAt)).toLowerCase() === 'today' ? 'today' : `on ${f.dayShort(f.instDay(gm.keyExpiresAt))}`}`, text: 'Make a new one in Garmin Connect and replace it in Connections, so nothing is missed.', actions: gmLink('Replace key') });
  }
  if (gm.connected && g.state !== 'ok') {
    const e = gm.lastError;
    if (e?.code === 'rate_limited') return banner({ tone: 'warn', iconName: 'clock', title: 'Garmin asked us to slow down', text: 'Reading is paused for a little while and then carries on by itself. There is nothing you need to do.' });
    if (e) return banner({ tone: 'warn', title: 'The last Garmin sync had a problem', text: `${e.message || 'Garmin returned an error.'} It will try again by itself.` });
    return '';
  }
  // Several accounts: one that dropped out is named, and the rest still syncs.
  const accts = (me.googleAccounts || []).filter((a) => a.include);
  if (accts.length > 1 && g.state !== 'unconfigured') {
    const lost = accts.filter((a) => a.state === 'expired');
    if (lost.length) {
      const a = lost[0];
      return banner({
        tone: 'bad', title: `${accountName(a)} stopped sharing its data`,
        text: `${a.testingExpiry ? 'Google signs this app out every 7 days for now.' : 'That connection was removed or has expired.'} Your other ${accts.length - 1 === 1 ? 'account still syncs' : 'accounts still sync'}; reconnect this one to bring its tracker back.`,
        actions: btn('Reconnect', a.id),
      });
    }
    const off = accts.filter((a) => a.state === 'needs_auth');
    if (off.length && off.length < accts.length) {
      return banner({ tone: 'warn', iconName: 'link', title: `${accountName(off[0])} is not connected`, text: 'Its tracker is not being read. Connect it again, or remove it in Connections.', actions: btn('Connect', off[0].id) });
    }
  }
  if (g.state === 'unconfigured') {
    return banner({ tone: 'warn', title: 'Google Health is not available yet', text: 'The server has not been set up to connect to Google. Ask ojee to finish the setup; nothing is wrong on your side.' });
  }
  if (g.state === 'needs_auth') {
    return banner({ tone: 'accent', iconName: 'link', title: 'Connect Google Health or Garmin', text: 'Your steps, sleep, heart rate and workouts come from Google Health, or straight from a Garmin watch. Connect one and the first numbers arrive within a minute.', actions: html`${btn('Connect Google')}<a class="btn btn--tonal btn--s" href="/settings/connections/accounts/garmin">Use a Garmin</a>` });
  }
  if (g.state === 'expired') {
    return banner({
      tone: 'bad',
      title: 'Google stopped sharing your data',
      text: g.testingExpiry
        ? 'Google signs this app out every 7 days for now. Reconnect and everything carries on; your history is safe.'
        : 'The connection was removed or has expired, so nothing new is arriving. Reconnect and syncing starts again; your history is safe.',
      actions: btn('Reconnect Google'),
    });
  }
  const err = me.sync?.lastError;
  if (err) {
    const until = me.sync.backoffUntil;
    if (err.code === 'rate_limited') {
      return banner({ tone: 'warn', iconName: 'clock', title: 'Google asked us to slow down', text: `Syncing is paused${until ? ` until ${f.clock(until)}` : ' for a little while'} and then carries on by itself. There is nothing you need to do.` });
    }
    if (err.code === 'network') {
      return banner({ tone: 'warn', iconName: 'offline', title: 'Could not reach Google', text: 'The last sync did not get through. It will try again by itself; you can also press Sync now.' });
    }
    return banner({ tone: 'warn', title: 'The last sync had a problem', text: `${err.message || 'Google returned an error.'} It will try again by itself.` });
  }
  return '';
}

/** What an account is called on the page: its name, else its address. */
export const accountName = (a) => a?.label || a?.email || 'A Google account';

/** Permissions the person declined, as a quieter banner. */
export function missingScopes(ret = '/settings/connections') {
  const miss = app.me.google?.missing || [];
  if (!miss.length || app.me.google.state !== 'ok') return '';
  return banner({
    iconName: 'key', title: 'Some permissions were not given',
    text: `${miss.join('. ')}.`,
    actions: html`<button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-return="${ret}">Reconnect</button>`,
  });
}

/* ── workouts ───────────────────────────────────────────────── */

export const SOURCE = { detected: 'Detected', manual: 'Started by hand', logged: 'Logged by hand', hevy: 'Hevy', strava: 'Strava', google: 'Google Health', recorded: 'Recorded with GPS', gpx: 'GPX file' };
export const sourceLabel = (w) => SOURCE[w.source] || 'Workout';

export function typeLabel(type, types) {
  const hit = types?.find((t) => t.id === type);
  if (hit) return hit.label;
  if (!type) return 'Workout';
  const s = String(type).replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export const workoutTitle = (w, types) => (w.title && w.title !== 'Workout' ? w.title : typeLabel(w.type, types));

export function googleStateText(w) {
  const g = w.google;
  if (!g || !g.state) return null;
  return {
    saved: 'Saved to Google Health',
    pending: 'Will be saved to Google Health shortly',
    failed: `Could not save to Google Health${g.error ? `: ${g.error}` : ''}`,
    needs_scope: 'Not saved to Google Health. Reconnect to allow saving workouts',
    local: 'Kept in this app only',
    remote: 'The console module will save it to Google Health',
    foreign: 'Already in Google Health from your device',
  }[g.state] || null;
}

/** The running workout: a live timer. */
export function runningCard(w) {
  return html`<section class="now" aria-label="Workout in progress" data-wid="${w.id}">
    <p class="now__k"><span class="now__live"></span>Workout in progress</p>
    <div class="now__row">
      <p class="now__t" data-timer="${w.start}" role="timer" aria-live="off">${f.stopwatch(Date.now() - w.start)}</p>
      <p class="now__hr" data-live-bpm></p>
    </div>
    <p class="now__s">Started at ${f.clock(w.start)}${w.source === 'detected' ? ', noticed from your heart rate' : ''}</p>
    <div class="btnrow">
      ${w.logging ? html`<a class="btn" href="/workouts/${encodeURIComponent(w.id)}">${ic('list', { size: 's' })}Open the log</a>` : ''}
      <button type="button" class="btn ${w.logging ? 'btn--tonal' : ''}" data-wact="end">${ic('stop', { size: 's' })}End workout</button>
      <button type="button" class="btn btn--ghost" data-wact="discard">Discard</button>
    </div>
  </section>`;
}

/** A question waiting for an answer: started? / ended? */
export function askCard(w) {
  if (w.status === 'ongoing') {
    return html`<section class="ask" data-wid="${w.id}" aria-label="Question about a workout">
      <div>
        <p class="ask__q">Workout started at ${f.clock(w.start)}?</p>
        <p class="ask__d">Your heart rate has been up since then${f.instDay(w.start) !== f.today() ? ` (${f.dayRel(f.instDay(w.start))})` : ''}.</p>
      </div>
      <div class="btnrow">
        <button type="button" class="btn btn--s" data-wact="confirm">Yes</button>
        <button type="button" class="btn btn--tonal btn--s" data-wact="adjust-start">Adjust</button>
        <button type="button" class="btn btn--ghost btn--s" data-wact="dismiss">Not a workout</button>
      </div>
    </section>`;
  }
  const end = w.end ?? w.lastEnd;
  const day = f.instDay(w.start) !== f.today() ? `${f.dayRel(f.instDay(w.start))}, ` : '';
  const why = w.autoClosed === 'calm'
    ? 'It was closed by itself after an hour of calm heart rate. Check the end time.'
    : w.autoClosed
      ? 'It was closed by itself because no raised heart rate was seen. Check the times.'
      : `${f.dur(w.durationMin ?? (end - w.start) / 60000)}${f.isNum(w.avgHr) ? `, average ${Math.round(w.avgHr)} bpm` : ''}.`;
  return html`<section class="ask" data-wid="${w.id}" aria-label="Question about a workout">
    <div>
      <p class="ask__q">Workout ${day}${f.clock(w.start)} to ${f.clock(end)}. Save it?</p>
      <p class="ask__d">${why}</p>
    </div>
    <div class="btnrow">
      <button type="button" class="btn btn--s" data-wact="save">Save</button>
      <button type="button" class="btn btn--tonal btn--s" data-wact="adjust">Adjust</button>
      <button type="button" class="btn btn--ghost btn--s" data-wact="dismiss">Not a workout</button>
    </div>
  </section>`;
}

/** Tick every [data-timer] under root once a second, and keep the live
    heart rate beside it current. Returns a stop function. */
export function runTimers(root) {
  const tick = () => {
    for (const el of root.querySelectorAll('[data-timer]')) el.textContent = f.stopwatch(Date.now() - Number(el.dataset.timer));
  };
  const id = setInterval(tick, 1000);
  paintLive(root);
  const off = live.subscribe(() => paintLive(root));
  return () => { clearInterval(id); off(); };
}

/**
 * A sheet for a start time, an end time, or both. Resolves to
 * { start?, end? } in ms, or undefined when closed.
 */
export function timesSheet({ title, start, end, wantStart = true, wantEnd = true, save = 'Save', text = '' }) {
  const s = sheet({
    title,
    body: html`<form class="form" id="times-form" novalidate>
      ${text ? html`<p class="muted small">${text}</p>` : ''}
      ${wantStart ? field({ label: 'Started', name: 'start', type: 'datetime-local', value: f.toLocalInput(start), attrs: 'required step="60"' }) : ''}
      ${wantEnd ? field({ label: 'Ended', name: 'end', type: 'datetime-local', value: f.toLocalInput(end ?? Date.now()), attrs: 'required step="60"' }) : ''}
      <p class="field__hint">Times are in your time zone (${f.getPrefs().tz}).</p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button>
      <button type="submit" class="btn" form="times-form">${save}</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(form);
    const out = {};
    if (wantStart) out.start = f.fromLocalInput(v.start);
    if (wantEnd) out.end = f.fromLocalInput(v.end);
    fieldError(form, 'start', ''); fieldError(form, 'end', '');
    if (wantStart && !out.start) { fieldError(form, 'start', 'Enter when it started.'); return; }
    if (wantEnd && !out.end) { fieldError(form, 'end', 'Enter when it ended.'); return; }
    if (wantStart && out.start > Date.now()) { fieldError(form, 'start', 'A workout cannot start in the future.'); return; }
    if (wantStart && wantEnd && out.end <= out.start) { fieldError(form, 'end', 'The end has to be after the start.'); return; }
    if (wantEnd && out.end > Date.now() + 60000) { fieldError(form, 'end', 'The end cannot be in the future.'); return; }
    s.close(out);
  });
  return s.closed;
}

/**
 * Wire the buttons on runningCard / askCard. `find(id)` returns the workout,
 * `done(payload)` receives the fresh GET /api/workouts payload.
 */
export function bindWorkoutActions(root, { find, done }) {
  on(root, 'click', '[data-wact]', async (e, btn) => {
    const id = btn.closest('[data-wid]')?.dataset.wid;
    const w = find(id);
    if (!id || !w) return;
    const act = btn.dataset.wact;
    const base = `/api/workouts/${encodeURIComponent(id)}`;
    let call = null; let okText = '';
    if (act === 'confirm') { call = () => api.post(`${base}/confirm`); okText = 'Workout running'; }
    else if (act === 'adjust-start') {
      const t = await timesSheet({ title: 'When did it start?', start: w.start, wantEnd: false, save: 'Start from here' });
      if (!t) return;
      call = () => api.post(`${base}/confirm`, { start: t.start }); okText = 'Workout running';
    } else if (act === 'save') { call = () => api.post(`${base}/save`); okText = 'Workout saved'; }
    else if (act === 'adjust') {
      const t = await timesSheet({ title: 'Adjust the times', start: w.start, end: w.end ?? w.lastEnd, save: 'Save workout' });
      if (!t) return;
      call = () => api.post(`${base}/save`, t); okText = 'Workout saved';
    } else if (act === 'dismiss') { call = () => api.post(`${base}/dismiss`); okText = 'Dismissed'; }
    else if (act === 'end') { call = () => api.post(`${base}/end`); okText = 'Workout saved'; }
    else if (act === 'discard') {
      const yes = await confirm({ title: 'Discard this workout?', text: 'The timer stops and nothing is saved.', yes: 'Discard', danger: true });
      if (!yes) return;
      call = () => api.post(`${base}/dismiss`); okText = 'Workout discarded';
    }
    if (!call) return;
    try {
      const payload = await busy(btn, call);
      if (payload === undefined) return;
      toast(okText);
      refreshMe().catch(() => {});
      done(payload);
    } catch (err) { toastError(err); }
  });
}

/** Start a workout now; goes to the workouts page on success. */
export async function startWorkout(btn, done) {
  try {
    // Started by hand, it opens the set-by-set log: exercises can be added
    // as they are done, or none, for a run or a class.
    const payload = await busy(btn, () => api.post('/api/workouts/start', { log: true }));
    if (payload === undefined) return;
    toast('Workout started');
    refreshMe().catch(() => {});
    if (payload.started) go(`/workouts/${encodeURIComponent(payload.started)}`); else if (done) done(payload); else go('/workouts');
  } catch (err) {
    toast(errText(err), { tone: 'bad' });
  }
}

/* ── misc ───────────────────────────────────────────────────── */

/** Format a leaderboard / compare / record value by its API unit. */
export function unitValue(value, unit) {
  if (!f.isNum(value)) return { v: f.DASH, u: '' };
  switch (unit) {
    case 'm': return { v: f.distNum(value), u: f.distUnit() };
    case 'min': {
      const p = f.durParts(value);
      return p.h ? { v: `${p.h} h ${p.m} min`, u: '' } : { v: String(p.m), u: 'min' };
    }
    case 'steps': return { v: f.int(value), u: 'steps' };
    case 'workouts': return { v: f.int(value), u: Math.round(value) === 1 ? 'workout' : 'workouts' };
    case 'medals': return { v: f.int(value), u: Math.round(value) === 1 ? 'medal' : 'medals' };
    case 'score': return { v: f.int(value), u: 'of 100' };
    case 'kg': return { v: f.weightNum(value), u: f.weightUnit() };
    default: return { v: f.int(value), u: unit || '' };
  }
}
export const unitText = (value, unit) => { const x = unitValue(value, unit); return x.u ? `${x.v} ${x.u}` : x.v; };

/** Global handler for "Connect Google" buttons, wherever they are. */
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-action="connect-google"]');
  if (!b) return;
  e.preventDefault();
  if (!platform.native) b.classList.add('is-busy');
  // Route maps asked for: back from Google, the next step is said (main.js, routesAllowed).
  if ((b.dataset.groups || '').split(',').includes('routes')) { try { sessionStorage.setItem('health.routesAsked', '1'); } catch { /* fine */ } }
  connectGoogle(b.dataset.return || '/settings/connections', (b.dataset.groups || '').split(',').filter(Boolean), b.dataset.account || '');
});

/* ── the sections under the Browse tab ──────────────────────── */

const SECTION_CAPS = {
  sleep: ['sleep', 'sleepStages'],
  heart: ['restingHr', 'hrv', 'spo2', 'skinTemp'],
  body: ['weight', 'bodyFat'],
};
/**
 * The sub-tabs shared by Browse and the analysis views: Browse first, then
 * Overview and the sections this person has anything for. `q` is the
 * analysis views' "?range=…"; `also(id)` lets a view keep a tab it knows
 * has data. Use with kit.js tabsub(sectionTabs(...), current).
 */
export function sectionTabs(current, { q = '', also = null } = {}) {
  const all = [['browse', 'All', '/trends'], ['overview', 'Overview', '/trends/overview'], ['sleep', 'Sleep', '/trends/sleep'], ['activity', 'Activity', '/trends/activity'], ['heart', 'Heart', '/trends/heart'], ['body', 'Body', '/trends/body']];
  const show = (id) => id === 'browse' || id === 'overview' || id === 'activity' || id === current
    || (SECTION_CAPS[id] || []).some((c) => Boolean(app.me?.caps?.[c])) || Boolean(also?.(id));
  return all.filter(([id]) => show(id)).map(([id, label, href]) => [id === 'browse' ? href : `${href}${q}`, label, id]);
}
