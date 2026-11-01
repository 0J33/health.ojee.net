/* ============================================================
   health.ojee.net — Garmin's numbers, kept here.

   The calls are server/garmin.js. A pass reads Garmin into the
   person's Garmin store (data/users/<id>/src/garmin.sqlite), in the
   same tables and the same shapes Google's sync writes, and the fold
   (core/merge.js) puts it together with Google's, if there is a
   Google, into the store every page reads. So a Garmin-only person
   has Today, the sleep page, the scores, the tiles, the leaderboard,
   readiness and resilience like anybody else, and somebody with both
   gets each number once (the rule is `prefer`, below).

     daily      steps, distance, calories (total, active, resting),
                floors, intensity minutes (as active minutes, and as
                zone minutes: vigorous count double in both), resting,
                lowest, highest and mean heart rate, HRV (last night's
                average), blood oxygen, breathing rate asleep, stress
                (the day's level and the minutes at rest, low, medium,
                high), Body Battery (high, low, charged, drained),
                Garmin's own sleep score, sedentary time
     sleep      each night with its stages (deep, light, REM, awake)
     exercise   each activity: type, times, heart rate, calories,
                distance, steps, zone minutes, pace. No route: the FIT
                file is not read
     weight     each weigh-in, and body fat with it
     sample     the day's heart rate by the hour (kind 'hrhours', for
                the day by the hour) and the day's Body Battery curve
                (kind 'bbday'), one row a day
     meta       the newest pulse ('hr'), and 'hrDense' for a day of
                watch-like readings

   How much is read, gently: every pass the last three days one by one
   (sleep, heart rate, blood oxygen) and the last week in ranges (the
   daily summaries, stress, HRV, Body Battery, weight, activities).
   Then one week further back, until the history asked for (30 days by
   default; 90 or 365 on request) is in: about forty calls a pass, a
   second apart. A 429 stops the pass and waits Garmin's Retry-After
   (or a quarter of an hour, doubling); a read Garmin refuses (403,
   404, 400) is left alone for a day while the rest carry on.
   ============================================================ */

import {
  GarminError, readDays, readStress, readSteps, readHrv, readBattery, readSleep, readHeart, readSpo2, readWeights, readActivities, keysOf, RANGE_DAYS,
} from './garmin.js';
import { GOOGLE_EXERCISE_TYPES } from './core/workouts.js';
import { addDays, today as todayIn, utcOffsetSec, localToMs } from './core/util.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The days read one by one on every pass: today and the two before. */
export const RECENT_DAYS = 3;
/** The days read in ranges on every pass. */
const RANGE_RECENT = 7;
/** How far one pass walks back into the history. */
export const BACK_STEP = 7;
export const BACKFILL_CHOICES = [30, 90, 365];
/** Bumped when the readers learn a shape: the history is read again once. */
const READ_VERSION = 2;
export const GARMIN_DEFAULTS = { prefer: 'garmin', backfill: 30 };
const UNAVAILABLE_MS = 24 * HOUR;
/** The daily metrics this store writes, every one of them a catalogue key. */
export const GARMIN_DAILY = ['steps', 'distance_m', 'kcal', 'kcal_active', 'kcal_basal', 'floors', 'active_min', 'azm', 'rhr', 'hr_min', 'hr_max', 'hr_avg',
  'hrv', 'spo2', 'spo2_min', 'resp', 'stress', 'stress_max', 'stress_rest', 'stress_low', 'stress_medium', 'stress_high',
  'bb_high', 'bb_low', 'bb_charged', 'bb_drained', 'garmin_sleep_score', 'sedentary_min', 'body_fat'];
const ALLOWED = new Set(GARMIN_DAILY);

/* ── the person's Garmin state (kept in their own store, meta 'garmin') ── */

export function garminMeta(db) {
  const m = db.meta('garmin', null) || {};
  const s = { ...GARMIN_DEFAULTS, ...(m.settings || {}) };
  if (!['garmin', 'google'].includes(s.prefer)) s.prefer = GARMIN_DEFAULTS.prefer;
  if (!BACKFILL_CHOICES.includes(s.backfill)) s.backfill = GARMIN_DEFAULTS.backfill;
  return { ...m, settings: s };
}
export function setGarminMeta(db, patch) {
  const next = { ...garminMeta(db), ...patch };
  db.setMeta('garmin', next);
  return next;
}

/** What the Connections page is told. Never the key, never the token. */
export function garminView(main, src, { connected = false, last4 = null, now = Date.now(), tz } = {}) {
  const m = garminMeta(main);
  const today = todayIn(now, tz);
  const target = addDays(today, -(m.settings.backfill - 1));
  const counts = src ? {
    days: src.db.prepare("SELECT COUNT(DISTINCT date) AS n FROM daily").get()?.n || 0,
    nights: src.sleeps('0000-00-00').length,
    activities: src.exercises('0000-00-00').length,
    weighIns: src.weights(0).length,
    stressDays: src.db.prepare("SELECT COUNT(*) AS n FROM daily WHERE metric = 'stress'").get()?.n || 0,
  } : { days: 0, nights: 0, activities: 0, weighIns: 0, stressDays: 0 };
  return {
    connected,
    last4: connected ? last4 : null,
    connectedAt: m.connectedAt || null,
    keyExpiresAt: connected ? m.keyExpiresAt || null : null,
    keyExpiresKnown: connected ? !!m.keyExpiresKnown : false,
    tokenExpiresAt: connected ? m.tokenExpiresAt || null : null,
    lastSync: m.lastSync || null,
    lastResult: m.lastResult || null,
    lastError: m.lastError || null,
    retryAt: m.retryAt && m.retryAt > now ? m.retryAt : null,
    lost: !connected && m.lost ? m.lost : null,
    kept: !connected && !!m.kept,
    settings: m.settings,
    backfill: { days: m.settings.backfill, backTo: m.backTo || null, done: !!m.backTo && m.backTo <= target, target },
    counts,
    unavailable: Object.entries(m.unavailable || {}).filter(([, at]) => now - at < UNAVAILABLE_MS).map(([k]) => k),
  };
}

/* ── one pass ─────────────────────────────────────────────────────── */

const STOP = new Set(['rate_limited', 'network', 'garmin_key', 'upstream', 'protocol']);

/**
 * One pass into the Garmin store `src`. `main` is the person's own store
 * (where the state is kept). Never throws: { ok, code, message, wrote,
 * days, nights, activities, weighIns, calls }.
 */
export async function syncGarmin({ main, src, api, tz, now = Date.now, force = false, log = () => {} }) {
  const startedAt = now();
  const m = garminMeta(main);
  const out = { ok: true, wrote: 0, days: 0, nights: 0, activities: 0, weighIns: 0, calls: 0 };
  if (!force && m.retryAt && m.retryAt > startedAt) return { ...out, ok: false, skipped: true, code: 'rate_limited', message: 'Waiting for Garmin to allow more reads.' };
  const today = todayIn(startedAt, tz);
  const target = addDays(today, -(m.settings.backfill - 1));
  const unavailable = { ...(m.unavailable || {}) };
  for (const [k, at] of Object.entries(unavailable)) if (startedAt - at >= UNAVAILABLE_MS) delete unavailable[k];
  const noted = new Set();
  const note = (where, value) => { if (noted.has(where)) return; noted.add(where); log(`garmin: unexpected ${where} shape (${keysOf(value)})`); };
  const offOf = (t) => utcOffsetSec(t, tz);
  const known = GOOGLE_EXERCISE_TYPES;

  /** One read: its answer, or null when Garmin will not give it now. */
  const read = async (name, fn) => {
    if (unavailable[name]) return null;
    try { return await fn(); } catch (e) {
      if (e instanceof GarminError && e.code === 'unavailable') { unavailable[name] = startedAt; log(`garmin: ${name} unavailable (${e.status})`); return null; }
      throw e;
    }
  };

  /* The days to write: date -> metric -> value, in the order the readers
     come (a later, more exact reader wins). */
  const days = {};
  const put = (date, metrics) => {
    if (!date || date > today) return;
    const row = (days[date] ||= {});
    for (const [k, v] of Object.entries(metrics || {})) if (ALLOWED.has(k) && Number.isFinite(v)) row[k] = v;
  };
  const nights = [];
  const hourRows = [];
  const bbRows = [];
  let activities = null; let actFrom = null;
  const weighIns = [];
  let latestHr = null; let dense = false; let newest = 0;

  async function ranged(from, to) {
    for (let a = from; a <= to; a = addDays(a, RANGE_DAYS)) {
      const b = [addDays(a, RANGE_DAYS - 1), to].sort()[0];
      const sums = await read('dailysummaries', () => api.dailySummaries(a, b));
      const byDay = readDays(sums, note);
      for (const [d, x] of Object.entries(byDay)) put(d, x);
      if (sums === null || !Object.values(byDay).some((x) => Number.isFinite(x.steps))) {
        // No summaries, or summaries without steps (a shape not read): steps from their own stats.
        for (const [d, x] of Object.entries(readSteps(await read('steps', () => api.steps(a, b)), note))) put(d, x);
      }
      for (const [d, x] of Object.entries(readStress(await read('stress', () => api.stress(a, b)), note))) put(d, x);
      for (const [d, x] of Object.entries(readHrv(await read('hrv', () => api.hrv(a, b)), note))) put(d, x);
      for (const [d, x] of Object.entries(readBattery(await read('bodyBattery', () => api.bodyBattery(a, b)), note))) {
        const { points, ...rest } = x;
        put(d, rest);
        if (points.length) bbRows.push({ date: d, points });
      }
      const ws = readWeights(await read('weight', () => api.weight(a, b)), note);
      weighIns.push(...ws);
      const acts = await read('activities', () => api.activities({ startDate: a, endDate: b, limit: 100 }));
      if (acts !== null) { activities = [...(activities || []), ...readActivities(acts, { known, offOf, note })]; actFrom = actFrom && actFrom < a ? actFrom : a; }
    }
  }
  async function single(date) {
    const sl = readSleep(await read('sleep', () => api.sleep(date)), { offOf, note });
    if (sl) { nights.push({ ...sl, asked: date }); put(sl.date, sl.night); }
    else nights.push({ asked: date, row: null });
    const hr = readHeart(await read('heartRate', () => api.heartRate(date)), note);
    if (hr) {
      put(hr.date || date, hr.daily);
      if (hr.hours.length) hourRows.push({ date: hr.date || date, hours: hr.hours });
      if (hr.latest && (!latestHr || hr.latest.t > latestHr.t)) latestHr = hr.latest;
      if (hr.n >= 20) dense = true;
    }
    const sp = readSpo2(await read('spo2', () => api.spo2(date)), note);
    if (sp) put(sp.date || date, { spo2: sp.spo2, spo2_min: sp.spo2_min });
  }

  // A history read before this reader knew Garmin's nested daily summaries
  // (READ_VERSION 2) is read again, so its steps, calories and intensity minutes come in.
  let backTo = m.backTo && m.backTo <= today && (m.readVersion || 1) >= READ_VERSION ? m.backTo : null;
  try {
    // The recent days, every pass.
    const recentFrom = addDays(today, -(RECENT_DAYS - 1));
    await ranged(addDays(today, -(RANGE_RECENT - 1)), today);
    for (let dd = today; dd >= recentFrom; dd = addDays(dd, -1)) await single(dd);
    if (!backTo) backTo = recentFrom;
    // One step further into the history.
    if (backTo > target) {
      const from = [addDays(backTo, -BACK_STEP), target].sort().pop();
      const to = addDays(backTo, -1);
      // The ranges of the last week were just read: only what is older.
      const rTo = [to, addDays(today, -RANGE_RECENT)].sort()[0];
      if (from <= rTo) await ranged(from, rTo);
      for (let dd = to; dd >= from; dd = addDays(dd, -1)) await single(dd);
      backTo = from;
    }
  } catch (e) {
    out.ok = false; out.code = e.code || 'error'; out.message = e.message;
    if (e.retryAfterMs) out.retryAfterMs = e.retryAfterMs;
    if (!STOP.has(out.code)) log(`garmin pass: ${e.message}`);
  }

  // Whatever was read is kept, even from a pass that stopped half-way.
  const touched = new Set();
  src.tx(() => {
    for (const [date, row] of Object.entries(days)) {
      for (const [k, v] of Object.entries(row)) { if (src.dailyValue(date, k) !== v) { src.setDaily(date, k, v); out.wrote += 1; } }
      touched.add(date); out.days += 1;
    }
    for (const n of nights) {
      // A night Garmin no longer has for a day it was asked about goes.
      const day = n.row ? n.row.date : n.asked;
      for (const x of src.sleeps(addDays(day, -1)).filter((s) => s.date === day && s.id.startsWith('garmin-') && s.id !== n.row?.id)) { src.deleteSleep(x.id); out.wrote += 1; }
      if (n.row) {
        const cur = src.sleeps(addDays(day, -1)).find((x) => x.id === n.row.id);
        if (!cur || JSON.stringify(cur) !== JSON.stringify(n.row)) { src.upsertSleep(n.row); out.wrote += 1; }
        out.nights += 1; newest = Math.max(newest, n.row.endMs);
      }
    }
    for (const h of hourRows) {
      const t = localToMs(h.date, 0, tz);
      const avg = h.hours.reduce((a, x) => a + x.avg, 0) / h.hours.length;
      src.sampleUpsert({ kind: 'hrhours', t, end: localToMs(addDays(h.date, 1), 0, tz), off: utcOffsetSec(t, tz), date: h.date, value: Math.round(avg * 10) / 10, data: { hours: h.hours }, device: 'Garmin', source: 'garmin' }, startedAt);
      newest = Math.max(newest, h.hours[h.hours.length - 1].end - HOUR);
    }
    for (const b of bbRows) {
      const t = localToMs(b.date, 0, tz);
      // Kept every quarter-hour: plenty for a day's curve.
      const pts = []; let lastQ = -1;
      for (const [pt, lv] of b.points) { const q = Math.floor(pt / (15 * MIN)); if (q !== lastQ) { pts.push([pt, lv]); lastQ = q; } }
      src.sampleUpsert({ kind: 'bbday', t, end: localToMs(addDays(b.date, 1), 0, tz), off: utcOffsetSec(t, tz), date: b.date, value: pts[pts.length - 1][1], data: { points: pts }, device: 'Garmin', source: 'garmin' }, startedAt);
    }
    if (activities) {
      const byId = new Map(activities.map((a) => [a.id, a]));
      const was = new Map(src.exercises(actFrom).map((e) => [e.id, JSON.stringify(e)]));
      for (const a of byId.values()) { src.upsertExercise(a); out.activities += 1; newest = Math.max(newest, a.endMs); }
      // Deleted in Garmin Connect: gone here too, for the days that were read.
      for (const e of src.exercises(actFrom)) if (e.id.startsWith('garmin-') && !byId.has(e.id)) src.deleteExercise(e.id);
      const now2 = new Map(src.exercises(actFrom).map((e) => [e.id, JSON.stringify(e)]));
      for (const [id, v] of now2) if (was.get(id) !== v) out.wrote += 1;
      for (const id of was.keys()) if (!now2.has(id)) out.wrote += 1;
    }
    for (const w of weighIns) {
      const off = utcOffsetSec(w.t, tz);
      const cur = src.weights(w.t).find((x) => x.t === w.t);
      if (!cur || cur.grams !== w.grams) { src.upsertWeight({ t: w.t, grams: w.grams, off, source: 'garmin', note: null }); out.weighIns += 1; out.wrote += 1; }
      if (Number.isFinite(w.fatPct)) {
        const date = new Date(w.t + off * 1000).toISOString().slice(0, 10);
        src.setDaily(date, 'body_fat', w.fatPct);
        src.sampleUpsert({ kind: 'bodyfat', t: w.t, off, date, value: w.fatPct, data: {}, device: 'Garmin', source: 'garmin' }, startedAt);
      }
    }
    if (latestHr) { const cur = src.meta('hr'); if (!cur || latestHr.t >= cur.t) src.setMeta('hr', latestHr); newest = Math.max(newest, latestHr.t); }
    if (dense) src.setMeta('hrDense', { t: latestHr?.t || startedAt, n: 20 });
    if (out.wrote || newest) {
      const dev = src.meta('device');
      src.setMeta('device', { name: 'Garmin', type: 'TRACKER', battery: null, batteryStatus: null, lastSync: Math.max(dev?.lastSync || 0, newest || 0) || null });
    }
  });
  out.calls = api.calls;
  out.touched = [...touched];

  const failures = out.ok ? 0 : (m.failures || 0) + 1;
  const wait = out.ok ? null : out.code === 'rate_limited' ? (out.retryAfterMs || Math.min(6 * HOUR, 15 * MIN * 2 ** Math.min(5, failures - 1)))
    : out.code === 'network' || out.code === 'upstream' || out.code === 'protocol' ? Math.min(2 * HOUR, 5 * MIN * 2 ** Math.min(5, failures - 1)) : null;
  setGarminMeta(main, {
    backTo, readVersion: READ_VERSION,
    unavailable,
    failures,
    retryAt: wait ? startedAt + wait : null,
    tokenExpiresAt: api.tok?.expiresAt || m.tokenExpiresAt || null,
    lastSync: out.ok ? startedAt : (m.lastSync || null),
    lastResult: { at: startedAt, ok: out.ok, days: out.days, nights: out.nights, activities: out.activities, weighIns: out.weighIns, calls: out.calls },
    lastError: out.ok ? null : { code: out.code, message: String(out.message || '').slice(0, 300), at: startedAt },
  });
  return out;
}

/** Everything a Garmin store holds goes (the person chose not to keep it). */
export function clearGarminStore(src) {
  src.db.exec(`DELETE FROM daily; DELETE FROM sleep; DELETE FROM exercise; DELETE FROM weight; DELETE FROM sample;
    DELETE FROM meta WHERE key IN ('device', 'hr', 'hrDense');`);
}

export { DAY };
