/* ============================================================
   health.ojee.net — Google Health API JSON -> rows.

   Pure functions, no I/O, so they are tested against fixtures shaped
   exactly like the API's discovery document says the replies are:
   int64 values arrive as strings, durations as "10800s", civil dates
   as { year, month, day }, and every DataPoint carries its value
   under a camelCase key named for its data type (`dailyRestingHeart
   Rate`, `sleep`, `weight`, …).

   Three shapes come out of here. A daily number is
   `{ date, metrics: { key: value } }` and goes into `daily`. A
   session (sleep, exercise) keeps its own row shape. Everything else
   that is an event or a reading (a glass of water, a glucose value,
   an ECG) is a SAMPLE ROW, `{ kind, t, end, off, date, value, data,
   device, gname }`, and goes into `sample`: `value` is the headline
   number, `data` the rest. Dense streams (oxygen saturation and HRV
   through the night, activity level through the day) are reduced to
   per-day numbers here and never stored point by point.
   ============================================================ */

import { num, ymd, durSec, ms } from './util.js';

/** The civil date of an instant, given the wearer's UTC offset then. */
const civilOf = (tMs, offSec) => new Date(tMs + offSec * 1000).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
/** Drop the keys that have no value. */
const compact = (o) => { for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };
const ZONE_KEY = { LIGHT: 'light', MODERATE: 'moderate', VIGOROUS: 'vigorous', PEAK: 'peak' };
const LEVEL_KEY = { SEDENTARY: 'level_sedentary', LIGHTLY_ACTIVE: 'level_light', MODERATELY_ACTIVE: 'level_moderate', VERY_ACTIVE: 'level_very' };

/* ── where a point came from ──────────────────────────────────────── */

const PLATFORM = {
  FITBIT: 'Fitbit', HEALTH_CONNECT: 'Health Connect', HEALTH_KIT: 'Apple Health', FIT: 'Google Fit', FITBIT_WEB_API: 'Fitbit app',
  NEST: 'Nest', GOOGLE_WEB_API: 'Another app', GOOGLE_PARTNER_INTEGRATION: 'A connected service',
};
const FORM = { FITNESS_BAND: 'Fitness band', WATCH: 'Watch', PHONE: 'Phone', RING: 'Ring', CHEST_STRAP: 'Chest strap', SCALE: 'Scale', TABLET: 'Tablet', HEAD_MOUNTED: 'Headset', SMART_DISPLAY: 'Smart display' };

/**
 * A DataPoint's `dataSource` as a few words for a person: the device's own
 * name when it has one ("Fitbit Air", "Pixel Watch 4"), else the kind of
 * device, else how it got to Google ("Health Connect"), else "Logged by
 * hand". `own` marks a point this app wrote itself.
 */
export function sourceName(ds, { own = false } = {}) {
  if (own) return 'health.ojee.net';
  if (!ds || typeof ds !== 'object') return null;
  const d = ds.device || {};
  if (d.displayName) return String(d.displayName).slice(0, 60);
  if (d.formFactor && FORM[d.formFactor]) return d.manufacturer ? `${String(d.manufacturer).slice(0, 30)} ${FORM[d.formFactor].toLowerCase()}` : FORM[d.formFactor];
  if (ds.recordingMethod === 'MANUAL') return 'Logged by hand';
  if (ds.platform && PLATFORM[ds.platform]) return PLATFORM[ds.platform];
  return null;
}

/* ── daily roll-ups (steps, active zone minutes, calories) ─────────── */

export function parseRollup(type, points) {
  const out = [];
  for (const p of points || []) {
    const date = ymd(p.civilStartTime?.date);
    if (!date) continue;
    const m = {};
    if (type === 'steps' && p.steps) m.steps = num(p.steps.countSum) ?? 0;
    if (type === 'active-zone-minutes' && p.activeZoneMinutes) {
      const a = p.activeZoneMinutes;
      m.azm_fat = num(a.sumInFatBurnHeartZone) ?? 0;
      m.azm_cardio = num(a.sumInCardioHeartZone) ?? 0;
      m.azm_peak = num(a.sumInPeakHeartZone) ?? 0;
      m.azm = m.azm_fat + m.azm_cardio + m.azm_peak;
    }
    if (type === 'total-calories' && p.totalCalories) m.kcal = num(p.totalCalories.kcalSum);
    // int64 millimetres, kept as metres.
    if (type === 'distance' && p.distance) { const mm = num(p.distance.millimetersSum); if (mm !== null) m.distance_m = mm / 1000; }
    // Plain active minutes, for devices that do not report heart-rate zones:
    // moderate + vigorous, which is what "active" means on those watches.
    if (type === 'active-minutes' && p.activeMinutes) {
      let n = 0; let any = false;
      for (const x of p.activeMinutes.activeMinutesRollupByActivityLevel || []) {
        if (x.activityLevel !== 'MODERATE' && x.activityLevel !== 'VIGOROUS') continue;
        const v = num(x.activeMinutesSum);
        if (v !== null) { n += v; any = true; }
      }
      if (any) m.active_min = n;
    }
    if (type === 'floors' && p.floors) m.floors = num(p.floors.countSum) ?? 0;
    // Gained height, int64 millimetres, kept as metres.
    if (type === 'altitude' && p.altitude) { const mm = num(p.altitude.gainMillimetersSum); if (mm !== null) m.altitude_m = mm / 1000; }
    if (type === 'active-energy-burned' && p.activeEnergyBurned) { const k = num(p.activeEnergyBurned.kcalSum); if (k !== null) m.kcal_active = k; }
    if (type === 'sedentary-period' && p.sedentaryPeriod) { const d = p.sedentaryPeriod.durationSum; if (d !== undefined && d !== null) m.sedentary_min = Math.round(durSec(d) / 60); }
    if (type === 'swim-lengths-data' && p.swimLengthsData) m.swim_strokes = num(p.swimLengthsData.strokeCountSum) ?? 0;
    // Minutes in each heart-rate zone. A zone with no time is simply absent
    // from the list, so the four are written as zero on a day that has any.
    if (type === 'time-in-heart-rate-zone' && p.timeInHeartRateZone) {
      const z = { zone_light: 0, zone_moderate: 0, zone_vigorous: 0, zone_peak: 0 };
      for (const x of p.timeInHeartRateZone.timeInHeartRateZones || []) if (ZONE_KEY[x.heartRateZone]) z[`zone_${ZONE_KEY[x.heartRateZone]}`] += durSec(x.duration) / 60;
      for (const k of Object.keys(z)) m[k] = r1(z[k]);
    }
    if (type === 'calories-in-heart-rate-zone' && p.caloriesInHeartRateZone) {
      const z = { zkcal_light: 0, zkcal_moderate: 0, zkcal_vigorous: 0, zkcal_peak: 0 };
      for (const x of p.caloriesInHeartRateZone.caloriesInHeartRateZones || []) if (ZONE_KEY[x.heartRateZone]) z[`zkcal_${ZONE_KEY[x.heartRateZone]}`] += num(x.kcal) ?? 0;
      for (const k of Object.keys(z)) m[k] = r1(z[k]);
    }
    // A day's heart rate as a range. A day without samples has no value.
    if (type === 'heart-rate' && p.heartRate) {
      const lo = num(p.heartRate.beatsPerMinuteMin); const hi = num(p.heartRate.beatsPerMinuteMax); const avg = num(p.heartRate.beatsPerMinuteAvg);
      if (lo !== null) m.hr_min = lo;
      if (hi !== null) m.hr_max = hi;
      if (avg !== null) m.hr_avg = r1(avg);
    }
    if (type === 'run-vo2-max' && p.runVo2Max) { const v = num(p.runVo2Max.rateAvg); if (v !== null) m.vo2max_run = r1(v); }
    if (Object.keys(m).length) out.push({ date, metrics: m });
  }
  return out;
}

/** Physical-time roll-up windows of steps -> [{ start, end, steps }]. */
export function parseStepWindows(points) {
  const out = [];
  for (const p of points || []) {
    const start = ms(p.startTime);
    const end = ms(p.endTime);
    if (start === null || end === null) continue;
    out.push({ start, end, steps: num(p.steps?.countSum) ?? 0 });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Physical-time roll-up windows of heart rate -> [{ start, avg, max }].
    Windows with no samples come back without a value and are skipped. */
export function parseHrWindows(points) {
  const out = [];
  for (const p of points || []) {
    const start = ms(p.startTime);
    const avg = num(p.heartRate?.beatsPerMinuteAvg);
    if (start === null || avg === null) continue;
    out.push({ start, avg, max: num(p.heartRate?.beatsPerMinuteMax) ?? avg });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ── daily data types ─────────────────────────────────────────────── */

export function parseDaily(type, dataPoints) {
  const out = [];
  for (const dp of dataPoints || []) {
    let v; let m = null;
    switch (type) {
      case 'daily-resting-heart-rate':
        v = dp.dailyRestingHeartRate;
        if (v) m = { rhr: num(v.beatsPerMinute) };
        break;
      case 'daily-heart-rate-variability':
        v = dp.dailyHeartRateVariability;
        if (v) {
          m = {
            hrv: num(v.averageHeartRateVariabilityMilliseconds), hrv_deep: num(v.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
            hrv_entropy: num(v.entropy), hrv_nonrem_hr: num(v.nonRemHeartRateBeatsPerMinute),
          };
        }
        break;
      case 'daily-respiratory-rate':
        v = dp.dailyRespiratoryRate;
        if (v) m = { resp: num(v.breathsPerMinute) };
        break;
      case 'daily-vo2-max':
        v = dp.dailyVo2Max;
        if (v) m = { vo2max: num(v.vo2Max) };
        break;
      case 'daily-oxygen-saturation':
        v = dp.dailyOxygenSaturation;
        if (v) m = { spo2: num(v.averagePercentage), spo2_lo: num(v.lowerBoundPercentage), spo2_hi: num(v.upperBoundPercentage), spo2_sd: num(v.standardDeviationPercentage) };
        break;
      case 'daily-sleep-temperature-derivations': {
        v = dp.dailySleepTemperatureDerivations;
        if (v) {
          const t = num(v.nightlyTemperatureCelsius);
          const b = num(v.baselineTemperatureCelsius);
          m = { temp: t, temp_base: b, temp_sd: num(v.relativeNightlyStddev30dCelsius), temp_dev: t !== null && b !== null ? t - b : null };
        }
        break;
      }
      default:
        break;
    }
    const date = ymd(v?.date);
    if (!m || !date) continue;
    for (const k of Object.keys(m)) if (m[k] === null) delete m[k];
    if (Object.keys(m).length) out.push({ date, metrics: m });
  }
  return out;
}

/** The newest daily VO2 max with what Google says about it: the fitness
    level it puts the value in, and whether it is an estimate. */
export function parseVo2Level(dataPoints) {
  let best = null;
  for (const dp of dataPoints || []) {
    const v = dp?.dailyVo2Max;
    const date = ymd(v?.date);
    const value = num(v?.vo2Max);
    if (!date || value === null) continue;
    if (!best || date > best.date) best = { date, value, level: v.cardioFitnessLevel && v.cardioFitnessLevel !== 'CARDIO_FITNESS_LEVEL_UNSPECIFIED' ? v.cardioFitnessLevel : null, estimated: !!v.estimated };
  }
  return best;
}

/** The person's heart-rate zone thresholds: the newest day's, as
    `{ date, zones: [{ type: 'light', min, max }] }` in ascending order. */
export function parseHeartRateZones(dataPoints) {
  let best = null;
  for (const dp of dataPoints || []) {
    const v = dp?.dailyHeartRateZones;
    const date = ymd(v?.date);
    if (!date) continue;
    const zones = (v.heartRateZones || [])
      .map((z) => ({ type: ZONE_KEY[z.heartRateZoneType] || null, min: num(z.minBeatsPerMinute), max: num(z.maxBeatsPerMinute) }))
      .filter((z) => z.type && z.min !== null && z.max !== null)
      .sort((a, b) => a.min - b.min);
    if (zones.length && (!best || date > best.date)) best = { date, zones };
  }
  return best;
}

/* ── interval types with no roll-up: summed here ──────────────────── */

/**
 * Activity-level intervals -> minutes per civil day and level. The API has
 * no roll-up for this type, so the intervals are added up here, and one
 * that runs over local midnight is split at it.
 */
export function parseActivityLevels(dataPoints) {
  const days = {};
  for (const dp of dataPoints || []) {
    const a = dp?.activityLevel;
    const key = LEVEL_KEY[a?.activityLevelType];
    const start = ms(a?.interval?.startTime);
    const end = ms(a?.interval?.endTime);
    if (!key || start === null || end === null || end <= start) continue;
    const off = durSec(a.interval.startUtcOffset) * 1000;
    for (let t = start; t < end;) {
      // The next local midnight after t, as an instant.
      const midnight = (Math.floor((t + off) / 86_400_000) + 1) * 86_400_000 - off;
      const stop = Math.min(end, midnight);
      const date = civilOf(t, off / 1000);
      (days[date] ||= {})[key] = (days[date][key] || 0) + (stop - t) / 60_000;
      t = stop;
    }
  }
  return Object.keys(days).sort().map((date) => {
    const m = { level_sedentary: 0, level_light: 0, level_moderate: 0, level_very: 0 };
    for (const [k, v] of Object.entries(days[date])) m[k] = Math.round(v);
    return { date, metrics: m };
  });
}

/* ── dense samples, reduced to a day ──────────────────────────────── */

/** Group readings by the civil date they were taken on. */
function byDay(dataPoints, field, valueOf) {
  const days = {};
  for (const dp of dataPoints || []) {
    const v = dp?.[field];
    const at = sample(v?.sampleTime);
    const x = v ? valueOf(v) : null;
    if (!at || x === null) continue;
    (days[at.date] ||= []).push(x);
  }
  return days;
}

/** Instantaneous SpO2 -> per day: the lowest reading and the mean. */
export function reduceSpo2(dataPoints) {
  const days = byDay(dataPoints, 'oxygenSaturation', (v) => { const p = num(v.percentage); return p !== null && p > 0 && p <= 100 ? p : null; });
  return Object.keys(days).sort().map((date) => {
    const v = days[date];
    return { date, n: v.length, metrics: { spo2_min: r1(Math.min(...v)), spo2_mean: r1(v.reduce((a, b) => a + b, 0) / v.length) } };
  });
}

/** HRV samples -> per day: the mean RMSSD of that day's readings (they are
    taken in sleep, so this is the night's). Only used as `hrv` for a
    device that sends samples but no daily value. */
export function reduceHrv(dataPoints) {
  const days = byDay(dataPoints, 'heartRateVariability', (v) => { const x = num(v.rootMeanSquareOfSuccessiveDifferencesMilliseconds); return x !== null && x > 0 ? x : null; });
  return Object.keys(days).sort().map((date) => {
    const v = days[date];
    return { date, n: v.length, rmssd: r1(v.reduce((a, b) => a + b, 0) / v.length) };
  });
}

/** Respiratory rate by sleep stage, one per sleep. `full` is the whole
    night's average, used as `resp` when there is no daily value. */
export function parseRespSleep(dataPoints) {
  const out = [];
  for (const dp of dataPoints || []) {
    const v = dp?.respiratoryRateSleepSummary;
    const at = sample(v?.sampleTime);
    if (!at) continue;
    const bpm = (x) => { const n = num(x?.breathsPerMinute); return n !== null && n > 0 ? n : null; };
    const m = compact({ resp_deep: bpm(v.deepSleepStats), resp_light: bpm(v.lightSleepStats), resp_rem: bpm(v.remSleepStats) });
    const full = bpm(v.fullSleepStats);
    if (full !== null || Object.keys(m).length) out.push({ date: at.date, t: at.t, full, metrics: m });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ── sleep sessions ───────────────────────────────────────────────── */

export function parseSleep(dp) {
  const s = dp?.sleep;
  const iv = s?.interval;
  const startMs = ms(iv?.startTime);
  const endMs = ms(iv?.endTime);
  if (!s || startMs === null || endMs === null) return null;
  const startOff = durSec(iv.startUtcOffset);
  const endOff = durSec(iv.endUtcOffset);
  const stages = (s.stages || [])
    .map((st) => ({ s: ms(st.startTime), e: ms(st.endTime), t: st.type || 'SLEEP_STAGE_TYPE_UNSPECIFIED' }))
    .filter((x) => x.s !== null && x.e !== null && x.e > x.s)
    .sort((a, b) => a.s - b.s);
  const sum = s.summary || {};
  const byStage = {};
  for (const x of sum.stagesSummary || []) if (x.type) byStage[x.type] = num(x.minutes) ?? 0;
  // A session summary that has not been computed yet (processed: false)
  // still has stages; count them rather than show zero.
  if (!Object.keys(byStage).length) for (const x of stages) byStage[x.t] = (byStage[x.t] || 0) + (x.e - x.s) / 60_000;
  const periodMin = num(sum.minutesInSleepPeriod) ?? (endMs - startMs) / 60_000;
  const awakeMin = num(sum.minutesAwake) ?? (byStage.AWAKE || 0) + (byStage.RESTLESS || 0);
  const asleepMin = num(sum.minutesAsleep) ?? Math.max(0, periodMin - awakeMin);
  const meta = s.metadata || {};
  return {
    id: String(dp.name || `sleep-${startMs}`),
    date: ymd(iv.civilEndTime?.date) || civilOf(endMs, endOff),
    startMs, endMs, startOff, endOff,
    main: meta.mainSleep !== undefined ? !!meta.mainSleep : (!meta.nap && periodMin >= 180),
    asleepMin, awakeMin, periodMin,
    stages,
    summary: {
      stages: byStage,
      toFallAsleep: num(sum.minutesToFallAsleep),
      afterWake: num(sum.minutesAfterWakeUp),
      // Brief wakings the stages do not show: how many there were.
      shortAwakenings: Array.isArray(s.shortAwakenings) ? s.shortAwakenings.length : null,
      stagesStatus: meta.stagesStatus || null,
      type: s.type || null,
      processed: meta.processed !== undefined ? !!meta.processed : null,
      nap: !!meta.nap,
    },
  };
}

/* ── exercise ─────────────────────────────────────────────────────── */

export function parseExercise(dp) {
  const e = dp?.exercise;
  const iv = e?.interval;
  const startMs = ms(iv?.startTime);
  const endMs = ms(iv?.endTime);
  if (!e || startMs === null || endMs === null) return null;
  const m = e.metricsSummary || {};
  const zd = m.heartRateZoneDurations;
  const zones = zd ? { light: r1(durSec(zd.lightTime) / 60), moderate: r1(durSec(zd.moderateTime) / 60), vigorous: r1(durSec(zd.vigorousTime) / 60), peak: r1(durSec(zd.peakTime) / 60) } : null;
  const pace = num(m.averagePaceSecondsPerMeter);
  return {
    // Minutes in each heart-rate zone, the time actually moving, and the
    // average pace (seconds per kilometre), when the device reports them.
    zones: zones && Object.values(zones).some((v) => v > 0) ? zones : null,
    activeSec: e.activeDuration !== undefined && e.activeDuration !== null ? durSec(e.activeDuration) : null,
    paceSecPerKm: pace !== null && pace > 0 ? Math.round(pace * 1000) : null,
    device: sourceName(dp.dataSource),
    // Whether it has a GPS route to export (exportExerciseTcx); null when Google does not say.
    hasGps: typeof e.exerciseMetadata?.hasGps === 'boolean' ? e.exerciseMetadata.hasGps : null,
    id: String(dp.name || `exercise-${startMs}`),
    date: ymd(iv.civilStartTime?.date) || civilOf(startMs, durSec(iv.startUtcOffset)),
    startMs, endMs,
    type: e.exerciseType || null,
    name: e.displayName || null,
    kcal: num(m.caloriesKcal),
    azm: num(m.activeZoneMinutes),
    avgHr: num(m.averageHeartRateBeatsPerMinute),
    steps: num(m.steps),
    distanceM: num(m.distanceMillimeters) !== null ? num(m.distanceMillimeters) / 1000 : null,
  };
}

/* ── samples: weight, body fat, heart rate ────────────────────────── */

const sample = (st) => {
  const t = ms(st?.physicalTime);
  if (t === null) return null;
  const off = durSec(st.utcOffset);
  return { t, off, date: ymd(st.civilTime?.date) || civilOf(t, off) };
};

export function parseWeight(dp) {
  const w = dp?.weight;
  const at = sample(w?.sampleTime);
  const grams = num(w?.weightGrams);
  if (!at || grams === null || grams <= 0) return null;
  return { t: at.t, off: at.off, date: at.date, grams, note: w.notes || null };
}

export function parseBodyFat(dp) {
  const b = dp?.bodyFat;
  const at = sample(b?.sampleTime);
  const pct = num(b?.percentage);
  if (!at || pct === null) return null;
  return { t: at.t, date: at.date, pct };
}

/* ── sample rows: one reading or event each ───────────────────────── */

/** The parts every sample row shares. */
const row = (kind, dp, at, value, data = {}, end = null) => ({
  kind, t: at.t, end, off: at.off, date: at.date, value, data: compact(data),
  device: sourceName(dp.dataSource), gname: dp.name ? String(dp.name) : null,
});
/** A session or observation interval as a sample's time. */
const span = (iv) => {
  const t = ms(iv?.startTime);
  if (t === null) return null;
  const off = durSec(iv.startUtcOffset);
  return { t, off, date: ymd(iv.civilStartTime?.date) || civilOf(t, off), end: ms(iv.endTime) };
};
const known = (v, unspecified) => (v && v !== unspecified ? v : null);

/** Height, value in millimetres. */
export function parseHeight(dp) {
  const at = sample(dp?.height?.sampleTime);
  const mm = num(dp?.height?.heightMillimeters);
  if (!at || mm === null || mm <= 0 || mm > 3000) return null;
  return row('height', dp, at, mm);
}

/** Body fat as a row, value in percent (the daily `body_fat` is kept too). */
export function parseBodyFatSample(dp) {
  const at = sample(dp?.bodyFat?.sampleTime);
  const pct = num(dp?.bodyFat?.percentage);
  if (!at || pct === null || pct <= 0 || pct > 100) return null;
  return row('bodyfat', dp, at, pct);
}

/** Blood glucose, value in mg/dL. */
export function parseGlucose(dp) {
  const g = dp?.bloodGlucose;
  const at = sample(g?.sampleTime);
  const v = num(g?.bloodGlucoseMilligramsPerDeciliter);
  if (!at || v === null || v <= 0) return null;
  return row('glucose', dp, at, v, {
    timing: known(g.measurementTiming, 'MEASUREMENT_TIMING_UNSPECIFIED'), meal: known(g.mealType, 'MEAL_TYPE_UNSPECIFIED'),
    specimen: known(g.specimen, 'SPECIMEN_UNSPECIFIED'), via: known(g.measurementSource, 'MEASUREMENT_SOURCE_UNSPECIFIED'), note: g.notes || null,
  });
}

/** Core body temperature, value in degrees Celsius. */
export function parseBodyTemp(dp) {
  const b = dp?.coreBodyTemperature;
  const at = sample(b?.sampleTime);
  const v = num(b?.temperatureCelsius);
  if (!at || v === null || v <= 0) return null;
  return row('bodytemp', dp, at, v, { location: known(b.measurementLocation, 'MEASUREMENT_LOCATION_UNSPECIFIED') });
}

/** A VO2 max reading, value in ml/kg/min. */
export function parseVo2(dp) {
  const v = dp?.vo2Max;
  const at = sample(v?.sampleTime);
  const x = num(v?.vo2Max);
  if (!at || x === null || x <= 0) return null;
  return row('vo2', dp, at, x, { method: known(v.measurementMethod, 'MEASUREMENT_METHOD_UNSPECIFIED') });
}

/** A run VO2 max reading -> `{ t, date, value }` (the daily roll-up is what
    the sync stores; this reads the raw samples the same way). */
export function parseRunVo2(dp) {
  const at = sample(dp?.runVo2Max?.sampleTime);
  const x = num(dp?.runVo2Max?.runVo2Max);
  if (!at || x === null || x <= 0) return null;
  return { t: at.t, off: at.off, date: at.date, value: x };
}

/** A drink, value in millilitres. */
export function parseHydration(dp) {
  const h = dp?.hydrationLog;
  const at = span(h?.interval);
  const ml = num(h?.amountConsumed?.milliliters);
  if (!at || ml === null || ml <= 0) return null;
  return row('water', dp, at, ml, {}, at.end);
}

/** A food log, value in kilocalories; the name, meal and macros (grams)
    in `data`. Protein is one of the `nutrients`, the other two are fields. */
export function parseNutrition(dp) {
  const f = dp?.nutritionLog;
  const at = span(f?.interval);
  if (!at) return null;
  const protein = (f.nutrients || []).find((x) => x.nutrient === 'PROTEIN');
  return row('food', dp, at, num(f.energy?.kcal), {
    name: f.foodDisplayName ? String(f.foodDisplayName).slice(0, 120) : null, meal: known(f.mealType, 'MEAL_TYPE_UNSPECIFIED'),
    protein: num(protein?.quantity?.grams), carbs: num(f.totalCarbohydrate?.grams), fat: num(f.totalFat?.grams),
  }, at.end);
}

/** An ECG reading, value = average heart rate. The waveform is counted,
    not kept: thousands of numbers per reading that nothing here draws. */
export function parseEcg(dp) {
  const e = dp?.electrocardiogram;
  const at = span(e?.interval);
  if (!at) return null;
  const n = Array.isArray(e.waveformSamples) ? e.waveformSamples.length : 0;
  const hz = num(e.samplingFrequencyHertz);
  const fromWave = n && hz ? Math.round(n / hz) : null;
  return row('ecg', dp, at, num(e.beatsPerMinuteAvg), {
    classification: known(e.resultClassification, 'RESULT_CLASSIFICATION_UNSPECIFIED'),
    durationSec: at.end !== null && at.end > at.t ? Math.round((at.end - at.t) / 1000) : fromWave,
    leads: num(e.leadNumber), samplingHz: hz, samples: n || null, model: e.medicalDeviceInfo?.deviceModel || null,
  }, at.end);
}

/** An irregular rhythm notice, value = how many analysis windows it rests
    on. The beats themselves are summarised (lowest, highest, mean). */
export function parseIrn(dp) {
  const x = dp?.irregularRhythmNotification;
  const at = span(x?.interval);
  if (!at) return null;
  const wins = x.alertWindows || [];
  const beats = wins.flatMap((w) => (w.heartBeats || []).map((b) => num(b.beatsPerMinute))).filter((b) => b !== null && b > 0);
  return row('irn', dp, at, wins.length, {
    positive: wins.filter((w) => w.positive).length,
    minBpm: beats.length ? Math.min(...beats) : null, maxBpm: beats.length ? Math.max(...beats) : null,
    avgBpm: beats.length ? Math.round(beats.reduce((a, b) => a + b, 0) / beats.length) : null,
    model: x.medicalDeviceInfo?.deviceModel || null,
  }, at.end);
}

/** The parser for each sample kind this app reads from Google. */
export const SAMPLE_PARSERS = {
  height: parseHeight, bodyfat: parseBodyFatSample, glucose: parseGlucose, bodytemp: parseBodyTemp, vo2: parseVo2,
  water: parseHydration, food: parseNutrition, ecg: parseEcg, irn: parseIrn,
};

/** The most recent heart-rate sample in a list, whatever order it came in. */
export function latestHeartRate(dataPoints) {
  let best = null;
  for (const dp of dataPoints || []) {
    const at = sample(dp?.heartRate?.sampleTime);
    const bpm = num(dp?.heartRate?.beatsPerMinute);
    if (!at || bpm === null) continue;
    if (!best || at.t > best.t) best = { t: at.t, bpm };
  }
  return best;
}

/* ── paired devices ───────────────────────────────────────────────── */

/** The tracker, or failing that whatever was synced last. A phone-only
    account has no paired device at all. */
export function pickDevice(list) {
  const devs = (list || []).map((d) => ({
    name: d.deviceVersion || 'Tracker',
    type: d.deviceType || null,
    battery: num(d.batteryLevel),
    batteryStatus: d.batteryStatus || null,
    lastSync: ms(d.lastSyncTime),
  }));
  devs.sort((a, b) => (b.type === 'TRACKER') - (a.type === 'TRACKER') || (b.lastSync || 0) - (a.lastSync || 0));
  return devs[0] || null;
}
