/* Today: the daily brief. What kind of day it is and why, how the day is
   going against this person's own usual, last night, the heart, what is
   worth knowing, and the week so far — glanceable at the top, the
   working-out as you scroll. Built from what the device reports: a module
   whose data does not exist is left out, and what is missing is said once.

   Data: /api/data (the day's numbers), /api/brief (the same numbers in
   context: usuals, week, streaks, insights, next, and `extra`: weekly
   cardio, the sleep score, calories in two parts, floors, vitals, the
   recovery trend, water, food and the pinned metrics) and /api/day (the
   day by hour, fetched after first paint because it asks Google).

   Each part of `extra` is null (or empty) for somebody without that data
   and then simply is not drawn: a phone-only person's Today is exactly
   the activity, the week and what is worth knowing. */

import { api } from '../api.js';
import { app, cap, listen, refreshMe } from '../app.js';
import { html, raw, mount, hydrate, ic, head, skeleton, errorState, banner, chart, on, busy, toast, toastError, sheet } from '../ui.js';
import { sleepNight } from '../charts.js';
import { hours, cats, spark } from '../viz.js';
import { mod, grid, stat, delta, range, facts, insight, missingNote, legend, figure, ib, rings, meter } from '../kit.js';
import { metricRow, metricIcon, num as mnum, unitOf } from '../metrics.js';
import { quickAdd, addEntry } from '../entry.js';
import { cardioRing } from './metric.js';
import { groupGrantToast } from '../groups.js';
import * as f from '../format.js';
import { connectionBanner, missingScopes, runningCard, askCard, runTimers, bindWorkoutActions, startWorkout } from './shared.js';
import { heartTile, heartBento, bindLive, paintLive } from './liveui.js';
import { aiButton, morningCard, morningNote } from '../ai.js';

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

/** The app's own 7-day trend of HRV and resting heart rate, as one quiet
    line: its label in words, what it is made of, and whose number it is. */
function recoveryLine(rc) {
  if (!rc?.label) return '';
  const NAME = { hrv: ['HRV', 'ms'], rhr: ['resting heart rate', 'bpm'] };
  const made = (rc.parts || []).filter((p) => NAME[p.id] && f.isNum(p.value) && f.isNum(p.baseline))
    .map((p) => `${NAME[p.id][0]} ${f.dec1(p.value)} ${NAME[p.id][1]} against your usual ${f.dec1(p.baseline)}`);
  return html`<a class="trendnote fam fam-recovery" href="/metric/recovery">
    ${ib('battery_charging_full', { size: 's' })}
    <span class="trendnote__b">
      <span class="trendnote__t">Over the last 7 days your recovery trend is <b>${rc.label}</b></span>
      <span class="trendnote__d">${made.length ? `${made.join(' · ')}. ` : ''}Calculated by this app.</span>
    </span>
    <span class="row__chev">${ic('right', { size: 's' })}</span>
  </a>`;
}

/** Readiness, resilience and the sleep score, worked out the way Google describes them. */
function scoresRow(d) {
  const sc = d.scores;
  if (!sc || (!f.isNum(sc.ready) && !f.isNum(sc.resil))) return '';
  const tone = (b) => ({ High: 'ok', Optimal: 'ok', Moderate: '', Balanced: '', Low: 'bad' }[b] || '');
  return html`<div class="gscores">
    ${f.isNum(sc.ready) ? html`<a class="gscore" href="/metric/readiness"><span class="gscore__k">Readiness</span><span class="gscore__v">${sc.ready}</span><span class="badge ${tone(sc.readyBand) ? `badge--${tone(sc.readyBand)}` : ''}">${sc.readyBand}</span></a>` : ''}
    ${f.isNum(sc.resil) ? html`<a class="gscore" href="/metric/resilience"><span class="gscore__k">Resilience</span><span class="gscore__v gscore__v--w">${sc.resilLabel}</span></a>` : ''}
    ${f.isNum(sc.sleep) ? html`<a class="gscore" href="/metric/sleep_score"><span class="gscore__k">Sleep score</span><span class="gscore__v">${sc.sleep}</span><span class="badge">${sc.sleepBand}</span></a>` : ''}
  </div>
  <p class="muted small gscores__n">Worked out from your data the way Google describes them. Google does not share its own, so they can differ by a few points.</p>`;
}

function verdict(d, b, o) {
  const rd = d.readiness;
  if (!rd || rd.level === 'unavailable') return '';
  const meta = READY[rd.level] || READY.normal;
  const stale = d.stale > 0 ? `From ${f.dayRel(d.verdictDay).toLowerCase()}, not this morning` : '';
  // "HRV −11% vs baseline, resting HR +3 bpm: easy day" → the reasons only.
  const why = (rd.text || '').replace(/:\s*[^:]*$/, '');
  const parts = (rd.parts || []).filter((p) => PART[p.key]);
  return mod({
    title: 'Readiness', span: 7, cls: `today-verdict ord-${o}`, fam: 'recovery', icon: 'readiness', tools: aiButton('readiness'),
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
      ${recoveryLine(b?.extra?.recovery)}
      ${nextStep(b)}`,
  });
}

/* ── activity ───────────────────────────────────────────────── */

/** Calories so far as two parts, active and resting, on a track that ends
    at the usual total for this weekday. */
function caloriesBlock(c, wd) {
  const u = c.usual || {};
  const top = Math.max(c.total || 0, u.total || 0, 1);
  const pc = (v) => `${((Math.max(0, v || 0) / top) * 100).toFixed(1)}%`;
  const diff = f.isNum(u.total) ? `Usual ${wd || 'day'} ${f.int(u.total)} by the end of the day` : 'Not enough history for a usual yet';
  const label = `Calories so far: ${f.int(c.total)} kilocalories, ${f.int(c.active)} active and ${f.int(c.basal)} resting.${f.isNum(u.total) ? ` Your usual ${wd} ends at ${f.int(u.total)}.` : ''}`;
  return html`<div class="kcal fam fam-energy">
    ${stat({ size: 's', label: 'Calories', value: f.int(c.total), unit: 'kcal', context: diff, href: '/metric/calories' })}
    <div class="twobar" role="img" aria-label="${label}">
      <span class="twobar__p twobar__p--a" data-style="width:${pc(c.active)}"></span><span class="twobar__p twobar__p--b" data-style="width:${pc(c.basal)}"></span>
      ${f.isNum(u.total) && u.total < top ? raw(`<span class="meter__tick meter__tick--usual" data-style="--x:${pc(u.total)}"></span>`) : ''}
    </div>
    <p class="twokey">
      <span><i class="twokey__a"></i>Active <b>${f.int(c.active)}</b>${f.isNum(u.active) ? ` · usual ${f.int(u.active)}` : ''}</span>
      <span><i class="twokey__b"></i>Resting <b>${f.int(c.basal)}</b></span>
    </p>
  </div>`;
}

function activity(d, b, day, o) {
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
    ? figure(chart((w) => hours({ w, values: stepHours, nowHour, unit: 'steps', fmt: f.int, label: `Steps by hour today. ${f.isNum(day.peakHour) ? `Busiest hour ${f.hourLabel(day.peakHour)}.` : ''}` })), {
      read: [f.isNum(day.peakHour) ? `Busiest hour ${f.hourLabel(day.peakHour)}` : null, f.isNum(day.activeHours) ? `${f.plural(day.activeHours, 'active hour')}` : null].filter(Boolean).join(' · '),
    })
    : day === null && cap('steps') ? html`<div class="skel skel--chart" aria-hidden="true"></div>` : '';

  const small = [];
  const ctx = (mm, fmt) => (mm && f.isNum(mm.usual) ? `Usual ${wd} ${fmt(mm.usual)}` : '');
  if (f.isNum(act.distanceM) || cap('distance')) small.push(stat({ size: 's', label: 'Distance', value: f.distNum(act.distanceM || 0), unit: f.distUnit(), context: ctx(m.distanceM, (x) => f.dist(x)) }));
  const x = b?.extra || {};
  if (x.floors && f.isNum(x.floors.value)) small.push(stat({ size: 's', label: 'Floors', value: f.int(x.floors.value), unit: x.floors.value === 1 ? 'floor' : 'floors', context: f.isNum(x.floors.usual) ? `Usual ${wd} ${f.int(x.floors.usual)}` : '', href: '/metric/floors' }));
  // The richer calories (two parts against the usual) replaces the plain stat.
  const rich = x.calories && f.isNum(x.calories.total) && f.isNum(x.calories.active);
  if (!rich && (f.isNum(act.kcal) || cap('calories'))) small.push(stat({ size: 's', label: 'Calories', value: f.int(act.kcal || 0), unit: 'kcal', context: ctx(m.kcal, f.int) }));

  return mod({
    title: 'Activity', note: 'So far today', span: 5, link: { href: '/trends/activity', text: 'Trends' }, fam: 'steps', icon: 'steps', cls: o ? `ord-${o}` : '', tools: aiButton('activity'),
    body: html`
      ${ringBlock}
      <p class="today-line"><b>${line}.</b> ${usualLine}</p>
      ${shape}
      ${small.length || rich ? html`<hr class="rule">` : ''}
      ${small.length ? html`<div class="stats stats--${Math.min(3, small.length)}">${small}</div>` : ''}
      ${rich ? caloriesBlock(x.calories, wd) : ''}`,
  });
}

/* ── sleep ──────────────────────────────────────────────────── */

/** The app's own score for the night, beside the duration. */
function scoreStat(sc) {
  const diff = f.isNum(sc.usual) ? sc.score - sc.usual : null;
  const words = diff === null ? 'Still learning your usual' : Math.abs(diff) < 1 ? `Right on your usual ${f.int(sc.usual)}` : `${f.int(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} your usual ${f.int(sc.usual)}`;
  return stat({ cls: 'today-score', label: 'Sleep score', value: f.int(sc.score), unit: 'of 100', context: words, href: '/metric/sleep_score' });
}
const tidy = (v) => (Number.isInteger(v) ? f.int(v) : f.dec1(v));
/** What the score is made of: each part as points of its maximum. */
function scoreParts(sc) {
  if (!sc.parts?.length) return '';
  return html`<a class="part scoreparts" href="/metric/sleep_score">
    <p class="sub">What the score is made of · calculated by this app</p>
    <ul class="scoreparts__l">${sc.parts.map((p) => html`<li>
      <span class="scoreparts__k">${p.label}</span><span class="scoreparts__v">${tidy(p.points)}<small> of ${f.int(p.max)}</small></span>
      ${meter({ value: p.points, goal: p.max, label: `${p.label}: ${tidy(p.points)} of ${p.max} points. ${p.text || ''}` })}
    </li>`)}</ul>
  </a>`;
}

function sleep(d, b, o) {
  if (!cap('sleep') && !d.sleep?.lastNight) return '';
  const night = d.sleep?.lastNight;
  const link = { href: '/trends/sleep', text: 'Trends' };
  if (!night || !f.isNum(night.asleepMin)) {
    return mod({ title: 'Sleep', span: 7, link, fam: 'sleep', icon: 'moon', cls: o ? `ord-${o}` : '', body: html`<p class="muted">Nothing recorded last night. Wear your device to bed and it shows up here in the morning.</p>` });
  }
  const bs = b?.sleep || null;
  const full = d.sleep.nights?.find((n) => n.main && n.date === night.date) || null;
  const target = d.activity?.sleepTarget || app.me.goals?.sleepMinutes;
  const diff = target ? night.asleepMin - target : null;
  const goalWords = diff === null ? '' : Math.abs(diff) < 10 ? 'Right on your goal' : `${f.dur(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} your goal`;
  const vsAvg = bs && f.isNum(bs.lastVsAvgMin) && Math.abs(bs.lastVsAvgMin) >= 5
    ? delta({ abs: bs.lastVsAvgMin, unit: 'min', good: 'up', text: 'against your 14-night average' }) : '';
  const strip = full && f.isNum(full.startMs) && f.isNum(full.endMs)
    ? chart((w) => sleepNight({ w, h: cap('sleepStages') && full.stages?.length ? 104 : 64, start: full.startMs, end: full.endMs, stages: cap('sleepStages') ? full.stages : null, label: `Sleep from ${f.clock(full.startMs)} to ${f.clock(full.endMs)}` }))
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
  if (bs?.bedtime?.last) when.push({ k: 'Asleep at', v: f.hhmm(bs.bedtime.last), s: bs.bedtime.usual ? `Usual ${f.hhmm(bs.bedtime.usual)}` : '' });
  else if (f.isNum(night.startMs)) when.push({ k: 'Asleep at', v: f.clock(night.startMs) });
  if (bs?.wake?.last) when.push({ k: 'Up at', v: f.hhmm(bs.wake.last), s: bs.wake.usual ? `Usual ${f.hhmm(bs.wake.usual)}` : '' });
  else if (f.isNum(night.endMs)) when.push({ k: 'Up at', v: f.clock(night.endMs) });
  if (bs && f.isNum(bs.regularity)) when.push({ k: 'Regularity', v: f.int(bs.regularity), u: 'of 100', s: `Over ${f.plural(bs.nights, 'night')}` });
  if (bs && f.isNum(bs.debt7Min)) when.push({ k: 'Short of goal, 7 nights', v: bs.debt7Min < 5 ? 'None' : f.dur(bs.debt7Min) });

  // The score belongs to the night shown, and to no other.
  const sc = b?.extra?.sleepScore && f.isNum(b.extra.sleepScore.score) && b.extra.sleepScore.date === night.date ? b.extra.sleepScore : null;
  const lead = stat({ size: 'l', value: f.dur(night.asleepMin), context: html`${goalWords ? html`<span>${goalWords}</span>` : ''}${vsAvg}` });

  return mod({
    title: 'Sleep', note: night.date === d.today ? 'Last night' : f.dayRel(night.date), span: 7, link, fam: 'sleep', icon: 'moon', cls: o ? `ord-${o}` : '', tools: aiButton('sleep'),
    body: html`
      ${sc ? html`<div class="sleephead">${lead}${scoreStat(sc)}</div>` : lead}
      ${strip ? html`<div class="part">${figure(strip, { read: hasStages ? 'Taller blocks are deeper sleep.' : '' })}${hasStages ? legend([['sw-deep', 'Deep'], ['sw-rem', 'REM'], ['sw-light', 'Light'], ['sw-awake', 'Awake']]) : ''}</div>` : ''}
      ${hasStages ? facts([stageFact('DEEP', 'Deep'), stageFact('REM', 'REM'), stageFact('LIGHT', 'Light'), stageFact('AWAKE', 'Awake')], { cols: 4, cls: 'facts--s' }) : ''}
      ${when.length ? html`<hr class="rule">${facts(when, { cols: 4, cls: 'facts--s' })}` : ''}
      ${sc?.parts?.length ? html`<hr class="rule">${scoreParts(sc)}` : ''}`,
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

function heart(d, day, b, o) {
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
  // Blood oxygen and temperature live in the vitals row when the brief
  // carries them there; this module stays about the heart.
  const inVitals = new Set((b?.extra?.vitals || []).map((v) => v.id));
  const extra = [];
  const spo = inVitals.has('spo2') ? null : lastRow(d, 'spo2');
  if (spo) extra.push({ k: 'Blood oxygen', v: f.dec1(spo.spo2), u: '%', s: f.isNum(spo.spo2Lo) ? `Asleep, ${f.dec1(spo.spo2Lo)} to ${f.dec1(spo.spo2Hi)}` : 'Average while asleep' });
  const tmp = inVitals.has('skin_temp') ? null : lastRow(d, 'tempDev');
  if (tmp) extra.push({ k: 'Skin temperature', v: f.tempDelta(tmp.tempDev), s: 'Against your own usual, at night' });
  return mod({
    title: 'Heart', span: 5, link: { href: '/trends/heart', text: 'Trends' }, cls: `today-heart ${o ? `ord-${o}` : ''}`, fam: 'heart', icon: 'heart', tools: aiButton('heart'),
    body: html`
      ${tile}
      ${lines.length ? html`<hr class="rule"><div class="lines">${lines}</div>` : ''}
      ${shape}
      ${extra.length ? html`<hr class="rule">${facts(extra, { cols: 2, cls: 'facts--s' })}` : ''}`,
  });
}

/* ── worth knowing, and the week ────────────────────────────── */

function knowing(b, o) {
  const list = (b?.insights || []).slice(0, 5);
  const changes = (b?.changes || []).slice(0, 4);
  if (!list.length && !changes.length) return '';
  return mod({
    title: 'Worth knowing', span: 7, icon: 'idea', cls: o ? `ord-${o}` : '',
    body: html`
      ${changes.length ? html`<div class="part"><p class="sub">Since yesterday</p><ul class="changes">${changes.map((c) => html`<li class="change">${ic(c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'flat', { size: 's' })}<span class="${c.good === true ? 'change--good' : c.good === false ? 'change--bad' : ''}">${c.text}</span></li>`)}</ul></div>` : ''}
      ${changes.length && list.length ? html`<hr class="rule">` : ''}
      ${list.length ? html`<div class="insights">${list.map((i) => insight(i))}</div>` : ''}`,
  });
}

const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const STREAK_FAM = { steps: ['steps', 'steps'], active: ['active', 'bolt'], sleep: ['sleep', 'moon'], workout_weeks: ['workouts', 'strength'] };

function week(d, b, o) {
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
    title: 'This week', span: 5, icon: 'week', cls: o ? `ord-${o}` : '', tools: aiButton('week'), note: wk ? `${f.dayShort(wk.start)} to ${f.dayShort(f.addDays(wk.start, 6))}` : '',
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

/* ── what "all the data" adds: cardio, vitals, water and food, pins ── */

const CARDIO_FROM = {
  'zone minutes': 'Counted from your device\'s zone minutes.',
  'time in heart-rate zones': 'Counted from your time in heart-rate zones; vigorous minutes count double.',
  'active minutes': 'Counted from your device\'s active minutes.',
};

/** This week's cardio minutes against the weekly target, and the seven days. */
function cardio(c, d, { span, o }) {
  const days = c.days || [];
  const todayIdx = days.findIndex((x) => x.date === d.today);
  const left = c.target - c.minutes;
  const prev = (c.weeks || []).at(-2);
  const words = [left > 0 ? `${f.int(left)} min to go this week` : 'Target reached', prev && f.isNum(prev.minutes) ? `last week ${f.int(prev.minutes)} in all` : null].filter(Boolean).join(' · ');
  const part = (x) => [f.isNum(x.moderate) && f.isNum(x.vigorous) ? `${f.int(x.moderate)} moderate, ${f.int(x.vigorous)} vigorous` : null].filter(Boolean).join('');
  const bars = days.some((x) => f.isNum(x.minutes)) ? figure(chart((w) => cats({
    w, h: 104, labels: WD, a: days.map((x) => x.minutes), mark: todayIdx >= 0 ? todayIdx : null, unit: 'min', fmt: f.int,
    reads: days.map((x) => `${f.dow(x.date)}: ${f.isNum(x.minutes) ? `${f.int(x.minutes)} min${part(x) ? ` (${part(x)})` : ''}` : x.date > d.today ? 'still to come' : 'nothing counted'}`),
    label: 'Cardio minutes on each day of this week',
  })), { read: 'Each day of this week, today marked.' }) : '';
  return mod({
    title: 'Weekly cardio', note: days.length ? `${f.dayShort(days[0].date)} to ${f.dayShort(days[days.length - 1].date)}` : '', span, fam: 'active', icon: 'monitor_heart',
    link: { href: '/metric/cardio_week', text: 'Details' }, cls: `today-cardio ord-${o}`,
    body: html`<div class="${span === 12 ? 'split2' : 'today-cardio__b'}">
      <div class="ringrow">
        ${cardioRing({ minutes: c.minutes, target: c.target, fam: 'active', size: 104, stroke: 13 })}
        ${stat({ size: 'l', value: f.int(c.minutes), unit: `of ${f.int(c.target)} min`, context: words })}
      </div>
      ${bars}
    </div>
    <p class="today-own">${CARDIO_FROM[c.source] || ''} Added up by this app against your weekly target.</p>`,
  });
}

/** One vital: badge, value and unit, and where it sits against the usual. */
function vitalItem(v, today) {
  const m = { id: v.id, unit: v.unit, decimals: 1, icon: v.icon };
  const temp = v.id === 'skin_temp';
  const diff = f.isNum(v.usual) ? v.value - v.usual : null;
  let words = temp ? 'Against your own usual, at night'
    : diff === null ? 'Still learning your usual'
      : Math.abs(diff) < 0.05 ? `Right on your usual ${mnum(m, v.usual)}`
        : `${f.dec1(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} your usual ${mnum(m, v.usual)}`;
  if (v.date && today && v.date !== today) words = `${f.dayRel(v.date)} · ${words}`;
  return html`<a class="line line--plain fam fam-${v.family}" href="/metric/${encodeURIComponent(v.id)}">
    <span class="line__k">${ib(metricIcon(m), { size: 's' })}<span>${v.label}</span></span>
    <span class="line__v">${temp ? f.tempDelta(v.value) : html`${mnum(m, v.value)}<span class="stat__u">${unitOf(m)}</span>`}</span>
    <span class="line__c">${words}</span>
  </a>`;
}

function vitals(list, d, { span, o, recovery = null }) {
  return mod({
    title: list.length ? 'Vitals' : 'Recovery trend', note: list.length ? 'Latest readings against your own usual' : '', span, fam: 'vitals', icon: 'pulmonology', cls: `today-vitals ord-${o}`,
    body: html`${list.length ? html`<div class="lines">${list.map((v) => vitalItem(v, d.today))}</div>` : ''}${recoveryLine(recovery)}`,
  });
}

/** Stress, in one quiet line: the watch's level against the usual and
    Body Battery now, or what was logged today. Calculated by the device
    and logged by you are said apart. */
function stressModule(x, d) {
  if (!x) return '';
  const dv = x.device; const bb = x.battery; const lg = x.logged;
  const m = { id: 'stress', unit: 'of 100', decimals: 0, icon: 'gauge' };
  const usual = dv && f.isNum(dv.usual) ? (Math.abs(dv.value - dv.usual) < 3 ? 'about your usual' : `${dv.value > dv.usual ? 'above' : 'below'} your usual ${dv.usual}`) : '';
  const words = [dv ? `${dv.band}${dv.date !== d.today ? `, ${f.dayRel(dv.date).toLowerCase()}` : ' so far'}` : '', usual, bb ? `Body Battery ${Math.round(bb.now)} now` : '', lg ? `you logged ${lg.word.toLowerCase()} at ${f.clock(lg.at)}` : ''].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase());
  return mod({
    title: 'Stress', note: dv || bb ? 'Worked out by your Garmin' : 'As you logged it', span: 12, fam: 'mind', icon: 'gauge', cls: 'today-stress',
    body: html`<div class="lines"><a class="line line--plain fam fam-mind" href="/metric/stress">
      <span class="line__k">${ib(metricIcon(m), { size: 's' })}<span>${dv ? 'Stress level' : bb ? 'Body Battery' : 'Stress'}</span></span>
      <span class="line__v">${dv ? html`${dv.value}<span class="stat__u">of 100</span>` : bb ? html`${Math.round(bb.now)}<span class="stat__u">of 100</span>` : lg.word}</span>
      <span class="line__c">${words}</span>
    </a></div>`,
  });
}

/** Today's water against the goal with one-tap adds, and today's food. */
function nutrition(x, { span, o }) {
  const w = x.water; const fd = x.food;
  const burned = x.calories && f.isNum(x.calories.total) ? x.calories.total : null;
  const water = w ? (() => {
    const has = f.isNum(w.target) && w.target > 0;
    const left = has ? w.target - w.ml : null;
    const words = !has ? html`<span class="muted">No daily goal set</span>` : left > 0 ? `${Math.round((w.ml / w.target) * 100)}% of your goal · ${f.water(left)} to go` : 'Goal reached';
    return html`<div class="nutri__i fam fam-water">
      ${stat({ label: 'Water', value: f.int(f.waterVal(w.ml)), unit: has ? `of ${f.water(w.target)}` : f.waterUnit(), context: words, href: '/metric/water', extra: has ? meter({ value: w.ml, goal: w.target, cls: 'meter--l', label: `${f.water(w.ml)} of ${f.water(w.target)} of water today` }) : '' })}
      <div class="quick" role="group" aria-label="Add water">
        <button type="button" class="btn btn--tonal btn--s" data-water="250">${ic('plus', { size: 's' })}${f.water(250)}</button>
        <button type="button" class="btn btn--tonal btn--s" data-water="500">${ic('plus', { size: 's' })}${f.water(500)}</button>
        <button type="button" class="btn btn--ghost btn--s" data-action="water-other">Other</button>
      </div>
    </div>`;
  })() : '';
  const food = fd ? html`<div class="nutri__i fam fam-nutrition">
      ${stat({ label: 'Food', value: f.int(fd.kcal), unit: 'kcal', href: '/metric/food',
        context: fd.entries ? `Protein ${f.int(fd.protein)} g · carbs ${f.int(fd.carbs)} g · fat ${f.int(fd.fat)} g` : html`<span class="muted">Nothing logged yet today</span>`,
        extra: html`<p class="stat__c nutri__more">${[fd.entries ? f.plural(fd.entries, 'entry', 'entries') : null, burned !== null ? `${f.int(burned)} kcal burned so far today` : null].filter(Boolean).join(' · ')}</p>` })}
      <div class="quick"><button type="button" class="btn btn--tonal btn--s" data-action="add-food">${ic('plus', { size: 's' })}Add food</button></div>
    </div>` : '';
  return mod({
    title: w && fd ? 'Water and food' : w ? 'Water' : 'Food', note: 'What you logged today', span, icon: w ? 'drop' : 'restaurant', cls: `today-food ord-${o}`,
    body: html`<div class="nutri ${w && fd ? 'nutri--2' : ''}">${water}${food}</div>`,
  });
}

/** The metrics the person pinned, as chosen. */
function pins(list, d, { span, o }) {
  return mod({
    title: 'Pinned', span, icon: 'pin', cls: `today-pins ord-${o}`, link: { href: '/trends', text: 'Edit pins' },
    body: html`<ul class="mrows ${span === 12 ? 'mrows--wide' : ''}">${list.map((m) => metricRow(m, { pin: false, today: d.today }))}</ul>`,
  });
}

/**
 * Which of the four extra modules this person has, with their desktop
 * spans: they pair up as 7 + 5 in the order vitals, cardio, water and food,
 * pins; one left over takes the whole row. `first` is the desktop order of
 * the first of them.
 */
function extraPlan(b, { first, recovery = false }) {
  const x = b?.extra;
  if (!x) return [];
  const have = [
    (x.vitals || []).length || (recovery && x.recovery) ? { key: 'vitals', want: 7 } : null,
    x.cardio && f.isNum(x.cardio.minutes) && x.cardio.target > 0 ? { key: 'cardio', want: 5 } : null,
    x.water || x.food ? { key: 'food', want: 7 } : null,
    (x.pinned || []).length ? { key: 'pins', want: 5 } : null,
  ].filter(Boolean);
  for (let i = 0; i < have.length; i += 2) {
    const a = have[i]; const c = have[i + 1];
    if (!c) { a.span = 12; break; }
    if (a.want >= c.want) { a.span = 7; c.span = 5; } else { a.span = 5; c.span = 7; }
  }
  have.forEach((h, i) => { h.o = first ? first + i : 0; });
  return have;
}

function extraModule(p, d, b, { recovery = false } = {}) {
  const x = b.extra;
  if (p.key === 'vitals') return vitals(x.vitals || [], d, { ...p, recovery: recovery ? x.recovery : null });
  if (p.key === 'cardio') return cardio(x.cardio, d, p);
  if (p.key === 'food') return nutrition(x, p);
  return pins(x.pinned, d, p);
}

/* ── footer: device, sync, live control ─────────────────────── */

/** The tracker's battery, readable in one look: a cell that fills, the
    number, the device's name. Its own element, near the top of the page. */
function batteryPill(d) {
  // Two trackers (two Google accounts): a pill each.
  const many = (d?.devices || []).filter((x) => f.isNum(x.battery));
  if (many.length > 1) return html`<div class="batts">${many.map((x) => onePill(x))}</div>`;
  return onePill(d?.device || app.me.device);
}
function onePill(dev) {
  if (!dev || !f.isNum(dev.battery)) return '';
  const pct = Math.max(0, Math.min(100, Math.round(dev.battery)));
  const tone = pct <= 20 ? 'bad' : pct <= 40 ? 'warn' : 'ok';
  const name = dev.name || 'Tracker';
  return html`<div class="batt batt--${tone}" role="img" aria-label="${name} battery ${pct}%${pct <= 20 ? ', low' : ''}">
    <span class="batt__cell" aria-hidden="true"><i style="width:${Math.max(8, pct)}%"></i></span>
    <b class="batt__pct">${pct}%</b>
    <span class="batt__name">${name}${pct <= 20 ? ' · charge soon' : ''}</span>
  </div>`;
}

/** Sync is not something to act on: one quiet line under the date. */
function syncText() {
  const me = app.me;
  const gOk = me.google?.state === 'ok';
  if (!gOk && !me.garmin?.connected) return '';
  const t = Math.max(gOk ? me.sync?.lastOk || 0 : 0, me.garmin?.connected ? me.garmin.lastSync || 0 : 0) || null;
  return me.sync?.running || app.syncing ? 'Syncing now' : t ? `Synced ${f.ago(t)}${me.garmin?.connected && !gOk ? ' from Garmin' : ''}` : 'Not synced yet';
}

function notConnected() {
  return html`<div class="group"><div class="empty">
    <span class="empty__ic">${ic('link')}</span>
    <p class="empty__t">Your day appears here</p>
    <p class="empty__d">Once Google Health, a Garmin or a Samsung Galaxy Watch is connected: what kind of day it is, steps against your usual, last night's sleep in stages, your heart, and the week so far.</p>
    <div class="btnrow" data-style="justify-content:center"><a class="btn btn--tonal btn--s" href="/settings/connections">${ic('link', { size: 's' })}Connect one</a><a class="btn btn--tonal btn--s" href="/settings/connections/devices/tracker/samsung">Samsung Health</a></div>
  </div></div>`;
}


/* ── the first screen: tiles (2026-10-31 redesign) ─────────────
   On waking: time asleep and the sleep score, readiness and resilience;
   then steps, calories, weekly cardio and live heart rate; then the
   running or just-ended workout (Me can move that to Train). Every tile
   opens its own page. Everything else Today used to show sits below. */

/** Where the workout card lives: 'today' (default) or 'train'. */
export function workoutCardOn() { try { return localStorage.getItem('health.wcard') === 'train' ? 'train' : 'today'; } catch { return 'today'; } }

/** A ring with a track: `pct` 0..100 of the way round. */
export function tring(pct, { size = 40, sw = 4, inner = '' } = {}) {
  const r = size / 2 - sw / 2; const c = size / 2;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return html`<span class="tring fill" style="width:${size / 16}rem;height:${size / 16}rem"><svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="trk" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}"/><circle class="val" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}" pathLength="100" stroke-dasharray="${p.toFixed(1)} 100" transform="rotate(-90 ${c} ${c})"/></svg>${inner ? html`<span class="tring__in">${inner}</span>` : ''}</span>`;
}

/** 437 → 7 h 17 m, as big numbers with small units. */
function hm(min) {
  const h = Math.floor(min / 60); const m = Math.round(min % 60);
  return html`<span data-count>${h}</span><span class="u">h</span>&thinsp;<span data-count>${String(m)}</span><span class="u">m</span>`;
}

function sleepTile(d, b) {
  const night = d.sleep?.lastNight;
  const goal = d.activity?.sleepTarget || app.me.goals?.sleepMinutes || 450;
  const sc = d.scores && f.isNum(d.scores.sleep) ? d.scores.sleep
    : b?.extra?.sleepScore && f.isNum(b.extra.sleepScore.score) && b.extra.sleepScore.date === night?.date ? b.extra.sleepScore.score : null;
  const est = !(d.scores && f.isNum(d.scores.sleep)) && Boolean(b?.extra?.sleepScore?.estimated);
  const band = (d.scores && f.isNum(d.scores.sleep) && d.scores.sleepBand) || (sc === null ? '' : sc >= 90 ? 'Excellent' : sc >= 80 ? 'Good' : sc >= 60 ? 'Fair' : 'Poor');
  if (!night || !f.isNum(night.asleepMin)) {
    return html`<a class="bt bt--sleep bt--wide bt-sleep bt-sleep--none" href="/trends/sleep">
      <div class="bt-sleep__l">
        <div class="bt__row"><span class="bt__lab">${ic('bed')}Sleep</span></div>
        <div><p class="n n-m">No sleep yet</p><p class="bt__sub">Wear your tracker to bed and last night shows up here in the morning.</p></div>
      </div>
    </a>`;
  }
  const pct = Math.round((night.asleepMin / goal) * 100);
  const short = goal - night.asleepMin;
  const goalText = pct >= 100 ? `Goal of ${f.dur(goal)} reached${short < -20 ? `, ${f.dur(-short)} over` : ''}` : `${pct} % of your ${f.dur(goal)} goal`;
  const when = f.isNum(night.startMs) && f.isNum(night.endMs) ? `${f.clock(night.startMs)} – ${f.clock(night.endMs)}` : '';
  // Not last night's (no sleep tracked since): the day it ended, before the times.
  const ago = old(d, night.date);
  return html`<a class="bt bt--sleep bt--wide bt-sleep" href="/sleep" aria-label="Sleep${ago ? ` (${ago})` : ''}: ${f.dur(night.asleepMin)} asleep${when ? `, ${when}` : ''}. ${goalText}.${sc !== null ? ` Sleep score ${sc}, ${band}${est ? ', estimated: no sleep stages were recorded' : ''}.` : ' No sleep score: no sleep stages were recorded.'}">
    <div class="bt-sleep__l">
      <div class="bt__row"><span class="bt__lab">${ic('bed')}Sleep</span>${ago || when ? html`<span class="bt__meta${ago ? ' bt__meta--day' : ''}">${ago ? html`<b>${ago}</b>` : ''}${when ? html`<span>${when}</span>` : ''}</span>` : ''}</div>
      <div>
        <p class="n n-hero">${hm(night.asleepMin)}</p>
        <span class="tbar fillbar"><i style="width:${Math.min(100, pct)}%"></i></span>
        <p class="bt__sub">${goalText}</p>
      </div>
    </div>
    ${sc !== null ? tring(sc, { size: 104, sw: 8, inner: html`<b class="n" data-count>${sc}</b><span>${band}${est ? ' · est.' : ''}</span>` })
    : tring(0, { size: 104, sw: 8, inner: html`<b class="n">–</b><span>No score</span>` })}
  </a>`;
}

/* After midnight, until tonight's sleep arrives, readiness and resilience
   are yesterday's (Google's are too): said so, quietly. */
const old = (d, day = d.scores?.date) => (day && d.today && day !== d.today ? f.dayRel(day) : '');

function readinessTile(d) {
  const sc = d.scores || {};
  const v = f.isNum(sc.ready) ? sc.ready : null;
  const band = sc.readyBand || '';
  const cls = band === 'High' ? 'band-high' : band === 'Low' ? 'band-low' : 'band-mid';
  return html`<a class="bt bt--plain bt-ready" href="/metric/readiness">
    <div class="bt__row"><span class="bt__lab">Readiness</span>
      <svg class="gauge" viewBox="0 0 44 26" aria-hidden="true"><path class="trk" d="M4 23a18 18 0 0 1 36 0" pathLength="100"/><path class="val fill-g" d="M4 23a18 18 0 0 1 36 0" pathLength="100" stroke-dasharray="${v ?? 0} 100"/></svg></div>
    ${v !== null ? html`<div><p class="bt__line"><span class="n n-l" data-count>${v}</span><span class="bt__state ${cls}">${band}</span></p>${old(d) ? html`<p class="bt__old">${old(d)}</p>` : ''}</div>`
      : html`<div><p class="bt__word">Learning</p><p class="bt__sub">Needs a week of nights</p></div>`}
  </a>`;
}

const RESIL = { Low: ['lvl-low', 'trend_down', 0], Balanced: ['lvl-bal', 'balance', 1], Optimal: ['lvl-opt', 'bolt', 2] };
function resilienceTile(d) {
  const label = d.scores?.resilLabel || null;
  const [cls, icon, idx] = RESIL[label] || ['', 'balance', -1];
  return html`<a class="bt bt--plain bt-resil" href="/metric/resilience" aria-label="Resilience: ${label || 'not yet'}">
    <div class="bt__row"><span class="bt__lab">Resilience</span><span class="${cls}">${ic(icon, { size: '' })}</span></div>
    ${label ? html`<div><p class="bt__word">${label}</p>${old(d, d.scores.resilDate) ? html`<p class="bt__old">${old(d, d.scores.resilDate)}</p>` : ''}</div>` : html`<div><p class="bt__word">Not yet</p><p class="bt__sub">Needs a few worn days</p></div>`}
    <span class="scale3 ${cls}" aria-hidden="true">${[0, 1, 2].map((i) => html`<i class="${i === idx ? 'on' : ''}"></i>`)}</span>
  </a>`;
}

function smallTile({ fam, icon, label, href, value, unit = '', sub, pct }) {
  return html`<a class="bt bt--${fam} bt-small" href="${href}">
    <div class="bt__row"><span class="bt__lab">${ic(icon)}${label}</span>${pct !== null && pct !== undefined ? tring(pct) : ''}</div>
    <div><p class="n n-m"><span data-count>${value}</span>${unit ? html`<span class="u">${unit}</span>` : ''}</p><p class="bt__sub">${sub}</p></div>
  </a>`;
}

function activityTiles(d, b) {
  const act = d.activity?.today || {};
  const goal = d.activity?.stepTarget || app.me.goals?.steps || 8000;
  const out = [];
  if (cap('steps') || f.isNum(act.steps)) {
    out.push(smallTile({ fam: 'steps', icon: 'steps', label: 'Steps', href: '/metric/steps', value: f.int(act.steps || 0), sub: `of ${f.int(goal)}`, pct: ((act.steps || 0) / goal) * 100 }));
  }
  const c = b?.extra?.calories;
  const kcal = c && f.isNum(c.total) ? c.total : act.kcal;
  const usual = c?.usual?.total ?? b?.metrics?.kcal?.usual;
  if (f.isNum(kcal) || cap('calories')) {
    out.push(smallTile({ fam: 'energy', icon: 'flame', label: 'Calories', href: '/metric/calories', value: f.int(kcal || 0), unit: 'kcal', sub: f.isNum(usual) ? `usual ${f.int(usual)} by tonight` : 'burned so far', pct: f.isNum(usual) ? ((kcal || 0) / usual) * 100 : null }));
  }
  const cw = b?.extra?.cardio;
  if (cw && f.isNum(cw.minutes) && cw.target > 0) {
    out.push(smallTile({ fam: 'active', icon: 'timer', label: 'Cardio', href: '/metric/cardio_week', value: f.int(cw.minutes), unit: 'min', sub: `of ${f.int(cw.target)} this week`, pct: (cw.minutes / cw.target) * 100 }));
  } else if (f.isNum(act.activeMinutes)) {
    const ag = d.activity?.azmTarget || app.me.goals?.activeMinutes || 22;
    out.push(smallTile({ fam: 'active', icon: 'timer', label: 'Active', href: '/metric/active_minutes', value: f.int(act.activeMinutes), unit: 'min', sub: `of ${f.int(ag)} today`, pct: (act.activeMinutes / ag) * 100 }));
  }
  const rhrRow = lastRow(d, 'rhr');
  const synced = d.hr ? { v: `${Math.round(d.hr.bpm)}<span class="u">bpm</span>`, s: `latest, ${f.ago(d.hr.t)}` }
    : rhrRow ? { v: `${Math.round(rhrRow.rhr)}<span class="u">bpm</span>`, s: 'resting' } : null;
  if (d.hr || rhrRow || cap('heartRate')) out.push(heartBento({ synced }));
  return out;
}

/** The running workout, or the one question waiting about a workout. */
function workoutSlot(wk) {
  const r = wk?.running;
  if (r) {
    const name = r.title && r.title !== 'Workout' ? r.title : 'Workout';
    const prog = r.sets?.exercises ? ` · ${f.plural(r.sets.exercises, 'exercise')}${r.sets.sets ? `, ${f.plural(r.sets.sets, 'set')}` : ''}` : '';
    return html`<section class="wcard" data-wid="${r.id}" aria-label="Workout in progress">
      <span class="wcard__ic">${ic('dumbbell')}</span>
      <div style="min-width:0">
        <p class="wcard__name"><span class="wcard__dot"></span>${name}<span>${prog}</span></p>
        <p class="wcard__time"><span class="n" data-timer="${r.start}" role="timer" aria-live="off">${f.stopwatch(Date.now() - r.start)}</span><span class="wcard__hr" data-live-bpm></span></p>
      </div>
      <div class="wcard__btns">
        ${r.logging ? html`<a class="pill-btn pill-btn--ghost" href="/workouts/${encodeURIComponent(r.id)}">Open</a>` : ''}
        <button type="button" class="pill-btn pill-btn--light" data-wact="end">Finish</button>
      </div>
    </section>`;
  }
  const w = wk?.pending?.[0];
  if (!w) return '';
  const end = w.end ?? w.lastEnd;
  const day = f.instDay(w.start) !== f.today() ? f.dayRel(f.instDay(w.start)) : 'Today';
  const q = w.status === 'ongoing' ? `Workout started at ${f.clock(w.start)}?` : `Was ${f.clock(w.start)} to ${f.clock(end)} a workout?`;
  return html`<section class="wask" data-wid="${w.id}" aria-label="Question about a workout">
    <div><p class="wask__k">${day}</p><p class="wask__q">${q}</p></div>
    <div class="wcard__btns">
      <button type="button" class="pill-btn pill-btn--ink" data-wact="${w.status === 'ongoing' ? 'confirm' : 'save'}">Yes</button>
      <button type="button" class="pill-btn pill-btn--soft" data-wact="dismiss">No</button>
    </div>
  </section>`;
}

function bento(d, b, wk) {
  const wslot = workoutCardOn() === 'today' || !wk?.running ? workoutSlot(workoutCardOn() === 'today' ? wk : { pending: wk?.pending }) : '';
  return html`<div class="bento bento--today">
    ${sleepTile(d, b)}
    ${readinessTile(d)}
    ${resilienceTile(d)}
    ${activityTiles(d, b)}
    ${wslot}
  </div>`;
}

/** What the note under the title says when there is no AI summary. */
function noteFallback(d, b) {
  const i = (b?.insights || [])[0];
  if (i?.text) return { lead: i.title || '', text: i.text };
  const rd = d.readiness;
  if (rd?.label && rd.text) return { lead: `${rd.label}.`, text: rd.text };
  return null;
}


/* ── "More about today": one calm row each, the whole thing in a sheet ── */

/** The rows below the tiles: a family icon, a title, one line, a chevron.
    Tapping one opens what used to be its full card, in a sheet. */
function moreRows(d, b, { full, plan }) {
  const rows = [];
  const add = (key, icon, fam, title, text, body) => { if (body) rows.push({ key, icon, fam, title, text, body }); };
  const rd = d.readiness;
  if (full) add('readiness', 'gauge', 'recovery', 'Readiness', [rd.label, (rd.text || '').replace(/:\s*[^:]*$/, '')].filter(Boolean).join(' · '), verdict(d, b, 0));
  const x = b?.extra || {};
  for (const p of plan) {
    if (p.key === 'vitals') {
      const v = x.vitals || [];
      const off = v.filter((i) => f.isNum(i.usual) && Math.abs(i.value - i.usual) >= (i.id === 'skin_temp' ? 0.5 : 1));
      add('vitals', 'pulse', 'vitals', v.length ? 'Vitals' : 'Recovery trend', v.length ? (off.length ? `${off.map((i) => i.label).join(', ')} off your usual` : `All ${v.length} usual`) : (x.recovery?.label ? `Over 7 days: ${x.recovery.label}` : ''), extraModule(p, d, b, { recovery: !full }));
    } else if (p.key === 'food') {
      const w = x.water; const fd = x.food;
      add('food', 'glass', 'water', w && fd ? 'Water and food' : w ? 'Water' : 'Food', [w ? `${f.water(w.ml)}${f.isNum(w.target) ? ` of ${f.water(w.target)}` : ''}` : '', fd ? `${f.int(fd.kcal)} kcal eaten` : ''].filter(Boolean).join(' · '), extraModule(p, d, b));
    } else if (p.key === 'pins') {
      add('pins', 'pin', '', 'Pinned', `${f.plural(x.pinned.length, 'metric')} you chose`, extraModule(p, d, b));
    }
  }
  const s = x.stress;
  if (s) add('stress', 'gauge', 'mind', 'Stress', s.device ? `${s.device.band} · ${s.device.value} of 100` : s.battery ? `Body Battery ${Math.round(s.battery.now)}` : s.logged ? `You logged ${s.logged.word.toLowerCase()}` : '', stressModule(s, d));
  const ins = b?.insights || [];
  if (ins.length || (b?.changes || []).length) add('knowing', 'idea', '', 'Worth knowing', ins[0]?.title || ins[0]?.text || (b.changes[0]?.text ?? ''), knowing(b));
  const wkT = b?.week?.totals?.steps;
  if (b?.week || (b?.streaks || []).length) add('week', 'calendar', 'steps', 'This week', f.isNum(wkT?.value) ? `${f.int(wkT.value)} steps${f.isNum(wkT.deltaPct) ? `, ${wkT.deltaPct >= 0 ? '+' : '−'}${Math.abs(Math.round(wkT.deltaPct))}% on last week` : ''}` : 'Days, totals and streaks', week(d, b));
  const devs = (d.devices || []).filter((v) => f.isNum(v.battery));
  const one = d.device || app.me.device;
  const list = devs.length ? devs : one && f.isNum(one.battery) ? [one] : [];
  if (list.length) add('devices', 'battery', '', list.length > 1 ? 'Devices' : (list[0].name || 'Tracker'), list.map((v) => `${list.length > 1 ? `${v.name || 'Tracker'} ` : 'Battery '}${Math.round(v.battery)}%`).join(' · '), batteryPill(d));
  const miss = (b?.missing || app.me.capsMeta?.missing || []).filter((m) => m?.text);
  if (miss.length) add('missing', 'info', '', 'Not on your device', `${f.plural(miss.length, 'kind')} of data need another device`, html`<ul class="more-miss">${miss.map((m) => html`<li>${m.text}</li>`)}</ul>`);
  return rows;
}

function moreList(rows) {
  if (!rows.length) return '';
  return html`<div class="blist more-list">${rows.map((r) => html`<button type="button" class="mrow ${r.fam ? `fam fam-${r.fam}` : ''}" data-more="${r.key}">
    <span class="mrow__ic">${ic(r.icon)}</span>
    <span class="mrow__b"><span class="mrow__t">${r.title}</span>${r.text ? html`<span class="mrow__d">${r.text}</span>` : ''}</span>
    ${ic('right', { size: 's' })}
  </button>`)}</div>`;
}

export default async function today(ctx) {
  const { root } = ctx;
  document.title = 'Today · Health';
  let data = null; let brief = null; let day = null; let wk = null; let stopTimers = null;
  let painted = false; let lastPlan = []; let morningNode = null; let moreNow = []; let moreBuild = () => [];

  const syncBtn = () => html`<button type="button" class="iconbtn ${app.syncing ? 'is-busy' : ''}" data-action="sync" aria-label="Sync now" title="Sync now">${ic('refresh')}</button>`;

  function paint() {
    const me = app.me;
    const d = data; const b = brief;
    const g = me.google?.state;
    const pending = wk?.pending || [];
    const has = d && d.connected !== false ? !d.empty : d && !d.empty;
    const full = has && d.readiness && d.readiness.level !== 'unavailable';
    const st = syncText();

    // Below the tiles: what Today used to scroll through, minus what the
    // tiles now open (sleep, activity, heart, cardio have their own pages).
    const plan = has ? extraPlan(b, { first: 0, recovery: !full }).filter((p) => p.key !== 'cardio') : [];
    plan.forEach((p) => { p.span = 12; });
    moreBuild = () => (has ? moreRows(d, b, { full, plan }) : []);
    moreNow = moreBuild();
    const lowBatt = (d?.devices || [d?.device || me.device]).filter((x) => x && f.isNum(x.battery) && x.battery <= 20);

    lastPlan = plan;
    const y = window.scrollY;
    mount(root, html`
      ${head({ kick: f.dayLong(d?.today || f.today()), title: 'Today' })}
      <div data-ai-morning></div>
      ${connectionBanner('/')}
      ${d?.illness?.flag ? banner({ tone: 'warn', iconName: 'temp', title: 'Your body looks under strain', text: d.illness.text || (d.illness.reasons || []).join(', ') }) : ''}
      ${lowBatt.length ? banner({ tone: 'warn', iconName: 'battery', title: `${lowBatt[0].name || 'Your tracker'} is at ${Math.round(lowBatt[0].battery)}%`, text: 'Charge it soon so tonight\'s sleep is recorded.' }) : ''}
      ${!d || (!d.connected && d.empty) ? notConnected()
        : d.empty && me.sync?.lastError?.code === 'not_linked' ? banner({ tone: 'warn', iconName: 'alert', title: 'No Google Health data on this account', text: `${me.google?.email ? `${me.google.email} is` : 'The Google account you connected is'} not the one your Fitbit or Google Health app uses, so there is nothing to read. In the Google Health app, check which account it is signed in with, then connect that one here.`, actions: html`<button type="button" class="btn btn--s" data-action="connect-google" data-account="pick" data-return="/">Connect another account</button><a class="btn btn--tonal btn--s" href="/settings/connections/devices/tracker/samsung">I use Samsung Health</a>` })
        : d.empty ? html`${banner({ tone: 'accent', iconName: 'refresh', title: 'The first sync is running', text: `Your history is being fetched from ${me.garmin?.connected && g !== 'ok' ? 'Garmin' : 'Google Health'}. This page fills in by itself, usually within a minute.` })}${skeleton('today')}`
        : html`${bento(d, b, wk)}
          ${pending.slice(workoutCardOn() === 'today' || !wk?.running ? 1 : 0).map((w) => askCard(w))}
          <section class="more-today" aria-label="More about today">
            <div class="more-today__h"><h2>More about today</h2><span class="muted small">${st}</span></div>
            ${moreList(moreNow)}
          </section>`}
      ${g === 'ok' ? missingScopes('/') : ''}`);

    stopTimers?.();
    stopTimers = runTimers(root);
    paintLive(root);
    // The morning note: kept across repaints, fetched once.
    const am = root.querySelector('[data-ai-morning]');
    if (am) {
      // Put back as it is: no entrance animation the second time round.
      if (morningNode) { morningNode.classList.remove('rise'); morningNode.querySelectorAll('.rise').forEach((x) => x.classList.remove('rise')); am.replaceWith(morningNode); } else { morningNode = am; morningNote(am, { alive: ctx.alive, fallback: noteFallback(d || {}, b) }); }
    }
    if (painted && y > 0) window.scrollTo(0, y);
    painted = true;
  }

  /* After something was logged from here: fetch the brief again and swap
     only the modules it changes (water and food, the pins), in place. */
  async function refreshLogged() {
    let b;
    try { b = await api.get('/api/brief'); } catch { return; }
    if (!ctx.alive() || !data) return;
    brief = b;
    paint();
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

  const sig = () => JSON.stringify([data, brief, wk]);

  async function reload({ quiet = true, force = true } = {}) {
    try {
      const before = sig();
      await load();
      // The same numbers again (an echo of something logged from this page): nothing to redraw.
      if (ctx.alive() && (force || sig() !== before)) paint();
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

  on(root, 'click', '[data-more]', (e, btn) => {
    // Built afresh: closing any sheet forgets charts that are not on screen,
    // so a body made at paint time can open with its chart gone.
    const r = moreBuild().find((x) => x.key === btn.dataset.more);
    if (!r) return;
    const s = sheet({ title: r.title, body: html`<div class="more-sheet">${r.body}</div>` });
    bindNutrition(s.el, () => s.close());
  });
  on(root, 'click', '[data-action="sync"]', (e, btn) => sync(btn));
  on(root, 'click', '[data-action="start"]', (e, btn) => startWorkout(btn, (payload) => { wk = payload; paint(); }));
  on(root, 'click', '[data-action="retry"]', () => first());
  /** Water and food buttons, on the page or in a "More" sheet. */
  function bindNutrition(el, done = null) {
    on(el, 'click', '[data-water]', async (e, btn) => {
      if (btn.disabled) return;
      const ml = Number(btn.dataset.water);
      const all = el.querySelectorAll('[data-water]');
      for (const x of all) x.disabled = true;
      btn.classList.add('is-busy');
      const r = await quickAdd({ route: '/api/entries', kind: 'water' }, { label: f.water(ml), fields: { ml } }, { label: `${f.water(ml)} of water` });
      btn.classList.remove('is-busy');
      for (const x of all) x.disabled = false;
      if (r && ctx.alive()) { await refreshLogged(); done?.(); }
    });
    on(el, 'click', '[data-action="water-other"]', () => { done?.(); addEntry('water', { onSaved: () => { if (ctx.alive()) refreshLogged(); } }); });
    on(el, 'click', '[data-action="add-food"]', () => { done?.(); addEntry('food', { onSaved: () => { if (ctx.alive()) refreshLogged(); } }); });
  }
  bindNutrition(root);
  bindWorkoutActions(root, {
    find: (id) => (wk?.running?.id === id ? wk.running : wk?.pending?.find((w) => w.id === id)),
    done: (payload) => { wk = payload; paint(); reload(); },
  });

  ctx.onLeave(listen('changed', (what) => { if (what.includes('data') || what.includes('workouts') || what.includes('me')) reload({ force: what.includes('workouts') || what.includes('me') }); }));
  ctx.onLeave(listen('sync', () => { if (ctx.alive() && data) paint(); }));
  ctx.onLeave(() => stopTimers?.());
  ctx.onLeave(bindLive(root));
  ctx.onRefresh(() => (app.me.google?.state === 'ok' || app.me.garmin?.connected ? sync(null) : reload({ quiet: false })));

  // Returning from Google's consent screen.
  const gq = ctx.query.get('google');
  if (gq) {
    history.replaceState(history.state, '', '/');
    const grant = groupGrantToast(gq);
    if (grant) toast(grant.text, { tone: grant.tone, ms: 7000 });
    else if (gq === 'connected') toast('Google connected. The first sync has started.');
    else if (gq === 'cancelled') toast('Google was not connected. You can try again any time.');
    else toast(ctx.query.get('message') || 'Google could not be connected. Try again.', { tone: 'bad' });
  }

  async function first() {
    mount(root, html`${head({ kick: f.dayLong(f.today()), title: 'Today' })}${skeleton('today')}`);
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
