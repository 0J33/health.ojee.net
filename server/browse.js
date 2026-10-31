/* ============================================================
   health.ojee.net — Browse and the metric page: every metric of the
   catalogue (catalog.js), read from ONE person's own world.

   Three payloads come from here:

     browseView    what the person has, by category, each with its
                   latest value and a small trend; and what they do
                   not have, with who or what would provide it
     metricView    one metric over a day, a week, a month, six months
                   or a year: the chart's points, what the period
                   amounts to, the period before, the person's own
                   usual range, a goal where there is one, one plain
                   line that reads it, the entries behind it, and the
                   form to add one where it can be logged
     briefExtra    what Today gains: cardio minutes, last night's
                   score, energy, floors, vitals, the recovery trend,
                   water and food, and the pinned metrics

   Everything is built the same way: a metric becomes a series of one
   point per civil day (`daySeries`), and days become weeks or months
   by the metric's own rule (things that add up are summed, states
   are averaged, ranges keep their lowest and highest).

   Privacy is structural here too. A metric of an optional group does
   not exist for a person whose group is off: not in Browse, not in a
   pin, and its page answers 409. Nothing in this file writes to the
   public tables or reads anybody else's world.

   The app's own numbers (core/derived.js) are stored by storeDerived
   after each sync, and once over the whole history for a database
   that predates them.
   ============================================================ */

import { addDays, today as todayIn, weekOf, monthOf, round, localToMs, stats as meanSd } from './core/util.js';
import { SCOPES, groupById } from './core/google.js';
import { KINDS, ENUMS, MEASURES, fieldsOf, target } from './core/entries.js';
import { readyX, readinessOf, resilX, resilienceOf, sleepScoreEstimate } from './core/scores.js';
import { sleepScore, usualTimes, cardioDay, cardioWeek, recovery, caloriesDay, caloriesWeek, bmi } from './core/derived.js';
import { METRICS, CATEGORIES, FORMS, RANGES, MAX_PINS, metricById, metricOfKind, valueText, duration, dailyKeysOf } from './catalog.js';
import { unified, workoutView, mirrorView } from './history.js';
import { compText, xiaomiMeta } from './xiaomisync.js';
import { analyse, ageAt, FIELDS as COMP_FIELDS, NOTE as COMP_NOTE, SEXES } from './core/bodycomp.js';
import { rangeFor, rangeNeeds } from './core/ranges.js';

const DAY = 86_400_000;
const fin = Number.isFinite;
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const bad = (message, status = 400, code = 'bad_request', detail = undefined) => Object.assign(new Error(message), { status, code, detail, expose: true });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && addDays(s, 0) === s;
const utc = (date) => Date.parse(`${date}T00:00:00Z`);
const quantile = (values, q) => {
  const v = values.filter(fin).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
};
const clock = (t, off) => { const x = new Date(t + (off || 0) * 1000); return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`; };
const nfmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const word = (name, id) => ENUMS[name].find((x) => x.id === id)?.label || String(id || '').toLowerCase().replace(/_/g, ' ');

/* ── the app's own numbers, stored ────────────────────────────────── */

/** Bump when a formula in core/derived.js changes: every database is
    then recalculated over its whole history, once. */
export const DERIVED_VERSION = 4;
const DERIVED_RECENT = 21;

/**
 * Write `cardio_min` per day and `sleep_score` per night into `daily`.
 * After a sync only the recent days are redone (a late-arriving night
 * changes the "usual" of the nights after it); the whole history is done
 * once for a database that has never had them, and again when the
 * formulas or the person's sleep goal change. Idempotent: a value that is
 * already right is not written.
 * @returns {number} how many values were written or removed
 */
export function storeDerived(world, { full = false } = {}) {
  const db = world.db;
  const today = todayIn(world.now(), world.tz);
  const goalMin = world.settings().sleepTarget;
  const mark = db.meta('derived');
  const all = full || !mark || mark.v !== DERIVED_VERSION || mark.sleepGoal !== goalMin;
  const from = all ? '0000-00-00' : addDays(today, -DERIVED_RECENT);
  const table = db.dailyTable(from);
  const nights = db.sleeps(all ? '0000-00-00' : addDays(from, -20)).filter((n) => n.main);
  // The main night of a date is its longest, as the sync has it.
  const byDate = {};
  for (const n of nights) if (n.date >= from && (!byDate[n.date] || n.asleepMin > byDate[n.date].asleepMin)) byDate[n.date] = n;
  let wrote = 0;
  db.tx(() => {
    for (const [date, r] of Object.entries(table)) {
      const c = cardioDay(r);
      if (c && r.cardio_min !== c.minutes) { db.setDaily(date, 'cardio_min', c.minutes); wrote += 1; }
      if (!c && fin(r.cardio_min)) { db.deleteDaily(date, 'cardio_min'); wrote += 1; }
      r.cardio_min = c ? c.minutes : undefined;   // what the scores below read
    }
    // A score whose night is gone (its source left with its data) goes too.
    for (const [date, r] of Object.entries(table)) if (fin(r.sleep_score) && !byDate[date]) { db.deleteDaily(date, 'sleep_score'); r.sleep_score = undefined; wrote += 1; }
    for (const [date, n] of Object.entries(byDate)) {
      const s = sleepScore(n, { goalMin }).score;
      if (s !== null && table[date]?.sleep_score !== s) { db.setDaily(date, 'sleep_score', s); wrote += 1; }
      if (s === null && fin(table[date]?.sleep_score)) { db.deleteDaily(date, 'sleep_score'); wrote += 1; }
      if (table[date]) table[date].sleep_score = s;
    }
    // Readiness and resilience, made to match Google's (core/scores.js), from the sleep scores above.
    const full1 = all ? table : { ...db.dailyTable(addDays(from, -40)), ...table };
    for (const date of Object.keys(table)) {
      const rd = readinessOf(readyX(full1, date, addDays));
      const rs = resilienceOf(resilX(full1, date, addDays, { goalMin }));
      for (const [k, v] of [['readiness', rd], ['resilience', rs]]) {
        if (v !== null && table[date]?.[k] !== v) { db.setDaily(date, k, v); wrote += 1; }
        if (v === null && fin(table[date]?.[k])) { db.deleteDaily(date, k); wrote += 1; }
      }
    }
  });
  if (all || !mark) db.setMeta('derived', { v: DERIVED_VERSION, at: world.now(), sleepGoal: goalMin });
  return wrote;
}
/** The one-off backfill, for a reader that arrives before any sync has. */
export function ensureDerived(world) {
  const mark = world.db.meta('derived');
  if (!mark || mark.v !== DERIVED_VERSION || mark.sleepGoal !== world.settings().sleepTarget) storeDerived(world);
}

/* ── one person, one request ──────────────────────────────────────── */

function context(world) {
  const now = world.now();
  const s = world.settings();
  let whole = null;
  const tables = new Map();
  return {
    world, db: world.db, tz: world.tz, now, today: todayIn(now, world.tz),
    groups: world.groups(), pins: world.pins(),
    goals: { steps: s.stepTarget, active: s.azmTarget, sleep: s.sleepTarget, cardio: s.cardioTarget, water: s.waterTarget },
    stats: world.db.sampleStats(),
    device: world.db.meta('device')?.name || null,
    // Numbers that come from Garmin alone (no Google account is read).
    garminOnly: !world.anyConnected() && world.garminIn(),
    /** The daily table from a date on; the whole of it once that was asked. */
    table(from) {
      if (whole) return whole;
      if (from <= '0001') { whole = world.db.dailyTable('0000-00-00'); return whole; }
      if (!tables.has(from)) tables.set(from, world.db.dailyTable(from));
      return tables.get(from);
    },
    heightMm() { return world.db.latest('height_mm')?.value ?? world.db.sampleLatest('height')?.value ?? null; },
    /** Every weigh-in of the scale worked out (core/bodycomp.js), newest first, once a request. */
    comp() {
      if (!this._comp) {
        const p = bodyPerson(world, this.heightMm());
        this._comp = world.db.samples('bodycomp', { limit: 1000 }).filter((r) => !r.deleted && fin(r.data?.weightKg)).map((r) => {
          const x = analyse(r.data, { sex: p.sex, age: ageAt(p.birthYear, r.t), heightCm: p.heightCm });
          return { r, x, values: { ...x.values, score: x.score?.value ?? null } };
        });
      }
      return this._comp;
    },
  };
}

/* ── the person, for body ranges ──────────────────────────────────── */

/**
 * Sex, year of birth and height, for the standard ranges of a body
 * composition scale. Set by the person in Me, Account (world meta
 * `body`; never published, never in a public table); what the scale's
 * record said about them fills in what they have not set, and the height
 * is their latest one (else the scale's).
 */
export function bodyPerson(world, heightMm = undefined) {
  const own = world.db.meta('body', null) || {};
  const m = xiaomiMeta(world.db);
  const scale = (m.profile && m.profiles?.[m.profile]?.person) || null;
  const mm = heightMm === undefined ? (world.db.latest('height_mm')?.value ?? world.db.sampleLatest('height')?.value ?? null) : heightMm;
  const sex = SEXES.includes(own.sex) ? own.sex : SEXES.includes(scale?.sex) ? scale.sex : null;
  const birthYear = fin(own.birthYear) ? own.birthYear : fin(scale?.birthYear) ? scale.birthYear : null;
  const heightCm = fin(mm) ? round(mm / 10, 1) : fin(scale?.heightCm) ? scale.heightCm : null;
  return {
    sex, birthYear, heightCm,
    from: { sex: SEXES.includes(own.sex) ? 'you' : sex ? 'scale' : null, birthYear: fin(own.birthYear) ? 'you' : birthYear ? 'scale' : null, height: fin(mm) ? 'you' : heightCm ? 'scale' : null },
    own: { sex: SEXES.includes(own.sex) ? own.sex : null, birthYear: fin(own.birthYear) ? own.birthYear : null },
    scale,
  };
}

const groupOn = (c, m) => !m.group || c.groups[m.group] === true;
/** Metrics only a Garmin watch, read directly, gives. */
const GARMIN_ONLY = new Set(['stress', 'body_battery']);
/** Where a day's number of a metric came from, for its row. */
const daySource = (c, m) => (m.own ? 'calculated' : GARMIN_ONLY.has(m.id) || c.garminOnly ? 'garmin' : 'google');

/* ── a metric as one point per civil day ──────────────────────────── */

const localDate = (t, off) => new Date(t + (off || 0) * 1000).toISOString().slice(0, 10);

/** A point of a row of the daily table, or null. */
function dailyPoint(m, r) {
  if (!r) return null;
  const s = m.source;
  if (s.type === 'daily') {
    const raw = s.keys.map((k) => r[k]).find(fin);
    if (!fin(raw)) return null;
    const p = { value: raw * (s.scale || 1) };
    if (s.parts && s.parts.some((x) => fin(r[x.daily]))) p.parts = Object.fromEntries(s.parts.map((x) => [x.key, fin(r[x.daily]) ? r[x.daily] : null]));
    return p;
  }
  if (s.type === 'range') {
    const lo = fin(r[s.lo]) ? r[s.lo] : null; const hi = fin(r[s.hi]) ? r[s.hi] : null;
    const value = fin(r[s.value]) ? r[s.value] : (lo !== null && hi !== null ? (lo + hi) / 2 : null);
    return value === null ? null : { value, lo: lo ?? value, hi: hi ?? value };
  }
  if (s.type === 'stack') {
    if (!s.parts.some((x) => fin(r[x.daily]) && (!s.need || s.need.includes(x.key)))) return null;
    const parts = Object.fromEntries(s.parts.map((x) => [x.key, fin(r[x.daily]) ? r[x.daily] : null]));
    return { value: Object.values(parts).reduce((a, v) => a + (v || 0), 0), parts };
  }
  return null;
}

/**
 * One metric from `from` to `to` (civil dates, inclusive):
 * Map(date -> { value, lo?, hi?, parts?, n? }). `n` is how many entries
 * the day holds, for the kinds made of entries. A day with nothing is
 * simply not in the map.
 */
function daySeries(c, m, from, to) {
  const out = new Map();
  const s = m.source;
  const put = (date, p) => { if (p && date >= from && date <= to && (fin(p.value) || p.n > 0)) out.set(date, p); };
  if (s.type === 'daily' || s.type === 'range' || s.type === 'stack') {
    const table = c.table(from);
    for (const date of Object.keys(table)) put(date, dailyPoint(m, table[date]));
  } else if (s.type === 'recovery') {
    const start = from <= '0001' ? (c.db.firstDate() || c.today) : from;
    const table = c.table(addDays(start, -40));
    for (let date = start; date <= to; date = addDays(date, 1)) { const r = recovery({ table, today: date }); if (r.available) put(date, { value: r.z }); }
  } else if (s.type === 'sample') {
    for (const r of c.db.sampleDays(s.kind, from, to, (s.parts || []).map((x) => x.key))) {
      const p = { n: r.n, value: s.day === 'sum' ? r.sum : s.day === 'count' ? r.n : r.avg };
      if (s.day === 'range' && fin(r.min)) { p.lo = r.min; p.hi = r.max; }
      if (s.parts && s.parts.some((x) => fin(r[x.key]))) p.parts = Object.fromEntries(s.parts.map((x) => [x.key, fin(r[x.key]) ? r[x.key] : null]));
      put(r.date, p);
    }
  } else if (s.type === 'comp') {
    // One field of each weigh-in: a day's value is its last weigh-in's.
    for (const { r, values } of c.comp()) {
      if (!fin(values[s.field]) || out.has(r.date)) continue;
      put(r.date, { value: values[s.field], n: 1 });
    }
  } else if (s.type === 'period') {
    // A period is days: every day inside one counts, the first carries the entry.
    const lo = from <= '0001' ? 0 : utc(from) - 40 * DAY;
    for (const r of c.db.samples('period', { fromMs: lo, toMs: utc(to) + 2 * DAY, limit: 1000 })) {
      const a = r.data.start || r.date; const b = r.data.end || a;
      for (let date = a, i = 0; date <= b && i < 40; date = addDays(date, 1), i += 1) put(date, { value: 1, n: (out.get(date)?.n || 0) + (date === a ? 1 : 0) });
    }
  } else if (s.type === 'weight' || s.type === 'bmi') {
    const h = s.type === 'bmi' ? c.heightMm() : null;
    if (s.type === 'bmi' && !fin(h)) return out;
    const by = {};
    for (const w of c.db.weights(from <= '0001' ? 0 : utc(from) - DAY)) (by[localDate(w.t, w.off)] ||= []).push(w.grams / 1000);
    for (const [date, v] of Object.entries(by)) {
      const last = v[v.length - 1];
      put(date, s.type === 'bmi' ? { value: bmi(last, h) } : { value: last, lo: Math.min(...v), hi: Math.max(...v), n: v.length });
    }
  } else if (s.type === 'workouts') {
    for (const x of unified(c.db, from <= '0001' ? 0 : utc(from) - DAY)) {
      const date = todayIn(x.start, c.tz);
      const cur = out.get(date) || { value: 0, n: 0 };
      put(date, { value: cur.value + Math.round((x.end - x.start) / 60_000), n: cur.n + 1 });
    }
  }
  return out;
}

/** Does this person have anything for a metric (whatever the group says). */
function hasData(c, m) {
  const s = m.source;
  const any = (keys) => keys.some((k) => !!c.db.latest(k));
  if (s.type === 'daily') return any(s.keys) || (!!m.logs && (c.stats[m.logs]?.n || 0) > 0);
  if (s.type === 'range') return any([s.value, s.lo]);
  if (s.type === 'stack') return any(s.parts.filter((x) => !s.need || s.need.includes(x.key)).map((x) => x.daily));
  if (s.type === 'sample') return (c.stats[s.kind]?.n || 0) > 0;
  if (s.type === 'period') return (c.stats.period?.n || 0) > 0;
  if (s.type === 'comp') return (c.stats.bodycomp?.n || 0) > 0 && c.comp().some((x) => fin(x.values[s.field]));
  if (s.type === 'weight') return !!c.db.lastWeightMs();
  if (s.type === 'bmi') return !!c.db.lastWeightMs() && fin(c.heightMm());
  if (s.type === 'workouts') return !!c.db.lastExerciseDate() || c.db.workoutsDone(Number.MAX_SAFE_INTEGER, 1).length > 0;
  if (s.type === 'recovery') return daySeries(c, m, addDays(c.today, -13), c.today).size > 0;
  return false;
}

/** The first civil date this person has anything for a metric, or null:
    how far back the "previous" arrow can go. */
function firstOf(c, m) {
  const s = m.source;
  if (s.type === 'sample') return c.stats[s.kind]?.first || null;
  if (s.type === 'period') return c.stats.period?.first || null;
  if (s.type === 'comp') return c.comp().filter((x) => fin(x.values[s.field])).at(-1)?.r.date || null;
  if (s.type === 'weight' || s.type === 'bmi') { const w = c.db.weights(0)[0]; return w ? localDate(w.t, w.off) : null; }
  if (s.type === 'workouts') { const x = unified(c.db, 0)[0]; return x ? todayIn(x.start, c.tz) : null; }
  if (m.logs) return [c.db.firstDateOf(dailyKeysOf(m)), c.stats[m.logs]?.first].filter(Boolean).sort()[0] || null;
  return c.db.firstDateOf(dailyKeysOf(m));
}

/* ── entries ──────────────────────────────────────────────────────── */

/** One line for a row of the `sample` table. */
function sampleText(row) {
  const d = row.data || {};
  const v = row.value;
  switch (row.kind) {
    case 'water': return `${nfmt.format(v)} ml`;
    case 'food': return `${d.name || 'Food'}, ${nfmt.format(v)} kcal${d.meal ? ` (${word('mealType', d.meal).toLowerCase()})` : ''}`;
    case 'mood': return `${(d.moods || []).map((x) => word('moods', x)).join(', ') || 'Mood'}${d.valence ? ` (${word('valences', d.valence).toLowerCase()})` : ''}`;
    case 'symptom': return (d.symptoms || []).map((x) => word('symptoms', x)).join(', ') || 'Symptoms';
    case 'glucose': return `${nfmt.format(v)} mg/dL${d.timing ? `, ${word('glucoseTiming', d.timing).toLowerCase()}` : ''}`;
    case 'bodytemp': return `${nfmt.format(v)} °C${d.location ? `, ${word('tempLocation', d.location).toLowerCase()}` : ''}`;
    case 'height': return `${nfmt.format(v / 10)} cm`;
    case 'bodyfat': return `${nfmt.format(v)}%`;
    case 'period': return `${v} ${v === 1 ? 'day' : 'days'}, ${d.start || row.date}${d.end && d.end !== d.start ? ` to ${d.end}` : ''}`;
    case 'ovulation': return word('ovulation', d.result);
    case 'ecg': return `${String(d.classification || 'Reading').toLowerCase().replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())}${fin(v) ? `, ${Math.round(v)} bpm` : ''}`;
    case 'irn': return `Irregular rhythm notice${fin(d.minBpm) && fin(d.maxBpm) ? `, ${Math.round(d.minBpm)} to ${Math.round(d.maxBpm)} bpm` : ''}`;
    case 'vo2': return `${nfmt.format(v)} ml/kg/min`;
    case 'stress': return word('stress', String(v));
    case 'bodycomp': return compText(d);
    case 'sleep': return `${duration(v)} asleep${d.awakeMin ? `, ${Math.round(d.awakeMin)} min awake` : ''}`;
    case 'measure': {
      const parts = MEASURES.filter(([k]) => fin(d[k])).map(([k, label]) => `${label.toLowerCase()} ${nfmt.format(d[k])}`);
      if (fin(d.lean_mass_kg)) parts.push(`lean mass ${nfmt.format(d.lean_mass_kg)} kg`);
      const text = parts.slice(0, 4).join(', ') + (parts.length > 4 ? `, and ${parts.length - 4} more` : '');
      return text ? text[0].toUpperCase() + text.slice(1) + (MEASURES.some(([k]) => fin(d[k])) ? ' cm' : '') : 'Measurements';
    }
    default: return fin(v) ? nfmt.format(v) : row.kind;
  }
}

/**
 * A row of the `sample` table as the API shows an entry. Only an entry
 * made here can be changed, and only while its group is on; removing
 * one's own entry is always allowed.
 */
export function entryView(world, row) {
  if (!row) return null;
  const m = metricOfKind(row.kind);
  const own = row.source === 'app' && !!KINDS[row.kind];
  const { _g, ...data } = row.data || {};
  return {
    id: row.id, kind: row.kind, metric: m?.id || null, t: row.t, end: row.end ?? null, date: row.date,
    text: sampleText(row), value: row.kind === 'height' && fin(row.value) ? row.value / 10 : row.value,
    // Stress logged by hand is on this app's 1 to 5 scale, not the device's 0 to 100.
    unit: row.kind === 'stress' ? 'of 5' : m?.unit ?? KINDS[row.kind]?.unit ?? null,
    source: row.source, device: row.device ?? null,
    editable: own && target(world, row.kind).chosen, deletable: own,
    google: row.gstate ?? null, error: _g?.error || null,
    fields: KINDS[row.kind] ? fieldsOf(row) : data,
    ...(row.kind === 'bodycomp' ? { details: compDetails(data) } : {}),
  };
}

/** A scale's weigh-in, field by field. */
const COMP = [['weightKg', 'Weight', 'kg'], ['fatPct', 'Body fat', '%'], ['muscleKg', 'Muscle', 'kg'], ['waterPct', 'Water', '%'], ['boneKg', 'Bone', 'kg'],
  ['proteinPct', 'Protein', '%'], ['proteinKg', 'Protein mass', 'kg'], ['visceral', 'Visceral fat', null], ['bmr', 'Basal metabolic rate', 'kcal'], ['metabolicAge', 'Body age', 'years'], ['bmi', 'BMI', null],
  ['heartRate', 'Heart rate', 'bpm'], ['impedance', 'Impedance', 'ohm']];
const compDetails = (d) => COMP.filter(([k]) => fin(d[k])).map(([k, label, unit]) => ({ label, value: round(d[k], 1), unit }));

const PAGE = 50;

/** The entries of a metric at or before a date, newest first, one page. */
function entriesOf(c, m, { to, before = null, from = null }) {
  const cut = fin(before) ? before : Number.MAX_SAFE_INTEGER;
  const endMs = Math.min(cut, localToMs(addDays(to, 1), 0, c.tz));
  const inRange = (date) => (from ? date >= from && date <= to : true);
  const page = (list) => ({ entries: list.slice(0, PAGE).map((e) => ({ ...e, inRange: inRange(e.date) })), more: list.length > PAGE });
  const kind = m.entries || (m.source.type === 'sample' ? m.source.kind : m.source.type === 'period' ? 'period' : null);
  if (kind) return page(c.db.samples(kind, { toMs: endMs, limit: PAGE + 1 }).map((r) => entryView(c.world, r)));
  const fixed = { unit: m.unit, editable: false, deletable: false, google: null, error: null };
  if (m.source.type === 'comp') {
    // One entry per weigh-in: the scale's number, or ours worked out from it.
    const rows = c.comp().filter((x) => x.r.t < endMs && fin(x.values[m.source.field])).slice(0, PAGE + 1);
    return page(rows.map(({ r, values }) => {
      const value = round(values[m.source.field], m.decimals);
      return { id: `bc-${m.id}-${r.t}`, kind: 'bodycomp', metric: m.id, t: r.t, end: null, date: r.date, text: valueText(m, value), value, ...fixed, source: m.own ? 'calculated' : 'scale', device: null, fields: {} };
    }));
  }
  if (m.source.type === 'weight') {
    const rows = c.db.weights(0).filter((w) => w.t < endMs).reverse().slice(0, PAGE + 1);
    return page(rows.map((w) => ({
      id: `w-${w.t}`, kind: 'weight', metric: m.id, t: w.t, end: null, date: localDate(w.t, w.off), text: `${nfmt.format(round(w.grams / 1000, 1))} kg`, value: round(w.grams / 1000, 2), ...fixed,
      source: w.source === 'app' || w.source === 'scale' ? w.source : 'google', device: null, fields: { at: w.t, kg: round(w.grams / 1000, 2), note: w.note ?? null },
    })));
  }
  if (m.source.type === 'workouts') {
    const totals = c.db.setTotals();
    const rows = unified(c.db, 0).filter((x) => x.start < endMs).reverse().slice(0, PAGE + 1);
    return page(rows.map((x) => {
      const v = x.local ? workoutView(x.local, { totals, defaultType: c.world.exerciseType() }) : mirrorView(x.ex);
      const min = Math.round((x.end - x.start) / 60_000);
      return {
        id: String(v.id), kind: 'workout', metric: m.id, t: x.start, end: x.end, date: todayIn(x.start, c.tz), text: `${v.title || 'Workout'}, ${duration(min)}`, value: min, ...fixed,
        source: x.local ? 'app' : 'google', device: x.ex?.device || null, fields: { workoutId: String(v.id), type: v.type || null },
      };
    }));
  }
  // A metric of daily numbers: each day's value is its entry.
  const series = daySeries(c, m, '0000-00-00', to);
  const mainNights = m.id === 'sleep' || m.id === 'sleep_score' ? c.db.sleeps('0000-00-00').filter((n) => n.main) : null;
  const nights = m.id === 'sleep' ? Object.fromEntries(mainNights.map((n) => [n.date, n])) : null;
  // A score is shown with its working-out: the night it was made from,
  // scored again the way storeDerived scored it (the longest main night).
  const scored = {};
  if (m.id === 'sleep_score') for (const n of mainNights) if (!scored[n.date] || n.asleepMin > scored[n.date].asleepMin) scored[n.date] = n;
  const table = c.table('0000-00-00');
  const dates = [...series.keys()].sort().reverse();
  const list = [];
  for (const date of dates) {
    const t = localToMs(date, 0, c.tz);
    if (t >= cut) continue;
    if (list.length > PAGE) break;
    const p = series.get(date);
    const value = round(p.value, m.decimals);
    const details = [];
    for (const part of m.source.parts || []) if (fin(p.parts?.[part.key])) details.push({ label: part.label, value: round(p.parts[part.key], 0), unit: part.unit || m.unit });
    if (m.source.type === 'range') details.push({ label: 'Lowest', value: round(p.lo, m.decimals), unit: m.unit }, { label: 'Highest', value: round(p.hi, m.decimals), unit: m.unit });
    for (const a of m.also) if (fin(table[date]?.[a.key])) details.push({ label: a.label, value: round(table[date][a.key], a.decimals), unit: a.unit });
    const n = nights?.[date];
    if (n) details.unshift({ label: 'Bedtime', value: clock(n.startMs, n.startOff), unit: null }, { label: 'Woke', value: clock(n.endMs, n.endOff), unit: null });
    const sn = scored[date];
    const parts = sn ? sleepScore(sn, { goalMin: c.goals.sleep }).parts : [];
    list.push({
      id: `d-${m.id}-${date}`, kind: 'day', metric: m.id, t, end: null, date, text: valueText(m, value), value, ...fixed,
      // A number this app worked out came from nowhere else.
      source: daySource(c, m), device: m.own ? null : daySource(c, m) === 'garmin' ? 'Garmin' : c.device, fields: {}, details,
      ...(parts.length ? { parts } : {}),
    });
  }
  // What the person logged themselves, on its own scale, with the days.
  if (m.logs) {
    for (const r of c.db.samples(m.logs, { toMs: endMs, limit: PAGE + 1 })) list.push(entryView(c.world, r));
    list.sort((a, b) => b.t - a.t);
  }
  return page(list);
}

/* ── the card of a metric ─────────────────────────────────────────── */

/** Can this person log this metric here, and where would it go. */
function addSpec(c, m) {
  if (!m.entry) return null;
  const form = FORMS[m.entry];
  const g = c.world.google;
  if (m.entry === 'weight') {
    const connected = g.connected();
    const ok = connected && g.granted(SCOPES.weightWrite);
    return {
      kind: 'weight', route: '/api/weight', fields: form.fields, quick: null, available: true, mode: ok ? 'google' : 'local',
      note: ok ? 'Saved to Google Health too, and to Hevy when it is connected. A weigh-in saved to Google is changed or removed in the Google Health app.'
        : connected ? 'Kept on this site (and sent to Hevy when it is connected). Reconnect Google Health and allow saving your weight to save it there too.'
          : 'Kept on this site, and sent to Hevy when it is connected. Connect Google Health to save weigh-ins there too.',
      group: null,
    };
  }
  const t = target(c.world, m.entry);
  const group = KINDS[m.entry].group ? groupById(KINDS[m.entry].group) : null;
  const note = !t.chosen ? `Switch on ${group.label.toLowerCase()} to log this.`
    : t.usable ? `Saved to Google Health too.${group?.writeOnly ? ' What you log in Google\'s own app cannot be read by other apps.' : ''}`
      : t.connected ? 'Kept on this site only: Google Health has not been given this permission.' : 'Kept on this site only: Google Health is not connected.';
  if (t.here) return { kind: m.entry, route: '/api/entries', fields: form.fields, quick: form.quick || null, available: true, mode: 'local', note: KINDS[m.entry].here ? 'Kept on this site only: Google Health has no stress type.' : 'Kept on this site: Google Health has no place for these. Sent to Hevy when it is connected.', group: null };
  return { kind: m.entry, route: '/api/entries', fields: form.fields, quick: form.quick || null, available: t.chosen, mode: !t.chosen ? 'off' : t.usable ? 'google' : 'local', note, group: KINDS[m.entry].group || null };
}

/** The form of one metric for one person, outside a page (the Log sheet). */
export const addOf = (world, m) => addSpec({ world }, m);
/** One row of the `sample` table as one line of text. */
export const textOfSample = (row) => sampleText(row);

/** Whether the small trend is the last 14 entries rather than 14 days. */
const sparseSpark = (m) => m.source.type === 'weight' || m.source.type === 'period' || m.source.type === 'comp' || !!m.entries || (m.source.type === 'sample' && (m.source.day !== 'sum' || m.kind === 'log'));

function latestAndSpark(c, m) {
  const s = m.source;
  const pt = (date, p, at = null) => ({ value: round(p.value, m.decimals), text: valueText(m, round(p.value, m.decimals)), at, date });
  if (sparseSpark(m)) {
    const { entries } = entriesOf(c, m, { to: c.today });
    const last = entries[0] || null;
    const vals = entries.slice(0, 14).map((e) => (fin(e.value) ? e.value : null)).reverse();
    return { latest: last ? { value: last.value, text: last.text, at: last.t, date: last.date } : null, spark: vals };
  }
  if (m.weekly) {
    // Counted by the week: this week so far, and the twelve weeks to now.
    const w = cardioWeek({ table: c.table(addDays(c.today, -100)), today: c.today, target: c.goals.cardio });
    const any = w.weeks.some((x) => x.minutes !== null);
    return { latest: any ? { value: w.minutes ?? 0, text: valueText(m, w.minutes ?? 0), at: null, date: c.today } : null, spark: w.weeks.map((x) => x.minutes) };
  }
  const from = addDays(c.today, -13);
  const series = daySeries(c, m, from, c.today);
  const spark = [];
  for (let date = from; date <= c.today; date = addDays(date, 1)) { const p = series.get(date); spark.push(p && fin(p.value) ? round(p.value, m.decimals) : null); }
  let latest = null;
  const dates = [...series.keys()].sort();
  if (dates.length) {
    const date = dates[dates.length - 1];
    latest = pt(date, series.get(date));
  } else if (s.type === 'daily' || s.type === 'range' || s.type === 'stack') {
    // Nothing in the last fortnight: the last day there ever was.
    const keys = s.type === 'daily' ? s.keys : s.type === 'range' ? [s.value, s.lo] : s.parts.map((x) => x.daily);
    const date = keys.map((k) => c.db.latest(k)?.date).filter(Boolean).sort().pop();
    const p = date ? dailyPoint(m, c.db.dailyTable(date)[date]) : null;
    if (p) latest = pt(date, p);
  } else {
    const old = daySeries(c, m, addDays(c.today, -400), c.today);
    const date = [...old.keys()].sort().pop();
    if (date) latest = pt(date, old.get(date));
  }
  if (latest && s.type === 'sample') latest.at = c.db.sampleLatest(s.kind)?.t ?? null;
  // Nothing from a device: the last time the person logged it, in words.
  if (!latest && m.logs) {
    const r = c.db.samples(m.logs, { toMs: c.now + 1, limit: 1 })[0];
    if (r) latest = { value: null, text: sampleText(r), at: r.t, date: r.date, logged: true };
  }
  if (latest && s.type === 'workouts') { const e = entriesOf(c, m, { to: c.today }).entries[0]; if (e) latest = { value: e.value, text: e.text, at: e.t, date: e.date }; }
  if (latest && m.id === 'recovery') latest.text = recovery({ table: c.table(addDays(latest.date, -40)), today: latest.date }).label || latest.text;
  return { latest, spark };
}

/** A metric as Browse, a pin and the metric page all show it. */
function card(c, m) {
  const add = addSpec(c, m);
  return {
    id: m.id, label: m.label, category: m.category, family: m.family, icon: m.icon, unit: m.unit, kind: m.kind,
    ...latestAndSpark(c, m),
    pinned: c.pins.includes(m.id), canAdd: !!add?.available, sensitive: m.sensitive, group: m.group, own: m.own,
    // How to write its numbers: a row converts units itself and must round the same way.
    decimals: m.decimals, format: m.format, signed: m.signed,
  };
}

/* ── reference ranges (core/ranges.js) ───────────────────────────── */

/** The person as the ranges need them, at a time: sex, age, height, the latest weigh-in. Never sent as such. */
function rangePerson(c, t) {
  if (!c._rp) {
    const p = bodyPerson(c.world, c.heightMm());
    c._rp = { sex: p.sex, birthYear: p.birthYear, heightCm: p.heightCm, weightKg: c.comp()[0]?.values.weightKg ?? null };
  }
  const p = c._rp;
  return { sex: p.sex, age: ageAt(p.birthYear, t), heightCm: p.heightCm, weightKg: p.weightKg };
}

/** The person's own days of a metric in the 30 before a date, for the ranges that are "your usual". */
function baselineOf(c, m, date, series = null) {
  const from = addDays(date, -30); const to = addDays(date, -1);
  const s = series || daySeries(c, m, from, to);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const p = s.get(d); if (p && fin(p.value)) out.push(p.value); }
  return out;
}

/** The shares of deep and REM sleep (% of time asleep) over the days of a series, from `from` to `to`. */
function stageShares(series, from, to) {
  let deep = 0; let rem = 0; let asleep = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const x = series.get(d)?.parts;
    if (!x || !fin(x.deep) || !fin(x.rem) || !fin(x.light)) continue;
    deep += x.deep; rem += x.rem; asleep += x.deep + x.rem + x.light;
  }
  return asleep > 0 ? { deep: round((deep / asleep) * 100, 1), rem: round((rem / asleep) * 100, 1) } : null;
}

/**
 * The ranges of a metric for one value: a list (most metrics have one;
 * sleep stages two, body measurements the waist and the waist-to-hip
 * ratio), or [] when none applies.
 */
function rangesAt(c, m, value, { date, from = date, series = null, basis = 'latest' }) {
  const p = rangePerson(c, utc(date));
  const out = [];
  const put = (id, v, o) => { const x = rangeFor(id, v, p, o); if (x) out.push({ ...x, value: round(v, Math.max(1, m.decimals)), basis }); };
  if (m.id === 'sleep_stages') {
    const sh = series ? stageShares(series, from, date) : null;
    if (sh) { put('deep', sh.deep); put('rem', sh.rem); }
    return out;
  }
  if (!fin(value)) return out;
  if (m.id === 'hrv' || m.id === 'skin_temp') put(m.id, value, { baseline: baselineOf(c, m, from, series) });
  else put(m.id, value);
  if (m.id === 'measurements') {
    const tape = c.db.samples('measure', { limit: 200 }).find((r) => !r.deleted && fin(r.data?.waist) && fin(r.data?.hips) && r.data.hips > 0);
    if (tape) put('whr', tape.data.waist / tape.data.hips);
  }
  return out;
}

/**
 * The value of a metric page that its range is for: the number its hero
 * shows. A day's value (or total, so far when the day is not over), a
 * week's total for a metric counted by the week, else the period's
 * average day. null when no range fits that number.
 */
function rangeValue(m, r, st, pts, today, series) {
  if (m.kind === 'log' && m.id !== 'measurements') return null;
  if (m.weekly) {
    if (r.id === 'week') return { value: st.total, basis: 'week' };
    if (r.bucket === 'week') { const v = pts.map((x) => x.value).filter(fin); return v.length ? { value: mean(v), basis: 'average-week' } : null; }
    return null;
  }
  // A total of a day that is not over is not held against a whole day's band
  // (1 active minute after midnight is not "under the guideline"): the same
  // 7 days before today the Health list judges, and the page says so.
  const runningTotal = m.kind === 'total' && m.agg === 'sum' && r.to === today;
  if (r.id === 'day') {
    if (runningTotal) {
      const v = []; for (let i = 1; i <= 7; i += 1) { const x = series?.get(addDays(today, -i))?.value; if (fin(x)) v.push(x); }
      return v.length >= 3 ? { value: mean(v), basis: 'average-7' } : null;
    }
    return { value: m.kind === 'total' ? (st.total ?? st.latest?.value) : st.latest?.value, basis: 'day' };
  }
  if (runningTotal && r.bucket === 'day') {
    // The period's average day, without today's unfinished one.
    const v = pts.filter((x) => x.date !== today).map((x) => x.value).filter(fin);
    return v.length ? { value: mean(v), basis: 'average' } : null;
  }
  return { value: st.avg, basis: 'average' };
}

/** What a row of the list shows of its range: { label, tone, basis }, or null. */
function listBand(c, m, x) {
  if (m.kind === 'stack' || !x.latest) return null;
  let v = null; let basis = 'latest'; const date = x.latest.date || c.today;
  if (m.weekly) { v = x.spark?.[x.spark.length - 2]; basis = 'last-week'; }
  else if (m.kind === 'total') {
    // A day that is not over is not held against a whole day's band: the 7 days before today.
    const days = (x.spark || []).slice(-8, -1).filter(fin);
    if (days.length >= 3) { v = mean(days); basis = 'average-7'; }
  } else v = x.latest.value;
  if (!fin(v)) return null;
  const rg = rangesAt(c, m, v, { date, basis })[0];
  return rg && rg.current ? { label: rg.current, tone: rg.tone, basis } : null;
}

/* ── Browse ───────────────────────────────────────────────────────── */

export function browseView(world) {
  ensureDerived(world);
  const c = context(world);
  const have = []; const empty = [];
  for (const m of METRICS) {
    const on = groupOn(c, m);
    if (on && hasData(c, m)) { const x = card(c, m); const band = listBand(c, m, x); have.push(band ? { ...x, band } : x); continue; }
    empty.push({
      id: m.id, label: m.label, category: m.category, family: m.family, icon: m.icon, provides: m.provides,
      group: m.group, groupOn: on, canAdd: on && !!addSpec(c, m)?.available,
    });
  }
  return {
    today: c.today, tz: c.tz,
    categories: CATEGORIES.map((cat) => ({ id: cat.id, label: cat.label, metrics: have.filter((x) => x.category === cat.id) })).filter((cat) => cat.metrics.length),
    empty,
    pinned: c.pins,
    groups: world.groupsView(),
  };
}

/* ── pins ─────────────────────────────────────────────────────────── */

/** Pin or unpin a metric. Throws 400 for an id that is not a metric, and
    when a ninth would be pinned. @returns {string[]} the pins, in order */
export function setPin(world, id, on) {
  const m = metricById(id);
  if (!m) throw bad('That is not a metric.', 400, 'bad_metric');
  if (typeof on !== 'boolean') throw bad('on must be true or false.');
  const pins = world.pins().filter((x) => x !== m.id);
  if (on) {
    if (pins.length >= MAX_PINS) throw bad(`At most ${MAX_PINS} metrics can be pinned. Unpin one first.`, 400, 'too_many');
    pins.push(m.id);
  }
  world.db.setMeta('pins', pins);
  return pins;
}

/* ── the metric page ──────────────────────────────────────────────── */

const PERIOD_WORD = { day: 'day', week: 'week', month: 'month', '6m': 'six months', year: 'year' };
const THIS = { day: 'this day', week: 'this week', month: 'this month', '6m': 'these six months', year: 'this year' };
const NEED = { day: 1, week: 3, month: 7, '6m': 14, year: 30 };

/** The dates a range covers, the period before it, and where the arrows go. */
function rangeOf(m, id, end, today) {
  let to = end; let from; let prevFrom; let prevTo; let nextEnd; let bucket = 'day';
  if (id === 'day') { from = to; prevTo = addDays(to, -1); prevFrom = prevTo; nextEnd = addDays(to, 1); }
  else if (id === 'week' && m.weekly) {
    // A metric counted by the week is shown by the week: Monday to Sunday.
    from = weekOf(end); to = addDays(from, 6) < today ? addDays(from, 6) : today;
    prevFrom = addDays(from, -7); prevTo = addDays(from, -1); nextEnd = addDays(from, 13);
  } else if (id === 'week') { from = addDays(to, -6); prevTo = addDays(from, -1); prevFrom = addDays(from, -7); nextEnd = addDays(to, 7); }
  else if (id === 'month') { from = addDays(to, -29); prevTo = addDays(from, -1); prevFrom = addDays(from, -30); nextEnd = addDays(to, 30); }
  else if (id === '6m') { bucket = 'week'; from = addDays(weekOf(to), -7 * 25); prevTo = addDays(from, -1); prevFrom = addDays(from, -7 * 26); nextEnd = addDays(to, 7 * 26); }
  else {
    bucket = 'month';
    const back = (date, months) => { const [y, mo] = date.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 - months, 1)).toISOString().slice(0, 10); };
    from = back(monthOf(to), 11); prevTo = addDays(from, -1); prevFrom = back(from, 12); nextEnd = addDays(to, 365);
  }
  const canNext = (id === 'week' && m.weekly ? addDays(from, 6) : to) < today;
  return { id, from, to, prevFrom, prevTo, prevEnd: prevTo, nextEnd: nextEnd > today ? today : nextEnd, canNext, bucket };
}

/** Days of a series folded into one point by the metric's own rule. */
function fold(m, date, pts) {
  const vals = pts.map((p) => p.value).filter(fin);
  const n = pts.reduce((a, p) => a + (p.n || 0), 0);
  if (!vals.length && !n) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const out = { date, value: vals.length ? round(m.agg === 'sum' ? sum : sum / vals.length, m.decimals) : null, days: pts.length };
  if (pts.some((p) => fin(p.lo))) { out.lo = round(Math.min(...pts.map((p) => p.lo ?? p.value).filter(fin)), m.decimals); out.hi = round(Math.max(...pts.map((p) => p.hi ?? p.value).filter(fin)), m.decimals); }
  const keys = [...new Set(pts.flatMap((p) => Object.keys(p.parts || {})))];
  if (keys.length) {
    out.parts = Object.fromEntries(keys.map((k) => {
      const v = pts.map((p) => p.parts?.[k]).filter(fin);
      return [k, v.length ? round(m.agg === 'sum' ? v.reduce((a, b) => a + b, 0) : mean(v), 0) : null];
    }));
  }
  if (n) out.n = n;
  return out;
}

function points(m, series, r) {
  const out = [];
  const day = (date) => series.get(date);
  if (r.bucket === 'day') {
    for (let date = r.from; date <= r.to; date = addDays(date, 1)) { const p = day(date); if (p) out.push(fold(m, date, [p])); }
  } else {
    const next = (date) => (r.bucket === 'week' ? addDays(date, 7) : (() => { const [y, mo] = date.split('-').map(Number); return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10); })());
    for (let b = r.from; b <= r.to; b = next(b)) {
      const pts = [];
      for (let date = b; date < next(b) && date <= r.to; date = addDays(date, 1)) { const p = day(date); if (p) pts.push(p); }
      const f = pts.length ? fold(m, b, pts) : null;
      if (f) out.push(f);
    }
  }
  return out.filter(Boolean);
}

/** What a stretch of days amounts to. Always per day, whatever the chart's
    buckets: "an average of 8,200 a day" means the same in every range. */
function statsOf(m, series, from, to, today) {
  const days = [];
  for (let date = from; date <= to; date = addDays(date, 1)) { const p = series.get(date); if (p) days.push({ date, ...p }); }
  const have = days.filter((x) => fin(x.value));
  const entries = days.reduce((a, x) => a + (x.n || 0), 0);
  if (!have.length) return { avg: null, min: null, max: null, latest: null, total: null, count: 0, entries: entries || null };
  // A day that is not over would pull the average of a running total down.
  const forAvg = m.agg === 'sum' && m.source.type !== 'sample' && to === today && have.length > 1 ? have.filter((x) => x.date !== today) : have;
  const pick = (cmp) => have.reduce((a, x) => (cmp(x.value, a.value) ? x : a));
  const at = (x) => ({ value: round(x.value, m.decimals), date: x.date });
  const lo = m.source.type === 'range' ? have.reduce((a, x) => ((x.lo ?? x.value) < (a.lo ?? a.value) ? x : a)) : pick((a, b) => a < b);
  const hi = m.source.type === 'range' ? have.reduce((a, x) => ((x.hi ?? x.value) > (a.hi ?? a.value) ? x : a)) : pick((a, b) => a > b);
  return {
    avg: round(mean(forAvg.map((x) => x.value)), m.decimals),
    min: m.source.type === 'range' ? { value: round(lo.lo ?? lo.value, m.decimals), date: lo.date } : at(lo),
    max: m.source.type === 'range' ? { value: round(hi.hi ?? hi.value, m.decimals), date: hi.date } : at(hi),
    latest: at(have[have.length - 1]),
    total: m.agg === 'sum' ? round(have.reduce((a, x) => a + x.value, 0), m.decimals) : null,
    count: have.length, entries: entries || null,
  };
}

/** One plain line about a period. Calm, exact, and no more than the
    numbers say. */
function readingOf(m, r, { st, prev, band, goal, pts, today }) {
  const before = `the ${PERIOD_WORD[r.id]} before`;
  if (m.kind === 'log') {
    const n = st.entries ?? st.count;
    if (!n) return r.id === 'day' ? 'Nothing logged on this day.' : `Nothing logged in ${THIS[r.id]}.`;
    const noun = m.id === 'workouts' ? ['workout', 'workouts'] : m.id === 'period' ? ['period started', 'periods started'] : ['entry', 'entries'];
    const was = prev ? (prev.entries ?? prev.count) : null;
    return `${n} ${n === 1 ? noun[0] : noun[1]} ${r.id === 'day' ? 'on' : 'in'} ${THIS[r.id]}${was !== null ? `, ${was} in ${before}` : ''}.`;
  }
  if (st.count < NEED[r.id]) return r.id === 'day' ? 'Nothing recorded on this day.' : 'Not enough days yet.';
  const said = [];
  const txt = (v) => valueText(m, round(v, m.decimals));
  // A day that is not over: a running total is only "so far", and is not
  // held against a whole day.
  const running = r.to === today && m.agg === 'sum';
  if (r.id === 'day') said.push(`${txt(st.latest.value)}${running ? ' so far' : ''}`);
  // Against the goal.
  if (goal !== null && m.weekly) {
    if (r.bucket === 'week') { const hit = pts.filter((p) => p.goalHit).length; said.push(`target met in ${hit} of ${pts.length} weeks`); }
    else if (r.id === 'week') said.push(`${txt(st.total)} of your ${txt(goal)} target ${r.to === today ? 'so far this week' : 'in this week'}${prev && fin(prev.total) ? `, ${txt(prev.total)} in the week before` : ''}`);
  } else if (goal !== null && r.id === 'day') {
    said.push(st.latest.value >= goal ? `at your goal of ${txt(goal)}` : `${txt(goal - st.latest.value)} short of your goal of ${txt(goal)}`);
  } else if (goal !== null && r.bucket === 'day') {
    const hit = pts.filter((p) => p.goalHit).length;
    said.push(`goal met on ${hit} of ${pts.length} ${m.family === 'sleep' ? 'nights' : 'days'}`);
  }
  // Against the period before.
  if (prev && fin(prev.avg) && fin(st.avg) && !(r.id === 'day' && running) && !(m.weekly && r.id === 'week')) {
    const dAbs = st.avg - prev.avg;
    const usePct = !m.signed && m.source.type !== 'recovery' && prev.avg !== 0;
    const pct = usePct ? Math.round((dAbs / Math.abs(prev.avg)) * 100) : null;
    const small = usePct ? Math.abs(pct) < 2 : Math.abs(dAbs) < 10 ** -m.decimals;
    if (small) said.push(`about the same as ${before}`);
    else said.push(`${usePct ? `${Math.abs(pct)}%` : `${nfmt.format(Math.abs(round(dAbs, Math.max(1, m.decimals))))}${m.unit && m.unit !== 'SD' ? ` ${m.unit}` : ''}`} ${dAbs > 0 ? 'above' : 'below'} ${before}`);
  }
  // Against the person's own usual.
  if (band && fin(st.avg)) said.push(st.avg > band.hi ? 'above your usual range' : st.avg < band.lo ? 'below your usual range' : 'inside your usual range');
  if (!said.length) return r.id === 'day' ? `${txt(st.latest.value)}.` : `An average of ${txt(st.avg)} ${m.family === 'sleep' ? 'a night' : 'a day'} over ${st.count} ${m.family === 'sleep' ? 'nights' : 'days'}.`;
  const line = said.join(', ');
  return `${line[0].toUpperCase()}${line.slice(1)}.`;
}

/**
 * GET /api/metric/<id>. `hours` is views.dayView (handed in, so this file
 * does not reach back into the views): the day by the hour for steps and
 * heart rate.
 * Throws 404 for an unknown id, 409 `group_off` for a metric whose group
 * is switched off, 400 for a bad range, end or before.
 */
export async function metricView(world, id, { range = 'week', end = null, before = null, hours = null } = {}) {
  const m = metricById(id);
  if (!m) throw bad('There is no such metric.', 404, 'not_found');
  const c = context(world);
  if (!groupOn(c, m)) throw bad(`Switch on ${groupById(m.group).label.toLowerCase()} to see this.`, 409, 'group_off', { group: m.group });
  if (!RANGES.includes(range)) throw bad(`range must be one of ${RANGES.join(', ')}.`);
  if (end !== null && !isDate(end)) throw bad('end must be a day as YYYY-MM-DD.');
  const cut = before === null || before === '' ? null : Number(before);
  if (cut !== null && !(cut > 0)) throw bad('before must be a time in milliseconds.');
  ensureDerived(world);

  const r = rangeOf(m, range, end && end < c.today ? end : c.today, c.today);
  const bandFrom = addDays(r.to, -90);
  const lo = [r.prevFrom, bandFrom].sort()[0];
  const series = daySeries(c, m, lo, r.to);
  const first = firstOf(c, m);

  const goalAll = m.goal ? c.goals[m.goal] : null;
  const goalPer = m.goal ? (m.weekly ? 'week' : 'day') : null;
  const chartGoal = goalAll !== null && goalPer === r.bucket && range !== 'day' ? goalAll : (goalAll !== null && range === 'day' && !m.weekly ? goalAll : null);
  let pts = points(m, series, r);
  if (chartGoal !== null && range !== 'day') pts = pts.map((p) => ({ ...p, goalHit: fin(p.value) && p.value >= chartGoal }));

  const st = statsOf(m, series, r.from, r.to, c.today);
  const pst = statsOf(m, series, r.prevFrom, r.prevTo, c.today);
  const prev = pst.count || pst.entries ? {
    avg: pst.avg, total: pst.total, count: pst.count, entries: pst.entries,
    deltaAbs: fin(st.avg) && fin(pst.avg) ? round(st.avg - pst.avg, Math.max(1, m.decimals)) : null,
    deltaPct: fin(st.avg) && fin(pst.avg) && pst.avg !== 0 ? round(((st.avg - pst.avg) / Math.abs(pst.avg)) * 100, 1) : null,
  } : null;

  let band = null;
  if (m.agg === 'avg' && m.kind !== 'log' && m.kind !== 'stack') {
    const v = [];
    for (let date = bandFrom; date < r.to; date = addDays(date, 1)) { const p = series.get(date); if (p && fin(p.value)) v.push(p.value); }
    if (v.length >= 10) band = { lo: round(quantile(v, 0.25), m.decimals), hi: round(quantile(v, 0.75), m.decimals) };
  }

  const page = entriesOf(c, m, { to: r.to, from: r.from, before: cut });

  // The chart: the catalogue's kind for the range, with a day falling back
  // from hours to the day's entries or its one value. Never an error.
  let kind = m.chart[range];
  let bucket = r.bucket;
  let note = null;
  if (range === 'day' && kind === 'hours' && m.id === 'body_battery') {
    // Garmin's curve for the day, kept by its sync: per hour, where it
    // ended, with its lowest and highest.
    const t0 = localToMs(r.to, 0, c.tz);
    const row = c.db.samples('bbday', { fromMs: t0 - 1, toMs: t0 + 1, limit: 1 })[0];
    const by = new Map();
    for (const [t, v] of row?.data?.points || []) {
      const h = Math.floor((t - t0) / 3_600_000);
      if (h < 0 || h > 23) continue;
      const x = by.get(h) || { t: t0 + h * 3_600_000, h, value: v, lo: v, hi: v };
      x.value = v; x.lo = Math.min(x.lo, v); x.hi = Math.max(x.hi, v);
      by.set(h, x);
    }
    if (by.size) { bucket = 'hour'; pts = [...by.values()].sort((a, b) => a.h - b.h); } else { kind = m.chart.week; note = 'Garmin has no Body Battery through this day'; }
  } else if (range === 'day' && kind === 'hours') {
    let got = null;
    try { got = hours ? await hours(world, r.to) : null; } catch (e) { if (e.status !== 400) throw e; note = 'The day by the hour is kept for the last week only'; }
    const stream = m.id === 'steps' ? got?.steps : got?.hr;
    if (got && stream?.available) {
      bucket = 'hour';
      const t0 = (h) => localToMs(r.to, h * 60, c.tz);
      pts = got.hours.filter((h) => !h.future).map((h) => (m.id === 'steps'
        ? { t: t0(h.h), h: h.h, value: h.steps }
        : { t: t0(h.h), h: h.h, value: h.hrAvg, lo: h.hrMin, hi: h.hrMax })).filter((p) => m.id === 'steps' || p.value !== null);
    } else { kind = m.chart.week; note = note || stream?.reason || null; }
  } else if (range === 'day' && kind === 'log') {
    // The day's own entries, whatever page of the list was asked for.
    const dayList = cut === null ? page.entries : entriesOf(c, m, { to: r.to, from: r.from }).entries;
    pts = dayList.filter((e) => e.date === r.to).map((e) => ({ t: e.t, value: e.value, text: e.text })).reverse();
  }
  const parts = m.source.parts || null;
  const stackKeys = parts && pts.some((p) => p.parts) ? parts.map((p) => ({ key: p.key, label: p.label, tone: p.tone, unit: p.unit || m.unit })) : null;

  const add = addSpec(c, m);
  const { canNext, bucket: _b, ...rng } = r;
  // Stress the person logged, apart from the device's: how often in the
  // period, and how it felt on average, in their words.
  let logged = null;
  if (m.logs && (c.stats[m.logs]?.n || 0) > 0) {
    const rows = c.db.samples(m.logs, { fromMs: localToMs(r.from, 0, c.tz), toMs: localToMs(addDays(r.to, 1), 0, c.tz), limit: 1000 }).filter((x) => fin(x.value));
    const avg = rows.length ? mean(rows.map((x) => x.value)) : null;
    logged = { count: rows.length, avg: avg === null ? null : round(avg, 1), word: avg === null ? null : word(m.logs, String(Math.round(avg))), scale: ENUMS[m.logs]?.map((x) => x.label) || null };
    if (!st.count) st.entries = rows.length || null;
  }
  // The reference ranges of the number the page leads with (core/ranges.js).
  const rv = st.count ? rangeValue(m, r, st, pts, c.today, series) : null;
  const ranges = rv ? rangesAt(c, m, rv.value, { date: r.to, from: r.id === 'day' ? r.to : r.from, series, basis: rv.basis }) : [];
  const needs = rangeNeeds(m.id, rangePerson(c, utc(r.to))).filter((k) => k !== 'weight');
  const reading = !st.count && logged ? (logged.count ? `${logged.count === 1 ? 'Logged once' : `Logged ${logged.count} times`} ${r.id === 'day' ? 'on this day' : `in ${THIS[r.id]}`}: ${logged.word.toLowerCase()} on average. Your own words, on a scale of 1 to 5.` : `Nothing logged ${r.id === 'day' ? 'on this day' : `in ${THIS[r.id]}`}.`)
    : readingOf(m, r, { st, prev, band, goal: goalAll, pts, today: c.today });
  return {
    metric: {
      ...card(c, m),
      about: m.about, ownNote: m.own ? m.ownNote : null, provides: m.provides, betterWhen: m.betterWhen,
      goal: goalAll, goalPer,
    },
    range: { ...rng, canPrev: !!first && r.prevTo >= first, canNext },
    chart: { kind, points: pts, bucket, band: bucket === 'hour' ? null : band, goal: bucket === 'hour' ? null : chartGoal, ...(stackKeys ? { stackKeys } : {}), note },
    stats: st,
    prev,
    reading,
    ...(logged ? { logged } : {}),
    entries: page.entries,
    more: page.more,
    add,
    ranges,
    rangeNeeds: needs,
    ...(m.id === 'body_composition' ? { body: bodyView(c) } : {}),
  };
}

/**
 * `body` of GET /api/metric/body_composition: the latest weigh-in worked
 * out in full (core/bodycomp.js), against the one before, with the
 * person's ranges, body type, body score, weight goals, and every number
 * of the last 120 weigh-ins for their charts. null without a weigh-in.
 */
function bodyView(c) {
  const all = c.comp();
  if (!all.length) return null;
  const p = bodyPerson(c.world, c.heightMm());
  const [cur, prev] = all;
  const age = ageAt(p.birthYear, cur.r.t);
  // The waist-to-hip ratio is a tape's, never guessed: the latest measurement with both.
  const tape = c.db.samples('measure', { limit: 200 }).find((r) => !r.deleted && fin(r.data?.waist) && fin(r.data?.hips));
  const x = tape ? analyse(cur.r.data, { sex: p.sex, age, heightCm: p.heightCm }, { whr: { waist: tape.data.waist, hips: tape.data.hips } }) : cur.x;
  const metrics = COMP_FIELDS.filter((f) => fin(x.values[f.id])).map((f) => {
    const v = x.values[f.id]; const pv = prev?.values[f.id];
    const rg = x.ranges[f.id];
    return {
      id: f.id, label: f.label, unit: f.unit, decimals: f.decimals, group: f.group, sent: !!f.sent, from: f.sent ? 'scale' : f.from || 'estimate', about: f.about || null,
      value: round(v, f.decimals),
      change: fin(pv) && f.id !== 'whr' ? round(v - pv, Math.max(1, f.decimals)) : null,
      range: rg ? { bands: rg.bands, at: rg.at, label: rg.bands[rg.at]?.label || null } : null,
      ...(f.id === 'metabolicAge' && age !== null ? { vsAge: round(v - age, 0) } : {}),
      ...(f.id === 'whr' ? { at: tape.t } : {}),
    };
  });
  const history = all.slice(0, 120).reverse().map(({ r, values }) => ({
    t: r.t, date: r.date, v: Object.fromEntries(Object.entries(values).filter(([, n]) => fin(n)).map(([k, n]) => [k, round(n, 2)])),
  }));
  return {
    at: cur.r.t, date: cur.r.date, prevAt: prev?.r.t ?? null,
    person: { sex: p.sex, age, birthYear: p.birthYear, heightCm: p.heightCm, from: p.from },
    needs: x.needs, metrics, bodyType: x.bodyType,
    score: x.score ? { ...x.score, prev: prev?.x.score?.value ?? null } : null,
    goals: x.goals, history, note: COMP_NOTE,
  };
}

/* ── what Today gains ─────────────────────────────────────────────── */

/** The mean of the same weekday over the eight weeks before a date; null
    under three of them. The rule of analysis.weekdayUsual, for any number
    a row of the daily table gives. */
function weekdayMean(table, get, date, weeks = 8) {
  const v = [];
  for (let i = 1; i <= weeks; i += 1) { const x = get(table[addDays(date, -7 * i)]); if (fin(x)) v.push(x); }
  return v.length >= 3 ? mean(v) : null;
}
/** The mean of the 30 days before a date; null under seven of them. */
function baselineMean(table, key, date) {
  const v = [];
  for (let i = 1; i <= 30; i += 1) { const x = table[addDays(date, -i)]?.[key]; if (fin(x)) v.push(x); }
  return v.length >= 7 ? mean(v) : null;
}

const VITALS = [['resp', 'resp', 7], ['spo2', 'spo2', 7], ['skin_temp', 'temp_dev', 7], ['vo2max', 'vo2max', 45]];

/**
 * `extra` of GET /api/brief. Every part is null (or an empty list) when
 * the person has nothing for it, or has not switched its group on, so
 * Today stays as short as their data.
 */
export function briefExtra(world) {
  ensureDerived(world);
  const c = context(world);
  const today = c.today;
  const table = c.table(addDays(today, -100));
  const row = table[today] || {};
  const recent = (key, days) => { for (let i = 0; i < days; i += 1) { const date = addDays(today, -i); if (fin(table[date]?.[key])) return date; } return null; };

  // Cardio minutes: this Monday week against the target.
  let cardio = null;
  const cw = cardioWeek({ table, today, target: c.goals.cardio });
  if (cw.weeks.some((w) => w.minutes !== null)) cardio = { minutes: cw.minutes ?? 0, target: cw.target, pct: cw.pct ?? 0, source: cw.source, days: cw.days, weeks: cw.weeks };

  // Last night's score, with its parts worked out again from the night.
  let score = null;
  const nights = world.db.sleeps(addDays(today, -20)).filter((n) => n.main);
  const last = nights.filter((n) => n.date > addDays(today, -2) && n.date <= today).sort((a, b) => b.asleepMin - a.asleepMin).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (last) {
    let s = sleepScore(last, { goalMin: c.goals.sleep });
    // No stages last night: an estimate from the usual nights, said so.
    if (s.score === null) s = sleepScoreEstimate(last, nights.filter((n) => n.date < last.date), { goalMin: c.goals.sleep }) || s;
    if (s.score !== null) {
      const before = [];
      for (let i = 1; i <= 14; i += 1) { const v = table[addDays(last.date, -i)]?.sleep_score; if (fin(v)) before.push(v); }
      score = { score: s.score, parts: s.parts, basis: s.basis || 'time asleep, with your usual REM sleep and wakes (no stages last night)', estimated: !!s.estimated, usual: before.length >= 3 ? Math.round(mean(before)) : null, date: last.date };
    }
  }

  // Energy: today so far, the usual for this weekday, the last seven days.
  let calories = null;
  const week = caloriesWeek(table, today);
  if (week.some((d) => d.total !== null || d.active !== null)) {
    const now = caloriesDay(row) || { total: null, active: null, basal: null };
    const ut = weekdayMean(table, (r) => r?.kcal, today); const ua = weekdayMean(table, (r) => r?.kcal_active, today);
    calories = { ...now, usual: ut !== null || ua !== null ? { total: ut !== null ? Math.round(ut) : null, active: ua !== null ? Math.round(ua) : null } : null, week };
  }

  let floors = null;
  if (recent('floors', 14)) { const u = weekdayMean(table, (r) => r?.floors, today); floors = { value: fin(row.floors) ? row.floors : 0, usual: u !== null ? round(u, 0) : null }; }

  const vitals = [];
  for (const [id, key, days] of VITALS) {
    const m = metricById(id);
    const date = recent(m.source.type === 'range' ? m.source.value : key, days);
    if (!date) continue;
    const value = round(table[date][m.source.type === 'range' ? m.source.value : key], m.decimals);
    const u = id === 'skin_temp' ? null : baselineMean(table, key, date);
    vitals.push({ id, label: m.label, value, text: valueText(m, value), unit: m.unit, family: m.family, icon: m.icon, usual: u !== null ? round(u, m.decimals) : null, date });
  }

  const rec = recovery({ table, today });
  const rtrend = rec.available ? { label: rec.label, text: rec.text, z: rec.z, parts: rec.parts, days: rec.days } : null;

  // Water and food exist only for somebody who switched nutrition on.
  let water = null; let food = null;
  if (c.groups.nutrition) {
    const w = world.db.sampleDays('water', today, today)[0];
    water = { ml: Math.round(w?.sum || 0), target: c.goals.water, entries: w?.n || 0 };
    const f = world.db.sampleDays('food', today, today, ['protein', 'carbs', 'fat'])[0];
    food = { kcal: Math.round(f?.sum || 0), protein: round(f?.protein ?? 0, 0) || 0, carbs: round(f?.carbs ?? 0, 0) || 0, fat: round(f?.fat ?? 0, 0) || 0, entries: f?.n || 0 };
  }

  const pinned = c.pins.map(metricById).filter((m) => m && groupOn(c, m) && hasData(c, m)).map((m) => card(c, m));
  return { cardio, sleepScore: score, calories, floors, vitals, recovery: rtrend, water, food, pinned, stress: stressToday(world, table, today) };
}

/** Garmin's own words for a day's stress level. */
export const stressBand = (v) => (!fin(v) ? null : v <= 25 ? 'Rest' : v <= 50 ? 'Low' : v <= 75 ? 'Medium' : 'High');

/**
 * Today's stress, for one quiet line: the device's (today, else
 * yesterday) against the usual, and Body Battery now; or, without a
 * device, what was logged today. null when there is neither.
 */
export function stressToday(world, table, today) {
  let device = null;
  for (const date of [today, addDays(today, -1)]) {
    const r = table[date];
    if (!fin(r?.stress)) continue;
    const u = baselineMean(table, 'stress', date);
    device = { value: Math.round(r.stress), band: stressBand(r.stress), date, usual: u === null ? null : Math.round(u), high: fin(r.stress_high) ? Math.round(r.stress_high) : null };
    break;
  }
  let battery = null;
  const t0 = localToMs(today, 0, world.tz);
  const bb = world.db.samples('bbday', { fromMs: t0 - 1, toMs: t0 + 1, limit: 1 })[0];
  if (bb?.data?.points?.length) { const last = bb.data.points[bb.data.points.length - 1]; battery = { now: last[1], at: last[0], high: fin(table[today]?.bb_high) ? table[today].bb_high : null }; }
  const lr = world.db.samples('stress', { fromMs: t0, toMs: localToMs(addDays(today, 1), 0, world.tz), limit: 1 })[0];
  const logged = lr && fin(lr.value) ? { level: lr.value, word: word('stress', String(lr.value)), at: lr.t } : null;
  return device || battery || logged ? { device, battery, logged } : null;
}

/* ── for the summary ──────────────────────────────────────────────── */

/** What the summary may know about cardio minutes and sleep scores: both
    are this app's own numbers over data that is already in the stats. */
export function summaryExtras(world, { today, from }) {
  ensureDerived(world);
  const s = world.settings();
  const table = world.db.dailyTable(addDays(today, -100));
  const cw = cardioWeek({ table, today, target: s.cardioTarget });
  const done = cw.weeks.slice(-5, -1).filter((w) => w.minutes !== null);
  const nights = world.db.sleeps(addDays(from, -20)).filter((n) => n.main);
  const scored = nights.filter((n) => n.date >= from && n.date <= today).map((n) => sleepScore(n, { goalMin: s.sleepTarget })).filter((x) => x.score !== null);
  // The part that most often earned the smallest share of its points.
  const lost = {};
  for (const x of scored) for (const p of x.parts) (lost[p.id] ||= { label: p.label, share: [] }).share.push(p.points / p.max);
  const weakest = Object.entries(lost).map(([id, v]) => ({ id, label: v.label, share: round(mean(v.share), 2) })).sort((a, b) => a.share - b.share)[0] || null;
  return {
    cardio: cw.weeks.some((w) => w.minutes !== null) ? {
      thisWeekMin: cw.minutes ?? 0, targetMin: cw.target, source: cw.source,
      lastWeekMin: cw.weeks[10]?.minutes ?? null, weeksAtTarget: done.filter((w) => w.hit).length, weeksCounted: done.length,
      note: 'cardio minutes are calculated by this app, Monday to Sunday',
    } : null,
    sleepScore: scored.length ? {
      nights: scored.length, avg: Math.round(meanSd(scored.map((x) => x.score)).mean), weakestPart: weakest && weakest.share < 0.85 ? weakest.label.toLowerCase() : null,
      note: 'a score out of 100 calculated by this app the way Google\'s is: duration, composition (REM) and revitalization (long awakenings)',
    } : null,
  };
}
