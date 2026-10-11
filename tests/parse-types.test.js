/* Parsing of every data type added with "all the data". The payloads are
   shaped like the real API's replies: the field sets are the ones a read-only
   probe of the live API returned on 2026-10-11, the rest is from the discovery
   schemas (int64 as strings, durations as "123s", civil dates as objects). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRollup, parseDaily, parseSleep, parseExercise, parseVo2Level, parseHeartRateZones, parseActivityLevels, parseRespSleep,
  reduceSpo2, reduceHrv, parseHeight, parseBodyFatSample, parseGlucose, parseBodyTemp, parseVo2, parseRunVo2, parseHydration, parseNutrition,
  parseEcg, parseIrn, sourceName, SAMPLE_PARSERS,
} from '../server/core/parse.js';

const day = (d) => ({ date: { year: 2026, month: 10, day: d } });
const win = (d) => ({ civilStartTime: day(d), civilEndTime: day(d + 1) });
const DEVICE = { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED', device: { displayName: 'Fitbit Air', formFactor: 'FITNESS_BAND', manufacturer: 'Google' }, application: { packageName: 'com.fitbit.FitbitMobile' } };
/** A sample time at HH:MM local on October `d`, in a +03:00 zone. */
const st = (d, hh, mm = 0) => ({
  physicalTime: new Date(Date.UTC(2026, 9, d, hh - 3, mm)).toISOString(), utcOffset: '10800s',
  civilTime: { date: { year: 2026, month: 10, day: d }, time: { hours: hh, minutes: mm } },
});
const at = (d, hh, mm = 0) => Date.UTC(2026, 9, d, hh - 3, mm);
const iv = (d, hh, mm, lenMin, civil = true) => ({
  startTime: new Date(at(d, hh, mm)).toISOString(), endTime: new Date(at(d, hh, mm) + lenMin * 60_000).toISOString(), startUtcOffset: '10800s', endUtcOffset: '10800s',
  ...(civil ? { civilStartTime: { date: { year: 2026, month: 10, day: d }, time: { hours: hh, minutes: mm } }, civilEndTime: { date: { year: 2026, month: 10, day: d }, time: { hours: hh, minutes: mm + lenMin } } } : {}),
});

test('daily roll-ups: floors, altitude, active energy, sedentary time, swim strokes', () => {
  assert.deepEqual(parseRollup('floors', [{ ...win(5), floors: { countSum: '14' } }, { ...win(6), floors: { countSum: '0' } }]),
    [{ date: '2026-10-05', metrics: { floors: 14 } }, { date: '2026-10-06', metrics: { floors: 0 } }]);
  assert.deepEqual(parseRollup('altitude', [{ ...win(5), altitude: { gainMillimetersSum: '42672' } }]), [{ date: '2026-10-05', metrics: { altitude_m: 42.672 } }]);
  assert.deepEqual(parseRollup('active-energy-burned', [{ ...win(5), activeEnergyBurned: { kcalSum: 612.4 } }]), [{ date: '2026-10-05', metrics: { kcal_active: 612.4 } }]);
  assert.deepEqual(parseRollup('sedentary-period', [{ ...win(5), sedentaryPeriod: { durationSum: '38460s' } }]), [{ date: '2026-10-05', metrics: { sedentary_min: 641 } }]);
  assert.deepEqual(parseRollup('swim-lengths-data', [{ ...win(5), swimLengthsData: { strokeCountSum: '612' } }]), [{ date: '2026-10-05', metrics: { swim_strokes: 612 } }]);
  // A window with nothing in it carries no value key, and gives no row.
  assert.deepEqual(parseRollup('floors', [win(7)]), []);
  assert.deepEqual(parseRollup('active-energy-burned', [{ ...win(7), activeEnergyBurned: {} }]), []);
});

test('daily roll-ups: time and calories in heart-rate zones (absent zones are zero), the day\'s heart-rate range, run VO2 max', () => {
  const [z] = parseRollup('time-in-heart-rate-zone', [{ ...win(5), timeInHeartRateZone: { timeInHeartRateZones: [
    { heartRateZone: 'LIGHT', duration: '7320s' }, { heartRateZone: 'MODERATE', duration: '1260s' }, { heartRateZone: 'VIGOROUS', duration: '330s' },
  ] } }]);
  assert.deepEqual(z, { date: '2026-10-05', metrics: { zone_light: 122, zone_moderate: 21, zone_vigorous: 5.5, zone_peak: 0 } });
  const [k] = parseRollup('calories-in-heart-rate-zone', [{ ...win(5), caloriesInHeartRateZone: { caloriesInHeartRateZones: [
    { heartRateZone: 'LIGHT', kcal: 500.21 }, { heartRateZone: 'PEAK', kcal: 52.4 },
  ] } }]);
  assert.deepEqual(k.metrics, { zkcal_light: 500.2, zkcal_moderate: 0, zkcal_vigorous: 0, zkcal_peak: 52.4 });
  const [h] = parseRollup('heart-rate', [{ ...win(5), heartRate: { beatsPerMinuteAvg: 72.48, beatsPerMinuteMax: 171, beatsPerMinuteMin: 51 } }, { ...win(6), heartRate: {} }]);
  assert.deepEqual(h, { date: '2026-10-05', metrics: { hr_min: 51, hr_max: 171, hr_avg: 72.5 } });
  assert.deepEqual(parseRollup('run-vo2-max', [{ ...win(5), runVo2Max: { rateAvg: 45.83, rateMax: 46.1, rateMin: 45.5 } }]), [{ date: '2026-10-05', metrics: { vo2max_run: 45.8 } }]);
});

test('activity level: intervals summed per civil day and level, split at local midnight', () => {
  const lv = (type, d, hh, mm, len) => ({ activityLevel: { activityLevelType: type, interval: iv(d, hh, mm, len) }, dataSource: DEVICE });
  const rows = parseActivityLevels([
    lv('SEDENTARY', 5, 9, 0, 200), lv('SEDENTARY', 5, 14, 0, 100), lv('LIGHTLY_ACTIVE', 5, 12, 20, 45), lv('VERY_ACTIVE', 5, 18, 0, 22),
    // 23:30 for an hour: half belongs to the 5th, half to the 6th.
    lv('MODERATELY_ACTIVE', 5, 23, 30, 60),
    lv('ACTIVITY_LEVEL_TYPE_UNSPECIFIED', 5, 10, 0, 30),
    { activityLevel: { activityLevelType: 'SEDENTARY', interval: {} } },
  ]);
  assert.deepEqual(rows, [
    { date: '2026-10-05', metrics: { level_sedentary: 300, level_light: 45, level_moderate: 30, level_very: 22 } },
    { date: '2026-10-06', metrics: { level_sedentary: 0, level_light: 0, level_moderate: 30, level_very: 0 } },
  ]);
});

test('daily types: respiratory rate, VO2 max (and its fitness level), the extra HRV and SpO2 fields', () => {
  assert.deepEqual(parseDaily('daily-respiratory-rate', [{ dailyRespiratoryRate: { breathsPerMinute: 14.6, ...day(6) }, dataSource: DEVICE }]), [{ date: '2026-10-06', metrics: { resp: 14.6 } }]);
  const vo2 = [
    { dailyVo2Max: { ...day(5), vo2Max: 44.1, vo2MaxCovariance: 1.9, estimated: false, cardioFitnessLevel: 'GOOD' } },
    { dailyVo2Max: { ...day(6), vo2Max: 44.3, estimated: true, cardioFitnessLevel: 'VERY_GOOD' } },
  ];
  assert.deepEqual(parseDaily('daily-vo2-max', vo2).map((r) => r.metrics.vo2max), [44.1, 44.3]);
  assert.deepEqual(parseVo2Level(vo2), { date: '2026-10-06', value: 44.3, level: 'VERY_GOOD', estimated: true });
  assert.equal(parseVo2Level([]), null);
  const [hrv] = parseDaily('daily-heart-rate-variability', [{ dailyHeartRateVariability: {
    ...day(6), averageHeartRateVariabilityMilliseconds: 47.3, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 55.1, entropy: 3.21, nonRemHeartRateBeatsPerMinute: '58',
  } }]);
  assert.deepEqual(hrv.metrics, { hrv: 47.3, hrv_deep: 55.1, hrv_entropy: 3.21, hrv_nonrem_hr: 58 });
  const [sp] = parseDaily('daily-oxygen-saturation', [{ dailyOxygenSaturation: { ...day(6), averagePercentage: 96.4, lowerBoundPercentage: 94.1, upperBoundPercentage: 98, standardDeviationPercentage: 0.7 } }]);
  assert.deepEqual(sp.metrics, { spo2: 96.4, spo2_lo: 94.1, spo2_hi: 98, spo2_sd: 0.7 });
});

test('heart-rate zone thresholds: the newest day, ascending, int64 strings read as numbers', () => {
  const zones = (d, base) => ({ dailyHeartRateZones: { ...day(d), heartRateZones: [
    { heartRateZoneType: 'PEAK', minBeatsPerMinute: String(base + 70), maxBeatsPerMinute: '220' },
    { heartRateZoneType: 'LIGHT', minBeatsPerMinute: String(base), maxBeatsPerMinute: String(base + 11) },
    { heartRateZoneType: 'MODERATE', minBeatsPerMinute: String(base + 12), maxBeatsPerMinute: String(base + 37) },
    { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: String(base + 38), maxBeatsPerMinute: String(base + 69) },
  ] }, dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' } });
  assert.deepEqual(parseHeartRateZones([zones(6, 99), zones(4, 97)]), { date: '2026-10-06', zones: [
    { type: 'light', min: 99, max: 110 }, { type: 'moderate', min: 111, max: 136 }, { type: 'vigorous', min: 137, max: 168 }, { type: 'peak', min: 169, max: 220 },
  ] });
  assert.equal(parseHeartRateZones([{ dailyHeartRateZones: { ...day(6), heartRateZones: [] } }]), null);
});

test('respiratory rate by sleep stage: per night, with the whole-night average kept apart', () => {
  const stat = (b) => ({ breathsPerMinute: b, signalToNoise: 5.2, standardDeviation: 1.1 });
  const rows = parseRespSleep([{
    name: 'users/me/dataTypes/respiratory-rate-sleep-summary/dataPoints/abc',
    respiratoryRateSleepSummary: { sampleTime: st(6, 7, 5), fullSleepStats: stat(14.6), deepSleepStats: stat(13.8), lightSleepStats: stat(14.7), remSleepStats: stat(15.5) },
    dataSource: DEVICE,
  }, { respiratoryRateSleepSummary: { sampleTime: st(5, 6, 50), fullSleepStats: stat(14.2), deepSleepStats: { breathsPerMinute: 0 } } }]);
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-05', '2026-10-06'], 'oldest first');
  assert.deepEqual(rows[1], { date: '2026-10-06', t: at(6, 7, 5), full: 14.6, metrics: { resp_deep: 13.8, resp_light: 14.7, resp_rem: 15.5 } });
  assert.deepEqual(rows[0].metrics, {}, 'a stage with no value is left out, not written as zero');
  assert.equal(rows[0].full, 14.2);
});

test('dense samples are reduced to a day: SpO2 lowest and mean, HRV mean RMSSD', () => {
  const o2 = (d, hh, pct) => ({ oxygenSaturation: { percentage: pct, sampleTime: st(d, hh) }, dataSource: DEVICE });
  assert.deepEqual(reduceSpo2([o2(6, 1, 96.5), o2(6, 2, 93.1), o2(6, 3, 97.4), o2(5, 2, 95), o2(5, 3, 0), { oxygenSaturation: { percentage: 96 } }]), [
    { date: '2026-10-05', n: 1, metrics: { spo2_min: 95, spo2_mean: 95 } },
    { date: '2026-10-06', n: 3, metrics: { spo2_min: 93.1, spo2_mean: 95.7 } },
  ]);
  const hv = (d, hh, ms) => ({ heartRateVariability: { rootMeanSquareOfSuccessiveDifferencesMilliseconds: ms, metadata: { highFrequencyPower: 412.5, lowFrequencyPower: 803.2 }, sampleTime: st(d, hh) }, dataSource: DEVICE });
  assert.deepEqual(reduceHrv([hv(6, 1, 40), hv(6, 2, 50), hv(6, 3, 61), { heartRateVariability: { standardDeviationMilliseconds: 30, sampleTime: st(6, 4) } }]), [{ date: '2026-10-06', n: 3, rmssd: 50.3 }]);
});

test('samples: height, body fat, glucose, body temperature, VO2 max', () => {
  const h = parseHeight({ name: 'users/me/dataTypes/height/dataPoints/h1', height: { heightMillimeters: '1780', sampleTime: st(1, 9) }, dataSource: { platform: 'FITBIT', recordingMethod: 'MANUAL' } });
  assert.deepEqual(h, { kind: 'height', t: at(1, 9), end: null, off: 10800, date: '2026-10-01', value: 1780, data: {}, device: 'Logged by hand', gname: 'users/me/dataTypes/height/dataPoints/h1' });
  assert.equal(parseHeight({ height: { heightMillimeters: '0', sampleTime: st(1, 9) } }), null);
  const bf = parseBodyFatSample({ bodyFat: { percentage: 19.2, sampleTime: st(5, 7, 10) }, dataSource: { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED', device: { formFactor: 'SCALE', manufacturer: 'Withings' } } });
  assert.deepEqual([bf.kind, bf.value, bf.date, bf.device, bf.gname], ['bodyfat', 19.2, '2026-10-05', 'Withings scale', null]);
  const g = parseGlucose({ name: 'users/me/dataTypes/blood-glucose/dataPoints/g1', bloodGlucose: {
    bloodGlucoseMilligramsPerDeciliter: 94, measurementTiming: 'FASTING', mealType: 'BREAKFAST', specimen: 'CAPILLARY_BLOOD', measurementSource: 'SELF_MONITORING_BLOOD_GLUCOSE', notes: 'before coffee', sampleTime: st(6, 7, 25),
  }, dataSource: { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED', application: { packageName: 'com.example.glucometer' } } });
  assert.deepEqual([g.kind, g.value, g.device], ['glucose', 94, 'Health Connect']);
  assert.deepEqual(g.data, { timing: 'FASTING', meal: 'BREAKFAST', specimen: 'CAPILLARY_BLOOD', via: 'SELF_MONITORING_BLOOD_GLUCOSE', note: 'before coffee' });
  assert.deepEqual(parseGlucose({ bloodGlucose: { bloodGlucoseMilligramsPerDeciliter: 101, measurementTiming: 'MEASUREMENT_TIMING_UNSPECIFIED', sampleTime: st(6, 8) } }).data, {}, 'unspecified enums are dropped');
  const bt = parseBodyTemp({ coreBodyTemperature: { temperatureCelsius: 36.8, measurementLocation: 'EAR', sampleTime: st(6, 21, 40) } });
  assert.deepEqual([bt.kind, bt.value, bt.data], ['bodytemp', 36.8, { location: 'EAR' }]);
  const v = parseVo2({ vo2Max: { vo2Max: 44.2, measurementMethod: 'GOOGLE_DEMOGRAPHIC', sampleTime: st(4, 10) }, dataSource: DEVICE });
  assert.deepEqual([v.kind, v.value, v.data, v.device], ['vo2', 44.2, { method: 'GOOGLE_DEMOGRAPHIC' }, 'Fitbit Air']);
  assert.deepEqual(parseRunVo2({ runVo2Max: { runVo2Max: 45.8, sampleTime: st(4, 9, 10) } }), { t: at(4, 9, 10), off: 10800, date: '2026-10-04', value: 45.8 });
  for (const f of Object.values(SAMPLE_PARSERS)) { assert.equal(f({}), null); assert.equal(f(null), null); }
});

test('what this app wrote, read back: a drink and a food log', () => {
  const own = { platform: 'GOOGLE_WEB_API', recordingMethod: 'MANUAL', application: { googleWebClientId: '1234.apps.googleusercontent.com' } };
  const w = parseHydration({ name: 'users/me/dataTypes/hydration-log/dataPoints/ojee-water-1', hydrationLog: { amountConsumed: { milliliters: 250, userProvidedUnit: 'MILLILITER' }, interval: iv(6, 10, 15, 1) }, dataSource: own });
  assert.deepEqual(w, { kind: 'water', t: at(6, 10, 15), end: at(6, 10, 16), off: 10800, date: '2026-10-06', value: 250, data: {}, device: 'Logged by hand', gname: 'users/me/dataTypes/hydration-log/dataPoints/ojee-water-1' });
  const f = parseNutrition({ name: 'users/me/dataTypes/nutrition-log/dataPoints/ojee-food-1', nutritionLog: {
    foodDisplayName: 'Chicken and rice', mealType: 'LUNCH', energy: { kcal: 640 }, totalFat: { grams: 16 }, totalCarbohydrate: { grams: 70 },
    nutrients: [{ nutrient: 'DIETARY_FIBER', quantity: { grams: 4 } }, { nutrient: 'PROTEIN', quantity: { grams: 46 } }], interval: iv(6, 13, 20, 1, false),
  }, dataSource: own });
  assert.deepEqual([f.kind, f.value, f.date, f.t], ['food', 640, '2026-10-06', at(6, 13, 20)]);
  assert.deepEqual(f.data, { name: 'Chicken and rice', meal: 'LUNCH', protein: 46, carbs: 70, fat: 16 });
  // An identified food with no numbers of its own still parses.
  assert.deepEqual(parseNutrition({ nutritionLog: { foodDisplayName: 'Tea', interval: iv(6, 16, 0, 1) } }).data, { name: 'Tea' });
});

test('an ECG keeps its reading and drops the waveform; a rhythm notice keeps a summary of its beats', () => {
  const e = parseEcg({ name: 'users/me/dataTypes/electrocardiogram/dataPoints/e1', electrocardiogram: {
    interval: iv(6, 20, 15, 0.5, false), resultClassification: 'NORMAL_SINUS_RHYTHM', beatsPerMinuteAvg: '66', leadNumber: 1, samplingFrequencyHertz: 250, millivoltsScalingFactor: 1000,
    waveformSamples: Array.from({ length: 7500 }, (_, i) => i % 300), medicalDeviceInfo: { firmwareVersion: '1.184.52', featureVersion: '2.1', deviceModel: 'Pixel Watch 4' },
  }, dataSource: DEVICE });
  assert.deepEqual([e.kind, e.value, e.end - e.t, e.device], ['ecg', 66, 30_000, 'Fitbit Air']);
  assert.deepEqual(e.data, { classification: 'NORMAL_SINUS_RHYTHM', durationSec: 30, leads: 1, samplingHz: 250, samples: 7500, model: 'Pixel Watch 4' });
  assert.ok(JSON.stringify(e).length < 500, 'no waveform in the row');
  const beat = (bpm) => ({ physicalTime: new Date(at(6, 2)).toISOString(), utcOffset: '10800s', beatsPerMinute: bpm });
  const w = (positive, beats) => ({ startTime: new Date(at(6, 2)).toISOString(), endTime: new Date(at(6, 2, 15)).toISOString(), startUtcOffset: '10800s', endUtcOffset: '10800s', positive, heartBeats: beats.map(beat) });
  const n = parseIrn({ name: 'users/me/dataTypes/irregular-rhythm-notification/dataPoints/n1', irregularRhythmNotification: {
    interval: iv(6, 2, 0, 40), alertWindows: [w(true, [58, 104, 77]), w(true, [61, 96])], medicalDeviceInfo: { algorithmVersion: '1.2.0', serviceVersion: '4.7', deviceModel: 'Pixel Watch 4' },
  } });
  assert.deepEqual([n.kind, n.value, n.end - n.t], ['irn', 2, 40 * 60_000]);
  assert.deepEqual(n.data, { positive: 2, minBpm: 58, maxBpm: 104, avgBpm: 79, model: 'Pixel Watch 4' });
});

test('sleep keeps short awakenings, minutes after waking and the stages status; no civil times needed', () => {
  const seg = (hh, mm, len, type) => ({ startTime: new Date(at(6, hh, mm)).toISOString(), endTime: new Date(at(6, hh, mm) + len * 60_000).toISOString(), startUtcOffset: '10800s', endUtcOffset: '10800s', type });
  const s = parseSleep({ name: 'users/me/dataTypes/sleep/dataPoints/s1', sleep: {
    // As the real list returns it: start and end with offsets, no civil times.
    interval: { startTime: new Date(at(5, 23, 30)).toISOString(), endTime: new Date(at(6, 7, 0)).toISOString(), startUtcOffset: '10800s', endUtcOffset: '10800s' },
    type: 'STAGES', stages: [seg(0, 0, 90, 'LIGHT'), seg(1, 30, 60, 'DEEP')], shortAwakenings: [seg(2, 0, 1, 'AWAKE'), seg(4, 10, 2, 'AWAKE'), seg(5, 0, 1, 'AWAKE')],
    metadata: { mainSleep: true, processed: true, stagesStatus: 'SUCCEEDED' },
    summary: { minutesAsleep: '420', minutesAwake: '30', minutesInSleepPeriod: '450', minutesToFallAsleep: '6', minutesAfterWakeUp: '4', stagesSummary: [{ type: 'LIGHT', minutes: '250', count: '12' }, { type: 'DEEP', minutes: '80', count: '4' }] },
  }, dataSource: DEVICE });
  assert.equal(s.date, '2026-10-06', 'the wake date, from the end offset');
  assert.deepEqual([s.summary.shortAwakenings, s.summary.afterWake, s.summary.stagesStatus, s.summary.toFallAsleep], [3, 4, 'SUCCEEDED', 6]);
  const classic = parseSleep({ sleep: { interval: { startTime: new Date(at(5, 23, 30)).toISOString(), endTime: new Date(at(6, 7, 0)).toISOString(), startUtcOffset: '10800s', endUtcOffset: '10800s' } } });
  assert.deepEqual([classic.summary.shortAwakenings, classic.summary.afterWake, classic.summary.stagesStatus], [null, null, null]);
});

test('exercise keeps time in zones, moving time and pace', () => {
  const e = parseExercise({ name: 'users/me/dataTypes/exercise/dataPoints/2026443605080188808', exercise: {
    interval: { startTime: new Date(at(5, 8, 30)).toISOString(), endTime: new Date(at(5, 9, 6)).toISOString(), startUtcOffset: '10800s', endUtcOffset: '10800s' },
    exerciseType: 'RUNNING', displayName: 'Run', activeDuration: '2095s', exerciseMetadata: { hasGps: true },
    metricsSummary: {
      caloriesKcal: 420, activeZoneMinutes: '52', averageHeartRateBeatsPerMinute: '152', steps: '5600', distanceMillimeters: 6048000, averagePaceSecondsPerMeter: 0.3464,
      heartRateZoneDurations: { lightTime: '216s', moderateTime: '648s', vigorousTime: '1008s', peakTime: '288s' },
    },
  }, dataSource: DEVICE });
  assert.equal(e.date, '2026-10-05');
  assert.deepEqual(e.zones, { light: 3.6, moderate: 10.8, vigorous: 16.8, peak: 4.8 });
  assert.deepEqual([e.activeSec, e.paceSecPerKm, e.distanceM, e.device], [2095, 346, 6048, 'Fitbit Air']);
  const plain = parseExercise({ exercise: { interval: { startTime: new Date(at(5, 18, 0)).toISOString(), endTime: new Date(at(5, 19, 0)).toISOString() }, exerciseType: 'WEIGHTLIFTING', metricsSummary: { heartRateZoneDurations: { lightTime: '0s' } } } });
  assert.deepEqual([plain.zones, plain.activeSec, plain.paceSecPerKm, plain.device], [null, null, null, null]);
});

test('where a point came from, in a few words', () => {
  assert.equal(sourceName(DEVICE), 'Fitbit Air');
  assert.equal(sourceName({ platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED', device: { displayName: 'Pixel Watch 4', formFactor: 'WATCH' } }), 'Pixel Watch 4');
  assert.equal(sourceName({ platform: 'HEALTH_CONNECT', recordingMethod: 'PASSIVELY_MEASURED', device: { formFactor: 'WATCH' } }), 'Watch');
  assert.equal(sourceName({ platform: 'HEALTH_CONNECT', recordingMethod: 'PASSIVELY_MEASURED', application: { packageName: 'com.garmin.android.apps.connectmobile' } }), 'Health Connect');
  assert.equal(sourceName({ platform: 'HEALTH_KIT', recordingMethod: 'UNKNOWN' }), 'Apple Health');
  assert.equal(sourceName({ platform: 'FITBIT', recordingMethod: 'MANUAL' }), 'Logged by hand');
  assert.equal(sourceName({ platform: 'GOOGLE_WEB_API', recordingMethod: 'MANUAL' }, { own: true }), 'health.ojee.net');
  assert.equal(sourceName(undefined), null);
  assert.equal(sourceName({ platform: 'PLATFORM_UNSPECIFIED' }), null);
});
