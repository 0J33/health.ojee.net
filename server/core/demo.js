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

const BASE = ['steps', 'distance', 'azm', 'kcal', 'rhr', 'hrv', 'spo2', 'temp', 'sleep', 'sleepStages', 'weight', 'bodyFat', 'exercise', 'hr', 'hrMinute', 'battery'];
/** What a device may report beyond the basics. `hrvSamples` is on no seeded
    device that lacks a daily HRV; a test can make one (see `persona`). */
const MORE = ['floors', 'altitude', 'kcalActive', 'zones', 'levels', 'sedentary', 'hrDay', 'resp', 'vo2', 'spo2Samples', 'hrvSamples', 'height', 'glucose', 'bodyTemp', 'swim', 'ecg', 'irn'];
const ALL = [...BASE, ...MORE];
const without = (...no) => ALL.filter((x) => !no.includes(x));
export const persona = (o) => ({ seed: '', stepScale: 1, liftDays: [1, 3, 5], runDays: [6], gym: false, platform: 'FITBIT', heightMm: 1780, ...o, has: new Set(o.has || ALL) });

/** The fake people's devices. `has` is what the device reports. */
export const PERSONAS = {
  // A Fitbit Air with everything, and a gym session a little while ago.
  fitbit: persona({ device: { name: 'Fitbit Air', type: 'TRACKER', battery: 64, status: 'Medium', form: 'FITNESS_BAND' }, gym: true }),
  // A Pixel Watch: no skin temperature, no body fat; no glucose meter, no
  // thermometer, no pool. A runner.
  pixel: persona({ seed: 'pixel', stepScale: 1.25, liftDays: [2], runDays: [1, 3, 6], heightMm: 1660, device: { name: 'Pixel Watch 4', type: 'TRACKER', battery: 41, status: 'Medium', form: 'WATCH' }, has: without('temp', 'bodyFat', 'glucose', 'bodyTemp', 'swim', 'irn') }),
  // A phone in a pocket: steps and distance, nothing else. No paired device.
  phone: persona({ seed: 'phone', stepScale: 0.7, liftDays: [], runDays: [], platform: 'HEALTH_CONNECT', device: null, has: ['steps', 'distance'] }),
  // A Garmin through Health Connect: no HRV, no SpO2, sleep without stages,
  // plain active minutes instead of zone minutes.
  // Of the newer metrics: floors, active energy, a daily heart-rate range.
  garmin: persona({ seed: 'garmin', stepScale: 1.1, liftDays: [2, 4], runDays: [0], platform: 'HEALTH_CONNECT', device: null, has: ['steps', 'distance', 'activeMin', 'kcal', 'rhr', 'sleep', 'weight', 'exercise', 'hr', 'hrMinute', 'floors', 'kcalActive', 'hrDay', 'sedentary'] }),
  // An Apple Watch through Apple Health: no paired-device battery, no zones.
  // Of the newer metrics: floors, active energy, breathing rate, VO2 max,
  // height. No heart-rate zones, no activity levels.
  apple: persona({ seed: 'apple', stepScale: 0.95, liftDays: [1, 4], runDays: [6], platform: 'HEALTH_KIT', heightMm: 1690, device: null, has: ['steps', 'distance', 'activeMin', 'kcal', 'rhr', 'hrv', 'spo2', 'sleep', 'sleepStages', 'weight', 'exercise', 'hr', 'hrMinute', 'floors', 'kcalActive', 'hrDay', 'resp', 'vo2', 'height'] }),
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

  const kcal = Math.round((1900 + steps * 0.045 + 60 * gauss(r)) * (k === 0 ? frac : 1));
  // Drawn from a generator of their own, so adding them moved none of the
  // numbers above (the demo's pinned morning stays as it was).
  const x = rng(`ojee-health:more:${p.seed}${date}`);
  const azmAll = azmFat + azmCardio + azmPeak;
  const vo2 = (p.seed ? 36 + 14 * person() : 44.2) - 0.012 * k + 0.25 * gauss(x);
  const resp = 14.6 + 0.5 * gauss(x) + 0.5 * block;
  const sedentary = Math.round((weekend ? 540 : 640) + 45 * gauss(x));
  return {
    date, k, dow,
    floors: Math.max(0, Math.round(((weekend ? 13 : 9) + 4 * gauss(x)) * frac)),
    // Active energy: what moving cost, always well under the day's total.
    kcalActive: Math.min(Math.round(kcal * 0.45), Math.round(steps * 0.038 + azmAll * 5.5)),
    // Minutes in each heart-rate zone: zone minutes count double above fat burn.
    zone: { light: Math.round((38 + azmAll * 2.2) * frac), moderate: azmFat, vigorous: Math.round(azmCardio / 2), peak: Math.round(azmPeak / 2) },
    level: { SEDENTARY: Math.round(sedentary * frac), LIGHTLY_ACTIVE: Math.round((150 + 30 * x()) * frac), MODERATELY_ACTIVE: azmFat, VERY_ACTIVE: azmCardio + azmPeak },
    resp, vo2,
    hrDay: { min: Math.round(rhr) - 5, max: Math.round(112 + azmAll * 0.9 + (dow === RUN_DAY ? 34 : 0) + 6 * x()), avg: Math.round((rhr + 13 + 2 * gauss(x)) * 10) / 10 },
    swim: dow === 2 && k > 0 && x() < 0.6 ? Math.round(520 + 160 * x()) : 0,
    hrv: Math.max(18, hrv), rhr: Math.round(rhr),
    steps: Math.round(steps), kcal,
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
      // Brief wakings inside the light stretches: a few a night.
      shortAwakenings: segs.filter((s, i) => s.type === 'LIGHT' && i % 3 === 1).slice(0, 6).map((s) => ({ startTime: iso(s.s + 120_000), endTime: iso(s.s + 150_000), startUtcOffset: dur(offsetAt(s.s)), endUtcOffset: dur(offsetAt(s.s)), type: 'AWAKE' })),
      metadata: { mainSleep: true, nap: false, processed: true, stagesStatus: 'SUCCEEDED' },
      summary: {
        minutesAsleep: String(Math.round(period - awake)),
        minutesAwake: String(Math.round(awake)),
        minutesInSleepPeriod: String(Math.round(period)),
        minutesToFallAsleep: String(Math.round(segs[0]?.type === 'AWAKE' ? (segs[0].e - segs[0].s) / 60_000 : 0)),
        minutesAfterWakeUp: String(segs.at(-1)?.type === 'AWAKE' ? Math.round((segs.at(-1).e - segs.at(-1).s) / 60_000) : 0),
        stagesSummary: Object.entries(sum).map(([type, min]) => ({ type, minutes: String(Math.round(min)), count: String(segs.filter((s) => s.type === type).length) })),
      },
    },
    dataSource: { platform: p.platform, recordingMethod: 'PASSIVELY_MEASURED', ...(p.device ? { device: { displayName: p.device.name, formFactor: p.device.form, manufacturer: 'Google' } } : {}) },
  };
}

const dateField = (date) => dateObj(date);

/** The dataSource a device's own points carry (platform, how it was
    recorded, the device, the app that uploaded it). */
function devSource(p) {
  const pkg = { FITBIT: 'com.fitbit.FitbitMobile', HEALTH_CONNECT: 'com.google.android.apps.healthdata', HEALTH_KIT: 'com.apple.Health' }[p.platform] || 'com.example.app';
  return {
    platform: p.platform, recordingMethod: 'PASSIVELY_MEASURED',
    ...(p.device ? { device: { displayName: p.device.name, formFactor: p.device.form, manufacturer: 'Google' } } : {}),
    application: { packageName: pkg },
  };
}

function dailyPoint(type, m, p = PERSONAS.fitbit) {
  switch (type) {
    case 'daily-respiratory-rate':
      return { dailyRespiratoryRate: { breathsPerMinute: Math.round(m.resp * 10) / 10, date: dateField(m.date) } };
    case 'daily-vo2-max': {
      const v = Math.round(m.vo2 * 10) / 10;
      return { dailyVo2Max: { date: dateField(m.date), vo2Max: v, vo2MaxCovariance: 1.9, estimated: false, cardioFitnessLevel: v >= 49 ? 'VERY_GOOD' : v >= 43 ? 'GOOD' : v >= 37 ? 'AVERAGE' : 'FAIR' } };
    }
    case 'daily-heart-rate-zones': {
      // Karvonen thresholds from this person's resting rate and a 187 maximum.
      const at = (f) => Math.round(m.rhr + (187 - m.rhr) * f);
      return { dailyHeartRateZones: { date: dateField(m.date), heartRateZones: [
        { heartRateZoneType: 'LIGHT', minBeatsPerMinute: String(at(0.3)), maxBeatsPerMinute: String(at(0.4) - 1) },
        { heartRateZoneType: 'MODERATE', minBeatsPerMinute: String(at(0.4)), maxBeatsPerMinute: String(at(0.6) - 1) },
        { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: String(at(0.6)), maxBeatsPerMinute: String(at(0.85) - 1) },
        { heartRateZoneType: 'PEAK', minBeatsPerMinute: String(at(0.85)), maxBeatsPerMinute: '220' },
      ] } };
    }
    case 'daily-resting-heart-rate':
      return { dailyRestingHeartRate: { beatsPerMinute: String(m.rhr), date: dateField(m.date), dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' } } };
    case 'daily-heart-rate-variability':
      return { dailyHeartRateVariability: { date: dateField(m.date), averageHeartRateVariabilityMilliseconds: Math.round(m.hrv * 10) / 10, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: Math.round(m.hrv * 11.5) / 10, entropy: Math.round((2.4 + m.hrv / 60) * 100) / 100, nonRemHeartRateBeatsPerMinute: String(m.rhr + 2) } };
    case 'daily-oxygen-saturation':
      return { dailyOxygenSaturation: { date: dateField(m.date), averagePercentage: Math.round(m.spo2 * 10) / 10, lowerBoundPercentage: Math.round((m.spo2 - 1.6) * 10) / 10, upperBoundPercentage: Math.min(100, Math.round((m.spo2 + 1.4) * 10) / 10), standardDeviationPercentage: 0.6 } };
    case 'daily-sleep-temperature-derivations':
      return { dailySleepTemperatureDerivations: { date: dateField(m.date), nightlyTemperatureCelsius: Math.round(m.temp.nightly * 100) / 100, baselineTemperatureCelsius: m.temp.base, relativeNightlyStddev30dCelsius: m.temp.sd } };
    default:
      return null;
  }
}

function rollupPoint(type, m, p = PERSONAS.fitbit) {
  const d = dateObj(m.date);
  const e = dateObj(addDays(m.date, 1));
  const base = { civilStartTime: { date: d }, civilEndTime: { date: e } };
  const rr = rng(`ru:${type}:${p.seed}${m.date}`);
  if (type === 'floors') return { ...base, floors: { countSum: String(m.floors) } };
  if (type === 'altitude') return m.floors ? { ...base, altitude: { gainMillimetersSum: String(m.floors * 3048) } } : null;
  if (type === 'active-energy-burned') return { ...base, activeEnergyBurned: { kcalSum: m.kcalActive } };
  if (type === 'sedentary-period') return { ...base, sedentaryPeriod: { durationSum: dur(m.level.SEDENTARY * 60) } };
  if (type === 'swim-lengths-data') return m.swim ? { ...base, swimLengthsData: { strokeCountSum: String(m.swim) } } : null;
  // Only the zones that have any time in them are listed, as the real one does.
  if (type === 'time-in-heart-rate-zone') {
    return { ...base, timeInHeartRateZone: { timeInHeartRateZones: Object.entries(m.zone).filter(([, min]) => min > 0).map(([z, min]) => ({ heartRateZone: z.toUpperCase(), duration: dur(min * 60) })) } };
  }
  if (type === 'calories-in-heart-rate-zone') {
    const per = { light: 4.1, moderate: 7.2, vigorous: 10.4, peak: 13.1 };
    return { ...base, caloriesInHeartRateZone: { caloriesInHeartRateZones: Object.entries(m.zone).filter(([, min]) => min > 0).map(([z, min]) => ({ heartRateZone: z.toUpperCase(), kcal: Math.round(min * per[z] * 10) / 10 })) } };
  }
  if (type === 'heart-rate') return { ...base, heartRate: { beatsPerMinuteAvg: m.hrDay.avg, beatsPerMinuteMax: m.hrDay.max, beatsPerMinuteMin: m.hrDay.min } };
  if (type === 'run-vo2-max') { const v = Math.round((m.vo2 + 1.4) * 10) / 10; return m.run ? { ...base, runVo2Max: { rateAvg: v, rateMax: v, rateMin: v } } : null; }
  if (type === 'weight') return m.weighed ? { ...base, weight: { weightGramsAvg: Math.round(m.kg * 1000) } } : null;
  if (type === 'body-fat') return m.weighed && rng(`bf:${m.date}`)() < 0.5 ? { ...base, bodyFat: { bodyFatPercentageAvg: Math.round(m.fatPct * 10) / 10 } } : null;
  if (type === 'blood-glucose') return [1, 3, 6, 11, 19].includes(m.k) ? { ...base, bloodGlucose: { bloodGlucoseMilligramsPerDeciliterAvg: Math.round(88 + 9 * rr()) } } : null;
  if (type === 'core-body-temperature') { const t = Math.round((36.6 + 0.3 * rr()) * 10) / 10; return [2, 5, 13].includes(m.k) ? { ...base, coreBodyTemperature: { temperatureCelsiusAvg: t, temperatureCelsiusMax: t, temperatureCelsiusMin: t } } : null; }
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

function exercisePoints(m, { localMs, offsetAt, civil }, p = PERSONAS.fitbit) {
  const out = [];
  // A device with heart-rate zones says how the session split across them;
  // a run also has a distance and a pace.
  const withZones = p.has.has('zones');
  const mk = (id, type, name, startMin, lenMin, kcal, azm, hr, steps) => {
    const s = localMs(m.date, startMin); const e = s + lenMin * 60_000;
    const run = type === 'RUNNING';
    const active = Math.round(lenMin * 60 * (run ? 0.97 : 0.86));
    const metres = run ? Math.round(steps * 1.08) : 0;
    out.push({
      name: `users/me/dataTypes/exercise/dataPoints/${id}`,
      exercise: {
        interval: { startTime: iso(s), endTime: iso(e), startUtcOffset: dur(offsetAt(s)), endUtcOffset: dur(offsetAt(e)), civilStartTime: civil(s), civilEndTime: civil(e) },
        exerciseType: type, displayName: name, activeDuration: dur(active),
        metricsSummary: {
          caloriesKcal: kcal, activeZoneMinutes: String(azm), averageHeartRateBeatsPerMinute: String(hr), steps: String(steps),
          ...(run ? { distanceMillimeters: metres * 1000, averagePaceSecondsPerMeter: Math.round((active / metres) * 10000) / 10000 } : {}),
          ...(withZones ? { heartRateZoneDurations: run
            ? { lightTime: dur(lenMin * 6), moderateTime: dur(lenMin * 18), vigorousTime: dur(lenMin * 28), peakTime: dur(lenMin * 8) }
            : { lightTime: dur(lenMin * 30), moderateTime: dur(lenMin * 14), vigorousTime: dur(0), peakTime: dur(0) } } : {}),
        },
        exerciseMetadata: { hasGps: false },
      },
      dataSource: devSource(p),
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

const G = 'https://www.googleapis.com/auth/googlehealth.';

/**
 * Every data type the real API has, as the probe of 2026-10-11 found it:
 *   field   the camelCase key its value sits under
 *   fam     the scope family that opens it (`<fam>.readonly` / `.writeonly`)
 *   needs   the persona capability that produces it (none: nothing from a device)
 *   list    false = "List is not supported", with the actions it names
 *   daily   true = dailyRollUp answers
 *   write   true = create / patch / batchDelete are taken
 *   ro      false = the family has no read scope: a list gives back only
 *           what this client wrote
 */
export const FAKE_TYPES = {
  steps: { field: 'steps', fam: 'activity_and_fitness', needs: 'steps', daily: true },
  distance: { field: 'distance', fam: 'activity_and_fitness', needs: 'distance', daily: true },
  'active-zone-minutes': { field: 'activeZoneMinutes', fam: 'activity_and_fitness', needs: 'azm', daily: true },
  'active-minutes': { field: 'activeMinutes', fam: 'activity_and_fitness', needs: 'activeMin', daily: true },
  'total-calories': { field: 'totalCalories', fam: 'activity_and_fitness', needs: 'kcal', daily: true, list: false, actions: 'rollup, dailyRollup' },
  'calories-in-heart-rate-zone': { field: 'caloriesInHeartRateZone', fam: 'activity_and_fitness', needs: 'zones', daily: true, list: false, actions: 'rollup, dailyRollup' },
  floors: { field: 'floors', fam: 'activity_and_fitness', needs: 'floors', daily: true, list: false, actions: 'reconcile, rollup, dailyRollup' },
  altitude: { field: 'altitude', fam: 'activity_and_fitness', needs: 'altitude', daily: true },
  'active-energy-burned': { field: 'activeEnergyBurned', fam: 'activity_and_fitness', needs: 'kcalActive', daily: true },
  'basal-energy-burned': { field: 'basalEnergyBurned', fam: 'activity_and_fitness' },
  'activity-level': { field: 'activityLevel', fam: 'activity_and_fitness', needs: 'levels' },
  'sedentary-period': { field: 'sedentaryPeriod', fam: 'activity_and_fitness', needs: 'sedentary', daily: true },
  'swim-lengths-data': { field: 'swimLengthsData', fam: 'activity_and_fitness', needs: 'swim', daily: true },
  'time-in-heart-rate-zone': { field: 'timeInHeartRateZone', fam: 'activity_and_fitness', needs: 'zones', daily: true },
  'daily-vo2-max': { field: 'dailyVo2Max', fam: 'activity_and_fitness', needs: 'vo2' },
  'vo2-max': { field: 'vo2Max', fam: 'activity_and_fitness', needs: 'vo2' },
  'run-vo2-max': { field: 'runVo2Max', fam: 'activity_and_fitness', needs: 'vo2', daily: true },
  exercise: { field: 'exercise', fam: 'activity_and_fitness', needs: 'exercise', write: true },
  'heart-rate': { field: 'heartRate', fam: 'health_metrics_and_measurements', needs: 'hr', daily: true },
  'daily-resting-heart-rate': { field: 'dailyRestingHeartRate', fam: 'health_metrics_and_measurements', needs: 'rhr' },
  'daily-heart-rate-variability': { field: 'dailyHeartRateVariability', fam: 'health_metrics_and_measurements', needs: 'hrv' },
  'daily-oxygen-saturation': { field: 'dailyOxygenSaturation', fam: 'health_metrics_and_measurements', needs: 'spo2' },
  'daily-sleep-temperature-derivations': { field: 'dailySleepTemperatureDerivations', fam: 'health_metrics_and_measurements', needs: 'temp' },
  'daily-respiratory-rate': { field: 'dailyRespiratoryRate', fam: 'health_metrics_and_measurements', needs: 'resp' },
  'daily-heart-rate-zones': { field: 'dailyHeartRateZones', fam: 'health_metrics_and_measurements', needs: 'zones' },
  'respiratory-rate-sleep-summary': { field: 'respiratoryRateSleepSummary', fam: 'health_metrics_and_measurements', needs: 'resp' },
  'oxygen-saturation': { field: 'oxygenSaturation', fam: 'health_metrics_and_measurements', needs: 'spo2Samples' },
  'heart-rate-variability': { field: 'heartRateVariability', fam: 'health_metrics_and_measurements', needs: 'hrvSamples' },
  height: { field: 'height', fam: 'health_metrics_and_measurements', needs: 'height', write: true },
  weight: { field: 'weight', fam: 'health_metrics_and_measurements', needs: 'weight', daily: true, write: true },
  'body-fat': { field: 'bodyFat', fam: 'health_metrics_and_measurements', needs: 'bodyFat', daily: true, write: true },
  'blood-glucose': { field: 'bloodGlucose', fam: 'health_metrics_and_measurements', needs: 'glucose', daily: true, write: true },
  'core-body-temperature': { field: 'coreBodyTemperature', fam: 'health_metrics_and_measurements', needs: 'bodyTemp', daily: true, write: true },
  sleep: { field: 'sleep', fam: 'sleep', needs: 'sleep' },
  'hydration-log': { field: 'hydrationLog', fam: 'nutrition', ro: false, daily: true, write: true },
  'nutrition-log': { field: 'nutritionLog', fam: 'nutrition', ro: false, daily: true, write: true },
  moods: { field: 'moods', fam: 'mindfulness', write: true, list: false, actions: 'create, update, batchDelete' },
  symptoms: { field: 'symptoms', fam: 'logged_symptoms', write: true, list: false, actions: 'create, update, batchDelete' },
  'menstrual-period': { field: 'menstrualPeriod', fam: 'reproductive_health', write: true, list: false, actions: 'create, update, batchDelete' },
  'ovulation-test': { field: 'ovulationTest', fam: 'reproductive_health', write: true, list: false, actions: 'create, update, batchDelete' },
  electrocardiogram: { field: 'electrocardiogram', fam: 'ecg', needs: 'ecg' },
  'irregular-rhythm-notification': { field: 'irregularRhythmNotification', fam: 'irn', needs: 'irn' },
};

/** The bounds in a filter: `>= "x"` and `< "y"`, each a civil date or an
    RFC 3339 instant. */
function bounds(filter) {
  const lo = />=\s*"([^"]+)"/.exec(filter || '');
  const hi = /<\s*"([^"]+)"/.exec(filter || '');
  return { lo: lo ? lo[1] : null, hi: hi ? hi[1] : null };
}

/** When a point happened, whatever its shape: the instant its filter and
    its ordering go by. */
function pointTime(type, pt) {
  const v = pt[FAKE_TYPES[type].field] || {};
  if (v.sampleTime) return Date.parse(v.sampleTime.physicalTime);
  if (v.interval) return Date.parse(type === 'sleep' ? v.interval.endTime : v.interval.startTime);
  if (v.date) return Date.parse(`${v.date.year}-${String(v.date.month).padStart(2, '0')}-${String(v.date.day).padStart(2, '0')}T00:00:00Z`);
  return 0;
}

/**
 * A fetch() that answers Google Health API URLs from the generator.
 * @param {object} o
 * @param {Function} o.now
 * @param {number} o.backfill  days of history it holds
 * @param {string} o.tz        the fake person's zone
 * @param {object} o.persona   what their device reports (PERSONAS)
 * @param {Array}  o.written   the points this client created: [{ type, body }]
 * @param {Function} o.scopes  () => the scopes the token holds, or null for
 *                             "everything" (a test that is not about scopes)
 */
export function synthFetch({ now = () => Date.now(), backfill = 120, written = [], tz = undefined, persona: p = PERSONAS.fitbit, scopes = () => null } = {}) {
  const z = zone(tz);
  const { offsetAt, localMs, civil } = z;
  const has = (k) => !!k && p.has.has(k);
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const bad = (message) => json(400, { error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
  const denied = () => json(403, { error: { code: 403, message: 'Required OAuth scope(s) are missing for this operation.', status: 'PERMISSION_DENIED' } });
  /** Does the token hold a scope of this family: 'ro', 'wo' or either. */
  const holds = (fam, mode = 'any') => {
    const s = scopes();
    if (!s) return true;
    return (mode !== 'wo' && s.includes(`${G}${fam}.readonly`)) || (mode !== 'ro' && s.includes(`${G}${fam}.writeonly`));
  };
  let serial = 0;

  const daysFrom = (from, to = null) => {
    const t = todayIn(now(), tz);
    const first = addDays(t, -(backfill - 1));
    const out = [];
    for (let d = from && from > first ? from : first; d <= t && (!to || d < to); d = addDays(d, 1)) out.push(dayModel(d, t, now(), { tz, p }));
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

  /** What this client wrote of one type, as the points a list returns. */
  const own = (type) => written.filter((w) => w.type === type && w.body?.[FAKE_TYPES[type].field]).map((w) => {
    const v = { ...w.body[FAKE_TYPES[type].field] };
    // Output-only civil times, as Google adds them on the way out.
    if (v.sampleTime) v.sampleTime = { ...v.sampleTime, civilTime: civil(Date.parse(v.sampleTime.physicalTime)) };
    if (v.interval && type !== 'exercise') v.interval = { ...v.interval, civilStartTime: civil(Date.parse(v.interval.startTime)), civilEndTime: civil(Date.parse(v.interval.endTime)) };
    return { name: w.body.name, [FAKE_TYPES[type].field]: v, dataSource: { platform: 'GOOGLE_WEB_API', recordingMethod: w.body.dataSource?.recordingMethod || 'MANUAL', application: { googleWebClientId: 'demo-client' } } };
  });

  /** The device's points of one type over some days, oldest first. */
  const fromDevice = (type, days, lo) => {
    const src = devSource(p);
    const st = (t) => ({ physicalTime: iso(t), utcOffset: dur(offsetAt(t)), civilTime: civil(t) });
    const iv = (s, e) => ({ startTime: iso(s), endTime: iso(e), startUtcOffset: dur(offsetAt(s)), endUtcOffset: dur(offsetAt(e)), civilStartTime: civil(s), civilEndTime: civil(e) });
    const past = (t) => t <= now();
    const pts = [];
    if (type.startsWith('daily-')) return days.map((d) => dailyPoint(type, d, p)).filter(Boolean).map((x) => ({ ...x, dataSource: src }));
    if (type === 'sleep') return days.map((d) => sleepPoint(d, z, p));
    if (type === 'exercise') return days.flatMap((d) => exercisePoints(d, z, p));
    if (type === 'weight' || type === 'body-fat') {
      for (const d of days) {
        if (!d.weighed) continue;
        const t = localMs(d.date, 7 * 60 + 10);
        if (!past(t)) continue;
        if (type === 'weight') pts.push({ name: `users/me/dataTypes/weight/dataPoints/demo-${d.date}`, weight: { weightGrams: Math.round(d.kg * 1000), sampleTime: st(t) }, dataSource: { platform: p.platform, recordingMethod: 'ACTIVELY_MEASURED' } });
        else if (rng(`bf:${d.date}`)() < 0.5) pts.push({ name: `users/me/dataTypes/body-fat/dataPoints/demo-${d.date}`, bodyFat: { percentage: Math.round(d.fatPct * 10) / 10, sampleTime: st(t) }, dataSource: { platform: p.platform, recordingMethod: 'ACTIVELY_MEASURED' } });
      }
      return pts;
    }
    if (type === 'heart-rate') {
      const t = now() - 25 * 60_000;
      // A watch: a sample every few minutes for the last hours. Anything
      // else: three spot readings.
      const backs = has('hrMinute') ? Array.from({ length: 36 }, (_, i) => i * 4) : [0, 5, 10];
      return backs.map((back) => ({ heartRate: { beatsPerMinute: String(64 + (back % 15) / 5), sampleTime: { physicalTime: iso(t - back * 60_000), utcOffset: dur(offsetAt(t)) } } })).reverse();
    }
    if (type === 'height') {
      // Typed in once, when the account was set up: long before any sync window.
      const t = localMs(addDays(todayIn(now(), tz), -200), 9 * 60);
      return lo && t < lo ? [] : [{ name: 'users/me/dataTypes/height/dataPoints/demo-height', height: { heightMillimeters: String(p.heightMm), sampleTime: st(t) }, dataSource: { platform: p.platform, recordingMethod: 'MANUAL' } }];
    }
    for (const d of days) {
      const x = rng(`pt:${type}:${p.seed}${d.date}`);
      if (type === 'activity-level') {
        // The waking day as four stretches, one per level, from 07:30.
        let t = localMs(d.date, 7 * 60 + 30);
        for (const [lv, min] of Object.entries(d.level)) {
          if (min <= 0) continue;
          const e = t + min * 60_000;
          if (past(e)) pts.push({ activityLevel: { activityLevelType: lv, interval: iv(t, e) }, dataSource: src });
          t = e;
        }
      } else if (type === 'active-energy-burned' || type === 'altitude' || type === 'sedentary-period' || type === 'swim-lengths-data' || type === 'time-in-heart-rate-zone') {
        // Raw intervals exist for these; the app reads their roll-ups. One
        // hour-long interval a day is enough to be a faithful shape.
        const s = localMs(d.date, 12 * 60); const e = s + 3_600_000;
        if (!past(e)) continue;
        if (type === 'active-energy-burned') pts.push({ activeEnergyBurned: { kcal: Math.round(d.kcalActive / 6), interval: iv(s, e) }, dataSource: src });
        if (type === 'altitude' && d.floors) pts.push({ altitude: { gainMillimeters: String(d.floors * 3048), interval: iv(s, e) }, dataSource: src });
        if (type === 'sedentary-period') pts.push({ sedentaryPeriod: { interval: iv(s, e) }, dataSource: { platform: p.platform, recordingMethod: 'DERIVED' } });
        if (type === 'swim-lengths-data' && d.swim) pts.push({ swimLengthsData: { strokeCount: String(d.swim), swimStrokeType: 'FREESTYLE', interval: iv(s, e) }, dataSource: src });
        if (type === 'time-in-heart-rate-zone' && d.zone.moderate) pts.push({ timeInHeartRateZone: { heartRateZoneType: 'MODERATE', interval: iv(s, s + d.zone.moderate * 60_000) }, dataSource: src });
      } else if (type === 'respiratory-rate-sleep-summary') {
        const t = d.sleepStart + d.sleep.len * 60_000;
        const stat = (bpm) => ({ breathsPerMinute: Math.round(bpm * 10) / 10, signalToNoise: Math.round((4 + 2 * x()) * 100) / 100, standardDeviation: Math.round((0.9 + 0.6 * x()) * 100) / 100 });
        if (past(t)) pts.push({ name: `users/me/dataTypes/respiratory-rate-sleep-summary/dataPoints/demo-${d.date}`, respiratoryRateSleepSummary: { sampleTime: st(t), fullSleepStats: stat(d.resp), deepSleepStats: stat(d.resp - 0.8), lightSleepStats: stat(d.resp + 0.1), remSleepStats: stat(d.resp + 0.9) }, dataSource: src });
      } else if (type === 'oxygen-saturation' || type === 'heart-rate-variability') {
        // Through the night: a reading every half hour (oxygen) or every
        // quarter of an hour (HRV) while asleep.
        const step = type === 'oxygen-saturation' ? 30 : 15;
        for (let m = 20; m < d.sleep.len - 10; m += step) {
          const t = d.sleepStart + m * 60_000;
          if (!past(t)) break;
          if (type === 'oxygen-saturation') pts.push({ oxygenSaturation: { percentage: Math.round(Math.min(100, d.spo2 + 1.1 * gauss(x)) * 10) / 10, sampleTime: st(t) }, dataSource: src });
          else pts.push({ heartRateVariability: { rootMeanSquareOfSuccessiveDifferencesMilliseconds: Math.round(Math.max(8, d.hrv + 9 * gauss(x)) * 10) / 10, metadata: { highFrequencyPower: Math.round(300 + 400 * x()), lowFrequencyPower: Math.round(500 + 700 * x()) }, sampleTime: st(t) }, dataSource: src });
        }
      } else if (type === 'vo2-max') {
        // A reading a week, on Sunday.
        const t = localMs(d.date, 10 * 60);
        if (d.dow === 0 && past(t)) pts.push({ vo2Max: { vo2Max: Math.round(d.vo2 * 10) / 10, measurementMethod: p.platform === 'FITBIT' ? 'GOOGLE_DEMOGRAPHIC' : 'HEART_RATE_RATIO', sampleTime: st(t) }, dataSource: src });
      } else if (type === 'run-vo2-max') {
        const t = localMs(d.date, 9 * 60 + 10);
        if (d.run && past(t)) pts.push({ runVo2Max: { runVo2Max: Math.round((d.vo2 + 1.4) * 10) / 10, sampleTime: st(t) }, dataSource: src });
      } else if (type === 'blood-glucose') {
        // A finger-prick meter used now and then: a fasting reading some mornings.
        const t = localMs(d.date, 7 * 60 + 25);
        if ([1, 3, 6, 11, 19].includes(d.k) && past(t)) pts.push({ name: `users/me/dataTypes/blood-glucose/dataPoints/demo-${d.date}`, bloodGlucose: { bloodGlucoseMilligramsPerDeciliter: Math.round(88 + 9 * x()), measurementTiming: 'FASTING', mealType: 'BREAKFAST', specimen: 'CAPILLARY_BLOOD', measurementSource: 'SELF_MONITORING_BLOOD_GLUCOSE', sampleTime: st(t) }, dataSource: { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED', application: { packageName: 'com.example.glucometer' } } });
      } else if (type === 'core-body-temperature') {
        const t = localMs(d.date, 21 * 60 + 40);
        if ([2, 5, 13].includes(d.k) && past(t)) pts.push({ name: `users/me/dataTypes/core-body-temperature/dataPoints/demo-${d.date}`, coreBodyTemperature: { temperatureCelsius: Math.round((36.6 + 0.3 * x()) * 10) / 10, measurementLocation: 'EAR', sampleTime: st(t) }, dataSource: { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED', device: { displayName: 'Ear thermometer', formFactor: 'FORM_FACTOR_UNSPECIFIED', manufacturer: 'Braun' } } });
      } else if (type === 'electrocardiogram') {
        // Two readings in the window, taken on the wrist after dinner.
        const s = localMs(d.date, 20 * 60 + 15); const e = s + 30_000;
        if ([4, 20].includes(d.k) && past(e)) {
          pts.push({
            name: `users/me/dataTypes/electrocardiogram/dataPoints/demo-${d.date}`,
            electrocardiogram: {
              interval: iv(s, e), resultClassification: d.k === 4 ? 'NORMAL_SINUS_RHYTHM' : 'INCONCLUSIVE_HIGH_HEART_RATE', beatsPerMinuteAvg: String(d.k === 4 ? 66 : 124),
              leadNumber: 1, samplingFrequencyHertz: 250, millivoltsScalingFactor: 1000,
              waveformSamples: Array.from({ length: 2500 }, (_, i) => Math.round(120 * Math.sin(i / 9) + (i % 190 === 0 ? 900 : 0))),
              medicalDeviceInfo: { firmwareVersion: '1.184.52', featureVersion: '2.1', deviceModel: p.device?.name || 'Tracker' },
            },
            dataSource: src,
          });
        }
      } else if (type === 'irregular-rhythm-notification') {
        // At most one notice: nine nights ago, two analysis windows.
        const s = d.sleepStart + 95 * 60_000; const e = s + 40 * 60_000;
        if (d.k === 9 && past(e)) {
          const win = (a) => ({
            startTime: iso(a), endTime: iso(a + 15 * 60_000), startUtcOffset: dur(offsetAt(a)), endUtcOffset: dur(offsetAt(a)), civilStartTime: civil(a), civilEndTime: civil(a + 15 * 60_000), positive: true,
            heartBeats: Array.from({ length: 6 }, (_, i) => ({ physicalTime: iso(a + i * 40_000), utcOffset: dur(offsetAt(a)), civilTime: civil(a + i * 40_000), beatsPerMinute: Math.round(58 + 46 * x()) })),
          });
          pts.push({
            name: `users/me/dataTypes/irregular-rhythm-notification/dataPoints/demo-${d.date}`,
            irregularRhythmNotification: { interval: iv(s, e), alertWindows: [win(s), win(s + 20 * 60_000)], medicalDeviceInfo: { algorithmVersion: '1.2.0', serviceVersion: '4.7', deviceModel: p.device?.name || 'Tracker' } },
            dataSource: src,
          });
        }
      }
    }
    return pts;
  };

  /** A day's value of a roll-up type, from what the device and this client hold. */
  const rollupOf = (type, d) => {
    const own1 = (pick) => own(type).filter((x) => todayIn(pointTime(type, x), tz) === d.date).map(pick);
    const base = { civilStartTime: { date: dateObj(d.date) }, civilEndTime: { date: dateObj(addDays(d.date, 1)) } };
    if (type === 'hydration-log') { const v = own1((x) => x.hydrationLog.amountConsumed.milliliters); return v.length ? { ...base, hydrationLog: { amountConsumed: { millilitersSum: v.reduce((a, b) => a + b, 0), userProvidedUnitLast: 'MILLILITER' } } } : null; }
    if (type === 'nutrition-log') { const v = own1((x) => x.nutritionLog.energy?.kcal || 0); return v.length ? { ...base, nutritionLog: { energy: { kcalSum: v.reduce((a, b) => a + b, 0) } } } : null; }
    // A day's heart-rate range needs a device that samples through the day.
    if (!has(type === 'heart-rate' ? 'hrDay' : FAKE_TYPES[type].needs)) return null;
    return rollupPoint(type, d, p);
  };

  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/v4\//, '');
    let m;

    if (path === 'users/me/pairedDevices') {
      if (!holds('settings', 'ro')) return denied();
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
      const T = FAKE_TYPES[m[1]];
      if (!T) return bad(`Invalid data type ID referenced in the parent data type collection: ${m[1]}`);
      if (!holds(T.fam)) return denied();
      if (!T.daily) return bad(`DailyRollup is not supported for data type ${m[1]}, but the following actions are supported: list, reconcile`);
      const max = ['heart-rate', 'active-minutes', 'total-calories', 'calories-in-heart-rate-zone'].includes(m[1]) ? 14 : 90;
      if (daysBetween(from, to) > max) return bad(`The requested range exceeds the maximum of ${max} days for data type ${m[1]}.`);
      const pts = daysFrom(from, to).map((d) => rollupOf(m[1], d)).filter(Boolean);
      return json(200, { rollupDataPoints: pts });
    }

    if ((m = /^users\/me\/dataTypes\/(heart-rate|steps|total-calories)\/dataPoints:rollUp$/.exec(path)) && method === 'POST'
      && (m[1] === 'total-calories' || JSON.parse(init.body || '{}').windowSize === '60s')) {
      // Minute windows (workout detection): a desk day with one session on
      // the machines that ended a little before the demo started.
      const body = JSON.parse(init.body || '{}');
      const a = Date.parse(body.range?.startTime); const b = Date.parse(body.range?.endTime);
      // No minute-level heart rate from this device: nothing to roll up.
      if ((m[1] === 'heart-rate' && !has('hrMinute')) || (m[1] !== 'heart-rate' && !has(FAKE_TYPES[m[1]].needs))) return json(200, { rollupDataPoints: [] });
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

    if ((m = /^users\/me\/dataTypes\/([a-z0-9-]+)\/dataPoints:batchDelete$/.exec(path)) && method === 'POST') {
      const T = FAKE_TYPES[m[1]];
      if (!T?.write) return bad(`BatchDelete is not supported for data type ${m[1]}`);
      if (!holds(T.fam, 'wo')) return denied();
      const names = JSON.parse(init.body || '{}').names || [];
      for (let i = written.length - 1; i >= 0; i -= 1) if (names.includes(written[i].body?.name)) written.splice(i, 1);
      return json(200, { name: 'operations/demo-delete', done: true });
    }
    if ((m = /^users\/me\/dataTypes\/([a-z0-9-]+)\/dataPoints\/([A-Za-z0-9-]+)$/.exec(path)) && method === 'PATCH') {
      const T = FAKE_TYPES[m[1]];
      if (!T?.write) return bad(`Update is not supported for data type ${m[1]}`);
      if (!holds(T.fam, 'wo')) return denied();
      const body = JSON.parse(init.body || '{}');
      const w = written.find((x) => x.body?.name === `users/me/dataTypes/${m[1]}/dataPoints/${m[2]}`);
      if (!w) return json(404, { error: { code: 404, message: 'data point not found', status: 'NOT_FOUND' } });
      w.body = { ...body, name: w.body.name };
      return json(200, { name: 'operations/demo-patch', done: true, response: w.body });
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
      const T = FAKE_TYPES[type];
      if (method === 'POST') {
        if (!T) return bad(`Invalid data type ID referenced in the parent data type collection: ${type}`);
        if (!T.write) return bad(`Create is not supported for data type ${type}`);
        if (!holds(T.fam, 'wo')) return denied();
        const body = JSON.parse(init.body || '{}');
        if (!body[T.field]) return bad(`Invalid data point: the ${T.field} field is required for data type ${type}.`);
        if (body.name && written.some((w) => w.body?.name === body.name)) return json(409, { error: { code: 409, message: 'A data point with this name already exists.', status: 'ALREADY_EXISTS' } });
        serial += 1;
        // The point's name: the client's own when it sent one, else Google's.
        const made = { ...body, name: body.name || `users/me/dataTypes/${type}/dataPoints/srv-${born}-${serial}` };
        written.push({ type, body: made });
        return json(200, { name: `operations/demo-${written.length}`, done: true, response: made });
      }
      if (!T) return bad(`Invalid data type ID referenced in the parent data type collection: ${type}`);
      if (!holds(T.fam)) return denied();
      if (T.list === false) return bad(`List is not supported for data type ${type}, but the following actions are supported: ${T.actions}`);
      const filter = url.searchParams.get('filter') || '';
      // The filter's member has to fit the type: a daily filter on an
      // interval type is refused, as the real API refuses it.
      if (type === 'activity-level' && /\.date\b/.test(filter)) return bad('Invalid data point filter: INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER.');
      if (type === 'electrocardiogram' && /</.test(filter)) return bad('Invalid data point filter: only electrocardiogram.interval.start_time >= is supported.');
      const { lo, hi } = bounds(filter);
      const loMs = lo ? (lo.length > 10 ? Date.parse(lo) : localMs(lo.slice(0, 10), 0)) : null;
      const hiMs = hi ? (hi.length > 10 ? Date.parse(hi) : localMs(hi.slice(0, 10), 0)) : null;
      const loDate = lo ? (lo.length > 10 ? todayIn(Date.parse(lo) - 86_400_000, tz) : lo.slice(0, 10)) : null;
      const hiDate = hi ? (hi.length > 10 ? todayIn(Date.parse(hi) + 86_400_000, tz) : hi.slice(0, 10)) : null;
      // A caller with only the write scope sees what it wrote itself; so
      // does everybody for a type no device of this person produces.
      const readable = T.ro !== false && holds(T.fam, 'ro');
      let pts = readable && has(T.needs) ? fromDevice(type, daysFrom(loDate, hiDate), loMs) : [];
      if (T.write) pts.push(...own(type));
      if (type === 'heart-rate') pts = pts.filter((x) => !loMs || pointTime(type, x) >= loMs);
      else if (type.startsWith('daily-')) pts = pts.filter((x) => { const d = iso(pointTime(type, x)).slice(0, 10); return (!lo || d >= lo.slice(0, 10)) && (!hi || d < hi.slice(0, 10)); });
      else pts = pts.filter((x) => { const t = pointTime(type, x); return (loMs === null || t >= loMs) && (hiMs === null || t < hiMs); });
      // Newest first, like the real thing; sleep and exercise in pages of 25.
      pts.sort((a, b) => pointTime(type, b) - pointTime(type, a));
      const size = type === 'sleep' || type === 'exercise' ? 25 : Number(url.searchParams.get('pageSize')) || 1440;
      const at = Number(url.searchParams.get('pageToken') || 0);
      const page = pts.slice(at, at + size);
      return json(200, { dataPoints: page, ...(at + size < pts.length ? { nextPageToken: String(at + size) } : {}) });
    }

    return json(404, { error: { code: 404, message: `no such method: ${method} ${path}`, status: 'NOT_FOUND' } });
  };
}
