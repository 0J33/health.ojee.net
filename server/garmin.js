/* ============================================================
   health.ojee.net — Garmin, through Garmin's Personal API.

   Garmin reopened its Connect Developer Program on 2026-10-21 with a
   Personal API: each person makes a key on their own Garmin Connect
   account (connect.garmin.com/app/settings/personalApiToken; it lasts
   30, 90 or 180 days or a year, and is shown once), and a client swaps
   it for a bearer token that lasts about a day:

     POST {base}/personalapitoken-service/personal-api/personal-api-key/token
          Authorization: ApiKey <key>
       -> the token itself, as text (a JWT; its `exp` says when it ends)

   There is no refresh token: when the token runs out the key is swapped
   again. Every read is then a GET with `Authorization: Bearer <token>`
   and `Accept: application/json`. The paths and their parameters are
   from Garmin's own example client (garmin-personal-api, Apache-2.0);
   the shapes of the answers are not documented there. They mirror
   Garmin Connect's own endpoints, whose shapes are known from the
   community python-garminconnect project, so every reader below is
   written to survive a field that is missing or renamed: one bad day
   never fails a sync, and an answer that does not look as expected is
   noted (its keys only, never its values) for whoever adjusts the
   mapping once a real key has been tried.

   The key is the person's: it is sealed with the vault like a Hevy
   key and never logged or sent back. The token lives in memory only.

   Everything Garmin's numbers become is in FIELDS (one place, read by
   server/garminsync.js); docs/DATA-TYPES.md, "Garmin", says the same
   in a table, with what is unverified.
   ============================================================ */

export const GARMIN_BASE = 'https://personal.connectapi.garmin.com';
export const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
/** Where a person makes their key. */
export const KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
/** The lifetimes Garmin offers for a key, in days. */
export const KEY_DAYS = [30, 90, 180, 365];
/** A token is swapped again this long before its `exp`. */
const EARLY_MS = 60 * 60_000;
/** A token that does not say when it ends is trusted for this long. */
const TOKEN_FALLBACK_MS = 23 * 3_600_000;
/** How many days a ranged call asks for at once. Garmin Connect's own
    stats endpoints answer 28 days at most; the Personal API's limits are
    not published, so this stays at what Connect is known to take. */
export const RANGE_DAYS = 28;

export class GarminError extends Error {
  constructor(message, code = 'upstream', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** What a key may look like: printable, no spaces, of a sane length. */
export const keyShape = (k) => typeof k === 'string' && /^[\x21-\x7e]{16,4096}$/.test(k);

/** The `exp` of a JWT, in milliseconds, or null. Not verified: only read. */
export function jwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const j = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const exp = Number(j?.exp);
    return Number.isFinite(exp) && exp > 0 ? Math.round(exp * 1000) : null;
  } catch { return null; }
}

const retryAfterMs = (res) => {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(1000, Math.min(6 * 3_600_000, s * 1000));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(1000, Math.min(6 * 3_600_000, t - Date.now())) : null;
};

/**
 * Swap a key for a token. Resolves { token, expiresAt }. Throws a
 * GarminError: 'garmin_key' when Garmin refuses the key (made wrongly,
 * expired, or deleted), 'rate_limited', 'network', 'upstream', 'protocol'.
 */
export async function swapKey(key, { fetchImpl = globalThis.fetch, base = GARMIN_BASE, now = Date.now } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base}${TOKEN_PATH}`, { method: 'POST', headers: { accept: '*/*', authorization: `ApiKey ${key}` } });
  } catch { throw new GarminError('Garmin could not be reached.', 'network'); }
  if (res.status === 401 || res.status === 403) {
    throw new GarminError('Garmin did not accept this key. It may have expired or been deleted: make a new one in Garmin Connect and paste it here.', 'garmin_key');
  }
  if (res.status === 429) throw new GarminError('Garmin asked this site to slow down. It tries again later by itself.', 'rate_limited', { retryAfterMs: retryAfterMs(res) });
  if (res.status === 400 || res.status === 404) throw new GarminError('Garmin did not recognise this key. Check that the whole key was copied.', 'garmin_key');
  if (!res.ok) throw new GarminError(`Garmin answered ${res.status}. Try again in a little while.`, 'upstream');
  const token = String(await res.text()).trim().replace(/^"|"$/g, '');
  if (!token || /\s/.test(token) || token.length > 16_384) throw new GarminError('Garmin answered with something this site cannot use as a token.', 'protocol');
  const exp = jwtExp(token);
  return { token, expiresAt: exp && exp > now() ? exp : now() + TOKEN_FALLBACK_MS, expKnown: !!exp };
}

const iso = (d) => String(d).slice(0, 10);

/**
 * One person's way into Garmin. `key` is their key, `token` an earlier
 * token kept in memory ({ token, expiresAt }), handed back through
 * `onToken` whenever a new one is made. Calls are spaced by `gapMs`;
 * a 429 ends the pass (the caller waits it out); a 401 swaps the key
 * again once, and a second one means the key is no good any more.
 */
export class GarminApi {
  constructor({ key, token = null, onToken = () => {}, fetchImpl = globalThis.fetch, base = GARMIN_BASE, gapMs = 1000, now = Date.now, log = () => {} }) {
    this.key = key; this.tok = token; this.onToken = onToken;
    this.fetch = fetchImpl; this.base = base; this.gapMs = gapMs; this.now = now; this.log = log;
    this.calls = 0; this.last = 0;
  }

  async token(fresh = false) {
    if (!fresh && this.tok && this.tok.expiresAt - EARLY_MS > this.now()) return this.tok.token;
    this.calls += 1;
    this.tok = await swapKey(this.key, { fetchImpl: this.fetch, base: this.base, now: this.now });
    this.onToken(this.tok);
    return this.tok.token;
  }

  async #space() {
    if (!this.gapMs) return;
    const wait = this.last + this.gapMs - Date.now();
    // Not unref()ed: a pass in the demo seed runs before the server listens.
    if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
    this.last = Date.now();
  }

  /** GET a path; the decoded JSON, or null for an empty answer. */
  async get(path, params = null, { retried = false } = {}) {
    const q = params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]))}` : '';
    const token = await this.token();
    await this.#space();
    this.calls += 1;
    let res;
    try {
      res = await this.fetch(`${this.base}${path}${q}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
    } catch { throw new GarminError('Garmin could not be reached.', 'network'); }
    if (res.status === 401) {
      if (retried) throw new GarminError('Garmin stopped accepting this key. Make a new one in Garmin Connect and paste it here.', 'garmin_key');
      await this.token(true);
      return this.get(path, params, { retried: true });
    }
    if (res.status === 429) throw new GarminError('Garmin asked this site to slow down. It tries again later by itself.', 'rate_limited', { retryAfterMs: retryAfterMs(res) });
    // Refused or not there for this account: that one read is skipped, the rest carry on.
    if (res.status === 403 || res.status === 404 || res.status === 400) throw new GarminError(`Garmin answered ${res.status} for ${path.split('/').slice(0, 3).join('/')}.`, 'unavailable', { status: res.status });
    if (!res.ok) throw new GarminError(`Garmin answered ${res.status}.`, 'upstream', { status: res.status });
    const text = await res.text();
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new GarminError('Garmin answered something this site cannot read.', 'protocol'); }
  }

  /* ── the reads (paths from garmin-personal-api's client.py) ─────── */

  profile() { return this.get('/userprofile-service/userprofile/settings'); }
  dailySummaries(start, end) { return this.get('/usersummary-service/v2/dailysummaries', { startDate: iso(start), endDate: iso(end) }); }
  stress(start, end) { return this.get(`/usersummary-service/stats/stress/daily/${iso(start)}/${iso(end)}`); }
  steps(start, end) { return this.get(`/usersummary-service/stats/steps/daily/${iso(start)}/${iso(end)}`); }
  hrv(start, end) { return this.get(`/hrv-service/hrv/daily/${iso(start)}/${iso(end)}`); }
  bodyBattery(start, end) { return this.get('/wellness-service/wellness/bodyBattery/reports/daily', { startDate: iso(start), endDate: iso(end) }); }
  weight(start, end) { return this.get(`/weight-service/weight/range/${iso(start)}/${iso(end)}`, { includeAll: 'true' }); }
  sleep(date) { return this.get('/sleep-service/sleep/dailySleep', { date: iso(date) }); }
  heartRate(date) { return this.get('/wellness-service/wellness/dailyHeartRate', { date: iso(date) }); }
  spo2(date) { return this.get(`/wellness-service/wellness/daily/spo2acclimation/${iso(date)}`); }
  activities({ start = 0, limit = 50, startDate = null, endDate = null } = {}) {
    return this.get('/activitylist-service/activities/search/activities', { start, limit, startDate: startDate && iso(startDate), endDate: endDate && iso(endDate) });
  }
}

/* ── reading the answers ─────────────────────────────────────────────

   Every reader takes whatever came back and returns plain rows, or an
   empty list. `note(where, value)` is told when a shape is not what was
   expected; it receives the keys only. */

const fin = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const pos = (v) => { const n = fin(v); return n !== null && n >= 0 ? n : null; };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s.slice(0, 10)));
/** The first of several names a field might have. */
const pick = (o, names) => { for (const n of names) { const v = n.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o); if (v !== undefined && v !== null) return v; } return null; };
/** A list wherever Garmin put it: the answer itself, or under one of these keys. */
const listOf = (j, keys = []) => {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of [...keys, 'data', 'values', 'items', 'results', 'list']) if (Array.isArray(j[k])) return j[k];
  return [];
};
export const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 30).join(',') : typeof o);

/** A Garmin instant: epoch ms (or s), or a GMT timestamp with or without 'Z'. */
export function gmt(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { const n = Number(v); return n > 1e11 ? n : n > 1e8 ? n * 1000 : null; }
  let s = String(v).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Garmin's fields, by what this site makes of them. The one place to
 * change when a real answer turns out to be shaped differently. Each
 * entry lists the names to try, first match wins. Durations named *Sec
 * are seconds and become minutes.
 */
export const FIELDS = {
  // /usersummary-service/v2/dailysummaries: one object per calendar day.
  day: {
    date: ['calendarDate', 'summaryDate', 'date'],
    steps: ['totalSteps', 'steps'],
    distance_m: ['totalDistanceMeters', 'totalDistance', 'distanceInMeters'],
    kcal: ['totalKilocalories', 'totalCalories'],
    kcal_active: ['activeKilocalories', 'activeCalories'],
    kcal_basal: ['bmrKilocalories', 'bmrCalories'],
    floors: ['floorsAscended', 'floorsClimbed'],
    moderate: ['moderateIntensityMinutes', 'moderateIntensityDurationInMinutes'],
    vigorous: ['vigorousIntensityMinutes', 'vigorousIntensityDurationInMinutes'],
    rhr: ['restingHeartRate', 'restingHeartRateInBeatsPerMinute'],
    hr_min: ['minHeartRate', 'minHeartRateInBeatsPerMinute'],
    hr_max: ['maxHeartRate', 'maxHeartRateInBeatsPerMinute'],
    hr_avg: ['averageHeartRate', 'averageHeartRateInBeatsPerMinute'],
    stress: ['averageStressLevel', 'avgStressLevel'],
    stress_max: ['maxStressLevel'],
    restSec: ['restStressDuration', 'restStressDurationInSeconds'],
    lowSec: ['lowStressDuration', 'lowStressDurationInSeconds'],
    mediumSec: ['mediumStressDuration', 'mediumStressDurationInSeconds'],
    highSec: ['highStressDuration', 'highStressDurationInSeconds'],
    bb_high: ['bodyBatteryHighestValue', 'bodyBatteryHighValue'],
    bb_low: ['bodyBatteryLowestValue', 'bodyBatteryLowValue'],
    bb_charged: ['bodyBatteryChargedValue', 'bodyBatteryChargedValueInPercent'],
    bb_drained: ['bodyBatteryDrainedValue', 'bodyBatteryDrainedValueInPercent'],
    spo2: ['averageSpo2', 'averageSpO2', 'avgSpo2'],
    spo2_min: ['lowestSpo2', 'lowestSpO2'],
    sedentarySec: ['sedentarySeconds', 'sedentaryDurationInSeconds'],
  },
  // /usersummary-service/stats/stress/daily/{start}/{end}: [{ calendarDate, values: {...} }]
  stress: {
    date: ['calendarDate', 'date'],
    level: ['values.overallStressLevel', 'values.averageStressLevel', 'overallStressLevel', 'averageStressLevel'],
    restSec: ['values.restStressDuration', 'restStressDuration'],
    lowSec: ['values.lowStressDuration', 'lowStressDuration'],
    mediumSec: ['values.mediumStressDuration', 'mediumStressDuration'],
    highSec: ['values.highStressDuration', 'highStressDuration'],
  },
  // /usersummary-service/stats/steps/daily/{start}/{end}: [{ calendarDate, totalSteps, totalDistance }]
  steps: { date: ['calendarDate', 'date'], steps: ['totalSteps', 'values.totalSteps'], distance_m: ['totalDistance', 'values.totalDistance'] },
  // /hrv-service/hrv/daily/{start}/{end}: { hrvSummaries: [{ calendarDate, lastNightAvg, weeklyAvg, status }] }
  hrv: { date: ['calendarDate', 'date'], hrv: ['lastNightAvg', 'lastNightAverage', 'avgOvernightHrv'], weekly: ['weeklyAvg'], status: ['status', 'hrvStatus'] },
  // /wellness-service/wellness/bodyBattery/reports/daily: [{ date, charged, drained, bodyBatteryValuesArray: [[ms, level], ...] }]
  battery: { date: ['date', 'calendarDate'], charged: ['charged', 'bodyBatteryChargedValue'], drained: ['drained', 'bodyBatteryDrainedValue'], values: ['bodyBatteryValuesArray', 'bodyBatteryValues'] },
  // /sleep-service/sleep/dailySleep: { dailySleepDTO: {...}, sleepLevels: [{ startGMT, endGMT, activityLevel }] }
  sleep: {
    dto: ['dailySleepDTO', 'dailySleep'],
    date: ['calendarDate'],
    start: ['sleepStartTimestampGMT'], end: ['sleepEndTimestampGMT'],
    startLocal: ['sleepStartTimestampLocal'], endLocal: ['sleepEndTimestampLocal'],
    asleepSec: ['sleepTimeSeconds'], napSec: ['napTimeSeconds'],
    deepSec: ['deepSleepSeconds'], lightSec: ['lightSleepSeconds'], remSec: ['remSleepSeconds'], awakeSec: ['awakeSleepSeconds'],
    awakenings: ['awakeCount'],
    score: ['sleepScores.overall.value', 'sleepScores.overallScore', 'overallSleepScore'],
    resp: ['averageRespirationValue', 'avgSleepRespirationValue'],
    spo2: ['averageSpO2Value', 'averageSpo2Value'],
    spo2_min: ['lowestSpO2Value', 'lowestSpo2Value'],
    stress: ['avgSleepStress'],
    levels: ['sleepLevels'],
    rhr: ['restingHeartRate'],
    hrv: ['avgOvernightHrv'],
  },
  // /wellness-service/wellness/dailyHeartRate: { calendarDate, restingHeartRate, heartRateValues: [[ms, bpm], ...] }
  heart: { date: ['calendarDate'], rhr: ['restingHeartRate'], min: ['minHeartRate'], max: ['maxHeartRate'], values: ['heartRateValues'] },
  // /wellness-service/wellness/daily/spo2acclimation/{date}
  spo2: { date: ['calendarDate'], avg: ['avgSleepSpO2', 'averageSpO2', 'averageSpo2', 'avgSpo2'], min: ['lowestSpO2', 'lowestSpo2'] },
  // /weight-service/weight/range/{start}/{end}?includeAll=true: { dailyWeightSummaries: [{ allWeightMetrics: [...] }] }
  weight: { t: ['timestampGMT', 'date'], grams: ['weight'], fat: ['bodyFat'], id: ['samplePk'] },
  // /activitylist-service/activities/search/activities: [{ activityId, activityName, activityType: { typeKey }, ... }]
  activity: {
    id: ['activityId'], name: ['activityName'], type: ['activityType.typeKey', 'activityTypeDTO.typeKey', 'activityType'],
    start: ['startTimeGMT', 'beginTimestamp'], startLocal: ['startTimeLocal'],
    elapsedSec: ['elapsedDuration', 'duration'], movingSec: ['movingDuration'], durationSec: ['duration'],
    kcal: ['calories'], avgHr: ['averageHR', 'averageHeartRate'], maxHr: ['maxHR', 'maxHeartRate'],
    steps: ['steps'], distance: ['distance'], speed: ['averageSpeed'],
  },
};

/** One record's fields by a FIELDS group. */
function fields(o, group) {
  const out = {};
  for (const [k, names] of Object.entries(FIELDS[group])) out[k] = pick(o, names);
  return out;
}

const min = (sec) => { const s = pos(sec); return s === null ? null : Math.round((s / 60) * 10) / 10; };
/** Garmin marks "not enough data" with -1 or -2. */
const level = (v, hi = 100) => { const n = fin(v); return n !== null && n >= 0 && n <= hi ? n : null; };

/** { date: { metric: value } } from the daily summaries. */
export function readDays(j, note = () => {}) {
  const out = {};
  const list = listOf(j, ['dailySummaries', 'summaries']);
  if (j && !list.length && typeof j === 'object' && !Array.isArray(j) && pick(j, FIELDS.day.date)) list.push(j);
  if (j && !list.length) note('dailysummaries', j);
  for (const o of list) {
    try {
      const f = fields(o, 'day');
      if (!isDate(f.date)) continue;
      const m = {};
      const put = (k, v) => { if (v !== null && Number.isFinite(v)) m[k] = v; };
      put('steps', pos(f.steps)); put('distance_m', pos(f.distance_m)); put('kcal', pos(f.kcal)); put('kcal_active', pos(f.kcal_active));
      put('kcal_basal', pos(f.kcal_basal)); put('floors', pos(f.floors) !== null ? Math.round(pos(f.floors)) : null);
      const mod = pos(f.moderate); const vig = pos(f.vigorous);
      if (mod !== null || vig !== null) {
        // Garmin's intensity minutes count vigorous ones double, as Google's
        // zone minutes count cardio and peak double: the same idea.
        put('active_min', (mod || 0) + (vig || 0));
        put('azm', (mod || 0) + 2 * (vig || 0));
      }
      put('rhr', pos(f.rhr) || null); put('hr_min', pos(f.hr_min) || null); put('hr_max', pos(f.hr_max) || null); put('hr_avg', pos(f.hr_avg) || null);
      put('stress', level(f.stress)); put('stress_max', level(f.stress_max));
      put('stress_rest', min(f.restSec)); put('stress_low', min(f.lowSec)); put('stress_medium', min(f.mediumSec)); put('stress_high', min(f.highSec));
      put('bb_high', level(f.bb_high)); put('bb_low', level(f.bb_low)); put('bb_charged', pos(f.bb_charged)); put('bb_drained', pos(f.bb_drained));
      put('spo2', level(f.spo2) || null); put('spo2_min', level(f.spo2_min) || null);
      put('sedentary_min', min(f.sedentarySec));
      out[f.date.slice(0, 10)] = m;
    } catch { /* one bad day: the rest stand */ }
  }
  return out;
}

/** { date: { stress, stress_rest, ... } } from the daily stress stats. */
export function readStress(j, note = () => {}) {
  const out = {};
  const list = listOf(j, ['stressValues', 'dailyStress']);
  if (j && !list.length) note('stress', j);
  for (const o of list) {
    const f = fields(o, 'stress');
    if (!isDate(f.date)) continue;
    const m = {};
    const lv = level(f.level);
    if (lv !== null) m.stress = lv;
    for (const [k, v] of [['stress_rest', f.restSec], ['stress_low', f.lowSec], ['stress_medium', f.mediumSec], ['stress_high', f.highSec]]) { const x = min(v); if (x !== null) m[k] = x; }
    if (Object.keys(m).length) out[f.date.slice(0, 10)] = m;
  }
  return out;
}

export function readSteps(j, note = () => {}) {
  const out = {};
  const list = listOf(j);
  if (j && !list.length) note('steps', j);
  for (const o of list) {
    const f = fields(o, 'steps');
    if (!isDate(f.date)) continue;
    const m = {};
    if (pos(f.steps) !== null) m.steps = pos(f.steps);
    if (pos(f.distance_m) !== null) m.distance_m = pos(f.distance_m);
    if (Object.keys(m).length) out[f.date.slice(0, 10)] = m;
  }
  return out;
}

export function readHrv(j, note = () => {}) {
  const out = {};
  const list = listOf(j, ['hrvSummaries']);
  if (j && !list.length && j.hrvSummary) list.push(j.hrvSummary);
  if (j && !list.length) note('hrv', j);
  for (const o of list) {
    const f = fields(o, 'hrv');
    const v = pos(f.hrv);
    if (isDate(f.date) && v) out[f.date.slice(0, 10)] = { hrv: v };
  }
  return out;
}

/** Body Battery: per day its numbers and its curve ([[t, level], ...]). */
export function readBattery(j, note = () => {}) {
  const out = {};
  const list = listOf(j, ['bodyBatteryReports']);
  if (j && !list.length) note('bodyBattery', j);
  for (const o of list) {
    try {
      const f = fields(o, 'battery');
      if (!isDate(f.date)) continue;
      const desc = Array.isArray(o.bodyBatteryValueDescriptorDTOList) ? o.bodyBatteryValueDescriptorDTOList : Array.isArray(o.bodyBatteryValueDescriptorsDTOList) ? o.bodyBatteryValueDescriptorsDTOList : [];
      const at = (key, dflt) => { const d = desc.find((x) => String(x?.bodyBatteryValueDescriptorKey || x?.key || '').toLowerCase() === key); return Number.isInteger(d?.bodyBatteryValueDescriptorIndex ?? d?.index) ? (d.bodyBatteryValueDescriptorIndex ?? d.index) : dflt; };
      const iT = at('timestamp', 0);
      const points = [];
      for (const row of Array.isArray(f.values) ? f.values : []) {
        if (!Array.isArray(row)) continue;
        // [t, level], or [t, status, level, version] as Connect's own app has it.
        const iL = at('bodybatterylevel', row.length >= 3 ? 2 : 1);
        const t = gmt(row[iT]); const lv = level(row[iL]);
        if (t && lv !== null) points.push([t, lv]);
      }
      points.sort((a, b) => a[0] - b[0]);
      const m = { points };
      if (pos(f.charged) !== null) m.bb_charged = pos(f.charged);
      if (pos(f.drained) !== null) m.bb_drained = pos(f.drained);
      if (points.length) { m.bb_high = Math.max(...points.map((p) => p[1])); m.bb_low = Math.min(...points.map((p) => p[1])); }
      out[f.date.slice(0, 10)] = m;
    } catch { /* one bad day */ }
  }
  return out;
}

const STAGE = { 0: 'DEEP', 1: 'LIGHT', 2: 'REM', 3: 'AWAKE' };
/** Garmin's sleep level names, when they come as words. */
const STAGE_WORD = { deep: 'DEEP', light: 'LIGHT', rem: 'REM', awake: 'AWAKE' };

/**
 * One night as this site keeps it (the `sleep` table's row), plus the
 * night's numbers that are measured asleep. null when there is no night.
 * `offOf(t)` gives the person's UTC offset in seconds when Garmin gives
 * no local times.
 */
export function readSleep(j, { offOf = () => 0, note = () => {} } = {}) {
  if (!j || typeof j !== 'object') return null;
  const dto = pick(j, FIELDS.sleep.dto) || j;
  const f = fields(dto, 'sleep');
  const top = fields(j, 'sleep');
  const startMs = gmt(f.start); const endMs = gmt(f.end);
  if (!startMs || !endMs || endMs <= startMs) { if (Object.keys(dto).length > 3 && pos(f.asleepSec)) note('sleep', dto); return null; }
  const sL = gmt(f.startLocal); const eL = gmt(f.endLocal);
  const startOff = sL ? Math.round((sL - startMs) / 1000) : offOf(startMs);
  const endOff = eL ? Math.round((eL - endMs) / 1000) : offOf(endMs);
  const stages = [];
  for (const x of Array.isArray(top.levels) ? top.levels : Array.isArray(f.levels) ? f.levels : []) {
    const s = gmt(x?.startGMT ?? x?.startTimeGMT); const e = gmt(x?.endGMT ?? x?.endTimeGMT);
    const lv = x?.activityLevel;
    const t = typeof lv === 'string' && STAGE_WORD[lv.toLowerCase()] ? STAGE_WORD[lv.toLowerCase()] : STAGE[Math.round(Number(lv))];
    if (s && e && e > s && t) stages.push({ s, e, t });
  }
  stages.sort((a, b) => a.s - b.s);
  const byStage = {};
  for (const [k, v] of [['DEEP', f.deepSec], ['LIGHT', f.lightSec], ['REM', f.remSec], ['AWAKE', f.awakeSec]]) { const m = min(v); if (m !== null) byStage[k] = m; }
  if (!Object.keys(byStage).length) for (const x of stages) byStage[x.t] = (byStage[x.t] || 0) + (x.e - x.s) / 60_000;
  const periodMin = Math.round((endMs - startMs) / 60_000);
  const asleep = min(f.asleepSec);
  const awakeMin = byStage.AWAKE ?? (asleep !== null ? Math.max(0, periodMin - asleep) : 0);
  const asleepMin = asleep ?? Math.max(0, periodMin - awakeMin);
  const date = isDate(f.date) ? f.date.slice(0, 10) : new Date(endMs + endOff * 1000).toISOString().slice(0, 10);
  const score = level(f.score);
  const row = {
    id: `garmin-sleep-${startMs}`, date, startMs, endMs, startOff, endOff,
    main: periodMin >= 180,
    asleepMin, awakeMin, periodMin,
    stages,
    summary: {
      stages: byStage, toFallAsleep: null, afterWake: null,
      shortAwakenings: pos(f.awakenings), stagesStatus: stages.length || byStage.DEEP !== undefined ? 'SUCCEEDED' : null,
      type: stages.length ? 'STAGES' : 'CLASSIC', processed: true, nap: false,
      source: 'garmin', ...(score !== null ? { deviceScore: score } : {}),
    },
  };
  const night = {};
  const put = (k, v) => { if (v !== null && v !== undefined && Number.isFinite(v)) night[k] = v; };
  put('resp', pos(f.resp) || null);
  put('spo2', level(f.spo2) || null); put('spo2_min', level(f.spo2_min) || null);
  put('rhr', pos(top.rhr ?? f.rhr) || null);
  put('hrv', pos(top.hrv ?? f.hrv) || null);
  if (score !== null) night.garmin_sleep_score = score;
  return { row, night, date };
}

/**
 * A day's heart rate: the day's low, high and mean, the hours (for the
 * day by the hour), and the newest reading.
 */
export function readHeart(j, note = () => {}) {
  if (!j || typeof j !== 'object') return null;
  const f = fields(j, 'heart');
  const vals = [];
  for (const row of Array.isArray(f.values) ? f.values : []) {
    const t = gmt(Array.isArray(row) ? row[0] : row?.timestamp ?? row?.t);
    const bpm = pos(Array.isArray(row) ? row[1] : row?.value ?? row?.bpm);
    if (t && bpm && bpm > 20 && bpm < 250) vals.push([t, bpm]);
  }
  if (!vals.length && !pos(f.rhr)) { if (Object.keys(j).length) note('heartRate', j); return null; }
  vals.sort((a, b) => a[0] - b[0]);
  const hours = new Map();
  for (const [t, bpm] of vals) {
    const start = Math.floor(t / 3_600_000) * 3_600_000;
    const h = hours.get(start) || { start, min: bpm, max: bpm, sum: 0, n: 0 };
    h.min = Math.min(h.min, bpm); h.max = Math.max(h.max, bpm); h.sum += bpm; h.n += 1;
    hours.set(start, h);
  }
  const daily = {};
  if (pos(f.rhr)) daily.rhr = pos(f.rhr);
  if (vals.length) {
    daily.hr_min = Math.min(...vals.map((v) => v[1]));
    daily.hr_max = Math.max(...vals.map((v) => v[1]));
    daily.hr_avg = Math.round((vals.reduce((a, v) => a + v[1], 0) / vals.length) * 10) / 10;
  }
  return {
    date: isDate(f.date) ? f.date.slice(0, 10) : null,
    daily,
    hours: [...hours.values()].map((h) => ({ start: h.start, end: h.start + 3_600_000, min: h.min, max: h.max, avg: Math.round((h.sum / h.n) * 10) / 10 })),
    latest: vals.length ? { t: vals[vals.length - 1][0], bpm: vals[vals.length - 1][1] } : null,
    n: vals.length,
  };
}

export function readSpo2(j, note = () => {}) {
  if (!j || typeof j !== 'object') return null;
  const f = fields(j, 'spo2');
  const avg = level(f.avg); const lo = level(f.min);
  if (!avg && !lo) { if (Object.keys(j).length) note('spo2', j); return null; }
  return { date: isDate(f.date) ? f.date.slice(0, 10) : null, spo2: avg || null, spo2_min: lo || null };
}

/** Weigh-ins: [{ t, grams, fatPct, id }]. */
export function readWeights(j, note = () => {}) {
  const out = [];
  const days = listOf(j, ['dailyWeightSummaries']);
  const flat = days.length && days.some((d) => Array.isArray(d?.allWeightMetrics)) ? days.flatMap((d) => d.allWeightMetrics || []) : listOf(j, ['dateWeightList', 'allWeightMetrics']).length ? listOf(j, ['dateWeightList', 'allWeightMetrics']) : days;
  if (j && !flat.length && !Array.isArray(j?.dailyWeightSummaries)) note('weight', j);
  for (const o of flat) {
    const f = fields(o, 'weight');
    const t = gmt(f.t);
    const g = pos(f.grams);
    // Garmin keeps weight in grams; a value under 400 can only be kilograms.
    const grams = g === null ? null : g < 400 ? g * 1000 : g;
    if (!t || !grams || grams < 20_000 || grams > 400_000) continue;
    const fat = pos(f.fat);
    out.push({ t, grams: Math.round(grams), fatPct: fat && fat > 1 && fat < 80 ? fat : null, id: f.id ? String(f.id) : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Garmin activity type → Google exercise type (what the workout pages know). */
const TYPE = {
  running: 'RUNNING', street_running: 'RUNNING', track_running: 'RUNNING', trail_running: 'RUNNING', treadmill_running: 'RUNNING', indoor_running: 'RUNNING', virtual_run: 'RUNNING', ultra_run: 'RUNNING',
  walking: 'WALKING', casual_walking: 'WALKING', speed_walking: 'WALKING', indoor_walking: 'WALKING',
  hiking: 'HIKING',
  cycling: 'BIKING', road_biking: 'BIKING', mountain_biking: 'BIKING', gravel_cycling: 'BIKING', indoor_cycling: 'BIKING', virtual_ride: 'BIKING', cyclocross: 'BIKING', e_bike_fitness: 'ELECTRIC_BIKE', e_bike_mountain: 'ELECTRIC_BIKE',
  lap_swimming: 'SWIMMING_POOL', open_water_swimming: 'SWIMMING_OPEN_WATER', swimming: 'SWIMMING_POOL',
  strength_training: 'STRENGTH_TRAINING', cardio_training: 'CARDIO_WORKOUT', fitness_equipment: 'WORKOUT', hiit: 'HIIT',
  elliptical: 'ELLIPTICAL', stair_climbing: 'STAIR_CLIMBING', indoor_rowing: 'ROWING_MACHINE', rowing: 'ROWING',
  yoga: 'YOGA', pilates: 'PILATES', breathwork: 'MEDITATE', meditation: 'MEDITATE',
  tennis: 'TENNIS', pickleball: 'PICKLEBALL', padel: 'PADEL', soccer: 'SOCCER', basketball: 'BASKETBALL', golf: 'GOLF',
  resort_skiing_snowboarding_ws: 'SKIING', backcountry_skiing: 'SKIING', cross_country_skiing_ws: 'CROSS_COUNTRY_SKI', snowboarding_ws: 'SNOWBOARDING',
  boxing: 'BOXING', dance: 'DANCING', rock_climbing: 'CLIMBING', indoor_climbing: 'INDOOR_CLIMBING', bouldering: 'INDOOR_CLIMBING',
};
export const exerciseTypeOf = (key, known = null) => { const t = TYPE[String(key || '').toLowerCase()]; return t && (!known || known.has(t)) ? t : 'WORKOUT'; };
const PACED = new Set(['RUNNING', 'WALKING', 'HIKING']);

/** Activities as rows of the `exercise` table (what Google's sessions become too). */
export function readActivities(j, { known = null, offOf = () => 0, note = () => {} } = {}) {
  const out = [];
  const list = listOf(j, ['activityList', 'activities']);
  if (j && !list.length && !Array.isArray(j)) note('activities', j);
  for (const o of list) {
    try {
      const f = fields(o, 'activity');
      const id = fin(f.id);
      const startMs = gmt(f.start);
      if (!id || !startMs) continue;
      const elapsed = pos(f.elapsedSec) ?? pos(f.durationSec);
      if (!elapsed || elapsed < 30) continue;
      const endMs = startMs + Math.round(elapsed * 1000);
      const sL = gmt(f.startLocal);
      const off = sL ? Math.round((sL - startMs) / 1000) : offOf(startMs);
      const type = exerciseTypeOf(typeof f.type === 'object' ? f.type?.typeKey : f.type, known);
      const z = [1, 2, 3, 4, 5].map((i) => pos(o[`hrTimeInZone_${i}`]));
      const zones = z.some((v) => v) ? { light: Math.round(((z[0] || 0) + (z[1] || 0)) / 6) / 10, moderate: Math.round((z[2] || 0) / 6) / 10, vigorous: Math.round((z[3] || 0) / 6) / 10, peak: Math.round((z[4] || 0) / 6) / 10 } : null;
      const speed = pos(f.speed);
      out.push({
        id: `garmin-${Math.round(id)}`, date: new Date(startMs + off * 1000).toISOString().slice(0, 10), startMs, endMs,
        type, name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 80) : null,
        kcal: pos(f.kcal), azm: null, avgHr: pos(f.avgHr) || null, steps: pos(f.steps) || null, distanceM: pos(f.distance) || null,
        zones, activeSec: pos(f.movingSec) ?? null, paceSecPerKm: PACED.has(type) && speed && speed > 0.3 ? Math.round(1000 / speed) : null,
        device: 'Garmin',
      });
    } catch { /* one bad activity */ }
  }
  return out;
}
