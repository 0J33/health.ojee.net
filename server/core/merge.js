/* ============================================================
   health.ojee.net — several Google accounts, one person.

   The Google Health app takes one tracker per Google account, so a
   person with two (one worn at home, one at work) connects two
   accounts here. Each account is synced on its own, by its own Sync,
   into its own store (data/users/<id>/src/<account>.sqlite): exactly
   what one account alone would give, stand-ins and all. This file
   then folds those stores into the person's own store, the one every
   page reads, so nothing downstream has to know there are two.

   With one account the fold is a copy. With two or more it has to
   decide, per kind of number, what two devices mean together:

     activity totals   (steps, distance, floors, active energy, zone
                       minutes, …) two devices worn at different times
                       add up; worn at the same time they count the same
                       steps twice. `activity: 'auto'` asks Google for
                       both devices' quarter-hours on such a day and
                       keeps, in each quarter-hour, the larger of the
                       two: whatever the wearing, nothing counts twice
                       and nothing is lost (reconcile(), below). Until a
                       day has been asked, its totals are added up.
                       'sum', 'max' and 'primary' are the plain rules.
     minutes in levels sedentary / light / moderate / very active: added,
                       and never more than the 1440 minutes of a day.
     calories          every tracker counts the body's resting burn for
                       the whole day, worn or not, so a day's total is
                       ONE resting burn (the larger) plus the active
                       energy above.
     overnight         resting HR, HRV, SpO2, skin temperature, breathing
                       rate are measured asleep: they come from the
                       device that recorded the night (the longer sleep,
                       when both did), or from a chosen account.
     sleep             sessions from both; two that overlap by half or
                       more are one night seen twice, and the fuller one
                       is kept. A night split across the two (one device
                       taken off at 3 a.m., the other put on) adds up.
     workouts          the same: two that overlap by half or more are
                       one workout, unless `workouts: 'keep'`. A workout
                       this app saved is always the one kept.
     weigh-ins, other  one scale syncing to both accounts gives the same
     readings          reading twice: within a few minutes and the same
                       value, the main account's copy is kept.
     everything else   (VO2 max, heart-rate range, body fat, height) the
                       main account's number when it has one.

   The main ("primary") account is also the one this app writes to:
   workouts, weigh-ins and logged entries go there.

   Garmin, read directly (server/garminsync.js), is a source of its own
   (`extra`), put together with whatever the Google accounts make, by
   one rule the person picks (`first`):

     Garmin first      (the default) each day's number, for each kind
                       of number, is Garmin's when Garmin has one;
                       Google's fills what Garmin lacks
     Google first      the other way round: Garmin fills the gaps

   Nothing is added up across the two, so a step walked with the watch
   on and the phone in a pocket is counted once. Sessions (nights,
   workouts) and weigh-ins that are the same one seen twice are kept
   once, the first source's copy; ones only one side has are kept.
   Numbers only Garmin gives (stress, Body Battery) are Garmin's either
   way. Leaving Garmin out (disconnected without keeping its data)
   takes what only it brought with it.
   ============================================================ */

import { addDays, today as todayIn, localToMs } from './util.js';
import { parseRollup } from './parse.js';

/** Written by this app from the merged numbers, never merged themselves. */
export const DERIVED = new Set(['cardio_min', 'sleep_score']);

/** Totals that two devices worn at different times add up. */
export const ADD = new Set([
  'steps', 'distance_m', 'floors', 'altitude_m', 'kcal_active', 'active_min', 'swim_strokes',
  'azm', 'azm_fat', 'azm_cardio', 'azm_peak',
  'zone_light', 'zone_moderate', 'zone_vigorous', 'zone_peak',
  'zkcal_light', 'zkcal_moderate', 'zkcal_vigorous', 'zkcal_peak',
]);
const LEVELS = ['level_sedentary', 'level_light', 'level_moderate', 'level_very'];
const MINUTES = new Set([...LEVELS, 'sedentary_min']);
/** Measured asleep: taken from the device that recorded the night. */
const NIGHT = /^(rhr|hrv|spo2|temp|resp)(_|$)/;
/** Worked out here from the merged sleep sessions (see mergeSleep). */
const SLEEP_DAILY = ['sleep_min', 'sleep_period', 'sleep_awake', 'sleep_efficiency', 'sleep_deep', 'sleep_rem', 'sleep_light'];
const SLEEP_SET = new Set(SLEEP_DAILY);
const RANGE = { hr_min: Math.min, hr_max: Math.max };

export const MERGE_DEFAULTS = { activity: 'auto', overnight: 'auto', workouts: 'merge' };
export const ACTIVITY_MODES = ['auto', 'sum', 'max', 'primary'];
export const WORKOUT_MODES = ['merge', 'keep'];

/** Rules as stored, with anything unknown put back to its default. */
export function mergeRules(v = {}, accountIds = []) {
  const r = { ...MERGE_DEFAULTS };
  if (ACTIVITY_MODES.includes(v?.activity)) r.activity = v.activity;
  if (WORKOUT_MODES.includes(v?.workouts)) r.workouts = v.workouts;
  if (v?.overnight === 'auto' || accountIds.includes(v?.overnight)) r.overnight = v.overnight;
  return r;
}

const fin = Number.isFinite;
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** Two sessions are one when they share half of the shorter. */
const same = (a, b) => overlap(a.startMs, a.endMs, b.startMs, b.endMs) >= 0.5 * Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));

/* ── the fold ─────────────────────────────────────────────────────── */

/**
 * Fold the source stores into `main`.
 * @param {object} main               the person's store
 * @param {Array<{id, db}>} srcs      included accounts, the main one first
 * @param {object} o
 * @param {object} o.rules            mergeRules()
 * @param {Array<object>} o.gone      stores of accounts just removed or left out:
 *                                    what only they had is taken out of `main`
 * @param {Set<string>} o.own         Google names of workouts this app saved
 * @returns {number} rows written or removed
 */
export function mergeAll(main, srcs, { rules = MERGE_DEFAULTS, gone = [], own = new Set(), extra = [] } = {}) {
  let n = 0;
  // Every source with its place: `tier` orders the sessions and readings
  // two sources both have (0 Garmin first, 1 Google, 2 Garmin after Google).
  const tiered = [...srcs.map((x) => ({ ...x, tier: 1 })), ...extra.map((x) => ({ ...x, tier: x.first ? 0 : 2 }))];
  main.tx(() => {
    const sl = mergeSleep(main, tiered, gone);
    n += sl.n;
    n += mergeDaily(main, srcs, { rules, gone, nights: sl.nights, extra });
    n += mergeExercise(main, tiered, { rules, own });
    n += mergeWeights(main, tiered, gone);
    n += mergeSamples(main, tiered, gone);
    mergeMeta(main, tiered);
  });
  return n;
}

/** Order: the main account first, then the rest as listed. */
function pick(vals) { for (const v of vals) if (fin(v)) return v; return null; }

function mergeDaily(main, srcs, { rules, gone, nights, extra = [] }) {
  const tables = srcs.map((s) => s.db.dailyTable('0000-00-00'));
  const cur = main.dailyTable('0000-00-00');
  const recon = srcs.length > 1 && rules.activity === 'auto' ? main.metaPrefix('recon:') : {};
  const idx = Object.fromEntries(srcs.map((s, i) => [s.id, i]));
  const dates = new Set(tables.flatMap((t) => Object.keys(t)));
  const out = {};   // date -> metric -> value
  for (const date of dates) {
    const rows = tables.map((t) => t[date] || {});
    const metrics = new Set(rows.flatMap((r) => Object.keys(r)));
    const m = {};
    const have = (k) => rows.map((r) => r[k]).filter(fin);
    for (const k of metrics) {
      if (DERIVED.has(k) || SLEEP_SET.has(k)) continue;
      const vals = rows.map((r) => r[k]);
      const got = vals.filter(fin);
      if (!got.length) continue;
      // One device has it: that is the number, whatever the rule.
      if (got.length === 1) { m[k] = got[0]; continue; }
      if (ADD.has(k) || MINUTES.has(k)) m[k] = combine(k, vals, rules.activity, recon[`recon:${date}`]);
      else if (RANGE[k]) m[k] = RANGE[k](...got);
      else if (NIGHT.test(k)) {
        const lead = rules.overnight !== 'auto' && fin(vals[idx[rules.overnight]]) ? idx[rules.overnight] : idx[nights[date]];
        m[k] = lead !== undefined && fin(vals[lead]) ? vals[lead] : pick(vals);
      } else if (k === 'kcal' || k === 'kcal_basal') continue;   // below, once the active part is known
      else m[k] = pick(vals);
    }
    // A day's calories: one resting burn, plus the active energy of both.
    const basal = have('kcal_basal');
    const kcal = have('kcal');
    if (kcal.length === 1) m.kcal = kcal[0];
    if (basal.length === 1) m.kcal_basal = basal[0];
    if (kcal.length > 1 || basal.length > 1) {
      if (basal.length) m.kcal_basal = rules.activity === 'primary' ? pick(rows.map((r) => r.kcal_basal)) : Math.max(...basal);
      // Every device with a total also gave its active part: rebuild the total from the two halves.
      const split = rows.every((r) => !fin(r.kcal) || fin(r.kcal_active));
      if (kcal.length > 1) {
        m.kcal = rules.activity === 'primary' ? pick(rows.map((r) => r.kcal))
          : rules.activity === 'max' || !split || !fin(m.kcal_basal) || !fin(m.kcal_active) ? Math.max(...kcal)
            : Math.round(m.kcal_basal + m.kcal_active);
      }
    }
    // Never more minutes in the levels than a day has.
    const lv = LEVELS.filter((k) => fin(m[k]));
    if (lv.length && srcs.length > 1) {
      const total = lv.reduce((a, k) => a + m[k], 0);
      if (total > 1440 && fin(m.level_sedentary)) m.level_sedentary = Math.max(0, m.level_sedentary - (total - 1440));
    }
    if (fin(m.sedentary_min) && srcs.length > 1) {
      const moving = ['level_light', 'level_moderate', 'level_very'].reduce((a, k) => a + (fin(m[k]) ? m[k] : 0), 0);
      m.sedentary_min = Math.min(m.sedentary_min, Math.max(0, 1440 - moving));
    }
    out[date] = m;
  }
  // A source of its own (Garmin): its number first, or only where the
  // Google accounts have none, kind of number by kind of number.
  for (const x of extra) {
    for (const [date, row] of Object.entries(x.db.dailyTable('0000-00-00'))) {
      const m = (out[date] ||= {});
      for (const [k, v] of Object.entries(row)) {
        if (DERIVED.has(k) || SLEEP_SET.has(k) || !fin(v)) continue;
        if (x.first || !fin(m[k])) m[k] = v;
      }
    }
  }
  let n = 0;
  for (const [date, m] of Object.entries(out)) {
    for (const [k, v] of Object.entries(m)) {
      if (cur[date]?.[k] === v) continue;
      main.setDaily(date, k, v);
      n += 1;
    }
  }
  // What only a removed account had goes with it.
  for (const g of gone) {
    const t = g.dailyTable('0000-00-00');
    for (const [date, row] of Object.entries(t)) {
      for (const k of Object.keys(row)) {
        if (DERIVED.has(k) || SLEEP_SET.has(k) || out[date]?.[k] !== undefined) continue;
        if (cur[date]?.[k] !== undefined) { main.deleteDaily(date, k); n += 1; }
      }
    }
  }
  return n;
}

/** Two or more devices' values of one activity total on one day. */
function combine(k, vals, mode, rec) {
  const got = vals.filter(fin);
  const sum = got.reduce((a, b) => a + b, 0);
  const max = Math.max(...got);
  let v;
  if (mode === 'max') v = max;
  else if (mode === 'primary') v = pick(vals);
  else if (mode === 'auto' && rec && fin(rec.sum?.[k]) && fin(rec.val?.[k])) {
    // What the quarter-hours showed was counted twice, taken off today's sum.
    // A total that grew since is still added; it is never below one device.
    v = Math.max(max, sum - Math.max(0, rec.sum[k] - rec.val[k]));
  } else v = sum;
  return k === 'steps' || k === 'floors' || k === 'swim_strokes' ? Math.round(v) : Math.round(v * 1000) / 1000;
}

/* ── sessions ─────────────────────────────────────────────────────── */

function mergeSleep(main, srcs, gone = []) {
  const all = srcs.flatMap((s, rank) => s.db.sleeps('0000-00-00').map((x) => ({ ...x, src: s.id, rank, tier: s.tier ?? 1 })));
  // Only a row some account had (or a removed one had) is this fold's to take away.
  const known = new Set([...all.map((x) => x.id), ...gone.flatMap((g) => g.sleeps('0000-00-00').map((x) => x.id))]);
  // The first source's first, then the fullest, the main account's first among equals.
  all.sort((a, b) => a.tier - b.tier || (b.asleepMin || 0) - (a.asleepMin || 0) || a.rank - b.rank || a.startMs - b.startMs);
  const kept = [];
  for (const x of all) if (!kept.some((k) => k.src !== x.src && same(k, x))) kept.push(x);
  let n = 0;
  const before = main.sleeps('0000-00-00');
  const keepIds = new Set(kept.map((k) => k.id));
  for (const s of before) if (!keepIds.has(s.id) && known.has(s.id)) { main.deleteSleep(s.id); n += 1; }
  const was = new Map(before.map((s) => [s.id, JSON.stringify(s)]));
  for (const k of kept) {
    const { src, rank, tier, ...row } = k;
    if (was.get(row.id) === JSON.stringify(row)) continue;
    main.upsertSleep(row);
    n += 1;
  }
  // The night's numbers: the fullest main session, plus any from another
  // device that does not overlap it (a night split across the two).
  const byDate = {};
  for (const k of kept.filter((x) => x.main)) (byDate[k.date] ||= []).push(k);
  const nights = {};
  const cur = main.dailyTable('0000-00-00');
  for (const [date, list] of Object.entries(byDate)) {
    const chosen = [list[0]];
    for (const x of list.slice(1)) if (!chosen.some((c) => c.src === x.src || overlap(c.startMs, c.endMs, x.startMs, x.endMs) > 0)) chosen.push(x);
    nights[date] = chosen[0].src;
    const m = {};
    const sumOf = (f) => chosen.reduce((a, c) => a + (fin(f(c)) ? f(c) : 0), 0);
    m.sleep_min = sumOf((c) => c.asleepMin);
    m.sleep_period = sumOf((c) => c.periodMin);
    m.sleep_awake = sumOf((c) => c.awakeMin);
    if (m.sleep_period > 0) m.sleep_efficiency = Math.round((m.sleep_min / m.sleep_period) * 1000) / 10;
    for (const [stage, key] of [['DEEP', 'sleep_deep'], ['REM', 'sleep_rem'], ['LIGHT', 'sleep_light']]) {
      const has = chosen.filter((c) => c.summary?.stages?.[stage] !== undefined);
      if (has.length) m[key] = has.reduce((a, c) => a + c.summary.stages[stage], 0);
    }
    for (const [k, v] of Object.entries(m)) if (cur[date]?.[k] !== v) { main.setDaily(date, k, v); n += 1; }
  }
  // A night that is no longer there (its account removed) takes its numbers along.
  for (const s of before) {
    if (byDate[s.date] || !s.main || keepIds.has(s.id) || !known.has(s.id)) continue;
    for (const k of SLEEP_DAILY) if (cur[s.date]?.[k] !== undefined) { main.deleteDaily(s.date, k); n += 1; }
  }
  return { n, nights };
}

/** How much a workout record says: heart rate, calories, movement. */
const fullness = (e) => (fin(e.avgHr) ? 4 : 0) + (fin(e.kcal) ? 2 : 0) + (fin(e.steps) || fin(e.distanceM) ? 1 : 0) + (e.zones ? 1 : 0);
const tail = (id) => String(id).split('/').pop();

function mergeExercise(main, srcs, { rules, own }) {
  const ownTails = new Set([...own].map(tail));
  const all = srcs.flatMap((s, rank) => s.db.exercises('0000-00-00').map((x) => ({ ...x, src: s.id, rank, tier: s.tier ?? 1, own: ownTails.has(tail(x.id)) })));
  all.sort((a, b) => (b.own - a.own) || a.tier - b.tier || fullness(b) - fullness(a) || (b.endMs - b.startMs) - (a.endMs - a.startMs) || a.rank - b.rank);
  const kept = [];
  for (const x of all) {
    if (rules.workouts !== 'keep' && kept.some((k) => k.src !== x.src && same(k, x))) continue;
    kept.push(x);
  }
  let n = 0;
  const before = main.exercises('0000-00-00');
  const keepIds = new Set(kept.map((k) => k.id));
  for (const e of before) if (!keepIds.has(e.id)) { main.deleteExercise(e.id); n += 1; }
  const was = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
  for (const k of kept) {
    const { src, rank, tier, own: o, ...row } = k;
    if (was.get(row.id) === JSON.stringify(row)) continue;
    main.upsertExercise(row);
    n += 1;
  }
  return n;
}

/* ── readings ─────────────────────────────────────────────────────── */

const NEAR_MS = 10 * 60_000;

/** Weigh-ins a source's sync read: Google's, or Garmin's. */
const READ = new Set(['google', 'garmin', 'hc']);
function mergeWeights(main, srcs, gone = []) {
  const all = srcs.flatMap((s, rank) => s.db.weights(0).filter((w) => READ.has(w.source)).map((w) => ({ ...w, rank: (s.tier ?? 1) * 100 + rank })));
  const known = new Set([...all.map((w) => w.t), ...gone.flatMap((g) => g.weights(0).map((w) => w.t))]);
  all.sort((a, b) => a.rank - b.rank || a.t - b.t);
  const kept = [];
  for (const w of all) if (!kept.some((k) => k.rank !== w.rank && Math.abs(k.t - w.t) <= NEAR_MS && Math.abs(k.grams - w.grams) <= 200)) kept.push(w);
  let n = 0;
  const before = main.weights(0);
  const at = new Map(before.map((w) => [w.t, w]));
  const keepT = new Set(kept.map((w) => w.t));
  for (const w of before) if (READ.has(w.source) && !keepT.has(w.t) && known.has(w.t)) { main.deleteWeight(w.t); n += 1; }
  for (const w of kept) {
    const c = at.get(w.t);
    if (c && c.grams === w.grams && c.off === w.off) continue;
    main.upsertWeight({ t: w.t, grams: w.grams, off: w.off, source: c?.source || w.source || 'google', note: w.note });
    n += 1;
  }
  return n;
}

/** Readings and logs read from Google (an ECG, a glucose value, a glass of
    water read back). A row this app wrote stays this app's: Google's copy
    only confirms it (Store.sampleUpsert). */
function mergeSamples(main, srcs, gone = []) {
  const all = srcs.flatMap((s, rank) => s.db.samplesAll().filter((r) => r.source !== 'app').map((r) => ({ ...r, rank: (s.tier ?? 1) * 100 + rank })));
  const keyOf = (r) => [r.gname ? `n:${r.gname}` : null, `t:${r.kind}:${r.t}`];
  const known = new Set([...all, ...gone.flatMap((g) => g.samplesAll())].flatMap(keyOf).filter(Boolean));
  all.sort((a, b) => a.rank - b.rank || a.t - b.t);
  const kept = [];
  const byKind = {};
  for (const r of all) {
    const list = (byKind[r.kind] ||= []);
    if (list.some((k) => k.rank !== r.rank && Math.abs(k.t - r.t) <= 120_000 && (k.value === r.value || (fin(k.value) && fin(r.value) && Math.abs(k.value - r.value) < 1e-6)))) continue;
    list.push(r);
    kept.push(r);
  }
  let n = 0;
  const keys = new Set();
  for (const r of kept) { if (r.gname) keys.add(`n:${r.gname}`); keys.add(`t:${r.kind}:${r.t}`); }
  const before = main.samplesAll().filter((r) => r.source !== 'app');
  for (const r of before) {
    if ((r.gname && keys.has(`n:${r.gname}`)) || keys.has(`t:${r.kind}:${r.t}`)) continue;
    if (!keyOf(r).some((k) => k && known.has(k))) continue;   // never any account's: not this fold's
    main.sampleDrop(r.id); n += 1;
  }
  const seen = new Map(before.map((r) => [r.gname || `${r.kind}:${r.t}`, r]));
  for (const r of kept) {
    const c = seen.get(r.gname || `${r.kind}:${r.t}`);
    if (c && c.t === r.t && c.value === r.value && c.end === r.end && JSON.stringify(c.data) === JSON.stringify(r.data) && c.device === r.device) continue;
    const { rank, id, gstate, updated, deleted, ...row } = r;
    main.sampleUpsert(row, r.updated || Date.now());
    n += 1;
  }
  return n;
}

/** The last readings each account keeps aside: devices, heart rate now, zones. */
function mergeMeta(main, srcs) {
  const devices = srcs.map((s) => ({ s, d: s.db.meta('device') })).filter((x) => x.d).map((x) => ({ ...x.d, account: x.s.id, accountLabel: x.s.label || null }));
  // The one shown alone: the tracker that reached its phone last.
  const latest = [...devices].sort((a, b) => (b.lastSync || 0) - (a.lastSync || 0))[0] || null;
  const put = (k, v) => { if (JSON.stringify(main.meta(k)) !== JSON.stringify(v)) { if (v === null) main.delMeta(k); else main.setMeta(k, v); } };
  // Several Google accounts, or Google and Garmin each with a device.
  const many = srcs.filter((s) => s.tier === 1).length > 1 || devices.length > 1;
  if (many) put('devices', devices); else put('devices', null);
  if (latest || srcs.length) {
    const { account, accountLabel, ...one } = latest || {};
    put('device', latest ? (many ? latest : one) : null);
  }
  const newest = (k) => srcs.map((s) => s.db.meta(k)).filter((v) => v && fin(v.t)).sort((a, b) => b.t - a.t)[0] || null;
  const hr = newest('hr'); if (hr) put('hr', hr);
  const dense = newest('hrDense'); if (dense) put('hrDense', dense);
  for (const k of ['hrZones', 'vo2']) { const v = srcs.map((s) => s.db.meta(k)).find(Boolean); if (v) put(k, v); }
}

/* ── an existing person's first source ───────────────────────────── */

/** What a copy of a person's own store keeps when it becomes their first
    account's source: only what that account's sync wrote. */
const SOURCE_META = ['schema', 'sync', 'device', 'hr', 'hrDense', 'hrZones', 'vo2'];
export function cleanSourceCopy(db) {
  db.tx(() => {
    db.db.prepare(`DELETE FROM daily WHERE metric IN (${[...DERIVED].map(() => '?').join(', ')})`).run(...DERIVED);
    db.db.exec(`DELETE FROM sample WHERE source = 'app';
      DELETE FROM weight WHERE source <> 'google';
      DELETE FROM workout; DELETE FROM wset; DELETE FROM strength; DELETE FROM hevy_seen; DELETE FROM routine; DELETE FROM track;`);
    db.db.prepare(`DELETE FROM meta WHERE key NOT IN (${SOURCE_META.map(() => '?').join(', ')})`).run(...SOURCE_META);
  });
}

/* ── quarter-hours: what two devices counted twice ───────────────── */

/** The activity types read quarter-hour by quarter-hour on a day two
    devices both recorded. */
export const RECON_TYPES = ['steps', 'distance', 'floors', 'active-energy-burned', 'active-zone-minutes', 'active-minutes', 'time-in-heart-rate-zone', 'calories-in-heart-rate-zone'];
const RECON_DAYS = 90;
const STOP = new Set(['needs_auth', 'rate_limited', 'network', 'unconfigured']);

/** A roll-up window's metrics, by the same reading as a day's. */
function windowMetrics(type, p) {
  return parseRollup(type, [{ ...p, civilStartTime: { date: { year: 2000, month: 1, day: 1 } } }])[0]?.metrics || {};
}

const dayAdd = (row) => Object.fromEntries([...ADD].filter((k) => fin(row?.[k])).map((k) => [k, row[k]]));
const busy = (row) => Object.values(dayAdd(row)).some((v) => v > 0);

/**
 * For days two or more devices both have activity on, read each device's
 * quarter-hours and keep, in each, the larger: the day's totals with
 * nothing counted twice. Kept in `main` as meta `recon:<date>` =
 * { fp, at, sum, val }: the plain sum of the daily totals at the time,
 * and the reconciled value, so the overlap can be taken off later sums.
 * A day is asked again when its totals change (today: at most hourly).
 * @param {object} o
 * @param {object} o.main
 * @param {Array<{id, db, google}>} o.accounts   included and connected
 * @returns {Promise<number>} days read
 */
export async function reconcile({ main, accounts, tz, now = Date.now(), budget = 3, gapMs = 0, log = () => {} }) {
  const today = todayIn(now, tz);
  const floor = addDays(today, -(RECON_DAYS - 1));
  // Old marks go; nothing else to do with fewer than two devices.
  for (const k of Object.keys(main.metaPrefix('recon:'))) if (k.slice(6) < floor) main.delMeta(k);
  if (accounts.length < 2) return 0;
  const tables = accounts.map((a) => a.db.dailyTable(floor));
  const dates = [...new Set(tables.flatMap((t) => Object.keys(t)))].filter((d) => d <= today && tables.filter((t) => busy(t[d])).length >= 2).sort().reverse();
  let done = 0;
  for (const date of dates) {
    if (done >= budget) break;
    const fp = JSON.stringify(tables.map((t) => dayAdd(t[date])));
    const rec = main.meta(`recon:${date}`);
    if (rec && (rec.fp === fp || now - rec.at < (date === today ? 3_600_000 : 15 * 60_000))) continue;
    const from = localToMs(date, 0, tz);
    const to = Math.min(localToMs(addDays(date, 1), 0, tz), now);
    if (to - from < 15 * 60_000) continue;
    const cells = new Map();   // window start -> { metric: the larger }
    const read = new Set();    // metrics whose type every device answered
    for (const type of RECON_TYPES) {
      const per = [];
      try {
        for (const a of accounts) {
          per.push(await a.google.rollUp(type, from, to, 900));
          if (gapMs) await new Promise((r) => { setTimeout(r, gapMs).unref?.(); });
        }
      } catch (e) {
        if (STOP.has(e.code)) { log(`reconcile ${date}: ${e.message}`); return done; }
        continue;   // a type this account will not give in windows: its days stay added up
      }
      const metrics = new Set();
      for (const pts of per) {
        for (const p of pts) {
          const start = Date.parse(p.startTime);
          if (!fin(start)) continue;
          const m = windowMetrics(type, p);
          const cell = cells.get(start) || {};
          for (const [k, v] of Object.entries(m)) { if (!fin(v)) continue; metrics.add(k); cell[k] = Math.max(cell[k] ?? 0, v); }
          cells.set(start, cell);
        }
      }
      for (const k of metrics) if (ADD.has(k)) read.add(k);
    }
    const val = {};
    for (const k of read) val[k] = [...cells.values()].reduce((a, c) => a + (fin(c[k]) ? c[k] : 0), 0);
    const sum = {};
    for (const k of read) {
      const got = tables.map((t) => t[date]?.[k]).filter(fin);
      if (got.length >= 2) sum[k] = got.reduce((a, b) => a + b, 0); else delete val[k];
    }
    main.setMeta(`recon:${date}`, { fp, at: now, sum, val });
    done += 1;
  }
  return done;
}
