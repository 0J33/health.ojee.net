/* ============================================================
   health.ojee.net — AI summaries and questions, where they help.

   Three ways in:
     a section's "Ask AI"   a summary of that part (last night, readiness,
                            today's activity, a workout, a metric, the
                            week) with follow-up questions to tap
     a question             anything, with the conversation so far
     the morning summary    once a day, after waking, of the night just
                            had and what it means for the day

   What the model gets is the whole point. Every request carries the same
   briefing, built here from the person's own store and labelled with
   dates so nothing is guessed: the time now and what part of the day it
   is; today so far; last night; each of the last 7 days; 30- and 90-day
   averages, the person's baselines and the direction of each trend;
   recent workouts; goals; their notes. Then the detail of the part asked
   about (a workout's sets, a route's splits, a metric's 30 days). The
   instructions say what to look at for that part and how to answer, as
   JSON the page can lay out. Only numbers the app holds go in, never raw
   samples; the model is told to say when something is missing rather
   than invent it.

   A request is a job: it starts at once, the page follows its steps
   (reading, asking a model, writing) and gets the answer when it is
   there. The free models are tried in turn (core/writer.js); answers are
   kept a while so opening the same thing again is instant.
   ============================================================ */

import { addDays, today as todayIn, utcOffsetSec, round } from './core/util.js';
import { readyBand, resilLabel, sleepBand, sleepScoreOf } from './core/scores.js';
import { unified, sessionType, typeLabel } from './history.js';
import { sleepTiming, recoveryDrivers } from './aianalysis.js';
import { metricById, valueText } from './catalog.js';
import { analyse, ageAt, FIELDS as COMP_FIELDS } from './core/bodycomp.js';
import { bodyPerson, sampleText } from './browse.js';

/* What the AI may read is the person's choice (consent.js): each daily key belongs to one kind,
   and a kind they did not allow is left out of the briefing altogether. Nothing read from Strava
   ever goes in (Strava's API agreement), and neither does the person's name. */
const KIND_OF = {
  steps: 'activity', azm: 'activity', active_min: 'activity', cardio_min: 'activity', kcal: 'activity', kcal_active: 'activity', kcal_basal: 'activity', distance_m: 'activity', floors: 'activity',
  altitude_m: 'activity', sedentary_min: 'activity', level_light: 'activity', level_moderate: 'activity', level_very: 'activity', swim_strokes: 'activity',
  sleep_min: 'sleep', sleep_score: 'sleep', sleep_efficiency: 'sleep',
  readiness: 'heart', resilience: 'heart', rhr: 'heart', hrv: 'heart', spo2: 'spo2', resp: 'heart', temp_dev: 'heart', stress: 'heart', stress_high: 'heart', bb_high: 'heart', bb_low: 'heart', vo2max: 'heart',
  vo2max_run: 'heart', hr_avg: 'heart', hr_min: 'heart', hr_max: 'heart', zone_light: 'heart', zone_moderate: 'heart', zone_vigorous: 'heart', zone_peak: 'heart',
  weight_kg: 'body', body_fat: 'bodycomp',
};
const kindOfKey = (k) => (KIND_OF[k] === 'spo2' ? 'heart' : KIND_OF[k] || 'activity');
const allowAll = { activity: true, sleep: true, heart: true, body: true, bodycomp: true, workouts: true, logged: true, notes: true,
  nutrition: true, mood: true, cycle: true, symptoms: true, vitals: true, ecg: true };
/** A workout the AI may be told about: not one from Strava. */
export const aiWorkoutOk = (w) => !!w && w.source !== 'strava';

const DAY = 86_400_000;
const fin = Number.isFinite;
const avg = (v) => { const x = v.filter(fin); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null; };
const r = (x, p = 0) => (fin(x) ? round(x, p) : null);
const hm = (min) => (fin(min) ? `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}m` : '-');
const clock = (t, off) => { const d = new Date(t + (off || 0) * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const wd = (date) => WD[new Date(`${date}T12:00:00Z`).getUTCDay()];

export const TOPICS = {
  morning: 'Good morning: last night, and what it means for today',
  sleep: 'Last night\'s sleep',
  readiness: 'Recovery and load balance',
  activity: 'Today\'s activity',
  heart: 'Heart',
  week: 'This week',
  workout: 'This workout',
  metric: 'This metric',
  ask: 'Your question',
};

/** What to look at, per topic. */
const FOCUS = {
  morning: 'The morning note. One line on how the night went and the main reason (short, late, restless, or good), then what it means for today: push, train normally, or keep it easy, with one concrete suggestion. If the night is still going on or has not synced, say so and give a plan for the day from the days before.',
  sleep: 'Their sleep. When the detail section names a particular night, the question is about that night, not last night: judge it against the nights around it. Otherwise: the one thing that most shaped last night (time asleep against their goal, a late bedtime, waking in the night), whether this week is better or worse than their usual, and one change for tonight. If last night is not there, see the notes in the data before saying anything about it.',
  readiness: 'Their Recovery and Load balance today. Recovery (0-100: today\'s HRV, resting heart rate, last night\'s sleep and skin temperature against their own 30 days) says whether today is a day to push; say whether it is above or below their usual and the likely cause in their data (sleep, a hard session, a busy week). Load balance (0-100: this week\'s training load against their last four weeks, and how HRV and resting heart rate kept up; under 55 low, 55-79 balanced, 80+ optimal) says whether the week\'s training is too much, about right or too little. Then what kind of day that suggests (hard, normal, easy, rest), concretely.',
  activity: 'Today so far against the time of day and their usual for this weekday: on track or behind, and the simplest way to round the day off (a walk of so many minutes, a short session). In the early morning, today has barely started: talk about yesterday and the plan instead.',
  heart: 'Their heart data: whether resting heart rate and HRV are moving the right way over the last weeks and what usually moves them (sleep, training, stress, illness), what the trend means, and one thing that would help.',
  week: 'This week against last week and their usual: the best part, the weakest part, and the one change that would most improve next week.',
  workout: 'The workout in the detail section: how hard it was for them (against their recent similar sessions), what went well, and one specific thing to change next time (weight, reps, pace, rest). If it was noticed by the app or overlaps another, say so before judging it.',
  metric: 'The metric in the detail section: what it means in plain words, where it is now against their usual, the direction over the last weeks and the likely reason in their data, and one thing that moves it.',
  ask: 'Answer their question directly first, from their data, then add the one thing that would help. If the data cannot answer it, say what is missing and give the best general advice.',
};

/* ── the briefing ──────────────────────────────────────────────────── */

const KEYS = [
  ['steps', 'steps'], ['distance_m', 'distance km'], ['floors', 'floors'], ['azm', 'active zone min'], ['active_min', 'active min'], ['cardio_min', 'cardio min'], ['kcal', 'kcal'], ['kcal_active', 'active kcal'],
  ['sleep_min', 'asleep'], ['sleep_score', 'sleep quality'], ['readiness', 'recovery'], ['resilience', 'load balance'],
  ['kcal_basal', 'resting kcal'], ['sedentary_min', 'sedentary min'], ['level_light', 'lightly active min'], ['level_moderate', 'moderately active min'], ['level_very', 'very active min'],
  ['altitude_m', 'climb m'], ['swim_strokes', 'swim strokes'], ['sleep_efficiency', 'sleep efficiency %'],
  ['rhr', 'resting HR'], ['hr_avg', 'avg HR'], ['hr_min', 'min HR'], ['hr_max', 'max HR'],
  ['zone_light', 'light zone min'], ['zone_moderate', 'moderate zone min'], ['zone_vigorous', 'vigorous zone min'], ['zone_peak', 'peak zone min'],
  ['hrv', 'HRV ms'], ['spo2', 'SpO2 %'], ['resp', 'breaths/min'], ['temp_dev', 'sleep temp dev C'], ['vo2max', 'VO2 max ml/kg/min'], ['vo2max_run', 'running VO2 max'],
  ['weight_kg', 'weight kg'], ['body_fat', 'body fat %'],
  // From a Garmin watch: its all-day stress (0-100, 25 and under is rest) and Body Battery.
  ['stress', 'Garmin stress 0-100'], ['stress_high', 'min of high stress'], ['bb_high', 'Body Battery high'], ['bb_low', 'Body Battery low'],
];

function line(row, keys = KEYS) {
  return keys.map(([k, label]) => {
    const v = row?.[k];
    if (!fin(v)) return null;
    if (k === 'sleep_min') return `${label} ${hm(v)}`;
    if (k === 'readiness') return `${label} ${v} (${readyBand(v)})`;
    if (k === 'resilience') return `${label} ${v} (${resilLabel(v)})`;
    if (k === 'distance_m') return `${label} ${r(v / 1000, 1)}`;
    if (k === 'sleep_score') return `${label} ${v} (${sleepBand(v)})`;
    return `${label} ${r(v, Math.abs(v) < 10 ? 1 : 0)}`;
  }).filter(Boolean).join(', ');
}

function stat(table, key, from, to) {
  const v = []; for (let d = from; d <= to; d = addDays(d, 1)) { const x = table[d]?.[key]; if (fin(x)) v.push(x); }
  return { mean: avg(v), n: v.length };
}

/** A week-on-week direction of a key over the last 4 weeks: "rising 3/wk", "flat". */
function trend(table, key, today) {
  const pts = [];
  for (let i = 0; i < 28; i += 1) { const d = addDays(today, -i); if (fin(table[d]?.[key])) pts.push([-i, table[d][key]]); }
  if (pts.length < 8) return null;
  const mx = avg(pts.map((p) => p[0])); const my = avg(pts.map((p) => p[1]));
  const sl = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const wk = sl * 7;
  const sd = Math.sqrt(avg(pts.map((p) => (p[1] - my) ** 2)) || 0);
  if (Math.abs(wk) < 0.15 * (sd || 1)) return 'flat';
  return `${wk > 0 ? 'rising' : 'falling'} ${r(Math.abs(wk), Math.abs(wk) < 10 ? 1 : 0)} a week`;
}

function nightText(n, goalMin, prior = null, stored = null) {
  if (!n) return 'no main night recorded';
  const s0 = sleepScoreOf(n, { prior });
  // The score the pages show is the day's stored one; its parts only when they add up to it.
  const s = fin(stored) && stored !== s0.score ? { ...s0, score: stored, band: sleepBand(stored), parts: [] } : s0;
  const st = n.summary?.stages || {};
  const parts = [
    `${clock(n.startMs, n.startOff)} to ${clock(n.endMs, n.endOff)}`, `asleep ${hm(n.asleepMin)}`, `in bed ${hm(n.periodMin)}`,
    fin(st.DEEP) ? `deep ${hm(st.DEEP)}` : null, fin(st.REM) ? `REM ${hm(st.REM)}` : null, fin(st.LIGHT) ? `light ${hm(st.LIGHT)}` : null,
    s.facts?.staged ? `REM ${s.facts.remPct}% of the time asleep` : 'no sleep stages',
    s.facts && Number.isFinite(s.facts.wasoMin) ? `${hm(s.facts.wasoMin)} awake after falling asleep` : null,
    s.score !== null ? `sleep quality ${s.score} (${s.band})${s.parts?.length ? `; parts: ${s.parts.map((p) => `${p.label} ${p.points}/${p.max}`).join(', ')}` : ''}` : null,
  ];
  return parts.filter(Boolean).join('; ');
}

const paceText = (sPerKm) => (fin(sPerKm) && sPerKm > 0 ? `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, '0')}` : '-');

/** A workout's exercises in one line: each with its working sets and the best of them. */
function exercisesLine(db, workoutId) {
  let list = [];
  try { list = db.setsOf(workoutId); } catch { return ''; }
  return list.slice(0, 12).map((x) => {
    const sets = x.sets.filter((st) => st.type !== 'warmup');
    const lifted = sets.filter((st) => fin(st.kg) && fin(st.reps));
    if (lifted.length) {
      const top = lifted.reduce((a, b) => (b.kg > a.kg || (b.kg === a.kg && b.reps > a.reps) ? b : a));
      return `${x.name} ${sets.length}x (${lifted.map((st) => `${st.kg}x${st.reps}`).join(', ')}; top ${top.kg} kg x ${top.reps})`;
    }
    const reps = sets.filter((st) => fin(st.reps)).map((st) => st.reps);
    if (reps.length) return `${x.name} ${sets.length}x (${reps.join(', ')} reps)`;
    const secs = sets.filter((st) => fin(st.durationS)).map((st) => st.durationS);
    if (secs.length) return `${x.name} ${secs.map((v) => `${Math.round(v / 60)} min`).join(', ')}${sets.some((st) => fin(st.distanceM)) ? `, ${(sets.reduce((a, st) => a + (st.distanceM || 0), 0) / 1000).toFixed(2)} km` : ''}`;
    return `${x.name} ${sets.length} sets`;
  }).join('; ');
}

/**
 * The briefing for one request: plain text sections, every number dated.
 * @param {object} world   the person's UserWorld
 * @param {object} o       { topic, id, profile, now }
 */
export function briefing(world, { topic = 'ask', id = null, profile = {}, now = Date.now(), extra = {}, allow = allowAll, seen = [] } = {}) {
  // `seen`: filled with what was read, one line each, for the page to show ("What it saw").
  const saw = (label) => seen.push(label);
  const may = (kind) => allow?.[kind] === true;
  const keys = KEYS.filter(([k]) => may(kindOfKey(k)));
  const tz = world.tz;
  const today = todayIn(now, tz);
  const off = utcOffsetSec(now, tz);
  const hour = new Date(now + off * 1000).getUTCHours();
  const part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'late evening';
  const db = world.db;
  const table = db.dailyTable(addDays(today, -95));
  const s = world.settings();
  const goalMin = s.sleepTarget || 450;
  const out = [];

  const nowMin = hour * 60 + new Date(now + off * 1000).getUTCMinutes();
  out.push(`## Now\n${wd(today)} ${today}, ${clock(now, off)} local time (${tz}), the ${part}. Today is not over: today's totals are so far.${hour < 5 ? ' It is after midnight: today has only just begun, so today\'s totals are near zero by nature; yesterday is the last full day.' : ''}`);
  void profile;   // never the name: the AI does not need to know who this is
  out.push(`## The person\ngoals: ${s.stepTarget || 8000} steps a day, ${hm(goalMin)} of sleep, ${s.cardioTarget || 150} cardio minutes a week, ${s.waterTarget || 2000} ml water.${db.meta('device')?.name ? ` Wears a ${db.meta('device').name}.` : ''}`);
  const off2 = Object.entries({ activity: 'activity', sleep: 'sleep', heart: 'heart data', body: 'weight', bodycomp: 'body composition (fat, muscle, bone, water), height and measurements', workouts: 'workouts', logged: 'logged stress', notes: 'their notes',
    nutrition: 'food and water', mood: 'mood', cycle: 'cycle', symptoms: 'symptoms', vitals: 'blood glucose and body temperature', ecg: 'ECG readings' }).filter(([k]) => !may(k)).map(([, v]) => v);
  if (off2.length) out.push(`## Not shared with you\nThe person chose not to share their ${off2.join(', ')} with the AI. If the question needs it, say so; never guess it.`);
  const sync = world.sync?.state?.lastOk;
  const syncAgoMin = sync ? Math.round((now - sync) / 60_000) : null;
  if (sync) out.push(`Data last synced ${syncAgoMin < 120 ? `${syncAgoMin} min` : `${Math.round(syncAgoMin / 60)} hours`} ago.${syncAgoMin > 360 ? ' That is a while: recent hours may be missing because they have not synced, not because nothing happened.' : ''}`);

  // Today and last night.
  const nights = db.sleeps(addDays(today, -40)).filter((n) => n.main);
  const byDate = {}; for (const n of nights) if (!byDate[n.date] || n.asleepMin > byDate[n.date].asleepMin) byDate[n.date] = n;
  out.push(`## Today so far (${wd(today)} ${today})\n${line(table[today], keys) || 'nothing yet today'}`);
  saw(`Today so far${may('activity') ? '' : ' (no activity: not shared)'}`);
  if (may('sleep')) {
    // When this person usually wakes and goes to bed (their last two weeks), so the time of day
    // can say whether a missing night is missing at all.
    const ofDay = (ms, o) => { const d = new Date(ms + (o || 0) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
    const recentN = nights.filter((n) => n.date >= addDays(today, -14));
    const med = (v) => { const x = v.filter(fin).sort((a, b) => a - b); return x.length ? x[Math.floor(x.length / 2)] : null; };
    const wakeMin = med(recentN.map((n) => ofDay(n.endMs, n.endOff))) ?? 7 * 60;
    const bedMin = med(recentN.map((n) => { const m = ofDay(n.startMs, n.startOff); return m < 12 * 60 ? m + 1440 : m; })) ?? 23 * 60;
    const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const last = byDate[today];
    const prev = byDate[addDays(today, -1)];
    let head; let body;
    if (last) {
      head = `## Last night (the night ending ${today})`;
      body = nightText(last, goalMin, nights, table[today]?.sleep_score);
      if (nowMin >= 18 * 60) body += `\nIt is evening: tonight's sleep has not started yet. "Last night" means the night that ended this morning.`;
    } else if (nowMin < wakeMin + 90) {
      head = `## Sleep: the night ending ${today} is still going on`;
      body = `It is ${clock(now, off)}, before or around their usual wake time (about ${hhmm(wakeMin)}). Tonight's sleep is NOT missing: it has not finished or synced yet. Do not comment on it as poor or missing sleep; if they are awake now, at most note that it is late and that sleep now helps tomorrow.\nThe latest finished night (ending ${addDays(today, -1)}): ${nightText(prev, goalMin, nights, table[addDays(today, -1)]?.sleep_score)}`;
    } else if (syncAgoMin !== null && syncAgoMin > 180) {
      head = `## Last night (the night ending ${today})`;
      body = `Not synced yet (the last sync was ${Math.round(syncAgoMin / 60)} hours ago). Do not judge last night; say it has not arrived.`;
    } else {
      head = `## Last night (the night ending ${today})`;
      body = `No sleep was recorded for it, although the data is up to date. Possible reasons: the watch was off or not worn, they slept without it, or they stayed up all night. Do not assume which: ask, and if it was an all-nighter, suggest how to get through today (light, water, a short nap before 15:00, an early night) rather than scoring it.${prev ? `\nThe night before (ending ${addDays(today, -1)}): ${nightText(prev, goalMin, nights, table[addDays(today, -1)]?.sleep_score)}` : ''}`;
    }
    out.push(`${head}\n${body}\nTheir usual: asleep around ${hhmm(bedMin)}, awake around ${hhmm(wakeMin)} (last two weeks).`);
    saw('Last night, and their usual bed and wake times');
  }

  // Day by day: two weeks always, a month when the question is about trends or anything at all.
  const nDays = ['heart', 'week', 'metric', 'ask', 'readiness', 'activity'].includes(topic) ? 30 : 14;
  const days = [];
  for (let i = 1; i <= nDays; i += 1) { const d = addDays(today, -i); const l = line(table[d], keys); if (l || i <= 7) days.push(`- ${wd(d).slice(0, 3)} ${d}: ${l || 'no data'}`); }
  out.push(`## The last ${nDays} days, day by day (newest first)\n${days.join('\n')}`);
  saw(`The last ${nDays} days, day by day`);

  // Averages, baselines, trends.
  const avgs = [];
  for (const [k, label] of keys) {
    const a7 = stat(table, k, addDays(today, -7), addDays(today, -1)); const a30 = stat(table, k, addDays(today, -30), addDays(today, -1)); const a90 = stat(table, k, addDays(today, -90), addDays(today, -1));
    if (!a30.n) continue;
    const t = trend(table, k, addDays(today, -1));
    const f = (x) => (k === 'sleep_min' ? hm(x.mean) : k === 'distance_m' ? r(x.mean / 1000, 1) : r(x.mean, Math.abs(x.mean) < 10 ? 1 : 0));
    avgs.push(`- ${label}: 7-day ${a7.n ? f(a7) : '-'}, 30-day ${f(a30)}, 90-day ${a90.n ? f(a90) : '-'}${t ? `; ${t}` : ''}`);
  }
  out.push(`## Averages and trends (days before today)\n${avgs.join('\n') || 'not enough history yet'}`);
  if (avgs.length) saw(`7-, 30- and 90-day averages and trends (${keys.length} measures)`);

  // Body composition from a scale: only weight is in the day-by-day lines, so a question about
  // bone, muscle, fat or water would otherwise find nothing, although the app shows each.
  if (may('bodycomp')) {
    const bc = compBrief(world);
    if (bc) { out.push(bc.text); saw(bc.label); }
    const extraBody = bodyExtras(world, now);
    if (extraBody) { out.push(extraBody); saw('Height, BMI and tape measurements'); }
  }
  // Sensitive health data: each only when the person allowed that kind, and its group is on.
  for (const sec of sensitiveSections(world, now, may)) { out.push(sec.text); saw(sec.label); }

  // Workouts: the ones kept here and the watch's own (as History lists them), never Strava's.
  // Ones the app noticed by itself from heart rate, very short ones, and two that overlap are said
  // to be what they are, so the model does not count a duplicate twice or trust a guess.
  const totals = db.setTotals();
  const sessions = may('workouts') ? unified(db, now - 30 * DAY, { noStrava: true }).sort((a, b) => b.start - a.start).slice(0, 40) : [];
  if (!may('workouts')) { /* not shared */ } else if (sessions.length) {
    const overlaps = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) >= 0.5 * Math.min(Math.max(60_000, a.end - a.start), Math.max(60_000, b.end - b.start));
    out.push(`## Recent workouts, last 30 days (newest first)\n${sessions.map((x, i) => {
      const w = x.local; const e = x.ex;
      const d = todayIn(x.start, tz);
      const type = sessionType(x);
      const name = (w && !(w.strava && w.title === w.strava.name) ? w.title : null) || x.as?.title || typeLabel(type);
      const minutes = Math.round((x.end - x.start) / 60_000);
      const t = w ? totals[w.id] : null;
      const hr = w ? w.avgHr : e?.avgHr;
      const km = w ? (w.route && w.route.from !== 'strava' && fin(w.route.distanceM) ? w.route.distanceM : fin(w.distanceM) ? w.distanceM : null) : e?.distanceM;
      const notes = [];
      if (w?.source === 'detected') notes.push('noticed by the app from heart rate, not logged: its kind and times are a guess');
      if (!w && e) notes.push('from the watch');
      if (minutes < 5) notes.push('very short: probably noise, not a real workout');
      if (sessions.some((y, j) => j !== i && overlaps(x, y))) notes.push('overlaps another one in this list: the same session recorded twice, count it once');
      const pace = fin(km) && km > 400 && minutes > 0 ? `, ${paceText((x.end - x.start) / 1000 / (km / 1000))} /km` : '';
      return `- ${wd(d).slice(0, 3)} ${d} ${clock(x.start, utcOffsetSec(x.start, tz))}: ${name}${name !== typeLabel(type) ? ` (${typeLabel(type)})` : ''}, ${minutes} min${fin(hr) ? `, avg HR ${Math.round(hr)}` : ''}${t?.sets ? `, ${t.sets} sets, ${Math.round(t.volumeKg)} kg volume` : ''}${fin(km) && km > 0 ? `, ${(km / 1000).toFixed(2)} km${pace}` : ''}${notes.length ? ` [${notes.join('; ')}]` : ''}${w && t?.sets ? `\n  ${exercisesLine(db, w.id)}` : ''}`;
    }).join('\n')}`);
    saw(`${sessions.length} workouts of the last 30 days, with their exercises and sets`);
  } else out.push('## Recent workouts\nnone recorded in the last 30 days');

  // When they slept, night by night, and what most likely moved today's recovery (aianalysis.js):
  // measured here, so a dip is put down to its real cause (a late or irregular night) and not guessed.
  // The nights before, each with its stages, when the question is about sleep or recovery (or anything).
  if (may('sleep') && ['sleep', 'morning', 'readiness', 'ask', 'week', 'heart'].includes(topic)) {
    const prevNights = [];
    for (let i = 1; i <= 14; i += 1) { const d = addDays(today, -i); if (byDate[d]) prevNights.push(`- night ending ${wd(d).slice(0, 3)} ${d}: ${nightText(byDate[d], goalMin, nights, table[d]?.sleep_score)}`); }
    if (prevNights.length) { out.push(`## The nights before, with stages (newest first)\n${prevNights.join('\n')}`); saw(`${prevNights.length} nights before, with their stages`); }
  }
  if (may('sleep')) {
    const st = sleepTiming(nights, today);
    if (st) { out.push(`## Sleep timing, night by night (last 7)\n${st}`); saw('Bed and wake times, last 7 nights'); }
  }
  if (may('heart') || may('sleep')) {
    const recentS = may('workouts') ? unified(db, now - 8 * DAY, { noStrava: true }).map((x) => ({ start: x.start, end: x.end, date: todayIn(x.start, tz), minutes: Math.round((x.end - x.start) / 60_000), avgHr: x.local ? x.local.avgHr : x.ex?.avgHr })) : [];
    let restHr = null; try { restHr = world.rest?.() ?? null; } catch { restHr = null; }
    const dr = recoveryDrivers({ nights: may('sleep') ? nights : [], table: may('heart') ? table : {}, today, sessions: recentS, restHr });
    if (dr) { out.push(`## Likely drivers of today's recovery and HRV (worked out by the app from their data, strongest first)\n${dr}`); saw('Likely causes of today\'s recovery'); }
  }

  // Stress as the person logged it (this app's 1-5 scale), apart from the watch's.
  const STRESS = ['', 'very calm', 'calm', 'some stress', 'stressed', 'very stressed'];
  const felt = may('logged') ? db.samples('stress', { fromMs: now - 14 * DAY, toMs: now + 1, limit: 40 }).filter((x) => fin(x.value)) : [];
  if (felt.length) {
    saw(`${felt.length} stress logs (last 14 days)`);
    out.push(`## Stress the person logged (1 very calm to 5 very stressed; their own words, not a device's), newest first\n${felt.map((x) => {
      const d = todayIn(x.t, tz);
      return `- ${wd(d).slice(0, 3)} ${d} ${clock(x.t, utcOffsetSec(x.t, tz))}: ${x.value} (${STRESS[x.value] || '-'})${x.data?.note ? `, note: ${String(x.data.note).slice(0, 120)}` : ''}`;
    }).join('\n')}`);
  }

  const notes = may('notes') ? String(db.meta('notes', '') || '').trim() : '';
  if (notes) { out.push(`## The person's own notes about themselves\n${notes.slice(0, 800)}`); saw('Your notes about yourself'); }

  // The part asked about.
  if (extra.detail) { out.push(`## Detail of what was asked about\n${extra.detail}`); if (extra.detailLabel) saw(extra.detailLabel); }
  if (off2.length) saw(`Not shared: ${off2.join(', ')}`);
  return out.join('\n\n');
}

/** The detail section for one night (the Sleep page showing a night before last night). */
/**
 * The scale's body composition for the briefing: the latest weigh-in, each number with the standard
 * range it falls in (core/bodycomp.js, as the Health page shows them), and how it moved over 30
 * and 90 days. Null without a weigh-in that has composition.
 */
export function compBrief(world) {
  const rows = world.db.samples('bodycomp', { limit: 400 }).filter((x) => !x.deleted && fin(x.data?.weightKg)).sort((a, b) => b.t - a.t);
  if (!rows.length) return null;
  const p = bodyPerson(world);
  const an = (x) => analyse(x.data, { sex: p.sex, age: ageAt(p.birthYear, x.t), heightCm: p.heightCm });
  const last = rows[0];
  const now = an(last);
  const back = (days) => rows.find((x) => x.t <= last.t - days * DAY) || null;
  const then = [[back(30), '30 days'], [back(90), '90 days']].filter(([x]) => x).map(([x, label]) => [an(x).values, label, x]);
  const num = (v, d) => (d === 0 ? String(Math.round(v)) : round(v, d).toFixed(d));
  const lines = COMP_FIELDS.filter((f) => fin(now.values[f.id]) && f.id !== 'heartRate').map((f) => {
    const v = now.values[f.id];
    const rg = now.ranges[f.id];
    const band = rg && rg.at >= 0 ? rg.bands[rg.at] : null;
    const std = rg?.bands.find((b) => b.std);
    const stdText = std ? `standard ${std.lo === null ? `under ${std.hi}` : std.hi === null ? `${std.lo} and over` : `${std.lo}-${std.hi}`}` : '';
    const moved = then.map(([vals, label]) => (fin(vals[f.id]) ? `${v - vals[f.id] >= 0 ? '+' : ''}${num(v - vals[f.id], f.decimals || 1)} over ${label}` : null)).filter(Boolean);
    return `- ${f.label}: ${num(v, f.decimals)}${f.unit ? ` ${f.unit}` : ''}${band ? ` (${band.label}${stdText ? `; ${stdText}` : ''})` : ''}${moved.length ? `, ${moved.join(', ')}` : ''}`;
  });
  if (!lines.length) return null;
  const n90 = rows.filter((x) => x.t > last.t - 90 * DAY).length;
  const when = todayIn(last.t, world.tz);
  const extra = [now.score ? `Body score ${now.score.value} (${now.score.word}), the app's estimate.` : '', now.bodyType ? `Body type: ${now.bodyType.label}.` : '',
    now.needs.length ? `Ranges need their ${now.needs.join(', ')}, not set, so some numbers have no range.` : ''].filter(Boolean).join(' ');
  return {
    label: `Body composition from the scale (latest ${when})`,
    text: `## Body composition from their smart scale (latest weigh-in ${wd(when)} ${when}; ${n90} weigh-in${n90 === 1 ? '' : 's'} in the 90 days to it)
`
      + 'A bioimpedance scale\'s estimates, not a lab test: good for the direction over weeks, not a diagnosis. Bone mineral here is the estimated weight of bone mineral in kg, not bone density or a T-score (only a DEXA scan gives those).\n'
      + `${lines.join('\n')}${extra ? `\n${extra}` : ''}`,
  };
}

/** Height, BMI and the latest tape measurements: the rest of the body, beside the scale's numbers. */
function bodyExtras(world, now) {
  const db = world.db;
  const mm = db.latest('height_mm')?.value ?? db.sampleLatest('height')?.value ?? null;
  const w = db.latest('weight_kg')?.value ?? null;
  const parts = [];
  if (fin(mm)) parts.push(`height ${round(mm / 10, 1)} cm`);
  if (fin(mm) && fin(w) && mm > 0) parts.push(`BMI ${round(w / (mm / 1000) ** 2, 1)} (from their latest weight)`);
  const tape = db.samples('measure', { toMs: now + 1, limit: 3 }).filter((x) => !x.deleted);
  const lines = tape.map((x) => `- ${x.date}: ${sampleText(x)}`);
  if (!parts.length && !lines.length) return null;
  return `## Height, BMI and tape measurements
${parts.join(', ')}${lines.length ? `${parts.length ? '\n' : ''}Tape measurements, newest first:\n${lines.join('\n')}` : ''}`;
}

/* Sensitive health data (catalog.js `sensitive`): what the person logged or their watch recorded,
   newest first, food and water as each day's totals. Each goes in only when its kind is allowed
   (consent.js AI_SENSITIVE) and, for a group's data, while that group is on and its own "Include
   in summaries" switch is too (world.aiShare). The notes on entries never go in (privacy.html). */
const SENSITIVE = [
  { kind: 'nutrition', sample: 'food', group: 'nutrition', days: 7, title: 'Food they logged (last 7 days)', perDay: true },
  { kind: 'nutrition', sample: 'water', group: 'nutrition', days: 7, title: 'Water they logged (last 7 days)', perDay: true },
  { kind: 'mood', sample: 'mood', group: 'mindfulness', days: 14, title: 'Mood they logged (last 14 days)' },
  { kind: 'cycle', sample: 'period', group: 'cycle', days: 200, title: 'Periods (last 200 days)' },
  { kind: 'cycle', sample: 'ovulation', group: 'cycle', days: 60, title: 'Ovulation tests (last 60 days)' },
  { kind: 'symptoms', sample: 'symptom', group: 'symptoms', days: 30, title: 'Symptoms they logged (last 30 days)' },
  { kind: 'vitals', sample: 'glucose', days: 30, title: 'Blood glucose (last 30 days)' },
  { kind: 'vitals', sample: 'bodytemp', days: 30, title: 'Body temperature (last 30 days)' },
  { kind: 'ecg', sample: 'ecg', group: 'ecg', days: 365, title: 'ECG readings from their watch (last year; the watch\'s own result, not a diagnosis)' },
  { kind: 'ecg', sample: 'irn', group: 'ecg', days: 365, title: 'Irregular rhythm notices from their watch (last year)' },
];
function sensitiveSections(world, now, may) {
  const groups = (() => { try { return world.groups?.() || {}; } catch { return {}; } })();
  const share = (() => { try { return world.aiShare?.() || {}; } catch { return {}; } })();
  const out = [];
  for (const s of SENSITIVE) {
    if (!may(s.kind) || (s.group && (groups[s.group] !== true || share[s.group] !== true))) continue;
    const rows = world.db.samples(s.sample, { fromMs: now - s.days * DAY, toMs: now + 1, limit: 80 }).filter((x) => !x.deleted);
    if (!rows.length) continue;
    let lines;
    if (s.perDay) {
      const byDay = new Map();
      for (const x of rows) { if (!byDay.has(x.date)) byDay.set(x.date, []); byDay.get(x.date).push(x); }
      lines = [...byDay].map(([date, xs]) => {
        const sum = xs.reduce((a, x) => a + (fin(x.value) ? x.value : 0), 0);
        if (s.sample === 'water') return `- ${wd(date).slice(0, 3)} ${date}: ${Math.round(sum)} ml`;
        const m = (k) => Math.round(xs.reduce((a, x) => a + (fin(x.data?.[k]) ? x.data[k] : 0), 0));
        return `- ${wd(date).slice(0, 3)} ${date}: ${Math.round(sum)} kcal in ${xs.length} entr${xs.length === 1 ? 'y' : 'ies'}, protein ${m('protein')} g, carbs ${m('carbs')} g, fat ${m('fat')} g`;
      });
    } else {
      lines = rows.slice(0, 30).map((x) => `- ${wd(x.date).slice(0, 3)} ${x.date} ${clock(x.t, x.off)}: ${sampleText(x)}`);
    }
    out.push({ text: `## ${s.title}, newest first\n${lines.join('\n')}`, label: s.title.replace(/ \(.*/, '') });
  }
  return out;
}

export function nightDetail(world, date) {
  const nights = world.db.sleeps(addDays(date, -40)).filter((n) => n.main && n.date <= addDays(date, 1));
  const n = nights.filter((x) => x.date === date).sort((a, b) => b.asleepMin - a.asleepMin)[0];
  const table = world.db.dailyTable(date);
  const goalMin = world.settings().sleepTarget || 450;
  return `The night ending ${wd(date)} ${date} (the one they are looking at, not last night): ${n ? nightText(n, goalMin, nights.filter((x) => x.date < date), table[date]?.sleep_score) : 'no main night recorded'}`;
}

/** The detail section for a workout. */
export function workoutDetail(world, w, detail) {
  if (!detail) return null;
  const lines = [`${detail.title} on ${todayIn(detail.start, world.tz)}, ${detail.durationMin} min, type ${detail.type}${fin(detail.avgHr) ? `, avg HR ${Math.round(detail.avgHr)}, max ${Math.round(detail.maxHr || 0)}` : ''}${fin(detail.kcal) ? `, ${Math.round(detail.kcal)} kcal` : ''}`];
  if (detail.routine) lines.push(`From routine "${detail.routine.title}"${detail.differences?.length ? `; differences from it: ${detail.differences.map((x) => x.text).join('; ')}` : ', done as planned'}`);
  for (const x of detail.exercises || []) lines.push(`- ${x.name}: ${x.sets.map((st) => [st.type !== 'normal' ? st.type : '', fin(st.kg) ? `${st.kg}kg` : '', fin(st.reps) ? `x${st.reps}` : '', fin(st.durationS) ? `${st.durationS}s` : '', st.pr ? '(record)' : ''].filter(Boolean).join(' ')).join(', ')}${x.previous ? `; last time top ${x.previous.topKg}kg x${x.previous.topReps} on ${x.previous.date}` : ''}`);
  if (detail.summary) lines.push(`Volume ${detail.summary.volumeKg} kg, ${detail.summary.sets} sets, ${detail.summary.reps} reps, ${detail.summary.records} records${detail.summary.last ? `; the same routine last time: ${detail.summary.last.volumeKg} kg in ${detail.summary.last.durationMin} min` : ''}`);
  if (detail.track) lines.push(`Route: ${(detail.track.distanceM / 1000).toFixed(2)} km, moving ${Math.round(detail.track.movingS / 60)} min, ${detail.track.pace ? `pace ${Math.floor(detail.track.paceSPerKm / 60)}:${String(detail.track.paceSPerKm % 60).padStart(2, '0')} /km` : `${detail.track.avgSpeedKmh} km/h`}, climb ${detail.track.elevGainM} m; splits: ${detail.track.splits.map((x) => `${x.n}:${x.paceSPerKm ? `${Math.floor(x.paceSPerKm / 60)}:${String(x.paceSPerKm % 60).padStart(2, '0')}` : '-'}${fin(x.hr) ? `@${x.hr}` : ''}`).join(' ')}`);
  if (detail.zones?.minutes) lines.push(`Heart-rate zone minutes (light, moderate, vigorous, peak): ${detail.zones.minutes.join(', ')}`);
  return lines.join('\n');
}

/** What consent kind a metric page is (consent.js), from its category in the catalog; null when it
    may never go to the AI: a sensitive metric (catalog.js) or one with no kind the person can allow. */
const CATEGORY_KIND = { activity: 'activity', heart: 'heart', vitals: 'heart', mindfulness: 'heart', sleep: 'sleep', body: 'bodycomp' };
/** Sensitive metrics, each under the kind the person allows it by (consent.js AI_SENSITIVE). */
const SENSITIVE_KIND = { water: 'nutrition', food: 'nutrition', mood: 'mood', period: 'cycle', ovulation: 'cycle', symptoms: 'symptoms',
  glucose: 'vitals', body_temp: 'vitals', ecg: 'ecg', irn: 'ecg' };
export function metricKind(metricId) {
  const m = metricById(metricId);
  if (!m) return null;
  if (m.sensitive) return SENSITIVE_KIND[m.id] || null;
  if (m.source?.type === 'workouts') return 'workouts';
  if (m.id === 'weight') return 'body';
  return CATEGORY_KIND[m.category] || null;
}

/**
 * The detail section for a metric: what it is (its name in the app, never its internal id) and
 * the numbers its own page shows (browse.metricView), so the AI reads what the person sees:
 * the last 30 days day by day (each part of a stack, low and high of a range), a weekly metric
 * week by week, the period's stats, the one before, and the usual band.
 * @param {object} view      metricView(world, id, { range: 'month' })
 * @param {object} [weeks]   metricView(world, id, { range: '6m' }) for a metric counted by the week
 */
export function metricDetail(metricId, view, weeks = null) {
  const m = metricById(metricId);
  if (!m || !view) return 'no values for this metric';
  const name = m.label;
  const txt = (v) => (fin(v) ? valueText(m, v) : '-');
  const partsOf = (p) => {
    const keys = view.chart?.stackKeys || [];
    if (!p.parts || !keys.length) return '';
    return ` (${keys.map((k) => `${k.label} ${fin(p.parts[k.key]) ? valueText({ ...m, unit: k.unit || m.unit }, p.parts[k.key]) : '-'}`).join(', ')})`;
  };
  const pointText = (p) => `${p.date}: ${fin(p.lo) && fin(p.hi) && p.lo !== p.hi ? `${txt(p.value)}, low ${txt(p.lo)}, high ${txt(p.hi)}` : txt(p.value)}${partsOf(p)}`;
  const st = view.stats || {};
  const about = [
    `The metric is "${name}" (call it exactly that; it is the app's own name for it${m.own ? ', a score the app works out itself' : ''}).`,
    m.about ? `What it is: ${String(m.about).replace(/<[^>]+>/g, '')}` : null,
    m.unit ? `Unit: ${m.unit === 'SD' ? 'standard deviations from their own usual (0 is usual)' : m.unit}${m.betterWhen ? `; better when ${m.betterWhen}` : ''}.` : null,
    m.zones?.length ? `Bands: ${m.zones.map((z) => `${z.label} ${z.lo}-${z.hi}`).join(', ')}.` : null,
    view.reading ? `What the page says: ${view.reading}` : null,
    st.count ? `Last 30 days: average ${txt(st.avg)}${m.agg === 'sum' ? ' a day' : ''}, lowest ${txt(st.min?.value)} (${st.min?.date}), highest ${txt(st.max?.value)} (${st.max?.date}), latest ${txt(st.latest?.value)} (${st.latest?.date}), ${st.count} days with data.` : null,
    view.prev && fin(view.prev.avg) ? `The 30 days before: average ${txt(view.prev.avg)}.` : null,
    view.chart?.band && fin(view.chart.band.lo) ? `Their usual range: ${txt(view.chart.band.lo)} to ${txt(view.chart.band.hi)}.` : null,
    view.metric?.goal ? `Their goal: ${txt(view.metric.goal)} a ${view.metric.goalPer || 'day'}.` : null,
  ].filter(Boolean).join('\n');
  const out = [about];
  const wk = (weeks?.chart?.points || []).slice(-8).reverse();
  if (m.weekly && wk.length) out.push(`${name}, week by week (the week starting on the date), newest first; this week is not over:\n${wk.map(pointText).join('\n')}`);
  const days = (view.chart?.points || []).slice().reverse();
  out.push(`${name}${m.weekly ? ', day by day (what each day added to its week)' : ', day by day'}, last 30 days, newest first:\n${days.map(pointText).join('\n') || 'no values in the last 30 days'}`);
  return out.join('\n');
}

/* ── the instructions ──────────────────────────────────────────────── */

export function prompt({ topic, briefingText, question = null, history = [] }) {
  const convo = history.slice(-6).map((h) => `${h.role === 'user' ? 'Person' : 'You'}: ${String(h.text).slice(0, 600)}`).join('\n');
  return `You are the coach inside the person's own fitness app. Below is their data, prepared and dated by the app. It is all there is.

Task: ${FOCUS[topic] || FOCUS.ask}
${question ? `\nThe person asks: "${String(question).slice(0, 500)}"` : ''}
${convo ? `\nThe conversation so far (answer the new message in its light):\n${convo}\n` : ''}
How to answer:
- Be useful, not a readout. They can already see their numbers. Say what the numbers MEAN for them (against their own usual), why it probably happened (the likely cause in their data: a late night, a hard session, a rest day, a trend), and what to DO about it today or this week.
- Use at most three of their numbers in the whole answer, each with its day and compared with their usual ("HRV 41 ms, about 15% under your usual"). Targets you prescribe (a pace, a weight, a heart rate to stay under) do not count against that.
- Call the app's scores by the app's names: "Recovery" (0-100, how ready the body is today), "Load balance" (0-100, this week's training against the last four), "Sleep quality" (0-100). Never call them readiness or resilience. Heart-rate zones are light, moderate, vigorous and peak.
- When a term may be unclear (HRV, Recovery, Load balance, zones, volume), explain it in a few plain words the first time.
- Suggestions are concrete and small: a time, a duration, an intensity ("an easy 30 minutes, keep it conversational", "in bed by 23:00").
- Answer the thing asked about first. When a detail section is attached, the question is about it: start there, not with the rest of their week.
- A workout: name its structure (steady, intervals, tempo, long and easy, a fade), judge the pacing and heart rate for that kind of session (were the hard parts hard and the easy parts easy, did it fade, did heart rate drift), compare it with their similar sessions, and prescribe the next one in numbers, e.g. "next time: 6 x 3 min jog at about 6:10/km with 90 s walking between; stop the set if heart rate stays over 175". For strength: sets, weights and reps against last time, and the next target.
- Recovery, HRV, resting heart rate, tiredness: use "Likely drivers" and name the strongest with its evidence. Check sleep timing (a late or irregular bedtime) before blaming training; never say "lingering fatigue from a workout" when the drivers point at sleep.
- Read the notes in the data and respect them: a night still going on is not missing sleep; a night not synced is not a bad night; a workout marked as noticed by the app is a guess; two overlapping workouts are one; a very short one is noise. When data is missing, say so in a few words and give what advice you can anyway; never invent it.
- No diagnosis. For anything worrying (chest pain, fainting, a very high resting heart rate for days), suggest seeing a doctor, in one sentence.
- Short and warm. No filler, no "great job" unless something really was. The headline is the single takeaway (under 10 words). The summary is 1 to 2 sentences. At most 3 points, each one sentence of at most 20 words, each an insight or an action, never a number alone.

Answer with JSON only, no other text:
{"headline": "the takeaway", "summary": "1-2 sentences: what it means and why", "points": ["an action or insight", "..."], "followUps": ["a short question they might ask next", "...", "..."]}

${briefingText}`;
}

/** The model's reply, or null when it is not the JSON asked for. */
export function parseReply(text) {
  const t = String(text || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
  const out = { headline: str(j.headline, 160), summary: str(j.summary || j.answer, 1200), points: list(j.points, 300, 5), followUps: list(j.followUps || j.follow_ups, 120, 3) };
  return out.headline || out.summary ? out : null;
}

/* ── jobs ──────────────────────────────────────────────────────────── */

/**
 * The running and recent requests, per person. A job's steps are what the
 * page shows while waiting: { state: reading | asking | done | error,
 * model, attempt, startedAt, answer }.
 */
export class AiJobs {
  constructor({ writer, log = () => {}, now = Date.now }) {
    this.writer = writer; this.log = log; this.now = now;
    this.jobs = new Map();   // id -> job
    this.seq = 0;
  }

  get(id, userId) { const j = this.jobs.get(id); return j && j.userId === userId ? view(j) : null; }

  /** Start a request. `build` (async) returns { prompt, cacheKey }. */
  start(userId, { topic, title, build, cache, onDone = () => {}, writer = null }) {
    const wr = writer || this.writer;
    const id = `ai${Date.now().toString(36)}${(this.seq += 1)}`;
    const job = { id, userId, topic, title, state: 'reading', startedAt: this.now(), model: null, attempt: 0, answer: null, error: null };
    this.jobs.set(id, job);
    // Old jobs go after a while.
    for (const [k, j] of this.jobs) if (this.now() - j.startedAt > 30 * 60_000) this.jobs.delete(k);
    (async () => {
      try {
        const { prompt: p, cacheKey } = await build();
        const hit = cacheKey ? cache.get(cacheKey) : null;
        if (hit) { Object.assign(job, { state: 'done', answer: hit.answer, model: hit.model, cached: true }); onDone(job); return; }
        job.state = 'asking';
        if (!wr.configured()) throw Object.assign(new Error('No AI is set up on this server.'), { code: 'unconfigured' });
        const r = await wr.write(p, { parse: parseReply, onStep: (s) => { job.model = s.model; job.attempt = s.attempt; } });
        Object.assign(job, { state: 'done', answer: r.summary, model: r.model.replace(/^opencode\//, '') });
        if (cacheKey) cache.set(cacheKey, { answer: r.summary, model: job.model, at: this.now() });
        onDone(job);
      } catch (e) {
        this.log(`ai ${topic}: ${e.message}`);
        Object.assign(job, { state: 'error', error: e.code === 'unconfigured' ? 'No AI is set up on this server yet.' : e.own ? e.message : (e.tried?.length ? 'The free AI models are busy or refused just now. Try again in a minute.' : 'The AI could not be reached. Try again in a minute.') });
      }
    })();
    return view(job);
  }
}

const view = (j) => ({ id: j.id, topic: j.topic, title: j.title, state: j.state, model: j.model, attempt: j.attempt, startedAt: j.startedAt, answer: j.answer, error: j.error, cached: !!j.cached });

/** A small cache of answers in the person's store: a key made from the topic and when the data last changed. */
export function answerCache(db, max = 40) {
  const all = () => db.meta('aiCache', {}) || {};
  return {
    get(k) { return all()[k] || null; },
    set(k, v) { const a = all(); a[k] = v; const keys = Object.keys(a).sort((x, y) => (a[y].at || 0) - (a[x].at || 0)); for (const x of keys.slice(max)) delete a[x]; db.setMeta('aiCache', a); },
  };
}

export { DAY };
