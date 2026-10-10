/* ============================================================
   health.ojee.net — capabilities: what this person's device (or
   phone) actually reports.

   People connect a Fitbit, a Pixel Watch, a Garmin through Health
   Connect, an Apple Watch through Apple Health, or nothing but a
   phone. So nothing is assumed: after each sync, a stream is a
   capability only if it produced data in the last 14 days. The
   frontend hides or explains what is missing, readiness uses what
   there is, and workout detection is only offered with minute-level
   heart rate.
   ============================================================ */

import { addDays, today as todayIn } from './core/util.js';

export const CAP_DAYS = 14;
export const CAPS = ['steps', 'activeMinutes', 'calories', 'distance', 'heartRate', 'heartRateMinute', 'restingHr', 'hrv', 'spo2', 'skinTemp', 'sleep', 'sleepStages', 'weight', 'bodyFat', 'exercise', 'deviceBattery'];

/** What to say about each one when it is missing. */
export const MISSING_TEXT = {
  steps: 'No steps are arriving. Check that your phone or watch is linked in the Google Health app',
  activeMinutes: 'Your device does not report active minutes',
  calories: 'Your device does not report calories',
  distance: 'Your device does not report distance',
  heartRate: 'Your device does not report heart rate',
  heartRateMinute: 'Your device does not report minute-by-minute heart rate, so workouts cannot be detected automatically',
  restingHr: 'Your device does not report resting heart rate',
  hrv: 'Your device does not report HRV',
  spo2: 'Your device does not report blood oxygen',
  skinTemp: 'Your device does not report sleep temperature',
  sleep: 'No sleep is arriving. Wear your device at night to see it here',
  sleepStages: 'Your device does not report sleep stages',
  weight: 'No weigh-ins yet. Log one here or use a connected scale',
  bodyFat: 'No body fat readings',
  exercise: 'No workouts in Google Health in the last two weeks',
  deviceBattery: 'Your device does not report its battery to Google',
};

/** Compute and store a person's capabilities from their own store. */
export function computeCaps(db, { now = Date.now(), tz } = {}) {
  const today = todayIn(now, tz);
  const since = addDays(today, -(CAP_DAYS - 1));
  const sinceMs = now - CAP_DAYS * 86_400_000;
  const last = db.lastDates();
  const day = (ms, off = 0) => (ms ? new Date(ms + off).toISOString().slice(0, 10) : null);
  const newest = (...d) => d.filter(Boolean).sort().pop() || null;
  const hr = db.meta('hr');
  const dense = db.meta('hrDense');
  const device = db.meta('device');
  const lastSeen = {
    steps: last.steps || null,
    activeMinutes: newest(last.azm, last.active_min),
    calories: last.kcal || null,
    distance: last.distance_m || null,
    heartRate: hr?.t ? day(hr.t) : null,
    heartRateMinute: dense?.t ? day(dense.t) : null,
    restingHr: last.rhr || null,
    hrv: last.hrv || null,
    spo2: last.spo2 || null,
    skinTemp: last.temp || null,
    sleep: newest(last.sleep_min, db.lastSleepDate()),
    sleepStages: newest(last.sleep_deep, last.sleep_rem),
    weight: day(db.lastWeightMs()),
    bodyFat: last.body_fat || null,
    exercise: db.lastExerciseDate(),
    deviceBattery: device && Number.isFinite(device.battery) ? today : null,
  };
  const caps = {};
  for (const k of CAPS) caps[k] = !!lastSeen[k] && lastSeen[k] >= since;
  // Instants, not civil dates, for the two that are kept as times.
  if (hr?.t) caps.heartRate = hr.t >= sinceMs;
  if (dense?.t) caps.heartRateMinute = dense.t >= sinceMs;
  const out = {
    caps,
    meta: {
      updatedAt: now, windowDays: CAP_DAYS, lastSeen,
      missing: CAPS.filter((k) => !caps[k]).map((k) => ({ cap: k, text: MISSING_TEXT[k] })),
    },
  };
  db.setMeta('caps', out);
  return out;
}

/** The stored capabilities; everything false before the first sync. */
export function readCaps(db) {
  const c = db.meta('caps');
  if (c?.caps) return c;
  return { caps: Object.fromEntries(CAPS.map((k) => [k, false])), meta: { updatedAt: null, windowDays: CAP_DAYS, lastSeen: {}, missing: [] } };
}
