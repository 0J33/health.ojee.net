/* ============================================================
   health.ojee.net — Samsung Health (and anything else in Android's
   Health Connect), sent by the Android app.

   Samsung Health keeps a watch's data on the phone and writes it to
   Health Connect; nothing of it reaches Google Health. The Android app
   (ojee-health-app, @capgo/capacitor-health) reads Health Connect while
   it is open and sends what it read here (POST /api/hc/upload), already
   summed into days in the phone's time zone. It lands in the person's
   Health Connect store (data/users/<id>/src/hc.sqlite) in the same
   tables and shapes Google's and Garmin's syncs write, and the fold
   (core/merge.js) puts it with the rest, so a Samsung person has Today,
   sleep, the scores, the boards and their workouts like anybody else.

     days       steps, distance, calories (total, active, resting),
                floors, active minutes, resting, lowest, highest and
                mean heart rate, HRV, blood oxygen, breathing rate,
                VO2 max, body fat
     nights     each night with its stages (deep, light, REM, awake)
     workouts   type, times, calories, distance, heart rate
     weigh-ins  each one
     hours      a day's heart rate by the hour (kind 'hrhours', as
                Garmin's), and the newest pulse

   What the phone sends is checked here: every number in its range,
   dates and times real, a bounded amount per request.
   ============================================================ */

import { addDays, localToMs, utcOffsetSec, today as todayIn } from './core/util.js';
import { GOOGLE_EXERCISE_TYPES } from './core/workouts.js';

const HOUR = 3_600_000;
const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The daily numbers kept, each with the range a real one falls in. */
export const HC_DAILY = {
  steps: [0, 200_000], distance_m: [0, 500_000], kcal: [0, 20_000], kcal_active: [0, 15_000], kcal_basal: [0, 10_000],
  floors: [0, 2_000], active_min: [0, 1_440], rhr: [20, 200], hr_min: [20, 250], hr_max: [30, 250], hr_avg: [20, 250],
  hrv: [1, 400], spo2: [50, 100], resp: [3, 60], vo2max: [10, 100], body_fat: [1, 80],
};
export const HC_DEFAULTS = { prefer: 'hc' };

export function hcMeta(db) {
  const m = db.meta('hc', null) || {};
  const s = { ...HC_DEFAULTS, ...(m.settings || {}) };
  if (!['hc', 'google'].includes(s.prefer)) s.prefer = HC_DEFAULTS.prefer;
  return { ...m, settings: s };
}
export function setHcMeta(db, patch) {
  const next = { ...hcMeta(db), ...patch };
  db.setMeta('hc', next);
  return next;
}

const num = (v, [lo, hi]) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const ms = (v) => { const n = typeof v === 'string' ? Date.parse(v) : Number(v); return Number.isFinite(n) && n > Date.UTC(2010, 0, 1) && n < Date.now() + 2 * 86_400_000 ? n : null; };
const STAGES = { deep: 'DEEP', light: 'LIGHT', rem: 'REM', awake: 'AWAKE', asleep: 'LIGHT', inBed: 'AWAKE' };

/** Health Connect's exercise words (the plugin's WorkoutType) as the app's types (Google's names). */
const TYPE = {
  running: 'RUNNING', runningTreadmill: 'TREADMILL', walking: 'WALKING', hiking: 'HIKING', cycling: 'BIKING', bikingStationary: 'STATIONARY_BIKE',
  swimming: 'SWIMMING', swimmingPool: 'SWIMMING_POOL', swimmingOpenWater: 'SWIMMING_OPEN_WATER', rowing: 'ROWING', rowingMachine: 'ROWING_MACHINE',
  elliptical: 'ELLIPTICAL', stairClimbing: 'STAIRCLIMBER', stairClimbingMachine: 'STAIRCLIMBER', yoga: 'YOGA', pilates: 'PILATES',
  highIntensityIntervalTraining: 'HIIT', strengthTraining: 'STRENGTH_TRAINING', traditionalStrengthTraining: 'WEIGHTS', functionalStrengthTraining: 'STRENGTH_TRAINING',
  weightlifting: 'WEIGHTS', calisthenics: 'CALISTHENICS', dancing: 'DANCING', dance: 'DANCING', boxing: 'BOXING', martialArts: 'MARTIAL_ARTS',
  soccer: 'SOCCER', basketball: 'BASKETBALL', tennis: 'TENNIS', badminton: 'BADMINTON', volleyball: 'VOLLEYBALL', golf: 'GOLF',
  crossTraining: 'CROSSFIT', jumpRope: 'JUMPING_ROPE', stretching: 'STRETCHING', meditation: 'MEDITATE', other: 'WORKOUT',
};
export const hcType = (t) => { const g = TYPE[t] || 'WORKOUT'; return GOOGLE_EXERCISE_TYPES.has(g) ? g : 'WORKOUT'; };
const typeName = (t) => String(t || 'Workout').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Keep one upload. `body`: { tz, days: [{ date, ...HC_DAILY }], nights: [{ startMs, endMs, stages: [{ s, e, stage }] }],
 * workouts: [{ id, type, startMs, endMs, kcal, distanceM, avgHr, name }], weights: [{ t, kg }],
 * hours: [{ date, hours: [{ start, min, max, avg }] }], latest: { t, bpm }, device }.
 * @returns {{ days, nights, workouts, weighIns, wrote, touched: string[] }}
 */
export function applyHc({ main, src, body, tz, now = Date.now() }) {
  if (!body || typeof body !== 'object') throw bad('Send what Health Connect gave.');
  const list = (k, max) => { const v = body[k]; if (v === undefined) return []; if (!Array.isArray(v)) throw bad(`${k} must be a list.`); if (v.length > max) throw bad(`At most ${max} ${k} at once.`); return v; };
  const days = list('days', 400); const nights = list('nights', 400); const workouts = list('workouts', 1000); const weights = list('weights', 1000); const hours = list('hours', 60);
  const out = { days: 0, nights: 0, workouts: 0, weighIns: 0, wrote: 0, touched: [] };
  const touched = new Set();
  const today = todayIn(now, tz);
  let newest = 0;
  src.tx(() => {
    for (const d of days) {
      if (!DATE.test(d?.date || '') || d.date > addDays(today, 1)) continue;
      let any = false;
      for (const [k, range] of Object.entries(HC_DAILY)) {
        const v = num(d[k], range);
        if (v === null) continue;
        const val = Math.round(v * 10) / 10;
        if (src.dailyValue(d.date, k) !== val) { src.setDaily(d.date, k, val); out.wrote += 1; }
        any = true;
      }
      if (any) { touched.add(d.date); out.days += 1; }
    }
    for (const n of nights) {
      const startMs = ms(n?.startMs); const endMs = ms(n?.endMs);
      if (!startMs || !endMs || endMs <= startMs || endMs - startMs > 20 * HOUR) continue;
      const stages = (Array.isArray(n.stages) ? n.stages : []).slice(0, 2000).map((x) => ({ s: ms(x?.s), e: ms(x?.e), t: STAGES[x?.stage] }))
        .filter((x) => x.s && x.e && x.e > x.s && x.t && x.s >= startMs - HOUR && x.e <= endMs + HOUR).sort((a, b) => a.s - b.s);
      const byStage = {};
      for (const x of stages) byStage[x.t] = (byStage[x.t] || 0) + (x.e - x.s) / 60_000;
      for (const k of Object.keys(byStage)) byStage[k] = Math.round(byStage[k]);
      const periodMin = Math.round((endMs - startMs) / 60_000);
      const awakeMin = Math.round(byStage.AWAKE || 0);
      const asleepMin = Math.max(0, stages.length ? Math.round((byStage.DEEP || 0) + (byStage.LIGHT || 0) + (byStage.REM || 0)) : periodMin - awakeMin);
      const startOff = utcOffsetSec(startMs, tz); const endOff = utcOffsetSec(endMs, tz);
      const date = new Date(endMs + endOff * 1000).toISOString().slice(0, 10);
      const deep = stages.some((x) => x.t === 'DEEP' || x.t === 'REM');
      const row = {
        id: `hc-sleep-${startMs}`, date, startMs, endMs, startOff, endOff, main: periodMin >= 180, asleepMin, awakeMin, periodMin, stages,
        summary: { stages: byStage, toFallAsleep: null, afterWake: null, shortAwakenings: null, stagesStatus: deep ? 'SUCCEEDED' : null, type: deep ? 'STAGES' : 'CLASSIC', processed: true, nap: periodMin < 180, source: 'hc' },
      };
      const cur = src.sleeps(addDays(date, -1)).find((x) => x.id === row.id);
      if (!cur || JSON.stringify(cur) !== JSON.stringify(row)) { src.upsertSleep(row); out.wrote += 1; }
      out.nights += 1; touched.add(date); newest = Math.max(newest, endMs);
    }
    for (const h of hours) {
      if (!DATE.test(h?.date || '') || !Array.isArray(h.hours) || !h.hours.length) continue;
      const hrs = h.hours.slice(0, 24).map((x) => ({ start: ms(x?.start), min: num(x?.min, [20, 250]), max: num(x?.max, [20, 250]), avg: num(x?.avg, [20, 250]) }))
        .filter((x) => x.start && x.avg !== null).map((x) => ({ start: x.start, end: x.start + HOUR, min: x.min ?? x.avg, max: x.max ?? x.avg, avg: Math.round(x.avg * 10) / 10 }));
      if (!hrs.length) continue;
      const t = localToMs(h.date, 0, tz);
      const avg = hrs.reduce((a, x) => a + x.avg, 0) / hrs.length;
      src.sampleUpsert({ kind: 'hrhours', t, end: localToMs(addDays(h.date, 1), 0, tz), off: utcOffsetSec(t, tz), date: h.date, value: Math.round(avg * 10) / 10, data: { hours: hrs }, device: String(body.device || 'Health Connect').slice(0, 60), source: 'hc' }, now);
      newest = Math.max(newest, hrs[hrs.length - 1].start);
    }
    for (const w of workouts) {
      const startMs = ms(w?.startMs); const endMs = ms(w?.endMs);
      if (!startMs || !endMs || endMs <= startMs || endMs - startMs > 48 * HOUR) continue;
      const id = `hc-${String(w.id || startMs).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || startMs}`;
      const off = utcOffsetSec(startMs, tz);
      src.upsertExercise({
        id, date: new Date(startMs + off * 1000).toISOString().slice(0, 10), startMs, endMs, type: hcType(w.type), name: String(w.name || typeName(w.type)).slice(0, 80),
        kcal: num(w.kcal, [0, 20_000]), azm: null, avgHr: num(w.avgHr, [20, 250]), steps: num(w.steps, [0, 200_000]), distanceM: num(w.distanceM, [0, 1_000_000]),
        device: String(w.source || body.device || 'Health Connect').slice(0, 60),
      });
      out.workouts += 1; touched.add(new Date(startMs + off * 1000).toISOString().slice(0, 10)); newest = Math.max(newest, endMs);
    }
    for (const x of weights) {
      const t = ms(x?.t); const kg = num(x?.kg, [20, 400]);
      if (!t || kg === null) continue;
      const grams = Math.round(kg * 1000);
      const off = utcOffsetSec(t, tz);
      const cur = src.weights(t).find((y) => y.t === t);
      if (!cur || cur.grams !== grams) { src.upsertWeight({ t, grams, off, source: 'hc', note: null }); out.weighIns += 1; out.wrote += 1; }
    }
    const lt = ms(body.latest?.t); const bpm = num(body.latest?.bpm, [20, 250]);
    if (lt && bpm !== null) { const cur = src.meta('hr'); if (!cur || lt >= cur.t) src.setMeta('hr', { t: lt, bpm: Math.round(bpm) }); newest = Math.max(newest, lt); }
    if (out.wrote || newest) {
      const dev = src.meta('device');
      src.setMeta('device', { name: String(body.device || dev?.name || 'Health Connect').slice(0, 60), type: 'TRACKER', battery: null, batteryStatus: null, lastSync: Math.max(dev?.lastSync || 0, newest || 0) || null });
    }
  });
  // Total calories, where only the active part came: active plus the resting
  // burn, from the newest weight and body fat on or before the day
  // (Katch-McArdle, 370 + 21.6 per kg of lean mass; without body fat, about
  // 22 kcal a kg). Today's resting part grows through the day.
  src.tx(() => {
    const ws = src.weights(0);
    const fats = src.dailyTable('0000-00-00');
    const est = new Set(src.meta('kcalEstimated', []) || []);
    // Every day with active calories (a few hundred at most), so a weigh-in that came later reaches the days before it too.
    for (const date of Object.keys(fats).filter((dt) => Number.isFinite(fats[dt].kcal_active))) {
      const active = src.dailyValue(date, 'kcal_active');
      // Worked out only where Health Connect gave no total (or it was worked out here before).
      if (!Number.isFinite(active) || (Number.isFinite(src.dailyValue(date, 'kcal')) && !est.has(date))) continue;
      const end = localToMs(addDays(date, 1), 0, tz);
      const w = [...ws].reverse().find((x) => x.t < end);
      if (!w) continue;
      const kg = w.grams / 1000;
      const fatDate = Object.keys(fats).filter((d) => d <= date && Number.isFinite(fats[d].body_fat)).sort().pop();
      const fat = fatDate ? fats[fatDate].body_fat : null;
      const bmr = Number.isFinite(fat) ? 370 + 21.6 * kg * (1 - fat / 100) : 22 * kg;
      const part = date === today ? Math.min(1, Math.max(0, (now - localToMs(date, 0, tz)) / 86_400_000)) : 1;
      const basal = Math.round(bmr * part);
      src.setDaily(date, 'kcal_basal', basal);
      src.setDaily(date, 'kcal', Math.round(active + basal));
      est.add(date); touched.add(date);
      out.wrote += 1;
    }
    src.setMeta('kcalEstimated', [...est].sort().slice(-800));
  });
  out.touched = [...touched];
  // What Health Connect lets the app read, as the phone says.
  const perms = body.perms && Array.isArray(body.perms.granted) ? { granted: body.perms.granted.slice(0, 40).map(String), denied: (body.perms.denied || []).slice(0, 40).map(String), at: now } : undefined;
  setHcMeta(main, { ...(perms ? { perms } : {}), lastUpload: now, lastResult: { at: now, days: out.days, nights: out.nights, workouts: out.workouts, weighIns: out.weighIns } });
  return out;
}
