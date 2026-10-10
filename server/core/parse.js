/* ============================================================
   health.ojee.net — Google Health API JSON -> rows.

   Pure functions, no I/O, so they are tested against fixtures shaped
   exactly like the API's discovery document says the replies are:
   int64 values arrive as strings, durations as "10800s", civil dates
   as { year, month, day }, and every DataPoint carries its value
   under a camelCase key named for its data type (`dailyRestingHeart
   Rate`, `sleep`, `weight`, …).
   ============================================================ */

import { num, ymd, durSec, ms } from './util.js';

/** The civil date of an instant, given the wearer's UTC offset then. */
const civilOf = (tMs, offSec) => new Date(tMs + offSec * 1000).toISOString().slice(0, 10);

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
        if (v) m = { hrv: num(v.averageHeartRateVariabilityMilliseconds), hrv_deep: num(v.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds) };
        break;
      case 'daily-oxygen-saturation':
        v = dp.dailyOxygenSaturation;
        if (v) m = { spo2: num(v.averagePercentage), spo2_lo: num(v.lowerBoundPercentage), spo2_hi: num(v.upperBoundPercentage) };
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
  return {
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
