/* ============================================================
   health.ojee.net — the live Hevy link, one person at a time.

   A person pastes their Hevy API key (a Hevy Pro feature); from then on
   their Hevy account and this site are kept together, on the same
   clock as the Google sync:

     exercise library   Hevy's templates (with each one's muscle groups)
                        are kept here, so muscle totals stop guessing
                        from names, and logging here picks real
                        exercises. A new exercise can be made in Hevy.
     routines           listed here; a workout can start from one, and
                        a workout here can be saved to Hevy as one.
     workouts, in       every Hevy workout with all of its sets. The
                        first sync reads them all; after that only the
                        changes (GET /v1/workouts/events). An edit in
                        Hevy edits it here, a delete there deletes it
                        here. A Hevy session that overlaps one already
                        here (detected from heart rate, from the watch,
                        imported from a Hevy CSV) is the same session:
                        its sets attach to that one.
     workouts, out      a strength workout logged here (with exercises
                        from the library) goes to Hevy, and its edits
                        follow it. History from before the link is not
                        sent: only what is logged after connecting.
     to Google          a Hevy workout Google has nothing for is saved
                        to Google Health, after a wait (Hevy may send it
                        through Health Connect itself), unless switched
                        off.
     body measurements  both ways, by day. Hevy's weight and body fat
                        fill days that have none here; this site's
                        weigh-ins, body fat and tape measurements go to
                        Hevy (its PUT replaces a whole day, so a day is
                        always sent whole: Hevy's own fields plus ours).

   Settings (meta `hevy`.settings), all on unless switched off:
   toGoogle, pushWorkouts, pushMeasures, pullMeasures.

   Nothing here touches HTTP or the key itself: `api` is a HevyApi made
   by the caller from the stored key.
   ============================================================ */

import { fromHevyWorkout, fromHevyTemplate, fromHevyMeasure, toHevyWorkout, MEASURE_FIELDS, TAPE_FIELDS, MUSCLE_TO_HEVY } from './hevyapi.js';
import { muscleOf } from './muscles.js';
import { localToMs, utcOffsetSec, addDays, today as todayIn } from './core/util.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const HEVY_DEFAULTS = { toGoogle: true, pushWorkouts: true, pushMeasures: true, pullMeasures: true };
/** How long a Hevy workout waits before it may go to Google itself. */
const GOOGLE_WAIT = 30 * MIN;
const TEMPLATES_EVERY = 12 * HOUR;
const ROUTINES_EVERY = 30 * MIN;
const MEASURES_EVERY = 2 * HOUR;
/** How far back this site's own weigh-ins are offered to Hevy. */
const PUSH_MEASURE_DAYS = 60;

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const sameSession = (a0, a1, b0, b1) => overlap(a0, a1, b0, b1) >= 0.5 * Math.max(MIN, Math.min(a1 - a0, b1 - b0));
/** The key a Hevy CSV export gives the same workout (hevy.js): start to the
    minute, and the title. A workout imported from a file is known again. */
export const csvKeyOf = (w) => `${Math.floor(w.start / MIN) * MIN}|${w.title}`;
const r2 = (v) => Math.round(v * 100) / 100;

/* ── state ─────────────────────────────────────────────────────────── */

/** What is known about the person's link, as stored. */
export function hevyMeta(db) {
  const m = db.meta('hevy', null) || {};
  return { ...m, settings: { ...HEVY_DEFAULTS, ...(m.settings || {}) } };
}
export function setHevyMeta(db, patch) {
  const next = { ...hevyMeta(db), ...patch };
  db.setMeta('hevy', next);
  return next;
}
export function forgetHevy(db, { keepData = true } = {}) {
  const m = hevyMeta(db);
  db.setMeta('hevy', { settings: m.settings, connected: false, disconnectedAt: Date.now() });
  if (!keepData) {
    db.tx(() => { db.db.exec('DELETE FROM hevy_tpl; DELETE FROM hevy_routine; DELETE FROM hevy_link;'); });
  }
}

/** The page's view of the link. No key, ever. */
export function hevyView(db, { keySet = false, last4 = null } = {}) {
  const m = hevyMeta(db);
  return {
    connected: !!(m.connected && keySet),
    keySet, last4,
    user: m.user || null,
    connectedAt: m.connectedAt || null,
    lastSync: m.lastSync || null,
    lastError: m.lastError || null,
    first: m.first || null,
    counts: { templates: db.hevyTemplateCount(), workouts: db.hevyLinkCount(), routines: db.hevyRoutines().length },
    settings: m.settings,
  };
}

/* ── the sync ──────────────────────────────────────────────────────── */

/**
 * One pass. Never throws for one bad item; an API failure stops the pass
 * and is returned (and kept as lastError).
 * @param {object} o
 * @param {object} o.db        the person's store
 * @param {HevyApi} o.api
 * @param {string} o.tz
 * @param {Function} o.now
 * @param {Function} o.remove  async (workoutId) => delete a workout here (and from Google)
 * @param {Function} [o.saveWeight]  async ({ grams, at, off }) => save a weigh-in to Google; resolves true when it went
 * @param {boolean} [o.force]  refresh the library and routines now
 */
export async function syncHevy({ db, api, tz, now = Date.now, remove, saveWeight = null, force = false, log = () => {} }) {
  const m = hevyMeta(db);
  const startedAt = now();
  const out = { ok: true, templates: null, routines: null, added: 0, merged: 0, updated: 0, deleted: 0, pushed: 0, measuresIn: 0, measuresOut: 0, calls: 0 };
  const stamp = {};
  try {
    // 1. The library, which every workout's muscle groups read.
    if (force || !db.hevyTemplateCount() || startedAt - (m.templatesAt || 0) > TEMPLATES_EVERY) {
      const list = (await api.all((p) => api.templates(p, 100), 'exercise_templates')).map(fromHevyTemplate);
      if (list.length) db.hevyTemplatesPut(list, startedAt);
      out.templates = list.length;
      stamp.templatesAt = startedAt;
    }
    const templates = new Map(db.hevyTemplates().map((t) => [t.id, t]));
    const read = (hw) => fromHevyWorkout(hw, { templates, muscleOf });

    // 2. Workouts: all of them once, then only what changed.
    if (!m.first?.done) {
      const all = await api.all((p) => api.workouts(p, 10), 'workouts');
      db.tx(() => { for (const hw of all) tally(out, applyWorkout({ db, w: read(hw), now: startedAt, settings: m.settings })); });
      stamp.first = { done: true, at: startedAt, count: all.length };
      stamp.since = new Date(startedAt - 5 * MIN).toISOString();
    } else {
      const since = m.since || new Date(startedAt - 7 * DAY).toISOString();
      const events = await api.all((p) => api.events(since, p, 10), 'events');
      for (const ev of events) {
        if (ev.type === 'deleted') {
          const id = ev.id || ev.workout_id || ev.workout?.id;
          if (id && await deleteWorkout({ db, hevyId: String(id), remove, now: startedAt })) out.deleted += 1;
        } else if (ev.workout) {
          const w = read(ev.workout);
          if (w) db.tx(() => tally(out, applyWorkout({ db, w, now: startedAt, settings: m.settings })));
        }
      }
      // A little overlap: an event stamped just before this pass began is read twice, harmlessly.
      stamp.since = new Date(startedAt - 5 * MIN).toISOString();
    }

    // 3. Routines (and their folders), for starting a workout from one.
    if (force || startedAt - (m.routinesAt || 0) > ROUTINES_EVERY) {
      const [routines, folders] = await Promise.all([
        api.all((p) => api.routines(p, 10), 'routines'),
        api.all((p) => api.folders(p, 10), 'routine_folders').catch(() => []),
      ]);
      const names = new Map(folders.map((f) => [String(f.id), f.title]));
      db.hevyRoutinesPut(routines.map((r) => routineOf(r, names, templates)), startedAt);
      out.routines = routines.length;
      stamp.routinesAt = startedAt;
    }

    // 4. Body measurements, both ways.
    if (m.settings.pullMeasures || m.settings.pushMeasures) {
      if (force || startedAt - (m.measuresAt || 0) > MEASURES_EVERY || db.meta('hevyMeasureDirty', false)) {
        const theirs = (await api.all((p) => api.measurements(p, 10), 'body_measurements')).map(fromHevyMeasure);
        const held = Object.fromEntries(theirs.map((x) => [x.date, x]));
        if (m.settings.pullMeasures) out.measuresIn = pullMeasures({ db, theirs, tz, now: startedAt });
        if (m.settings.pushMeasures) out.measuresOut = await pushMeasures({ db, api, held, tz, now: startedAt, since: m.connectedAt || startedAt });
        if (m.settings.toGoogle && saveWeight) await weightsToGoogle({ db, saveWeight, log });
        db.setMeta('hevyMeasureDirty', false);
        stamp.measuresAt = startedAt;
      }
    }

    // 5. What was logged here, out to Hevy.
    if (m.settings.pushWorkouts) out.pushed = await pushWorkouts({ db, api, since: m.connectedAt || startedAt, now: startedAt, log });
  } catch (e) {
    out.ok = false;
    out.code = e.code || 'error';
    out.message = e.message;
    out.retryAfter = e.retryAfter || null;
  }
  out.calls = api.calls;
  setHevyMeta(db, {
    ...stamp, lastSync: out.ok ? startedAt : (m.lastSync || null),
    lastError: out.ok ? null : { code: out.code, message: String(out.message || '').slice(0, 300), at: startedAt },
    ...(out.code === 'hevy_key' || out.code === 'hevy_pro' ? { connected: false } : {}),
  });
  return out;
}

function tally(out, r) {
  if (r === 'added') out.added += 1;
  else if (r === 'merged') out.merged += 1;
  else if (r === 'updated') out.updated += 1;
}

/* ── one Hevy workout ──────────────────────────────────────────────── */

/**
 * Bring one Hevy workout in. Returns 'added' | 'merged' | 'updated' | 'same'.
 */
export function applyWorkout({ db, w, now, settings = HEVY_DEFAULTS }) {
  if (!w) return 'same';
  const link = db.hevyLink(w.hevyId);
  if (link?.workoutId) {
    const r = db.workoutGet(link.workoutId);
    if (r && r.status !== 'deleted') {
      if (link.updated && w.updatedAt && link.updated === w.updatedAt) return 'same';
      db.putSets(r.id, w.exercises);
      if (r.source === 'hevy') {
        const moved = r.start !== w.start || r.end !== w.end;
        r.start = w.start; r.end = w.end;
        r.title = w.title;
        r.notes = w.description;
        if (moved && r.google?.state === 'saved') r.google = { ...r.google, dirty: true };
      } else if (!r.title) r.title = w.title;
      r.hevy = { ...(r.hevy || {}), id: w.hevyId, title: w.title, routineId: w.routineId, at: now };
      r.updated = now;
      db.workoutPut(r);
      db.hevyLinkSet(w.hevyId, r.id, w.updatedAt, { at: now });
      return 'updated';
    }
    // Deleted here: a Hevy edit does not bring it back.
    if (r?.status === 'deleted') { db.hevyLinkSet(w.hevyId, r.id, w.updatedAt, { at: now }); return 'same'; }
  }

  // The same session already here: from a Hevy CSV, or held otherwise.
  const seen = db.hevySeen(csvKeyOf(w));
  let mine = seen?.workout_id ? db.workoutGet(seen.workout_id) : null;
  if (mine && mine.status === 'deleted') { db.hevyLinkSet(w.hevyId, mine.id, w.updatedAt, { at: now }); return 'same'; }
  if (!mine) {
    const held = db.workoutsSince(w.start - 12 * HOUR)
      .filter((r) => ['done', 'running', 'review', 'ongoing'].includes(r.status) && !db.hevyLinkOf(r.id) && r.source !== 'hevy');
    mine = held.find((r) => sameSession(w.start, w.end, r.start, r.end ?? r.lastEnd ?? r.start + MIN)) || null;
  }
  if (mine) {
    db.putSets(mine.id, w.exercises);
    if (!mine.title) mine.title = w.title;
    if (!mine.notes && w.description) mine.notes = w.description;
    mine.hevy = { id: w.hevyId, key: csvKeyOf(w), title: w.title, routineId: w.routineId, at: now };
    mine.updated = now;
    db.workoutPut(mine);
    db.markHevy(csvKeyOf(w), mine.id, now);
    db.hevyLinkSet(w.hevyId, mine.id, w.updatedAt, { at: now });
    return 'merged';
  }

  // New here. Google gets it unless it already has the session, or the
  // person said no; either way not before Hevy had its chance to send it.
  const from = new Date(w.start - 2 * DAY).toISOString().slice(0, 10);
  const theirs = db.exercises(from).find((x) => sameSession(w.start, w.end, x.startMs, x.endMs));
  const google = theirs ? { state: 'foreign', name: theirs.id }
    : settings.toGoogle ? { state: 'pending', notBefore: Math.max(now, w.end) + GOOGLE_WAIT } : { state: 'local' };
  const rec = {
    status: 'done', source: 'hevy', start: w.start, end: w.end, created: now, updated: now,
    title: w.title, notes: w.description, prompts: {}, google, confirmedAt: now,
    hevy: { id: w.hevyId, key: csvKeyOf(w), title: w.title, routineId: w.routineId, at: now },
  };
  rec.id = db.workoutAdd(rec);
  db.putSets(rec.id, w.exercises);
  db.markHevy(csvKeyOf(w), rec.id, now);
  db.hevyLinkSet(w.hevyId, rec.id, w.updatedAt, { at: now });
  return 'added';
}

/** Deleted in Hevy. A workout that came from Hevy goes; one that was here
    first keeps itself and loses only the sets Hevy gave it. */
export async function deleteWorkout({ db, hevyId, remove, now }) {
  const link = db.hevyLink(hevyId);
  if (!link?.workoutId) { db.hevyLinkDel(hevyId); return false; }
  const r = db.workoutGet(link.workoutId);
  db.hevyLinkDel(hevyId);
  if (!r || r.status === 'deleted') return false;
  if (r.source === 'hevy') { await remove(r.id); return true; }
  db.putSets(r.id, []);
  delete r.hevy;
  r.updated = now;
  db.workoutPut(r);
  return true;
}

/* ── out to Hevy ───────────────────────────────────────────────────── */

/**
 * Strength workouts logged here since the link was made, not in Hevy yet
 * (or edited since they went), sent to Hevy. Only exercises that name a
 * library exercise can go; a workout with none is left alone.
 */
export async function pushWorkouts({ db, api, since, now, log = () => {}, limit = 5 }) {
  let n = 0;
  const candidates = db.workoutsDoneFrom(since - 6 * HOUR)
    .filter((r) => r.source !== 'hevy' && r.source !== 'strava' && (r.created >= since || db.hevyLinkOf(r.id)?.own))
    .slice(-50);
  for (const r of candidates) {
    if (n >= limit) break;
    const exercises = db.setsOf(r.id);
    if (!exercises.some((x) => x.templateId)) continue;
    const link = db.hevyLinkOf(r.id);
    if (link && !link.own) continue;                       // came from Hevy: Hevy holds it already
    const pushedAt = r.hevyPushedAt || 0;
    if (link && pushedAt >= (r.updated || 0)) continue;    // sent, and not changed since
    if (r.hevyFailed && r.hevyFailed.updated === r.updated) continue;  // Hevy refused this version
    const { body, missing } = toHevyWorkout({ title: r.title || 'Workout', start: r.start, end: r.end ?? r.start + 60 * MIN, notes: r.notes, exercises });
    if (!body.exercises.length) continue;
    try {
      const made = link ? await api.updateWorkout(link.hevyId, body) : await api.createWorkout(body);
      const id = String(made?.id || link?.hevyId || '');
      if (!id) throw new Error('Hevy did not say what it called the workout.');
      db.hevyLinkSet(id, r.id, made?.updated_at || null, { own: true, at: now });
      r.hevy = { ...(r.hevy || {}), id, title: r.title || 'Workout', at: now, ...(missing.length ? { missing } : {}) };
      r.hevyPushedAt = Math.max(now, r.updated || 0);
      delete r.hevyFailed;
      db.workoutCache(r.id, { hevy: r.hevy, hevyPushedAt: r.hevyPushedAt, hevyFailed: undefined });
      n += 1;
    } catch (e) {
      if (['hevy_key', 'hevy_pro', 'rate_limited', 'network'].includes(e.code)) throw e;
      log(`hevy push ${r.id}: ${e.message}`);
      db.workoutCache(r.id, { hevyFailed: { updated: r.updated, message: String(e.message).slice(0, 200) } });
    }
  }
  return n;
}

/** Build a routine from one of this site's workouts and save it in Hevy. */
export async function saveRoutine({ db, api, workoutId, title, now }) {
  const r = db.workoutGet(workoutId);
  const exercises = db.setsOf(workoutId).filter((x) => x.templateId);
  if (!r || !exercises.length) throw Object.assign(new Error('This workout has no exercises from your Hevy library to make a routine from.'), { status: 409, code: 'conflict', expose: true });
  const routine = {
    title: String(title || r.title || 'Routine').slice(0, 80),
    folder_id: null,
    notes: r.notes ? String(r.notes).slice(0, 500) : '',
    exercises: exercises.map((x) => ({
      exercise_template_id: x.templateId, superset_id: null, rest_seconds: 90, notes: x.notes || null,
      sets: x.sets.map((s) => ({ type: s.type || 'normal', weight_kg: s.kg ?? null, reps: s.reps ?? null, distance_meters: s.distanceM ? Math.round(s.distanceM) : null, duration_seconds: s.durationS ? Math.round(s.durationS) : null })),
    })),
  };
  const made = await api.createRoutine(routine);
  setHevyMeta(db, { routinesAt: 0 });   // read the list again at the next pass
  return made ? { id: String(made.id), title: made.title } : null;
}

/** A custom exercise in the person's Hevy library, kept here too. */
export async function createTemplate({ db, api, title, muscle, equipment = 'other', type = 'weight_reps', now }) {
  const name = String(title || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('The exercise needs a name.'), { status: 400, expose: true });
  const known = db.hevyTemplateByTitle(name);
  if (known) return known;
  const mg = MUSCLE_TO_HEVY[muscle] ? MUSCLE_TO_HEVY[muscle] : (muscle || MUSCLE_TO_HEVY[muscleOf(name)] || 'other');
  const id = await api.createTemplate({ title: name, exercise_type: type, equipment_category: equipment, muscle_group: mg, other_muscles: [] });
  if (!id) throw Object.assign(new Error('Hevy did not say what it called the exercise.'), { status: 502, expose: true });
  const t = { id, title: name, type, primary: mg, secondary: [], equipment, custom: true };
  db.hevyTemplateAdd(t, now);
  return t;
}

/** A routine as the page shows one: exercises with their sets, ready to log. */
function routineOf(r, folders, templates) {
  return {
    id: String(r.id), title: String(r.title || 'Routine'), folderId: r.folder_id ?? null, folder: r.folder_id !== null && r.folder_id !== undefined ? folders.get(String(r.folder_id)) || null : null,
    updatedAt: r.updated_at || null, notes: r.notes || null,
    exercises: [...(r.exercises || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => {
      const t = templates.get(String(x.exercise_template_id || ''));
      return {
        name: String(x.title || t?.title || 'Exercise'), templateId: x.exercise_template_id ? String(x.exercise_template_id) : null,
        muscle: t?.primary || null, restS: x.rest_seconds ?? null, notes: x.notes || null,
        sets: (x.sets || []).map((s) => ({ type: s.type || 'normal', kg: s.weight_kg ?? null, reps: s.reps ?? s.rep_range?.start ?? null, repRange: s.rep_range || null, distanceM: s.distance_meters ?? null, durationS: s.duration_seconds ?? null })),
      };
    }),
  };
}

/* ── body measurements ─────────────────────────────────────────────── */

const noonOf = (date, tz) => localToMs(date, 12 * 60, tz);
const dayOf = (t, tz) => { const off = utcOffsetSec(t, tz); return new Date(t + off * 1000).toISOString().slice(0, 10); };

/** Hevy's days into this site. Returns how many rows changed. */
export function pullMeasures({ db, theirs, tz, now }) {
  let n = 0;
  const weights = db.weights(0);
  const byDay = new Map();
  for (const w of weights) { const d = dayOf(w.t, tz); (byDay.get(d) || byDay.set(d, []).get(d)).push(w); }
  db.tx(() => {
    for (const x of theirs) {
      const t = noonOf(x.date, tz);
      const off = utcOffsetSec(t, tz);
      // Weight: a day with a weigh-in here keeps it; Hevy's fills an empty day.
      if (x.weight_kg) {
        const day = byDay.get(x.date) || [];
        const own = day.find((w) => w.source === 'hevy');
        const others = day.filter((w) => w.source !== 'hevy');
        if (!others.length) {
          const grams = Math.round(x.weight_kg * 1000);
          if (!own || own.grams !== grams) { db.upsertWeight({ t: own?.t ?? t, grams, off, source: 'hevy', note: null }); n += 1; }
        }
      }
      // Body fat, the same way.
      if (x.fat_percent) {
        const rows = db.samples('bodyfat', { fromMs: t - 14 * HOUR, toMs: t + 14 * HOUR, limit: 20 }).filter((r) => r.date === x.date);
        if (!rows.some((r) => r.source !== 'hevy')) {
          const id = `hv-bf-${x.date}`;
          const had = db.sampleGet(id);
          if (!had || had.deleted || had.value !== x.fat_percent) {
            if (had) db.samplePatch(id, { value: x.fat_percent, deleted: 0 }, now);
            else db.sampleAdd({ id, kind: 'bodyfat', t, off, date: x.date, value: x.fat_percent, source: 'hevy', data: {} }, now);
            db.setDaily(x.date, 'body_fat', x.fat_percent);
            n += 1;
          }
        }
      }
      // Tape measurements and lean mass: one `measure` row per Hevy day.
      const data = {};
      for (const k of [...TAPE_FIELDS, 'lean_mass_kg']) if (x[k]) data[k] = x[k];
      if (Object.keys(data).length) {
        const id = `hv-m-${x.date}`;
        const had = db.sampleGet(id);
        const same = had && !had.deleted && JSON.stringify(had.data) === JSON.stringify(data);
        if (!same) {
          if (had) db.samplePatch(id, { data, value: data.waist ?? null, deleted: 0 }, now);
          else db.sampleAdd({ id, kind: 'measure', t, off, date: x.date, value: data.waist ?? null, source: 'hevy', data }, now);
          n += 1;
        }
      }
    }
  });
  db.setMeta('hevyMeasures', Object.fromEntries(theirs.map((x) => [x.date, x])));
  return n;
}

/**
 * This site's days out to Hevy: the day's latest weigh-in (not one that came
 * from Hevy), body fat and tape measurements logged here. A day Hevy has is
 * PUT whole (its fields, then ours over them); a day it has not is POSTed.
 */
export async function pushMeasures({ db, api, held, tz, now, since, limit = 15 }) {
  const fromDay = todayIn(Math.max(since - PUSH_MEASURE_DAYS * DAY, now - PUSH_MEASURE_DAYS * DAY), tz);
  const ours = new Map();
  const put = (date, k, v) => { if (!(v > 0)) return; const d = ours.get(date) || {}; d[k] = v; ours.set(date, d); };
  const fromMs = localToMs(fromDay, 0, tz);
  for (const w of db.weights(fromMs)) if (w.source !== 'hevy') put(dayOf(w.t, tz), 'weight_kg', r2(w.grams / 1000));   // ascending: the day's last wins
  for (const r of db.samples('bodyfat', { fromMs, limit: 1000 }).reverse()) if (r.source !== 'hevy' && !r.deleted) put(r.date, 'fat_percent', r2(r.value));
  for (const r of db.samples('measure', { fromMs, limit: 1000 }).reverse()) {
    if (r.source === 'hevy' || r.deleted) continue;
    for (const [k, v] of Object.entries(r.data || {})) if (TAPE_FIELDS.includes(k) || k === 'lean_mass_kg') put(r.date, k, r2(v));
  }
  const sent = db.meta('hevyMeasuresSent', {}) || {};
  let n = 0;
  for (const [date, mine] of [...ours.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    if (n >= limit) break;
    const theirs = held[date] || null;
    // Already what Hevy holds for every field we have.
    if (theirs && Object.entries(mine).every(([k, v]) => Math.abs((theirs[k] ?? -1) - v) < 0.01)) continue;
    const sig = JSON.stringify(mine);
    if (sent[date] === sig && theirs) continue;
    const whole = { date };
    for (const [k] of MEASURE_FIELDS) { const v = mine[k] ?? theirs?.[k]; if (v > 0) whole[k] = v; }
    try {
      if (theirs) await api.updateMeasurement(date, whole);
      else await api.createMeasurement(whole);
    } catch (e) {
      if (e.code === 'hevy_conflict') { await api.updateMeasurement(date, whole); }
      else if (e.code === 'not_found' && theirs) { await api.createMeasurement(whole); }
      else throw e;
    }
    sent[date] = sig;
    held[date] = whole;
    n += 1;
  }
  db.setMeta('hevyMeasuresSent', sent);
  if (n) db.setMeta('hevyMeasures', held);
  return n;
}

/** Hevy weigh-ins Google has no copy of, sent to Google (weight write). */
async function weightsToGoogle({ db, saveWeight, log }) {
  const pending = db.weights(Date.now() - 90 * DAY).filter((w) => w.source === 'hevy');
  for (const w of pending.slice(-10)) {
    try {
      if (await saveWeight({ grams: w.grams, at: w.t, off: w.off })) db.upsertWeight({ ...w, source: 'app' });
    } catch (e) { log(`hevy weight to google: ${e.message}`); break; }
  }
}

/* ── for the logging forms ─────────────────────────────────────────── */

/**
 * Exercises to pick from: the Hevy library when there is one, and the
 * names the person has logged before (with when, and what they lifted
 * last), so logging works with or without Hevy.
 */
export function exercisePicker(db, { q = '', limit = 40 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const last = new Map();
  for (const s of db.exerciseSets(Date.now() - 365 * DAY)) {
    const k = s.exercise.toLowerCase();
    const e = last.get(k) || { name: s.exercise, muscle: s.muscle, t: 0, best: null, sets: 0 };
    e.t = Math.max(e.t, s.t);
    e.sets += 1;
    if (s.kg > 0 && s.reps > 0 && (!e.best || s.kg > e.best.kg)) e.best = { kg: s.kg, reps: s.reps };
    last.set(k, e);
  }
  const out = [];
  const seen = new Set();
  for (const t of db.hevyTemplates()) {
    if (needle && !t.title.toLowerCase().includes(needle)) continue;
    const h = last.get(t.title.toLowerCase());
    out.push({ name: t.title, templateId: t.id, muscle: t.primary || null, group: t.primary ? null : 'other', equipment: t.equipment, type: t.type, custom: t.custom, lastAt: h?.t || null, best: h?.best || null, sets: h?.sets || 0 });
    seen.add(t.title.toLowerCase());
  }
  for (const [k, e] of last) {
    if (seen.has(k) || (needle && !k.includes(needle))) continue;
    out.push({ name: e.name, templateId: null, muscle: null, group: e.muscle, equipment: null, type: null, custom: false, lastAt: e.t, best: e.best, sets: e.sets });
  }
  // Done before first (most recent first), then the library by name; an exact match leads.
  out.sort((a, b) => {
    if (needle) { const ea = a.name.toLowerCase() === needle; const eb = b.name.toLowerCase() === needle; if (ea !== eb) return ea ? -1 : 1; }
    if (!!a.lastAt !== !!b.lastAt) return a.lastAt ? -1 : 1;
    if (a.lastAt && b.lastAt && a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
    return a.name.localeCompare(b.name);
  });
  return out.slice(0, limit);
}

/** The last sets of an exercise, to fill a new one in with. */
export function lastSetsOf(db, name) {
  const want = String(name || '').toLowerCase();
  const rows = db.exerciseSets(Date.now() - 365 * DAY).filter((s) => s.exercise.toLowerCase() === want);
  if (!rows.length) return [];
  const lastW = rows[rows.length - 1].workoutId;
  const lastX = rows.filter((s) => s.workoutId === lastW);
  const ex = lastX[lastX.length - 1].ex;
  return lastX.filter((s) => s.ex === ex).map((s) => ({ type: s.type, kg: s.kg, reps: s.reps, distanceM: s.distanceM, durationS: s.durationS }));
}

export { addDays };
