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
import { cats, hours, stacked, spark, trace } from '../viz.js';
import { mod, grid, stat, split, facts, figure, ib, tooFew } from '../kit.js';
import * as f from '../format.js';
import { connectionBanner, runningCard, askCard, runTimers, bindWorkoutActions, startWorkout, timesSheet, workoutTitle, typeLabel, sourceLabel, googleStateText } from './shared.js';

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
const volNum = (kg) => f.int(f.weightVal(kg));
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
  if (!wk) return mod({ title: 'This week', fam: 'workouts', icon: 'week', span: 12, body: actions });
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
    list.push(stat({ size: 'l', label: 'Volume', value: volNum(wk.volumeKg), unit: f.weightUnit(),
      context: known ? againstUsual(wk.volumeKg, a.volumeKg, (v) => `${volNum(v)} ${f.weightUnit()}`, { tol: Math.max(1, (a.volumeKg || 0) * 0.03), less: 'less', usual: volNum(a.volumeKg) }) : none }));
  }
  return mod({
    title: 'This week', fam: 'workouts', icon: 'week', span: 12, cls: 'wk-week',
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
  return mod({
    title: 'Last 12 weeks', fam: 'workouts', icon: 'history', span: 7,
    tools: seg('wkmode', [['time', 'Time'], ['sessions', 'Sessions']], mode, { fit: true, label: 'What the bars show' }),
    body: html`
      ${graph}
      <hr class="rule">
      ${facts([
        { k: 'Sessions a week', v: num1(sum(full.map((w) => w.workouts)) / fullN), s: 'Average of 11 full weeks' },
        { k: 'Time a week', v: f.dur(sum(full.map((w) => w.minutes)) / fullN), s: 'Average of 11 full weeks' },
        { k: 'Weeks with a session', v: `${n} of ${weeks.length}`, s: n === weeks.length ? 'Not one missed' : `${f.plural(weeks.length - n, 'week')} without` },
        top ? { k: 'Longest week', v: f.dur(top.minutes), s: `Week of ${f.dayShort(top.week)}, ${f.plural(top.workouts, 'session')}` } : null,
      ], { cols: 2, cls: 'facts--s wk-facts4' })}`,
  });
}

function whenMod(t, span = 5) {
  const wd = (t.weekday || []).slice().sort((a, b) => a.dow - b.dow).map((x) => x.workouts);
  const hrs = t.hours || [];
  const total = sum(wd);
  if (total < 3) return mod({ title: 'When you train', icon: 'calendar', span, body: tooFew(total, 3, 'sessions') });
  const max = Math.max(...wd);
  const days = wd.map((v, i) => (v > 0 && v >= max * 0.6 ? WD3[i] : null)).filter(Boolean);
  let peak = 0;
  hrs.forEach((v, i) => { if (v > hrs[peak]) peak = i; });
  const peakShare = Math.round((hrs[peak] / Math.max(1, sum(hrs))) * 100);
  const best = wd.indexOf(max);
  const tied = wd.map((v, i) => (v === max ? WD3[i] : null)).filter(Boolean);
  const hh = (i) => `${String(i).padStart(2, '0')}:00`;
  return mod({
    title: 'When you train', fam: 'workouts', icon: 'calendar', span,
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
  return mod({
    title: 'Heart-rate zones', fam: 'heart', icon: 'heart', span, note: 'Minutes a week in each zone',
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
  return mod({
    title: 'Strength volume', fam: 'workouts', icon: 'strength', span, note: `Weight × reps a week, in ${f.weightUnit()}`,
    body: html`
      ${figure(chart((w) => cats({
        w, h: 168, labels, a: weeks.map((x) => f.weightVal(x.volumeKg || 0)),
        reads: weeks.map((x, i) => `Week of ${labels[i]}${i === weeks.length - 1 ? ' (so far)' : ''}: ${x.sets ? `${volNum(x.volumeKg)} ${f.weightUnit()} in ${f.plural(x.sets, 'set')}${topMuscle(x)}` : 'no sets'}`),
        label: `Strength volume in each of the last 12 weeks, in ${f.weightUnit()}.`,
      })), {
        read: `${volNum(cur.volumeKg || 0)} ${f.weightUnit()} this week so far`,
        table: tableAlt(['Week of', 'Sets', `Volume (${f.weightUnit()})`], weeks.map((x, i) => [labels[i], f.int(x.sets), volNum(x.volumeKg)]).reverse()),
      })}
      <hr class="rule">
      ${facts([
        { k: 'Sets a week', v: num1(d.strength?.setsPerWeek ?? t.week?.avg4?.sets), s: 'Average of the last 4 full weeks' },
        { k: 'Volume a week', v: volNum(t.week?.avg4?.volumeKg), u: f.weightUnit(), s: 'Average of the last 4 full weeks' },
        top ? { k: 'Heaviest week', v: volNum(top.volumeKg), u: f.weightUnit(), s: `Week of ${f.dayShort(top.week)}` } : null,
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
  return mod({
    title: 'Muscle balance', fam: 'workouts', icon: 'target', span, note: 'Sets in the last 4 weeks',
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
  return mod({
    title: 'Records', fam: 'workouts', icon: 'record', span,
    note: groups.length ? `${f.plural(groups.length, 'lift')} improved in the last 30 days` : 'Last 30 days',
    body,
  });
}

const lastWith = (x, key) => [...(x.sessions || [])].reverse().find((s) => f.isNum(s[key])) || null;

function progressMod(t, span = 12) {
  const list = (t.exercises || []).filter((x) => x.sessions?.length);
  if (!list.length) return '';
  return mod({
    title: 'Progress by exercise', fam: 'workouts', icon: 'trends', span,
    note: 'Estimated one-rep max, session by session; the top set where sets are too long to estimate from. Tap one for its history.',
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
        <thead><tr><th scope="col">Session</th><th scope="col" class="n">Top set</th><th scope="col" class="n">Est. 1RM</th><th scope="col" class="n">Sets</th><th scope="col" class="n">Volume</th></tr></thead>
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

function sessionRow(w, d) {
  const types = d.exerciseTypes;
  const zones = d.training?.zones;
  const day = f.instDay(w.start);
  const title = workoutTitle(w, types);
  const bits = [f.clock(w.start), sourceLabel(w)];
  if (w.sets?.sets) bits.push(f.plural(w.sets.sets, 'set'), `${volNum(w.sets.volumeKg)} ${f.weightUnit()}`);
  const sp = Array.isArray(w.spark) && w.spark.filter(f.isNum).length >= 3;
  const zm = Array.isArray(w.zonesMin) && sum(w.zonesMin) > 0;
  return html`<a class="ses" href="/workouts/${encodeURIComponent(w.id)}">
    <span class="ses__date" aria-hidden="true"><span class="ses__dow">${f.dow(day)}</span><span class="ses__day">${f.dom(day)}</span></span>
    <span class="ses__b">
      <span class="ses__t"><span class="ib ib--s fam fam-workouts">${ic(typeIcon(w))}</span><span class="ses__name">${title}</span>${w.prCount > 0 ? recBadge(w.prCount) : ''}</span>
      <span class="ses__d"><span class="sr">${f.dayMed(day)}, </span>${bits.map((b, i) => html`${i ? ' · ' : ''}<span class="nw">${b}</span>`)}</span>
    </span>
    <span class="ses__viz fam fam-heart">${sp ? chart((cw) => trace({ w: cw, h: 30, values: w.spark, label: `Heart rate through the session, from ${Math.round(Math.min(...w.spark.filter(f.isNum)))} to ${Math.round(Math.max(...w.spark.filter(f.isNum)))} bpm` })) : ''}${zm ? zoneSplit(zones, w.zonesMin) : ''}</span>
    <span class="ses__v"><span class="ses__dur">${f.dur(w.durationMin)}</span>${f.isNum(w.avgHr) ? html`<span class="ses__hr">${ic('heart', { size: 's' })}${Math.round(w.avgHr)} bpm</span>` : ''}</span>
    <span class="row__chev">${ic('right', { size: 's' })}</span>
  </a>`;
}

function sessionsMod(all, d, visible) {
  const history = all.slice(0, visible);
  const groups = new Map();
  for (const w of history) {
    const wkStart = f.weekStart(f.instDay(w.start));
    if (!groups.has(wkStart)) groups.set(wkStart, []);
    groups.get(wkStart).push(w);
  }
  const anyViz = history.some((w) => w.spark || w.zonesMin);
  return mod({
    title: 'Sessions', fam: 'workouts', icon: 'list', span: 12, cls: `mod--flush wk-sessions ${anyViz ? 'has-viz' : ''}`,
    note: anyViz ? 'Newest first. The line is heart rate through the session, the bar its time in zones.' : 'Newest first',
    body: html`${[...groups.entries()].map(([wkStart, items]) => {
      const sets = sum(items.map((w) => w.sets?.sets));
      return html`<div class="sesweek">
        <h3 class="sesweek__t">${f.weekLabel(wkStart)}</h3>
        <span class="sesweek__s">${f.plural(items.length, 'session')} · ${f.dur(sum(items.map((w) => w.durationMin)))}${sets ? ` · ${f.plural(sets, 'set')}` : ''}</span>
      </div>${items.map((w) => sessionRow(w, d))}`;
    })}`,
    foot: d.more || all.length > history.length ? html`<div class="btnrow wk-more"><button type="button" class="btn btn--tonal btn--s" data-action="more">Show older workouts</button></div>` : '',
  });
}

function toolsMod(d, span = 12) {
  const det = d.detection || {};
  return mod({
    title: 'Tools', icon: 'settings', span, cls: 'mod--flush wk-tools',
    body: html`
      ${row({ href: '/workouts/import', iconName: 'upload', title: 'Import from Hevy', text: 'Bring in your exercises and sets from a Hevy export' })}
      ${row({ href: '/workouts/detection', iconName: 'wave', title: 'Detection', text: !det.available ? 'Not available on your device' : det.suppressedByLink ? 'Handled by the console module' : det.settings?.enabled ? 'On: asks when your heart rate looks like a workout' : 'Off: you start and log workouts yourself', value: det.available && !det.suppressedByLink ? html`<span class="badge ${det.settings?.enabled ? 'badge--accent' : ''}">${det.settings?.enabled ? 'On' : 'Off'}</span>` : '' })}`,
  });
}

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
    body: html`<form class="form" id="log-form" novalidate>
      <div data-slot="error"></div>
      ${field({ label: 'Started', name: 'start', type: 'datetime-local', value: f.toLocalInput(now - 75 * 60000), attrs: 'required step="60"' })}
      ${field({ label: 'Ended', name: 'end', type: 'datetime-local', value: f.toLocalInput(now - 15 * 60000), attrs: 'required step="60"', hint: 'Between 5 minutes and 6 hours long, in the last 30 days.' })}
      ${field({ label: 'Name (optional)', name: 'title', attrs: 'maxlength="80" autocomplete="off" placeholder="Push day"' })}
      ${d.exerciseTypes?.length ? field({ label: 'Kind', name: 'type', value: d.exerciseType, options: d.exerciseTypes.map((t) => [t.id, t.label]) }) : ''}
      ${field({ label: 'Notes (optional)', name: 'notes', type: 'textarea', attrs: 'maxlength="2000" rows="3"' })}
      <p class="field__hint">${d.canWrite ? 'It is saved to Google Health as well.' : 'It is kept in this app only. Reconnect Google to allow saving workouts there too.'}</p>
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

async function list(ctx) {
  const { root } = ctx;
  document.title = 'Workouts · Health';
  let d = null; let history = []; let stopTimers = null; let mode = 'time'; let visible = FIRST;

  function paint() {
    const t = d.training || {};
    const weeks = t.weeks || [];
    const hasAny = history.length > 0 || weeks.some((w) => w.workouts > 0);
    const hasSets = weeks.some((w) => w.sets > 0) || (t.exercises || []).length > 0 || (t.prs || []).length > 0;
    const modules = !hasAny
      ? html`${emptyMod(d)}${toolsMod(d)}`
      : html`
        ${weekMod(d)}
        ${weeks.length ? html`${weeksMod(t, mode)}${whenMod(t, 5)}` : ''}
        ${hasSets
          ? html`${zonesMod(t, 5)}${volumeMod(d, 7)}${balanceMod(t, 6)}${recordsMod(t, 6)}${progressMod(t, 12)}`
          : html`${zonesMod(t, 7)}<div class="mod--5 wk-col">${mod({
              title: 'Strength', fam: 'workouts', icon: 'strength', span: 12,
              body: html`<p class="wk-say wk-say--quiet">There are no sets in your log. Import them from Hevy and this page adds weekly volume, muscle balance, records and progress for each exercise.</p>
                <div class="btnrow"><a class="btn btn--tonal btn--s" href="/workouts/import">${ic('upload', { size: 's' })}Import from Hevy</a></div>`,
            })}${toolsMod(d)}</div>`}
        ${history.length ? sessionsMod(history, d, visible) : ''}
        ${hasSets ? toolsMod(d) : ''}`;
    mount(root, html`
      ${head({ title: 'Workouts', sub: hasAny ? 'Your training log' : '' })}
      <div class="stack">
        ${connectionBanner('/workouts')}
        ${d.needsReconnect ? banner({ tone: 'warn', iconName: 'key', title: 'Workouts are not reaching Google Health', text: `Reconnect to allow saving workouts.${d.unsaved ? ` ${f.plural(d.unsaved, 'workout')} ${d.unsaved === 1 ? 'is' : 'are'} waiting.` : ''}`, actions: html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="/workouts">Reconnect Google</button>` }) : ''}
        ${d.running ? runningCard(d.running) : ''}
        ${(d.pending || []).map((w) => askCard(w))}
        ${grid(modules, 'grid--rows wkg')}
      </div>`);
    stopTimers?.();
    stopTimers = d.running ? runTimers(root) : null;
  }

  const take = (payload) => { d = payload; history = payload.history || []; if (ctx.alive()) paint(); };

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, html`${head({ title: 'Workouts' })}${skeleton('chart')}`);
    try {
      take(await api.get('/api/workouts?limit=40'));
    } catch (err) {
      if (ctx.alive() && !quiet) mount(root, html`${head({ title: 'Workouts' })}${errorState(err)}`);
    }
  }

  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="start"]', (e, btn) => startWorkout(btn, take));
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
  on(root, 'click', '[data-ex]', (e, btn) => {
    const x = (d?.training?.exercises || []).filter((it) => it.sessions?.length)[Number(btn.dataset.ex)];
    if (x) exerciseSheet(x);
  });
  bindWorkoutActions(root, {
    find: (id) => (d?.running?.id === id ? d.running : d?.pending?.find((w) => w.id === id)),
    done: take,
  });
  ctx.onLeave(listen('changed', (what) => { if (what.includes('workouts')) load({ quiet: true }); }));
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


/** Exercises and sets, edited in a sheet and saved whole (PUT …/sets). */
function setsSheet(w, done) {
  const blankSet = () => ({ kg: null, reps: null, type: 'normal' });
  let list = (w.exercises || []).map((x) => ({
    name: x.name || '', was: x.name || '', muscle: x.muscle || null, notes: x.notes || null, templateId: x.templateId || null,
    sets: (x.sets || []).map((s) => ({ kg: s.kg, reps: s.reps, type: s.type || 'normal', rpe: s.rpe, distanceM: s.distanceM, durationS: s.durationS })),
  }));
  if (!list.length) list = [{ name: '', was: '', muscle: null, notes: null, sets: [blankSet()] }];
  const unit = f.weightUnit();
  const shown = (kg) => (f.isNum(kg) ? String(Math.round(f.weightVal(kg) * 100) / 100) : '');

  const s = sheet({
    title: 'Exercises and sets',
    body: html`<form class="form" id="sets-form" novalidate>
      <div data-slot="error"></div>
      <div class="setsed" data-slot="list"></div>
      <div class="btnrow"><button type="button" class="btn btn--tonal btn--s" data-sx="add-ex">${ic('plus', { size: 's' })}Add exercise</button></div>
      <p class="field__hint">Saving replaces this workout's exercises with what is shown here. Leave a row empty to drop it.</p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="sets-form">Save sets</button>`,
  });
  const form = s.el.querySelector('form');
  const slot = form.querySelector('[data-slot="list"]');

  const draw = () => mount(slot, html`${list.map((x, i) => html`<fieldset class="setsed__x" data-x="${i}">
    <legend class="sr">Exercise ${i + 1}</legend>
    <div class="setsed__head">
      <input class="input" type="text" data-f="name" value="${x.name}" maxlength="80" autocomplete="off" placeholder="Exercise name" aria-label="Name of exercise ${i + 1}">
      <button type="button" class="iconbtn" data-sx="del-ex" aria-label="Remove exercise ${i + 1}">${ic('trash')}</button>
    </div>
    <div class="setsed__cols" aria-hidden="true"><span></span><span>Weight (${unit})</span><span>Reps</span><span>Kind</span><span></span></div>
    ${x.sets.map((st, j) => html`<div class="setsed__s" data-s="${j}">
      <span class="setsed__i">${j + 1}</span>
      <input class="input" type="number" data-f="kg" value="${shown(st.kg)}" inputmode="decimal" min="0" step="any" aria-label="Weight in ${unit}, set ${j + 1}">
      <input class="input" type="number" data-f="reps" value="${f.isNum(st.reps) ? st.reps : ''}" inputmode="numeric" min="0" max="500" step="1" aria-label="Reps, set ${j + 1}">
      <select class="select" data-f="type" aria-label="Kind of set ${j + 1}">${[['normal', 'Normal'], ['warmup', 'Warm-up'], ['dropset', 'Drop set'], ['failure', 'To failure']].map(([v, t]) => html`<option value="${v}" ${v === st.type ? 'selected' : ''}>${t}</option>`)}</select>
      <button type="button" class="iconbtn" data-sx="del-set" aria-label="Remove set ${j + 1}">${ic('x')}</button>
    </div>`)}
    <div class="btnrow"><button type="button" class="btn btn--ghost btn--s" data-sx="add-set">${ic('plus', { size: 's' })}Add set</button></div>
  </fieldset>`)}`);

  const numOf = (el) => (el && el.value !== '' && Number.isFinite(Number(el.value)) ? Number(el.value) : null);
  const read = () => {
    for (const xe of slot.querySelectorAll('[data-x]')) {
      const x = list[Number(xe.dataset.x)];
      if (!x) continue;
      x.name = xe.querySelector('[data-f="name"]').value;
      for (const se of xe.querySelectorAll('[data-s]')) {
        const st = x.sets[Number(se.dataset.s)];
        if (!st) continue;
        const v = numOf(se.querySelector('[data-f="kg"]'));
        // An untouched weight keeps its exact stored value (no lb round trip).
        if (shown(st.kg) !== (v === null ? '' : String(v))) st.kg = v === null ? null : Math.round(f.toKg(v) * 100) / 100;
        st.reps = numOf(se.querySelector('[data-f="reps"]'));
        st.type = se.querySelector('[data-f="type"]').value;
      }
    }
  };

  on(form, 'click', '[data-sx]', (e, btn) => {
    read();
    const xi = Number(btn.closest('[data-x]')?.dataset.x);
    const act = btn.dataset.sx;
    let focus = null;
    if (act === 'add-ex') { list.push({ name: '', was: '', muscle: null, notes: null, sets: [blankSet()] }); focus = `[data-x="${list.length - 1}"] [data-f="name"]`; }
    else if (act === 'del-ex') list.splice(xi, 1);
    else if (act === 'add-set') {
      const prev = list[xi].sets[list[xi].sets.length - 1];
      list[xi].sets.push(prev ? { kg: prev.kg, reps: prev.reps, type: prev.type === 'warmup' ? 'normal' : prev.type } : blankSet());
      focus = `[data-x="${xi}"] [data-s="${list[xi].sets.length - 1}"] [data-f="kg"]`;
    } else if (act === 'del-set') list[xi].sets.splice(Number(btn.closest('[data-s]').dataset.s), 1);
    draw();
    if (focus) slot.querySelector(focus)?.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    read();
    const errSlot = form.querySelector('[data-slot="error"]');
    mount(errSlot, '');
    const out = [];
    for (const x of list) {
      const sets = x.sets.filter((st) => f.isNum(st.kg) || f.isNum(st.reps) || f.isNum(st.distanceM) || f.isNum(st.durationS));
      const name = x.name.trim();
      if (!name && !sets.length) continue;
      if (!name) { mount(errSlot, banner({ tone: 'bad', title: 'Give every exercise a name.' })); return; }
      if (sets.some((st) => (f.isNum(st.kg) && (st.kg < 0 || st.kg > 1000)) || (f.isNum(st.reps) && (st.reps < 0 || st.reps > 500 || !Number.isInteger(st.reps))))) {
        mount(errSlot, banner({ tone: 'bad', title: `Check the sets of ${name}.`, text: 'Weight is 0 to 1,000 kg and reps are whole numbers up to 500.' })); return;
      }
      out.push({
        name,
        // A renamed exercise has its muscle group worked out again, and is no
        // longer the Hevy exercise it was.
        ...(x.muscle && name === x.was ? { muscle: x.muscle } : {}),
        ...(x.templateId && name === x.was ? { templateId: x.templateId } : {}),
        ...(x.notes ? { notes: x.notes } : {}),
        sets: sets.map((st) => Object.fromEntries(Object.entries({ kg: st.kg, reps: st.reps, type: st.type, rpe: st.rpe, distanceM: st.distanceM, durationS: st.durationS }).filter(([, v]) => v !== null && v !== undefined))),
      });
    }
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.put(`/api/workouts/${encodeURIComponent(w.id)}/sets`, { exercises: out }));
      if (r === undefined) return;
      s.close(); toast('Sets saved'); done(r);
    } catch (err) {
      mount(errSlot, banner({ tone: 'bad', title: errText(err, 'Could not save the sets. Try again.') }));
    }
  });
  draw();
}

async function detail(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  const base = `/api/workouts/${encodeURIComponent(id)}`;
  let w = null; let meta = null; let stopTimers = null;
  document.title = 'Workout · Health';

  function heartMod({ pts, hasTrace, end, span }) {
    const z = w.zones;
    const zoned = z && Array.isArray(z.minutes) && sum(z.minutes) > 0;
    const most = zoned ? z.minutes.indexOf(Math.max(...z.minutes)) : -1;
    return mod({
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
    const vol = w.sets?.volumeKg;
    const prs = (w.exercises || []).reduce((a, x) => a + (x.sets || []).filter((s) => s.pr).length, 0);
    const second = [
      f.isNum(w.avgHr) ? html`<div class="fam fam-heart">${stat({ size: 's', label: 'Average heart rate', icon: 'heart', value: Math.round(w.avgHr), unit: 'bpm',
        context: againstSession(w.avgHr, u.avgHr, { fmt: (v) => `${f.int(v)} bpm`, tol: 2, more: 'higher', less: 'lower', what: f.isNum(u.avgHr) ? `${Math.round(u.avgHr)}` : '' }) })}</div>` : '',
      f.isNum(vol) && vol > 0 ? stat({ size: 's', label: 'Volume', icon: 'strength', value: volNum(vol), unit: f.weightUnit(),
        context: againstSession(vol, u.volumeKg, { fmt: (v) => `${volNum(v)} ${f.weightUnit()}`, tol: Math.max(1, (u.volumeKg || 0) * 0.03), more: 'more', less: 'less', what: f.isNum(u.volumeKg) ? volNum(u.volumeKg) : '' }) }) : '',
    ].filter(Boolean);
    const rest = [
      f.isNum(w.maxHr) ? { k: 'Highest heart rate', v: Math.round(w.maxHr), u: 'bpm' } : null,
      f.isNum(w.kcal) ? { k: 'Calories', v: f.int(w.kcal), u: 'kcal' } : null,
      f.isNum(w.steps) ? { k: 'Steps', v: f.int(w.steps) } : null,
      f.isNum(w.activeMin) ? { k: 'Active minutes', v: f.int(w.activeMin) } : null,
      w.sets ? { k: 'Sets', v: f.int(w.sets.sets), s: f.plural(w.sets.exercises, 'exercise') } : null,
      prs ? { k: 'Records', v: f.int(prs), s: 'Marked on the sets' } : null,
    ];
    return mod({
      title: 'Summary', fam: 'workouts', icon: typeIcon(w), span: 12,
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
      paceS && /RUN|WALK|HIK/.test(String(w.type)) ? { k: 'Pace', v: `${Math.floor(paceS / 60)}:${String(Math.round(paceS % 60)).padStart(2, '0')}`, u: '/km' } : null,
      f.isNum(st.avgSpeed) && /BIK|RIDE|CYCL/.test(String(w.type)) ? { k: 'Average speed', v: (st.avgSpeed * 3.6).toFixed(1), u: 'km/h' } : null,
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
    return mod({
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
    return mod({
      title: 'Exercises', fam: 'workouts', icon: 'strength', span: 12,
      note: w.sets ? `${f.plural(w.sets.sets, 'set')} · ${volNum(w.sets.volumeKg)} ${f.weightUnit()}` : '',
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
    const about = html`<hr class="rule">
      <dl class="wk-about">
        <div><dt>Recorded by</dt><dd>${sourceLabel(w)}</dd></div>
        <div><dt>Kind</dt><dd>${typeLabel(w.type, types)}</dd></div>
        ${w.hevy?.id ? html`<div><dt>Hevy</dt><dd>${w.hevy.sent ? 'Sent to Hevy' : 'From Hevy'}${w.hevy.missing?.length ? html`<span class="muted"> · not sent: ${w.hevy.missing.join(', ')} (not in your Hevy library)</span>` : ''}</dd></div>` : ''}
        ${w.strava?.own ? html`<div><dt>Strava</dt><dd><a href="https://www.strava.com/activities/${encodeURIComponent(w.strava.id)}" target="_blank" rel="noopener">Sent to Strava</a></dd></div>` : ''}
        ${gText ? html`<div class="wk-about__g ${gBad ? 'is-bad' : ''}"><dt>Google Health</dt><dd>${gBad ? ic('alert', { size: 's' }) : ''}<span>${gText}</span></dd>
          ${w.google.state === 'failed' ? html`<div class="btnrow wk-rowact"><button type="button" class="btn btn--tonal btn--s" data-action="retry-upload">Try again</button></div>` : ''}
          ${w.google.state === 'needs_scope' ? html`<div class="btnrow wk-rowact"><button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-return="/workouts/${encodeURIComponent(w.id)}">Reconnect Google</button></div>` : ''}
        </div>` : ''}
      </dl>
      ${w.readOnly ? html`<p class="chart__note wk-note">This workout lives in Google Health, recorded by your device or another app. It can be seen here but not changed.</p>` : ''}`;
    const notes = w.notes ? mod({ title: 'Notes', icon: 'text', span: 12, body: html`<p class="prose sumtext">${w.notes}</p>` }) : '';
    const manage = w.readOnly ? '' : mod({
      title: 'Change it', icon: 'edit', span: 12, cls: 'mod--flush wk-manage',
      body: html`
        ${!live && w.status !== 'ongoing' ? row({ action: 'edit-times', iconName: 'clock', title: 'Edit times', text: 'Heart rate, steps and calories are worked out again', chevron: true }) : ''}
        ${row({ action: 'edit', iconName: 'edit', title: 'Name and notes', text: 'And the kind of exercise', chevron: true })}
        ${canEditSets ? row({ action: 'edit-sets', iconName: 'strength', title: w.exercises?.length ? 'Edit exercises and sets' : 'Add exercises and sets', chevron: true }) : ''}
        ${app.me?.hevy?.connected && (w.exercises || []).some((x) => x.templateId) ? row({ action: 'save-routine', iconName: 'playlist', title: 'Save as a Hevy routine', text: 'Its exercises and sets, ready to start in Hevy', chevron: true }) : ''}
        ${row({ action: 'delete', iconName: 'trash', title: 'Delete workout', danger: true })}`,
    });

    mount(root, html`
      ${head({ title, back: '/workouts' })}
      <p class="wk-when-line"><span class="ib ib--s fam fam-workouts">${ic(typeIcon(w))}</span><span>${f.dayLong(day)} · ${f.clock(w.start)}${end ? ` to ${f.clock(end)}` : ''} · ${sourceLabel(w)}</span></p>
      <div class="stack">
        ${live ? runningCard(w) : ''}
        ${waiting ? askCard(w) : ''}
        ${w.status === 'dismissed' ? banner({ title: 'This was marked as not a workout', text: 'It is kept out of your history and totals.' }) : ''}
        ${grid(html`
          ${heartMod({ pts, hasTrace, end, span: 8 })}
          <div class="mod--4 wk-side">${summaryMod({ live, end, about })}${manage}</div>
          ${stravaMod()}
          ${exercisesMod()}
          ${notes}`, 'wkg wk-detail')}
      </div>`);
    stopTimers?.();
    stopTimers = live ? runTimers(root) : null;
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${skeleton('chart')}`);
    try {
      const [one, all] = await Promise.all([api.get(base), meta ? Promise.resolve(meta) : api.get('/api/workouts?limit=1').catch(() => null)]);
      w = one; meta = all;
      if (ctx.alive()) paint();
    } catch (err) {
      if (!ctx.alive() || quiet) return;
      if (err.status === 404) {
        mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${mod({ label: 'Workout not found', body: html`<div class="empty wk-empty">${ib('workouts', { size: 'l', plain: true })}<p class="empty__t">This workout is not here</p><p class="empty__d">It may have been deleted, or the link is old.</p><a class="btn btn--tonal btn--s" href="/workouts">Back to workouts</a></div>` })}`);
      } else mount(root, html`${head({ title: 'Workout', back: '/workouts' })}${errorState(err)}`);
    }
  }

  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="edit"]', () => editSheet(w, meta, () => load({ quiet: true })));
  on(root, 'click', '[data-action="edit-sets"]', () => setsSheet(w, () => { refreshMe().catch(() => {}); load({ quiet: true }); }));
  on(root, 'click', '[data-action="save-routine"]', async () => {
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
  on(root, 'click', '[data-action="edit-times"]', async () => {
    const t = await timesSheet({ title: 'Edit times', start: w.start, end: w.end ?? w.lastEnd ?? Date.now(), text: 'The heart rate, steps and calories are worked out again for the new times.' });
    if (!t) return;
    try { await api.post(`${base}/save`, t); toast('Times saved'); refreshMe().catch(() => {}); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-action="retry-upload"]', async (e, btn) => {
    try { const r = await busy(btn, () => api.post(`${base}/retry`)); if (r === undefined) return; toast('Trying again'); load({ quiet: true }); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-action="delete"]', async () => {
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
  ctx.onLeave(listen('changed', (what) => { if (what.includes('workouts')) load({ quiet: true }); }));
  ctx.onLeave(() => stopTimers?.());
  ctx.onRefresh(() => load({ quiet: true }));
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
      body = html`${grid(html`
        ${mod({
          title: 'Get the file from Hevy', fam: 'workouts', icon: 'strength', span: 6,
          body: html`<ol class="howto">
            <li><span>Open Hevy and go to your <b>Profile</b>, then <b>Settings</b>.</span></li>
            <li><span>Choose <b>Export &amp; Import Data</b>, then <b>Export Workouts</b>.</span></li>
            <li><span>Hevy gives you a file called <b>workouts.csv</b>. Save it to your phone or send it to yourself.</span></li>
          </ol>
          <hr class="rule">
          <div class="part"><p class="sub">What it adds</p><p class="wk-say wk-say--quiet">Your exercises and sets, and with them weekly volume, muscle balance, records and progress for each exercise.</p></div>`,
        })}
        <div class="mod--6 wk-dropcol">
          ${problem ? banner({ tone: 'bad', title: problem }) : ''}
          <label class="drop fam fam-workouts" data-drop>
            <input type="file" accept=".csv,text/csv" data-file>
            ${ib('upload', { size: 'l' })}
            <span class="drop__t">${reading ? 'Reading the file' : 'Choose your Hevy CSV'}</span>
            <span class="muted small">${reading ? 'This takes a moment for a long history.' : 'Up to 5 MB. You see what would change before anything is saved.'}</span>
          </label>
          <p class="muted small wk-pad">Importing the same file twice is safe: workouts that are already here are skipped.</p>
        </div>`, 'wkg')}`;
    }
    mount(root, html`${head({ title: 'Import from Hevy', back: '/workouts' })}<div class="stack">${body}</div>`);
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
    const b = det.bounds || {};
    const on_ = Boolean(s.enabled) && det.available;
    mount(root, html`
      ${head({ title: 'Detection', back: '/workouts' })}
      <div class="stack">
        ${!det.available ? banner({ tone: 'warn', title: 'Not available on your device', text: det.reason || 'Workout detection needs minute-by-minute heart rate, which your device does not report.' }) : ''}
        ${det.available && det.suppressedByLink ? banner({ iconName: 'link', title: 'The console module is doing this', text: 'Your console health module is linked and detecting workouts, so this app is not. The settings below are the module\'s to change. Its questions still show up here.' }) : ''}

        <form class="grid wkg wk-det" id="det-form" novalidate>
          ${mod({
            title: 'Notice workouts', fam: 'heart', icon: 'wave', span: 5,
            body: html`
              <div class="wk-switch">
                <span class="row__body"><span class="row__t">Notice workouts from my heart rate</span>
                <span class="row__d">Off unless you turn it on. When your heart rate stays up, you are asked once whether a workout started, and once at the end whether to save it.</span></span>
                ${toggle('enabled', on_, { label: 'Notice workouts from my heart rate', disabled: locked })}
              </div>
              ${det.available ? html`<hr class="rule">
                ${facts([
                  { k: 'Resting heart rate', v: f.int(det.rest), u: 'bpm', s: 'Your 30-day average' },
                  { k: 'Effort starts at', v: f.int(det.threshold), u: 'bpm', s: `${f.int(s.plusBpm)} above resting` },
                  { k: 'Last checked', v: det.last?.checkedAt ? f.ago(det.last.checkedAt) : 'Not yet', s: det.last?.error ? `It failed: ${det.last.error}` : on_ ? 'Checked by itself every few minutes' : 'Nothing is checked while it is off' },
                ], { cols: 2, cls: 'facts--s wk-facts2' })}` : ''}
              ${det.available && !det.suppressedByLink && s.enabled ? html`<div class="btnrow"><button type="button" class="btn btn--tonal btn--s" data-action="check">${ic('refresh', { size: 's' })}Check now</button></div>` : ''}`,
          })}
          ${mod({
            title: 'Thresholds', icon: 'admin', span: 7, note: locked ? 'These cannot be changed here' : 'What counts as a workout',
            body: html`<div class="wk-fields">
              ${FIELDS.map(([key, label, unit, hint]) => field({
                label: `${label} (${unit})`, name: key, type: 'number', value: s[key] ?? '',
                attrs: `inputmode="numeric" step="1" ${b[key] ? `min="${b[key][0]}" max="${b[key][1]}"` : ''} ${locked ? 'disabled' : ''}`,
                hint: `${hint}${b[key] ? ` ${b[key][0]} to ${b[key][1]}.` : ''}`,
              }))}
            </div>`,
          })}
          ${d.exerciseTypes?.length ? mod({
            title: 'Saved to Google Health as', fam: 'workouts', icon: 'strength', span: 12,
            body: field({ label: 'Kind of exercise', name: 'exerciseType', value: d.exerciseType, options: d.exerciseTypes.map((t) => [t.id, t.label]), hint: 'Used for workouts you start, log, or that are detected.' }),
          }) : ''}
          <div class="btnrow mod--12">
            <button type="submit" class="btn">Save</button>
          </div>
        </form>
      </div>`);
  }

  async function save(body, okText, btn) {
    try {
      const p = await busy(btn, () => api.post('/api/workouts/settings', body));
      if (p === undefined) return;
      d = p; toast(okText); paint();
    } catch (err) { toastError(err); paint(); }
  }

  on(root, 'change', 'input[name="enabled"]', (e, input) => save({ enabled: input.checked }, input.checked ? 'Detection is on' : 'Detection is off', null));
  on(root, 'submit', '#det-form', (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    const body = {};
    const b = d.detection?.bounds || {};
    let bad = false;
    for (const [key] of FIELDS) {
      if (form.elements[key]?.disabled) continue;
      fieldError(form, key, '');
      if (!f.isNum(v[key])) { fieldError(form, key, 'Enter a number.'); bad = true; continue; }
      if (b[key] && (v[key] < b[key][0] || v[key] > b[key][1])) { fieldError(form, key, `Between ${b[key][0]} and ${b[key][1]}.`); bad = true; continue; }
      body[key] = Math.round(v[key]);
    }
    if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    if (v.exerciseType) body.exerciseType = v.exerciseType;
    save(body, 'Saved', form.querySelector('button[type="submit"]'));
  });
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
