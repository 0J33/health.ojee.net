/* ============================================================
   health.ojee.net — the catalogue: every metric the app can show.

   One list, read by everything that shows a metric: Browse, the
   metric page, the pins on Today, the "no data yet" list. A metric
   that is not here cannot be shown; a number the sync stores that no
   metric here reaches would be stored for nothing, and a test fails
   on that (tests/catalog.test.js).

   Each entry says what the thing is in plain words (`about`), who or
   what provides it (`provides`, shown when the person has none),
   where its numbers live (`source`), how a period of it is drawn
   (`chart`) and added up (`agg`), and whether the person can log it
   here (`entry`, a kind of core/entries.js).

   Three flags carry rules, not decoration:

     group      the optional group it belongs to. The metric exists
                for a person only while that group is switched on.
     sensitive  never published, never summarised unless the person
                said so. Every group metric, plus glucose and body
                temperature.
     own        calculated by this app. Its `about` names the inputs,
                and its label is never a product name of anybody's.

   The server only NAMES families and icons. The pages own the colour
   tokens and the glyphs (Material Symbols Rounded, snake_case).
   Units are metric; the pages convert what they draw.
   ============================================================ */

import { ENUMS, LIMITS, KINDS, MAX_AGE_DAYS, MEASURES } from './core/entries.js';

export const CATEGORIES = [
  { id: 'activity', label: 'Activity' },
  { id: 'heart', label: 'Heart' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'body', label: 'Body' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'nutrition', label: 'Nutrition' },
  { id: 'mindfulness', label: 'Mindfulness' },
  { id: 'cycle', label: 'Cycle' },
  { id: 'other', label: 'Other' },
];
export const FAMILIES = ['steps', 'active', 'energy', 'heart', 'sleep', 'recovery', 'body', 'workouts', 'vitals', 'nutrition', 'water', 'mind', 'cycle'];
export const KINDS_OF_METRIC = ['total', 'state', 'range', 'stack', 'log', 'score'];
export const CHART_KINDS = ['bars', 'line', 'range', 'stack', 'log', 'hours'];
export const RANGES = ['day', 'week', 'month', '6m', 'year'];
export const MAX_PINS = 8;

const OWN = 'Calculated by this app';
const WEAR = 'A watch or band';
const all = (kind, day = kind) => ({ day, week: kind, month: kind, '6m': kind, year: kind });
const d = (keys, o = {}) => ({ type: 'daily', keys: [].concat(keys), ...o });
const also = (...list) => list.map(([key, label, unit = null, decimals = 0]) => ({ key, label, unit, decimals }));

/**
 * The metrics, in the order Browse lists them inside a category.
 * `chart` is what each range is drawn as; `agg` is how days become a
 * week or a month ('sum' for things that add up, 'avg' for states).
 */
const LIST = [
  /* ── activity ── */
  { id: 'steps', label: 'Steps', category: 'activity', family: 'steps', icon: 'footprint', unit: 'steps', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('steps'), agg: 'sum', goal: 'steps', chart: all('bars', 'hours'),
    about: 'Steps counted by your phone, watch or band, as Google Health reports them for each day.',
    provides: 'Any phone with Google Health, or a watch or band' },
  { id: 'distance', label: 'Distance', category: 'activity', family: 'steps', icon: 'distance', unit: 'm', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('distance_m'), agg: 'sum', chart: all('bars'),
    about: 'Distance covered on foot each day, estimated by your device from steps and, where it has one, GPS.',
    provides: 'Any phone with Google Health, or a watch or band' },
  { id: 'floors', label: 'Floors climbed', category: 'activity', family: 'active', icon: 'stairs', unit: 'floors', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('floors'), agg: 'sum', chart: all('bars'),
    about: 'Floors climbed each day, counted by the altimeter in your watch or band (about three metres of climb is one floor).',
    provides: `${WEAR} with an altimeter` },
  { id: 'altitude', label: 'Elevation gained', category: 'activity', family: 'active', icon: 'landscape', unit: 'm', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('altitude_m'), agg: 'sum', chart: all('bars'),
    about: 'Metres climbed each day, as your device measured them. A gain, not a height above sea level.',
    provides: `${WEAR} with an altimeter or GPS` },
  { id: 'active', label: 'Active minutes', category: 'activity', family: 'active', icon: 'bolt', unit: 'min', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d(['azm', 'active_min']), agg: 'sum', goal: 'active', chart: all('bars'),
    also: also(['azm_fat', 'In the fat-burn zone', 'min'], ['azm_cardio', 'In the cardio zone', 'min'], ['azm_peak', 'In the peak zone', 'min']),
    about: 'Minutes of heart-raising activity each day: zone minutes where your device counts them, otherwise its moderate and vigorous active minutes.',
    provides: `${WEAR} with a heart-rate sensor` },
  { id: 'cardio_week', label: 'Cardio minutes this week', category: 'activity', family: 'active', icon: 'monitor_heart', unit: 'min', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('cardio_min'), agg: 'sum', goal: 'cardio', weekly: true, chart: all('bars'), own: true,
    ownNote: `${OWN}. A day counts its zone minutes; without those, minutes in the moderate heart-rate zone plus twice the minutes above it; without those, active minutes. The week runs Monday to Sunday against your own target.`,
    about: `${OWN} from your zone minutes, time in heart-rate zones or active minutes, added up over a Monday-to-Sunday week against your weekly target.`,
    provides: `${WEAR} with a heart-rate sensor` },
  { id: 'calories', label: 'Calories burned', category: 'activity', family: 'energy', icon: 'local_fire_department', unit: 'kcal', kind: 'total', decimals: 0, betterWhen: null,
    source: d('kcal', { parts: [{ key: 'active', label: 'Active', tone: 'high', daily: 'kcal_active' }, { key: 'basal', label: 'Resting', tone: 'low', daily: 'kcal_basal' }] }), agg: 'sum', chart: all('bars'),
    about: 'Total energy burned each day as your device estimates it, split into active and resting energy where both are known.',
    provides: `${WEAR}; a phone alone estimates it roughly` },
  { id: 'calories_active', label: 'Active energy', category: 'activity', family: 'energy', icon: 'mode_heat', unit: 'kcal', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('kcal_active'), agg: 'sum', chart: all('bars'),
    about: 'Energy burned by moving each day, on top of what your body uses at rest, as your device estimates it.',
    provides: `${WEAR} with a heart-rate sensor` },
  { id: 'calories_basal', label: 'Resting energy', category: 'activity', family: 'energy', icon: 'hotel', unit: 'kcal', kind: 'total', decimals: 0, betterWhen: null,
    source: d('kcal_basal'), agg: 'sum', chart: all('bars'), own: true,
    ownNote: `${OWN}: total calories minus active energy for each day that has both, never below zero. Google Health gives no daily resting figure to read.`,
    about: `${OWN}: each day's total calories minus its active energy. What your body used at rest.`,
    provides: `${WEAR} that reports both total and active energy` },
  { id: 'sedentary', label: 'Sedentary time', category: 'activity', family: 'active', icon: 'chair', unit: 'min', kind: 'total', decimals: 0, betterWhen: 'lower', format: 'duration',
    source: d('sedentary_min'), agg: 'avg', chart: all('bars'),
    about: 'Time each day your device recorded you as sitting or still while awake.',
    provides: `${WEAR} that tracks all-day activity` },
  { id: 'activity_levels', label: 'Activity levels', category: 'activity', family: 'active', icon: 'stacked_bar_chart', unit: 'min', kind: 'stack', decimals: 0, betterWhen: null, format: 'duration',
    source: { type: 'stack', parts: [
      { key: 'sedentary', label: 'Sedentary', tone: 'muted', daily: 'level_sedentary' }, { key: 'light', label: 'Lightly active', tone: 'low', daily: 'level_light' },
      { key: 'moderate', label: 'Moderately active', tone: 'mid', daily: 'level_moderate' }, { key: 'very', label: 'Very active', tone: 'high', daily: 'level_very' }] },
    agg: 'avg', chart: all('stack'),
    about: 'How each day divides between sedentary, lightly, moderately and very active time, as your device classifies it.',
    provides: `${WEAR} that tracks all-day activity` },
  { id: 'swim', label: 'Swimming strokes', category: 'activity', family: 'workouts', icon: 'pool', unit: 'strokes', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: d('swim_strokes'), agg: 'sum', chart: all('bars'),
    about: 'Strokes counted by your watch or band while swimming, added up per day.',
    provides: 'A swim-proof watch or band with swim tracking' },
  { id: 'workouts', label: 'Workouts', category: 'activity', family: 'workouts', icon: 'fitness_center', unit: 'min', kind: 'log', decimals: 0, betterWhen: 'higher', format: 'duration',
    source: { type: 'workouts' }, agg: 'sum', chart: all('bars', 'log'),
    about: 'Minutes in workouts each day: the ones confirmed or logged here and the sessions Google Health holds.',
    provides: 'Log one on the Workouts page, or record one on a watch or band' },

  /* ── heart ── */
  { id: 'resting_hr', label: 'Resting heart rate', category: 'heart', family: 'heart', icon: 'favorite', unit: 'bpm', kind: 'state', decimals: 0, betterWhen: 'lower',
    source: d('rhr'), agg: 'avg', chart: all('line'),
    about: 'Your heart rate at rest for each day, as your device works it out, mostly from sleep.',
    provides: `${WEAR} with a heart-rate sensor, worn at night` },
  { id: 'hrv', label: 'Heart rate variability', category: 'heart', family: 'recovery', icon: 'vital_signs', unit: 'ms', kind: 'state', decimals: 0, betterWhen: 'higher',
    source: d('hrv'), agg: 'avg', chart: all('line'),
    also: also(['hrv_deep', 'In deep sleep', 'ms'], ['hrv_entropy', 'Entropy', null, 2], ['hrv_nonrem_hr', 'Heart rate outside REM sleep', 'bpm']),
    about: 'The beat-to-beat variation of your heart during sleep (RMSSD), per night. It differs a lot between people; your own trend is what means something.',
    provides: `${WEAR} with a heart-rate sensor, worn at night` },
  { id: 'heart_rate', label: 'Heart rate', category: 'heart', family: 'heart', icon: 'cardiology', unit: 'bpm', kind: 'range', decimals: 0, betterWhen: null,
    source: { type: 'range', value: 'hr_avg', lo: 'hr_min', hi: 'hr_max' }, agg: 'avg', chart: all('range', 'hours'),
    about: 'The lowest, highest and average heart rate your device recorded each day.',
    provides: `${WEAR} with a heart-rate sensor` },
  { id: 'zones', label: 'Time in heart-rate zones', category: 'heart', family: 'heart', icon: 'speed', unit: 'min', kind: 'stack', decimals: 0, betterWhen: null,
    source: { type: 'stack', parts: [
      { key: 'light', label: 'Light', tone: 'low', daily: 'zone_light' }, { key: 'moderate', label: 'Moderate', tone: 'mid', daily: 'zone_moderate' },
      { key: 'vigorous', label: 'Vigorous', tone: 'high', daily: 'zone_vigorous' }, { key: 'peak', label: 'Peak', tone: 'peak', daily: 'zone_peak' }] },
    agg: 'sum', chart: all('stack'),
    about: 'Minutes each day your heart rate spent in the light, moderate, vigorous and peak zones your device sets for you.',
    provides: `${WEAR} with continuous heart rate` },
  { id: 'zone_calories', label: 'Calories by heart-rate zone', category: 'heart', family: 'energy', icon: 'whatshot', unit: 'kcal', kind: 'stack', decimals: 0, betterWhen: null,
    source: { type: 'stack', parts: [
      { key: 'light', label: 'Light', tone: 'low', daily: 'zkcal_light' }, { key: 'moderate', label: 'Moderate', tone: 'mid', daily: 'zkcal_moderate' },
      { key: 'vigorous', label: 'Vigorous', tone: 'high', daily: 'zkcal_vigorous' }, { key: 'peak', label: 'Peak', tone: 'peak', daily: 'zkcal_peak' }] },
    agg: 'sum', chart: all('stack'),
    about: 'Energy burned each day while your heart rate was in each zone, as your device estimates it.',
    provides: `${WEAR} with continuous heart rate` },
  { id: 'vo2max', label: 'VO2 max', category: 'heart', family: 'heart', icon: 'sprint', unit: 'ml/kg/min', kind: 'state', decimals: 1, betterWhen: 'higher',
    source: d(['vo2max', 'vo2max_run']), agg: 'avg', chart: all('line'),
    also: also(['vo2max_run', 'From running', 'ml/kg/min', 1]),
    about: 'An estimate of how much oxygen your body can use at full effort, made by your watch from heart rate and pace. An estimate, not a lab measurement.',
    provides: 'A watch with heart rate and GPS, usually after a few outdoor runs or brisk walks' },
  { id: 'recovery', label: 'Recovery trend', category: 'heart', family: 'recovery', icon: 'battery_charging_full', unit: 'SD', kind: 'state', decimals: 1, betterWhen: 'higher',
    source: { type: 'recovery' }, agg: 'avg', chart: all('line'), own: true,
    ownNote: `${OWN}. Each of the last 7 days of HRV and resting heart rate is compared with your own average over the 30 days before, in units of your own day-to-day spread, turned so that up is better. It is a trend of those two signals and measures nothing else.`,
    about: `${OWN} from HRV and resting heart rate: how the last 7 days sit against your own 30 days before. Zero is your usual.`,
    provides: `${WEAR} worn at night for at least two weeks` },
  { id: 'ecg', label: 'ECG readings', category: 'heart', family: 'heart', icon: 'ecg', unit: 'bpm', kind: 'log', decimals: 0, betterWhen: null,
    source: { type: 'sample', kind: 'ecg', day: 'avg' }, agg: 'avg', chart: all('log'), group: 'ecg',
    about: 'The ECG readings you took on your watch, with the result the watch gave and the average heart rate. The waveform itself is not kept here.',
    provides: 'A watch with an ECG app' },
  { id: 'irn', label: 'Irregular rhythm notices', category: 'heart', family: 'heart', icon: 'heart_check', unit: 'notices', kind: 'log', decimals: 0, betterWhen: null,
    source: { type: 'sample', kind: 'irn', day: 'count' }, agg: 'sum', chart: all('log'), group: 'ecg',
    about: 'Notices your watch raised about an irregular heart rhythm, as Google Health holds them. Shown as recorded; this app adds no judgement.',
    provides: 'A watch with irregular rhythm notifications switched on' },

  /* ── sleep ── */
  { id: 'sleep', label: 'Sleep', category: 'sleep', family: 'sleep', icon: 'bedtime', unit: 'min', kind: 'state', decimals: 0, betterWhen: 'higher', format: 'duration',
    source: d('sleep_min'), agg: 'avg', goal: 'sleep', chart: all('bars'), entry: 'sleep',
    also: also(['sleep_period', 'In bed', 'min'], ['sleep_awake', 'Awake', 'min']),
    about: 'Time asleep in the main sleep of each night, dated by the morning you woke. A night your device missed can be logged here.',
    provides: `${WEAR} worn at night` },
  { id: 'sleep_score', label: 'Sleep score', category: 'sleep', family: 'sleep', icon: 'hotel_class', unit: 'of 100', kind: 'score', decimals: 0, betterWhen: 'higher',
    source: d('sleep_score'), agg: 'avg', chart: all('line', 'bars'), own: true,
    ownNote: `${OWN}, out of 100. Duration against your sleep goal is worth 50 points, deep and REM share 20, the share of your time in bed spent asleep 15, and how close bedtime and wake were to your own usual 15. A part that cannot be worked out is left out and the rest is rescaled.`,
    about: `${OWN} for each night from how long you slept against your goal, your sleep stages, your time awake and how regular your bedtime and wake were.`,
    provides: `${WEAR} worn at night` },
  { id: 'sleep_stages', label: 'Sleep stages', category: 'sleep', family: 'sleep', icon: 'layers', unit: 'min', kind: 'stack', decimals: 0, betterWhen: null, format: 'duration',
    source: { type: 'stack', parts: [
      { key: 'deep', label: 'Deep', tone: 'high', daily: 'sleep_deep' }, { key: 'rem', label: 'REM', tone: 'mid', daily: 'sleep_rem' },
      { key: 'light', label: 'Light', tone: 'low', daily: 'sleep_light' }, { key: 'awake', label: 'Awake', tone: 'muted', daily: 'sleep_awake' }], need: ['deep', 'rem', 'light'] },
    agg: 'avg', chart: all('stack'),
    about: 'How each night divides between deep, REM and light sleep and time awake, as your device estimates the stages.',
    provides: `${WEAR} with a heart-rate sensor, worn at night` },
  { id: 'sleep_efficiency', label: 'Sleep efficiency', category: 'sleep', family: 'sleep', icon: 'percent', unit: '%', kind: 'state', decimals: 0, betterWhen: 'higher',
    source: d('sleep_efficiency'), agg: 'avg', chart: all('line'),
    about: 'The share of your time in bed that you were asleep, per night: time asleep divided by the whole sleep period.',
    provides: `${WEAR} worn at night` },

  /* ── body ── */
  { id: 'weight', label: 'Weight', category: 'body', family: 'body', icon: 'monitor_weight', unit: 'kg', kind: 'state', decimals: 1, betterWhen: null,
    source: { type: 'weight' }, agg: 'avg', chart: all('line', 'log'), entry: 'weight',
    about: 'Your weigh-ins: the ones logged here and whatever a connected scale or app saved to Google Health.',
    provides: 'Log it here, or use a connected scale' },
  { id: 'body_fat', label: 'Body fat', category: 'body', family: 'body', icon: 'body_fat', unit: '%', kind: 'state', decimals: 1, betterWhen: null,
    source: d('body_fat'), entries: 'bodyfat', agg: 'avg', chart: all('line', 'log'), entry: 'bodyfat',
    about: 'Body fat as a share of your weight: the readings a connected scale saved to Google Health and the ones logged here.',
    provides: 'Log it here, or use a scale that measures it' },
  { id: 'height', label: 'Height', category: 'body', family: 'body', icon: 'height', unit: 'cm', kind: 'state', decimals: 1, betterWhen: null,
    source: d('height_mm', { scale: 0.1 }), entries: 'height', agg: 'avg', chart: all('line', 'log'), entry: 'height',
    about: 'Your height, from Google Health or logged here. It is used for body mass index and nothing else.',
    provides: 'Log it here, or set it in the Google Health app' },
  { id: 'measurements', label: 'Body measurements', category: 'body', family: 'body', icon: 'straighten', unit: 'cm', kind: 'state', decimals: 1, betterWhen: null,
    source: { type: 'sample', kind: 'measure', day: 'avg' }, agg: 'avg', chart: all('line', 'log'), entry: 'measure',
    about: 'Tape measurements (waist, chest, arms, legs) logged here or in Hevy. The chart follows your waist; every measurement is in the entries.',
    provides: 'Log them here, or in Hevy with the Hevy link on' },
  { id: 'bmi', label: 'Body mass index', category: 'body', family: 'body', icon: 'accessibility_new', unit: 'kg/m2', kind: 'state', decimals: 1, betterWhen: null,
    source: { type: 'bmi' }, agg: 'avg', chart: all('line'), own: true,
    ownNote: `${OWN}: your weight in kilograms divided by the square of your height in metres, for each day with a weigh-in, using your latest height. It says nothing about what the weight is made of.`,
    about: `${OWN} from your weigh-ins and your height: kilograms divided by metres squared.`,
    provides: 'Needs a weigh-in and your height: log both here' },

  /* ── vitals ── */
  { id: 'resp', label: 'Breathing rate', category: 'vitals', family: 'vitals', icon: 'pulmonology', unit: 'br/min', kind: 'state', decimals: 1, betterWhen: null,
    source: d('resp'), agg: 'avg', chart: all('line'),
    also: also(['resp_deep', 'In deep sleep', 'br/min', 1], ['resp_light', 'In light sleep', 'br/min', 1], ['resp_rem', 'In REM sleep', 'br/min', 1]),
    about: 'Breaths a minute during sleep, per night, as your device estimates it from your heart rate.',
    provides: `${WEAR} that tracks sleep with a heart-rate sensor` },
  { id: 'spo2', label: 'Blood oxygen', category: 'vitals', family: 'vitals', icon: 'spo2', unit: '%', kind: 'range', decimals: 1, betterWhen: null,
    source: { type: 'range', value: 'spo2', lo: 'spo2_lo', hi: 'spo2_hi' }, agg: 'avg', chart: all('range'),
    also: also(['spo2_sd', 'Spread', '%', 1], ['spo2_min', 'Lowest reading', '%', 1], ['spo2_mean', 'Mean of readings', '%', 1]),
    about: 'Oxygen saturation of your blood during sleep, per night: the average with the range your device reports around it.',
    provides: `${WEAR} with a blood-oxygen sensor, worn at night` },
  { id: 'skin_temp', label: 'Sleep temperature', category: 'vitals', family: 'vitals', icon: 'thermostat', unit: '°C', kind: 'state', decimals: 2, betterWhen: null, signed: true,
    source: d('temp_dev'), agg: 'avg', chart: all('line'),
    also: also(['temp', 'Nightly temperature', '°C', 2], ['temp_base', 'Your baseline', '°C', 2], ['temp_sd', 'Usual nightly spread', '°C', 2]),
    about: 'How far your skin temperature during sleep was from your own baseline, per night. A difference, not a body temperature.',
    provides: `${WEAR} with a skin-temperature sensor, worn at night` },
  { id: 'body_temp', label: 'Body temperature', category: 'vitals', family: 'vitals', icon: 'device_thermostat', unit: '°C', kind: 'state', decimals: 1, betterWhen: null,
    source: { type: 'sample', kind: 'bodytemp', day: 'avg' }, agg: 'avg', chart: all('line', 'log'), entry: 'bodytemp', sensitive: true,
    about: 'Body temperature readings: the ones a connected thermometer saved to Google Health and the ones logged here. Always private.',
    provides: 'Log one here, or use a connected thermometer' },
  { id: 'glucose', label: 'Blood glucose', category: 'vitals', family: 'vitals', icon: 'glucose', unit: 'mg/dL', kind: 'range', decimals: 0, betterWhen: null,
    source: { type: 'sample', kind: 'glucose', day: 'range' }, agg: 'avg', chart: all('range', 'log'), entry: 'glucose', sensitive: true,
    about: 'Blood glucose readings: the ones a connected meter or sensor saved to Google Health and the ones logged here. Always private.',
    provides: 'Log one here, or use a connected glucose meter or sensor' },

  /* ── nutrition ── */
  { id: 'water', label: 'Water', category: 'nutrition', family: 'water', icon: 'water_drop', unit: 'ml', kind: 'total', decimals: 0, betterWhen: 'higher',
    source: { type: 'sample', kind: 'water', day: 'sum' }, agg: 'sum', goal: 'water', chart: all('bars', 'log'), entry: 'water', group: 'nutrition',
    about: 'Water you logged here, added up per day against your daily target. What you log in Google\'s own app cannot be read by other apps.',
    provides: 'Log it here' },
  { id: 'food', label: 'Food', category: 'nutrition', family: 'nutrition', icon: 'restaurant', unit: 'kcal', kind: 'total', decimals: 0, betterWhen: null,
    source: { type: 'sample', kind: 'food', day: 'sum', parts: [{ key: 'protein', label: 'Protein', tone: 'high', unit: 'g' }, { key: 'carbs', label: 'Carbohydrate', tone: 'mid', unit: 'g' }, { key: 'fat', label: 'Fat', tone: 'low', unit: 'g' }] },
    agg: 'sum', chart: all('bars', 'log'), entry: 'food', group: 'nutrition',
    about: 'Meals you logged here: calories per day, with protein, carbohydrate and fat in grams where you gave them.',
    provides: 'Log it here' },

  /* ── mindfulness ── */
  { id: 'mood', label: 'Mood', category: 'mindfulness', family: 'mind', icon: 'mood', unit: null, kind: 'log', decimals: 1, betterWhen: null,
    source: { type: 'sample', kind: 'mood', day: 'avg' }, agg: 'avg', chart: all('log'), entry: 'mood', group: 'mindfulness',
    about: 'How you said you felt, each time you logged it here: the feelings you chose and, when you set it, the overall feel from unpleasant through neutral to pleasant. The days you logged on are marked; the entries are listed below.',
    provides: 'Log it here' },

  /* ── cycle ── */
  { id: 'period', label: 'Period', category: 'cycle', family: 'cycle', icon: 'calendar_month', unit: 'days', kind: 'log', decimals: 0, betterWhen: null,
    source: { type: 'period' }, agg: 'sum', chart: all('log'), entry: 'period', group: 'cycle',
    about: 'The periods you logged here, by their first and last day.',
    provides: 'Log it here' },
  { id: 'ovulation', label: 'Ovulation tests', category: 'cycle', family: 'cycle', icon: 'science', unit: 'tests', kind: 'log', decimals: 0, betterWhen: null,
    source: { type: 'sample', kind: 'ovulation', day: 'count' }, agg: 'sum', chart: all('log'), entry: 'ovulation', group: 'cycle',
    about: 'The ovulation test results you logged here.',
    provides: 'Log it here' },

  /* ── other ── */
  { id: 'symptoms', label: 'Symptoms', category: 'other', family: 'vitals', icon: 'sick', unit: 'symptoms', kind: 'log', decimals: 0, betterWhen: null,
    source: { type: 'sample', kind: 'symptom', day: 'sum' }, agg: 'sum', chart: all('log'), entry: 'symptom', group: 'symptoms',
    about: 'The symptoms you logged here, as you named them. A record for you; this app reads nothing into it.',
    provides: 'Log it here' },
];

export const METRICS = LIST.map((m) => Object.freeze({
  own: false, ownNote: null, group: null, entry: null, goal: null, also: [], format: null, signed: false, weekly: false, entries: null, ...m,
  sensitive: !!m.sensitive || !!m.group,
}));
const BY_ID = new Map(METRICS.map((m) => [m.id, m]));
export const metricById = (id) => BY_ID.get(String(id)) || null;
/** The metric a logged kind shows up under. */
export const metricOfKind = (kind) => METRICS.find((m) => m.entry === kind) || METRICS.find((m) => m.source.kind === kind || m.entries === kind) || null;

/** Every daily key a metric reads (its value, its parts, its extras). */
export function dailyKeysOf(m) {
  const s = m.source;
  const keys = [];
  if (s.type === 'daily') keys.push(...s.keys, ...(s.parts || []).map((p) => p.daily));
  if (s.type === 'range') keys.push(s.value, s.lo, s.hi);
  if (s.type === 'stack') keys.push(...s.parts.map((p) => p.daily));
  if (s.type === 'recovery') keys.push('hrv', 'rhr');
  keys.push(...m.also.map((a) => a.key));
  return keys.filter(Boolean);
}
/** Every sample kind a metric reads. */
export function sampleKindsOf(m) {
  const out = [];
  if (m.source.type === 'sample') out.push(m.source.kind);
  if (m.source.type === 'period') out.push('period');
  if (m.entries) out.push(m.entries);
  if (m.id === 'vo2max') out.push('vo2');
  return out;
}

/* ── how a value reads ────────────────────────────────────────────── */

const nf = (p) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: p, maximumFractionDigits: p });
export const duration = (min) => { const m = Math.round(Math.abs(min)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
/** A value of a metric as a short metric-unit string: "8,412 steps", "7h 12m". */
export function valueText(m, value) {
  if (!Number.isFinite(value)) return null;
  if (m.format === 'duration') return duration(value);
  const n = nf(m.decimals).format(value);
  const s = m.signed && value > 0 ? `+${n}` : n;
  if (!m.unit) return s;
  return m.unit === '%' ? `${s}%` : `${s} ${m.unit}`;
}

/* ── the forms ────────────────────────────────────────────────────── */

const num = (id, label, [min, max], unit, o = {}) => ({ id, label, type: 'number', unit, min, max, step: 1, required: true, ...o });
const AT = { id: 'at', label: 'When', type: 'datetime', required: false, maxAgeDays: MAX_AGE_DAYS };
const NOTE = (max) => ({ id: 'note', label: 'Note', type: 'text', maxLength: max, required: false });

/**
 * What a form for one kind asks: `[{ id, label, type, unit?, min?, max?,
 * step?, options?, maxLength?, required }]`, the same fields POST
 * /api/entries takes. `at` is milliseconds since the epoch and defaults
 * to now. Limits and choices come from core/entries.js, so the form and
 * the validation cannot disagree.
 */
export const FORMS = {
  water: { fields: [num('ml', 'Amount', LIMITS.water.ml, 'ml', { step: 10 }), AT], quick: [{ label: '250 ml', fields: { ml: 250 } }, { label: '500 ml', fields: { ml: 500 } }] },
  food: { fields: [
    { id: 'name', label: 'What was it', type: 'text', maxLength: LIMITS.food.name, required: true },
    { id: 'meal', label: 'Meal', type: 'select', options: ENUMS.mealType, required: true },
    num('kcal', 'Calories', LIMITS.food.kcal, 'kcal'),
    num('protein', 'Protein', LIMITS.food.protein, 'g', { required: false }), num('carbs', 'Carbohydrate', LIMITS.food.carbs, 'g', { required: false }), num('fat', 'Fat', LIMITS.food.fat, 'g', { required: false }), AT] },
  mood: { fields: [
    { id: 'moods', label: 'How do you feel', type: 'multi', options: ENUMS.moods, min: LIMITS.mood.moods[0], max: LIMITS.mood.moods[1], required: true },
    { id: 'valence', label: 'Overall', type: 'select', options: ENUMS.valences, required: false }, NOTE(LIMITS.mood.note), AT] },
  symptom: { fields: [
    { id: 'symptoms', label: 'Symptoms', type: 'multi', options: ENUMS.symptoms, min: LIMITS.symptom.symptoms[0], max: LIMITS.symptom.symptoms[1], required: true }, NOTE(LIMITS.symptom.note), AT] },
  glucose: { fields: [
    num('mgdl', 'Glucose', LIMITS.glucose.mgdl, 'mg/dL'),
    { id: 'timing', label: 'Timing', type: 'select', options: ENUMS.glucoseTiming, required: false }, { id: 'meal', label: 'Meal', type: 'select', options: ENUMS.glucoseMeal, required: false }, NOTE(LIMITS.glucose.note), AT] },
  bodytemp: { fields: [num('celsius', 'Temperature', LIMITS.bodytemp.celsius, '°C', { step: 0.1 }), { id: 'location', label: 'Measured at', type: 'select', options: ENUMS.tempLocation, required: false }, AT] },
  height: { fields: [num('cm', 'Height', LIMITS.height.cm, 'cm', { step: 0.1 }), AT] },
  bodyfat: { fields: [num('pct', 'Body fat', LIMITS.bodyfat.pct, '%', { step: 0.1 }), AT] },
  period: { fields: [
    { id: 'start', label: 'First day', type: 'date', required: true, maxAgeDays: MAX_AGE_DAYS }, { id: 'end', label: 'Last day', type: 'date', required: false, maxDays: LIMITS.period.days[1] }, NOTE(LIMITS.period.note)] },
  ovulation: { fields: [{ id: 'result', label: 'Result', type: 'select', options: ENUMS.ovulation, required: true }, AT] },
  sleep: { fields: [
    { id: 'start', label: 'Fell asleep', type: 'datetime', required: true, maxAgeDays: LIMITS.sleep.maxAgeDays, default: 'lastNight' },
    { id: 'end', label: 'Woke up', type: 'datetime', required: true, maxAgeDays: LIMITS.sleep.maxAgeDays, default: 'thisMorning' },
    num('awakeMin', 'Time awake in the night', LIMITS.sleep.awake, 'min', { required: false, step: 5 }), NOTE(LIMITS.sleep.note)] },
  measure: { fields: [
    ...MEASURES.map(([k, label]) => num(k, label, LIMITS.measure.cm, 'cm', { required: false, step: 0.1 })),
    num('lean_mass_kg', 'Lean mass', LIMITS.measure.kg, 'kg', { required: false, step: 0.1 }), AT] },
  // Weight has its own route and its own, older, limits.
  weight: { fields: [num('kg', 'Weight', [20, 400], 'kg', { step: 0.1 }), { ...AT, maxAgeDays: 30 }, NOTE(200)] },
};
/** Every kind a form exists for must be a kind entries.js knows (or weight). */
export const FORM_KINDS = Object.keys(FORMS).filter((k) => k === 'weight' || KINDS[k]);
