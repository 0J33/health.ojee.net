/* ============================================================
   health.ojee.net — entries: what a person logs by hand.

   Water, food, a mood, symptoms, a period, an ovulation test, a
   glucose or temperature reading, height, body fat. Each is one row
   of the `sample` table, made here, and mirrored to Google Health
   when that is possible:

     connected, the kind's scope granted   written to Google first-
       (and its group chosen)              hand; the row keeps the
                                           point's name -> 'saved'
     Google took it but named nothing      'create_only': later edits
                                           and deletes stay here
     Google unreachable or refusing        'failed': the row stays and
                                           flushEntries() tries again
     not connected / scope not granted     'local': kept on this site

   The row is written BEFORE Google is asked, so nothing a person
   typed is lost to a timeout. A group's kinds (water, food, mood,
   symptom, period, ovulation) can only be logged while the person
   has that group switched on; without Google they stay local.

   No HTTP in here: the routes, the sync and the demo seed all call
   the same four functions. `deps` is anything with
   `{ db, google, groups(), tz, now() }`; a UserWorld is one.
   ============================================================ */

import { build, pointNameFor, WRITABLE } from './google.js';
import { addDays, today as todayIn, utcOffsetSec, localToMs } from './util.js';

/* ── enums, with the words a person reads ─────────────────────────── */

const WORDS = { PMS: 'PMS' };
const label = (id) => WORDS[id] || id.toLowerCase().split('_').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const list = (ids, over = {}) => ids.split(' ').map((id) => ({ id, label: over[id] || label(id) }));

/** Every enum an entry form offers, as `[{ id, label }]`, in Google's order
    (discovery revision 20261007; the *_UNSPECIFIED values are left out). */
export const ENUMS = {
  moods: list('AMAZED AMUSED ANGRY ANNOYED ANXIOUS HAPPY CONTENT SAD WORRIED FRUSTRATED EXCITED CALM STRESSED ASHAMED BRAVE CONFIDENT DISAPPOINTED DISCOURAGED DISGUSTED DRAINED EMBARRASSED GRATEFUL GUILTY HOPEFUL HOPELESS INDIFFERENT IRRITATED JEALOUS JOYFUL LONELY OVERWHELMED PASSIONATE PEACEFUL PROUD RELIEVED SATISFIED SCARED SURPRISED ENERGIZED FATIGUED VERY_CALM VERY_STRESSED NEUTRAL AFRAID HURTING BORED BITTER ENVIOUS CONFUSED CURIOUS AWESTRUCK INSPIRED LONGING ACCOMPLISHED LOVING COMPASSIONATE DEPRESSED GOOD LOW_ENERGY OBSESSIVE_THOUGHTS PANIC PLAYFUL PLEASED SENSITIVE SLEEPY SWINGS UNHAPPY VERY_SELF_CRITICAL',
    { SWINGS: 'Mood swings' }),
  valences: list('UNPLEASANT BASELINE PLEASANT', { BASELINE: 'Neutral' }),
  // INCREASED_APPETITE_V2 is Google's second spelling of the same thing: one is offered.
  symptoms: list('CRAMPS HEADACHE TENDER_BREASTS ACNE SICK BLOATED HOT_FLASHES PMS COUGH FEVER DIFFICULTY_BREATHING BACK_PAIN SHAKINESS HUNGER SWEATING ANXIETY THIRST FREQUENT_URINATION BLURRED_VISION OTHER SEX_DRIVE_HIGH SEX_DRIVE_MEDIUM SEX_DRIVE_LOW HEART_PALPITATIONS FAINTING CHEST_PAIN FATIGUE CONFUSION DIZZINESS ABDOMINAL_PAIN BLADDER_LEAKS BLEEDING_GUMS BRAIN_FOG BURNING_MOUTH CONSTIPATION CRAVINGS DECREASED_APPETITE DIARRHEA DRAWING_PAIN DRY_EYES DRY_HAIR DRY_SKIN EXHAUSTION FEEL_GOOD FOOD_AVERSIONS HAIR_LOSS HEARTBURN HYPERPIGMENTATION INCREASED_APPETITE INSOMNIA JOINT_PAIN LEG_CRAMPS MILKY_NIPPLE_DISCHARGE NAUSEA NIGHT_SWEATS NORMAL_DIGESTION NORMAL_STOOL PERINEUM_PAIN SLEEPINESS STRETCH_MARKS SWELLING VAGINAL_DRYNESS VAGINAL_ITCHING VOMITING',
    { SICK: 'Feeling sick', SEX_DRIVE_HIGH: 'Sex drive: high', SEX_DRIVE_MEDIUM: 'Sex drive: medium', SEX_DRIVE_LOW: 'Sex drive: low', FEEL_GOOD: 'Feeling good' }),
  glucoseTiming: list('AFTER_MEAL BEFORE_MEAL FASTING GENERAL BEFORE_BED OVER_NIGHT', { GENERAL: 'No particular time', OVER_NIGHT: 'Overnight' }),
  glucoseMeal: list('BREAKFAST LUNCH DINNER SNACK'),
  tempLocation: list('OTHER ARMPIT BODY EAR FINGER GASTRO_INTESTINAL MOUTH RECTUM TOE EAR_DRUM TEMPORAL_ARTERY FOREHEAD URINARY_BLADDER NASAL NASOPHARYNGEAL WRIST VAGINA', { GASTRO_INTESTINAL: 'Gastro-intestinal' }),
  // Google's enum also has BEFORE_BREAKFAST, ANYTIME and the like; its own
  // description names these four as the meal categories.
  mealType: list('BREAKFAST LUNCH DINNER SNACK'),
  ovulation: list('NEGATIVE LUTEINIZING_HORMONE_SURGE ESTROGEN_SURGE POSITIVE INDETERMINATE', { LUTEINIZING_HORMONE_SURGE: 'LH surge' }),
};
const has = (name, v) => ENUMS[name].some((x) => x.id === v);
const VALENCE = { UNPLEASANT: -1, BASELINE: 0, PLEASANT: 1 };

/* ── the kinds ────────────────────────────────────────────────────── */

/** What can be logged: its Google data type, the optional group it
    belongs to (null = core metrics scope), and its unit. */
export const KINDS = {
  water: { type: 'hydration-log', group: 'nutrition', unit: 'ml', label: 'Water' },
  food: { type: 'nutrition-log', group: 'nutrition', unit: 'kcal', label: 'Food' },
  mood: { type: 'moods', group: 'mindfulness', unit: null, label: 'Mood' },
  symptom: { type: 'symptoms', group: 'symptoms', unit: null, label: 'Symptoms' },
  period: { type: 'menstrual-period', group: 'cycle', unit: 'days', label: 'Period' },
  ovulation: { type: 'ovulation-test', group: 'cycle', unit: null, label: 'Ovulation test' },
  glucose: { type: 'blood-glucose', group: null, unit: 'mg/dL', label: 'Blood glucose' },
  bodytemp: { type: 'core-body-temperature', group: null, unit: 'C', label: 'Body temperature' },
  height: { type: 'height', group: null, unit: 'mm', label: 'Height' },
  bodyfat: { type: 'body-fat', group: null, unit: '%', label: 'Body fat' },
};
export const ENTRY_KINDS = Object.keys(KINDS);
/** Kinds whose data is sensitive whatever scope carries it: only ever in
    `sample`, never public, never summarised unless the person said so. */
export const SENSITIVE_KINDS = ['water', 'food', 'mood', 'symptom', 'period', 'ovulation', 'ecg', 'irn', 'glucose', 'bodytemp'];
/** Kinds that also set a daily metric (the latest reading of the day). */
const MIRROR = { bodyfat: 'body_fat', height: 'height_mm' };

/** The limits a form shows, per kind and field (metric units). */
export const LIMITS = {
  water: { ml: [1, 5000] },
  food: { kcal: [0, 10000], protein: [0, 1000], carbs: [0, 1000], fat: [0, 1000], name: 120 },
  mood: { moods: [1, 10], note: 500 },
  symptom: { symptoms: [1, 20], note: 500 },
  glucose: { mgdl: [10, 900], note: 200 },
  bodytemp: { celsius: [30, 45] },
  height: { cm: [50, 272] },
  bodyfat: { pct: [2, 75] },
  period: { days: [1, 31], note: 200 },
};
/** How far back an entry may be dated. */
export const MAX_AGE_DAYS = 366;
const MAX_ATTEMPTS = 6;

const bad = (message, code = 'bad_entry', status = 400) => Object.assign(new Error(message), { status, code, expose: true });
const fin = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : NaN));
function range(v, [lo, hi], what, unit, { required = true } = {}) {
  const n = fin(v);
  if (n === null) { if (required) throw bad(`${what} is needed.`); return null; }
  if (!(n >= lo && n <= hi)) throw bad(`${what} must be between ${lo} and ${hi}${unit ? ` ${unit}` : ''}.`);
  return n;
}
const note = (v, max) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
function choice(name, v, what, { required = false } = {}) {
  if (v === null || v === undefined || v === '') { if (required) throw bad(`${what} is needed.`); return null; }
  if (!has(name, String(v))) throw bad(`${what} is not one of the choices.`);
  return String(v);
}
function many(name, v, [lo, hi], what) {
  const arr = [...new Set((Array.isArray(v) ? v : []).map(String))];
  if (arr.length < lo) throw bad(`Choose at least one ${what}.`);
  if (arr.length > hi) throw bad(`Choose at most ${hi}.`);
  for (const x of arr) if (!has(name, x)) throw bad(`${x} is not one of the choices.`);
  return arr;
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Check what a person typed for one kind and turn it into the row's own
 * columns: `{ t, end, off, date, value, data }`. Throws a 400 `bad_entry`
 * with a sentence fit to show. Units are metric; whole seconds, because
 * that is the instant Google will hand back.
 */
export function validate(kind, fields, { now = Date.now(), tz = undefined } = {}) {
  const K = KINDS[kind];
  if (!K) throw bad('That is not something that can be logged here.', 'bad_kind');
  const f = fields || {};
  const L = LIMITS[kind] || {};

  if (kind === 'period') {
    const today = todayIn(now, tz);
    if (!isDate(f.start)) throw bad('The first day is needed, as a date.');
    const endDate = f.end === undefined || f.end === null || f.end === '' ? f.start : f.end;
    if (!isDate(endDate)) throw bad('The last day must be a date.');
    if (endDate < f.start) throw bad('The last day cannot be before the first.');
    if (f.start > today || endDate > today) throw bad('A period cannot be in the future.');
    if (f.start < addDays(today, -MAX_AGE_DAYS)) throw bad('That is more than a year ago.');
    const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${f.start}T00:00:00Z`)) / 86_400_000) + 1;
    if (days > L.days[1]) throw bad(`A period can be at most ${L.days[1]} days long.`);
    // The whole of both days in the person's zone: midnight to midnight.
    const t = localToMs(f.start, 0, tz);
    const end = localToMs(addDays(endDate, 1), 0, tz);
    const data = { start: f.start, end: endDate };
    const n = note(f.note, L.note);
    if (n) data.note = n;
    return { t, end, off: utcOffsetSec(t, tz), date: f.start, value: days, data };
  }

  const t = f.at === undefined || f.at === null || f.at === '' ? Math.floor(now / 1000) * 1000 : Math.floor(Number(f.at) / 1000) * 1000;
  if (!Number.isFinite(t)) throw bad('That is not a time.');
  if (t > now + 120_000) throw bad('An entry cannot be in the future.');
  if (t < now - MAX_AGE_DAYS * 86_400_000) throw bad('That is more than a year ago.');
  const off = utcOffsetSec(t, tz);
  const at = { t, end: null, off, date: new Date(t + off * 1000).toISOString().slice(0, 10) };
  const data = {};
  const put = (k, v) => { if (v !== null && v !== undefined) data[k] = v; };
  let value = null;

  switch (kind) {
    case 'water':
      value = range(f.ml, L.ml, 'The amount', 'ml');
      break;
    case 'food': {
      const name = note(f.name, L.name);
      if (!name) throw bad('What was it? A name is needed.');
      data.name = name;
      data.meal = choice('mealType', f.meal, 'The meal', { required: true });
      value = range(f.kcal, L.kcal, 'Calories', 'kcal');
      put('protein', range(f.protein, L.protein, 'Protein', 'g', { required: false }));
      put('carbs', range(f.carbs, L.carbs, 'Carbohydrate', 'g', { required: false }));
      put('fat', range(f.fat, L.fat, 'Fat', 'g', { required: false }));
      break;
    }
    case 'mood':
      data.moods = many('moods', f.moods, L.moods, 'mood');
      put('valence', choice('valences', f.valence, 'How it felt'));
      put('note', note(f.note, L.note));
      value = data.valence ? VALENCE[data.valence] : null;
      break;
    case 'symptom':
      data.symptoms = many('symptoms', f.symptoms, L.symptoms, 'symptom');
      put('note', note(f.note, L.note));
      value = data.symptoms.length;
      break;
    case 'glucose':
      value = range(f.mgdl, L.mgdl, 'Glucose', 'mg/dL');
      put('timing', choice('glucoseTiming', f.timing, 'The timing'));
      put('meal', choice('glucoseMeal', f.meal, 'The meal'));
      put('note', note(f.note, L.note));
      break;
    case 'bodytemp':
      value = range(f.celsius, L.celsius, 'Temperature', 'C');
      put('location', choice('tempLocation', f.location, 'Where it was measured'));
      break;
    case 'height':
      value = Math.round(range(f.cm, L.cm, 'Height', 'cm') * 10);
      break;
    case 'bodyfat':
      value = range(f.pct, L.pct, 'Body fat', '%');
      break;
    case 'ovulation':
      data.result = choice('ovulation', f.result, 'The result', { required: true });
      value = data.result === 'NEGATIVE' ? 0 : data.result === 'INDETERMINATE' ? null : 1;
      break;
    default:
      throw bad('That is not something that can be logged here.', 'bad_kind');
  }
  return { ...at, value, data };
}

/** A row's content in the words the API takes it in (the reverse of
    validate): what an edit form is filled with. */
export function fieldsOf(row) {
  const d = row.data || {};
  switch (row.kind) {
    case 'water': return { at: row.t, ml: row.value };
    case 'food': return { at: row.t, name: d.name ?? null, meal: d.meal ?? null, kcal: row.value, protein: d.protein ?? null, carbs: d.carbs ?? null, fat: d.fat ?? null };
    case 'mood': return { at: row.t, moods: d.moods || [], valence: d.valence ?? null, note: d.note ?? null };
    case 'symptom': return { at: row.t, symptoms: d.symptoms || [], note: d.note ?? null };
    case 'glucose': return { at: row.t, mgdl: row.value, timing: d.timing ?? null, meal: d.meal ?? null, note: d.note ?? null };
    case 'bodytemp': return { at: row.t, celsius: row.value, location: d.location ?? null };
    case 'height': return { at: row.t, cm: row.value !== null ? row.value / 10 : null };
    case 'bodyfat': return { at: row.t, pct: row.value };
    case 'period': return { start: d.start ?? row.date, end: d.end ?? row.date, note: d.note ?? null };
    case 'ovulation': return { at: row.t, result: d.result ?? null };
    default: return { at: row.t };
  }
}

/** The DataPoint body Google is sent for a row (see google.js `build`).
    A mood's and a symptom's note have no field at Google: they stay here. */
export function bodyOf(row, { name } = {}) {
  const K = KINDS[row.kind];
  const d = row.data || {};
  const base = { at: row.t, offsetSec: row.off, name };
  switch (row.kind) {
    case 'water': return build[K.type]({ ...base, ml: row.value });
    case 'food': return build[K.type]({ ...base, food: d.name, meal: d.meal, kcal: row.value, protein: d.protein, carbs: d.carbs, fat: d.fat });
    case 'mood': return build[K.type]({ ...base, moods: d.moods || [], valence: d.valence });
    case 'symptom': return build[K.type]({ ...base, symptoms: d.symptoms || [] });
    case 'glucose': return build[K.type]({ ...base, mgdl: row.value, timing: d.timing, meal: d.meal, notes: d.note });
    case 'bodytemp': return build[K.type]({ ...base, celsius: row.value, location: d.location });
    case 'height': return build[K.type]({ ...base, mm: row.value });
    case 'bodyfat': return build[K.type]({ ...base, pct: row.value });
    case 'period': return build[K.type]({ ...base, end: row.end, endOffsetSec: row.off, notes: d.note });
    case 'ovulation': return build[K.type]({ ...base, result: d.result });
    default: throw bad('That is not something that can be logged here.', 'bad_kind');
  }
}

/** A row without the bookkeeping this module keeps inside `data`. */
export function entryOf(row) {
  if (!row) return null;
  const { _g, ...data } = row.data || {};
  return { ...row, data, error: _g?.error || null };
}

/* ── where a kind can go ──────────────────────────────────────────── */

/** For one kind: is its group switched on, and can Google take a write. */
export function target(deps, kind) {
  const K = KINDS[kind];
  if (!K) return { known: false, chosen: false, usable: false, connected: false };
  const chosen = !K.group || !!deps.groups?.()[K.group];
  const connected = !!deps.google?.connected();
  return { known: true, type: K.type, group: K.group, chosen, connected, usable: chosen && connected && deps.google.granted(WRITABLE[K.type]) };
}

const TEXT = {
  local: (t) => (t.connected ? 'Kept on this site only: Google Health has not been given this permission.' : 'Kept on this site only: Google Health is not connected.'),
  failed: (m) => `Saved here. Google Health did not take it (${m}); it will be tried again at the next sync.`,
  create_only: 'Saved to Google Health, which gave the entry no name: later changes stay on this site, and the copy in Google Health has to be changed there.',
  deleteLater: 'Removed here. It will be removed from Google Health when that can be reached.',
  deleteThere: 'Removed here. The copy in Google Health has to be removed there.',
};
/** Errors that say "stop asking for now", not "this entry is wrong". */
const WAIT = new Set(['rate_limited', 'network', 'needs_auth', 'unconfigured']);

function requireKind(deps, kind) {
  const t = target(deps, kind);
  if (!t.known) throw bad('That is not something that can be logged here.', 'bad_kind');
  if (!t.chosen) throw bad(`Switch on ${KINDS[kind].label.toLowerCase()} tracking first.`, 'group_off', 409);
  return t;
}
function ownRow(deps, id) {
  const row = deps.db.sampleGet(id);
  if (!row || row.deleted) throw bad('There is no such entry.', 'not_found', 404);
  if (row.source !== 'app' || !KINDS[row.kind]) throw bad('This came from Google Health and can only be changed there.', 'read_only', 403);
  return row;
}

/** Keep the daily metric of a mirrored kind as the day's latest reading. */
function mirror(db, kind, date) {
  const metric = MIRROR[kind];
  if (!metric || !date) return;
  const day = Date.parse(`${date}T00:00:00Z`);
  // Rows carry their own civil date; a day is at most 14 hours off UTC.
  const last = db.samples(kind, { fromMs: day - 14 * 3_600_000, toMs: day + 38 * 3_600_000, limit: 200 }).find((r) => r.date === date);
  if (last && Number.isFinite(last.value)) db.setDaily(date, metric, last.value);
  else db.deleteDaily(date, metric);
}

/** The Google account a row's point is in: the one it was saved to (the
    main account when it was saved), for a person with several. */
function googleOf(deps, row) {
  return deps.googleFor ? deps.googleFor(row.data?._g?.acct) : deps.google;
}

/** Record how a try at Google went, inside the row. */
function mark(deps, row, gstate, { gname = row.gname, error = null, assumed, wait = false, acct } = {}) {
  const g = { ...(row.data?._g || {}) };
  if (acct) g.acct = acct;
  if (gname === null) delete g.acct;
  if (error) { g.error = String(error).slice(0, 300); g.at = deps.now(); if (!wait) g.attempts = (g.attempts || 0) + 1; } else { delete g.error; delete g.attempts; delete g.at; }
  if (assumed !== undefined) { if (assumed) g.assumed = true; else delete g.assumed; }
  const data = { ...row.data };
  if (Object.keys(g).length) data._g = g; else delete data._g;
  return deps.db.samplePatch(row.id, { gname: gname ?? null, gstate, data }, deps.now());
}

/** Create the point. A name of our own is proposed, so the entry can be
    changed later; a server that names its own points is asked again
    without one. Returns `{ name, assumed }`; name null = it has none. */
async function create(deps, row) {
  const K = KINDS[row.kind];
  const proposed = pointNameFor(K.type, `ojee-${row.kind}-${String(row.id).replace(/^l-/, '')}`);
  const done = (op) => { if (op?.error) throw Object.assign(new Error(op.error.message || 'Google Health refused the entry'), { status: op.error.code || 0 }); return op; };
  try {
    const op = done(await deps.google.createPoint(K.type, bodyOf(row, { name: proposed })));
    if (op?.response?.name) return { name: String(op.response.name), assumed: false };
    // Accepted with the name we proposed, but not echoed back: taken to be
    // the name, and remembered as an assumption (see push()).
    return { name: proposed, assumed: true };
  } catch (e) {
    if (e.status === 409) return { name: proposed, assumed: false };   // a retry of a create that did land
    if (e.status === 400 && /\bname\b/i.test(e.message)) {
      const op = done(await deps.google.createPoint(K.type, bodyOf(row)));
      return { name: op?.response?.name ? String(op.response.name) : null, assumed: false };
    }
    throw e;
  }
}

/** Bring Google's copy of one live row up to date. Never throws. */
async function push(deps, id) {
  let row = deps.db.sampleGet(id);
  const t = target(deps, row.kind);
  const out = (r, message = null) => ({ entry: entryOf(r), google: r.gstate, message });
  if (!t.usable) {
    // Nothing can be sent. A row Google already holds keeps owing its edit.
    if (row.gstate === 'create_only') return out(row, TEXT.create_only);
    if (row.gname) { row = mark(deps, row, 'pending'); return { entry: entryOf(row), google: 'failed', message: TEXT.failed(t.connected ? 'this permission has not been granted' : 'it is not connected') }; }
    row = mark(deps, row, 'local');
    return out(row, TEXT.local(t));
  }
  if (row.gstate === 'create_only') return out(row, TEXT.create_only);
  try {
    if (row.gname) {
      try {
        const op = await googleOf(deps, row).patchPoint(row.gname, bodyOf(row));
        if (op?.error) throw Object.assign(new Error(op.error.message || 'Google Health refused the change'), { status: op.error.code || 0 });
        return out(mark(deps, row, 'saved', { assumed: false }));
      } catch (e) {
        if (e.status !== 404) throw e;
        // No such point. If its name was only ever assumed, Google named it
        // something else and creating again would make a second copy.
        if (row.data?._g?.assumed) return out(mark(deps, row, 'create_only', { gname: null, assumed: false }), TEXT.create_only);
        row = mark(deps, row, 'pending', { gname: null });
      }
    }
    const made = await create(deps, row);
    if (!made.name) return out(mark(deps, row, 'create_only', { gname: null }), TEXT.create_only);
    return out(mark(deps, row, 'saved', { gname: made.name, assumed: made.assumed, acct: deps.primaryId }));
  } catch (e) {
    row = mark(deps, row, 'failed', { error: e.message || e, wait: WAIT.has(e.code) });
    return { entry: entryOf(row), google: 'failed', message: TEXT.failed(String(e.message || e).slice(0, 160)), code: e.code || null };
  }
}

/** Tell Google a deleted row is gone. Never throws. */
async function pushDelete(deps, row) {
  try {
    await googleOf(deps, row).deletePoints(KINDS[row.kind].type, [row.gname]);
  } catch (e) {
    if (e.status !== 404) {
      mark(deps, row, 'failed', { error: e.message || e, wait: WAIT.has(e.code) });
      return { ok: true, google: 'failed', message: TEXT.deleteLater, code: e.code || null };
    }
  }
  mark(deps, row, 'saved');
  return { ok: true, google: 'saved', message: null };
}

/* ── the four calls ───────────────────────────────────────────────── */

/**
 * Log one entry. @returns {{ entry, google: 'saved'|'local'|'failed'|'create_only', message: string|null }}
 * Throws 400 `bad_entry` / `bad_kind`, 409 `group_off`.
 */
export async function addEntry(deps, kind, fields) {
  requireKind(deps, kind);
  const v = validate(kind, fields, { now: deps.now(), tz: deps.tz });
  const id = deps.db.sampleAdd({ ...v, kind, source: 'app', gstate: 'pending' }, deps.now());
  mirror(deps.db, kind, v.date);
  return push(deps, id);
}

/** Change an entry made here: `fields` replaces only what it names. */
export async function editEntry(deps, id, fields) {
  const row = ownRow(deps, id);
  requireKind(deps, row.kind);
  const v = validate(row.kind, { ...fieldsOf(row), ...(fields || {}) }, { now: deps.now(), tz: deps.tz });
  const keep = row.data?._g ? { _g: row.data._g } : {};
  deps.db.samplePatch(row.id, { ...v, data: { ...v.data, ...keep }, ...(row.gstate === 'saved' ? { gstate: 'pending' } : {}) }, deps.now());
  mirror(deps.db, row.kind, row.date);
  mirror(deps.db, row.kind, v.date);
  return push(deps, row.id);
}

/** Remove an entry made here. @returns {{ ok, google, message }} */
export async function removeEntry(deps, id) {
  const row = ownRow(deps, id);
  const t = target(deps, row.kind);
  let out;
  if (row.gstate === 'create_only') {
    deps.db.sampleDelete(row.id, deps.now());
    out = { ok: true, google: 'create_only', message: TEXT.deleteThere };
  } else if (!row.gname) {
    // It never reached Google: nothing to tell, nothing to remember.
    deps.db.sampleDrop(row.id);
    out = { ok: true, google: 'local', message: null };
  } else {
    const dead = deps.db.sampleDelete(row.id, deps.now(), 'pending');
    out = t.usable ? await pushDelete(deps, dead) : { ok: true, google: 'failed', message: TEXT.deleteLater };
  }
  mirror(deps.db, row.kind, row.date);
  return out;
}

/**
 * Send what is owed to Google: entries it never took, edits and deletes
 * made while it could not be reached, and entries kept local that can
 * now go (the person connected, or granted the group). Called after a
 * sync and by anything that wants it sooner. Stops early when Google says
 * to wait. @returns {{ sent, failed, skipped }}
 */
export async function flushEntries(deps, { limit = 20 } = {}) {
  const res = { sent: 0, failed: 0, skipped: 0 };
  if (!deps.google?.connected()) return res;
  for (const row of deps.db.samplesOwed(limit, MAX_ATTEMPTS)) {
    if (!KINDS[row.kind] || !target(deps, row.kind).usable) { res.skipped += 1; continue; }
    let r;
    if (row.deleted) r = row.gname ? await pushDelete(deps, row) : (deps.db.sampleDrop(row.id), { google: 'saved' });
    else r = await push(deps, row.id);
    if (r.google === 'failed') { res.failed += 1; if (WAIT.has(r.code)) break; } else res.sent += 1;
  }
  return res;
}
