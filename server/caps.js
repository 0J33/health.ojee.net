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

   The capabilities added with "all the data" follow the same rule,
   with three honest exceptions: height is a capability once there is
   any (nobody measures it fortnightly), and cycle entries and ECG
   readings are looked for over a longer window, because a period
   comes monthly and an ECG is taken now and then. The kinds a person
   logs by hand count when they logged one in the window. What is
   missing among the new ones is listed apart (`missingMore`), and a
   capability that belongs to an optional group is only called
   missing while that group is switched on. Stress and Body Battery come
   only from a Garmin watch read directly (server/garmin.js): they are
   called missing only while Garmin is connected. A Garmin person's
   capabilities are worked out by the same rule from what Garmin sent.
   ============================================================ */

import { addDays, today as todayIn } from './core/util.js';

export const CAP_DAYS = 14;
export const CORE_CAPS = ['steps', 'activeMinutes', 'calories', 'distance', 'heartRate', 'heartRateMinute', 'restingHr', 'hrv', 'spo2', 'skinTemp', 'sleep', 'sleepStages', 'weight', 'bodyFat', 'exercise', 'deviceBattery'];
export const MORE_CAPS = ['floors', 'caloriesActive', 'respiratoryRate', 'vo2max', 'zones', 'glucose', 'bodyTemp', 'height', 'hydration', 'nutrition', 'mood', 'symptoms', 'cycle', 'ecg', 'stress', 'bodyBattery'];
export const CAPS = [...CORE_CAPS, ...MORE_CAPS];
/** The optional group a capability belongs to. */
export const CAP_GROUP = { hydration: 'nutrition', nutrition: 'nutrition', mood: 'mindfulness', symptoms: 'symptoms', cycle: 'cycle', ecg: 'ecg' };
/** Capabilities only a Garmin read directly gives: called missing only
    while Garmin is connected (nobody else's device could give them). */
export const CAP_GARMIN = ['stress', 'bodyBattery'];
/** Capabilities looked for over more than CAP_DAYS. */
export const CAP_WINDOW = { cycle: 45, ecg: 90 };

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
  floors: 'No floors climbed are arriving. A watch or band with an altimeter reports them',
  caloriesActive: 'Your device does not report active energy. A watch or band with a heart-rate sensor does',
  respiratoryRate: 'No breathing rate. A watch or band that tracks sleep with a heart-rate sensor reports it',
  vo2max: 'No VO2 max estimate. A watch with heart rate reports one, usually after a few outdoor runs or walks',
  zones: 'No time in heart-rate zones. A watch or band with continuous heart rate reports it',
  glucose: 'No glucose readings. A connected glucose meter or sensor reports them, or log one here',
  bodyTemp: 'No body temperature readings. A connected thermometer reports them, or log one here',
  height: 'No height yet. Log it here, or set it in the Google Health app',
  hydration: 'No water logged in the last two weeks. Log a glass here',
  nutrition: 'No food logged in the last two weeks. Log a meal here',
  mood: 'No mood logged in the last two weeks. Log one here',
  symptoms: 'No symptoms logged in the last two weeks. Log one here when you have any',
  cycle: 'No period or ovulation test logged recently. Log one here',
  ecg: 'No ECG readings or rhythm notices. A watch with an ECG app takes them',
  stress: 'No stress score from Garmin in the last two weeks. Wear the watch through the day and let it sync',
  bodyBattery: 'No Body Battery from Garmin in the last two weeks. Wear the watch through the day and night',
};

/** The words for a person whose numbers come from Garmin alone. */
const GARMIN_TEXT = {
  steps: 'No steps are arriving from Garmin. Check that the watch syncs to Garmin Connect',
  exercise: 'No activities from Garmin in the last two weeks',
  deviceBattery: 'Garmin does not share your watch\'s battery with other apps',
  skinTemp: 'Your Garmin does not report sleep temperature',
  height: 'No height yet. Log it here',
};

/** Compute and store a person's capabilities from their own store.
    `googleOn` false with Garmin connected: the words are Garmin's. */
export function computeCaps(db, { now = Date.now(), tz, groups = db.meta('groups', {}) || {}, garmin = !!db.meta('garmin', null)?.connected, googleOn = null } = {}) {
  const say = (k) => (garmin && googleOn === false && GARMIN_TEXT[k]) || MISSING_TEXT[k];
  const today = todayIn(now, tz);
  const since = addDays(today, -(CAP_DAYS - 1));
  const sinceMs = now - CAP_DAYS * 86_400_000;
  const last = db.lastDates();
  const samples = db.sampleStats();
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
    floors: last.floors || null,
    caloriesActive: last.kcal_active || null,
    respiratoryRate: last.resp || null,
    vo2max: newest(last.vo2max, last.vo2max_run),
    zones: newest(last.zone_light, last.zone_moderate, last.zone_vigorous, last.zone_peak),
    glucose: samples.glucose?.last || null,
    bodyTemp: samples.bodytemp?.last || null,
    height: newest(samples.height?.last, last.height_mm),
    hydration: samples.water?.last || null,
    nutrition: samples.food?.last || null,
    mood: samples.mood?.last || null,
    symptoms: samples.symptom?.last || null,
    cycle: newest(samples.period?.last, samples.ovulation?.last),
    ecg: newest(samples.ecg?.last, samples.irn?.last),
    stress: last.stress || null,
    bodyBattery: newest(last.bb_high, last.bb_low),
  };
  const caps = {};
  for (const k of CAPS) caps[k] = !!lastSeen[k] && lastSeen[k] >= (CAP_WINDOW[k] ? addDays(today, -(CAP_WINDOW[k] - 1)) : since);
  // Height does not go stale.
  caps.height = !!lastSeen.height;
  // Instants, not civil dates, for the two that are kept as times.
  if (hr?.t) caps.heartRate = hr.t >= sinceMs;
  if (dense?.t) caps.heartRateMinute = dense.t >= sinceMs;
  const out = {
    caps,
    meta: {
      updatedAt: now, windowDays: CAP_DAYS, lastSeen,
      missing: CORE_CAPS.filter((k) => !caps[k]).map((k) => ({ cap: k, text: say(k) })),
      // The newer ones, apart, so a page that lists `missing` says what it
      // always said. A group's capability is only missing while the group is on.
      missingMore: MORE_CAPS.filter((k) => !caps[k] && (!CAP_GROUP[k] || groups[CAP_GROUP[k]]) && (!CAP_GARMIN.includes(k) || garmin)).map((k) => ({ cap: k, text: say(k), group: CAP_GROUP[k] || null })),
    },
  };
  db.setMeta('caps', out);
  return out;
}

/** The stored capabilities; everything false before the first sync. */
export function readCaps(db) {
  const c = db.meta('caps');
  if (c?.caps) return c;
  return { caps: Object.fromEntries(CAPS.map((k) => [k, false])), meta: { updatedAt: null, windowDays: CAP_DAYS, lastSeen: {}, missing: [], missingMore: [] } };
}
