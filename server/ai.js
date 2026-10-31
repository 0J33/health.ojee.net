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
  readiness: 'Readiness and recovery',
  activity: 'Today\'s activity',
  heart: 'Heart',
  week: 'This week',
  workout: 'This workout',
  metric: 'This metric',
  ask: 'Your question',
};

/** What to look at, per topic. */
const FOCUS = {
  morning: 'It is the morning summary. Lead with how last night went (sleep score and what drove it: time asleep, sound sleep, awakenings, bed and wake times against usual) and then what it means for today: readiness, resilience, HRV and resting heart rate against baseline, and one sensible suggestion for the day (train hard, keep it easy, get to bed earlier). Mention yesterday only where it explains last night.',
  sleep: 'Focus on last night and the last 7 nights: the score and its parts, time asleep against the goal, stages, awakenings, bed and wake times and their regularity, and how last night compares with the week and the person\'s 30-day usual. Say what is improving or slipping.',
  readiness: 'Focus on readiness and resilience today: HRV and resting heart rate against the 30-day baseline, the last week of sleep, recent training load, and what that suggests for today. Explain why the score is where it is.',
  activity: 'Focus on today so far (it is not over: judge it against the time of day): steps, active minutes, calories, cardio, against goals and the usual for this weekday, and the week so far. Suggest what would round the day off.',
  heart: 'Focus on heart data: resting heart rate, HRV, heart-rate zones and cardio over the last weeks, against baselines; anything unusual. Where there is stress (the watch\'s, or what the person logged) or Body Battery, say how it fits.',
  week: 'Focus on this week (Monday to today) against last week and the usual: activity, workouts, sleep, recovery. Name the best and the weakest part of the week.',
  workout: 'Focus on the workout in the detail section: what was done, how hard (heart rate, volume, pace), records, how it compares with the last similar sessions and the routine it was from, and one thing to try next time.',
  metric: 'Focus on the metric in the detail section: where it is now, its trend over the last weeks, against the person\'s usual, and what usually moves it for them according to their data.',
  ask: 'Answer the person\'s question directly, using the data. If the data cannot answer it, say what is missing.',
};

/* ── the briefing ──────────────────────────────────────────────────── */

const KEYS = [
  ['steps', 'steps'], ['active_min', 'active min'], ['cardio_min', 'cardio min'], ['kcal', 'kcal'], ['kcal_active', 'active kcal'],
  ['sleep_min', 'asleep'], ['sleep_score', 'sleep score'], ['readiness', 'readiness'], ['resilience', 'resilience'],
  ['rhr', 'resting HR'], ['hrv', 'HRV ms'], ['spo2', 'SpO2 %'], ['resp', 'breaths/min'], ['temp_dev', 'sleep temp dev C'], ['weight_kg', 'weight kg'],
  // From a Garmin watch: its all-day stress (0-100, 25 and under is rest) and Body Battery.
  ['stress', 'Garmin stress 0-100'], ['stress_high', 'min of high stress'], ['bb_high', 'Body Battery high'], ['bb_low', 'Body Battery low'],
];

function line(row, keys = KEYS) {
  return keys.map(([k, label]) => {
    const v = row?.[k];
    if (!fin(v)) return null;
    if (k === 'sleep_min') return `${label} ${hm(v)}`;
    if (k === 'readiness') return `${label} ${v} (${readyBand(v)})`;
    if (k === 'resilience') return `${label} ${resilLabel(v)}`;
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

function nightText(n, goalMin) {
  if (!n) return 'no main night recorded';
  const s = sleepScoreOf(n, { goalMin });
  const st = n.summary?.stages || {};
  const parts = [
    `${clock(n.startMs, n.startOff)} to ${clock(n.endMs, n.endOff)}`, `asleep ${hm(n.asleepMin)}`, `in bed ${hm(n.periodMin)}`,
    fin(st.DEEP) ? `deep ${hm(st.DEEP)}` : null, fin(st.REM) ? `REM ${hm(st.REM)}` : null, fin(st.LIGHT) ? `light ${hm(st.LIGHT)}` : null,
    s.facts ? `REM ${s.facts.remPct}% of the night, ${hm(s.facts.wasoMin)} awake after falling asleep (${hm(s.facts.longWakeMin)} of it in spells of 3 min or more)` : 'no sleep stages',
    s.score !== null ? `sleep score ${s.score} (${s.band}); parts: ${s.parts.map((p) => `${p.label} ${p.points}/${p.max}`).join(', ')}` : null,
  ];
  return parts.filter(Boolean).join('; ');
}

/**
 * The briefing for one request: plain text sections, every number dated.
 * @param {object} world   the person's UserWorld
 * @param {object} o       { topic, id, profile, now }
 */
export function briefing(world, { topic = 'ask', id = null, profile = {}, now = Date.now(), extra = {} } = {}) {
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

  out.push(`## Now\n${wd(today)} ${today}, ${clock(now, off)} local time (${tz}), the ${part}. Today is not over: today's totals are so far.`);
  const name = profile?.displayName || profile?.username || null;
  out.push(`## The person\n${[name ? `Name ${name}` : null, `goals: ${s.stepTarget || 8000} steps a day, ${hm(goalMin)} of sleep, ${s.cardioTarget || 150} cardio minutes a week, ${s.waterTarget || 2000} ml water`].filter(Boolean).join('; ')}.${db.meta('device')?.name ? ` Wears a ${db.meta('device').name}.` : ''}`);
  const sync = world.sync?.state?.lastOk;
  if (sync) out.push(`Data last synced ${Math.round((now - sync) / 60_000)} min ago.`);

  // Today and last night.
  const nights = db.sleeps(addDays(today, -40)).filter((n) => n.main);
  const byDate = {}; for (const n of nights) if (!byDate[n.date] || n.asleepMin > byDate[n.date].asleepMin) byDate[n.date] = n;
  out.push(`## Today so far (${wd(today)} ${today})\n${line(table[today]) || 'nothing yet today'}`);
  out.push(`## Last night (the night ending ${today})\n${nightText(byDate[today], goalMin)}`);

  // The last 7 days, day by day.
  const days = [];
  for (let i = 1; i <= 7; i += 1) { const d = addDays(today, -i); days.push(`- ${wd(d).slice(0, 3)} ${d}: ${line(table[d]) || 'no data'}`); }
  out.push(`## The last 7 days (newest first)\n${days.join('\n')}`);

  // Averages, baselines, trends.
  const avgs = [];
  for (const [k, label] of KEYS) {
    const a7 = stat(table, k, addDays(today, -7), addDays(today, -1)); const a30 = stat(table, k, addDays(today, -30), addDays(today, -1)); const a90 = stat(table, k, addDays(today, -90), addDays(today, -1));
    if (!a30.n) continue;
    const t = trend(table, k, addDays(today, -1));
    const f = (x) => (k === 'sleep_min' ? hm(x.mean) : r(x.mean, Math.abs(x.mean) < 10 ? 1 : 0));
    avgs.push(`- ${label}: 7-day ${a7.n ? f(a7) : '-'}, 30-day ${f(a30)}, 90-day ${a90.n ? f(a90) : '-'}${t ? `; ${t}` : ''}`);
  }
  out.push(`## Averages and trends (days before today)\n${avgs.join('\n') || 'not enough history yet'}`);

  // Workouts.
  const recent = db.workoutsDone(Number.MAX_SAFE_INTEGER, 12);
  const totals = db.setTotals();
  if (recent.length) {
    out.push(`## Recent workouts (newest first)\n${recent.map((w) => {
      const d = todayIn(w.start, tz);
      const t = totals[w.id];
      return `- ${wd(d).slice(0, 3)} ${d} ${clock(w.start, utcOffsetSec(w.start, tz))}: ${w.title || w.type || 'workout'}, ${Math.round(((w.end || w.start) - w.start) / 60_000)} min${fin(w.avgHr) ? `, avg HR ${Math.round(w.avgHr)}` : ''}${t ? `, ${t.sets} sets, ${Math.round(t.volumeKg)} kg volume` : ''}${w.route ? `, ${(w.route.distanceM / 1000).toFixed(2)} km` : ''}`;
    }).join('\n')}`);
  } else out.push('## Recent workouts\nnone recorded');

  // Stress as the person logged it (this app's 1-5 scale), apart from the watch's.
  const STRESS = ['', 'very calm', 'calm', 'some stress', 'stressed', 'very stressed'];
  const felt = db.samples('stress', { fromMs: now - 14 * DAY, toMs: now + 1, limit: 40 }).filter((x) => fin(x.value));
  if (felt.length) {
    out.push(`## Stress the person logged (1 very calm to 5 very stressed; their own words, not a device's), newest first\n${felt.map((x) => {
      const d = todayIn(x.t, tz);
      return `- ${wd(d).slice(0, 3)} ${d} ${clock(x.t, utcOffsetSec(x.t, tz))}: ${x.value} (${STRESS[x.value] || '-'})${x.data?.note ? `, note: ${String(x.data.note).slice(0, 120)}` : ''}`;
    }).join('\n')}`);
  }

  const notes = String(db.meta('notes', '') || '').trim();
  if (notes) out.push(`## The person's own notes about themselves\n${notes.slice(0, 800)}`);

  // The part asked about.
  if (extra.detail) out.push(`## Detail of what was asked about\n${extra.detail}`);
  return out.join('\n\n');
}

/** The detail section for a workout. */
export function workoutDetail(world, w, detail) {
  if (!detail) return null;
  const lines = [`${detail.title} on ${todayIn(detail.start, world.tz)}, ${detail.durationMin} min, type ${detail.type}${fin(detail.avgHr) ? `, avg HR ${Math.round(detail.avgHr)}, max ${Math.round(detail.maxHr || 0)}` : ''}${fin(detail.kcal) ? `, ${Math.round(detail.kcal)} kcal` : ''}`];
  if (detail.routine) lines.push(`From routine "${detail.routine.title}"${detail.differences?.length ? `; differences from it: ${detail.differences.map((x) => x.text).join('; ')}` : ', done as planned'}`);
  for (const x of detail.exercises || []) lines.push(`- ${x.name}: ${x.sets.map((st) => [st.type !== 'normal' ? st.type : '', fin(st.kg) ? `${st.kg}kg` : '', fin(st.reps) ? `x${st.reps}` : '', fin(st.durationS) ? `${st.durationS}s` : '', st.pr ? '(record)' : ''].filter(Boolean).join(' ')).join(', ')}${x.previous ? `; last time top ${x.previous.topKg}kg x${x.previous.topReps} on ${x.previous.date}` : ''}`);
  if (detail.summary) lines.push(`Volume ${detail.summary.volumeKg} kg, ${detail.summary.sets} sets, ${detail.summary.reps} reps, ${detail.summary.records} records${detail.summary.last ? `; the same routine last time: ${detail.summary.last.volumeKg} kg in ${detail.summary.last.durationMin} min` : ''}`);
  if (detail.track) lines.push(`Route: ${(detail.track.distanceM / 1000).toFixed(2)} km, moving ${Math.round(detail.track.movingS / 60)} min, ${detail.track.pace ? `pace ${Math.floor(detail.track.paceSPerKm / 60)}:${String(detail.track.paceSPerKm % 60).padStart(2, '0')} /km` : `${detail.track.avgSpeedKmh} km/h`}, climb ${detail.track.elevGainM} m; splits: ${detail.track.splits.map((x) => `${x.n}:${x.paceSPerKm ? `${Math.floor(x.paceSPerKm / 60)}:${String(x.paceSPerKm % 60).padStart(2, '0')}` : '-'}${fin(x.hr) ? `@${x.hr}` : ''}`).join(' ')}`);
  if (detail.zones?.minutes) lines.push(`Heart-rate zone minutes (easy to peak): ${detail.zones.minutes.join(', ')}`);
  return lines.join('\n');
}

/** The detail section for a metric: its own last 30 days. */
export function metricDetail(world, metricId, label) {
  const today = todayIn(Date.now(), world.tz);
  const table = world.db.dailyTable(addDays(today, -30));
  const key = { sleep: 'sleep_min', steps: 'steps', resting_hr: 'rhr', hrv: 'hrv', weight: 'weight_kg', active: 'active_min', calories: 'kcal', sleep_score: 'sleep_score', readiness: 'readiness', resilience: 'resilience', spo2: 'spo2', resp: 'resp', vo2max: 'vo2max', distance: 'distance_m', floors: 'floors', body_battery: 'bb_high' }[metricId] || metricId;
  const vals = [];
  for (let i = 0; i <= 30; i += 1) { const d = addDays(today, -i); const v = table[d]?.[key]; if (fin(v)) vals.push(`${d}: ${r(v, Math.abs(v) < 10 ? 1 : 0)}`); }
  return `${label || metricId} (key ${key}), last 30 days, newest first:\n${vals.join('\n') || 'no values'}`;
}

/* ── the instructions ──────────────────────────────────────────────── */

export function prompt({ topic, briefingText, question = null, history = [] }) {
  const convo = history.slice(-6).map((h) => `${h.role === 'user' ? 'Person' : 'You'}: ${String(h.text).slice(0, 600)}`).join('\n');
  return `You are the health coach inside the person's own health app. You have their data below, prepared by the app; it is everything there is.

What to do: ${FOCUS[topic] || FOCUS.ask}
${question ? `\nThe person asks: "${String(question).slice(0, 500)}"` : ''}
${convo ? `\nThe conversation so far:\n${convo}\n` : ''}
Rules:
- Use only the numbers below. Quote them with their day ("last night", "Tuesday"), and compare with the person's own averages and baselines, not with population norms.
- Think about the time of day: today's totals are so far, not final. In the morning, today has barely started.
- If something needed is missing, say so in a few words instead of guessing.
- Plain, warm, direct English. No medical diagnosis; for anything worrying suggest seeing a doctor.
- Short: the summary at most 3 sentences; at most 4 points, each one sentence.

Answer with JSON only, no other text:
{"headline": "one short line, the main thing", "summary": "2 or 3 sentences", "points": ["specific observation or suggestion", "..."], "followUps": ["a question the person might ask next", "...", "..."]}

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
  start(userId, { topic, title, build, cache, onDone = () => {} }) {
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
        if (!this.writer.configured()) throw Object.assign(new Error('No AI is set up on this server.'), { code: 'unconfigured' });
        const r = await this.writer.write(p, { parse: parseReply, onStep: (s) => { job.model = s.model; job.attempt = s.attempt; } });
        Object.assign(job, { state: 'done', answer: r.summary, model: r.model.replace(/^opencode\//, '') });
        if (cacheKey) cache.set(cacheKey, { answer: r.summary, model: job.model, at: this.now() });
        onDone(job);
      } catch (e) {
        this.log(`ai ${topic}: ${e.message}`);
        Object.assign(job, { state: 'error', error: e.code === 'unconfigured' ? 'No AI is set up on this server yet.' : (e.tried?.length ? 'The free AI models are busy or refused just now. Try again in a minute.' : 'The AI could not be reached. Try again in a minute.') });
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
