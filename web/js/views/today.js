/* Today: the daily brief. What kind of day it is and why, how the day is
   going against this person's own usual, last night, the heart, what is
   worth knowing, and the week so far — glanceable at the top, the
   working-out as you scroll. Built from what the device reports: a module
   whose data does not exist is left out, and what is missing is said once.

   Data: /api/data (the day's numbers), /api/brief (the same numbers in
   context: usuals, week, streaks, insights, next) and /api/day (the day
   by hour, fetched after first paint because it asks Google). */

import { api } from '../api.js';
import { app, cap, listen, refreshMe } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, banner, chart, on, busy, toast, toastError } from '../ui.js';
import { sleepNight } from '../charts.js';
import { hours, cats, spark } from '../viz.js';
import { mod, grid, stat, delta, range, facts, insight, missingNote, legend, figure, ib, rings } from '../kit.js';
import * as f from '../format.js';
import { connectionBanner, missingScopes, runningCard, askCard, runTimers, bindWorkoutActions, startWorkout } from './shared.js';
import { heartTile, liveControl, bindLive, paintLive } from './liveui.js';

const READY = {
  push: { tone: 'good', icon: 'bolt' },
  normal: { tone: 'good', icon: 'check' },
  easy: { tone: 'warn', icon: 'flat' },
  rest: { tone: 'warn', icon: 'moon' },
  learning: { tone: '', icon: 'clock' },
  unavailable: { tone: '', icon: 'info' },
};

const PART = {
  hrv: { label: 'Heart rate variability', icon: 'wave', fam: 'recovery', href: '/trends/heart' },
  rhr: { label: 'Resting heart rate', icon: 'resting', fam: 'heart', href: '/trends/heart' },
  sleep: { label: 'Sleep', icon: 'moon', fam: 'sleep', href: '/trends/sleep' },
  temp: { label: 'Skin temperature', icon: 'temp', fam: 'energy', href: '/trends/heart' },
};

const lastRow = (d, key) => [...(d.series || [])].reverse().find((r) => f.isNum(r[key])) || null;

/* ── readiness ──────────────────────────────────────────────── */

/** One driver of the verdict: what it is, where it sits, what it did. */
function driver(p, d, b) {
  const meta = PART[p.key];
  if (!meta) return '';
  const pushed = p.pts > 0 ? html`<span class="delta delta--good">${ic('up', { size: 's' })}<span>Counts for you</span></span>`
    : p.pts < 0 ? html`<span class="delta delta--bad">${ic('down', { size: 's' })}<span>Counts against</span></span>`
      : html`<span class="muted">Neutral</span>`;
  let value = ''; let words = ''; let bar = '';
  if (p.key === 'hrv') {
    const row = lastRow(d, 'hrv');
    value = html`${f.int(p.value)}<span class="stat__u">ms</span>`;
    words = `${Math.abs(Math.round(p.delta))}% ${p.delta < 0 ? 'below' : 'above'} your usual ${f.int(p.base)}`;
    if (Math.abs(p.delta) < 1) words = `Right on your usual ${f.int(p.base)}`;
    bar = range({ value: p.value, lo: p.base - (row?.hrvSd || 0), hi: p.base + (row?.hrvSd || 0), tick: p.base, label: `HRV ${f.int(p.value)} milliseconds; your usual is ${f.int(p.base)}` });
  } else if (p.key === 'rhr') {
    const row = lastRow(d, 'rhr');
    value = html`${f.int(p.value)}<span class="stat__u">bpm</span>`;
    words = Math.abs(p.delta) < 0.5 ? `Right on your usual ${f.int(p.base)}` : `${f.int(Math.abs(p.delta))} bpm ${p.delta > 0 ? 'above' : 'below'} your usual ${f.int(p.base)}`;
    bar = range({ value: p.value, lo: p.base - (row?.rhrSd || 0), hi: p.base + (row?.rhrSd || 0), tick: p.base, label: `Resting heart rate ${f.int(p.value)}; your usual is ${f.int(p.base)}` });
  } else if (p.key === 'sleep') {
    const m = b?.metrics?.sleepMin;
    const goal = d.activity?.sleepTarget || app.me.goals?.sleepMinutes;
    value = f.dur(p.value);
    const diff = goal ? p.value - goal : null;
    words = diff === null ? '' : Math.abs(diff) < 10 ? 'Right on your goal' : `${f.dur(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} your goal`;
    if (m && f.isNum(m.usual)) words += `${words ? ' · ' : ''}usual ${f.dur(m.usual)}`;
    bar = range({ value: p.value, lo: m?.lo, hi: m?.hi, tick: goal, label: `Slept ${f.dur(p.value)}${goal ? `; your goal is ${f.dur(goal)}` : ''}` });
  } else if (p.key === 'temp') {
    value = f.tempDelta(p.value);
    words = 'Above your own usual at night';
  }
  return html`<a class="line fam fam-${meta.fam}" href="${meta.href}">
    <span class="line__k">${ib(meta.icon, { size: 's' })}<span>${meta.label}</span></span>
    <span class="line__v">${value}</span>
    <span class="line__c">${pushed}${words ? html`<span>${words}</span>` : ''}</span>
    ${bar ? html`<span class="line__g">${bar}</span>` : ''}
  </a>`;
}

function nextStep(b) {
  const n = b?.next;
  if (!n?.text) return '';
  const body = html`<span class="next__ic">${ic('right')}</span><span class="next__t">${n.text}</span>`;
  return n.href && n.href !== '/' ? html`<a class="next" href="${n.href}">${body}</a>` : html`<p class="next">${body}</p>`;
}

function verdict(d, b) {
  const rd = d.readiness;
  if (!rd || rd.level === 'unavailable') return '';
  const meta = READY[rd.level] || READY.normal;
  const stale = d.stale > 0 ? `From ${f.dayRel(d.verdictDay).toLowerCase()}, not this morning` : '';
  // "HRV −11% vs baseline, resting HR +3 bpm: easy day" → the reasons only.
  const why = (rd.text || '').replace(/:\s*[^:]*$/, '');
  const parts = (rd.parts || []).filter((p) => PART[p.key]);
  return mod({
    title: 'Readiness', span: 7, cls: 'today-verdict', fam: 'recovery', icon: 'readiness',
    note: [rd.usedText, stale].filter(Boolean).join('. '),
    body: html`
      <div class="verdict verdict--${meta.tone || 'plain'}">
        <span class="verdict__ic">${ic(meta.icon)}</span>
        <div>
          <p class="verdict__t">${rd.label || rd.level}</p>
          <p class="verdict__d">${rd.score === null ? rd.text : why ? `${why}.` : ''}</p>
        </div>
      </div>
      ${parts.length ? html`<div class="lines">${parts.map((p) => driver(p, d, b))}</div>` : ''}
      ${nextStep(b)}`,
  });
}

/* ── activity ───────────────────────────────────────────────── */

function activity(d, b, day) {
  const act = d.activity?.today || {};
  const goal = d.activity?.stepTarget || app.me.goals?.steps || 8000;
  const steps = act.steps;
  if (!cap('steps') && !f.isNum(steps)) return '';
  const m = b?.metrics || {};
  const wd = b?.weekday || '';
  const usual = m.steps?.usual;
  const v = steps || 0;
  const left = goal - v;
  const line = !f.isNum(steps) ? 'No steps yet today.'
    : left > 0 ? `${Math.round((v / goal) * 100)}% of your goal · ${f.int(left)} to go`
      : `Goal reached${v >= goal * 1.5 ? ', and then some' : ''}`;
  const past = f.isNum(usual) && v > usual;
  const usualLine = f.isNum(usual) ? `Your usual ${wd} is ${f.int(usual)}${past ? ', already passed' : ''}.` : '';

  // The day's goals as rings: steps, active minutes, and a third that this
  // person's device can fill (last night's sleep, else calories against usual).
  const ag = d.activity?.azmTarget || app.me.goals?.activeMinutes || 22;
  const am = act.activeMinutes;
  const night = d.sleep?.lastNight;
  const sg = d.activity?.sleepTarget || app.me.goals?.sleepMinutes;
  const list = [{ fam: 'steps', value: v, goal, label: 'Steps', icon: 'steps', v: f.int(v), of: f.int(goal) }];
  if (f.isNum(am) || cap('activeMinutes')) list.push({ fam: 'active', value: am || 0, goal: ag, label: 'Active', icon: 'bolt', v: f.int(am || 0), of: `${f.int(ag)} min` });
  if (night && f.isNum(night.asleepMin) && sg) list.push({ fam: 'sleep', value: night.asleepMin, goal: sg, label: 'Sleep', icon: 'moon', v: f.durShort(night.asleepMin), of: f.durShort(sg) });
  else if (f.isNum(act.kcal) && f.isNum(m.kcal?.usual)) list.push({ fam: 'energy', value: act.kcal, goal: m.kcal.usual, label: 'Calories', icon: 'flame', v: f.int(act.kcal), of: `${f.int(m.kcal.usual)} usual` });
  const ringSize = list.length >= 3 ? 148 : list.length === 2 ? 132 : 116;
  const ringBlock = html`<div class="ringrow">
    ${rings(list, { size: ringSize, stroke: list.length >= 3 ? 14 : 15, inner: list.length === 1 ? `<span class="ring__n">${Math.round((v / goal) * 100)}%</span>` : '' })}
    <ul class="ringkey">${list.map((r) => html`<li class="ringkey__i fam fam-${r.fam}">${ib(r.icon)}<span class="ringkey__k">${r.label}</span><span class="ringkey__v">${r.v}<small>/ ${r.of}</small></span></li>`)}</ul>
  </div>`;

  const stepHours = day?.steps?.available ? day.hours.map((h) => h.steps) : null;
  const nowHour = day && day.date === d.today ? Number(f.clock(Date.now()).slice(0, 2)) : null;
  const shape = stepHours && stepHours.some((x) => x > 0)
    ? figure(chart((w) => hours({ w, values: stepHours, nowHour, unit: 'steps', fmt: f.int, label: `Steps by hour today. ${f.isNum(day.peakHour) ? `Busiest hour ${String(day.peakHour).padStart(2, '0')}:00.` : ''}` })), {
      read: [f.isNum(day.peakHour) ? `Busiest hour ${String(day.peakHour).padStart(2, '0')}:00` : null, f.isNum(day.activeHours) ? `${f.plural(day.activeHours, 'active hour')}` : null].filter(Boolean).join(' · '),
    })
    : day === null && cap('steps') ? html`<div class="skel skel--chart" aria-hidden="true"></div>` : '';

  const small = [];
  const ctx = (mm, fmt) => (mm && f.isNum(mm.usual) ? `Usual ${wd} ${fmt(mm.usual)}` : '');
  if (f.isNum(act.distanceM) || cap('distance')) small.push(stat({ size: 's', label: 'Distance', value: f.distNum(act.distanceM || 0), unit: f.distUnit(), context: ctx(m.distanceM, (x) => f.dist(x)) }));
  if (f.isNum(act.kcal) || cap('calories')) small.push(stat({ size: 's', label: 'Calories', value: f.int(act.kcal || 0), unit: 'kcal', context: ctx(m.kcal, f.int) }));

  return mod({
    title: 'Activity', note: 'So far today', span: 5, link: { href: '/trends/activity', text: 'Trends' }, fam: 'steps', icon: 'steps',
    body: html`
      ${ringBlock}
      <p class="today-line"><b>${line}.</b> ${usualLine}</p>
      ${shape}
      ${small.length ? html`<hr class="rule"><div class="stats stats--${Math.min(3, small.length)}">${small}</div>` : ''}`,
  });
}

/* ── sleep ──────────────────────────────────────────────────── */

function sleep(d, b) {
  if (!cap('sleep') && !d.sleep?.lastNight) return '';
  const night = d.sleep?.lastNight;
  const link = { href: '/trends/sleep', text: 'Trends' };
  if (!night || !f.isNum(night.asleepMin)) {
    return mod({ title: 'Sleep', span: 7, link, fam: 'sleep', icon: 'moon', body: html`<p class="muted">Nothing recorded last night. Wear your device to bed and it shows up here in the morning.</p>` });
  }
  const bs = b?.sleep || null;
  const full = d.sleep.nights?.find((n) => n.main && n.date === night.date) || null;
  const target = d.activity?.sleepTarget || app.me.goals?.sleepMinutes;
  const diff = target ? night.asleepMin - target : null;
  const goalWords = diff === null ? '' : Math.abs(diff) < 10 ? 'Right on your goal' : `${f.dur(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} your goal`;
  const vsAvg = bs && f.isNum(bs.lastVsAvgMin) && Math.abs(bs.lastVsAvgMin) >= 5
    ? delta({ abs: bs.lastVsAvgMin, unit: 'min', good: 'up', text: 'against your 14-night average' }) : '';
  const strip = full && f.isNum(full.startMs) && f.isNum(full.endMs)
    ? chart((w) => sleepNight({ w, h: 104, start: full.startMs, end: full.endMs, stages: cap('sleepStages') ? full.stages : null, label: `Sleep from ${f.clock(full.startMs)} to ${f.clock(full.endMs)}` }))
    : '';
  const st = night.stages || {};
  const hasStages = cap('sleepStages') && (st.DEEP || st.REM);
  const total = (st.DEEP || 0) + (st.REM || 0) + (st.LIGHT || 0) + (st.AWAKE || 0);
  const stageFact = (key, name) => {
    const min = st[key] || 0;
    const pct = total ? Math.round((min / total) * 100) : null;
    const usual = bs?.stages?.[key]?.usualPct;
    return { k: name, v: f.dur(min), s: pct === null ? '' : `${pct}%${f.isNum(usual) ? ` · usual ${Math.round(usual)}%` : ''}` };
  };
  const when = [];
  if (bs?.bedtime?.last) when.push({ k: 'Asleep at', v: bs.bedtime.last, s: bs.bedtime.usual ? `Usual ${bs.bedtime.usual}` : '' });
  else if (f.isNum(night.startMs)) when.push({ k: 'Asleep at', v: f.clock(night.startMs) });
  if (bs?.wake?.last) when.push({ k: 'Up at', v: bs.wake.last, s: bs.wake.usual ? `Usual ${bs.wake.usual}` : '' });
  else if (f.isNum(night.endMs)) when.push({ k: 'Up at', v: f.clock(night.endMs) });
  if (bs && f.isNum(bs.regularity)) when.push({ k: 'Regularity', v: f.int(bs.regularity), u: 'of 100', s: `Over ${f.plural(bs.nights, 'night')}` });
  if (bs && f.isNum(bs.debt7Min)) when.push({ k: 'Short of goal, 7 nights', v: bs.debt7Min < 5 ? 'None' : f.dur(bs.debt7Min) });

  return mod({
    title: 'Sleep', note: night.date === d.today ? 'Last night' : f.dayRel(night.date), span: 7, link, fam: 'sleep', icon: 'moon',
    body: html`
      ${stat({ size: 'l', value: f.dur(night.asleepMin), context: html`${goalWords ? html`<span>${goalWords}</span>` : ''}${vsAvg}` })}
      ${strip ? html`<div class="part">${figure(strip, { read: hasStages ? 'Taller blocks are deeper sleep.' : '' })}${hasStages ? legend([['sw-deep', 'Deep'], ['sw-rem', 'REM'], ['sw-light', 'Light'], ['sw-awake', 'Awake']]) : ''}</div>` : ''}
      ${hasStages ? facts([stageFact('DEEP', 'Deep'), stageFact('REM', 'REM'), stageFact('LIGHT', 'Light'), stageFact('AWAKE', 'Awake')], { cols: 4, cls: 'facts--s' }) : ''}
      ${when.length ? html`<hr class="rule">${facts(when, { cols: 4, cls: 'facts--s' })}` : ''}`,
  });
}

/* ── heart ──────────────────────────────────────────────────── */

function vital(d, { key, base, sd, label, unit, good, digits = 0, fam, icon }) {
  const rows = (d.series || []).slice(-14);
  const row = lastRow(d, key);
  if (!row) return '';
  const v = row[key]; const bs = row[base];
  const diff = f.isNum(bs) ? v - bs : null;
  const words = diff === null ? html`<span class="muted">Still learning your usual</span>`
    : Math.abs(diff) < (digits ? 0.05 : 0.5) ? html`<span>Right on your usual</span>`
      : html`${delta({ abs: diff, unit, good, digits })}<span>${diff > 0 ? 'above' : 'below'} your usual ${digits ? f.dec1(bs) : f.int(bs)}</span>`;
  const sp = rows.filter((r) => f.isNum(r[key])).length >= 4
    ? chart((w) => spark({ w, h: 40, values: rows.map((r) => r[key]), band: sd ? { lo: rows.map((r) => (f.isNum(r[base]) && f.isNum(r[sd]) ? r[base] - r[sd] : null)), hi: rows.map((r) => (f.isNum(r[base]) && f.isNum(r[sd]) ? r[base] + r[sd] : null)) } : null, label: `${label}, last 14 days, against your usual range` }))
    : '';
  return html`<a class="line line--spark fam fam-${fam}" href="/trends/heart">
    <span class="line__k">${ib(icon, { size: 's' })}<span>${label}</span></span>
    <span class="line__v">${digits ? f.dec1(v) : f.int(v)}<span class="stat__u">${unit}</span></span>
    <span class="line__c">${words}</span>
    ${sp ? html`<span class="line__g">${sp}</span>` : ''}
  </a>`;
}

function heart(d, day) {
  const rhrRow = lastRow(d, 'rhr');
  const any = d.hr || rhrRow || cap('heartRate') || cap('hrv') || cap('spo2');
  if (!any) return '';
  const tile = d.hr || rhrRow
    ? heartTile({ synced: {
      v: d.hr ? html`${Math.round(d.hr.bpm)}<span class="unit">bpm</span>` : html`${Math.round(rhrRow.rhr)}<span class="unit">bpm resting</span>`,
      s: d.hr ? `Latest reading, ${f.ago(d.hr.t)}` : 'Your latest resting heart rate',
    } })
    : heartTile({ synced: null, na: 'No heart rate has arrived yet.' });
  const lines = [
    cap('restingHr') || rhrRow ? vital(d, { key: 'rhr', base: 'rhrBase', sd: 'rhrSd', label: 'Resting', unit: 'bpm', good: 'down', fam: 'heart', icon: 'resting' }) : '',
    cap('hrv') ? vital(d, { key: 'hrv', base: 'hrvBase', sd: 'hrvSd', label: 'Variability', unit: 'ms', good: 'up', fam: 'recovery', icon: 'wave' }) : '',
  ].filter(Boolean);
  const hr = day?.hr?.available ? day.hours.map((h) => (f.isNum(h.hrMin) && f.isNum(h.hrMax) ? { lo: h.hrMin, hi: h.hrMax, avg: h.hrAvg } : null)) : null;
  const shape = hr && hr.some(Boolean)
    ? html`<div class="part"><p class="sub">Through the day</p>${figure(chart((w) => hours({ w, h: 104, range: hr, unit: 'bpm', label: 'Heart rate by hour today: the range in each hour, with its average' })), { read: 'Each bar is the range in that hour; the line is its average.' })}</div>`
    : day === null && cap('heartRateMinute') ? html`<div class="skel skel--chart" aria-hidden="true"></div>` : '';
  const extra = [];
  const spo = lastRow(d, 'spo2');
  if (spo) extra.push({ k: 'Blood oxygen', v: f.dec1(spo.spo2), u: '%', s: f.isNum(spo.spo2Lo) ? `Asleep, ${f.dec1(spo.spo2Lo)} to ${f.dec1(spo.spo2Hi)}` : 'Average while asleep' });
  const tmp = lastRow(d, 'tempDev');
  if (tmp) extra.push({ k: 'Skin temperature', v: f.tempDelta(tmp.tempDev), s: 'Against your own usual, at night' });
  return mod({
    title: 'Heart', span: 5, link: { href: '/trends/heart', text: 'Trends' }, cls: 'today-heart', fam: 'heart', icon: 'heart',
    body: html`
      ${tile}
      ${lines.length ? html`<hr class="rule"><div class="lines">${lines}</div>` : ''}
      ${shape}
      ${extra.length ? html`<hr class="rule">${facts(extra, { cols: 2, cls: 'facts--s' })}` : ''}`,
  });
}

/* ── worth knowing, and the week ────────────────────────────── */

function knowing(b) {
  const list = (b?.insights || []).slice(0, 5);
  const changes = (b?.changes || []).slice(0, 4);
  if (!list.length && !changes.length) return '';
  return mod({
    title: 'Worth knowing', span: 7, icon: 'idea',
    body: html`
      ${changes.length ? html`<div class="part"><p class="sub">Since yesterday</p><ul class="changes">${changes.map((c) => html`<li class="change">${ic(c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'flat', { size: 's' })}<span class="${c.good === true ? 'change--good' : c.good === false ? 'change--bad' : ''}">${c.text}</span></li>`)}</ul></div>` : ''}
      ${changes.length && list.length ? html`<hr class="rule">` : ''}
      ${list.length ? html`<div class="insights">${list.map((i) => insight(i))}</div>` : ''}`,
  });
}

const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const STREAK_FAM = { steps: ['steps', 'steps'], active: ['active', 'bolt'], sleep: ['sleep', 'moon'], workout_weeks: ['workouts', 'strength'] };

function week(d, b) {
  const wk = b?.week;
  const streaks = b?.streaks || [];
  if (!wk && !streaks.length) return '';
  const days = wk?.days || [];
  const todayIdx = days.findIndex((x) => x.date === d.today);
  const hasSteps = days.some((x) => f.isNum(x.steps) || f.isNum(x.lastSteps));
  const graph = hasSteps ? figure(chart((w) => cats({
    w, h: 124, labels: WD, a: days.map((x) => (x.future ? null : x.steps)), b: days.map((x) => x.lastSteps), nameA: 'this week', nameB: 'last week',
    fmt: f.int, unit: 'steps', goal: d.activity?.stepTarget, mark: todayIdx >= 0 ? todayIdx : null,
    reads: days.map((x) => `${f.dow(x.date)}: ${x.future ? 'still to come' : f.isNum(x.steps) ? `${f.int(x.steps)} steps` : 'no data'}${f.isNum(x.lastSteps) ? `, last week ${f.int(x.lastSteps)}` : ''}`),
    label: 'Steps each day this week against the same day last week',
  })), { legendItems: [['sw-met', 'This week'], ['sw-b', 'Last week']] }) : '';

  const t = wk?.totals || {};
  const row = (label, m, fmt, good = 'up') => (m && f.isNum(m.value) ? { k: label, v: fmt(m.value), s: f.isNum(m.deltaPct) ? html`${delta({ pct: m.deltaPct, good })} <span>on last week so far</span>` : (f.isNum(m.previous) ? `Last week ${fmt(m.previous)}` : '') } : null);
  const totals = [
    row('Steps', t.steps, f.int),
    row('Active minutes', t.activeMinutes, f.int),
    row('Average sleep', t.sleepAvgMin, f.dur),
    t.workouts && f.isNum(t.workouts.value) ? { k: 'Workouts', v: f.int(t.workouts.value), s: f.isNum(t.workoutMin?.value) && t.workoutMin.value > 0 ? `${f.dur(t.workoutMin.value)}${f.isNum(t.workouts.previous) ? ` · last week ${f.int(t.workouts.previous)}` : ''}` : (f.isNum(t.workouts.previous) ? `Last week ${f.int(t.workouts.previous)} by now` : '') } : null,
  ].filter(Boolean);

  const sk = streaks.filter((s) => s.current > 0 || s.best > 0);
  return mod({
    title: 'This week', span: 5, icon: 'week', note: wk ? `${f.dayShort(wk.start)} to ${f.dayShort(f.addDays(wk.start, 6))}` : '',
    body: html`
      ${graph}
      ${totals.length ? facts(totals, { cols: 2, cls: 'facts--s' }) : ''}
      ${sk.length ? html`<hr class="rule"><div class="part"><p class="sub">Streaks</p><ul class="streaklist">${sk.map((s) => html`<li class="streakrow fam fam-${(STREAK_FAM[s.id] || STREAK_FAM.steps)[0]} ${s.atRisk ? 'is-risk' : ''}">
        ${ib((STREAK_FAM[s.id] || STREAK_FAM.steps)[1])}
        <span class="streakrow__n">${f.int(s.current)}</span>
        <span class="streakrow__b"><span class="streakrow__t">${s.label}</span><span class="streakrow__d">${s.atRisk && s.need ? html`<span class="streakrow__risk">${ic('alert', { size: 's' })}${s.need}</span>` : `${s.unit === 'weeks' ? 'weeks' : 'days'} in a row`}${s.best > s.current ? ` · best ${f.int(s.best)}` : s.current > 1 && s.best === s.current ? ' · your best' : ''}</span></span>
      </li>`)}</ul></div>` : ''}`,
  });
}

/* ── footer: device, sync, live control ─────────────────────── */

function deviceLine(d) {
  const dev = d?.device || app.me.device;
  const me = app.me;
  const bits = [];
  if (dev) {
    const low = f.isNum(dev.battery) && dev.battery <= 20;
    bits.push(html`<span class="devline__i">${ic(f.isNum(dev.battery) ? 'battery' : 'watch', { size: 's' })}<span>${dev.name || 'Device'}${f.isNum(dev.battery) ? html` · ${f.int(dev.battery)}%${low ? html` <span class="badge badge--warn">Low</span>` : ''}` : ''}${dev.lastSync ? ` · on your wrist ${f.ago(dev.lastSync)}` : ''}</span></span>`);
  }
  if (me.google?.state === 'ok') {
    bits.push(html`<span class="devline__i">${ic('refresh', { size: 's' })}<span>${me.sync?.running || app.syncing ? 'Syncing now' : me.sync?.lastOk ? `Synced with Google Health ${f.ago(me.sync.lastOk)}` : 'Not synced yet'}</span></span>`);
  }
  return bits.length ? html`<div class="devline">${bits}${me.google?.state === 'ok' ? html`<button type="button" class="btn btn--ghost btn--s" data-action="sync">Sync now</button>` : ''}</div>` : '';
}

function notConnected() {
  return html`<div class="group"><div class="empty">
    <span class="empty__ic">${ic('link')}</span>
    <p class="empty__t">Your day appears here</p>
    <p class="empty__d">Once Google Health is connected: what kind of day it is, steps against your usual, last night's sleep in stages, your heart, and the week so far.</p>
  </div></div>`;
}

export default async function today(ctx) {
  const { root } = ctx;
  document.title = 'Today · Health';
  let data = null; let brief = null; let day = null; let wk = null; let stopTimers = null;

  const syncBtn = () => html`<button type="button" class="iconbtn ${app.syncing ? 'is-busy' : ''}" data-action="sync" aria-label="Sync now" title="Sync now">${ic('refresh')}</button>`;

  function paint() {
    const me = app.me;
    const d = data; const b = brief;
    const g = me.google?.state;
    const pending = wk?.pending || [];
    const running = wk?.running || null;
    const has = d && d.connected !== false ? !d.empty : d && !d.empty;
    const full = has && d.readiness && d.readiness.level !== 'unavailable';

    const tools = html`<div class="btnrow">
      ${!running ? html`<button type="button" class="btn btn--tonal btn--s" data-action="start">${ic('play', { size: 's' })}Start workout</button>` : ''}
      <a class="btn btn--tonal btn--s" href="/summary">${ic('text', { size: 's' })}Summary</a>
    </div>`;

    // A device with recovery signals leads with the verdict; a phone leads
    // with the day's activity and the week.
    const modules = !has ? '' : full
      ? html`${verdict(d, b)}${activity(d, b, day)}${sleep(d, b)}${heart(d, day)}${knowing(b)}${week(d, b)}`
      : html`${activity(d, b, day)}${week(d, b)}${sleep(d, b)}${heart(d, day)}${knowing(b)}${!full && b?.next ? mod({ title: 'Next', span: 5, icon: 'right', body: nextStep(b) }) : ''}`;

    mount(root, html`
      ${head({ title: 'Today', sub: f.dayLong(d?.today || f.today()), actions: g === 'ok' ? syncBtn() : '' })}
      <div class="stack">
        ${connectionBanner('/')}
        ${running ? runningCard(running) : ''}
        ${pending.map((w) => askCard(w))}
        ${d?.illness?.flag ? banner({ tone: 'warn', iconName: 'temp', title: 'Your body looks under strain', text: d.illness.text || (d.illness.reasons || []).join(', ') }) : ''}
        ${!d || (!d.connected && d.empty) ? notConnected()
          : d.empty ? html`${banner({ tone: 'accent', iconName: 'refresh', title: 'The first sync is running', text: 'Your history is being fetched from Google Health. This page fills in by itself, usually within a minute.' })}${skeleton('today')}`
          : html`${grid(modules, 'grid--rows today')}
            ${tools}
            ${liveControl()}
            ${deviceLine(d)}
            ${missingNote(b?.missing || me.capsMeta?.missing)}`}
        ${g === 'ok' ? missingScopes('/') : ''}
      </div>`);

    stopTimers?.();
    stopTimers = running ? runTimers(root) : null;
    paintLive(root);
  }

  async function loadDay() {
    if (!data || data.empty || !data.connected) return;
    try {
      const got = await api.get('/api/day');
      if (!ctx.alive()) return;
      const had = Boolean(day);
      day = got;
      if (!had || document.visibilityState === 'visible') paint();
    } catch { /* the day's shape is an extra; Today stands without it */ }
  }

  async function load() {
    const needWk = app.me.workout && (app.me.workout.running || app.me.workout.pending > 0);
    const [d, b, w] = await Promise.all([
      api.get('/api/data?days=30'),
      api.get('/api/brief').catch(() => null),
      needWk ? api.get('/api/workouts?limit=1').catch(() => null) : Promise.resolve(null),
    ]);
    data = d; brief = b; wk = w;
  }

  async function reload({ quiet = true } = {}) {
    try {
      await load();
      if (ctx.alive()) paint();
      loadDay();
    } catch (err) {
      if (!quiet && ctx.alive()) toastError(err);
    }
  }

  async function sync(btn) {
    if (app.syncing) return;
    app.syncing = true;
    root.querySelectorAll('.iconbtn[data-action="sync"]').forEach((el) => el.classList.add('is-busy'));
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
      loadDay();
    } catch (err) {
      if (!ctx.alive()) return;
      mount(root, html`${head({ title: 'Today' })}${errorState(err)}`);
    }
  }
  await first();
}
