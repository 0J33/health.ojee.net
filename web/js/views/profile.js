/* A person's public page, /u/<username>. Works signed out. Sections whose
   category is private are simply not there; a private or unknown account
   gets one plain "not available" page, with no hint which it is.

   Only what the API returned is drawn: a null section or field is somebody
   keeping it private (or a device that does not report it) and is left
   out, never worked out from another number. */

import { api } from '../api.js';
import { signedIn, hasProfile, go, refreshMe } from '../app.js';
import { html, raw, mount, ic, skeleton, errorState, banner, chart, on, busy, toast, toastError } from '../ui.js';
import { heatmap, tableAlt } from '../charts.js';
import { cats } from '../viz.js';
import { mod, stat, facts, figure, legend, ib, tooFew } from '../kit.js';
import * as f from '../format.js';
import { avatar, unitValue, unitText, typeLabel } from './shared.js';
import { moreRows, bindMore } from '../metrics.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SECTION = { activity: 'activity', workouts: 'workouts', sleep: 'sleep', heart: 'heart', body: 'body' };

/* A record's family and glyph, by what it measures. */
const recordMeta = (r) => (/workout/.test(r.kind) ? { fam: 'workouts', icon: /longest/.test(r.kind) ? 'timer' : 'strength' } : { fam: 'steps', icon: 'steps' });

const TYPE_ICON = [[/run|jog/i, 'run'], [/walk/i, 'walk'], [/bik|cycl|spin/i, 'bike'], [/swim/i, 'swim'], [/hik/i, 'hike'], [/yoga|pilates|stretch/i, 'yoga'], [/row/i, 'rowing'], [/weight|strength|lift/i, 'strength']];
const typeIcon = (w) => TYPE_ICON.find(([re]) => re.test(`${w.type || ''} ${w.type ? '' : w.title || ''}`))?.[1] || 'strength';

function topbar() {
  if (hasProfile()) return '';
  return html`<header class="land__bar prof__bar">
    <a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a>
    ${signedIn() ? '' : html`<a class="btn btn--tonal btn--s" href="/signin?next=${encodeURIComponent(location.pathname)}">Sign in</a>`}
  </header>`;
}

const agoWords = (n) => (!f.isNum(n) ? '' : n <= 0 ? 'set today' : n === 1 ? 'set yesterday' : `set ${f.int(n)} days ago`);
const monthName = (ym) => f.monthYear(`${ym}-01`);

/* ── the year ───────────────────────────────────────────────── */

function yearMod(p, opts = {}) {
  const days = p.heatmap || [];
  const y = p.year || null;
  if (!(p.sections?.activity || p.sections?.workouts)) return '';
  if (!days.length && !y) return '';
  const lit = days.filter((d) => d.level > 0).length;
  const dist = y && f.isNum(y.distanceM) ? unitValue(y.distanceM, 'm') : null;
  const totals = y ? facts([
    f.isNum(y.activeDays) ? { k: 'Active days', v: f.int(y.activeDays), s: 'days with steps' } : null,
    f.isNum(y.steps) ? { k: 'Steps', v: f.int(y.steps) } : null,
    dist ? { k: 'Distance', v: dist.v, u: dist.u } : null,
    y.workouts > 0 ? { k: 'Workouts', v: f.int(y.workouts) } : null,
    y.workoutMin > 0 ? { k: 'Workout time', v: f.dur(y.workoutMin) } : null,
    y.bestMonth?.month ? { k: 'Best month', v: monthName(y.bestMonth.month), s: f.isNum(y.bestMonth.steps) ? `${f.int(y.bestMonth.steps)} steps` : '' } : null,
  ], { cols: 2, cls: 'facts--s year__facts' }) : '';
  const map = days.length ? html`<div class="chartbox year__map">
      <p class="chart__read" aria-live="polite">${lit ? 'Touch a square to read a day.' : 'Nothing recorded in the last year yet.'}</p>
      <div class="heat" tabindex="0" role="group" aria-label="Activity over the last year, scrollable">${chart(() => heatmap({
        label: `Activity on each of the last 365 days: ${lit} days with something recorded.`,
        days: days.map((d) => ({ date: d.date, level: d.level, read: `${f.dayMed(d.date)}: ${[f.isNum(d.steps) ? `${f.int(d.steps)} steps` : null, d.workouts ? f.plural(d.workouts, 'workout') : null].filter(Boolean).join(', ') || 'nothing recorded'}` })),
      }))}</div>
      ${legend([['sw-h0', 'None'], ['sw-h1', ''], ['sw-h2', ''], ['sw-h3', ''], ['sw-h4', 'Most active']])}
    </div>` : '';
  if (opts.part === 'map') {
    return map ? html`<section class="bt bt--plain fam fam-steps pf-year">
      <div class="bt__row"><span class="bt__lab">${ic('calendar')}The last year</span>${f.isNum(y?.activeDays) ? html`<span class="bt__meta">${f.int(y.activeDays)} active days</span>` : ''}</div>
      ${map}</section>` : '';
  }
  if (opts.part === 'totals') return totals;
  return mod({
    title: 'The last year', icon: 'calendar', fam: 'steps', span: 12, cls: 'year',
    note: p.sections?.activity && p.sections?.workouts ? 'Steps against the goal, and workouts, day by day' : p.sections?.activity ? 'Steps against the goal, day by day' : 'Workouts, day by day',
    body: html`<div class="year__grid">${totals}${map}</div>`,
  });
}

/* ── streaks ────────────────────────────────────────────────── */

function streaksMod(p) {
  const s = p.streaks || {};
  const defs = [
    s.stepGoal ? { ...s.stepGoal, fam: 'steps', icon: 'steps', one: 'day at the step goal', many: 'days in a row at the step goal', unit: 'days' } : null,
    s.workoutWeeks ? { ...s.workoutWeeks, fam: 'workouts', icon: 'strength', one: 'week with a workout', many: 'weeks in a row with a workout', unit: 'weeks' } : null,
  ].filter((x) => x && ((x.current || 0) > 0 || (x.best || 0) > 0));
  if (!defs.length) return '';
  return mod({
    title: 'Streaks', icon: 'streak', span: 5,
    body: html`<div class="pstreaks">${defs.map((x) => {
      const cur = x.current || 0; const best = x.best || 0;
      const words = cur === 0 ? 'No streak running' : cur === 1 ? x.one : x.many;
      const bestWords = best <= 0 ? 'No best yet' : cur > 0 && cur >= best ? 'This is the best so far' : `Best ${f.int(best)} ${x.unit}`;
      return html`<div class="pstreak fam fam-${x.fam}">
        ${ib(x.icon, { size: 'l' })}
        <span class="pstreak__n">${f.int(cur)}</span>
        <span class="pstreak__b"><span class="pstreak__t">${words}</span><span class="pstreak__d">${bestWords}</span></span>
      </div>`;
    })}</div>`,
  });
}

/* ── this week against last ─────────────────────────────────── */

function weekMod(p) {
  const a = p.week?.thisWeek; const b = p.week?.lastWeek;
  if (!a) return '';
  const defs = [
    ['steps', 'Steps', 'steps', 'steps', 'steps'],
    ['activeMinutes', 'Active minutes', 'min', 'active', 'bolt'],
    ['distanceM', 'Distance', 'm', 'steps', 'distance'],
    ['workouts', 'Workouts', 'workouts', 'workouts', 'strength'],
    ['workoutMin', 'Workout time', 'min', 'workouts', 'timer'],
  ];
  const rows = defs.filter(([k]) => f.isNum(a[k]) && (a[k] > 0 || b?.[k] > 0)).map(([k, label, unit, fam, icon]) => {
    const prev = b?.[k];
    const x = unitValue(a[k], unit);
    const max = Math.max(a[k], f.isNum(prev) ? prev : 0) || 1;
    const share = f.isNum(prev) && prev > 0 ? Math.round((a[k] / prev) * 100) : null;
    const words = !f.isNum(prev) || prev === 0 ? 'Nothing last week'
        : a[k] >= prev ? `Already past last week's ${unitText(prev, unit)}`
          : `${share}% of last week's ${unitText(prev, unit)}`;
    return html`<div class="wkrow fam fam-${fam}">
      <span class="wkrow__k">${ib(icon, { size: 's' })}<span>${label}</span></span>
      <span class="wkrow__v">${x.v}${x.u ? html`<span class="stat__u">${x.u}</span>` : ''}</span>
      <span class="wkrow__bars" role="img" aria-label="${label}: ${unitText(a[k], unit)} this week${f.isNum(prev) ? `, ${unitText(prev, unit)} in the whole of last week` : ''}.">
        <span class="wkrow__bar"><span data-style="--p:${(a[k] / max).toFixed(3)}"></span></span>
        ${f.isNum(prev) ? html`<span class="wkrow__bar wkrow__bar--b"><span data-style="--p:${(prev / max).toFixed(3)}"></span></span>` : ''}
      </span>
      <span class="wkrow__c">${words}</span>
    </div>`;
  });
  if (!rows.length) return '';
  return mod({
    title: 'This week', icon: 'week', span: 7, note: 'So far, against the whole of last week',
    body: html`<div class="wkrows">${rows}</div>`,
  });
}

/* ── 12 weeks ───────────────────────────────────────────────── */

function weeksMod(p) {
  const weeks = p.weeks || [];
  if (!weeks.length) return '';
  const labels = weeks.map((w) => f.dayShort(w.week));
  const part = (key, { title, fam, icon, unit, fmt, per }) => {
    const vals = weeks.map((w) => w[key]);
    if (!vals.some(f.isNum)) return '';       // private: not there at all
    const head = html`<p class="sub wk12__k fam fam-${fam}">${ib(icon, { size: 's' })}${title}</p>`;
    const full = vals.slice(0, -1).filter(f.isNum);
    if (!vals.some((v) => v > 0)) return '';
    const withData = vals.filter((v) => v > 0).length;
    if (withData < 2) return html`<div class="part">${head}${tooFew(withData, 2, 'weeks')}</div>`;
    const avg = full.length ? full.reduce((x, y) => x + y, 0) / full.length : null;
    let best = 0; vals.forEach((v, i) => { if (f.isNum(v) && v > vals[best]) best = i; });
    const now = vals[vals.length - 1];
    return html`<div class="part fam fam-${fam}">${head}${figure(chart((w) => cats({
      w, h: 128, labels, a: vals, fmt, label: `${title} in each of the last 12 weeks. Best: week of ${labels[best]}, ${fmt(vals[best])}${unit}.`,
      mark: weeks.length - 1, reads: weeks.map((wk, i) => `Week of ${labels[i]}${i === weeks.length - 1 ? ' (so far)' : ''}: ${f.isNum(vals[i]) ? `${fmt(vals[i])}${unit}` : 'nothing'}`),
    })), {
      read: html`<b>${fmt(now)}${unit}</b> this week so far${f.isNum(avg) ? ` · ${fmt(avg)}${per} over the 11 before` : ''}`,
      table: tableAlt(['Week of', title], weeks.map((wk, i) => [labels[i], f.isNum(vals[i]) ? `${fmt(vals[i])}${unit}` : f.DASH])),
    })}</div>`;
  };
  const steps = part('steps', { title: 'Steps per week', fam: 'steps', icon: 'steps', unit: ' steps', fmt: f.int, per: ' a week' });
  const wk = part('workouts', { title: 'Workouts per week', fam: 'workouts', icon: 'strength', unit: '', fmt: f.int, per: ' a week' });
  if (!steps && !wk) return '';
  return mod({
    title: '12 weeks', icon: 'history', span: 7, note: 'This week is the brighter bar; it is not over yet',
    body: html`${steps}${steps && wk ? html`<hr class="rule">` : ''}${wk}`,
  });
}

/* ── weekday pattern ────────────────────────────────────────── */

function weekdayMod(p) {
  const wd = p.weekday;
  if (!Array.isArray(wd)) return '';
  const have = wd.filter(f.isNum);
  if (have.length < 3) {
    return mod({ title: 'Weekday pattern', icon: 'steps', fam: 'steps', span: 5, body: tooFew(have.length, 3, 'weekdays') });
  }
  let hi = -1; let lo = -1;
  wd.forEach((v, i) => { if (!f.isNum(v)) return; if (hi < 0 || v > wd[hi]) hi = i; if (lo < 0 || v < wd[lo]) lo = i; });
  const mean = have.reduce((a, b) => a + b, 0) / have.length;
  return mod({
    title: 'Weekday pattern', icon: 'steps', fam: 'steps', span: 5, note: 'Average steps by weekday, last 12 weeks',
    body: html`
      ${stat({ label: 'Most active day', value: `${DAYS[hi]}s`, context: html`<span>${f.int(wd[hi])} steps on average${mean > 0 && wd[hi] > mean ? `, ${Math.round((wd[hi] / mean - 1) * 100)}% above the average day` : ''}</span>` })}
      ${figure(chart((w) => cats({
        w, h: 132, labels: DAYS.map((x) => x.slice(0, 3)), a: wd, mark: hi, fmt: f.int, unit: 'steps',
        label: `Average steps by weekday. Highest on ${DAYS[hi]}s with ${f.int(wd[hi])}, lowest on ${DAYS[lo]}s with ${f.int(wd[lo])}.`,
        reads: DAYS.map((x, i) => `${x}s: ${f.isNum(wd[i]) ? `${f.int(wd[i])} steps on average` : 'no days yet'}`),
      })), {
        read: hi !== lo ? `Quietest on ${DAYS[lo]}s, ${f.int(wd[lo])} steps` : '',
        table: tableAlt(['Weekday', 'Average steps'], DAYS.map((x, i) => [x, f.isNum(wd[i]) ? f.int(wd[i]) : f.DASH])),
      })}`,
  });
}

/* ── records, sessions ──────────────────────────────────────── */

function recordsMod(p) {
  if (!p.records?.length) return '';
  return mod({
    title: 'Records', icon: 'record', span: 6, cls: 'mod--flush',
    body: html`<div class="prows">${p.records.map((r) => {
      const m = recordMeta(r);
      const x = unitValue(r.value, r.unit);
      const when = r.date ? (/week/.test(r.kind) ? `Week of ${f.dayShort(r.date)}` : f.dateFull(r.date)) : '';
      return html`<div class="prow fam fam-${m.fam}">
        ${ib(m.icon)}
        <span class="prow__b"><span class="prow__t">${r.label}</span><span class="prow__d">${[when, agoWords(r.daysAgo)].filter(Boolean).join(' · ')}</span></span>
        <span class="prow__v">${x.v}${x.u ? html`<span class="stat__u">${x.u}</span>` : ''}</span>
      </div>`;
    })}</div>`,
  });
}

function sessionsMod(p) {
  if (!p.recentWorkouts?.length) return '';
  return mod({
    title: 'Recent sessions', icon: 'strength', fam: 'workouts', span: 6, cls: 'mod--flush',
    body: html`<div class="prows">${p.recentWorkouts.map((w) => {
      const named = w.title && w.title !== 'Workout';
      const kind = w.type ? typeLabel(w.type) : '';
      return html`<div class="prow">
        ${ib(typeIcon(w))}
        <span class="prow__b"><span class="prow__t">${named ? w.title : kind || 'Workout'}</span><span class="prow__d">${f.dayRel(w.date)}${named && kind && kind.toLowerCase() !== String(w.title).toLowerCase() ? ` · ${kind}` : ''}${f.isNum(w.start) ? ` · ${f.clock(w.start)}` : ''}</span></span>
        <span class="prow__v">${f.dur(w.durationMin)}</span>
      </div>`;
    })}</div>`,
  });
}

/* ── shared summaries ───────────────────────────────────────── */

function summaryMods(p) {
  const out = [];
  const pair = (title, fam, icon, items) => {
    const list = items.filter(Boolean);
    if (list.length) out.push(mod({ title, fam, icon, span: 4, body: html`<div class="stats">${list}</div>` }));
  };
  if (p.sleep) {
    pair('Sleep', 'sleep', 'moon', [
      f.isNum(p.sleep.avgMin7) ? stat({ size: 's', label: 'A night, on average', value: f.dur(p.sleep.avgMin7), context: 'Over the last 7 nights' }) : null,
      f.isNum(p.sleep.consistency) ? stat({ size: 's', label: 'Consistency', value: f.int(p.sleep.consistency), unit: 'of 100', context: 'How regular bedtime and wake time are' }) : null,
    ]);
  }
  if (p.heart) {
    pair('Heart', 'heart', 'heart', [
      f.isNum(p.heart.restingHr) ? stat({ size: 's', label: 'Resting heart rate', value: f.int(p.heart.restingHr), unit: 'bpm', context: 'Latest' }) : null,
      f.isNum(p.heart.hrv) ? stat({ size: 's', label: 'Variability', value: f.int(p.heart.hrv), unit: 'ms', context: 'Latest HRV' }) : null,
    ]);
  }
  if (p.body) {
    pair('Body', 'body', 'scale', [
      f.isNum(p.body.weightKg) ? stat({ size: 's', label: 'Weight', value: f.weightNum(p.body.weightKg), unit: f.weightUnit(), context: 'Latest weigh-in' }) : null,
      f.isNum(p.body.bodyFatPct) ? stat({ size: 's', label: 'Body fat', value: f.dec1(p.body.bodyFatPct), unit: '%', context: 'Latest' }) : null,
    ]);
  }
  return out;
}

/* ── glance first: two tiles, the year, then rows ──────────── */

/** This week's steps and workouts as tiles, in their families' colours. */
function heroTiles(p) {
  const a = p.week?.thisWeek || {}; const b = p.week?.lastWeek || {};
  const ws = p.streaks?.workoutWeeks; const ss = p.streaks?.stepGoal;
  const share = (k) => (f.isNum(b[k]) && b[k] > 0 ? (a[k] >= b[k] ? `Past last week's ${unitText(b[k], k === 'steps' ? 'steps' : 'workouts')}` : `${Math.round((a[k] / b[k]) * 100)}% of last week's ${f.int(b[k])}`) : 'Nothing last week');
  const t = [];
  if (f.isNum(a.steps) && (a.steps > 0 || b.steps > 0)) {
    t.push(html`<div class="bt bt--steps pf-t"><div class="bt__row"><span class="bt__lab">${ic('steps')}Steps</span></div>
      <div><p class="n n-l">${f.int(a.steps)}</p><p class="bt__sub">This week · ${ss?.current > 0 ? `${f.plural(ss.current, 'day')} in a row at goal` : share('steps')}</p></div></div>`);
  }
  if (f.isNum(a.workouts) && (a.workouts > 0 || b.workouts > 0 || ws?.current > 0)) {
    t.push(html`<div class="bt bt--energy pf-t"><div class="bt__row"><span class="bt__lab">${ic('strength')}Workouts</span></div>
      <div><p class="n n-l">${f.int(a.workouts)}${f.isNum(a.workoutMin) && a.workoutMin > 0 ? html`<span class="u">${f.dur(a.workoutMin)}</span>` : ''}</p><p class="bt__sub">This week · ${ws?.current > 0 ? `${f.plural(ws.current, 'week')} in a row` : share('workouts')}</p></div></div>`);
  }
  return t.length ? html`<div class="bento pf-tiles">${t.length === 1 ? raw(String(t[0]).replace('class="bt ', 'class="bt bt--wide ')) : t}</div>` : '';
}

/** Everything else, one calm row each; the full card opens in a sheet. */
function profileRows(p) {
  const y = p.year || {};
  const rows = [];
  const add = (key, icon, fam, title, text, body, value = '') => { if (body && String(body)) rows.push({ key, icon, fam, title, text, body, value }); };
  const dist = f.isNum(y.distanceM) ? unitValue(y.distanceM, 'm') : null;
  add('year', 'calendar', 'steps', 'The last year', [f.isNum(y.steps) ? `${f.int(y.steps)} steps` : '', dist ? `${dist.v} ${dist.u}` : '', y.workouts > 0 ? f.plural(y.workouts, 'workout') : ''].filter(Boolean).join(' · '), yearMod(p, { part: 'totals' }));
  const ws = p.streaks?.workoutWeeks; const ss = p.streaks?.stepGoal;
  add('streaks', 'streak', '', 'Streaks', [ss?.current > 0 ? `${f.plural(ss.current, 'day')} at the step goal` : '', ws?.current > 0 ? `${f.plural(ws.current, 'week')} with a workout` : ''].filter(Boolean).join(' · ') || 'Best runs so far', streaksMod(p));
  add('week', 'week', '', 'This week', 'So far, against the whole of last week', weekMod(p));
  add('weeks', 'history', '', '12 weeks', 'Steps and workouts, week by week', weeksMod(p));
  const wd = Array.isArray(p.weekday) ? p.weekday : null;
  let hi = -1; if (wd) wd.forEach((v, i) => { if (f.isNum(v) && (hi < 0 || v > wd[hi])) hi = i; });
  add('weekday', 'steps', 'steps', 'Weekday pattern', hi >= 0 && wd.filter(f.isNum).length >= 3 ? `Most active on ${DAYS[hi]}s, ${f.int(wd[hi])} steps` : 'Average steps by weekday', weekdayMod(p));
  const r0 = p.records?.[0];
  add('records', 'record', '', 'Records', r0 ? `${r0.label}: ${unitText(r0.value, r0.unit)}` : '', recordsMod(p), p.records?.length ? html`${f.int(p.records.length)}` : '');
  const w0 = p.recentWorkouts?.[0];
  add('sessions', 'strength', 'workouts', 'Recent sessions', w0 ? `Latest: ${w0.title && w0.title !== 'Workout' ? w0.title : typeLabel(w0.type) || 'Workout'}, ${f.dayRel(w0.date)}` : '', sessionsMod(p));
  const sums = summaryMods(p);
  const S = [];
  if (p.sleep) S.push(['sleep', 'moon', 'sleep', 'Sleep', [f.isNum(p.sleep.avgMin7) ? `${f.dur(p.sleep.avgMin7)} a night` : '', f.isNum(p.sleep.consistency) ? `consistency ${f.int(p.sleep.consistency)}` : ''].filter(Boolean).join(' · ')]);
  if (p.heart) S.push(['heart', 'heart', 'heart', 'Heart', [f.isNum(p.heart.restingHr) ? `Resting ${f.int(p.heart.restingHr)} bpm` : '', f.isNum(p.heart.hrv) ? `HRV ${f.int(p.heart.hrv)} ms` : ''].filter(Boolean).join(' · ')]);
  if (p.body) S.push(['body', 'scale', 'body', 'Body', [f.isNum(p.body.weightKg) ? `${f.weightNum(p.body.weightKg)} ${f.weightUnit()}` : '', f.isNum(p.body.bodyFatPct) ? `${f.dec1(p.body.bodyFatPct)}% body fat` : ''].filter(Boolean).join(' · ')]);
  // summaryMods skips an empty pair, so match them by title.
  for (const [key, icon, fam, title, text] of S) add(key, icon, fam, title, text, sums.find((m) => String(m).includes(`<span>${title}</span>`)) || '');
  return rows;
}

/* ── the page ───────────────────────────────────────────────── */

/** The friend button on someone else's page, for each state. */
function friendBtn(state) {
  if (state === 'friends') return html`<button type="button" class="btn btn--tonal btn--s" data-friend="remove" data-state="friends">${ic('user_check', { size: 's' })}Friends</button>`;
  if (state === 'incoming') return html`<button type="button" class="btn btn--s" data-friend="accept">${ic('user_check', { size: 's' })}Accept request</button>`;
  if (state === 'outgoing') return html`<button type="button" class="btn btn--tonal btn--s" data-friend="remove">${ic('clock', { size: 's' })}Requested</button>`;
  return html`<button type="button" class="btn btn--s" data-friend="request">${ic('user_plus', { size: 's' })}Add friend</button>`;
}

export default async function profile(ctx) {
  const { root } = ctx;
  const username = ctx.params.username;
  document.title = `${username} · Health`;

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, html`${topbar()}${skeleton('page')}`);
    let p;
    try { p = await api.get(`/api/users/${encodeURIComponent(username)}`); } catch (err) {
      if (!ctx.alive() || quiet) return;
      if (err.status === 404) {
        document.title = 'Not available · Health';
        mount(root, html`${topbar()}<div class="narrow"><div class="empty prof__gone">
          <span class="empty__ic">${ic('lock')}</span>
          <h1 class="empty__t" tabindex="-1">This profile is not available</h1>
          <p class="empty__d">There is no public profile at this address.</p>
          <a class="btn btn--tonal btn--s" href="${hasProfile() ? '/ranks' : '/'}">${hasProfile() ? 'Back to ranks' : 'Go to the start'}</a>
        </div></div>`);
      } else mount(root, html`${topbar()}${errorState(err)}`);
      return;
    }
    if (!ctx.alive()) return;
    const name = p.displayName || p.username;
    document.title = `${name} · Health`;

    const y = p.year || {};
    const wk = p.week?.thisWeek || {}; const lw = p.week?.lastWeek || {};
    const hasData = y.activeDays > 0 || y.workouts > 0 || p.records?.length || p.recentWorkouts?.length || p.sleep || p.heart || p.body
      || (p.heatmap || []).some((d) => d.level > 0) || [...Object.values(wk), ...Object.values(lw)].some((v) => v > 0)
      || (p.streaks?.stepGoal?.best > 0) || (p.streaks?.workoutWeeks?.best > 0);
    rows = hasData ? profileRows(p) : [];
    const tiles = hasData ? heroTiles(p) : '';
    const yearCard = hasData ? yearMod(p, { part: 'map' }) : '';
    const hidden = p.me && p.sections ? Object.keys(SECTION).filter((k) => p.sections[k] === false) : [];
    const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

    mount(root, html`
      ${topbar()}
      ${hasProfile() ? html`<header class="head head--back"><div class="head__lead"><a class="back" href="/ranks" aria-label="Back to ranks">${ic('left')}</a><span class="muted small">Profile</span></div></header>` : ''}
      <div class="phead">
        <div class="phead__id">
          ${avatar(p, { large: true })}
          <div class="phead__names">
            <h1 class="phead__n" tabindex="-1">${name}</h1>
            <p class="phead__u">@${p.username}</p>
          </div>
        </div>
        <div class="phead__more">
          ${p.bio ? html`<p class="phead__bio">${p.bio}</p>` : ''}
          <p class="phead__meta">
            ${p.joinedAt ? html`<span>${ic('calendar', { size: 's' })}Joined ${f.monthYear(f.instDay(p.joinedAt))}</span>` : ''}
            ${p.device ? html`<span>${ic('watch', { size: 's' })}${p.device}</span>` : ''}
          </p>
        </div>
        <div class="btnrow phead__act">
          ${p.me ? html`<a class="btn btn--tonal btn--s" href="/settings/account">${ic('edit', { size: 's' })}Edit profile</a><a class="btn btn--tonal btn--s" href="/settings/privacy">${ic('lock', { size: 's' })}Privacy</a>` : ''}
          ${!p.me && hasProfile() ? friendBtn(p.friend) : ''}
          ${!p.me && hasProfile() ? html`<a class="btn btn--s ${p.friend === 'friends' ? '' : 'btn--tonal'}" href="/compare?with=${encodeURIComponent(p.username)}">${ic('compare', { size: 's' })}Compare with me</a>` : ''}
          ${!signedIn() ? html`<a class="btn btn--tonal btn--s" href="/signin?next=${encodeURIComponent(location.pathname)}">Sign in to compare</a>` : ''}
        </div>
      </div>

      <div class="stack pnotes">
        ${p.me && p.private ? banner({ iconName: 'lock', title: 'Your account is private', text: 'Nobody else can open this page and you are not on the leaderboards. Below is what people would see if you made it public.', actions: html`<a class="btn btn--tonal btn--s" href="/settings/privacy">Privacy settings</a>` }) : ''}
        ${p.me && !p.private ? banner({ iconName: 'eye', title: 'This is what other people see', text: hidden.length ? `Not shown to anyone else, because you keep it private: ${list(hidden)}.` : 'Everything you record is shared here.' }) : ''}
        ${p.me && p.private && hidden.length ? html`<p class="muted small pnotes__p">Even when public, this would stay hidden because you keep it private: ${list(hidden)}.</p>` : ''}
      </div>

      ${hasData
        ? html`<div class="pf-glance">${tiles}${yearCard}${moreRows(rows, { label: `More about ${name}` })}</div>`
        : html`<div class="mod mod--12"><div class="empty"><span class="empty__ic">${ic('eyeoff')}</span><p class="empty__t">Nothing shared yet</p><p class="empty__d">${p.me ? 'Once your data syncs, the categories you share appear here.' : `${name} has no public numbers yet. There is nothing here beyond the name.`}</p></div></div>`}
    `);
    // The newest weeks are at the right-hand end.
    const heat = root.querySelector('.heat');
    if (heat) {
      const end = () => { heat.scrollLeft = heat.scrollWidth; };
      end(); requestAnimationFrame(end);
    }
  }

  let rows = [];
  bindMore(root, () => rows);
  // Friends: ask, answer, or take it back. The page reads itself again after.
  on(root, 'click', '[data-friend]', async (e, b) => {
    const act = b.dataset.friend;
    if (act === 'remove' && b.dataset.state === 'friends') { go('/people/friends'); return; }
    await busy(b, async () => {
      try {
        const r = await api.post(`/api/friends/${act}`, { username: ctx.params.username });
        toast(act === 'request' ? (r.status === 'friends' ? 'You are friends now' : 'Request sent') : act === 'accept' ? 'You are friends now' : 'Request taken back');
        refreshMe().catch(() => {});
        load({ quiet: true });
      } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}
