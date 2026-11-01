/* Workouts: the training log (what needs an answer, this week against the
   usual, twelve weeks, heart-rate zones, strength, then the sessions), one
   workout in detail, Hevy import, and detection settings.

   Data: GET /api/workouts (`training` is the log; every workout carries
   `spark`, `zonesMin`, `prCount`) and GET /api/workouts/:id (`zones`,
   `usual`, `pr` per set, `previous` per exercise). A workout's `spark` and
   `zonesMin` are null until its detail has been opened once, so every place
   that draws them stands without them. */

import { api } from '../api.js';
import { app, listen, go, refreshMe } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, banner, chart, on, sheet, confirm, field, formValues, fieldError, busy, toast, toastError, toggle, row, seg, errText, esc } from '../ui.js';
import { hrTrace, tableAlt } from '../charts.js';
import { cats, hours, stacked, spark } from '../viz.js';
import { mod, grid, stat, split, facts, figure, ib, tooFew } from '../kit.js';
import * as f from '../format.js';
import { connectionBanner, runningCard, askCard, runTimers, bindWorkoutActions, startWorkout, timesSheet, workoutTitle, typeLabel, sourceLabel, googleStateText } from './shared.js';
import { mountLogger } from './logger.js';
import { startRoutine, askText } from './routines.js';
import { routeMap } from '../map.js';
import { thumb, exerciseInfo, pickExercises } from '../exlib.js';
import { exerciseCard, readInput, nextSet, cycleKind } from '../setsui.js';
import { exerciseMenu } from './routines.js';
import { aiButton } from '../ai.js';
import { workoutCardOn } from './today.js';
import { addToPost, openViewer, MAX_PER_POST } from '../media.js';

const MAX_CSV = 5 * 1024 * 1024;

/* ── words and small pieces both screens use ────────────────── */

const ZK = ['k0', 'k1', 'k2', 'k3', 'k4'];
const MUSCLE = { chest: 'Chest', back: 'Back', shoulders: 'Shoulders', arms: 'Arms', legs: 'Legs', core: 'Core', other: 'Other' };
const WD1 = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const WD3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const num1 = (v) => (f.isNum(v) ? f.dec(v, 1).replace(/\.0$/, '') : f.DASH);
/** Kilograms as a number in the person's unit: "98.5", "70". */
const wnum = (kg) => num1(f.weightVal(kg));
const wt = (kg) => `${wnum(kg)} ${f.weightUnit()}`;
/** Training volume in the person's own unit (tonnes, kg or lb): the number, its unit, both. */
const volNum = (kg) => f.volume(kg, { unit: false });
const volU = () => f.volumeUnit();
const vol = (kg) => f.volume(kg);
const volV = (kg) => (f.isNum(kg) ? (volU() === 't' ? kg / 1000 : volU() === 'lb' ? kg * 2.2046226218 : kg) : null);
const sum = (arr) => arr.reduce((a, v) => a + (f.isNum(v) ? v : 0), 0);
const words = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** "3 h 30 min" with the units set small, for a headline number. */
function durHtml(min) {
  const p = f.durParts(min);
  if (!p) return f.DASH;
  const u = (t) => html`<span class="stat__u">${t}</span>`;
  if (!p.h) return html`${p.m}${u('min')}`;
  return p.m ? html`${p.h}${u('h')} ${p.m}${u('min')}` : html`${p.h}${u('h')}`;
}

function typeIcon(w) {
  const t = String(w.type || '').toUpperCase();
  if (w.sets || /STRENGTH|WEIGHT|CALISTHEN|CROSSFIT/.test(t)) return 'strength';
  if (/RUN|JOG/.test(t)) return 'run';
  if (/WALK/.test(t)) return 'walk';
  if (/BIK|CYCL|SPIN/.test(t)) return 'bike';
  if (/SWIM/.test(t)) return 'swim';
  if (/HIK|CLIMB/.test(t)) return 'hike';
  if (/YOGA|PILATES|STRETCH|MEDITAT/.test(t)) return 'yoga';
  if (/ROW/.test(t)) return 'rowing';
  return 'sport';
}

const since = (days) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${f.int(days)} days ago`);
const recBadge = (n, { plain = false } = {}) => html`<span class="rec">${ic('record', { size: 's' })}${plain ? 'Record' : f.plural(n, 'record')}</span>`;

/** The bpm range of each of the five zones, from the four bounds. */
const zoneRanges = (b) => [`under ${b[0]}`, `${b[0]} to ${b[1] - 1}`, `${b[1]} to ${b[2] - 1}`, `${b[2]} to ${b[3] - 1}`, `${b[3]} and up`];

/** The five zones as a table: name, bpm range, and (when given) minutes and share. */
function zoneTable(z, minutes = null) {
  const ranges = zoneRanges(z.bounds);
  const total = minutes ? sum(minutes) : 0;
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table class="data zt">
    <thead><tr><th scope="col">Zone</th><th scope="col" class="n">bpm</th>${minutes ? html`<th scope="col" class="n">Time</th><th scope="col" class="n">Share</th>` : ''}</tr></thead>
    <tbody>${z.labels.map((l, i) => html`<tr class="${minutes && !(minutes[i] > 0) ? 'is-none' : ''}">
      <th scope="row"><span class="legend__sw ${ZK[i]}"></span>${l}</th>
      <td class="n">${ranges[i]}</td>
      ${minutes ? html`<td class="n">${f.dur(minutes[i] || 0)}</td><td class="n">${total > 0 ? `${Math.round(((minutes[i] || 0) / total) * 100)}%` : f.DASH}</td>` : ''}
    </tr>`)}</tbody>
  </table></div>`;
}

const zoneSplit = (z, minutes) => split(minutes.map((v, i) => ({ value: v, cls: ZK[i], label: z?.labels?.[i] || `Zone ${i + 1}` })), {
  label: `Time in heart-rate zones: ${minutes.map((v, i) => (v > 0 ? `${z?.labels?.[i] || `zone ${i + 1}`} ${f.dur(v)}` : null)).filter(Boolean).join(', ')}`,
});

/** Returning from Google's consent screen (the banners send people there). */
function googleReturn(ctx, path) {
  const gq = ctx.query?.get?.('google');
  if (!gq) return;
  history.replaceState(history.state, '', path);
  if (gq === 'connected') toast('Google connected.');
  else if (gq === 'cancelled') toast('Google was not connected. You can try again any time.');
  else toast(ctx.query.get('message') || 'Google could not be connected. Try again.', { tone: 'bad' });
}

/** Calm rows into more: an icon in a soft circle, a title, one grey line, a
    chevron. A row with `href` is a link; otherwise a button with data-<kind>="key". */
function xrows(rows, kind = 'x') {
  if (!rows.length) return '';
  return html`<div class="xrows">${rows.map((r) => {
    const inner = html`<span class="xrow__ic ${r.fam ? `fam fam-${r.fam}` : ''}">${ic(r.icon || 'right')}</span>
      <span class="xrow__b"><span class="xrow__t">${r.title}</span>${r.text ? html`<span class="xrow__d">${r.text}</span>` : ''}</span>
      ${r.value ? html`<span class="xrow__v">${r.value}</span>` : ''}
      ${r.danger ? '' : html`<span class="xrow__chev">${ic('right', { size: 's' })}</span>`}`;
    const cls = `xrow press ${r.danger ? 'xrow--danger' : ''}`;
    return r.href ? html`<a class="${cls}" href="${r.href}" ${r.ext ? raw('target="_blank" rel="noopener"') : ''}>${inner}</a>`
      : html`<button type="button" class="${cls}" ${raw(r.attrs || `data-${kind}="${esc(r.key)}"`)}>${inner}</button>`;
  })}</div>`;
}

/* ── list: this week ────────────────────────────────────────── */

/** "1 more than your usual week", in words, without a verdict. */
function againstUsual(cur, avg, fmt, { tol = 0.5, more = 'more', less = 'fewer', usual = '' } = {}) {
  if (!f.isNum(cur) || !f.isNum(avg)) return '';
  const diff = cur - avg;
  const tail = usual ? html`<span class="muted">Usual ${usual}</span>` : '';
  if (Math.abs(diff) < tol) return html`<span class="delta">${ic('flat', { size: 's' })}<span>In line with your usual week</span></span>${tail}`;
  return html`<span class="delta">${ic(diff > 0 ? 'up' : 'down', { size: 's' })}<span>${fmt(Math.abs(diff))} ${diff > 0 ? more : less} than your usual week</span></span>${tail}`;
}

function weekMod(d) {
  const t = d.training;
  const wk = t?.week;
  const actions = html`<div class="btnrow wk-week__act">
    ${!d.running ? html`<button type="button" class="btn" data-action="start">${ic('play', { size: 's' })}Start workout</button>` : ''}
    <button type="button" class="btn btn--tonal" data-action="log">${ic('plus', { size: 's' })}Log a past one</button>
  </div>`;
  if (!wk) return ({ title: 'This week', fam: 'workouts', icon: 'week', span: 12, body: actions });
  const a = wk.avg4 || {};
  const known = (a.workouts || 0) > 0;
  const none = html`<span class="muted">No earlier weeks to compare with yet</span>`;
  const hasSets = (wk.sets || 0) > 0 || (a.sets || 0) > 0;
  const list = [
    stat({ size: 'l', label: 'Sessions', value: f.int(wk.workouts),
      context: known ? againstUsual(wk.workouts, a.workouts, (v) => f.int(Math.max(1, Math.round(v))), { tol: 0.75, usual: num1(a.workouts) }) : none }),
    stat({ size: 'l', label: 'Time', value: durHtml(wk.minutes),
      context: known ? againstUsual(wk.minutes, a.minutes, f.dur, { tol: 10, less: 'less', usual: f.dur(a.minutes) }) : none }),
  ];
  if (hasSets) {
    list.push(stat({ size: 'l', label: 'Sets', value: f.int(wk.sets),
      context: known ? againstUsual(wk.sets, a.sets, (v) => f.int(Math.max(1, Math.round(v))), { tol: 1, usual: num1(a.sets) }) : none }));
    list.push(stat({ size: 'l', label: 'Volume', value: volNum(wk.volumeKg), unit: volU(),
      context: known ? againstUsual(wk.volumeKg, a.volumeKg, (v) => `${vol(v)}`, { tol: Math.max(1, (a.volumeKg || 0) * 0.03), less: 'less', usual: volNum(a.volumeKg) }) : none }));
  }
  return ({
    title: 'This week', fam: 'workouts', icon: 'week', span: 12, cls: 'wk-week',
    line: `${f.plural(wk.workouts, 'session')} · ${f.dur(wk.minutes)}${known ? ` · usual ${num1(a.workouts)}` : ''}`,
    note: `${f.dayShort(wk.start)} to ${f.dayShort(f.addDays(wk.start, 6))}, so far. Your usual week is the average of the four before it.`,
    body: html`<div class="wk-week__in"><div class="stats stats--${list.length === 4 ? 4 : 2} wk-week__stats">${list}</div>${actions}</div>`,
  });
}

/* ── list: twelve weeks, zones, pattern ─────────────────────── */

function weeksMod(t, mode) {
  const weeks = t.weeks || [];
  const n = weeks.filter((w) => w.workouts > 0).length;
  const labels = weeks.map((w) => f.dayShort(w.week));
  const bySessions = mode === 'sessions';
  const totalMin = sum(weeks.map((w) => w.minutes));
  const totalN = sum(weeks.map((w) => w.workouts));
  // The averages leave out this week, which is not over.
  const full = weeks.slice(0, -1);
  const fullN = Math.max(1, full.length);
  let top = null;
  for (const w of weeks) if (w.minutes > 0 && (!top || w.minutes > top.minutes)) top = w;
  const reads = weeks.map((w, i) => `Week of ${labels[i]}${i === weeks.length - 1 ? ' (so far)' : ''}: ${w.workouts ? `${f.plural(w.workouts, 'session')}, ${f.dur(w.minutes)}` : 'no sessions'}`);
  const graph = figure(chart((w) => cats({
    w, h: 168, labels, a: weeks.map((x) => (bySessions ? x.workouts : x.minutes / 60)), reads,
    tick: bySessions ? (v) => String(Math.round(v)) : (v) => (v > 0 ? `${num1(v)} h` : '0'),
    label: `${bySessions ? 'Sessions' : 'Training time'} in each of the last 12 weeks. ${f.plural(totalN, 'session')}, ${f.dur(totalMin)} in all.`,
  })), {
    read: `${f.plural(totalN, 'session')} and ${f.dur(totalMin)} in 12 weeks`,
    table: tableAlt(['Week of', 'Sessions', 'Time'], weeks.map((w, i) => [labels[i], f.int(w.workouts), f.dur(w.minutes)]).reverse()),
  });
  return ({
    title: 'Last 12 weeks', fam: 'workouts', icon: 'history', span: 7,
    line: `${f.plural(totalN, 'session')} · ${n} of ${weeks.length} weeks trained`, graph,
    tools: seg('wkmode', [['time', 'Time'], ['sessions', 'Sessions']], mode, { fit: true, label: 'What the bars show' }),
    nums: html`${facts([
        { k: 'Sessions a week', v: num1(sum(full.map((w) => w.workouts)) / fullN), s: 'Average of 11 full weeks' },
        { k: 'Time a week', v: f.dur(sum(full.map((w) => w.minutes)) / fullN), s: 'Average of 11 full weeks' },
        { k: 'Weeks with a session', v: `${n} of ${weeks.length}`, s: n === weeks.length ? 'Not one missed' : `${f.plural(weeks.length - n, 'week')} without` },
        top ? { k: 'Longest week', v: f.dur(top.minutes), s: `Week of ${f.dayShort(top.week)}, ${f.plural(top.workouts, 'session')}` } : null,
      ], { cols: 2, cls: 'facts--s wk-facts4' })}`,
    get body() { return html`${graph}<hr class="rule">${this.nums}`; },
  });
}

function whenMod(t, span = 5) {
  const wd = (t.weekday || []).slice().sort((a, b) => a.dow - b.dow).map((x) => x.workouts);
  const hrs = t.hours || [];
  const total = sum(wd);
  if (total < 3) return ({ title: 'When you train', icon: 'calendar', span, line: 'Needs a few more sessions', body: tooFew(total, 3, 'sessions') });
  const max = Math.max(...wd);
  const days = wd.map((v, i) => (v > 0 && v >= max * 0.6 ? WD3[i] : null)).filter(Boolean);
  let peak = 0;
  hrs.forEach((v, i) => { if (v > hrs[peak]) peak = i; });
  const peakShare = Math.round((hrs[peak] / Math.max(1, sum(hrs))) * 100);
  const best = wd.indexOf(max);
  const tied = wd.map((v, i) => (v === max ? WD3[i] : null)).filter(Boolean);
  const hh = (i) => f.hourLabel(i);
  return ({
    title: 'When you train', fam: 'workouts', icon: 'calendar', span,
    line: `Mostly ${words(days)}, around ${hh(peak)}`,
    note: 'Sessions started, last 12 weeks',
    body: html`
      <p class="wk-say">Mostly <b>${words(days)}</b>, around <b>${hh(peak)}</b>.</p>
      <div class="wk-when">
        <div class="part"><p class="sub">By weekday</p>${figure(chart((w) => cats({
          w, h: 104, labels: WD1, a: wd, mark: tied.length > 1 ? null : best, tick: (v) => String(Math.round(v)),
          reads: wd.map((v, i) => `${WD3[i]}: ${f.plural(v, 'session')}`),
          label: `Sessions by weekday over 12 weeks. ${WD3[best]} has the most, ${f.int(max)}.`,
        })), { read: tied.length > 1 ? `${words(tied)} equally often, ${f.plural(max, 'session')} each` : `${WD3[best]} most often, ${f.plural(max, 'session')}` })}</div>
        <div class="part"><p class="sub">By hour of day</p>${figure(chart((w) => hours({
          w, h: 104, values: hrs, unit: 'sessions', label: `Sessions by the hour they started, over 12 weeks. Most often at ${hh(peak)}.`,
        })), { read: `${peakShare}% start in the hour from ${hh(peak)}` })}</div>
      </div>`,
  });
}

function zonesMod(t, span = 5) {
  const z = t.zones;
  if (!z?.bounds || !z.labels) return '';
  const weeks = t.weeks || [];
  const have = weeks.filter((w) => Array.isArray(w.zonesMin));
  const totals = z.labels.map((_, i) => sum(have.map((w) => w.zonesMin[i])));
  const all = sum(totals);
  const labels = weeks.map((w) => f.dayShort(w.week));
  const body = have.length && all > 0
    ? html`${figure(chart((w) => stacked({
        w, h: 168, labels, unit: 'min',
        series: z.labels.map((l, i) => ({ label: l, cls: ZK[i], values: weeks.map((x) => (x.zonesMin ? x.zonesMin[i] : null)) })),
        label: `Minutes in each heart-rate zone per week. ${z.labels.map((l, i) => `${l} ${f.dur(totals[i])}`).join(', ')}.`,
      })), { read: `${f.dur(all)} with heart rate, in ${f.plural(have.length, 'week')}` })}
      ${zoneTable(z, totals)}`
    : html`<p class="wk-say wk-say--quiet">No session has its heart rate loaded yet. Open one and its minutes in each zone are kept from then on.</p>
      ${zoneTable(z)}`;
  return ({
    title: 'Heart-rate zones', fam: 'heart', icon: 'heart', span, note: 'Minutes a week in each zone',
    line: have.length && all > 0 ? `${f.dur(all)} with heart rate in ${f.plural(have.length, 'week')}` : 'Your zones; minutes fill in as sessions load',
    body: html`${body}<p class="chart__note wk-note">${z.note}${/[.!?]$/.test(z.note || '') ? '' : '.'}${have.length ? ' Only sessions whose heart rate has been loaded are counted.' : ''}</p>`,
  });
}

/* ── list: strength ─────────────────────────────────────────── */

function volumeMod(d, span = 7) {
  const t = d.training;
  const weeks = t.weeks || [];
  const labels = weeks.map((w) => f.dayShort(w.week));
  const cur = weeks[weeks.length - 1] || {};
  let top = null;
  for (const w of weeks) if (w.volumeKg > 0 && (!top || w.volumeKg > top.volumeKg)) top = w;
  const topMuscle = (w) => {
    const e = Object.entries(w.byMuscle || {}).sort((a, b) => b[1] - a[1])[0];
    return e && e[1] > 0 ? `, most on ${MUSCLE[e[0]]?.toLowerCase() || e[0]}` : '';
  };
  const graph = figure(chart((w) => cats({
        w, h: 168, labels, a: weeks.map((x) => volV(x.volumeKg || 0)),
        reads: weeks.map((x, i) => `Week of ${labels[i]}${i === weeks.length - 1 ? ' (so far)' : ''}: ${x.sets ? `${vol(x.volumeKg)} in ${f.plural(x.sets, 'set')}${topMuscle(x)}` : 'no sets'}`),
        label: `Strength volume in each of the last 12 weeks, in ${volU() === 't' ? 'tonnes' : volU()}.`,
      })), {
        read: `${vol(cur.volumeKg || 0)} this week so far`,
        table: tableAlt(['Week of', 'Sets', `Volume (${volU()})`], weeks.map((x, i) => [labels[i], f.int(x.sets), volNum(x.volumeKg)]).reverse()),
      });
  return ({
    title: 'Strength volume', fam: 'workouts', icon: 'strength', span,
    line: `${vol(cur.volumeKg || 0)} this week${f.isNum(t.week?.avg4?.volumeKg) ? ` · usual ${vol(t.week.avg4.volumeKg)}` : ''}`,
    note: `Weight × reps a week, in ${volU() === 't' ? 'tonnes' : volU()}`,
    graph,
    body: html`
      ${graph}
      <hr class="rule">
      ${facts([
        { k: 'Sets a week', v: num1(d.strength?.setsPerWeek ?? t.week?.avg4?.sets), s: 'Average of the last 4 full weeks' },
        { k: 'Volume a week', v: volNum(t.week?.avg4?.volumeKg), u: volU(), s: 'Average of the last 4 full weeks' },
        top ? { k: 'Heaviest week', v: volNum(top.volumeKg), u: volU(), s: `Week of ${f.dayShort(top.week)}` } : null,
      ], { cols: 3, cls: 'facts--s' })}`,
  });
}

function balanceMod(t, span = 6) {
  const rows = (t.balance || []).filter((b) => b.sets4w > 0 || f.isNum(b.daysSince));
  if (!rows.length) return '';
  const max = Math.max(1, ...rows.map((b) => b.sets4w));
  const stale = rows.filter((b) => b.muscle !== 'other' && f.isNum(b.daysSince) && b.daysSince >= 10);
  const names = (list) => { const s = words(list.map((b) => (MUSCLE[b.muscle] || b.muscle).toLowerCase())); return s.charAt(0).toUpperCase() + s.slice(1); };
  const lead = rows.filter((b) => b.sets4w > 0).sort((a, b) => b.sets4w - a.sets4w).slice(0, 2);
  const say = [
    lead.length ? `${names(lead)} ${lead.length > 1 ? 'take' : 'takes'} the most sets.` : '',
    stale.length ? `${names(stale)} ${stale.length > 1 ? 'have' : 'has'} gone 10 days or more without a set.` : 'Every group has been trained in the last 10 days.',
  ].filter(Boolean).join(' ');
  return ({
    title: 'Muscle balance', fam: 'workouts', icon: 'target', span, note: 'Sets in the last 4 weeks',
    line: stale.length ? `${names(stale)}: 10 days or more without a set` : lead.length ? `Most sets: ${words(lead.map((b) => (MUSCLE[b.muscle] || b.muscle).toLowerCase()))}` : 'Sets by muscle group',
    body: html`
      <p class="wk-say wk-say--quiet">${say}</p>
      <ul class="bals">${rows.map((b) => {
        const old = b.muscle !== 'other' && f.isNum(b.daysSince) && b.daysSince >= 10;
        return html`<li class="bal">
          <span class="bal__k">${MUSCLE[b.muscle] || b.muscle}</span>
          <span class="bal__v">${f.plural(b.sets4w, 'set')}<span class="bal__p">${b.sets4w > 0 ? `${Math.round(b.sharePct)}%` : ''}</span></span>
          <span class="bal__bar" aria-hidden="true"><span class="bal__f" data-style="--f:${(b.sets4w / max).toFixed(3)}"></span></span>
          <span class="bal__d ${old ? 'bal__d--old' : ''}">${old ? html`${ic('alert', { size: 's' })}Not trained for ${f.int(b.daysSince)} days` : f.isNum(b.daysSince) ? `Last trained ${since(b.daysSince)}` : 'Never trained'}</span>
        </li>`;
      })}</ul>`,
  });
}

function recordsMod(t, span = 6) {
  const groups = [];
  const seen = new Map();
  for (const p of t.prs || []) {
    const key = `${p.exercise}|${p.at}`;
    let g = seen.get(key);
    if (!g) { g = { exercise: p.exercise, muscle: p.muscle, date: p.date, workoutId: p.workoutId }; seen.set(key, g); groups.push(g); }
    g[p.kind] = p;
  }
  const shown = groups.slice(0, 6);
  const body = shown.length
    ? html`<div class="recs">${shown.map((g) => {
        const main = g.weight || g.e1rm;
        const bits = [f.dayMed(g.date)];
        if (g.weight) bits.push(`was ${wt(g.weight.previous)}`);
        if (g.e1rm) bits.push(g.weight ? `estimated 1RM ${wnum(g.e1rm.value)}, was ${wnum(g.e1rm.previous)}` : `estimated 1RM, was ${wt(g.e1rm.previous)}`);
        const inner = html`${ib('record')}
          <span class="recrow__b"><span class="recrow__t">${g.exercise}</span><span class="recrow__d">${bits.join(' · ')}</span></span>
          <span class="recrow__v">${wnum(main.value)}<span class="stat__u">${f.weightUnit()}</span></span>
          ${g.workoutId ? html`<span class="row__chev">${ic('right', { size: 's' })}</span>` : ''}`;
        return g.workoutId ? html`<a class="recrow" href="/workouts/${encodeURIComponent(g.workoutId)}">${inner}</a>` : html`<div class="recrow">${inner}</div>`;
      })}</div>${groups.length > shown.length ? html`<p class="chart__note wk-note">And ${f.int(groups.length - shown.length)} more in the same 30 days.</p>` : ''}`
    : html`<p class="wk-say wk-say--quiet">No records in the last 30 days. A record is a heavier top set, or a better estimated one-rep max, than in any earlier session.</p>`;
  return ({
    title: 'Records', fam: 'workouts', icon: 'record', span,
    line: groups.length ? `${f.plural(groups.length, 'lift')} improved in 30 days` : 'None in the last 30 days',
    note: groups.length ? `${f.plural(groups.length, 'lift')} improved in the last 30 days` : 'Last 30 days',
    body,
  });
}

const lastWith = (x, key) => [...(x.sessions || [])].reverse().find((s) => f.isNum(s[key])) || null;

function progressMod(t, span = 12) {
  const list = (t.exercises || []).filter((x) => x.sessions?.length);
  if (!list.length) return '';
  return ({
    title: 'Progress by exercise', fam: 'workouts', icon: 'trends', span,
    line: (() => { const up = list.filter((x) => f.isNum(x.changePct) && x.changePct >= 0.5).length; return `${f.plural(list.length, 'exercise')}${up ? ` · ${up} going up` : ''}`; })(),
    note: 'Estimated one-rep max by session (the top set when reps are too high). Tap one for its history.',
    body: html`<div class="exrows">${list.map((x, i) => {
      const top = lastWith(x, 'topKg');
      const e = lastWith(x, 'e1rm');
      const byTop = !e;
      const vals = x.sessions.map((s) => (byTop ? s.topKg : s.e1rm));
      const change = f.isNum(x.changePct)
        ? (Math.abs(x.changePct) < 0.5
          ? html`<span class="delta">${ic('flat', { size: 's' })}<span>Level</span></span>`
          : html`<span class="delta ${x.changePct > 0 ? 'delta--good' : ''}">${ic(x.changePct > 0 ? 'up' : 'down', { size: 's' })}<span>${num1(Math.abs(x.changePct))}%</span></span>`)
        : html`<span class="muted">${byTop ? 'Top set' : f.plural(x.sessions.length, 'session')}</span>`;
      return html`<button type="button" class="exrow" data-ex="${i}">
        <span class="exrow__b"><span class="exrow__t">${x.name}</span><span class="exrow__d">${[MUSCLE[x.muscle] || '', top ? `last ${wnum(top.topKg)} ${f.weightUnit()} × ${f.int(top.topReps)}` : '', f.isNum(x.bestKg) ? `best ${wt(x.bestKg)}` : ''].filter(Boolean).join(' · ')}</span></span>
        <span class="exrow__g">${vals.filter(f.isNum).length >= 2 ? chart((w) => spark({ w, h: 36, values: vals, label: `${byTop ? 'Heaviest set' : 'Estimated one-rep max'} for ${x.name} over ${x.sessions.length} sessions` })) : ''}</span>
        <span class="exrow__v"><span class="exrow__n">${e ? wnum(e.e1rm) : top ? wnum(top.topKg) : f.DASH}<span class="stat__u">${f.weightUnit()}</span></span><span class="exrow__c">${change}</span></span>
        <span class="row__chev">${ic('right', { size: 's' })}</span>
      </button>`;
    })}</div>`,
  });
}

/** One exercise's e1RM over its sessions: a line, each session a dot. */
function sessionLine({ w, h = 190, dates, values, label }) {
  const pts = values.map((v, i) => (f.isNum(v) ? i : -1)).filter((i) => i >= 0);
  if (pts.length < 2) return '';
  const have = pts.map((i) => values[i]);
  let lo = Math.min(...have); let hi = Math.max(...have);
  if (hi === lo) { hi += 1; lo -= 1; }
  const padv = (hi - lo) * 0.14; lo -= padv; hi += padv;
  const l = 40; const r = 14; const top = 14; const bot = 24;
  const iw = w - l - r; const ih = h - top - bot; const n = values.length;
  const x = (i) => Math.round((l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1))) * 10) / 10;
  const y = (v) => Math.round((top + ih - ((v - lo) / (hi - lo)) * ih) * 10) / 10;
  let s = '';
  for (let k = 0; k <= 2; k += 1) {
    const v = lo + ((hi - lo) * k) / 2;
    s += `<line class="${k === 0 ? 'c-axis' : 'c-grid'}" x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(num1(Math.round(v * 2) / 2))}</text>`;
  }
  s += `<path class="c-line" d="${pts.map((i, k) => `${k ? 'L' : 'M'}${x(i)},${y(values[i])}`).join('')}"/>`;
  let best = pts[0];
  for (const i of pts) if (values[i] > values[best]) best = i;
  const last = pts[pts.length - 1];
  for (const i of pts) if (i !== last) s += `<circle class="c-dot--s" cx="${x(i)}" cy="${y(values[i])}" r="2.5"/>`;
  s += `<circle class="c-dot" cx="${x(last)}" cy="${y(values[last])}" r="4.5"/>`;
  const bx = x(best);
  s += `<text class="c-mk" x="${bx}" y="${Math.max(11, y(values[best]) - 9)}" text-anchor="${bx < l + 40 ? 'start' : bx > w - r - 40 ? 'end' : 'middle'}">${esc(`Best ${num1(values[best])}`)}</text>`;
  s += `<text x="${l}" y="${h - 6}" text-anchor="start">${esc(f.dayShort(dates[0]))}</text><text x="${w - r}" y="${h - 6}" text-anchor="end">${esc(f.dayShort(dates[n - 1]))}</text>`;
  const hw = n <= 1 ? iw : iw / (n - 1);
  values.forEach((v, i) => {
    s += `<rect class="c-hit" data-read="${esc(`${f.dayMed(dates[i])}: ${f.isNum(v) ? `${num1(v)} ${f.weightUnit()}` : 'no counted set'}`)}" x="${Math.max(0, x(i) - hw / 2)}" y="${top}" width="${Math.max(1, hw)}" height="${ih}"/>`;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${s}</svg>`;
}

function exerciseSheet(x) {
  const ses = x.sessions || [];
  const e = lastWith(x, 'e1rm');
  const top = lastWith(x, 'topKg');
  // Sets of more than 12 reps give no estimate: such a lift is read by its top set.
  const byTop = !e;
  const what = byTop ? 'Heaviest set' : 'Estimated one-rep max';
  const vals = ses.map((s) => { const v = byTop ? s.topKg : s.e1rm; return f.isNum(v) ? f.weightVal(v) : null; });
  const enough = vals.filter(f.isNum).length >= 2;
  sheet({
    title: x.name,
    body: html`<div class="stack stack--l fam fam-workouts exsheet">
      ${facts([
        byTop
          ? { k: 'Top set now', v: top ? wnum(top.topKg) : f.DASH, u: top ? f.weightUnit() : '', s: top ? `${f.int(top.topReps)} reps. Too many for an estimated one-rep max` : '' }
          : { k: 'Estimated 1RM now', v: e ? wnum(e.e1rm) : f.DASH, u: e ? f.weightUnit() : '', s: f.isNum(x.changePct) ? `${x.changePct > 0 ? 'Up' : x.changePct < 0 ? 'Down' : 'Level,'} ${num1(Math.abs(x.changePct))}% from the first three sessions shown to the last three` : 'Six sessions are needed for a change' },
        byTop
          ? { k: 'Heaviest ever', v: f.isNum(x.bestKg) ? wnum(x.bestKg) : f.DASH, u: f.isNum(x.bestKg) ? f.weightUnit() : '', s: f.plural(ses.length, 'session') }
          : { k: 'Best ever', v: f.isNum(x.bestE1rm) ? wnum(x.bestE1rm) : f.DASH, u: f.isNum(x.bestE1rm) ? f.weightUnit() : '', s: f.isNum(x.bestKg) ? `Heaviest set ${wt(x.bestKg)}` : '' },
      ], { cols: 2 })}
      ${enough
        ? figure(chart((w) => sessionLine({ w, dates: ses.map((s) => s.date), values: vals, label: `${what} for ${x.name} over ${ses.length} sessions, from ${num1(vals.find(f.isNum))} to ${num1([...vals].reverse().find(f.isNum))} ${f.weightUnit()}` })), {
          read: `${f.plural(ses.length, 'session')}, ${f.dayShort(ses[0].date)} to ${f.dayShort(ses[ses.length - 1].date)}`,
          note: byTop ? 'The heaviest set of each session. Warm-up sets do not count.' : 'Estimated one-rep max is weight × (1 + reps ÷ 30), from sets of 1 to 12 reps. Warm-up sets do not count.',
        })
        : tooFew(vals.filter(f.isNum).length, 2, 'sessions')}
      <div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table class="data">
        <thead><tr><th scope="col">Session</th><th scope="col" class="n">Top set</th><th scope="col" class="n">Est. 1RM</th><th scope="col" class="n">Sets</th><th scope="col" class="n">Volume (${volU()})</th></tr></thead>
        <tbody>${[...ses].reverse().map((s) => html`<tr>
          <td class="nw">${f.dayMed(s.date)}</td>
          <td class="n nw">${f.isNum(s.topKg) ? `${wnum(s.topKg)} ${f.weightUnit()} × ${f.int(s.topReps)}` : f.DASH}</td>
          <td class="n">${f.isNum(s.e1rm) ? wnum(s.e1rm) : f.DASH}</td>
          <td class="n">${f.int(s.sets)}</td>
          <td class="n">${volNum(s.volumeKg)}</td>
        </tr>`)}</tbody>
      </table></div>
    </div>`,
  });
}

/* ── list: sessions ─────────────────────────────────────────── */

/** Sessions shown before "Show older": about three weeks of training. */
const FIRST = 12;

function emptyMod(d) {
  return mod({
    fam: 'workouts', span: 12, label: 'No workouts yet',
    body: html`<div class="empty wk-empty">
      ${ib('strength', { size: 'l' })}
      <p class="empty__t">No workouts yet</p>
      <p class="empty__d">Start one when you begin training, log one you already did, or bring your history in from Hevy. Workouts your watch records show up here by themselves. Once there are a few, this page shows your week against your usual, twelve weeks of training and where your time goes.</p>
      <div class="btnrow wk-empty__act">
        ${!d.running ? html`<button type="button" class="btn" data-action="start">${ic('play', { size: 's' })}Start workout</button>` : ''}
        <button type="button" class="btn btn--tonal" data-action="log">${ic('plus', { size: 's' })}Log a past one</button>
        <a class="btn btn--tonal" href="/workouts/import">${ic('upload', { size: 's' })}Import from Hevy</a>
      </div>
    </div>`,
  });
}

/* ── list: log a past workout ───────────────────────────────── */

function logSheet(d, done) {
  const now = Date.now();
  const s = sheet({
    title: 'Log a past workout',
    body: html`<form class="form ex-form" id="log-form" novalidate>
      <div data-slot="error"></div>
      ${field({ label: 'Started', name: 'start', type: 'datetime-local', value: f.toLocalInput(now - 75 * 60000), attrs: 'required step="60"' })}
      ${field({ label: 'Ended', name: 'end', type: 'datetime-local', value: f.toLocalInput(now - 15 * 60000), attrs: 'required step="60"' })}
      <details class="ex-more">
        <summary><span class="ex-more__b"><span class="ex-more__t">More</span><span class="ex-more__s">Name, kind, notes</span></span>${ic('right', { size: 's' })}</summary>
        <div class="ex-more__in">
          ${field({ label: 'Name (optional)', name: 'title', attrs: 'maxlength="80" autocomplete="off" placeholder="Push day"' })}
          ${d.exerciseTypes?.length ? field({ label: 'Kind', name: 'type', value: d.exerciseType, options: d.exerciseTypes.map((t) => [t.id, t.label]) }) : ''}
          ${field({ label: 'Notes (optional)', name: 'notes', type: 'textarea', attrs: 'maxlength="2000" rows="3"' })}
          <p class="entry__note">${ic(d.canWrite ? 'link' : 'lock', { size: 's' })}<span>${d.canWrite ? 'Saved to Google Health as well.' : 'Kept in this app only. Reconnect Google to save workouts there too.'}</span></p>
        </div>
      </details>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="log-form">Save workout</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    fieldError(form, 'start', ''); fieldError(form, 'end', '');
    const start = f.fromLocalInput(v.start); const end = f.fromLocalInput(v.end);
    if (!start) { fieldError(form, 'start', 'Enter when it started.'); return; }
    if (!end) { fieldError(form, 'end', 'Enter when it ended.'); return; }
    if (end <= start) { fieldError(form, 'end', 'The end has to be after the start.'); return; }
    if (end > Date.now() + 60000) { fieldError(form, 'end', 'The end cannot be in the future.'); return; }
    const mins = (end - start) / 60000;
    if (mins < 5 || mins > 360) { fieldError(form, 'end', 'A workout has to be between 5 minutes and 6 hours.'); return; }
    try {
      const payload = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/workouts/log', {
        start, end, ...(v.title?.trim() ? { title: v.title.trim() } : {}), ...(v.notes?.trim() ? { notes: v.notes.trim() } : {}), ...(v.type ? { type: v.type } : {}),
      }));
      if (payload === undefined) return;
      s.close();
      toast('Workout saved');
      done(payload);
    } catch (err) {
      mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err, 'Could not save the workout. Try again.') }));
    }
  });
}

/* ── Train, the first screen (2026-10-31 redesign) ─────────────
   Start fast: two big tiles (an empty workout, a route), then your
   routines with a play button; the week as one divided strip; recent
   sessions as a quiet list. Routines, Progress and History are one tap
   away at the top; the tools (import, detection, the exercise library,
   logging a past one) sit below. */

/** Minutes as "58 min" or "1 h 04". */
const durTight = (min) => { const p = f.durParts(min); if (!p) return f.DASH; return p.h ? `${p.h} h ${String(p.m).padStart(2, '0')}` : `${p.m} min`; };
const isRoute = (w) => Boolean(w.gps || w.track) || /RUN|WALK|HIK|BIK|CYCL|RIDE/.test(String(w.type || '').toUpperCase()) && !w.sets;
const signedN = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.int(Math.abs(v))}`;

/** The running workout, Today's card, when Me puts it on Train. */
function trainWcard(r) {
  const name = r.title && r.title !== 'Workout' ? r.title : 'Workout';
  const prog = r.logging && f.isNum(r.exercises) ? ` · ${r.done ?? 0} of ${r.exercises}` : '';
  return html`<section class="wcard trn-wcard" data-wid="${r.id}" aria-label="Workout in progress">
    <span class="wcard__ic">${ic('dumbbell')}</span>
    <div class="trn-wcard__mid">
      <p class="wcard__name"><span class="wcard__dot"></span>${name}<span>${prog}</span></p>
      <p class="wcard__time"><span class="n" data-timer="${r.start}" role="timer" aria-live="off">${f.stopwatch(Date.now() - r.start)}</span><span class="wcard__hr" data-live-bpm></span></p>
    </div>
    <div class="wcard__btns">
      <a class="pill-btn pill-btn--ghost" href="/workouts/${encodeURIComponent(r.id)}">Open</a>
      <button type="button" class="pill-btn pill-btn--light" data-wact="end">Finish</button>
    </div>
  </section>`;
}

/** A question about a workout: Yes / No here, the rest (adjust the times) on its page. */
function trainAsk(w) {
  const end = w.end ?? w.lastEnd;
  const day = f.instDay(w.start) !== f.today() ? f.dayRel(f.instDay(w.start)) : 'Today';
  const q = w.status === 'ongoing' ? `Workout started at ${f.clock(w.start)}?` : `Was ${f.clock(w.start)} to ${f.clock(end)} a workout?`;
  return html`<section class="wask trn-ask" data-wid="${w.id}" aria-label="Question about a workout">
    <a class="trn-ask__q" href="/workouts/${encodeURIComponent(w.id)}"><p class="wask__k">${day}${f.isNum(w.avgHr) ? ` · average ${Math.round(w.avgHr)} bpm` : ''}</p><p class="wask__q">${q}</p></a>
    <div class="wcard__btns">
      <button type="button" class="pill-btn pill-btn--ink" data-wact="${w.status === 'ongoing' ? 'confirm' : 'save'}">Yes</button>
      <button type="button" class="pill-btn pill-btn--soft" data-wact="dismiss">No</button>
    </div>
  </section>`;
}

function startTiles(d, rts) {
  const r = d.running;
  const all = rts?.routines || [];
  const top = all.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.position - b.position).slice(0, 2);
  const empty = r
    ? html`<a class="bt bt--energy trn-start" href="/workouts/${encodeURIComponent(r.id)}">
        <span class="bt__ic">${ic('dumbbell')}</span>
        <div><p class="trn-start__t">Workout running</p><p class="bt__sub"><span data-timer="${r.start}">${f.stopwatch(Date.now() - r.start)}</span> · tap to open</p></div>
      </a>`
    : html`<button type="button" class="bt bt--energy trn-start" data-go-routine="">
        <span class="bt__ic">${ic('dumbbell')}</span>
        <div><p class="trn-start__t">Empty workout</p><p class="bt__sub">Add exercises as you go</p></div>
      </button>`;
  const route = html`<a class="bt bt--active trn-start" href="/workouts/record">
    <span class="bt__ic">${ic('route')}</span>
    <div><p class="trn-start__t">Record route</p><p class="bt__sub">Run, walk or ride</p></div>
  </a>`;
  const rt = (x) => html`<div class="bt bt--plain trn-rt">
    <a class="trn-rt__b" href="/workouts/routines/${encodeURIComponent(x.id)}"><span class="trn-rt__t">${x.title}</span><span class="trn-rt__s">${[f.plural(x.exercises, 'exercise'), x.exercises && f.isNum(x.estimateMin) ? `${f.int(x.estimateMin)} min` : ''].filter(Boolean).join(' · ')}</span></a>
    <button type="button" class="b-play" data-go-routine="${x.id}" ${x.exercises && !r ? '' : 'disabled'} aria-label="Start ${x.title}">${ic('play')}</button>
  </div>`;
  const fill = top.length >= 2 ? '' : html`
    ${top.length ? '' : html`<a class="bt bt--plain trn-rt" href="/workouts/routines"><span class="trn-rt__b"><span class="trn-rt__t">Routines</span><span class="trn-rt__s">Plan a session</span></span><span class="b-play">${ic('plus')}</span></a>`}
    <a class="bt bt--plain trn-rt" href="/workouts/exercises"><span class="trn-rt__b"><span class="trn-rt__t">Exercises</span><span class="trn-rt__s">Browse the library</span></span><span class="b-play">${ic('book')}</span></a>`;
  return html`<div class="bento trn-grid">${empty}${route}${top.map(rt)}${fill}</div>`;
}

function weekStrip(d) {
  const t = d.training || {};
  const wk = t.week;
  if (!wk) return '';
  const weeks = t.weeks || [];
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  const a = wk.avg4 || {};
  const up = (txt) => html`<b class="trn-up">${txt}</b>`;
  const down = (txt) => html`<b class="trn-down">${txt}</b>`;
  const mark = (v, txt) => (v > 0 ? up(txt) : v < 0 ? down(txt) : html`<b>${txt}</b>`);
  let sessLine = 'this week so far';
  if (prev) { const dn = wk.workouts - prev.workouts; sessLine = dn ? html`${mark(dn, signedN(dn))} vs last week` : 'same as last week'; }
  let timeLine = 'this week so far';
  if (prev && prev.minutes > 0) { const p = Math.round(((wk.minutes - prev.minutes) / prev.minutes) * 100); timeLine = Math.abs(p) < 1 ? 'same as last week' : html`${mark(p, `${signedN(p)} %`)} vs last week`; }
  const hasVol = (wk.volumeKg || 0) > 0 || (a.volumeKg || 0) > 0;
  let third;
  if (hasVol) {
    let line = 'no usual yet';
    if ((a.volumeKg || 0) > 0) { const p = Math.round(((wk.volumeKg - a.volumeKg) / a.volumeKg) * 100); line = Math.abs(p) <= 5 ? 'your usual' : html`${mark(p, `${signedN(p)} %`)} on usual`; }
    third = html`<div><p class="trn-wk__k">Volume</p><p class="n n-s">${volNum(wk.volumeKg || 0)}<span class="u">${volU()}</span></p><p class="trn-wk__s">${line}</p></div>`;
  } else {
    third = html`<div><p class="trn-wk__k">Usual week</p><p class="n n-s">${num1(a.workouts || 0)}</p><p class="trn-wk__s">sessions</p></div>`;
  }
  const p = f.durParts(wk.minutes || 0);
  return html`<a class="bt bt--plain trn-wk" href="/workouts?view=progress" aria-label="This week: ${f.plural(wk.workouts, 'session')}, ${f.dur(wk.minutes)}${hasVol ? `, ${vol(wk.volumeKg || 0)} lifted` : ''}. Open your progress.">
    <div><p class="trn-wk__k">Sessions</p><p class="n n-s" data-count>${f.int(wk.workouts)}</p><p class="trn-wk__s">${sessLine}</p></div>
    <div><p class="trn-wk__k">Time</p><p class="n n-s">${p.h ? html`${p.h}<span class="u">h</span>&thinsp;${String(p.m).padStart(2, '0')}` : html`${p.m}<span class="u">min</span>`}</p><p class="trn-wk__s">${timeLine}</p></div>
    ${third}
  </a>`;
}

/** One session in a quiet list. */
function recentRow(w, d) {
  const route = isRoute(w);
  const title = workoutTitle(w, d.exerciseTypes);
  const day = f.dayRel(f.instDay(w.start));
  const distM = w.gps?.distanceM ?? w.track?.distanceM ?? null;
  const meta = [day, f.isNum(distM) ? f.dist(distM) : '', w.sets?.sets ? f.plural(w.sets.sets, 'set') : '', f.isNum(w.avgHr) ? `${Math.round(w.avgHr)} bpm` : ''].filter(Boolean).slice(0, 3).join(' · ');
  return html`<li><a class="trn-ses" href="/workouts/${encodeURIComponent(w.id)}">
    <span class="trn-ses__ic ${route ? 'c-active' : 'c-energy'}">${ic(route ? 'route' : typeIcon(w) === 'strength' ? 'dumbbell' : typeIcon(w))}</span>
    <span class="trn-ses__b"><span class="trn-ses__t"><span class="trn-ses__name">${title}</span>${w.prCount > 0 ? html`<span class="trn-pill">${f.plural(w.prCount, 'PR')}</span>` : ''}</span><span class="trn-ses__s">${meta}</span></span>
    <b class="n trn-ses__v">${durTight(w.durationMin)}</b>
  </a></li>`;
}

/** One session in History: the day and time, sets or distance, its length. */
function historyRow(w, d) {
  const route = isRoute(w);
  const day = f.instDay(w.start);
  const distM = w.gps?.distanceM ?? w.track?.distanceM ?? null;
  const meta = [`${f.dow(day)} ${f.dom(day)}`, f.clock(w.start), f.isNum(distM) ? f.dist(distM) : '', w.sets?.sets ? f.plural(w.sets.sets, 'set') : '', w.sets?.volumeKg ? vol(w.sets.volumeKg) : f.isNum(w.avgHr) ? `${Math.round(w.avgHr)} bpm` : ''].filter(Boolean).join(' · ');
  return html`<li><a class="trn-ses" href="/workouts/${encodeURIComponent(w.id)}">
    <span class="trn-ses__ic ${route ? 'c-active' : 'c-energy'}">${ic(route ? 'route' : typeIcon(w) === 'strength' ? 'dumbbell' : typeIcon(w))}</span>
    <span class="trn-ses__b"><span class="trn-ses__t"><span class="trn-ses__name">${workoutTitle(w, d.exerciseTypes)}</span>${w.prCount > 0 ? html`<span class="trn-pill">${f.plural(w.prCount, 'PR')}</span>` : ''}</span><span class="trn-ses__s">${meta}</span></span>
    <b class="n trn-ses__v">${durTight(w.durationMin)}</b>
  </a></li>`;
}

function moreRows(d) {
  const det = d.detection || {};
  return html`<div class="bsec"><h2>More</h2></div>
    <div class="blist trn-more">
      ${row({ action: 'log', iconName: 'clock', title: 'Log a past workout', text: 'One you did without starting it here' })}
      ${row({ href: '/workouts/exercises', iconName: 'book', title: 'Exercise library', text: 'Every exercise, how to do it' })}
      ${row({ href: '/workouts/import', iconName: 'upload', title: 'Import from Hevy', text: 'Your exercises and sets from a Hevy export' })}
      ${row({ href: '/workouts/record', iconName: 'map', title: 'Import a GPX file', text: 'On the Record route screen' })}
      ${row({ href: '/workouts/detection', iconName: 'wave', title: 'Detection', text: !det.available ? 'Not available on your device' : det.suppressedByLink ? 'Handled by the console module' : det.settings?.enabled ? 'On: asks when your heart rate looks like a workout' : 'Off: you start and log workouts yourself', value: det.available && !det.suppressedByLink ? html`<span class="badge ${det.settings?.enabled ? 'badge--accent' : ''}">${det.settings?.enabled ? 'On' : 'Off'}</span>` : '' })}
      ${row({ href: '/settings/connections/accounts', iconName: 'link', title: 'Hevy and Strava', text: [app.me.hevy?.connected ? 'Hevy linked' : '', app.me.strava?.connected ? 'Strava linked' : ''].filter(Boolean).join(', ') || 'Link them to bring workouts in and send them out' })}
    </div>`;
}

function trainHome(d, history, rts) {
  const ws = d.training?.week?.start || f.weekStart(f.today());
  const kick = `Week of ${f.dayLong(ws).split(' ').slice(1).join(' ')}`;
  const recent = history.slice(0, 4);
  const showCard = d.running && workoutCardOn() === 'train';
  return html`
    ${head({ title: 'Train', kick })}
    <nav class="trn-links" aria-label="Train">
      <a class="press" href="/workouts/routines">Routines${ic('chev_r', { size: 's' })}</a>
      <a class="press" href="/workouts?view=progress">Progress${ic('chev_r', { size: 's' })}</a>
      <a class="press" href="/workouts?view=history">History${ic('chev_r', { size: 's' })}</a>
    </nav>
    <div class="stack trn">
      ${connectionBanner('/workouts')}
      ${/* Only when something logged here is waiting: reading Google alone needs no write permission, so nothing to warn about. */ ''}
      ${d.needsReconnect && d.unsaved > 0 ? banner({ tone: 'warn', iconName: 'key', title: 'Workouts are not reaching Google Health', text: `Reconnect to allow saving workouts. ${f.plural(d.unsaved, 'workout')} ${d.unsaved === 1 ? 'is' : 'are'} waiting.`, actions: html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="/workouts">Reconnect Google</button>` }) : ''}
      ${showCard ? trainWcard(d.running) : ''}
      ${(d.pending || []).map(trainAsk)}
      ${startTiles(d, rts)}
      ${weekStrip(d)}
      ${recent.length ? html`<div class="bsec"><h2>Recent</h2><a href="/workouts?view=history">All</a></div>
        <ul class="blist trn-recent">${recent.map((w) => recentRow(w, d))}</ul>`
        : html`<div class="bt bt--plain trn-none"><p class="trn-none__t">No workouts yet</p><p class="bt__sub">Start one above, log one you already did, or bring your history in from Hevy. Workouts your watch records show up here by themselves.</p></div>`}
      ${moreRows(d)}
    </div>`;
}

/** A small area chart along a route: elevation or speed against distance. */
function alongChart({ series, idx, label, unit, fmt = (v) => String(Math.round(v)), cls = '' }) {
  const pts = series.filter((r) => f.isNum(r[idx]));
  if (pts.length < 4) return '';
  const W = 600; const H = 120; const pad = 4;
  const xs = pts.map((r) => r[0]); const ys = pts.map((r) => r[idx]);
  const x0 = xs[0]; const x1 = xs[xs.length - 1] || 1;
  let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
  const X = (v) => pad + ((v - x0) / (x1 - x0 || 1)) * (W - pad * 2);
  const Y = (v) => H - pad - ((v - y0) / (y1 - y0)) * (H - pad * 2);
  const line = pts.map((r, i) => `${i ? 'L' : 'M'}${X(r[0]).toFixed(1)},${Y(r[idx]).toFixed(1)}`).join('');
  return html`<figure class="along ${cls}">
    <figcaption class="along__k"><span>${label}</span><span class="muted">${fmt(y0)} to ${fmt(y1)} ${unit}</span></figcaption>
    ${raw(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} from ${esc(fmt(y0))} to ${esc(fmt(y1))} ${esc(unit)} along the route"><path class="along__a" d="${line}L${X(x1).toFixed(1)},${H}L${X(x0).toFixed(1)},${H}Z"/><path class="along__l" d="${line}"/></svg>`)}
  </figure>`;
}

const paceText = (sPerKm) => { if (!f.isNum(sPerKm) || sPerKm <= 0) return f.DASH; const s = f.distUnit() === 'mi' ? sPerKm * 1.609344 : sPerKm; const v = Math.round(s); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };
const hmsS = (sec) => { const v = Math.round(sec); const h = Math.floor(v / 3600); const m = Math.floor((v % 3600) / 60); return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(v % 60).padStart(2, '0')}`; };
const speedText = (kmh) => (f.isNum(kmh) ? (f.distUnit() === 'mi' ? kmh / 1.609344 : kmh).toFixed(1) : f.DASH);

async function list(ctx) {
  const { root } = ctx;
  const view = ['progress', 'history'].includes(ctx.query.get('view')) ? ctx.query.get('view') : '';
  const TITLE = { progress: 'Progress', history: 'History' };
  document.title = `${TITLE[view] || 'Train'} · Health`;
  let d = null; let history = []; let stopTimers = null; let mode = 'time'; let visible = view === 'history' ? 40 : FIRST; let rts = null;
  const top = () => (view ? head({ title: TITLE[view], back: '/workouts', actions: view === 'history' ? html`<button type="button" class="btn btn--tonal btn--s" data-action="log">${ic('plus', { size: 's' })}Log one</button>` : '' }) : head({ title: 'Train', kick: `Week of ${f.dayLong(f.weekStart(f.today())).split(' ').slice(1).join(' ')}` }));

  /** Progress: the week at a glance, one chart, then a row into each analysis. */
  function progress() {
    const t = d.training || {};
    const weeks = t.weeks || [];
    const hasAny = history.length > 0 || weeks.some((w) => w.workouts > 0);
    if (!hasAny) return html`${top()}<div class="stack trn-deep">${grid(emptyMod(d), 'wkg')}</div>`;
    const hasSets = weeks.some((w) => w.sets > 0) || (t.exercises || []).length > 0 || (t.prs || []).length > 0;
    if (mode === 'volume' && !hasSets) mode = 'time';
    const wk = t.week || {};
    const a = wk.avg4 || {};
    const known = (a.workouts || 0) > 0;
    const p = f.durParts(wk.minutes || 0) || { h: 0, m: 0 };
    const cmp = (cur, avg, tol, fmt) => {
      if (!known || !f.isNum(cur) || !f.isNum(avg)) return 'no usual yet';
      const dv = cur - avg;
      return Math.abs(dv) < tol ? 'your usual' : `${fmt(Math.abs(dv))} ${dv > 0 ? 'over' : 'under'} usual`;
    };
    const tiles = html`<div class="bento pg-tiles">
      <button type="button" class="bt bt--energy pg-tile" data-pg="week">
        <span class="bt__lab">${ic('calendar')}This week</span>
        <span><span class="n n-l" data-count>${f.int(wk.workouts || 0)}</span><span class="pg-u">${(wk.workouts || 0) === 1 ? 'session' : 'sessions'}</span></span>
        <span class="bt__sub">${cmp(wk.workouts, a.workouts, 0.75, (v) => f.int(Math.max(1, Math.round(v))))}</span>
      </button>
      ${hasSets
        ? html`<button type="button" class="bt bt--plain pg-tile" data-pg="volume">
            <span class="bt__lab">${ic('dumbbell')}Volume</span>
            <span class="n n-l">${volNum(wk.volumeKg || 0)}<span class="u">${volU()}</span></span>
            <span class="bt__sub">${cmp(wk.volumeKg, a.volumeKg, Math.max(1, (a.volumeKg || 0) * 0.03), (v) => vol(v))}</span>
          </button>`
        : html`<button type="button" class="bt bt--plain pg-tile" data-pg="week">
            <span class="bt__lab">${ic('clock')}Time</span>
            <span class="n n-l">${p.h ? html`${p.h}<span class="u">h</span>&thinsp;${String(p.m).padStart(2, '0')}` : html`${p.m}<span class="u">min</span>`}</span>
            <span class="bt__sub">${cmp(wk.minutes, a.minutes, 10, f.dur)}</span>
          </button>`}
    </div>`;
    const main = mode === 'volume' ? volumeMod(d) : weeksMod(t, mode);
    const opts = [['time', 'Time'], ['sessions', 'Sessions'], ...(hasSets ? [['volume', 'Volume']] : [])];
    const chartCard = weeks.length ? html`<section class="bt bt--plain pg-chart fam fam-workouts" aria-label="Last 12 weeks">
      <div class="bt__row"><span class="bt__lab">${ic('history')}Last 12 weeks</span>
        <div class="me-sg" role="group" aria-label="What the bars show">${opts.map(([v, l]) => html`<button type="button" data-seg="wkmode" data-value="${v}" aria-pressed="${String(v === mode)}">${l}</button>`)}</div>
      </div>
      ${main.graph}
    </section>` : '';
    const rows = [];
    const add = (key, cfg) => { if (cfg) rows.push({ key, icon: cfg.icon, fam: cfg.fam, title: cfg.title, text: cfg.line || cfg.note || '' }); };
    add('week', weekMod(d));
    if (weeks.length) { add('weeks', { ...weeksMod(t, 'time'), title: '12 weeks in numbers' }); add('when', whenMod(t)); }
    add('zones', zonesMod(t) || null);
    if (hasSets) {
      add('volume', volumeMod(d)); add('balance', balanceMod(t) || null); add('records', recordsMod(t)); add('exercises', progressMod(t) || null);
    } else rows.push({ key: 'strength', icon: 'strength', fam: 'workouts', title: 'Strength', text: 'No sets yet. Import them from Hevy' });
    return html`${top()}<div class="stack trn-deep pg">
      ${tiles}
      ${chartCard}
      <div class="bsec"><h2>Look closer</h2></div>
      ${xrows(rows, 'pg')}
    </div>`;
  }

  /** One analysis in a sheet: what used to be its card on the page. */
  function pgSheet(key) {
    const t = d.training || {};
    if (key === 'strength') { go('/workouts/import'); return; }
    const cfg = {
      week: () => weekMod(d), weeks: () => { const c = weeksMod(t, 'time'); return { ...c, title: '12 weeks in numbers', body: c.nums, note: 'This week is left out of the averages' }; },
      when: () => whenMod(t), zones: () => zonesMod(t), volume: () => volumeMod(d), balance: () => balanceMod(t), records: () => recordsMod(t), exercises: () => progressMod(t),
    }[key]?.();
    if (!cfg) return;
    const s = sheet({ title: cfg.title, body: html`<div class="pg-sh fam fam-${cfg.fam || 'workouts'}">${cfg.note ? html`<p class="pg-sh__note">${cfg.note}</p>` : ''}${cfg.body}</div>` });
    on(s.el, 'click', '[data-ex]', (e, b) => { const x = (t.exercises || []).filter((it) => it.sessions?.length)[Number(b.dataset.ex)]; if (x) exerciseSheet(x); });
    on(s.el, 'click', '[data-action="start"]', (e, b) => { s.close(); startWorkout(b, take); });
    on(s.el, 'click', 'a[href^="/"]', () => s.close());
    on(s.el, 'click', '[data-action="log"]', () => { s.close(); logSheet(d, (p) => { take(p); refreshMe().catch(() => {}); }); });
  }

  /** History: every session, week by week, as quiet rows. */
  function sessions() {
    if (!history.length) return html`${top()}<div class="stack trn-deep">${grid(emptyMod(d), 'wkg')}</div>`;
    const groups = new Map();
    for (const w of history.slice(0, visible)) {
      const k = f.weekStart(f.instDay(w.start));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    }
    const more = d.more || history.length > visible;
    return html`${top()}<div class="stack trn-deep hs">
      ${[...groups.entries()].map(([k, items]) => html`<div class="bsec"><h2>${f.weekLabel(k)}</h2><span class="hs-s">${f.plural(items.length, 'session')} · ${f.dur(sum(items.map((w) => w.durationMin)))}</span></div>
        <ul class="blist trn-recent">${items.map((w) => historyRow(w, d))}</ul>`)}
      ${more ? html`<button type="button" class="btn btn--tonal hs-more" data-action="more">Show older workouts</button>` : ''}
    </div>`;
  }

  function paint() {
    mount(root, view === 'progress' ? progress() : view === 'history' ? sessions() : trainHome(d, history, rts));
    stopTimers?.();
    stopTimers = d.running ? runTimers(root) : null;
  }

  const take = (payload) => { d = payload; history = payload.history || []; if (ctx.alive()) paint(); };

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, html`${top()}${skeleton(view ? 'chart' : 'page')}`);
    try {
      const [p, r] = await Promise.all([api.get('/api/workouts?limit=40'), view ? Promise.resolve(null) : api.get('/api/routines').catch(() => null)]);
      if (r) rts = r;
      take(p);
    } catch (err) {
      if (ctx.alive() && !quiet) mount(root, html`${top()}${errorState(err)}`);
    }
  }

  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="start"]', (e, btn) => startWorkout(btn, take));
  on(root, 'click', '[data-go-routine]', (e, btn) => startRoutine(btn.dataset.goRoutine || null, btn));
  on(root, 'click', '[data-action="log"]', () => logSheet(d, (p) => { take(p); refreshMe().catch(() => {}); }));
  on(root, 'click', '[data-action="more"]', async (e, btn) => {
    const last = history[history.length - 1];
    if (!last) return;
    // What is already here first; the server is asked once that runs out.
    if (visible < history.length) { visible += 40; paint(); return; }
    try {
      const p = await busy(btn, () => api.get(`/api/workouts?limit=40&before=${last.start}`));
      if (!p) return;
      const seen = new Set(history.map((w) => w.id));
      history = history.concat((p.history || []).filter((w) => !seen.has(w.id)));
      d = { ...d, more: p.more };
      visible = history.length;
      paint();
    } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-seg="wkmode"]', (e, btn) => {
    if (btn.dataset.value === mode) return;
    mode = btn.dataset.value;
    paint();
    root.querySelector(`[data-seg="wkmode"][data-value="${mode}"]`)?.focus({ preventScroll: true });
  });
  on(root, 'click', '[data-pg]', (e, btn) => pgSheet(btn.dataset.pg));
  on(root, 'click', '[data-ex]', (e, btn) => {
    const x = (d?.training?.exercises || []).filter((it) => it.sessions?.length)[Number(btn.dataset.ex)];
    if (x) exerciseSheet(x);
  });
  bindWorkoutActions(root, {
    find: (id) => (d?.running?.id === id ? d.running : d?.pending?.find((w) => w.id === id)),
    done: take,
  });
  ctx.onLeave(listen('changed', (what) => { if (what.includes('workouts') || what.includes('routines')) load({ quiet: true }); }));
  ctx.onLeave(() => stopTimers?.());
  ctx.onRefresh(() => load({ quiet: true }));
  googleReturn(ctx, '/workouts');
  await load();
}

/* ── detail ─────────────────────────────────────────────────── */

const SET_TYPE = { warmup: 'Warm-up', dropset: 'Drop set', failure: 'To failure' };

function setLine(s) {
  const parts = [];
  if (f.isNum(s.kg) && s.kg > 0) parts.push(`${wnum(s.kg)} ${f.weightUnit()}`);
  if (f.isNum(s.reps)) parts.push(`${f.int(s.reps)} reps`);
  if (f.isNum(s.distanceM) && s.distanceM > 0) parts.push(f.dist(s.distanceM));
  if (f.isNum(s.durationS) && s.durationS > 0) parts.push(s.durationS >= 60 ? `${Math.floor(s.durationS / 60)} min ${s.durationS % 60 ? `${s.durationS % 60} s` : ''}`.trim() : `${s.durationS} s`);
  return parts.join(' × ') || f.DASH;
}

/** "12 min longer than your usual", against the median session. */
function againstSession(v, usual, { fmt, tol, more, less, what }) {
  if (!f.isNum(v)) return '';
  if (!f.isNum(usual)) return html`<span class="muted">No usual to compare with yet</span>`;
  const diff = v - usual;
  if (Math.abs(diff) < tol) return html`<span class="delta">${ic('flat', { size: 's' })}<span>About your usual ${what}</span></span>`;
  return html`<span class="delta">${ic(diff > 0 ? 'up' : 'down', { size: 's' })}<span>${fmt(Math.abs(diff))} ${diff > 0 ? more : less} than your usual ${what}</span></span>`;
}

function editSheet(w, d, done) {
  const s = sheet({
    title: 'Name and notes',
    body: html`<form class="form" id="edit-form" novalidate>
      <div data-slot="error"></div>
      ${field({ label: 'Name', name: 'title', value: w.title || '', attrs: 'maxlength="80" autocomplete="off"' })}
      ${d?.exerciseTypes?.length ? field({ label: 'Kind', name: 'type', value: w.type, options: [...(d.exerciseTypes.some((t) => t.id === w.type) || !w.type ? [] : [[w.type, typeLabel(w.type)]]), ...d.exerciseTypes.map((t) => [t.id, t.label])] }) : ''}
      ${field({ label: 'Notes', name: 'notes', type: 'textarea', value: w.notes || '', attrs: 'maxlength="2000" rows="4"' })}
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="edit-form">Save</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.patch(`/api/workouts/${encodeURIComponent(w.id)}`, { title: v.title.trim() || null, notes: v.notes.trim() || null, ...(v.type ? { type: v.type } : {}) }));
      if (r === undefined) return;
      s.close(); toast('Saved'); done();
    } catch (err) {
      mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err) }));
    }
  });
}


/** Exercises and sets, edited in a sheet and saved whole (PUT …/sets):
    the same cards as the routine editor and the logger. */
function setsSheet(w, done) {
  const list = (w.exercises || []).map((x) => ({
    name: x.name, libId: x.libId || null, templateId: x.templateId || null, muscle: x.muscle || 'other', notes: x.notes || null, image: x.image || null,
    // The columns follow what the sets hold.
    type: x.sets.some((st) => f.isNum(st.distanceM) && st.distanceM > 0) ? 'distance_duration'
      : x.sets.some((st) => f.isNum(st.durationS)) && !x.sets.some((st) => f.isNum(st.reps)) ? 'duration' : 'weight_reps',
    restS: 0, sets: (x.sets || []).map((st) => ({ type: st.type || 'normal', kg: st.kg ?? null, reps: st.reps ?? null, durationS: st.durationS ?? null, distanceM: st.distanceM ?? null, rpe: st.rpe ?? null })),
  }));
  const open = new Set(list.map((_, i) => i));
  const s = sheet({
    title: 'Exercises and sets',
    body: html`<div class="setsheet"><div class="sxl" data-list></div>
      <button type="button" class="btn btn--tonal" data-add>${ic('plus', { size: 's' })}Add exercises</button>
      <p class="field__hint">Saving replaces this workout's exercises with what is shown here. Tap a set's number to make it a warm-up, a drop set or to failure.</p></div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-save>Save sets</button>`,
  });
  const el = s.el.querySelector('[data-list]');
  const draw = () => mount(el, html`${list.map((x, i) => exerciseCard(x, i, { open: open.has(i), rest: false }))}${list.length ? '' : html`<p class="muted small">No exercises yet.</p>`}`);
  on(s.el, 'input', '.sx [data-k]', (e, input) => { const x = list[Number(input.closest('[data-x]').dataset.x)]; if (x) readInput(x, input); });
  on(s.el, 'click', '.sx [data-xa]', async (e, b) => {
    const i = Number(b.closest('[data-x]').dataset.x);
    const x = list[i];
    const j = Number(b.closest('[data-s]')?.dataset.s);
    const act = b.dataset.xa;
    if (act === 'info') { if (x.libId) exerciseInfo(x.libId); return; }
    if (act === 'kind') cycleKind(x.sets[j]);
    else if (act === 'add-set') x.sets.push(nextSet(x));
    else if (act === 'del-set') x.sets.splice(j, 1);
    else if (act === 'menu') await exerciseMenu(list, i, open, { rest: false });
    draw();
  });
  s.el.querySelector('[data-add]').addEventListener('click', async () => {
    const got = await pickExercises({ title: 'Add exercises' });
    for (const g of got) {
      let last = [];
      try { last = (await api.get(`/api/exercises/last?name=${encodeURIComponent(g.name)}`)).sets || []; } catch { /* none */ }
      list.push({ name: g.name, libId: g.libId, templateId: g.templateId, muscle: g.muscle || 'other', type: g.type || 'weight_reps', image: g.image, restS: 0, notes: null,
        sets: last.length ? last.map((st) => ({ type: st.type || 'normal', kg: st.kg ?? null, reps: st.reps ?? null, durationS: st.durationS ?? null, distanceM: st.distanceM ?? null })) : [{ type: 'normal', kg: null, reps: null, durationS: null, distanceM: null }] });
      open.add(list.length - 1);
    }
    draw();
  });
  s.el.querySelector('[data-save]').addEventListener('click', async (e) => {
    const out = list.map((x) => ({
      name: x.name, libId: x.libId, templateId: x.templateId, muscle: x.muscle, notes: x.notes,
      sets: x.sets.filter((st) => [st.kg, st.reps, st.durationS, st.distanceM].some((v) => f.isNum(v) && v > 0))
        .map((st) => Object.fromEntries(Object.entries({ kg: st.kg, reps: st.reps, type: st.type, rpe: st.rpe, distanceM: st.distanceM, durationS: st.durationS }).filter(([, v]) => v !== null && v !== undefined))),
    })).filter((x) => x.sets.length);
    try {
      const r = await busy(e.currentTarget, () => api.put(`/api/workouts/${encodeURIComponent(w.id)}/sets`, { exercises: out }));
      if (r === undefined) return;
      s.close(); toast('Sets saved'); done(r);
    } catch (err) { toastError(err, 'Could not save the sets. Try again.'); }
  });
  draw();
}

/** The top of one workout, at a glance: how long, when, and the few numbers that matter. */
function heroTile(w, { day, end, types }) {
  const route = Boolean(w.track) || isRoute(w);
  const durMin = w.durationMin ?? (end ? (end - w.start) / 60000 : null);
  const p = f.durParts(durMin);
  const prs = (w.exercises || []).reduce((a, x) => a + (x.sets || []).filter((s) => s.pr).length, 0) || w.prCount || 0;
  const distM = w.track?.distanceM ?? w.strava?.distanceM ?? null;
  const facts1 = [
    f.isNum(distM) && distM > 0 ? [f.distNum(distM), f.distUnit()] : null,
    w.sets?.volumeKg > 0 ? [volNum(w.sets.volumeKg), `${volU() === 't' ? 'tonnes' : volU()} lifted`] : null,
    w.sets?.sets ? [f.int(w.sets.sets), w.sets.sets === 1 ? 'set' : 'sets'] : null,
    f.isNum(w.avgHr) ? [Math.round(w.avgHr), 'bpm avg'] : null,
    f.isNum(w.kcal) ? [f.int(w.kcal), 'kcal'] : null,
    prs ? [f.int(prs), prs === 1 ? 'record' : 'records'] : null,
  ].filter(Boolean).slice(0, 3);
  return html`<section class="bt ${route ? 'bt--active' : 'bt--energy'} wk-hero" aria-label="${typeLabel(w.type, types)}, ${f.dur(durMin)}, ${f.dayLong(day)}">
    <div class="bt__row"><span class="bt__lab">${ic(route ? 'route' : typeIcon(w) === 'strength' ? 'dumbbell' : typeIcon(w))}${typeLabel(w.type, types)}</span><span class="bt__meta">${f.clock(w.start)}${end ? ` – ${f.clock(end)}` : ''}</span></div>
    <div>
      <p class="n n-hero">${p ? (p.h ? html`<span data-count>${p.h}</span><span class="u">h</span>&thinsp;<span data-count>${String(p.m).padStart(2, '0')}</span><span class="u">m</span>` : html`<span data-count>${p.m}</span><span class="u">min</span>`) : f.DASH}</p>
      <p class="bt__sub">${f.dayLong(day)} · ${sourceLabel(w)}</p>
    </div>
    ${facts1.length ? html`<div class="wk-hero__facts">${facts1.map(([v, u]) => html`<div><b class="n">${v}</b><span>${u}</span></div>`)}</div>` : ''}
  </section>`;
}

async function detail(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  const base = `/api/workouts/${encodeURIComponent(id)}`;
  let parts = null; let w = null; let meta = null; let stopTimers = null; let logger = null; let triedStream = false; let map = null; let justFinished = false; let rts = null;
  document.title = 'Workout · Health';

  /** How the session went, the way Hevy sums it up: the headline numbers,
      each exercise's best set, the muscles worked, and the last time. */
  function doneMod() {
    const sm = w.summary;
    if (!sm) return '';
    const last = sm.last;
    const vs = (now1, then, fmt) => (f.isNum(now1) && f.isNum(then) && then > 0 ? html`<span class="delta">${ic(now1 >= then ? 'up' : 'down', { size: 's' })}<span>${fmt(Math.abs(now1 - then))} ${now1 >= then ? 'more' : 'less'} than last time</span></span>` : '');
    const maxSets = Math.max(1, ...sm.muscles.map((m) => m.sets));
    return ({
      title: justFinished ? 'Workout complete' : 'Session', fam: 'workouts', icon: 'record', span: 12, cls: justFinished ? 'wk-done is-new' : 'wk-done',
      body: html`
        <div class="wk-done__big">
          <div>${stat({ size: 's', label: 'Volume', value: volNum(sm.volumeKg), unit: volU(), context: last ? vs(sm.volumeKg, last.volumeKg, (v) => `${vol(v)}`) : '' })}</div>
          <div>${stat({ size: 's', label: 'Sets', value: f.int(sm.sets), context: html`<span class="muted">${f.plural(sm.reps, 'rep')}</span>` })}</div>
          <div>${stat({ size: 's', label: 'Exercises', value: f.int(sm.exercises) })}</div>
          <div>${stat({ size: 's', label: 'Records', value: f.int(sm.records), context: sm.records ? html`<span class="muted">Marked below</span>` : '' })}</div>
        </div>
        ${sm.best.length ? html`<hr class="rule"><p class="sub">Best set of each exercise</p>
          <ul class="wk-best">${sm.best.map((b) => html`<li class="wk-best__r">
            <button type="button" class="wk-best__pic" ${b.libId ? `data-lib="${b.libId}"` : 'disabled'} aria-label="About ${b.name}">${thumb(b.libId ? `/api/media/exercises/${b.libId}/0.jpg` : null, { size: 's' })}</button>
            <span class="wk-best__n">${b.name}${b.pr ? html` ${recBadge(1, { plain: true })}` : ''}</span>
            <span class="wk-best__v">${setLine(b)}${f.isNum(b.e1rm) ? html`<small class="muted"> · 1RM about ${wnum(b.e1rm)}</small>` : ''}</span>
          </li>`)}</ul>` : ''}
        ${sm.muscles.length ? html`<hr class="rule"><p class="sub">Sets by muscle group</p>
          <div class="wk-mus">${sm.muscles.map((m) => html`<div class="wk-mus__r"><span>${MUSCLE[m.muscle] || m.muscle}</span><span class="wk-mus__bar"><span style="width:${Math.round((m.sets / maxSets) * 100)}%"></span></span><span class="num">${m.sets}</span></div>`)}</div>` : ''}
        ${last ? html`<p class="muted small wk-done__last">Last time with this routine, <a class="link" href="/workouts/${encodeURIComponent(last.id)}">${f.dateTime(last.start)}</a>: ${[last.durationMin ? f.dur(last.durationMin) : '', f.isNum(last.sets) ? f.plural(last.sets, 'set') : '', f.isNum(last.volumeKg) ? `${vol(last.volumeKg)}` : ''].filter(Boolean).join(', ')}.</p>` : ''}`,
    });
  }

  /** The routine it was: done as planned, or how it differed, and the way
      to bring the routine up to date; or which routine it was. */
  function routineMod() {
    if (w.readOnly || w.track) return '';
    const r = w.routine;
    const has = (w.exercises || []).length > 0;
    if (!r && !has) return '';
    const diff = w.differences || [];
    return ({
      title: 'Routine', icon: 'list', span: 12, cls: 'wk-rtn',
      body: r ? html`
        <p class="wk-say">${r.exists ? html`Done with <a class="link" href="/workouts/routines/${encodeURIComponent(r.id)}"><b>${r.title}</b></a>` : html`Done with <b>${r.title || 'a routine'}</b>, since deleted`}${diff.length ? '.' : ', as planned.'}</p>
        ${diff.length ? html`<ul class="wk-diff">${diff.slice(0, 8).map((x) => html`<li>${x.text}</li>`)}${diff.length > 8 ? html`<li class="muted">and ${diff.length - 8} more</li>` : ''}</ul>` : ''}
        <div class="btnrow">
          ${r.exists && diff.length ? html`<button type="button" class="btn btn--s" data-act="rt-update">${ic('refresh', { size: 's' })}Update the routine to this</button>` : ''}
          <button type="button" class="btn btn--ghost btn--s" data-act="rt-pick">Change routine</button>
        </div>` : html`
        <p class="wk-say wk-say--quiet">Not linked to a routine.</p>
        <div class="btnrow">
          <button type="button" class="btn btn--tonal btn--s" data-act="rt-pick">Which routine was it?</button>
          ${has ? html`<button type="button" class="btn btn--tonal btn--s" data-act="rt-new">${ic('plus', { size: 's' })}Save as a routine</button>` : ''}
        </div>`,
    });
  }

  /** A route: the map, distance, pace or speed, climb, splits, best efforts. */
  function trackMod() {
    const t = w.track;
    if (!t) return '';
    const pace = t.pace;
    const items = [
      { k: 'Distance', v: f.dist(t.distanceM) },
      { k: 'Moving time', v: hmsS(t.movingS) },
      pace ? { k: 'Average pace', v: paceText(t.paceSPerKm), u: `/${f.distUnit()}` } : { k: 'Average speed', v: speedText(t.avgSpeedKmh), u: `${f.distUnit()}/h` },
      pace ? { k: 'Top speed', v: speedText(t.maxSpeedKmh), u: `${f.distUnit()}/h` } : { k: 'Top speed', v: speedText(t.maxSpeedKmh), u: `${f.distUnit()}/h` },
      f.isNum(t.elevGainM) ? { k: 'Climb', v: f.int(t.elevGainM), u: 'm' } : null,
      f.isNum(t.elevMaxM) ? { k: 'Highest point', v: f.int(t.elevMaxM), u: 'm' } : null,
      t.elapsedS - t.movingS > 60 ? { k: 'Stopped', v: hmsS(t.elapsedS - t.movingS) } : null,
    ].filter(Boolean);
    const fastest = t.splits.filter((x) => !x.partial).reduce((a, x) => (!a || x.paceSPerKm < a.paceSPerKm ? x : a), null);
    return ({
      title: t.label, fam: 'workouts', icon: typeIcon(w), span: 12, cls: 'wk-track',
      note: w.strava?.id ? (w.strava.own ? 'Also on Strava' : 'From Strava') : '',
      tools: html`${w.strava?.id ? html`<a class="mod__link" href="https://www.strava.com/activities/${encodeURIComponent(w.strava.id)}" target="_blank" rel="noopener">Strava${ic('external', { size: 's' })}</a>` : ''}<a class="mod__link" href="/api/workouts/${encodeURIComponent(w.id)}/route.gpx" download>${ic('download', { size: 's' })}GPX</a>`,
      body: html`
        <div class="wk-map" data-map></div>
        ${facts(items, { cols: 3, cls: 'facts--s' })}
        ${alongChart({ series: t.series, idx: 1, label: 'Elevation', unit: 'm', cls: 'along--elev' })}
        ${alongChart({ series: t.series, idx: 2, label: 'Speed', unit: `${f.distUnit()}/h`, fmt: (v) => speedText(v), cls: 'along--speed' })}
        ${alongChart({ series: t.series, idx: 4, label: 'Heart rate', unit: 'bpm', cls: 'along--hr' })}
        ${t.splits.length > 1 ? html`<hr class="rule"><p class="sub">Splits</p>
          <table class="tbl wk-splits"><thead><tr><th>Km</th><th>${pace ? 'Pace' : 'Speed'}</th><th>Climb</th>${t.splits.some((x) => f.isNum(x.hr)) ? html`<th>Heart rate</th>` : ''}</tr></thead><tbody>
          ${t.splits.map((x) => html`<tr class="${x === fastest ? 'is-best' : ''}"><td>${x.partial ? `${(x.distanceM / 1000).toFixed(2)}` : x.n}</td><td class="num">${pace ? paceText(x.paceSPerKm) : speedText(x.speedKmh)}${x === fastest ? html` <span class="badge badge--ok">Fastest</span>` : ''}</td><td class="num">${f.isNum(x.elevM) ? `${x.elevM > 0 ? '+' : ''}${x.elevM} m` : f.DASH}</td>${t.splits.some((y) => f.isNum(y.hr)) ? html`<td class="num">${f.isNum(x.hr) ? `${x.hr} bpm` : f.DASH}</td>` : ''}</tr>`)}
          </tbody></table>` : ''}
        ${t.efforts.length ? html`<hr class="rule"><p class="sub">Fastest stretches</p>${facts(t.efforts.map((e) => ({ k: e.label, v: hmsS(e.timeS) })), { cols: 3, cls: 'facts--s' })}` : ''}`,
    });
  }

  function heartMod({ pts, hasTrace, end, span }) {
    const z = w.zones;
    const zoned = z && Array.isArray(z.minutes) && sum(z.minutes) > 0;
    const most = zoned ? z.minutes.indexOf(Math.max(...z.minutes)) : -1;
    return ({
      title: 'Heart rate', fam: 'heart', icon: 'heart', span,
      note: hasTrace ? 'Minute by minute, with 20 minutes either side' : '',
      body: html`
        ${hasTrace
          ? figure(chart((cw) => hrTrace({ w: cw, h: cw > 620 ? 240 : 180, points: pts, start: w.start, end, avg: w.avgHr, label: `Heart rate from ${f.clock(pts[0][0])} to ${f.clock(pts[pts.length - 1][0])}${f.isNum(w.avgHr) ? `, average ${Math.round(w.avgHr)} bpm` : ''}${f.isNum(w.maxHr) ? `, highest ${Math.round(w.maxHr)} bpm` : ''}. The workout itself is shaded.` })), {
            read: 'Touch the line to read a minute. The shaded part is the workout.',
            table: tableAlt(['Time', 'Heart rate (bpm)'], pts.filter((p) => f.isNum(p[1])).filter((_, i, a) => i % Math.max(1, Math.round(a.length / 30)) === 0).map((p) => [f.clock(p[0]), String(Math.round(p[1]))])),
          })
          : html`<p class="wk-say wk-say--quiet">${w.traceReason || 'There is no minute-by-minute heart rate for this workout.'}</p>`}
        ${zoned ? html`<hr class="rule">
          <div class="part wk-zones">
            <p class="sub">Time in zones</p>
            <p class="wk-say">Mostly <b>${z.labels[most].toLowerCase()}</b>: ${f.dur(z.minutes[most])} of ${f.dur(sum(z.minutes))} at ${zoneRanges(z.bounds)[most]} bpm.</p>
            ${zoneSplit(z, z.minutes)}
            ${zoneTable(z, z.minutes)}
            <p class="chart__note wk-note">${z.note}${/[.!?]$/.test(z.note || '') ? '' : '.'}</p>
          </div>` : ''}`,
    });
  }

  function summaryMod({ live, end, about }) {
    const u = w.usual || {};
    const durMin = w.durationMin ?? (end ? (end - w.start) / 60000 : null);
    const vkg = w.sets?.volumeKg;
    const prs = (w.exercises || []).reduce((a, x) => a + (x.sets || []).filter((s) => s.pr).length, 0);
    const second = [
      f.isNum(w.avgHr) ? html`<div class="fam fam-heart">${stat({ size: 's', label: 'Average heart rate', icon: 'heart', value: Math.round(w.avgHr), unit: 'bpm',
        context: againstSession(w.avgHr, u.avgHr, { fmt: (v) => `${f.int(v)} bpm`, tol: 2, more: 'higher', less: 'lower', what: f.isNum(u.avgHr) ? `${Math.round(u.avgHr)}` : '' }) })}</div>` : '',
      f.isNum(vkg) && vkg > 0 ? stat({ size: 's', label: 'Volume', icon: 'strength', value: volNum(vkg), unit: volU(),
        context: againstSession(vkg, u.volumeKg, { fmt: (v) => `${vol(v)}`, tol: Math.max(1, (u.volumeKg || 0) * 0.03), more: 'more', less: 'less', what: f.isNum(u.volumeKg) ? volNum(u.volumeKg) : '' }) }) : '',
    ].filter(Boolean);
    const rest = [
      f.isNum(w.maxHr) ? { k: 'Highest heart rate', v: Math.round(w.maxHr), u: 'bpm' } : null,
      f.isNum(w.kcal) ? { k: 'Calories', v: f.int(w.kcal), u: 'kcal' } : null,
      f.isNum(w.steps) ? { k: 'Steps', v: f.int(w.steps) } : null,
      f.isNum(w.activeMin) ? { k: 'Active minutes', v: f.int(w.activeMin) } : null,
      w.sets ? { k: 'Sets', v: f.int(w.sets.sets), s: f.plural(w.sets.exercises, 'exercise') } : null,
      prs ? { k: 'Records', v: f.int(prs), s: 'Marked on the sets' } : null,
    ];
    return ({
      title: 'Summary', fam: 'workouts', icon: typeIcon(w), span: 12, tools: live || w.readOnly ? '' : aiButton('workout', { id: w.id }),
      body: html`
        ${stat({ size: 'l', label: live ? 'Running for' : 'Duration',
          value: live ? html`<span data-timer="${w.start}">${f.stopwatch(Date.now() - w.start)}</span>` : durHtml(durMin),
          context: live ? html`<span class="muted">Started at ${f.clock(w.start)}</span>` : againstSession(durMin, u.durationMin, { fmt: f.dur, tol: 4, more: 'longer', less: 'shorter', what: f.isNum(u.durationMin) ? f.dur(u.durationMin) : '' }) })}
        ${second.length ? html`<hr class="rule"><div class="stats stats--2">${second}</div>` : ''}
        ${rest.some(Boolean) ? html`<hr class="rule">${facts(rest, { cols: 2, cls: 'facts--s wk-facts2' })}` : ''}
        ${about}`,
    });
  }

  /** The Strava side of a workout: distance, pace, climb, the route. */
  function stravaMod() {
    const st = w.strava;
    if (!st || st.own) return '';
    const km = f.isNum(st.distanceM) && st.distanceM > 0 ? st.distanceM : null;
    const movingS = f.isNum(st.movingS) ? st.movingS : null;
    const paceS = km && movingS ? movingS / (km / 1000) : null;
    const items = [
      km ? { k: 'Distance', v: f.dist(km) } : null,
      movingS ? { k: 'Moving time', v: f.dur(movingS / 60) } : null,
      paceS && /RUN|WALK|HIK/.test(String(w.type)) ? { k: 'Pace', v: paceText(paceS), u: `/${f.distUnit()}` } : null,
      f.isNum(st.avgSpeed) && /BIK|RIDE|CYCL/.test(String(w.type)) ? { k: 'Average speed', v: speedText(st.avgSpeed * 3.6), u: `${f.distUnit()}/h` } : null,
      f.isNum(st.elevationM) && st.elevationM > 0 ? { k: 'Climb', v: f.int(st.elevationM), u: 'm' } : null,
      f.isNum(st.avgWatts) ? { k: 'Average power', v: f.int(st.avgWatts), u: 'W' } : null,
      f.isNum(st.kcal) ? { k: 'Calories (Strava)', v: f.int(st.kcal), u: 'kcal' } : null,
      st.device ? { k: 'Recorded on', v: st.device } : null,
    ].filter(Boolean);
    const r = w.route;
    const shape = r && r.points?.length > 1 ? (() => {
      const W = 600; const H = Math.round(W * Math.max(0.35, Math.min(1, r.h / Math.max(0.01, r.w))));
      const pad = 16; const sc = Math.min((W - pad * 2) / Math.max(0.01, r.w), (H - pad * 2) / Math.max(0.01, r.h));
      const ox = (W - r.w * sc) / 2; const oy = (H - r.h * sc) / 2;
      const d = r.points.map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + x * sc).toFixed(1)},${(oy + y * sc).toFixed(1)}`).join('');
      const [sx, sy] = r.points[0]; const [ex, ey] = r.points[r.points.length - 1];
      return raw(`<svg class="route" viewBox="0 0 ${W} ${H}" role="img" aria-label="The route, as recorded on Strava"><path class="route__l" d="${d}"/><circle class="route__s" cx="${(ox + sx * sc).toFixed(1)}" cy="${(oy + sy * sc).toFixed(1)}" r="7"/><circle class="route__e" cx="${(ox + ex * sc).toFixed(1)}" cy="${(oy + ey * sc).toFixed(1)}" r="7"/></svg>`);
    })() : '';
    return ({
      title: 'From Strava', fam: 'workouts', icon: 'route', span: 12,
      note: st.name && st.name !== w.title ? st.name : '',
      tools: html`<a class="mod__link" href="https://www.strava.com/activities/${encodeURIComponent(st.id)}" target="_blank" rel="noopener">Open in Strava${ic('external', { size: 's' })}</a>`,
      body: html`<div class="wk-strava ${shape ? 'wk-strava--map' : ''}">
        ${shape ? html`<div class="wk-route">${shape}<p class="chart__note">Start ${raw('<span class="route__k route__k--s"></span>')} · finish ${raw('<span class="route__k route__k--e"></span>')}. Drawn from the route, no map.</p></div>` : ''}
        ${items.length ? facts(items, { cols: 2, cls: 'facts--s' }) : html`<p class="wk-say wk-say--quiet">Strava has no distance or route for this one.</p>`}
        ${st.description ? html`<p class="prose small">${st.description}</p>` : ''}
      </div>`,
    });
  }

  function exercisesMod() {
    const ex = w.exercises || [];
    if (!ex.length) return '';
    return ({
      title: 'Exercises', fam: 'workouts', icon: 'strength', span: 12,
      note: w.sets ? `${f.plural(w.sets.sets, 'set')} · ${vol(w.sets.volumeKg)}` : '',
      body: html`<div class="exgrid">${ex.map((x) => {
        const p = x.previous;
        return html`<div class="ex">
          <h3 class="ex__t">${x.name}</h3>
          <p class="ex__d">${[MUSCLE[x.muscle] || '', p && f.isNum(p.topKg) ? `last time ${wnum(p.topKg)} ${f.weightUnit()} × ${f.int(p.topReps)}, ${f.dayShort(p.date)}` : p ? `last done ${f.dayShort(p.date)}` : 'first time in your log'].filter(Boolean).join(' · ')}</p>
          ${x.notes ? html`<p class="ex__n">${x.notes}</p>` : ''}
          <ol class="setl">${(x.sets || []).map((s, i) => html`<li class="setl__r ${s.type === 'warmup' ? 'is-warm' : ''}">
            <span class="setl__i">${i + 1}</span>
            <span class="setl__v">${setLine(s)}</span>
            <span class="setl__x">${SET_TYPE[s.type] ? html`<span class="badge">${SET_TYPE[s.type]}</span>` : ''}${s.pr ? recBadge(1, { plain: true }) : ''}${f.isNum(s.rpe) ? html`<span class="setl__rpe">RPE ${s.rpe}</span>` : ''}</span>
          </li>`)}</ol>
        </div>`;
      })}</div>`,
    });
  }

  function paint() {
    const types = meta?.exerciseTypes;
    const title = workoutTitle(w, types);
    document.title = `${title} · Health`;
    const day = f.instDay(w.start);
    const end = w.end ?? w.lastEnd;
    const live = w.status === 'running';
    const waiting = w.status === 'ongoing' || w.status === 'review';
    const pts = (w.trace || []).map((p) => [p[0], p[1]]);
    const hasTrace = pts.filter((p) => f.isNum(p[1])).length > 1;
    const gText = googleStateText(w);
    const canEditSets = !w.readOnly && !live && !waiting && w.status !== 'dismissed';

    const gBad = w.google?.state === 'failed' || w.google?.state === 'needs_scope';
    // Where it came from and where it is kept: the foot of the summary.
    const about = html`<dl class="wk-about">
        <div><dt>Recorded by</dt><dd>${sourceLabel(w)}</dd></div>
        <div><dt>Kind</dt><dd>${typeLabel(w.type, types)}</dd></div>
        ${w.hevy?.id ? html`<div><dt>Hevy</dt><dd>${w.hevy.sent ? 'Sent to Hevy' : 'From Hevy'}${w.hevy.missing?.length ? html`<span class="muted"> · not sent: ${w.hevy.missing.join(', ')} (not in your Hevy library)</span>` : ''}</dd></div>` : ''}
        ${w.strava?.own ? html`<div><dt>Strava</dt><dd><a href="https://www.strava.com/activities/${encodeURIComponent(w.strava.id)}" target="_blank" rel="noopener">Sent to Strava</a></dd></div>` : ''}
        ${gText ? html`<div class="wk-about__g ${gBad ? 'is-bad' : ''}"><dt>Google Health</dt><dd>${gBad ? ic('alert', { size: 's' }) : ''}<span>${gText}</span></dd>
          ${w.google.state === 'failed' ? html`<div class="btnrow wk-rowact"><button type="button" class="btn btn--tonal btn--s" data-action="retry-upload">Try again</button></div>` : ''}
          ${w.google.state === 'needs_scope' ? html`<div class="btnrow wk-rowact"><button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-return="/workouts/${encodeURIComponent(w.id)}">Reconnect Google</button></div>` : ''}
        </div>` : ''}
      </dl>
      ${w.routeNeeds === 'location' ? html`<div class="wk-route-ask">${ic('map', { size: 's' })}<span>This ${String(w.type || '').includes('WALK') || String(w.type || '').includes('HIK') ? 'walk' : /BIK|CYCL|RIDE/.test(String(w.type || '')) ? 'ride' : 'run'} has a route. Allow route maps at Google to see it here.</span><button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-groups="routes" data-return="${location.pathname}">Allow</button></div>` : ''}
      ${w.readOnly ? html`<p class="chart__note wk-note">${w.source === 'garmin' ? 'This activity was recorded by your Garmin and read from Garmin Connect. It can be seen here but not changed: change it in Garmin Connect.' : 'This workout lives in Google Health, recorded by your device or another app. It can be seen here but not changed.'}</p>` : ''}`;
    // The page: the hero, one chart (the route's map, or the heart rate),
    // then a row into each part. Every part opens in a sheet.
    const done = doneMod(); const track = trackMod(); const heart = heartMod({ pts, hasTrace, end }); const sum0 = summaryMod({ live, end, about: '' });
    const strava = w.track ? '' : stravaMod(); const rtn = routineMod(); const exs = exercisesMod();
    const z = w.zones; const zoned = z && Array.isArray(z.minutes) && sum(z.minutes) > 0;
    const t = w.track;
    const ex = w.exercises || [];
    parts = {
      done: done && { title: justFinished ? done.title : 'How it went', body: done.body },
      sets: exs && { title: 'Exercises and sets', body: exs.body },
      heart: { title: 'Heart rate', body: heart.body, fam: 'heart' },
      route: track && { title: track.title, body: html`${track.tools ? html`<div class="wk-sh-tools">${track.tools}</div>` : ''}${track.body}`, map: true },
      strava: strava && { title: 'From Strava', body: html`<div class="wk-sh-tools">${strava.tools}</div>${strava.body}` },
      numbers: { title: 'Numbers', body: html`${live || w.readOnly ? '' : html`<div class="wk-sh-tools">${aiButton('workout', { id: w.id })}</div>`}${sum0.body}` },
      routine: rtn && { title: 'Routine', body: rtn.body },
      notes: w.notes && { title: 'Notes', body: html`<p class="prose sumtext">${w.notes}</p>` },
      kept: { title: 'Where it is kept', body: about },
    };
    const rows = [];
    if (done && !justFinished) rows.push({ key: 'done', icon: 'record', fam: 'workouts', title: 'How it went', text: [w.summary.records ? f.plural(w.summary.records, 'record') : '', f.plural(w.summary.exercises, 'exercise'), w.summary.last ? 'against last time' : ''].filter(Boolean).join(' · ') });
    if (exs) rows.push({ key: 'sets', icon: 'dumbbell', fam: 'workouts', title: 'Exercises and sets', text: [f.plural(ex.length, 'exercise'), w.sets ? f.plural(w.sets.sets, 'set') : '', w.sets?.volumeKg ? vol(w.sets.volumeKg) : ''].filter(Boolean).join(' · ') });
    if (track) rows.push({ key: 'route', icon: 'route', fam: 'active', title: 'Route', text: [f.dist(t.distanceM), t.pace ? `${paceText(t.paceSPerKm)} /${f.distUnit()}` : `${speedText(t.avgSpeedKmh)} ${f.distUnit()}/h`, f.isNum(t.elevGainM) ? `${f.int(t.elevGainM)} m climb` : '', t.splits.length > 1 ? 'splits' : ''].filter(Boolean).join(' · ') });
    rows.push({ key: 'heart', icon: 'heart', fam: 'heart', title: 'Heart rate', text: [f.isNum(w.avgHr) ? `Average ${Math.round(w.avgHr)} bpm` : '', f.isNum(w.maxHr) ? `highest ${Math.round(w.maxHr)}` : '', zoned ? `mostly ${z.labels[z.minutes.indexOf(Math.max(...z.minutes))].toLowerCase()}` : ''].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase()) || (hasTrace ? 'Minute by minute' : 'No minute-by-minute heart rate') });
    if (strava) rows.push({ key: 'strava', icon: 'route', fam: 'active', title: 'From Strava', text: w.strava.name && w.strava.name !== w.title ? w.strava.name : [f.isNum(w.strava.distanceM) && w.strava.distanceM > 0 ? f.dist(w.strava.distanceM) : '', 'distance, pace and climb'].filter(Boolean).join(' · ') });
    rows.push({ key: 'numbers', icon: 'trends', fam: 'workouts', title: 'Numbers', text: [f.isNum(w.usual?.durationMin) && !live ? 'Against your usual' : '', f.isNum(w.kcal) ? `${f.int(w.kcal)} kcal` : '', f.isNum(w.steps) ? `${f.int(w.steps)} steps` : ''].filter(Boolean).join(' · ') || 'Duration, heart rate, calories' });
    if (rtn) rows.push({ key: 'routine', icon: 'list', title: 'Routine', text: w.routine ? `${w.routine.title || 'A routine'}${(w.differences || []).length ? `, ${f.plural(w.differences.length, 'change')}` : ', as planned'}` : 'Not linked to a routine' });
    if (w.notes) rows.push({ key: 'notes', icon: 'text', title: 'Notes', text: w.notes.split('\n')[0] });
    rows.push({ key: 'kept', icon: gBad ? 'alert' : 'link', fam: gBad ? 'heart' : '', title: 'Where it is kept', text: [sourceLabel(w), w.hevy?.id ? (w.hevy.sent ? 'sent to Hevy' : 'from Hevy') : '', w.strava?.own ? 'sent to Strava' : '', gText ? (/google/i.test(gText) ? gText : `Google Health: ${gText.charAt(0).toLowerCase()}${gText.slice(1)}`) : ''].filter(Boolean).join(' · ') });

    const change = w.readOnly ? [] : [
      !live && w.status !== 'ongoing' ? { attrs: 'data-action="edit-times"', icon: 'clock', title: 'Edit times', text: 'Heart rate, steps and calories are worked out again' } : null,
      { attrs: 'data-action="edit"', icon: 'edit', title: 'Name and notes', text: 'And the kind of exercise' },
      canEditSets ? { attrs: 'data-action="edit-sets"', icon: 'dumbbell', title: ex.length ? 'Edit exercises and sets' : 'Add exercises and sets' } : null,
      { attrs: 'data-action="delete"', icon: 'trash', title: 'Delete workout', danger: true },
    ].filter(Boolean);

    // The one chart: the map for a route, else the heart rate.
    const lead = t?.line?.length > 1
      ? html`<section class="wk-lead wk-lead--map" aria-label="Route map"><div class="wk-map" data-map></div></section>`
      : hasTrace ? html`<section class="bt bt--plain wk-lead fam fam-heart" aria-label="Heart rate"><div class="bt__row"><span class="bt__lab">${ic('heart')}Heart rate</span>${f.isNum(w.avgHr) ? html`<span class="bt__meta">avg ${Math.round(w.avgHr)} bpm</span>` : ''}</div>
          ${chart((cw) => hrTrace({ w: cw, h: 150, points: pts, start: w.start, end, avg: w.avgHr, label: `Heart rate from ${f.clock(pts[0][0])} to ${f.clock(pts[pts.length - 1][0])}${f.isNum(w.avgHr) ? `, average ${Math.round(w.avgHr)} bpm` : ''}. The workout itself is shaded.` }))}</section>` : '';

    mount(root, html`
      ${head({ title, back: '/workouts' })}
      ${live || waiting ? html`<p class="wk-when-line"><span class="ib ib--s fam fam-workouts">${ic(typeIcon(w))}</span><span>${f.dayLong(day)} · ${f.clock(w.start)}${end ? ` to ${f.clock(end)}` : ''} · ${sourceLabel(w)}</span></p>` : heroTile(w, { day, end, types })}
      <div class="stack trn-deep wk-d">
        ${live ? runningCard(w) : ''}
        ${waiting ? askCard(w) : ''}
        ${w.status === 'dismissed' ? banner({ title: 'Marked as not a workout', text: 'Kept out of your history and totals.' }) : ''}
        ${justFinished && done ? mod({ title: done.title, fam: 'workouts', icon: 'record', body: done.body, cls: 'wk-done is-new' }) : ''}
        ${lead}
        ${xrows(rows, 'wp')}
        ${w.status === 'done' ? html`<div data-postslot></div>` : ''}
        ${change.length ? html`<div class="bsec"><h2>Change it</h2></div>${xrows(change)}` : ''}
      </div>`);
    stopTimers?.();
    stopTimers = live ? runTimers(root) : null;
    map?.destroy(); map = null;
    const mapEl = root.querySelector('[data-map]');
    if (mapEl && t?.line?.length > 1) map = routeMap(mapEl, { line: t.line, bounds: t.bounds, height: 220, label: `Map of the route, ${f.dist(t.distanceM)}` });
    paintShare();
  }

  /* Friends' feed: is this workout shared, and Share / Stop sharing (People, the feed). */
  let share = null;
  function paintShare() {
    const slot = root.querySelector('[data-postslot]');
    if (!slot) return;
    const draw = () => {
      if (!share || !slot.isConnected) return;
      const p = share.post;
      if (!share.canShare || !p) {
        mount(slot, html`<section class="bt bt--plain wk-share"><span class="wk-share__ic">${ic('lock', { size: 's' })}</span><span class="wk-share__t"><b>Not in the feed</b><small>${share.reason || 'This workout cannot be shared.'}</small></span></section>`);
        return;
      }
      mount(slot, html`<section class="bt bt--plain wk-share ${p.shared ? 'is-on' : ''}">
        <span class="wk-share__ic">${ic(p.shared ? 'users' : 'lock', { size: 's' })}</span>
        <span class="wk-share__t"><b>${p.shared ? 'Shared with friends' : 'Only you see this'}</b><small>${p.shared ? `${p.cheers ? f.plural(p.cheers, 'cheer') : 'No cheers yet'}${p.comments ? ` · ${f.plural(p.comments, 'comment')}` : ''}` : 'Friends see it in their feed once you share it'}</small></span>
        <span class="wk-share__b">${p.shared ? html`<a class="pill-btn pill-btn--soft" href="/post/${encodeURIComponent(p.id)}">Open</a><button type="button" class="pill-btn pill-btn--soft" data-wshare="off">Stop</button>` : html`<button type="button" class="pill-btn pill-btn--ink" data-wshare="on">Share</button>`}</span>
        <span class="wk-share__m">
          ${(p.media || []).slice(0, 4).map((m, i) => html`<button type="button" class="wk-share__th" data-wmedia="${i}" aria-label="${m.kind === 'video' ? 'Video' : 'Photo'} ${i + 1} of ${p.media.length}">${m.thumb ? html`<img src="${m.thumb}" alt="" loading="lazy" decoding="async">` : ic('play', { size: 's' })}</button>`)}
          ${(p.media || []).length > 4 ? html`<span class="wk-share__more n">+${p.media.length - 4}</span>` : ''}
          ${(p.media || []).length < MAX_PER_POST ? html`<button type="button" class="pill-btn pill-btn--soft" data-wphotos>${ic('camera', { size: 's' })}${p.media?.length ? 'Add more' : 'Add photos'}</button>` : ''}
        </span>
      </section>`);
    };
    if (share) draw();
    api.get(`${base}/post`).then((r) => { share = r; draw(); }).catch(() => {});
  }
  on(root, 'click', '[data-wphotos]', () => {
    if (share?.post) addToPost(share.post, { onDone: () => { api.get(`${base}/post`).then((r) => { share = r; paintShare(); }).catch(() => {}); } });
  });
  on(root, 'click', '[data-wmedia]', (e, b) => { if (share?.post?.media?.length) openViewer(share.post.media, Number(b.dataset.wmedia) || 0); });
  on(root, 'click', '[data-wshare]', async (e, b) => {
    await busy(b, async () => {
      try { share = await api.put(`${base}/post`, { shared: b.dataset.wshare === 'on' }); toast(b.dataset.wshare === 'on' ? 'Shared with your friends' : 'No longer shared'); paintShare(); } catch (err) { toastError(err); }
    });
  });

  /** One part of the workout in a sheet. */
  function openPart(key) {
    const p = parts?.[key];
    if (!p) return;
    const s = sheet({ title: p.title, body: html`<div class="pg-sh wk-sh fam fam-${p.fam || 'workouts'}">${p.body}</div>` });
    wire(s.el, s.close);
    on(s.el, 'click', 'a[href^="/"]', () => s.close());
    if (p.map) {
      const el = s.el.querySelector('[data-map]');
      let m = null;
      if (el && w.track?.line?.length > 1) requestAnimationFrame(() => { m = routeMap(el, { line: w.track.line, bounds: w.track.bounds, height: 260, label: `Map of the route, ${f.dist(w.track.distanceM)}` }); });
      s.closed.then(() => m?.destroy());
    }
  }

  async function load({ quiet = false, finished = false } = {}) {
    if (!quiet) mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${skeleton('chart')}`);
    try {
      const [one, all] = await Promise.all([api.get(base), meta ? Promise.resolve(meta) : api.get('/api/workouts?limit=1').catch(() => null)]);
      w = one; meta = all;
      if (!ctx.alive()) return;
      // Being logged set by set: the logger owns the screen until it is finished.
      if (w.draft && ['running', 'review', 'ongoing'].includes(w.status)) {
        if (!logger) { document.title = `${w.title || 'Workout'} · Health`; logger = mountLogger(root, w, { onLeave: ctx.onLeave, reload: (o) => load(o) }); }
        return;
      }
      if (logger) { logger(); logger = null; }
      if (finished) { justFinished = true; window.scrollTo(0, 0); }
      paint();
      // A Strava activity whose whole route was not read yet: read it now, once.
      if (!w.track && w.strava?.id && !w.strava.own && w.route && !triedStream) {
        triedStream = true;
        api.post(`${base}/route/strava`, {}).then((x) => { if (ctx.alive() && x?.track) { w = x; paint(); } }).catch(() => {});
      }
    } catch (err) {
      if (!ctx.alive() || quiet) return;
      if (err.status === 404) {
        mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${mod({ label: 'Workout not found', body: html`<div class="empty wk-empty">${ib('workouts', { size: 'l', plain: true })}<p class="empty__t">This workout is not here</p><p class="empty__d">It may have been deleted, or the link is old.</p><a class="btn btn--tonal btn--s" href="/workouts">Back to workouts</a></div>` })}`);
      } else mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${errorState(err)}`);
    }
  }

  /* Actions live on the page and in the sheets the rows open: a sheet
     closes before its action runs (the page is repainted after). */
  const acts = [];
  const act = (sel, fn) => { acts.push([sel, fn]); on(root, 'click', sel, fn); };
  const wire = (el, close) => { for (const [sel, fn] of acts) on(el, 'click', sel, (e, b) => { if (sel !== '[data-lib]') close(); fn(e, b); }); };
  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-wp]', (e, b) => openPart(b.dataset.wp));
  act('[data-action="edit"]', () => editSheet(w, meta, () => load({ quiet: true })));
  act('[data-action="edit-sets"]', () => setsSheet(w, () => { refreshMe().catch(() => {}); load({ quiet: true }); }));
  act('[data-action="save-routine"]', async () => {
    const s = sheet({
      title: 'Save as a Hevy routine',
      body: html`<form class="form" id="rt-form" novalidate>${field({ label: 'Routine name', name: 'title', value: w.title || '', attrs: 'maxlength="80" autocomplete="off" required' })}<p class="field__hint">Exercises from your Hevy library, with these sets as the targets. It appears in Hevy under Routines.</p></form>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="rt-form">Save routine</button>`,
    });
    s.el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/hevy/routines', { workoutId: w.id, title: e.target.elements.title.value.trim() || undefined }));
        if (r === undefined) return;
        s.close(); toast(`"${r.routine?.title || 'Routine'}" is in Hevy now`);
      } catch (err) { toastError(err); }
    });
  });
  act('[data-action="edit-times"]', async () => {
    const t = await timesSheet({ title: 'Edit times', start: w.start, end: w.end ?? w.lastEnd ?? Date.now(), text: 'The heart rate, steps and calories are worked out again for the new times.' });
    if (!t) return;
    try { await api.post(`${base}/save`, t); toast('Times saved'); refreshMe().catch(() => {}); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  act('[data-action="retry-upload"]', async (e, btn) => {
    try { const r = await busy(btn, () => api.post(`${base}/retry`)); if (r === undefined) return; toast('Trying again'); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  act('[data-action="delete"]', async () => {
    const saved = w.google?.state === 'saved';
    const yes = await confirm({ title: 'Delete this workout?', text: saved ? 'It is removed here and from Google Health. This cannot be undone.' : 'It is removed from your history. This cannot be undone.', yes: 'Delete', danger: true });
    if (!yes) return;
    try { await api.del(base); toast('Workout deleted'); refreshMe().catch(() => {}); go('/workouts', { replace: true }); } catch (err) { toastError(err); }
  });
  bindWorkoutActions(root, {
    find: () => w,
    done: (payload) => {
      const still = payload.running?.id === id || payload.pending?.some((x) => x.id === id) || payload.history?.some((x) => x.id === id);
      if (still) load({ quiet: true }); else go('/workouts', { replace: true });
    },
  });
  act('[data-lib]', (e, b) => exerciseInfo(b.dataset.lib));
  act('[data-act="rt-update"]', async (e, b) => {
    const r = w.routine;
    if (!(await confirm({ title: `Update "${r.title}"?`, text: 'Its exercises and sets become what you did in this workout. Rest times and notes stay.', yes: 'Update routine' }))) return;
    try { await busy(b, () => api.post(`/api/routines/${encodeURIComponent(r.id)}/from-workout`, { workoutId: w.id })); toast('Routine updated'); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  act('[data-act="rt-new"]', async () => {
    const title = await askText({ title: 'Save as a routine', label: 'Routine name', value: w.title || '', save: 'Save routine', hint: 'Its exercises and these sets become the plan, to start next time in a tap.' });
    if (title === null) return;
    try { const r = await api.post('/api/routines/from-workout', { workoutId: w.id, title: title || undefined }); toast(`"${r.routine.title}" saved`); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  act('[data-act="rt-pick"]', async () => {
    try { rts = rts || await api.get('/api/routines'); } catch (err) { toastError(err); return; }
    const none = !(w.exercises || []).length;
    const s = sheet({
      title: 'Which routine was it?',
      body: rts.routines.length ? html`<div class="group">${rts.routines.map((r) => html`<button type="button" class="row" data-pick="${r.id}"><span class="row__ic">${ic('list')}</span><span class="row__body"><span class="row__t">${r.title}</span><span class="row__d">${[r.folder, f.plural(r.exercises, 'exercise')].filter(Boolean).join(' · ')}</span></span>${w.routine?.id === r.id ? ic('check', { size: 's' }) : ''}</button>`)}
        ${w.routine ? html`<button type="button" class="row" data-pick=""><span class="row__ic">${ic('unlink')}</span><span class="row__body"><span class="row__t">Not from a routine</span></span></button>` : ''}</div>
        ${none ? html`<p class="field__hint">This workout has no sets yet: the routine's are filled in, to change to what you did.</p>` : ''}`
        : html`<p class="prose">You have no routines yet. <a class="link" href="/workouts/routines">Make one, or pick a programme</a>.</p>`,
    });
    on(s.el, 'click', '[data-pick]', async (e, b) => {
      s.close();
      try { await api.post(`${base}/routine`, { routineId: b.dataset.pick || null, fill: none }); toast(b.dataset.pick ? 'Routine linked' : 'Routine unlinked'); load({ quiet: true }); } catch (err) { toastError(err); }
    });
  });
  ctx.onLeave(listen('changed', (what) => { if (what.includes('workouts') && !logger) load({ quiet: true }); }));
  ctx.onLeave(() => { stopTimers?.(); map?.destroy(); logger?.(); });
  ctx.onRefresh(() => { if (!logger) load({ quiet: true }); });
  googleReturn(ctx, `/workouts/${encodeURIComponent(id)}`);
  await load();
}

/* ── Hevy import ────────────────────────────────────────────── */

const RESULT = { imported: ['New', 'badge--accent'], merged: ['Merged', 'badge--ok'], skipped: ['Already here', ''] };

async function importer(ctx) {
  const { root } = ctx;
  document.title = 'Import from Hevy · Health';
  let file = null; let text = null; let preview = null; let result = null; let problem = null; let reading = false;

  function report(r, isPreview) {
    const items = r.items || [];
    return html`
      ${mod({
        title: isPreview ? 'What would change' : 'What changed', fam: 'workouts', icon: 'upload', span: 12,
        note: `${f.plural(r.found, 'workout')} and ${f.plural(r.sets, 'set')} in the file`,
        body: html`
          <div class="stats stats--3">
            ${stat({ label: isPreview ? 'New' : 'Imported', value: f.int(r.imported), context: html`<span class="muted">${isPreview ? 'Will be added' : 'Added to your log'}</span>` })}
            ${stat({ label: isPreview ? 'To merge' : 'Merged', value: f.int(r.merged), context: html`<span class="muted">Sets ${isPreview ? 'go onto' : 'put on'} a workout you have</span>` })}
            ${stat({ label: isPreview ? 'Already here' : 'Skipped', value: f.int(r.skipped), context: html`<span class="muted">Imported before</span>` })}
          </div>
          <p class="chart__note wk-note">Merged means the sets ${isPreview ? 'will be' : 'were'} attached to a workout you already have at that time. Already here means it was imported before, so nothing changes.</p>`,
      })}
      ${r.errors?.length ? banner({ tone: 'warn', title: `${f.plural(r.errors.length, 'row')} could not be read`, text: r.errors.slice(0, 4).join(' ') + (r.errors.length > 4 ? ` And ${r.errors.length - 4} more.` : '') }) : ''}
      ${r.unknownExercises?.length ? banner({ title: 'Some exercises were not recognised', text: `${r.unknownExercises.slice(0, 8).join(', ')}${r.unknownExercises.length > 8 ? ` and ${r.unknownExercises.length - 8} more` : ''}. They are imported all the same and counted under "other" in muscle totals.` }) : ''}
      ${items.length ? mod({
        title: 'Workouts in the file', icon: 'list', span: 12, cls: 'mod--flush',
        note: items.length > 60 ? `Showing the first 60 of ${f.int(items.length)}` : '',
        body: html`${items.slice(0, 60).map((it) => {
          const [label, tone] = RESULT[it.result] || [it.result, ''];
          const target = it.id || it.mergedInto;
          const inner = html`<span class="row__body"><span class="row__t">${it.title || 'Workout'}</span><span class="row__d">${f.dayMed(f.instDay(it.start))}, ${f.clock(it.start)} · ${f.plural(it.sets, 'set')}</span></span><span class="badge ${tone}">${label}</span>`;
          return !isPreview && target ? html`<a class="row" href="/workouts/${encodeURIComponent(target)}">${inner}</a>` : html`<div class="row">${inner}</div>`;
        })}`,
      }) : ''}`;
  }

  function paint() {
    const canWrite = app.me.google?.canWriteWorkouts === true && app.me.google?.state === 'ok';
    let body;
    if (result) {
      body = html`
        ${banner({ tone: 'ok', iconName: 'check', title: result.imported + result.merged > 0 ? 'Import finished' : 'Nothing new in this file', text: result.imported + result.merged > 0 ? `${f.plural(result.imported, 'workout')} added, ${f.int(result.merged)} merged.${result.toUpload ? ` ${f.plural(result.toUpload, 'workout')} will be saved to Google Health shortly.` : ''}` : 'Everything in it was already imported, so nothing changed.' })}
        ${report(result, false)}
        <div class="btnrow"><a class="btn" href="/workouts">See your workouts</a><button type="button" class="btn btn--tonal" data-action="reset">Import another file</button></div>`;
    } else if (preview) {
      const n = preview.imported + preview.merged;
      body = html`
        <div class="wk-file"><span class="ib fam fam-workouts">${ic('text')}</span><h2 class="wk-file__n">${file?.name || 'Your file'}</h2><button type="button" class="btn btn--ghost btn--s" data-action="reset">Choose another</button></div>
        ${report(preview, true)}
        ${n > 0 ? mod({ span: 12, cls: 'mod--flush', label: 'Options', body: html`<div class="row">
          <span class="row__body"><span class="row__t" id="up-l">Also save these to Google Health</span>
          <span class="row__d">${canWrite ? 'Only the ones Google does not already have. Leave it off to keep them in this app only.' : 'Not available: reconnect Google to allow saving workouts.'}</span></span>
          ${toggle('upload', false, { label: 'Also save these to Google Health', disabled: !canWrite })}
        </div>` }) : ''}
        <div class="btnrow">
          <button type="button" class="btn" data-action="import" ${n > 0 ? '' : 'disabled'}>${n > 0 ? `Import ${f.plural(n, 'workout')}` : 'Nothing to import'}</button>
        </div>`;
    } else {
      body = html`
        ${problem ? banner({ tone: 'bad', title: problem }) : ''}
        <label class="drop fam fam-workouts imp-drop" data-drop>
          <input type="file" accept=".csv,text/csv" data-file>
          ${ib('upload', { size: 'l' })}
          <span class="drop__t">${reading ? 'Reading the file' : 'Choose your Hevy CSV'}</span>
          <span class="muted small">${reading ? 'A moment for a long history.' : 'Up to 5 MB. Nothing is saved until you confirm.'}</span>
        </label>
        ${xrows([
          { attrs: 'data-action="howto"', icon: 'book', fam: 'workouts', title: 'Get the file from Hevy', text: 'Profile, Settings, Export Workouts' },
          { attrs: 'data-action="adds"', icon: 'trends', fam: 'workouts', title: 'What it adds', text: 'Sets, volume, records, progress' },
        ])}
        <p class="rt-intro">Importing the same file twice is safe: what is already here is skipped.</p>`;
    }
    mount(root, html`${head({ title: 'Import from Hevy', back: '/workouts' })}<div class="stack trn-deep imp">${body}</div>`);
  }

  async function choose(picked) {
    problem = null;
    if (!picked) return;
    if (picked.size > MAX_CSV) { problem = `That file is ${(picked.size / 1048576).toFixed(1)} MB. The limit is 5 MB; export a shorter period from Hevy.`; paint(); return; }
    if (picked.size === 0) { problem = 'That file is empty. Export it from Hevy again.'; paint(); return; }
    reading = true; paint();
    try {
      text = await picked.text();
      file = picked;
      preview = await api.upload('/api/workouts/import/hevy?dryRun=1', text, 'text/csv');
    } catch (err) {
      problem = err.status === 400 ? `${err.message} Check that it is the workouts.csv file from Hevy.` : errText(err, 'The file could not be read. Try again.');
      preview = null;
    }
    reading = false;
    if (ctx.alive()) paint();
  }

  on(root, 'click', '[data-action="howto"]', () => sheet({ title: 'Get the file from Hevy', body: html`<ol class="howto">
    <li><span>Open Hevy and go to your <b>Profile</b>, then <b>Settings</b>.</span></li>
    <li><span>Choose <b>Export &amp; Import Data</b>, then <b>Export Workouts</b>.</span></li>
    <li><span>Hevy gives you a file called <b>workouts.csv</b>. Save it to your phone or send it to yourself.</span></li>
  </ol>` }));
  on(root, 'click', '[data-action="adds"]', () => sheet({ title: 'What it adds', body: html`<p class="prose">Your exercises and sets, and with them weekly volume, muscle balance, records and progress for each exercise.</p>` }));
  on(root, 'change', '[data-file]', (e, input) => choose(input.files?.[0]));
  on(root, 'dragover', '[data-drop]', (e, el) => { e.preventDefault(); el.classList.add('is-over'); });
  on(root, 'dragleave', '[data-drop]', (e, el) => el.classList.remove('is-over'));
  on(root, 'drop', '[data-drop]', (e) => { e.preventDefault(); choose(e.dataTransfer?.files?.[0]); });
  on(root, 'click', '[data-action="reset"]', () => { file = null; text = null; preview = null; result = null; problem = null; paint(); });
  on(root, 'click', '[data-action="import"]', async (e, btn) => {
    const upload = root.querySelector('input[name="upload"]')?.checked ? 1 : 0;
    try {
      const r = await busy(btn, () => api.upload(`/api/workouts/import/hevy?upload=${upload}`, text, 'text/csv'));
      if (r === undefined) return;
      result = r;
      refreshMe().catch(() => {});
      paint();
      window.scrollTo(0, 0);
    } catch (err) { toastError(err, 'The import did not finish. Nothing was half-saved; try again.'); }
  });
  paint();
}

/* ── detection settings ─────────────────────────────────────── */

const FIELDS = [
  ['plusBpm', 'Heart rate above resting', 'bpm', 'How far above your resting heart rate counts as effort.'],
  ['minStartMin', 'Minutes before it asks', 'min', 'How long the effort has to last before you are asked.'],
  ['minTotalMin', 'Shortest workout', 'min', 'Anything shorter is ignored.'],
  ['calmMin', 'Calm minutes that end it', 'min', 'How long your heart rate has to stay down before it counts as over.'],
  ['walkSteps', 'Walking pace', 'steps a minute', 'At or above this, raised heart rate is treated as a walk, not a workout.'],
  ['autoCloseMin', 'Close a forgotten workout after', 'min', 'A workout you started by hand is closed for review after this long with a calm heart rate.'],
];

async function detection(ctx) {
  const { root } = ctx;
  document.title = 'Workout detection · Health';
  let d = null;

  function paint() {
    const det = d.detection || {};
    const s = det.settings || {};
    const locked = !det.available || det.suppressedByLink;
    const on_ = Boolean(s.enabled) && det.available;
    const srow = (t, sub, right) => html`<div class="me-srow"><div class="me-srow__b"><p class="me-srow__t">${t}</p>${sub ? html`<p class="me-srow__d">${sub}</p>` : ''}</div>${right}</div>`;
    const val = (v) => html`<span class="det-v">${v}</span>`;
    mount(root, html`
      ${head({ title: 'Detection', back: '/workouts' })}
      <div class="stack trn-deep det">
        ${!det.available ? banner({ tone: 'warn', title: 'Not available on your device', text: det.reason || 'It needs minute-by-minute heart rate, which your device does not report.' }) : ''}
        ${det.available && det.suppressedByLink ? banner({ iconName: 'link', title: 'The console module is doing this', text: 'Its settings are the module\'s to change; its questions still show up here.' }) : ''}
        <div class="me-grp">
          ${srow('Notice workouts', 'Asks when your heart rate stays up', toggle('enabled', on_, { label: 'Notice workouts from my heart rate', disabled: locked }))}
          ${det.available && !det.suppressedByLink && s.enabled ? srow('Last checked', det.last?.error ? `It failed: ${det.last.error}` : 'Every few minutes, by itself', html`<button type="button" class="pill-btn pill-btn--soft" data-action="check">${det.last?.checkedAt ? f.ago(det.last.checkedAt) : 'Not yet'} · Check</button>`)
            : det.available ? srow('Last checked', on_ ? '' : 'Nothing is checked while it is off', val(det.last?.checkedAt ? f.ago(det.last.checkedAt) : 'Not yet')) : ''}
        </div>
        ${det.available ? html`<div class="bsec"><h2>Your heart rate</h2></div>
          <div class="me-grp">
            ${srow('Resting heart rate', 'Your 30-day average', val(`${f.int(det.rest)} bpm`))}
            ${srow('Effort starts at', `${f.int(s.plusBpm)} above resting`, val(`${f.int(det.threshold)} bpm`))}
          </div>` : ''}
        <div class="bsec"><h2>Settings</h2></div>
        ${xrows([
          { attrs: 'data-action="thresholds"', icon: 'admin', title: 'What counts as a workout', text: locked ? 'These cannot be changed here' : `${f.int(s.plusBpm)} bpm above resting, ${f.int(s.minStartMin)} min before it asks` },
          d.exerciseTypes?.length ? { attrs: 'data-action="kind"', icon: 'strength', fam: 'workouts', title: 'Saved to Google Health as', text: d.exerciseTypes.find((t) => t.id === d.exerciseType)?.label || typeLabel(d.exerciseType) } : null,
        ].filter(Boolean))}
      </div>`);
  }

  function thresholds() {
    const det = d.detection || {};
    const s0 = det.settings || {};
    const locked = !det.available || det.suppressedByLink;
    const b = det.bounds || {};
    const s = sheet({
      title: 'What counts as a workout',
      body: html`<form class="form ex-form" id="det-form" novalidate><div class="ex-nums">
        ${FIELDS.map(([key, label, unit, hint]) => html`<div class="field ex-num"><label class="ex-num__l" for="det-${key}">${label}<span class="det-h">${hint}${b[key] ? ` ${b[key][0]} to ${b[key][1]}.` : ''}</span></label>
          <span class="ex-num__in"><input class="input ex-num__i" id="det-${key}" name="${key}" type="number" inputmode="numeric" step="1" value="${s0[key] ?? ''}" ${b[key] ? raw(`min="${b[key][0]}" max="${b[key][1]}"`) : ''} ${locked ? 'disabled' : ''}><span class="ex-num__u det-u">${unit === 'steps a minute' ? 'spm' : unit}</span></span>
          <div data-err="${key}"></div></div>`)}
      </div></form>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button>${locked ? '' : html`<button type="submit" class="btn" form="det-form">Save</button>`}`,
    });
    const form = s.el.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = formValues(form);
      const body = {};
      let bad = false;
      for (const [key] of FIELDS) {
        fieldError(form, key, '');
        if (!f.isNum(v[key])) { fieldError(form, key, 'Enter a number.'); bad = true; continue; }
        if (b[key] && (v[key] < b[key][0] || v[key] > b[key][1])) { fieldError(form, key, `Between ${b[key][0]} and ${b[key][1]}.`); bad = true; continue; }
        body[key] = Math.round(v[key]);
      }
      if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
      save(body, 'Saved', s.el.querySelector('button[type="submit"]')).then((ok) => { if (ok) s.close(); });
    });
  }

  function kindSheet() {
    const s = sheet({
      title: 'Saved to Google Health as',
      body: html`<div class="pg-sh"><p class="pg-sh__note">For workouts you start, log, or that are detected.</p>
        <div class="xrows">${d.exerciseTypes.map((t) => html`<button type="button" class="xrow xrow--plain press" data-kind="${t.id}"><span class="xrow__b"><span class="xrow__t">${t.label}</span></span>${t.id === d.exerciseType ? html`<span class="xrow__v">${ic('check', { size: 's' })}</span>` : html`<span></span>`}</button>`)}</div></div>`,
    });
    on(s.el, 'click', '[data-kind]', (e, b) => { s.close(); save({ exerciseType: b.dataset.kind }, 'Saved', null); });
  }

  async function save(body, okText, btn) {
    try {
      const p = await busy(btn, () => api.post('/api/workouts/settings', body));
      if (p === undefined) return false;
      d = p; toast(okText); paint(); return true;
    } catch (err) { toastError(err); paint(); return false; }
  }

  on(root, 'change', 'input[name="enabled"]', (e, input) => save({ enabled: input.checked }, input.checked ? 'Detection is on' : 'Detection is off', null));
  on(root, 'click', '[data-action="thresholds"]', () => thresholds());
  on(root, 'click', '[data-action="kind"]', () => kindSheet());
  on(root, 'click', '[data-action="check"]', async (e, btn) => {
    try {
      const p = await busy(btn, () => api.post('/api/workouts/check'));
      if (p === undefined) return;
      d = p; refreshMe().catch(() => {});
      toast(p.pending?.length ? 'Found something. Look at your workouts.' : 'Checked. Nothing that looks like a workout right now.');
      paint();
    } catch (err) { toast(err.status === 429 ? 'Checked a moment ago. Try again in half a minute.' : errText(err), { tone: err.status === 429 ? '' : 'bad' }); }
  });
  on(root, 'click', '[data-action="retry"]', () => load());

  async function load() {
    mount(root, html`${head({ title: 'Detection', back: '/workouts' })}${skeleton('form')}`);
    try { d = await api.get('/api/workouts?limit=1'); if (ctx.alive()) paint(); } catch (err) {
      if (ctx.alive()) mount(root, html`${head({ title: 'Detection', back: '/workouts' })}${errorState(err)}`);
    }
  }
  await load();
}

export default async function workouts(ctx) {
  if (ctx.name === 'detail') return detail(ctx);
  if (ctx.name === 'import') return importer(ctx);
  if (ctx.name === 'detection') return detection(ctx);
  return list(ctx);
}
