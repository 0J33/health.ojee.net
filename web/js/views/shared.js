/* Pieces more than one screen uses: people, workout cards and their
   actions, the connection banner, chart framing. */

import { api } from '../api.js';
import { app, refreshMe, go } from '../app.js';
import { html, raw, ic, banner, sheet, confirm, toast, toastError, busy, on, field, formValues, fieldError, errText } from '../ui.js';
import * as f from '../format.js';

/* ── people ─────────────────────────────────────────────────── */

const HEX = /^#[0-9a-f]{6}$/i;
export function avatar(person, { large = false } = {}) {
  const style = person?.accent && HEX.test(person.accent) ? `data-style="--av:${person.accent}"` : '';
  return html`<span class="avatar ${large ? 'avatar--l' : ''}" ${raw(style)} aria-hidden="true">${f.initials(person?.displayName || person?.username)}</span>`;
}

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

export const connectGoogle = (ret = '/settings/connections') => { location.href = `/auth/google/start?return=${encodeURIComponent(ret)}`; };

/**
 * The one banner that explains a connection problem and its fix, or '' when
 * everything is fine. Used on Today, Trends and Workouts.
 */
export function connectionBanner(ret = '/') {
  const me = app.me;
  const g = me.google;
  if (!g) return '';
  const btn = (label) => html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="${ret}">${label}</button>`;
  if (g.state === 'unconfigured') {
    return banner({ tone: 'warn', title: 'Google Health is not available yet', text: 'The server has not been set up to connect to Google. Ask ojee to finish the setup; nothing is wrong on your side.' });
  }
  if (g.state === 'needs_auth') {
    return banner({ tone: 'accent', iconName: 'link', title: 'Connect Google Health', text: 'Your steps, sleep, heart rate and workouts come from Google Health. Connect it and the first numbers arrive within a minute.', actions: btn('Connect Google') });
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

export const SOURCE = { detected: 'Detected', manual: 'Started by hand', logged: 'Logged by hand', hevy: 'Hevy', google: 'Google Health' };
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
    <p class="now__t" data-timer="${w.start}" role="timer" aria-live="off">${f.stopwatch(Date.now() - w.start)}</p>
    <p class="now__s">Started at ${f.clock(w.start)}${w.source === 'detected' ? ', noticed from your heart rate' : ''}</p>
    <div class="btnrow">
      <button type="button" class="btn" data-wact="end">${ic('stop', { size: 's' })}End workout</button>
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

/** Tick every [data-timer] under root once a second. Returns a stop function. */
export function runTimers(root) {
  const tick = () => {
    for (const el of root.querySelectorAll('[data-timer]')) el.textContent = f.stopwatch(Date.now() - Number(el.dataset.timer));
  };
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
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
    const payload = await busy(btn, () => api.post('/api/workouts/start'));
    if (payload === undefined) return;
    toast('Workout started');
    refreshMe().catch(() => {});
    if (done) done(payload); else go('/workouts');
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
  b.classList.add('is-busy');
  connectGoogle(b.dataset.return || '/settings/connections');
});
