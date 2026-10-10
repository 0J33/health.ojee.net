/* ============================================================
   health.ojee.net — demo data: a stand-in Google, per persona.

   Demo mode and the tests have no Google to read. So this stands in
   for it: it answers the same URLs with replies
   shaped exactly like the real API's (int64s as strings, durations as
   "10800s", civil dates as objects), and demo mode runs the REAL
   poller and the REAL parser against it. Every panel is therefore
   built from the same code path the live data will take — the only
   thing that is fake is the far end.

   The numbers are synthetic but have realistic shapes: weekday and
   weekend steps, a hard training block three weeks ago that dents HRV
   and lifts resting HR, sleep in ~90-minute cycles with more deep
   sleep early and more REM late, a weight that drifts down through
   daily noise. It is deterministic per date, so a reload does not
   reshuffle history.

   People wear different things, and the app has to adapt to each. A
   PERSONA says what a fake person's device reports: a Fitbit with
   everything, a watch with no HRV, a phone that only counts steps.
   A stream the persona lacks answers with an empty list, which is
   exactly what Google does for a data type a device never wrote.

   Every time here is in the fake person's own zone (`tz`), never the
   process's.
   ============================================================ */

import { addDays, daysBetween, dateObj, today as todayIn, utcOffsetSec, localToMs } from './util.js';

const ALL = ['steps', 'distance', 'azm', 'kcal', 'rhr', 'hrv', 'spo2', 'temp', 'sleep', 'sleepStages', 'weight', 'bodyFat', 'exercise', 'hr', 'hrMinute', 'battery'];
const persona = (o) => ({ seed: '', stepScale: 1, liftDays: [1, 3, 5], runDays: [6], gym: false, platform: 'FITBIT', ...o, has: new Set(o.has || ALL) });

/** The fake people's devices. `has` is what the device reports. */
export const PERSONAS = {
  // A Fitbit Air with everything, and a gym session a little while ago.
  fitbit: persona({ device: { name: 'Fitbit Air', type: 'TRACKER', battery: 64, status: 'Medium', form: 'FITNESS_BAND' }, gym: true }),
  // A Pixel Watch: no skin temperature, no body fat. A runner.
  pixel: persona({ seed: 'pixel', stepScale: 1.25, liftDays: [2], runDays: [1, 3, 6], device: { name: 'Pixel Watch 4', type: 'TRACKER', battery: 41, status: 'Medium', form: 'WATCH' }, has: ALL.filter((x) => x !== 'temp' && x !== 'bodyFat') }),
  // A phone in a pocket: steps and distance, nothing else. No paired device.
  phone: persona({ seed: 'phone', stepScale: 0.7, liftDays: [], runDays: [], platform: 'HEALTH_CONNECT', device: null, has: ['steps', 'distance'] }),
  // A Garmin through Health Connect: no HRV, no SpO2, sleep without stages,
  // plain active minutes instead of zone minutes.
  garmin: persona({ seed: 'garmin', stepScale: 1.1, liftDays: [2, 4], runDays: [0], platform: 'HEALTH_CONNECT', device: null, has: ['steps', 'distance', 'activeMin', 'kcal', 'rhr', 'sleep', 'weight', 'exercise', 'hr', 'hrMinute'] }),
  // An Apple Watch through Apple Health: no paired-device battery, no zones.
  apple: persona({ seed: 'apple', stepScale: 0.95, liftDays: [1, 4], runDays: [6], platform: 'HEALTH_KIT', device: null, has: ['steps', 'distance', 'activeMin', 'kcal', 'rhr', 'hrv', 'spo2', 'sleep', 'sleepStages', 'weight', 'exercise', 'hr', 'hrMinute'] }),
  // The same band on another wrist.
  fitbit3: persona({ seed: 'ojee', stepScale: 1.05, liftDays: [0, 2, 4], device: { name: 'Fitbit Air', type: 'TRACKER', battery: 82, status: 'High', form: 'FITNESS_BAND' } }),
  // A second Fitbit, with its own numbers.
  fitbit2: persona({ seed: 'fitbit2', stepScale: 0.9, device: { name: 'Fitbit Charge 7', type: 'TRACKER', battery: 17, status: 'Low', form: 'FITNESS_BAND' } }),
};


/* ── a seeded generator per date ────────────────────────────────── */

function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => { let u = 0; let v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dur = (s) => `${Math.round(s)}s`;

/** The zone-dependent helpers, for one fake person's zone. */
function zone(tz) {
  /** The wearer's UTC offset at an instant. */
  const offsetAt = (t) => utcOffsetSec(t, tz);
  /** An instant from a local civil date and minutes after its midnight. */
  const localMs = (date, minutes) => localToMs(date, minutes, tz);
  const civil = (t) => {
    const d = new Date(t + offsetAt(t) * 1000);
    return { date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, time: { hours: d.getUTCHours(), minutes: d.getUTCMinutes() } };
  };
  return { offsetAt, localMs, civil };
}

/** Everything about one synthetic day. `k` is days before today. */
export function dayModel(date, todayDate, now, { tz = undefined, p = PERSONAS.fitbit } = {}) {
  const { localMs } = zone(tz);
  const LIFT_DAYS = new Set(p.liftDays);
  const RUN = new Set(p.runDays);
  const r = rng(`ojee-health:${p.seed}${date}`);
  const k = daysBetween(date, todayDate);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const RUN_DAY = RUN.has(dow) ? dow : -1;
  // The first persona's last two days are pinned (below); the others are drawn.
  const pin = !p.seed;
  const person = rng(`person:${p.seed}`);
  const hrv0 = p.seed ? 38 + 30 * person() : 52;
  const rhr0 = p.seed ? 50 + 14 * person() : 57;
  const kg0 = p.seed ? 58 + 34 * person() : 77.1;
  const weekend = dow === 5 || dow === 6;
  // A hard block 18-24 days ago; the last two nights a little run down.
  const block = k >= 18 && k <= 24 ? 1 : 0;
  const rundown = k <= 1 ? 1 : 0;

  // The last two days are pinned rather than drawn, so the demo opens on a
  // morning worth reading: HRV down, resting HR up a little, an easy day.
  const hrv = pin && k === 0 ? 45.4 : pin && k === 1 ? 48.9 : hrv0 - 7 * block - (pin ? 6.5 * rundown : 0) + 3.2 * gauss(r);
  const rhr = pin && k === 0 ? 61 : pin && k === 1 ? 60 : rhr0 + 2 * block + (pin ? 3.4 * rundown : 0) + 1.1 * gauss(r);

  // Steps: today is only as far through as the clock is.
  const frac = k === 0 ? Math.min(1, Math.max(0.05, ((now - localMs(date, 0)) / 86_400_000))) : 1;
  // A four-day step streak running into today, and three days of zone minutes.
  const streak = k >= 1 && k <= 4;
  const steps = Math.max(streak && pin ? 8300 + 1400 * r() : 900, ((weekend ? 10_800 : 7600) + (weekend ? 3200 : 2400) * gauss(r) + (dow === RUN_DAY ? 4200 : 0)) * p.stepScale) * frac;
  const azmBase = Math.max(k >= 1 && k <= 3 ? 24 : 0, 14 + 9 * gauss(r) + (LIFT_DAYS.has(dow) ? 10 : 0) + (dow === RUN_DAY ? 30 : 0)) * frac;
  const azmPeak = dow === RUN_DAY ? Math.round(azmBase * 0.2) : 0;
  const azmCardio = Math.round(azmBase * (dow === RUN_DAY ? 0.5 : 0.25));
  const azmFat = Math.max(0, Math.round(azmBase) - azmPeak - azmCardio);

  // Sleep ending on this date's morning.
  const bed = pin && k === 0 ? 23 * 60 + 34 - 1440 : 23 * 60 + 20 + 32 * gauss(r) + (weekend ? 50 : 0) - 1440;   // minutes from this date's midnight (negative = the evening before)
  const lenMin = pin && k === 0 ? 452 : Math.max(300, 432 + 40 * gauss(r) - 30 * block);

  return {
    date, k, dow,
    hrv: Math.max(18, hrv), rhr: Math.round(rhr),
    steps: Math.round(steps), kcal: Math.round((1900 + steps * 0.045 + 60 * gauss(r)) * (k === 0 ? frac : 1)),
    azm: { fat: azmFat, cardio: azmCardio, peak: azmPeak },
    spo2: Math.min(99.4, 96.3 + 0.7 * gauss(r)),
    temp: { base: 33.9, nightly: 33.9 + 0.17 * gauss(r) + (block ? 0.1 : 0), sd: 0.21 },
    sleep: { bed, len: lenMin, seed: `sleep:${date}` },
    weighed: r() < 0.8,
    kg: kg0 + 0.022 * k + 0.33 * gauss(r),
    // A stride of roughly 0.74 m, a little longer on a run day.
    distanceM: Math.round(steps * (dow === RUN_DAY ? 0.82 : 0.74)),
    fatPct: 19.4 + 0.012 * k + 0.3 * gauss(r),
    lift: LIFT_DAYS.has(dow) && k > 0,
    run: dow === RUN_DAY && k > 0,
    sleepStart: localMs(date, bed),
  };
}

/** A night of sleep stages in ~90-minute cycles. */
function stagesFor(m) {
  const r = rng(m.sleep.seed);
  const start = m.sleepStart;
  const end = start + m.sleep.len * 60_000;
  const segs = [];
  let t = start;
  const push = (type, min) => {
    const e = Math.min(end, t + Math.max(1, min) * 60_000);
    if (e > t) segs.push({ type, s: t, e });
    t = e;
  };
  push('AWAKE', 4 + 6 * r());
  for (let cycle = 0; t < end; cycle += 1) {
    const late = Math.min(1, cycle / 4);
    push('LIGHT', 22 + 12 * r());
    push('DEEP', Math.max(3, (30 - 24 * late) + 6 * gauss(r)));
    push('LIGHT', 8 + 8 * r());
    push('REM', Math.max(4, (10 + 22 * late) + 5 * gauss(r)));
    if (r() < 0.45) push('AWAKE', 1 + 5 * r());
  }
  return { start, end, segs };
}

/* ── the data points ────────────────────────────────────────────── */

function sleepPoint(m, { offsetAt, civil }, p) {
  const { start, end, segs } = stagesFor(m);
  if (!p.has.has('sleepStages')) {
    // A device that only knows asleep / not asleep: no stages, a summary.
    const period = (end - start) / 60_000;
    const awake = Math.round(period * 0.06);
    return {
      name: `users/me/dataTypes/sleep/dataPoints/demo-${m.date}`,
      sleep: {
        interval: { startTime: iso(start), endTime: iso(end), startUtcOffset: dur(offsetAt(start)), endUtcOffset: dur(offsetAt(end)), civilStartTime: civil(start), civilEndTime: civil(end) },
        type: 'CLASSIC',
        metadata: { mainSleep: true, nap: false, processed: true },
        summary: { minutesAsleep: String(Math.round(period - awake)), minutesAwake: String(awake), minutesInSleepPeriod: String(Math.round(period)) },
      },
      dataSource: { platform: p.platform, recordingMethod: 'PASSIVELY_MEASURED' },
    };
  }
  const sum = {};
  for (const s of segs) sum[s.type] = (sum[s.type] || 0) + (s.e - s.s) / 60_000;
  const awake = sum.AWAKE || 0;
  const period = (end - start) / 60_000;
  return {
    name: `users/me/dataTypes/sleep/dataPoints/demo-${m.date}`,
    sleep: {
      interval: {
        startTime: iso(start), endTime: iso(end),
        startUtcOffset: dur(offsetAt(start)), endUtcOffset: dur(offsetAt(end)),
        civilStartTime: civil(start), civilEndTime: civil(end),
      },
      type: 'STAGES',
      stages: segs.map((s) => ({ startTime: iso(s.s), endTime: iso(s.e), startUtcOffset: dur(offsetAt(s.s)), endUtcOffset: dur(offsetAt(s.e)), type: s.type })),
      metadata: { mainSleep: true, nap: false, processed: true, stagesStatus: 'SUCCEEDED' },
      summary: {
        minutesAsleep: String(Math.round(period - awake)),
        minutesAwake: String(Math.round(awake)),
        minutesInSleepPeriod: String(Math.round(period)),
        minutesToFallAsleep: String(Math.round(segs[0]?.type === 'AWAKE' ? (segs[0].e - segs[0].s) / 60_000 : 0)),
        stagesSummary: Object.entries(sum).map(([type, min]) => ({ type, minutes: String(Math.round(min)), count: String(segs.filter((s) => s.type === type).length) })),
      },
    },
    dataSource: { platform: p.platform, recordingMethod: 'PASSIVELY_MEASURED', ...(p.device ? { device: { displayName: p.device.name, formFactor: p.device.form, manufacturer: 'Google' } } : {}) },
  };
}

const dateField = (date) => dateObj(date);

function dailyPoint(type, m) {
  switch (type) {
    case 'daily-resting-heart-rate':
      return { dailyRestingHeartRate: { beatsPerMinute: String(m.rhr), date: dateField(m.date), dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' } } };
    case 'daily-heart-rate-variability':
      return { dailyHeartRateVariability: { date: dateField(m.date), averageHeartRateVariabilityMilliseconds: Math.round(m.hrv * 10) / 10, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: Math.round(m.hrv * 11.5) / 10, nonRemHeartRateBeatsPerMinute: String(m.rhr + 2) } };
    case 'daily-oxygen-saturation':
      return { dailyOxygenSaturation: { date: dateField(m.date), averagePercentage: Math.round(m.spo2 * 10) / 10, lowerBoundPercentage: Math.round((m.spo2 - 1.6) * 10) / 10, upperBoundPercentage: Math.min(100, Math.round((m.spo2 + 1.4) * 10) / 10) } };
    case 'daily-sleep-temperature-derivations':
      return { dailySleepTemperatureDerivations: { date: dateField(m.date), nightlyTemperatureCelsius: Math.round(m.temp.nightly * 100) / 100, baselineTemperatureCelsius: m.temp.base, relativeNightlyStddev30dCelsius: m.temp.sd } };
    default:
      return null;
  }
}

function rollupPoint(type, m) {
  const d = dateObj(m.date);
  const e = dateObj(addDays(m.date, 1));
  const base = { civilStartTime: { date: d }, civilEndTime: { date: e } };
  if (type === 'steps') return { ...base, steps: { countSum: String(m.steps) } };
  if (type === 'active-zone-minutes') return { ...base, activeZoneMinutes: { sumInFatBurnHeartZone: String(m.azm.fat), sumInCardioHeartZone: String(m.azm.cardio), sumInPeakHeartZone: String(m.azm.peak) } };
  if (type === 'total-calories') return { ...base, totalCalories: { kcalSum: m.kcal } };
  if (type === 'distance') return { ...base, distance: { millimetersSum: String(m.distanceM * 1000) } };
  if (type === 'active-minutes') {
    const total = m.azm.fat + m.azm.cardio + m.azm.peak;
    return { ...base, activeMinutes: { activeMinutesRollupByActivityLevel: [
      { activityLevel: 'LIGHT', activeMinutesSum: String(Math.round(total * 2.4)) },
      { activityLevel: 'MODERATE', activeMinutesSum: String(m.azm.fat) },
      { activityLevel: 'VIGOROUS', activeMinutesSum: String(m.azm.cardio + m.azm.peak) },
    ] } };
  }
  return null;
}

function exercisePoints(m, { localMs, offsetAt, civil }) {
  const out = [];
  const mk = (id, type, name, startMin, lenMin, kcal, azm, hr, steps) => {
    const s = localMs(m.date, startMin); const e = s + lenMin * 60_000;
    out.push({
      name: `users/me/dataTypes/exercise/dataPoints/${id}`,
      exercise: {
        interval: { startTime: iso(s), endTime: iso(e), startUtcOffset: dur(offsetAt(s)), endUtcOffset: dur(offsetAt(e)), civilStartTime: civil(s), civilEndTime: civil(e) },
        exerciseType: type, displayName: name, activeDuration: dur(lenMin * 60),
        metricsSummary: { caloriesKcal: kcal, activeZoneMinutes: String(azm), averageHeartRateBeatsPerMinute: String(hr), steps: String(steps) },
      },
    });
  };
  const num = Number(m.date.replaceAll('-', ''));
  if (m.lift) mk(`${num}1`, 'WEIGHTLIFTING', 'Weights', 18 * 60 + 10, 58, 310, 14, 108, 420);
  if (m.run) mk(`${num}2`, 'RUNNING', 'Run', 8 * 60 + 30, 36, 420, 52, 152, 5600);
  return out;
}

/* ── demo strength log (shown only until the first real set) ─────── */

export function demoSets(todayDate, weeks = 10, { tz = undefined } = {}) {
  const { localMs } = zone(tz);
  const out = [];
  const plan = {
    1: [['Bench press', 'chest', 72, 8, 4], ['Overhead press', 'shoulders', 42, 8, 3], ['Triceps pushdown', 'arms', 30, 12, 3]],
    3: [['Barbell row', 'back', 64, 8, 4], ['Pull-up', 'back', 10, 8, 3], ['Biceps curl', 'arms', 14, 12, 3]],
    5: [['Back squat', 'legs', 92, 6, 4], ['Romanian deadlift', 'legs', 84, 8, 3], ['Cable crunch', 'core', 35, 15, 3]],
  };
  let id = -1;
  for (let k = weeks * 7; k >= 1; k -= 1) {
    const date = addDays(todayDate, -k);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const m = dayModel(date, todayDate, Date.now(), { tz });
    if (!plan[dow]) continue;
    const prog = 1 + 0.012 * ((weeks * 7 - k) / 7);              // slow progression
    const hard = m.k >= 18 && m.k <= 24 ? 1.08 : 1;             // the hard block: heavier, and HRV paid for it
    for (const [exercise, muscle, kg, reps, sets] of plan[dow]) {
      out.push({
        id: id--, date, t: localMs(date, 18 * 60 + 20), exercise, muscle,
        kg: Math.round(kg * prog * hard * 2) / 2, reps, sets, note: null, example: true,
      });
    }
  }
  return out;
}

/* ── the stand-in API ───────────────────────────────────────────── */

/** The lower bound in a filter: a civil date or an RFC 3339 instant. */
function lowerBound(filter) {
  const m = />=\s*"([^"]+)"/.exec(filter || '');
  return m ? m[1] : null;
}

/**
 * A fetch() that answers Google Health API URLs from the generator.
 * @param {object} o
 * @param {Function} o.now
 * @param {number} o.backfill  days of history it holds
 * @param {string} o.tz        the fake person's zone
 * @param {object} o.persona   what their device reports (PERSONAS)
 */
export function synthFetch({ now = () => Date.now(), backfill = 120, written = [], tz = undefined, persona: p = PERSONAS.fitbit } = {}) {
  const z = zone(tz);
  const { offsetAt, localMs, civil } = z;
  const has = (k) => p.has.has(k);
  /** Which persona capability a Google data type needs. */
  const NEEDS = {
    steps: 'steps', distance: 'distance', 'active-zone-minutes': 'azm', 'active-minutes': 'activeMin', 'total-calories': 'kcal',
    'daily-resting-heart-rate': 'rhr', 'daily-heart-rate-variability': 'hrv', 'daily-oxygen-saturation': 'spo2',
    'daily-sleep-temperature-derivations': 'temp', sleep: 'sleep', exercise: 'exercise', weight: 'weight', 'body-fat': 'bodyFat', 'heart-rate': 'hr',
  };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const daysFrom = (from) => {
    const t = todayIn(now(), tz);
    const first = addDays(t, -(backfill - 1));
    const out = [];
    for (let d = from && from > first ? from : first; d <= t; d = addDays(d, 1)) out.push(dayModel(d, t, now(), { tz, p }));
    return out;
  };

  // The demo's one workout: 85 → 25 minutes before this generator was made
  // (sets at ~125 bpm with dips between them, a walk to the gym before).
  const born = Math.floor(now() / 60_000) * 60_000;
  const gymFrom = born - 85 * 60_000; const gymTo = born - 25 * 60_000;
  const minuteAt = (t) => {
    const r = rng(`hr:${t}`)();
    if (p.gym && t >= gymFrom && t < gymTo) {
      const i = (t - gymFrom) / 60_000;
      if (i % 5 === 3) return { hr: Math.round(96 + 6 * r), steps: Math.round(r * 8) };
      if (i % 16 === 15) return { hr: Math.round(108 + 5 * r), steps: 70 + Math.round(r * 20) };
      return { hr: Math.round(118 + 14 * r), steps: Math.round(r * 10) };
    }
    if (p.gym && t >= gymFrom - 20 * 60_000 && t < gymFrom) return { hr: Math.round(96 + 6 * r), steps: 100 + Math.round(r * 15) };
    if (p.gym && t >= gymTo && t < gymTo + 15 * 60_000) return { hr: Math.round(98 - (t - gymTo) / 60_000 + 4 * r), steps: 0 };
    return { hr: Math.round(68 + 9 * r), steps: r < 0.1 ? Math.round(r * 300) : 0 };
  };

  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/v4\//, '');
    let m;

    if (path === 'users/me/pairedDevices') {
      // Only Google's own trackers pair here; a phone or another maker's
      // watch reaches Google through Health Connect and has no entry.
      if (!p.device || !has('battery')) return json(200, { pairedDevices: [] });
      return json(200, { pairedDevices: [{
        name: 'users/me/pairedDevices/1', deviceVersion: p.device.name, deviceType: p.device.type,
        batteryLevel: p.device.battery, batteryStatus: p.device.status, lastSyncTime: iso(now() - 18 * 60_000), features: ['HEART_RATE', 'SLEEP', 'SPO2'],
      }] });
    }

    if ((m = /^users\/me\/dataTypes\/([a-z0-9-]+)\/dataPoints:dailyRollUp$/.exec(path)) && method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      const s = body.range?.start?.date; const e = body.range?.end?.date;
      const from = `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
      const to = `${e.year}-${String(e.month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`;
      if (!NEEDS[m[1]]) return json(400, { error: { code: 400, message: `unknown data type ${m[1]}`, status: 'INVALID_ARGUMENT' } });
      if (!has(NEEDS[m[1]])) return json(200, { rollupDataPoints: [] });
      const pts = daysFrom(from).filter((d) => d.date < to).map((d) => rollupPoint(m[1], d)).filter(Boolean);
      return json(200, { rollupDataPoints: pts });
    }

    if ((m = /^users\/me\/dataTypes\/(heart-rate|steps|total-calories)\/dataPoints:rollUp$/.exec(path)) && method === 'POST'
      && (m[1] === 'total-calories' || JSON.parse(init.body || '{}').windowSize === '60s')) {
      // Minute windows (workout detection): a desk day with one session on
      // the machines that ended a little before the demo started.
      const body = JSON.parse(init.body || '{}');
      const a = Date.parse(body.range?.startTime); const b = Date.parse(body.range?.endTime);
      // No minute-level heart rate from this device: nothing to roll up.
      if ((m[1] === 'heart-rate' && !has('hrMinute')) || (m[1] !== 'heart-rate' && !has(NEEDS[m[1]]))) return json(200, { rollupDataPoints: [] });
      if (m[1] === 'total-calories') {
        let kcal = 0;
        for (let t = Math.floor(a / 60_000) * 60_000; t < b; t += 60_000) kcal += minuteAt(t).hr > 100 ? 6.2 : 1.4;
        return json(200, { rollupDataPoints: [{ startTime: iso(a), endTime: iso(b), totalCalories: { kcalSum: Math.round(kcal) } }] });
      }
      const pts = [];
      for (let t = Math.floor(a / 60_000) * 60_000; t < b && t < now(); t += 60_000) {
        const x = minuteAt(t);
        if (m[1] === 'heart-rate') pts.push({ startTime: iso(t), endTime: iso(t + 60_000), heartRate: { beatsPerMinuteAvg: x.hr, beatsPerMinuteMax: x.hr + 4, beatsPerMinuteMin: x.hr - 3 } });
        else if (x.steps) pts.push({ startTime: iso(t), endTime: iso(t + 60_000), steps: { countSum: String(x.steps) } });
      }
      return json(200, { rollupDataPoints: pts.reverse() });
    }

    if ((m = /^users\/me\/dataTypes\/exercise\/dataPoints:batchDelete$/.exec(path)) && method === 'POST') {
      const names = JSON.parse(init.body || '{}').names || [];
      for (let i = written.length - 1; i >= 0; i -= 1) if (names.includes(written[i].body?.name)) written.splice(i, 1);
      return json(200, { name: 'operations/demo-delete', done: true });
    }
    if ((m = /^users\/me\/dataTypes\/exercise\/dataPoints\/([a-z0-9-]+)$/.exec(path)) && method === 'PATCH') {
      const body = JSON.parse(init.body || '{}');
      const w = written.find((x) => x.body?.name === body.name);
      if (!w) return json(404, { error: { code: 404, message: 'data point not found', status: 'NOT_FOUND' } });
      w.body = body;
      return json(200, { name: 'operations/demo-patch', done: true, response: body });
    }

    if ((m = /^users\/me\/dataTypes\/steps\/dataPoints:rollUp$/.exec(path)) && method === 'POST') {
      // Physical-time windows: a desk day — a few steps a quarter-hour, a
      // short walk on the hour.
      const body = JSON.parse(init.body || '{}');
      const a = Date.parse(body.range?.startTime); const b = Date.parse(body.range?.endTime);
      const win = (Number(String(body.windowSize || '900s').replace('s', '')) || 900) * 1000;
      if (!has('steps')) return json(200, { rollupDataPoints: [] });
      const pts = [];
      for (let t = a; t < b; t += win) {
        const e = Math.min(b, t + win);
        const r = rng(`iw:${Math.floor(t / win)}`)();
        const steps = new Date(t).getUTCMinutes() < 15 ? Math.round(120 + r * 400) : Math.round(r * 60);
        pts.push({ startTime: iso(t), endTime: iso(e), steps: { countSum: String(steps) } });
      }
      return json(200, { rollupDataPoints: pts });
    }

    if ((m = /^users\/me\/dataTypes\/([a-z0-9-]+)\/dataPoints$/.exec(path))) {
      const type = m[1];
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        written.push({ type, body });
        return json(200, { name: `operations/demo-${written.length}`, done: true, response: body });
      }
      if (!NEEDS[type]) return json(400, { error: { code: 400, message: `unknown data type ${type}`, status: 'INVALID_ARGUMENT' } });
      const lb = lowerBound(url.searchParams.get('filter'));
      const fromDate = lb ? lb.slice(0, 10) : null;
      const fromMs = lb && lb.length > 10 ? Date.parse(lb) : null;
      const days = daysFrom(fromDate);
      let pts = [];
      if (!has(NEEDS[type])) {
        // Nothing from the device; what this app wrote itself still reads back.
        if (type === 'exercise') pts = written.filter((w) => w.type === 'exercise' && w.body.exercise).map((w) => ({ name: w.body.name, exercise: w.body.exercise }));
        else if (type === 'weight') pts = written.filter((w) => w.type === 'weight' && w.body.weight).map((w) => ({ weight: w.body.weight }));
      } else if (type.startsWith('daily-')) pts = days.map((d) => dailyPoint(type, d)).filter(Boolean);
      else if (type === 'sleep') pts = days.map((d) => sleepPoint(d, z, p)).filter((x) => !fromMs || Date.parse(x.sleep.interval.endTime) >= fromMs);
      else if (type === 'exercise') {
        pts = days.flatMap((d) => exercisePoints(d, z));
        for (const w of written) if (w.type === 'exercise' && w.body.exercise) pts.push({ name: w.body.name, exercise: w.body.exercise });
        pts.sort((p, q) => Date.parse(p.exercise.interval.startTime) - Date.parse(q.exercise.interval.startTime));
      }
      else if (type === 'weight' || type === 'body-fat') {
        const d0 = fromMs ? todayIn(fromMs - 86_400_000, tz) : fromDate;
        for (const d of daysFrom(d0)) {
          if (!d.weighed) continue;
          const t = localMs(d.date, 7 * 60 + 10);
          if (fromMs && t < fromMs) continue;
          if (t > now()) continue;
          const st = { physicalTime: iso(t), utcOffset: dur(offsetAt(t)), civilTime: civil(t) };
          if (type === 'weight') pts.push({ weight: { weightGrams: Math.round(d.kg * 1000), sampleTime: st } });
          else if (rng(`bf:${d.date}`)() < 0.5) pts.push({ bodyFat: { percentage: Math.round(d.fatPct * 10) / 10, sampleTime: st } });
        }
        for (const w of written) if (w.type === type && w.body.weight) pts.push({ weight: w.body.weight });
      } else if (type === 'heart-rate') {
        const t = now() - 25 * 60_000;
        // A watch: a sample every few minutes for the last hours. Anything
        // else: three spot readings.
        const backs = has('hrMinute') ? Array.from({ length: 36 }, (_, i) => i * 4) : [0, 5, 10];
        pts = backs.map((back) => ({ heartRate: { beatsPerMinute: String(64 + (back % 15) / 5), sampleTime: { physicalTime: iso(t - back * 60_000), utcOffset: dur(offsetAt(t)) } } })).reverse();
      }
      // Newest first, like the real thing; sleep and exercise in pages of 25.
      pts.reverse();
      const size = type === 'sleep' || type === 'exercise' ? 25 : Number(url.searchParams.get('pageSize')) || 1440;
      const at = Number(url.searchParams.get('pageToken') || 0);
      const page = pts.slice(at, at + size);
      return json(200, { dataPoints: page, ...(at + size < pts.length ? { nextPageToken: String(at + size) } : {}) });
    }

    return json(404, { error: { code: 404, message: `no such method: ${method} ${path}`, status: 'NOT_FOUND' } });
  };
}
