/* Today: the day so far, built from whatever this person's device reports.
   Nothing here assumes a metric exists; a missing one is explained. */

import { api } from '../api.js';
import { app, cap, capText, listen, refreshMe } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, banner, chart, on, busy, toast, toastError } from '../ui.js';
import { ring, sleepNight } from '../charts.js';
import * as f from '../format.js';
import { connectionBanner, missingScopes, runningCard, askCard, runTimers, bindWorkoutActions, startWorkout, legend } from './shared.js';
import { heartTile, liveControl, bindLive, paintLive } from './liveui.js';

const READY = {
  push: { tone: 'badge--accent', icon: 'bolt' },
  normal: { tone: 'badge--ok', icon: 'check' },
  easy: { tone: 'badge--warn', icon: 'flat' },
  rest: { tone: 'badge--warn', icon: 'moon' },
  learning: { tone: '', icon: 'clock' },
  unavailable: { tone: '', icon: 'info' },
};

function leadCard(d) {
  const goal = d.activity?.stepTarget || app.me.goals?.steps || 8000;
  const steps = d.activity?.today?.steps;
  const hasSteps = cap('steps') || f.isNum(steps);
  const dist = d.activity?.today?.distanceM;
  let line = '';
  if (f.isNum(steps)) {
    const left = goal - steps;
    line = left > 0
      ? `${Math.round((steps / goal) * 100)}% of your goal. ${f.int(left)} to go.`
      : `Goal reached${steps >= goal * 1.5 ? ', and then some' : ''}.`;
  }
  const r = hasSteps
    ? ring({
      value: steps || 0, goal, size: 148, stroke: 13,
      label: `${f.int(steps || 0)} of ${f.int(goal)} steps`,
      inner: `<div><div class="big big--m">${f.int(steps || 0)}</div><div class="cap">of ${f.int(goal)}</div></div>`,
    })
    : '';
  const rd = d.readiness;
  const meta = rd ? (READY[rd.level] || READY.normal) : null;
  return html`<section class="lead-card" aria-label="Steps and readiness">
    ${hasSteps ? html`<div class="lead-card__top">
      ${raw(r)}
      <div class="lead-card__txt">
        <p class="lead-card__k">Steps today</p>
        <p class="lead-card__l">${line || 'No steps yet today.'}</p>
        ${f.isNum(dist) && dist > 0 ? html`<p class="lead-card__l">${f.dist(dist)} walked</p>` : ''}
        ${d.activity?.streak?.steps > 1 ? html`<p class="lead-card__l">${f.int(d.activity.streak.steps)} days in a row at goal</p>` : ''}
      </div>
    </div>` : html`<div class="na">${ic('steps')}<div><p class="na__t">No steps yet</p><p class="na__d">${capText('steps', 'Steps appear once your phone or watch has synced to Google Health.')}</p></div></div>`}
    ${rd ? html`<div class="readiness">
      <p class="readiness__t"><span>Readiness</span><span class="badge ${meta.tone}">${ic(meta.icon, { size: 's' })}${rd.label || rd.level}</span></p>
      <p class="readiness__d">${rd.text || ''}</p>
      ${rd.usedText ? html`<p class="cap">${rd.usedText}${d.stale > 0 ? `. From ${f.dayRel(d.verdictDay)}, not this morning` : ''}</p>` : ''}
    </div>` : ''}
  </section>`;
}

function na(iconName, title, capName, fallback) {
  return html`<div class="tile tile--na">
    <p class="tile__k">${ic(iconName)}${title}</p>
    <p class="tile__v">Not available</p>
    <p class="tile__s">${capText(capName, fallback)}</p>
  </div>`;
}

function tiles(d) {
  const out = [];
  const last = [...(d.series || [])].reverse();
  const act = d.activity?.today || {};

  // Sleep, with last night's shape when the device gives stages.
  const night = d.sleep?.lastNight;
  if (night && f.isNum(night.asleepMin)) {
    const full = d.sleep.nights?.find((n) => n.main && n.date === night.date) || null;
    const target = d.activity?.sleepTarget || app.me.goals?.sleepMinutes;
    const diff = target ? night.asleepMin - target : null;
    const strip = full && f.isNum(full.startMs) && f.isNum(full.endMs)
      ? chart((w) => sleepNight({ w, start: full.startMs, end: full.endMs, stages: cap('sleepStages') ? full.stages : null, label: `Sleep from ${f.clock(full.startMs)} to ${f.clock(full.endMs)}` }))
      : '';
    const st = night.stages || {};
    out.push(html`<a class="tile tile--wide" href="/trends/sleep">
      <p class="tile__k">${ic('moon')}Sleep last night</p>
      <p class="tile__v">${f.dur(night.asleepMin)}</p>
      <p class="tile__s">${diff === null ? '' : Math.abs(diff) < 10 ? 'Right on your goal' : diff > 0 ? `${f.dur(diff)} over your goal` : `${f.dur(-diff)} under your goal`}${night.date !== d.today ? ` · ${f.dayRel(night.date)}` : ''}</p>
      ${strip ? html`<div class="chartbox">${strip}</div>` : ''}
      ${cap('sleepStages') && (st.DEEP || st.REM) ? raw(legend([['sw-deep', `Deep ${f.dur(st.DEEP || 0)}`], ['sw-rem', `REM ${f.dur(st.REM || 0)}`], ['sw-light', `Light ${f.dur(st.LIGHT || 0)}`], ['sw-awake', `Awake ${f.dur(st.AWAKE || 0)}`]])) : ''}
    </a>`);
  } else if (cap('sleep')) {
    out.push(html`<a class="tile tile--wide tile--na" href="/trends/sleep"><p class="tile__k">${ic('moon')}Sleep last night</p><p class="tile__v">Nothing recorded</p><p class="tile__s">Wear your device to bed and it shows up here in the morning.</p></a>`);
  } else {
    out.push(na('moon', 'Sleep', 'sleep', 'Your device does not report sleep. A watch or band worn at night adds it.'));
  }

  // Heart: the live reading while there is one (liveui.js swaps it in and
  // out); otherwise the latest synced one, and resting against the usual.
  const rhrRow = last.find((r) => f.isNum(r.rhr));
  if (d.hr || rhrRow) {
    const usual = rhrRow && f.isNum(rhrRow.rhrBase) ? `, usually ${Math.round(rhrRow.rhrBase)}` : '';
    out.push(heartTile({ synced: {
      v: d.hr ? html`${Math.round(d.hr.bpm)}<span class="unit">bpm</span>` : html`${Math.round(rhrRow.rhr)}<span class="unit">bpm resting</span>`,
      s: [d.hr ? f.ago(d.hr.t) : null, d.hr && rhrRow ? `Resting ${Math.round(rhrRow.rhr)}${usual}` : null, !d.hr && usual ? `Usually ${Math.round(rhrRow.rhrBase)}` : null].filter(Boolean).join(' · '),
    } }));
  } else {
    out.push(heartTile({ synced: null, na: capText('heartRate', 'Your device does not report heart rate. A watch or band adds it.') }));
  }

  // Active minutes against the goal.
  const am = act.activeMinutes;
  if (f.isNum(am) || cap('activeMinutes')) {
    const goal = d.activity?.azmTarget || app.me.goals?.activeMinutes || 22;
    out.push(html`<a class="tile" href="/trends/activity">
      <p class="tile__k">${ic('bolt')}Active minutes</p>
      <p class="tile__v">${f.int(am || 0)}<span class="unit">of ${f.int(goal)}</span></p>
      <div class="meter" role="img" aria-label="${f.int(am || 0)} of ${f.int(goal)} active minutes"><div class="meter__v" data-style="--p:${Math.min(1, (am || 0) / goal).toFixed(3)}"></div></div>
      <p class="tile__s">${(am || 0) >= goal ? 'Goal reached' : `${f.int(goal - (am || 0))} min to go`}</p>
    </a>`);
  } else {
    out.push(na('bolt', 'Active minutes', 'activeMinutes', 'Your device does not report active minutes.'));
  }

  if (f.isNum(act.kcal) || cap('calories')) {
    out.push(html`<a class="tile" href="/trends/activity">
      <p class="tile__k">${ic('flame')}Calories</p>
      <p class="tile__v">${f.int(act.kcal || 0)}<span class="unit">kcal</span></p>
      <p class="tile__s">Burned so far today</p>
    </a>`);
  } else {
    out.push(na('flame', 'Calories', 'calories', 'Your device does not report calories burned.'));
  }

  const dev = d.device || app.me.device;
  if (dev && f.isNum(dev.battery)) {
    const low = dev.battery <= 20;
    out.push(html`<div class="tile">
      <p class="tile__k">${ic('battery')}${dev.name || 'Device'}</p>
      <p class="tile__v">${f.int(dev.battery)}<span class="unit">%</span>${low ? html` <span class="badge badge--warn">Low</span>` : ''}</p>
      <p class="tile__s">${dev.lastSync ? `Device synced ${f.ago(dev.lastSync)}` : 'Battery'}</p>
    </div>`);
  } else if (dev) {
    out.push(html`<div class="tile tile--na"><p class="tile__k">${ic('watch')}${dev.name || 'Device'}</p><p class="tile__v">${dev.lastSync ? `Synced ${f.ago(dev.lastSync)}` : 'Connected'}</p><p class="tile__s">This device does not report its battery.</p></div>`);
  }
  return out;
}

function streaks(d) {
  const s = d.activity?.streak || {};
  const items = [];
  if (cap('steps')) items.push([s.steps || 0, (s.steps || 0) === 1 ? 'day at your step goal' : 'days in a row at your step goal']);
  if (cap('activeMinutes')) items.push([s.azm || 0, (s.azm || 0) === 1 ? 'day at your active minutes goal' : 'days in a row at your active minutes goal']);
  if (!items.length) return '';
  return html`<section class="sec">
    <div class="sec__head"><h2 class="h2">Streaks</h2></div>
    <div class="streaks">${items.map(([v, k]) => html`<div class="streak"><p class="streak__v">${f.int(v)}</p><p class="streak__k">${k}</p></div>`)}</div>
  </section>`;
}

function notConnected() {
  return html`<div class="group"><div class="empty">
    <span class="empty__ic">${ic('link')}</span>
    <p class="empty__t">Nothing to show yet</p>
    <p class="empty__d">Once Google Health is connected, today's steps, last night's sleep, your heart rate and your readiness appear here.</p>
  </div></div>`;
}

export default async function today(ctx) {
  const { root } = ctx;
  document.title = 'Today · Health';
  let data = null; let wk = null; let stopTimers = null;

  const syncBtn = () => html`<button type="button" class="iconbtn ${app.syncing ? 'is-busy' : ''}" data-action="sync" aria-label="Sync now" title="Sync now">${ic('refresh')}</button>`;

  function paint() {
    const me = app.me;
    const d = data;
    const g = me.google?.state;
    const hello = me.profile?.displayName ? `${f.dayLong(d?.today || f.today())}` : '';
    const pending = wk?.pending || [];
    const running = wk?.running || null;

    mount(root, html`
      ${head({ title: 'Today', sub: hello, actions: g === 'ok' ? syncBtn() : '' })}
      <div class="stack">
        ${connectionBanner('/')}
        ${running ? runningCard(running) : ''}
        ${pending.map((w) => askCard(w))}
        ${d?.illness?.flag ? banner({ tone: 'warn', iconName: 'temp', title: 'Your body looks under strain', text: d.illness.text || (d.illness.reasons || []).join(', ') }) : ''}
        ${!d || !d.connected ? notConnected()
          : d.empty ? html`${banner({ tone: 'accent', iconName: 'refresh', title: 'The first sync is running', text: 'Your history is being fetched from Google Health. This page fills in by itself, usually within a minute.' })}${skeleton('today')}`
          : html`<div class="cols">
              <div class="stack">
                ${leadCard(d)}
                <div class="btnrow">
                  ${!running ? html`<button type="button" class="btn btn--tonal btn--s" data-action="start">${ic('play', { size: 's' })}Start workout</button>` : ''}
                  <a class="btn btn--tonal btn--s" href="/summary">${ic('text', { size: 's' })}Summary</a>
                </div>
              </div>
              <div class="tiles">${tiles(d)}</div>
            </div>
            ${liveControl()}
            ${streaks(d)}`}
        ${g === 'ok' ? missingScopes('/') : ''}
      </div>
      ${g === 'ok' ? html`<p class="syncline">
        <span>${me.sync?.running || app.syncing ? 'Syncing now' : me.sync?.lastOk ? `Last synced ${f.ago(me.sync.lastOk)}` : 'Not synced yet'}</span>
        <button type="button" class="btn btn--ghost btn--s" data-action="sync">Sync now</button>
      </p>` : ''}`);

    stopTimers?.();
    stopTimers = running ? runTimers(root) : null;
    paintLive(root);
  }

  async function load() {
    const needWk = app.me.workout && (app.me.workout.running || app.me.workout.pending > 0);
    const [d, w] = await Promise.all([
      api.get('/api/data?days=30'),
      needWk ? api.get('/api/workouts?limit=1').catch(() => null) : Promise.resolve(null),
    ]);
    data = d; wk = w;
  }

  async function reload({ quiet = true } = {}) {
    try {
      await load();
      if (ctx.alive()) paint();
    } catch (err) {
      if (!quiet && ctx.alive()) toastError(err);
    }
  }

  async function sync(btn) {
    if (app.syncing) return;
    app.syncing = true;
    root.querySelectorAll('.iconbtn[data-action="sync"]').forEach((b) => b.classList.add('is-busy'));
    try {
      const r = await busy(btn?.classList.contains('btn') ? btn : null, () => api.post('/api/sync'));
      app.syncing = false;
      await refreshMe().catch(() => {});
      await reload();
      if (r?.result?.ok === false) toast(r.result.message || 'Google did not answer. It will try again by itself.', { tone: 'bad' });
      else toast('Synced');
    } catch (err) {
      app.syncing = false;
      if (ctx.alive()) paint();
      toast(err.status === 429 ? 'Synced a moment ago. Try again in a minute.' : err.code === 'needs_google' ? 'Connect Google first.' : (err.message || 'Sync did not work. Try again.'), { tone: err.status === 429 ? '' : 'bad' });
    }
  }

  on(root, 'click', '[data-action="sync"]', (e, btn) => sync(btn));
  on(root, 'click', '[data-action="start"]', (e, btn) => startWorkout(btn, (payload) => { wk = payload; paint(); }));
  on(root, 'click', '[data-action="retry"]', () => first());
  bindWorkoutActions(root, {
    find: (id) => (wk?.running?.id === id ? wk.running : wk?.pending?.find((w) => w.id === id)),
    done: (payload) => { wk = payload; paint(); reload(); },
  });

  ctx.onLeave(listen('changed', (what) => { if (what.includes('data') || what.includes('workouts') || what.includes('me')) reload(); }));
  ctx.onLeave(listen('sync', () => { if (ctx.alive() && data) paint(); }));
  ctx.onLeave(() => stopTimers?.());
  ctx.onLeave(bindLive(root));
  ctx.onRefresh(() => (app.me.google?.state === 'ok' ? sync(null) : reload({ quiet: false })));

  // Returning from Google's consent screen.
  const gq = ctx.query.get('google');
  if (gq) {
    history.replaceState(history.state, '', '/');
    if (gq === 'connected') toast('Google connected. The first sync has started.');
    else if (gq === 'cancelled') toast('Google was not connected. You can try again any time.');
    else toast(ctx.query.get('message') || 'Google could not be connected. Try again.', { tone: 'bad' });
  }

  async function first() {
    mount(root, html`${head({ title: 'Today' })}${skeleton('today')}`);
    try {
      await load();
      if (ctx.alive()) paint();
    } catch (err) {
      if (!ctx.alive()) return;
      mount(root, html`${head({ title: 'Today' })}${errorState(err)}`);
    }
  }
  await first();
}
