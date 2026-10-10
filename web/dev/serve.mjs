#!/usr/bin/env node
/* Frontend-only dev server: serves web/ with the index.html fallback and the
   production CSP, and answers the API from in-memory fixtures shaped like
   docs/API.md. For working on the UI when the real backend is not running.

     node web/dev/serve.mjs [port]            (default 5021)
     PERSONA=sam node web/dev/serve.mjs       (phone only: most metrics missing)
     PERSONA=new node web/dev/serve.mjs       (fresh account at onboarding)

   Sign in with any username / "demo". Nothing here is loaded by the app or
   used in production; `npm run demo` is the real thing. */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 5021;
const PERSONA = process.env.PERSONA || 'demo';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/* ── fixtures ───────────────────────────────────────────────── */

let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const around = (m, s) => m + (rnd() - 0.5) * 2 * s;
const TZ = 'Africa/Cairo'; const OFF = 3 * 3600;
const now = Date.now();
const civil = (ms) => new Date(ms + OFF * 1000).toISOString().slice(0, 10);
const TODAY = civil(now);
const dayN = (n) => civil(now - n * 86400000);
const phone = PERSONA === 'sam';
const fresh = PERSONA === 'new';

const state = {
  signedIn: false, username: 'demo', registrationOpen: true,
  onboarding: fresh ? 'profile' : 'done',
  google: fresh ? 'needs_auth' : 'ok',
  units: { distance: 'km', weight: 'kg', temp: 'c' },
  goals: { steps: 8000, activeMinutes: 22, sleepMinutes: 450 },
  privacy: { account: 'public', activity: true, workouts: true, sleep: false, heart: false, body: false },
  profile: { displayName: 'Demo', bio: 'Lifting three days a week.', accent: '#2fbf71', tz: TZ, notes: 'Desk job. Gym 3 days a week.' },
  ai: { keySet: false, last4: null }, detection: { enabled: false, plusBpm: 35, minStartMin: 10, minTotalMin: 20, calmMin: 10, walkSteps: 60, autoCloseMin: 60 },
  running: null, pending: true, push: null, devices: [], keys: [], summaries: {}, sumRunning: null,
};

const caps = () => {
  const on = state.google === 'ok';
  const all = { steps: 1, activeMinutes: 1, calories: 1, distance: 1, heartRate: 1, heartRateMinute: 1, restingHr: 1, hrv: 1, spo2: 1, skinTemp: 1, sleep: 1, sleepStages: 1, weight: 1, bodyFat: 1, exercise: 1, deviceBattery: 1 };
  const out = {};
  for (const k of Object.keys(all)) out[k] = on && (!phone || k === 'steps' || k === 'distance');
  return out;
};
const MISSING = { heartRate: 'Your device does not report heart rate', restingHr: 'Your device does not report resting heart rate', hrv: 'Your device does not report HRV', spo2: 'Your device does not report blood oxygen', skinTemp: 'Your device does not report skin temperature', sleep: 'Your device does not report sleep', sleepStages: 'Your device does not report sleep stages', weight: 'No weigh-ins yet', bodyFat: 'Your device does not report body fat', activeMinutes: 'Your device does not report active minutes', calories: 'Your device does not report calories', heartRateMinute: 'Your device does not report minute-by-minute heart rate', exercise: 'Your device does not record exercises', deviceBattery: 'No paired device' };

function seriesFor(days) {
  seed = 11;
  const c = caps();
  return Array.from({ length: days }, (_, i) => {
    const n = days - 1 - i;
    const last = n === 0;
    const gap = n === 5 || n === 19;
    const steps = gap ? null : Math.round(around(last ? 5200 : 8600, 3400));
    return {
      date: dayN(n),
      steps: c.steps ? steps : null, distanceM: c.distance && steps ? Math.round(steps * 0.74) : null,
      azm: c.activeMinutes && !gap ? Math.round(Math.max(0, around(last ? 12 : 26, 18))) : null, activeMin: null,
      kcal: c.calories && !gap ? Math.round(around(last ? 1320 : 2300, 260)) : null,
      rhr: c.restingHr && !gap ? Math.round(around(58, 3)) : null, rhrBase: c.restingHr ? 57.6 : null, rhrSd: 1.3,
      hrv: c.hrv && !gap ? Math.round(around(51, 7) * 10) / 10 : null, hrvBase: c.hrv ? 51.7 : null, hrvSd: 3.1,
      spo2: c.spo2 && !gap ? Math.round(around(96.3, 0.8) * 10) / 10 : null, spo2Lo: 94.8, spo2Hi: 97.8,
      tempDev: c.skinTemp && !gap ? Math.round(around(0, 0.35) * 100) / 100 : null, tempSd: 0.21,
      sleepMin: c.sleep && !gap ? Math.round(around(435, 55)) : null,
      bodyFat: c.bodyFat && n % 6 === 0 ? Math.round(around(19.4, 0.4) * 10) / 10 : null,
    };
  });
}

function nightsFor(days, withStages) {
  seed = 23;
  const out = [];
  for (let n = Math.min(days, 90) - 1; n >= 0; n -= 1) {
    if (n === 5 || n === 19) continue;
    const date = dayN(n);
    const midnightUtc = Date.parse(`${date}T00:00:00Z`) - OFF * 1000;
    const startMs = Math.round(midnightUtc - around(30, 45) * 60000);
    const asleep = Math.round(around(435, 55));
    const endMs = startMs + (asleep + 20) * 60000;
    const stages = [];
    if (withStages) {
      let t = startMs; const cyc = ['LIGHT', 'DEEP', 'LIGHT', 'REM', 'AWAKE'];
      let k = 0;
      while (t < endMs) { const typ = cyc[k % cyc.length]; const len = (typ === 'AWAKE' ? around(4, 2) : typ === 'DEEP' ? around(22, 8) : typ === 'REM' ? around(24, 8) : around(38, 12)) * 60000; stages.push({ s: Math.round(t), e: Math.round(Math.min(endMs, t + len)), t: typ }); t += len; k += 1; }
    }
    out.push({ id: `n${n}`, date, main: true, startMs, endMs, startOff: OFF, endOff: OFF, asleepMin: asleep, awakeMin: 20, periodMin: asleep + 20, stages,
      summary: { stages: { AWAKE: 20, LIGHT: Math.round(asleep * 0.52), DEEP: Math.round(asleep * 0.2), REM: Math.round(asleep * 0.28) }, toFallAsleep: 6, type: 'STAGES', processed: true, nap: false } });
  }
  return out;
}

const mkWorkout = (id, n, hour, mins, title, source, extra = {}) => {
  const start = Date.parse(`${dayN(n)}T${String(hour).padStart(2, '0')}:10:00Z`) - OFF * 1000;
  return { id: String(id), uid: `uid-${id}`, source, status: 'done', start, end: start + mins * 60000, durationMin: mins, title, type: 'STRENGTH_TRAINING', notes: null,
    avgHr: 112 + (id % 9), maxHr: 141 + (id % 12), steps: 380 + id * 7, kcal: 280 + id * 3, activeMin: mins - 9,
    google: { state: source === 'hevy' ? 'local' : 'saved', name: 'x', error: null, dirty: false },
    sets: source === 'hevy' ? { exercises: 5, sets: 17, volumeKg: 6420 } : null, readOnly: source === 'google',
    prompts: {}, lastEnd: start + mins * 60000, autoClosed: null, updatedAt: now, ...extra };
};
const HISTORY = [mkWorkout(31, 1, 15, 58, 'Push Day', 'hevy'), mkWorkout(30, 3, 16, 64, 'Pull Day', 'hevy'), mkWorkout(29, 4, 7, 32, 'Workout', 'manual'), mkWorkout(28, 6, 15, 71, 'Leg Day', 'hevy'),
  mkWorkout(27, 8, 15, 55, 'Push Day', 'hevy'), { ...mkWorkout(26, 9, 18, 41, 'Run', 'google'), id: 'g-26', type: 'RUNNING', readOnly: true, google: { state: 'foreign' } }, mkWorkout(25, 10, 16, 60, 'Pull Day', 'hevy'), mkWorkout(24, 13, 15, 68, 'Leg Day', 'detected'), mkWorkout(23, 15, 15, 52, 'Workout', 'logged', { google: { state: 'failed', error: 'Google returned 503' } })];
const reviewW = () => ({ ...mkWorkout(40, 0, 9, 47, 'Workout', 'detected'), status: 'review', google: { state: null } });

function workoutsPayload() {
  const c = caps();
  return { running: state.running, pending: state.pending && state.google === 'ok' && !phone ? [reviewW()] : [], history: state.google === 'ok' && !phone ? HISTORY : [], more: false,
    detection: { available: c.heartRateMinute, reason: c.heartRateMinute ? null : 'Workout detection needs minute-by-minute heart rate, which your device does not report', suppressedByLink: false,
      settings: state.detection, bounds: { plusBpm: [10, 60], minStartMin: [5, 30], minTotalMin: [10, 90], calmMin: [5, 30], walkSteps: [30, 140], autoCloseMin: [30, 240] }, rest: 58, threshold: 58 + state.detection.plusBpm, last: { checkedAt: now - 240000, asOf: now - 300000, error: null } },
    exerciseType: 'STRENGTH_TRAINING', exerciseTypes: [{ id: 'STRENGTH_TRAINING', label: 'Strength training' }, { id: 'WEIGHT_MACHINES', label: 'Weight machines' }, { id: 'RUNNING', label: 'Running' }, { id: 'WORKOUT', label: 'Workout' }],
    canWrite: state.google === 'ok', needsReconnect: false, unsaved: 0,
    strength: { muscles: ['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'other'], weeks: Array.from({ length: 12 }, (_, i) => ({ week: dayN((11 - i) * 7), sets: 28 + i, volumeKg: 11000 + i * 160, workouts: 3, byMuscle: {} })), setsPerWeek: 31.5, exercises: [] } };
}

function me() {
  if (!state.signedIn) return { user: null, demo: true, version: '1.0.0-dev', registrationOpen: state.registrationOpen, push: { publicKey: null } };
  const c = caps();
  const ok = state.google === 'ok';
  return { user: { id: 'u1', username: state.username, admin: state.username === 'ojee' || state.username === 'demo' }, demo: true, version: '1.0.0-dev', registrationOpen: state.registrationOpen,
    profile: { username: state.username, ...state.profile, joinedAt: now - 90 * 86400000, onboarding: state.onboarding },
    units: state.units, goals: state.goals, privacy: state.privacy,
    google: { state: state.google, email: ok ? 'demo@example.com' : null, connectedAt: ok ? now - 80 * 86400000 : null, lastRefreshAt: now, expiredAt: state.google === 'expired' ? now - 3600000 : null, testingExpiry: false, refreshError: null,
      scopes: [['activity_and_fitness.readonly', 'Steps, active minutes, calories, distance, exercise'], ['health_metrics_and_measurements.readonly', 'Heart rate, HRV, SpO2, temperature, weight, body fat'], ['sleep.readonly', 'Sleep and sleep stages'], ['settings.readonly', 'Paired devices: battery and last sync'], ['health_metrics_and_measurements.writeonly', 'Saving a weigh-in'], ['activity_and_fitness.writeonly', 'Saving workouts']].map(([scope, label]) => ({ scope, label, granted: ok })),
      canWriteWeight: ok, canWriteWorkouts: ok, missing: [] },
    sync: { running: false, lastRun: now - 260000, lastOk: ok ? now - 260000 : null, lastError: null, nextAt: now + 900000, backoffUntil: null, streams: {} },
    caps: c, capsMeta: { updatedAt: now, windowDays: 14, lastSeen: {}, missing: Object.keys(c).filter((k) => !c[k] && ok).map((k) => ({ cap: k, text: MISSING[k] || `Your device does not report ${k}` })) },
    device: ok && !phone ? { name: 'Fitbit Air', type: 'TRACKER', battery: 64, batteryStatus: 'Medium', lastSync: now - 400000 } : null,
    ai: state.ai, push: { publicKey: null, devices: state.devices.length }, link: { keys: state.keys.length, active: false, detector: false },
    workout: { running: state.running ? state.running.id : null, pending: state.pending && ok && !phone ? 1 : 0 } };
}

function dataPayload(days) {
  const c = caps();
  const series = seriesFor(days);
  const nights = c.sleep ? nightsFor(14, c.sleepStages) : [];
  const ln = nights[nights.length - 1];
  const t = series[series.length - 1];
  return { today: TODAY, tz: TZ, days, connected: state.google === 'ok', empty: false, verdictDay: TODAY, stale: 0,
    readiness: c.hrv ? { date: TODAY, level: 'easy', label: 'Easy day', score: -2, text: 'HRV 12% under your usual and resting heart rate 3 bpm up. Keep today light.', used: ['hrv', 'rhr', 'sleep'], usedText: 'Based on HRV, resting heart rate and sleep', parts: [] }
      : { date: TODAY, level: 'unavailable', label: 'Not available', score: null, text: 'Readiness needs sleep, HRV or resting heart rate, and your device reports none of them.', used: [], usedText: null, parts: [] },
    illness: { flag: false, reasons: [], text: null }, series,
    sleep: { lastNight: ln ? { date: ln.date, asleepMin: ln.asleepMin, periodMin: ln.periodMin, stages: ln.summary.stages, startMs: ln.startMs, endMs: ln.endMs, startOff: OFF, endOff: OFF } : null, consistency: c.sleep ? { nights: 14, bedtime: '23:31', bedtimeSd: 34, wake: '07:02', wakeSd: 41, asleep: 431, asleepSd: 38 } : null, nights },
    activity: { stepTarget: state.goals.steps, azmTarget: state.goals.activeMinutes, sleepTarget: state.goals.sleepMinutes, streak: { steps: 4, azm: 3 }, today: { steps: t.steps, distanceM: t.distanceM, azm: t.azm, activeMin: null, activeMinutes: t.azm, kcal: t.kcal }, exercises: [] },
    weight: weightPayload(days), hr: c.heartRate ? { t: now - 420000, bpm: 64 } : null, device: me().device, caps: c, workout: me().workout };
}
function weightPayload(days) {
  if (!caps().weight) return { latest: null, change30: null, trend: [], points: [] };
  seed = 5;
  const trend = Array.from({ length: days }, (_, i) => { const n = days - 1 - i; const base = 77.1 + n * 0.02; return { date: dayN(n), kg: n % 2 ? Math.round(around(base, 0.5) * 10) / 10 : null, avg7: Math.round(base * 100) / 100 }; });
  return { latest: { date: dayN(1), avg7: 77.08 }, change30: -0.61, trend, points: [] };
}
function trendsPayload(days) {
  const c = caps();
  const series = seriesFor(days);
  const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, i) => ({ week: mondayOf(dayN((Math.ceil(days / 7) - 1 - i) * 7)), days: 7, steps: 58000, stepsAvg: Math.round(around(8500, 900)), distanceM: 40000, activeMinutes: Math.round(around(150, 40)), kcalAvg: 2300, sleepAvgMin: 436, rhrAvg: 58, hrvAvg: 51, workouts: 3, workoutMin: 170 }));
  return { today: TODAY, tz: TZ, days, from: dayN(days - 1), series, weeks, sleep: { nights: c.sleep ? nightsFor(days, c.sleepStages && days <= 30) : [], consistency: c.sleep ? { nights: Math.min(days, 62), bedtime: '23:29', bedtimeSd: 36, wake: '07:01', wakeSd: 40, asleep: 433, asleepSd: 39 } : null },
    weight: weightPayload(days), activity: { stepTarget: state.goals.steps, azmTarget: state.goals.activeMinutes, sleepTarget: state.goals.sleepMinutes, streak: { steps: 4, azm: 3 } }, caps: c };
}
function mondayOf(d) { const c = new Date(`${d}T00:00:00Z`); c.setUTCDate(c.getUTCDate() - ((c.getUTCDay() + 6) % 7)); return c.toISOString().slice(0, 10); }

const PEOPLE = [['mira', 'Mira', '#e2574c', 61230], ['demo', 'Demo', '#2fbf71', 51230], ['lena', 'Lena', '#3aa6e8', 48900], ['noor', 'Noor', '#f29f3d', 44120], ['sam', 'Sam', '#b46cf0', 30210], ['ojee', 'Ojee', '#e8c93a', 28800]];
function leaderboard(metric, period) {
  const scale = { steps: 1, active_minutes: 0.003, workouts: 0.00007, workout_time: 0.0035, distance: 0.74, sleep_consistency: 0.0013 }[metric] * ({ today: 0.15, week: 1, month: 4.2, all: 13 }[period]);
  const unit = { steps: 'steps', active_minutes: 'min', workouts: 'workouts', workout_time: 'min', distance: 'm', sleep_consistency: 'score' }[metric];
  const mine = state.privacy.account === 'public' && (metric === 'sleep_consistency' ? state.privacy.sleep : metric.startsWith('workout') ? state.privacy.workouts : state.privacy.activity);
  let list = PEOPLE.filter(([u]) => u !== 'demo' || mine).map(([username, displayName, accent, v], i) => ({ username, displayName, accent, value: metric === 'sleep_consistency' ? Math.min(96, Math.round(v * 0.0013)) : Math.max(1, Math.round(v * scale)), previous: period === 'all' ? null : Math.round(v * scale * (1 + (i - 2) * 0.06)), me: username === 'demo', detail: metric === 'sleep_consistency' ? { nights: 6, bedtimeSdMin: 22 + i * 4, wakeSdMin: 31 } : null }));
  list.sort((a, b) => b.value - a.value);
  list = list.map((e, i) => ({ rank: i + 1, ...e, trend: e.previous ? Math.round(((e.value - e.previous) / e.previous) * 100) : null }));
  const my = list.find((e) => e.me);
  return { metric, period, unit, higherIsBetter: true, label: { steps: 'Steps', active_minutes: 'Active minutes', workouts: 'Workouts', workout_time: 'Workout time', distance: 'Distance', sleep_consistency: 'Sleep consistency' }[metric], periodLabel: { today: 'Today', week: 'This week', month: 'This month', all: 'All time' }[period], total: list.length, entries: list,
    me: my ? { rank: my.rank, value: my.value, previous: my.previous, trend: my.trend, listed: true, reason: null } : { rank: null, value: null, previous: null, trend: null, listed: false, reason: state.privacy.account === 'private' ? 'Your account is private' : metric === 'sleep_consistency' ? 'Your sleep is private' : 'Your activity is private' } };
}
function userPayload(username) {
  const p = PEOPLE.find(([u]) => u === username);
  if (!p || username === 'kai') return null;
  const isMe = state.signedIn && username === state.username;
  seed = username.length * 31;
  const pv = isMe ? state.privacy : { activity: true, workouts: true, sleep: username === 'lena', heart: username === 'lena', body: false };
  return { username, displayName: isMe ? state.profile.displayName : p[1], bio: isMe ? state.profile.bio : 'Runs on Saturdays.', accent: isMe ? state.profile.accent : p[2], joinedAt: now - 90 * 86400000, me: isMe, private: isMe && state.privacy.account === 'private',
    sections: pv, device: pv.activity ? 'Pixel Watch 4' : null,
    streaks: { stepGoal: pv.activity ? { current: 6, best: 21 } : null, workoutWeeks: pv.workouts ? { current: 9, best: 9 } : null },
    week: { thisWeek: { steps: pv.activity ? p[3] : null, activeMinutes: pv.activity ? 188 : null, distanceM: pv.activity ? 46100 : null, kcal: null, workouts: pv.workouts ? 4 : null, workoutMin: pv.workouts ? 212 : null }, lastWeek: { steps: pv.activity ? 70410 : null, activeMinutes: pv.activity ? 201 : null, distanceM: pv.activity ? 52800 : null, kcal: null, workouts: pv.workouts ? 4 : null, workoutMin: pv.workouts ? 230 : null } },
    records: [...(pv.activity ? [{ kind: 'best_day_steps', label: 'Most steps in a day', value: 24180, unit: 'steps', date: dayN(28) }, { kind: 'best_week_steps', label: 'Most steps in a week', value: 82400, unit: 'steps', date: mondayOf(dayN(33)) }] : []), ...(pv.workouts ? [{ kind: 'longest_workout', label: 'Longest workout', value: 96, unit: 'min', date: dayN(41) }, { kind: 'most_workouts_week', label: 'Most workouts in a week', value: 5, unit: 'workouts', date: mondayOf(dayN(26)) }] : [])],
    recentWorkouts: pv.workouts ? HISTORY.slice(0, 5).map((w) => ({ date: civil(w.start), start: w.start, durationMin: w.durationMin, title: w.title, type: w.type })) : [],
    heatmap: Array.from({ length: 365 }, (_, i) => { const lv = i < 80 ? 0 : Math.floor(rnd() * 5); return { date: dayN(364 - i), level: lv, steps: lv ? 2500 * lv + 900 : null, workouts: lv > 3 ? 1 : 0 }; }),
    sleep: pv.sleep ? { avgMin7: 431, consistency: 82 } : null, heart: pv.heart ? { restingHr: 58, hrv: 51 } : null, body: null };
}
const PUSH_TYPES = [['workout_start', 'Workout started?', 'Asks once when your heart rate looks like a workout has begun.', true], ['workout_end', 'Workout ended?', 'Asks once when a workout looks finished, so you can save it.', true], ['morning', 'Morning readiness', "Your readiness and last night's sleep, once a morning.", true], ['weekly', 'Weekly summary', "The week's headline and next steps, on Sunday evening.", true], ['step_goal', 'Step goal reached', 'When you reach your step goal for the day.', true], ['leaderboard', 'Passed on the leaderboard', "When someone passes you on this week's steps.", false], ['record', 'New personal record', 'When you set a new best.', true], ['battery', 'Device battery low', 'When your tracker is at 20% or less.', true], ['connection', 'Google connection needs attention', 'When Google stops accepting the connection and syncing has stopped.', true]];
function pushPayload() {
  state.push ||= { types: Object.fromEntries(PUSH_TYPES.map((t) => [t[0], t[3]])), quiet: { from: '22:30', to: '07:00' }, morningAt: '07:30', weeklyAt: { day: 'sun', time: '18:00' } };
  return { publicKey: null, types: PUSH_TYPES.map(([id, label, description, def]) => ({ id, label, description, default: def })), prefs: state.push, devices: state.devices };
}
const summaryItem = (window, source) => ({ window, at: now - 3600000, ms: 4210, source, model: source === 'model' ? 'space-bunny-free' : null, why: source === 'rules' ? 'No OpenCode key saved' : null,
  summary: { headline: '7h 12m sleep · 8,412 steps a day · easy day', sections: [{ id: 'sleep', title: 'Sleep', text: 'Seven nights averaging 7 h 12 min, with bedtime drifting later towards the weekend. Deep sleep held steady at about 1 h 25 min.' }, { id: 'heart', title: 'Heart', text: 'Resting heart rate sat at 58 bpm, level with your usual. HRV dipped on Thursday after the late night and has not fully come back.' }, { id: 'activity', title: 'Activity', text: 'You reached your step goal on four of seven days. Three workouts, all strength, totalling 2 h 51 min.' }], nextSteps: ['Bring lights-out forward 30 minutes.', 'Book the third gym day.'], caveats: [] } });
const summaryPayload = () => ({ windows: ['night', 7, 30, 90], running: state.sumRunning, ai: { ...state.ai, models: ['space-bunny-free'] }, notes: state.profile.notes, latest: { 7: summaryItem(7, state.ai.keySet ? 'model' : 'rules'), ...state.summaries } });
const linkPayload = () => ({ keys: state.keys, active: false, detector: false, url: 'https://health.ojee.net' });

/* ── routes ─────────────────────────────────────────────────── */

const fail = (status, code, error) => ({ __status: status, error, code, detail: null });

async function handle(method, path, q, body, raw) {
  const m = `${method} ${path}`;
  if (m === 'GET /api/me') return me();
  if (m === 'GET /api/health') return { ok: true, version: '1.0.0-dev', demo: true, uptimeS: 1 };
  if (m === 'GET /auth/me') return { user: state.signedIn ? { id: 'u1', username: state.username } : null };
  if (m === 'POST /auth/login' || m === 'POST /auth/register') {
    if (!body.username || !body.password) return fail(400, 'bad_request', 'Username and password required');
    if (m === 'POST /auth/register' && body.username.toLowerCase() === 'demo') return fail(400, 'bad_request', 'That username is taken');
    if (m === 'POST /auth/login' && body.password !== 'demo') return fail(401, 'bad_login', 'Wrong username or password');
    state.signedIn = true; state.username = body.username.toLowerCase();
    if (m === 'POST /auth/register') { state.onboarding = 'profile'; state.google = 'needs_auth'; state.profile = { ...state.profile, displayName: body.username, bio: '' }; }
    return { user: { id: 'u1', username: state.username } };
  }
  if (m === 'POST /auth/logout') { state.signedIn = false; return { success: true }; }
  const user = path.match(/^\/api\/users\/([^/]+)$/);
  if (user && method === 'GET') return userPayload(decodeURIComponent(user[1])) || fail(404, 'not_found', 'Not found');
  if (!state.signedIn) return fail(401, 'not_logged_in', 'Not logged in');

  if (m === 'PATCH /api/profile') { for (const k of ['displayName', 'bio', 'accent', 'tz', 'notes']) if (k in body) state.profile[k] = body[k]; if (body.onboarding) state.onboarding = body.onboarding; return me(); }
  if (m === 'PATCH /api/settings') { for (const k of ['units', 'goals', 'privacy']) if (body[k]) Object.assign(state[k], body[k]); return me(); }
  if (m === 'GET /api/data') return dataPayload(Number(q.get('days')) || 30);
  if (m === 'GET /api/trends') return trendsPayload([7, 30, 90, 365].includes(Number(q.get('days'))) ? Number(q.get('days')) : 30);
  if (m === 'POST /api/sync') return state.google === 'ok' ? { result: { ok: true, code: null, message: null, wrote: 12 }, sync: me().sync } : fail(409, 'needs_google', 'Connect Google first');
  if (m === 'POST /api/weight') return { ok: true, point: { t: body.at || now, kg: body.kg, source: 'app' } };
  if (m === 'POST /api/google/disconnect') { state.google = 'needs_auth'; return me(); }

  if (m === 'GET /api/workouts') return workoutsPayload();
  if (m === 'POST /api/workouts/start') { state.running = { ...mkWorkout(50, 0, 0, 0, 'Workout', 'manual'), status: 'running', start: Date.now(), end: null, durationMin: null, avgHr: null, maxHr: null, steps: null, kcal: null, activeMin: null, google: { state: null } }; return workoutsPayload(); }
  if (m === 'POST /api/workouts/log') { HISTORY.unshift({ ...mkWorkout(60 + HISTORY.length, 0, 6, Math.round((body.end - body.start) / 60000), body.title || 'Workout', 'logged'), start: body.start, end: body.end }); return workoutsPayload(); }
  if (m === 'POST /api/workouts/settings') { for (const k of Object.keys(state.detection)) if (k in body) state.detection[k] = body[k]; return workoutsPayload(); }
  if (m === 'POST /api/workouts/check') return workoutsPayload();
  if (m === 'POST /api/workouts/import/hevy') {
    if (!raw || !/title/.test(raw.slice(0, 200))) return fail(400, 'bad_request', 'That file has no workouts in it.');
    const dry = q.get('dryRun') === '1';
    return { ok: true, dryRun: dry, found: 6, imported: 4, merged: 1, skipped: 1, toUpload: q.get('upload') === '1' ? 3 : 0, sets: 96, unknownExercises: ['Sled Push'], errors: [],
      items: [['Push Day', 'imported'], ['Pull Day', 'imported'], ['Leg Day', 'merged'], ['Push Day', 'imported'], ['Arms', 'imported'], ['Pull Day', 'skipped']].map(([title, result], i) => ({ title, start: now - (i + 2) * 2 * 86400000, end: now - (i + 2) * 2 * 86400000 + 3600000, sets: 14 + i, result, id: result === 'imported' && !dry ? String(31 - i) : null, mergedInto: result === 'merged' ? '28' : null })) };
  }
  const wk = path.match(/^\/api\/workouts\/([^/]+)(?:\/(\w+))?$/);
  if (wk) {
    const id = decodeURIComponent(wk[1]); const act = wk[2];
    const w = state.running?.id === id ? state.running : id === '40' ? reviewW() : HISTORY.find((x) => x.id === id);
    if (!w) return fail(404, 'not_found', 'No such workout');
    if (method === 'GET' && !act) {
      seed = 3;
      const trace = w.status === 'running' ? [] : Array.from({ length: w.durationMin + 40 }, (_, i) => { const inside = i >= 20 && i < w.durationMin + 20; return [w.start - 20 * 60000 + i * 60000, Math.round(inside ? around(118 + Math.sin(i / 5) * 14, 7) : around(72, 5)), inside ? 4 : 30]; });
      return { ...w, trace, traceReason: trace.length ? null : 'Heart rate appears a few minutes after it is recorded.', threshold: 93,
        exercises: w.sets ? [['Bench Press (Barbell)', [[70, 8], [70, 8], [70, 7], [65, 9]]], ['Incline Dumbbell Press', [[26, 10], [26, 9], [26, 8]]], ['Shoulder Press (Machine)', [[40, 12], [45, 10], [45, 9]]], ['Triceps Pushdown', [[25, 15], [30, 12], [30, 11]]]].map(([name, sets]) => ({ name, muscle: 'chest', notes: name.startsWith('Bench') ? 'Paused reps on the last set.' : null, supersetId: null, sets: sets.map(([kg, reps], index) => ({ index, type: index === 0 && name.startsWith('Bench') ? 'warmup' : 'normal', kg, reps, distanceM: null, durationS: null, rpe: index === 2 ? 8 : null })) })) : [] };
    }
    if (method === 'DELETE') { const i = HISTORY.findIndex((x) => x.id === id); if (i >= 0) HISTORY.splice(i, 1); return workoutsPayload(); }
    if (method === 'PATCH') { Object.assign(w, body); return workoutsPayload(); }
    if (act === 'end' || act === 'dismiss' || act === 'save' || act === 'confirm') {
      if (state.running?.id === id) { if (act === 'end') HISTORY.unshift({ ...state.running, status: 'done', end: Date.now(), durationMin: Math.max(1, Math.round((Date.now() - state.running.start) / 60000)), google: { state: 'pending' } }); state.running = null; }
      if (id === '40') { state.pending = false; if (act === 'save') HISTORY.unshift({ ...reviewW(), status: 'done', ...(body.start ? { start: body.start, end: body.end } : {}), google: { state: 'pending' } }); }
      return workoutsPayload();
    }
    if (act === 'retry') { w.google = { state: 'pending' }; return workoutsPayload(); }
  }

  if (m === 'GET /api/summary') { if (state.sumRunning && Date.now() - state.sumRunning.startedAt > 5000) { state.summaries[state.sumRunning.window] = summaryItem(state.sumRunning.window, state.ai.keySet ? 'model' : 'rules'); state.summaries[state.sumRunning.window].at = Date.now(); state.sumRunning = null; } return summaryPayload(); }
  if (m === 'POST /api/summary') { state.sumRunning = { window: body.window, startedAt: Date.now() }; return { __status: 202, ...summaryPayload() }; }
  if (m === 'PUT /api/ai/key') { state.ai = { keySet: true, last4: String(body.key).slice(-4) }; return state.ai; }
  if (m === 'DELETE /api/ai/key') { state.ai = { keySet: false, last4: null }; return state.ai; }
  if (m === 'POST /api/ai/test') return (body.key || '').startsWith('sk-') || (!body.key && state.ai.keySet) ? { ok: true, model: 'space-bunny-free', ms: 812 } : { ok: false, reason: 'OpenCode rejected the key', tried: [] };

  if (m === 'GET /api/leaderboard') return leaderboard(q.get('metric') || 'steps', q.get('period') || 'week');
  if (m === 'GET /api/people') return { people: PEOPLE.map(([username, displayName, accent]) => ({ username, displayName, accent, joinedAt: now, me: username === state.username })) };
  if (m === 'GET /api/compare') {
    const b = PEOPLE.find(([u]) => u === q.get('with'));
    if (!b) return fail(404, 'not_found', 'Not found');
    return { period: q.get('period') || 'week', periodLabel: 'This week', a: { username: state.username, displayName: state.profile.displayName, accent: state.profile.accent }, b: { username: b[0], displayName: b[1], accent: b[2] },
      metrics: [['steps', 'Steps', 'steps', 51230, b[3]], ['active_minutes', 'Active minutes', 'min', 141, 188], ['workouts', 'Workouts', 'workouts', 3, 4], ['workout_time', 'Workout time', 'min', 171, 212], ['distance', 'Distance', 'm', 38400, 46100], ['sleep_consistency', 'Sleep consistency', 'score', null, null]].map(([metric, label, unit, a, bv]) => ({ metric, label, unit, higherIsBetter: true, a, b: bv })) };
  }

  if (m === 'GET /api/push') return pushPayload();
  if (m === 'PUT /api/push/prefs') { pushPayload(); if (body.types) Object.assign(state.push.types, body.types); for (const k of ['quiet', 'morningAt', 'weeklyAt']) if (k in body) state.push[k] = body[k]; return pushPayload(); }
  if (m === 'POST /api/push/subscribe') { const id = `d_${state.devices.length + 1}`; state.devices.push({ id, label: body.label || 'Device', enabled: true, types: null, createdAt: Date.now(), lastOkAt: null, lastError: null }); return { ...pushPayload(), deviceId: id }; }
  if (m === 'POST /api/push/test') return state.devices.length ? { sent: state.devices.length, failed: 0, removed: 0, errors: [] } : fail(409, 'conflict', 'No device to send to');
  const dev = path.match(/^\/api\/push\/devices\/([^/]+)$/);
  if (dev) { const i = state.devices.findIndex((d) => d.id === dev[1]); if (i >= 0) { if (method === 'DELETE') state.devices.splice(i, 1); else Object.assign(state.devices[i], body); } return pushPayload(); }

  if (m === 'GET /api/link') return linkPayload();
  if (m === 'POST /api/link/keys') { state.keys.push({ id: `k_${state.keys.length + 1}`, label: body.label || 'Link key', last4: 'x7Qd', createdAt: Date.now(), lastSeenAt: null, detector: false }); return { ...linkPayload(), key: 'hlk_3f9a1c7e5b2d4a6f8091a2b3c4d5x7Qd' }; }
  const key = path.match(/^\/api\/link\/keys\/([^/]+)$/);
  if (key && method === 'DELETE') { state.keys = state.keys.filter((k) => k.id !== key[1]); return linkPayload(); }

  if (m === 'POST /api/account/delete-data') { if (body.confirm !== state.username) return fail(400, 'bad_request', 'Type your username exactly to confirm.'); state.onboarding = 'profile'; state.google = 'needs_auth'; return { ok: true }; }
  const adminPayload = () => ({ registrationOpen: state.registrationOpen, people: PEOPLE.map(([username, displayName], i) => ({ id: `u${i}`, username, displayName, joinedAt: now - 90 * 86400000, lastSeenAt: now - i * 5400000, private: false, google: i === 4 ? 'needs_auth' : i === 3 ? 'expired' : 'ok', lastSyncAt: i === 4 ? null : now - i * 600000, syncError: i === 3 ? { code: 'needs_auth', message: 'Google revoked the grant' } : null, nextSyncAt: now + 600000, pushDevices: i % 2, linkKeys: i === 5 ? 1 : 0, aiKey: i === 0, detection: i < 2 })),
    server: { version: '1.0.0-dev', node: process.version, startedAt: now - 83200000, uptimeS: 83200, demo: true, memoryMb: 92, worlds: { open: 4, max: 40 }, scheduler: { inFlight: 0, maxInFlight: 3, runs: 412, failures: 2, lastRunAt: now }, google: { configured: true, redirectUri: '' }, push: { configured: false }, mongo: { ok: true } } });
  if (m === 'GET /api/admin') return adminPayload();
  if (m === 'POST /api/admin/registration') { state.registrationOpen = Boolean(body.open); return adminPayload(); }
  return fail(404, 'not_found', `No fixture for ${m}`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, type, bodyOut, extra = {}) => { res.writeHead(status, { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...extra }); res.end(bodyOut); };
  try {
    if (url.pathname === '/auth/google/start') {
      state.google = 'ok';
      const ret = url.searchParams.get('return') || '/settings/connections';
      res.writeHead(302, { location: `${ret.startsWith('/') ? ret : '/'}?google=connected` }); res.end(); return;
    }
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write('event: hello\ndata: {"at":0}\n\n'); return; }
    if (url.pathname === '/api/export') { send(200, 'application/json', JSON.stringify({ profile: state.profile }), { 'content-disposition': 'attachment; filename="health-demo.json"' }); return; }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {}; try { body = raw && (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : {}; } catch { body = {}; }
      await new Promise((r) => setTimeout(r, Number(process.env.DELAY) || 60));
      const out = await handle(req.method, url.pathname, url.searchParams, body, raw);
      const status = out.__status || 200; delete out.__status;
      send(status, 'application/json', JSON.stringify(out)); return;
    }
    const ext = extname(url.pathname);
    const file = ext ? normalize(join(ROOT, url.pathname)) : join(ROOT, 'index.html');
    if (!file.startsWith(ROOT)) { send(403, 'text/plain', 'no'); return; }
    try { send(200, TYPES[ext || '.html'] || 'application/octet-stream', await readFile(file), url.pathname === '/sw.js' ? { 'service-worker-allowed': '/' } : {}); } catch { send(404, 'text/plain', 'Not found'); }
  } catch (err) { send(500, 'application/json', JSON.stringify({ error: String(err?.stack || err), code: 'server_error' })); }
}).listen(PORT, '127.0.0.1', () => console.log(`fixtures on http://localhost:${PORT}  (persona: ${PERSONA})`));
