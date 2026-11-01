/* Samsung Health (and anything else in Health Connect) on an Android
   phone, read by the Android app and sent to the server (server/hcsync.js).

   Samsung Health keeps a Galaxy Watch's data on the phone and writes it to
   Health Connect. Inside the Health app on Android the page can reach
   Health Connect through the Health plugin (@capgo/capacitor-health); it
   reads it while the app is open (on opening, coming back to it, and every
   quarter of an hour) and sends it up, summed into days on the phone:

     the days      steps, distance, calories (total, active, resting),
                   floors, heart rate (resting, lowest, highest, mean),
                   HRV, blood oxygen, breathing rate, VO2 max, body fat
     the nights    each with its stages
     workouts      type, times, calories, distance
     weigh-ins     each one
     the hours     heart rate by the hour, for the last few days

   The first time it reads back a year (when Health Connect allows reading
   history, else its last 30 days), a month at a time, newest first; after
   that, from a little before the last read. Where it has got to is kept in
   this browser (localStorage), per person. */

import { api } from './api.js';
import { app, emit } from './app.js';
import { platform } from './pwa.js';

const plugin = () => window.Capacitor?.Plugins?.Health || null;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const READ = ['steps', 'distance', 'calories', 'totalCalories', 'basalCalories', 'flightsClimbed', 'heartRate', 'restingHeartRate', 'heartRateVariability',
  'oxygenSaturation', 'respiratoryRate', 'vo2Max', 'sleep', 'weight', 'bodyFat', 'workouts'];
const HISTORY_DAYS = 365;
const CHUNK_DAYS = 30;

/** Is Health Connect reachable from here: the Android app, with the plugin, and Health Connect on the phone. */
export async function hcAvailable() {
  if (!platform.native || !platform.android) return { ok: false, why: 'app' };
  const h = plugin();
  if (!h) return { ok: false, why: 'update' };
  try { const r = await h.isAvailable(); return r?.available ? { ok: true } : { ok: false, why: 'missing', reason: r?.reason || null }; } catch { return { ok: false, why: 'missing' }; }
}

const key = () => `health.hc.${app.me?.user?.username || ''}`;
const state = () => { try { return JSON.parse(localStorage.getItem(key()) || '{}') || {}; } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(key(), JSON.stringify(s)); } catch { /* fine */ } };

/** The phone's own civil date of an instant. */
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const iso = (t) => new Date(t).toISOString();

/** Ask Health Connect for reading, then tell the server. */
export async function hcConnect() {
  const h = plugin();
  if (!h) throw new Error('Update the Health app to connect Samsung Health.');
  const st = await h.requestAuthorization({ read: READ, requestHistoryAccess: true });
  if (!st?.readAuthorized?.length) throw new Error('Health Connect did not allow reading. Allow it, then try again.');
  await api.post('/api/hc/connect', { device: 'Samsung Health' });
  save({ ...state(), history: st.historyAccessAuthorized === true });
  return st;
}

/** One thing read, or nothing when Health Connect refuses it (not allowed, not on this phone). */
async function tryRead(fn) { try { return await fn(); } catch { return null; } }

/** Days summed by Health Connect: { 'YYYY-MM-DD': value } for one type. */
async function perDay(h, dataType, from, to, aggregation = 'sum') {
  const r = await tryRead(() => h.queryAggregated({ dataType, startDate: iso(from), endDate: iso(to), bucket: 'day', aggregation }));
  const out = {};
  for (const s of r?.samples || []) {
    const v = Array.isArray(aggregation) ? s.values : s.value;
    if (v !== null && v !== undefined) out[ymd(Date.parse(s.startDate))] = v;
  }
  return out;
}

/** All samples of a type in a window, paged by time (newest first, as the plugin gives them). */
async function samples(h, dataType, from, to, limit = 5000) {
  const r = await tryRead(() => h.readSamples({ dataType, startDate: iso(from), endDate: iso(to), limit, ascending: true }));
  return r?.samples || [];
}

/** The day's mean of a type's samples, by date. */
function meanBy(list, pick = (s) => s.value) {
  const acc = {};
  for (const s of list) { const v = pick(s); if (!Number.isFinite(v)) continue; const d = ymd(Date.parse(s.startDate)); (acc[d] ||= []).push(v); }
  return Object.fromEntries(Object.entries(acc).map(([d, v]) => [d, v.reduce((a, b) => a + b, 0) / v.length]));
}
const lastBy = (list) => { const out = {}; for (const s of list) if (Number.isFinite(s.value)) out[ymd(Date.parse(s.startDate))] = s.value; return out; };

/**
 * Active minutes, from the steps' pace, for when no device says (Health
 * Connect has no such number): a minute walked at 100 steps a minute or
 * more is a moderate one, the usual line in the research; a stretch of
 * steps counts in proportion to its length. By day.
 */
async function activeFromSteps(h, from, to) {
  const out = {};
  for (let a = from; a < to; a += 7 * DAY) {
    const b = Math.min(to, a + 7 * DAY);
    const list = await samples(h, 'steps', a, b, 60000);
    for (const s of list) {
      const t0 = Date.parse(s.startDate); const t1 = Date.parse(s.endDate);
      const min = (t1 - t0) / 60_000;
      if (!(min >= 0.5 && min <= 20) || !Number.isFinite(s.value)) continue;
      if (s.value / min >= 100) { const d = ymd(t0); out[d] = (out[d] || 0) + min; }
    }
  }
  return out;
}

/** Read one window [from, to) and send it. `hours`: also heart rate by the hour (the last few days). */
async function readWindow(h, from, to, { hours = false, last = true } = {}) {
  const [steps, dist, active, total, basal, floors] = await Promise.all([
    perDay(h, 'steps', from, to), perDay(h, 'distance', from, to), perDay(h, 'calories', from, to),
    perDay(h, 'totalCalories', from, to), perDay(h, 'basalCalories', from, to), perDay(h, 'flightsClimbed', from, to),
  ]);
  const hrDay = await perDay(h, 'heartRate', from, to, ['min', 'max', 'average']);
  const [rhr, hrv, spo2, resp, vo2, fat, weight, sleep] = await Promise.all([
    samples(h, 'restingHeartRate', from, to), samples(h, 'heartRateVariability', from, to), samples(h, 'oxygenSaturation', from, to),
    samples(h, 'respiratoryRate', from, to), samples(h, 'vo2Max', from, to), samples(h, 'bodyFat', from, to), samples(h, 'weight', from, to), samples(h, 'sleep', from, to, 1000),
  ]);
  const rhrD = meanBy(rhr); const hrvD = meanBy(hrv); const spo2D = meanBy(spo2, (s) => (s.value <= 1 ? s.value * 100 : s.value)); const respD = meanBy(resp);
  const vo2D = lastBy(vo2); const fatD = lastBy(fat.map((s) => ({ ...s, value: s.value <= 1 ? s.value * 100 : s.value })));
  const act = await tryRead(() => activeFromSteps(h, from, to)) || {};
  const dates = new Set([...Object.keys(act), ...Object.keys(steps), ...Object.keys(dist), ...Object.keys(active), ...Object.keys(total), ...Object.keys(hrDay), ...Object.keys(rhrD), ...Object.keys(hrvD), ...Object.keys(spo2D), ...Object.keys(respD), ...Object.keys(vo2D), ...Object.keys(fatD), ...Object.keys(floors), ...Object.keys(basal)]);
  const days = [...dates].sort().map((date) => ({
    date, steps: steps[date], distance_m: dist[date], kcal_active: active[date], kcal: total[date], kcal_basal: basal[date], floors: floors[date],
    active_min: Object.keys(steps).length && steps[date] !== undefined ? Math.round(act[date] || 0) : undefined,
    hr_min: hrDay[date]?.min, hr_max: hrDay[date]?.max, hr_avg: hrDay[date]?.average, rhr: rhrD[date], hrv: hrvD[date], spo2: spo2D[date], resp: respD[date], vo2max: vo2D[date], body_fat: fatD[date],
  }));
  const nights = sleep.filter((s) => Date.parse(s.endDate) - Date.parse(s.startDate) > 20 * 60_000).map((s) => ({
    startMs: Date.parse(s.startDate), endMs: Date.parse(s.endDate),
    stages: (s.stages || []).map((x) => ({ s: Date.parse(x.startDate), e: Date.parse(x.endDate), stage: x.stage })),
  }));
  const wk = await tryRead(() => h.queryWorkouts({ startDate: iso(from), endDate: iso(to), limit: 500, ascending: true }));
  const workouts = (wk?.workouts || []).map((w) => ({
    id: w.platformId || `${Date.parse(w.startDate)}`, type: w.workoutType, startMs: Date.parse(w.startDate), endMs: Date.parse(w.endDate),
    kcal: w.totalEnergyBurned ?? null, distanceM: w.totalDistance ?? null, source: w.sourceName || null,
  }));
  const weights = weight.map((s) => ({ t: Date.parse(s.startDate), kg: s.value }));
  // Which kinds Health Connect lets this app read: the page names the missing ones.
  const perm = await tryRead(() => h.checkAuthorization({ read: READ }));
  const body = { days, nights, workouts, weights, last, ...(perm ? { perms: { granted: perm.readAuthorized || [], denied: perm.readDenied || [] } } : {}) };
  if (hours) {
    // Heart rate by the hour and the newest pulse: the last three days.
    const hf = Math.max(from, midnight(to - 3 * DAY));
    const hr = await samples(h, 'heartRate', hf, to, 20000);
    const by = new Map();
    for (const s of hr) {
      const t = Date.parse(s.startDate); if (!Number.isFinite(s.value)) continue;
      const hs = Math.floor(t / HOUR) * HOUR; const d = ymd(t);
      const x = by.get(`${d}|${hs}`) || { date: d, start: hs, min: s.value, max: s.value, sum: 0, n: 0 };
      x.min = Math.min(x.min, s.value); x.max = Math.max(x.max, s.value); x.sum += s.value; x.n += 1;
      by.set(`${d}|${hs}`, x);
    }
    const perDate = new Map();
    for (const x of by.values()) { if (!perDate.has(x.date)) perDate.set(x.date, []); perDate.get(x.date).push({ start: x.start, min: x.min, max: x.max, avg: x.sum / x.n }); }
    body.hours = [...perDate.entries()].map(([date, hs]) => ({ date, hours: hs.sort((a, b) => a.start - b.start) }));
    const lastHr = hr.at(-1);
    if (lastHr) body.latest = { t: Date.parse(lastHr.startDate), bpm: lastHr.value };
  }
  return api.post('/api/hc/upload', body);
}

let running = null;
/**
 * Read what is new (and a month more of the history, until a year is in) and send it.
 * Resolves to the server's last result, or null when there was nothing to do.
 */
export function hcSync({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    if (!app.me?.hc?.connected) return null;
    const av = await hcAvailable();
    if (!av.ok) return null;
    const h = plugin();
    const s = state();
    const now = Date.now();
    if (!force && s.at && now - s.at < 10 * 60_000) return null;
    // New: from a little before the last read (the first time, the last month).
    const from = s.through ? midnight(s.through - 3 * DAY) : midnight(now - (CHUNK_DAYS - 1) * DAY);
    let r = await readWindow(h, from, now, { hours: true });
    const next = { ...state(), at: now, through: now, backTo: s.backTo || from };
    save(next);
    // Then the history, a month at a time, until a year is in (or Health Connect gives no more):
    // one month a pass, or all of it at once when asked (just connected, or Sync now).
    const floor = midnight(now - (next.history ? HISTORY_DAYS : 30) * DAY);
    for (let i = 0; i < (force ? 13 : 1); i += 1) {
      const bTo = state().backTo;
      if (!(bTo > floor)) break;
      const bFrom = Math.max(floor, midnight(bTo - CHUNK_DAYS * DAY));
      const rb = await tryRead(() => readWindow(h, bFrom, bTo, { last: true }));
      if (!rb) break;
      r = rb; save({ ...state(), backTo: bFrom });
    }
    emit('changed', ['data', 'workouts', 'me']);
    return r;
  })().finally(() => { running = null; });
  return running;
}

/** Health Connect's own settings, where its permissions are changed. */
export async function hcSettings() { const h = plugin(); if (h?.openHealthConnectSettings) await h.openHealthConnectSettings(); }

/** Ask again for what is not allowed yet (Health Connect shows only what is missing). */
export async function hcAskAgain() {
  const h = plugin();
  if (!h) return null;
  return h.requestAuthorization({ read: READ, requestHistoryAccess: true });
}

/** Let go of Samsung Health; `keepData` keeps what it brought. */
export async function hcDisconnect({ keepData = true } = {}) {
  const r = await api.post('/api/hc/disconnect', { keepData });
  try { localStorage.removeItem(key()); } catch { /* fine */ }
  return r;
}

/** Keep it fresh while the app is open: on opening, on coming back, and every quarter of an hour. */
export function hcAuto() {
  if (!platform.native || !platform.android) return;
  const go = () => { if (document.visibilityState === 'visible' && app.me?.hc?.connected) hcSync().catch(() => {}); };
  document.addEventListener('visibilitychange', go);
  setInterval(go, 15 * 60_000);
  setTimeout(go, 3000);
}
