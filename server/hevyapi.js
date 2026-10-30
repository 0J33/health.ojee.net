/* ============================================================
   health.ojee.net — the Hevy public API, as one small client.

   https://api.hevyapp.com/docs (OpenAPI 0.0.1). A person's own API key
   (Hevy → Settings → Developer, a Hevy Pro feature) goes in the
   `api-key` header. There are no webhooks: changes are read by polling
   GET /v1/workouts/events?since=, which lists updated workouts (whole)
   and deleted ones (by id) after an instant.

   What it covers:
     user info                      GET  /v1/user/info
     workouts                       GET  /v1/workouts, /v1/workouts/{id}, /v1/workouts/events
                                    POST /v1/workouts      PUT /v1/workouts/{id}
     exercise templates (library)   GET  /v1/exercise_templates   POST (a custom one)
     routines and their folders     GET  /v1/routines, /v1/routine_folders   POST /v1/routines, PUT /v1/routines/{id}, POST /v1/routine_folders
                                    (the API has no way to delete a routine)
     body measurements              GET  /v1/body_measurements    POST     PUT /v1/body_measurements/{date}

   Every failure is an HevyError with a code the routes turn into a
   sentence: hevy_key (401), hevy_pro (403 on a read), hevy_limit (403 on
   a create: Hevy's own caps), not_found, hevy_conflict (409),
   rate_limited (429, with retryAfter), hevy_bad (400), network, upstream.
   Calls to one person's key are spaced out (gapMs): Hevy publishes no
   limit, so this is polite by default.
   ============================================================ */

export const HEVY_BASE = 'https://api.hevyapp.com';

export class HevyError extends Error {
  constructor(message, { status = 0, code = 'upstream', retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

export class HevyApi {
  /**
   * @param {object} o
   * @param {string} o.key            the person's API key
   * @param {Function} [o.fetchImpl]
   * @param {string} [o.base]
   * @param {number} [o.gapMs]        least time between two calls
   * @param {number} [o.timeoutMs]
   */
  constructor({ key, fetchImpl = globalThis.fetch, base = HEVY_BASE, gapMs = 300, timeoutMs = 20_000 }) {
    this.key = String(key || '').trim();
    this.fetch = fetchImpl;
    this.base = base.replace(/\/+$/, '');
    this.gapMs = gapMs;
    this.timeoutMs = timeoutMs;
    this.last = 0;
    this.calls = 0;
  }

  async #call(method, path, { query = null, body = undefined, create = false } = {}) {
    if (!this.key) throw new HevyError('No Hevy API key is set.', { code: 'hevy_key', status: 401 });
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    this.calls += 1;
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}` : '';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    timer.unref?.();
    let res;
    try {
      res = await this.fetch(`${this.base}${path}${qs}`, {
        method,
        headers: { 'api-key': this.key, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      throw new HevyError(e.name === 'AbortError' ? 'Hevy did not answer in time.' : `Hevy could not be reached (${e.message}).`, { code: 'network' });
    } finally { clearTimeout(timer); }
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (res.ok) return json;
    const said = (json && (json.error || json.message)) ? String(json.error || json.message).slice(0, 200) : '';
    const s = res.status;
    if (s === 401) throw new HevyError('Hevy did not accept this API key. Make a new one in Hevy, Settings, Developer, and paste it again.', { status: s, code: 'hevy_key' });
    if (s === 403) {
      if (create) throw new HevyError(said ? `Hevy refused: ${said}` : 'Hevy refused: a limit of your Hevy account was reached.', { status: s, code: 'hevy_limit' });
      throw new HevyError('Hevy refused this key. The Hevy API needs Hevy Pro.', { status: s, code: 'hevy_pro' });
    }
    if (s === 404) throw new HevyError(said || 'Hevy has no such item.', { status: s, code: 'not_found' });
    if (s === 409) throw new HevyError(said || 'Hevy already has this.', { status: s, code: 'hevy_conflict' });
    if (s === 429) {
      const ra = Number(res.headers?.get?.('retry-after'));
      throw new HevyError('Hevy asked us to slow down.', { status: s, code: 'rate_limited', retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 60 });
    }
    if (s === 400) throw new HevyError(said ? `Hevy did not accept that: ${said}` : 'Hevy did not accept that.', { status: s, code: 'hevy_bad' });
    throw new HevyError(`Hevy answered ${s}${said ? `: ${said}` : ''}.`, { status: s, code: 'upstream' });
  }

  /* ── the account ── */
  async user() { return (await this.#call('GET', '/v1/user/info'))?.data || null; }

  /* ── workouts ── */
  workouts(page = 1, pageSize = 10) { return this.#call('GET', '/v1/workouts', { query: { page, pageSize } }); }
  workout(id) { return this.#call('GET', `/v1/workouts/${encodeURIComponent(id)}`); }
  async workoutCount() { return Number((await this.#call('GET', '/v1/workouts/count'))?.workout_count) || 0; }
  /** Updated and deleted workouts after `since` (an ISO instant), a page at a time. */
  events(since, page = 1, pageSize = 10) { return this.#call('GET', '/v1/workouts/events', { query: { since, page, pageSize } }); }
  async createWorkout(workout) {
    const r = await this.#call('POST', '/v1/workouts', { body: { workout }, create: true });
    // The reply holds the new workout in a list.
    const w = Array.isArray(r?.workout) ? r.workout[0] : r?.workout || r;
    return w || null;
  }
  async updateWorkout(id, workout) {
    const r = await this.#call('PUT', `/v1/workouts/${encodeURIComponent(id)}`, { body: { workout } });
    return Array.isArray(r?.workout) ? r.workout[0] : r?.workout || r;
  }

  /* ── the exercise library ── */
  templates(page = 1, pageSize = 100) { return this.#call('GET', '/v1/exercise_templates', { query: { page, pageSize } }); }
  template(id) { return this.#call('GET', `/v1/exercise_templates/${encodeURIComponent(id)}`); }
  /** A custom exercise. Returns its new id. */
  async createTemplate(exercise) {
    const r = await this.#call('POST', '/v1/exercise_templates', { body: { exercise }, create: true });
    return r?.id !== undefined && r?.id !== null ? String(r.id) : null;
  }

  /* ── routines ── */
  routines(page = 1, pageSize = 10) { return this.#call('GET', '/v1/routines', { query: { page, pageSize } }); }
  folders(page = 1, pageSize = 10) { return this.#call('GET', '/v1/routine_folders', { query: { page, pageSize } }); }
  async createRoutine(routine) {
    const r = await this.#call('POST', '/v1/routines', { body: { routine }, create: true });
    return Array.isArray(r?.routine) ? r.routine[0] : r?.routine || null;
  }
  /** Replace a routine's title, notes and exercises (Hevy keeps its folder). */
  async updateRoutine(id, routine) {
    const r = await this.#call('PUT', `/v1/routines/${encodeURIComponent(id)}`, { body: { routine } });
    return Array.isArray(r?.routine) ? r.routine[0] : r?.routine || null;
  }
  /** A new routine folder. Returns it ({ id, title }). */
  async createFolder(title) {
    const r = await this.#call('POST', '/v1/routine_folders', { body: { routine_folder: { title } }, create: true });
    return r?.routine_folder || (Array.isArray(r?.routine_folder) ? r.routine_folder[0] : r) || null;
  }

  /* ── body measurements ── */
  measurements(page = 1, pageSize = 10) { return this.#call('GET', '/v1/body_measurements', { query: { page, pageSize } }); }
  measurement(date) { return this.#call('GET', `/v1/body_measurements/${encodeURIComponent(date)}`); }
  createMeasurement(m) { return this.#call('POST', '/v1/body_measurements', { body: m, create: true }); }
  /** PUT replaces every field: send the whole row, not only what changed. */
  updateMeasurement(date, m) { const { date: _d, ...rest } = m; return this.#call('PUT', `/v1/body_measurements/${encodeURIComponent(date)}`, { body: rest }); }

  /**
   * Every item of a paged list. `get(page)` returns Hevy's page object;
   * `key` names its list. Stops at `max` pages.
   */
  async all(get, key, { max = 500 } = {}) {
    const out = [];
    for (let page = 1; page <= max; page += 1) {
      let r;
      try { r = await get(page); } catch (e) { if (e.code === 'not_found' && page > 1) break; throw e; }
      out.push(...(r?.[key] || []));
      const count = Number(r?.page_count) || 0;
      if (page >= count || !(r?.[key] || []).length) break;
    }
    return out;
  }
}

/* ── Hevy's words and the app's ─────────────────────────────────────── */

/** Hevy's muscle groups (20) → the app's seven (muscles.js). */
export const MUSCLE_FROM_HEVY = {
  chest: 'chest',
  lats: 'back', upper_back: 'back', lower_back: 'back', traps: 'back',
  shoulders: 'shoulders', neck: 'shoulders',
  biceps: 'arms', triceps: 'arms', forearms: 'arms',
  quadriceps: 'legs', hamstrings: 'legs', calves: 'legs', glutes: 'legs', abductors: 'legs', adductors: 'legs',
  abdominals: 'core',
  cardio: 'other', full_body: 'other', other: 'other',
};
/** The app's group → the Hevy group a custom exercise is filed under. */
export const MUSCLE_TO_HEVY = { chest: 'chest', back: 'upper_back', shoulders: 'shoulders', arms: 'biceps', legs: 'quadriceps', core: 'abdominals', other: 'other' };
export const HEVY_MUSCLES = Object.keys(MUSCLE_FROM_HEVY);
export const HEVY_EQUIPMENT = ['none', 'barbell', 'dumbbell', 'kettlebell', 'machine', 'plate', 'resistance_band', 'suspension', 'other'];
export const HEVY_EXERCISE_TYPES = ['weight_reps', 'reps_only', 'bodyweight_reps', 'bodyweight_assisted_reps', 'duration', 'weight_duration', 'distance_duration', 'short_distance_weight'];
const SET_TYPES = new Set(['normal', 'warmup', 'dropset', 'failure']);
const RPE = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10];

/** The body measurement fields Hevy keeps, with the words a form shows. */
export const MEASURE_FIELDS = [
  ['weight_kg', 'Weight', 'kg'], ['lean_mass_kg', 'Lean mass', 'kg'], ['fat_percent', 'Body fat', '%'],
  ['neck_cm', 'Neck', 'cm'], ['shoulder_cm', 'Shoulders', 'cm'], ['chest_cm', 'Chest', 'cm'],
  ['left_bicep_cm', 'Left biceps', 'cm'], ['right_bicep_cm', 'Right biceps', 'cm'],
  ['left_forearm_cm', 'Left forearm', 'cm'], ['right_forearm_cm', 'Right forearm', 'cm'],
  ['abdomen', 'Abdomen', 'cm'], ['waist', 'Waist', 'cm'], ['hips', 'Hips', 'cm'],
  ['left_thigh', 'Left thigh', 'cm'], ['right_thigh', 'Right thigh', 'cm'],
  ['left_calf', 'Left calf', 'cm'], ['right_calf', 'Right calf', 'cm'],
];
/** The tape-measure ones: what the app keeps as a `measure` entry. */
export const TAPE_FIELDS = MEASURE_FIELDS.filter(([, , u]) => u === 'cm').map(([k]) => k);

const fin = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const MIN = 60_000;

/**
 * A Hevy workout as the app keeps one: `{ hevyId, title, start, end,
 * description, routineId, updatedAt, exercises: [{ name, muscle, templateId,
 * notes, supersetId, sets: [...] }] }`. `templates` maps a template id to
 * its row (for the muscle group); a name is read loosely when unknown.
 */
export function fromHevyWorkout(w, { templates = new Map(), muscleOf = () => 'other' } = {}) {
  const start = Date.parse(w.start_time);
  let end = Date.parse(w.end_time);
  if (!Number.isFinite(start)) return null;
  if (!(end > start)) end = start + 60 * MIN;
  if (end - start > 6 * 60 * MIN) end = start + 6 * 60 * MIN;
  const exercises = [...(w.exercises || [])].sort((a, b) => (fin(a.index) ?? 0) - (fin(b.index) ?? 0)).map((x) => {
    const t = templates.get(String(x.exercise_template_id || ''));
    const name = String(x.title || t?.title || 'Exercise').slice(0, 80);
    const muscle = t?.primary ? (MUSCLE_FROM_HEVY[t.primary] || 'other') : muscleOf(name);
    return {
      name, muscle, templateId: x.exercise_template_id ? String(x.exercise_template_id) : null,
      notes: x.notes ? String(x.notes).slice(0, 500) : null,
      supersetId: x.superset_id === null || x.superset_id === undefined ? null : String(x.superset_id),
      sets: [...(x.sets || [])].sort((a, b) => (fin(a.index) ?? 0) - (fin(b.index) ?? 0)).map((s, j) => ({
        index: fin(s.index) ?? j,
        type: SET_TYPES.has(s.type) ? s.type : 'normal',
        kg: fin(s.weight_kg) !== null && fin(s.weight_kg) >= 0 ? fin(s.weight_kg) : null,
        reps: fin(s.reps) !== null ? Math.max(0, Math.round(fin(s.reps))) : null,
        distanceM: fin(s.distance_meters),
        durationS: fin(s.duration_seconds),
        rpe: fin(s.rpe),
      })),
    };
  });
  return {
    hevyId: String(w.id), title: String(w.title || 'Workout').slice(0, 80), start, end,
    description: w.description ? String(w.description).slice(0, 2000) : null,
    routineId: w.routine_id ? String(w.routine_id) : null,
    updatedAt: w.updated_at || w.created_at || null,
    exercises,
    sets: exercises.reduce((n, e) => n + e.sets.length, 0),
  };
}

/** The nearest RPE Hevy takes (6 to 10 in halves from 7), or null. */
const rpeOf = (v) => { const n = fin(v); if (n === null || n < 6) return null; return RPE.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a)); };
const int = (v) => (fin(v) === null ? null : Math.round(fin(v)));

/**
 * The body Hevy is sent for one of the app's workouts. Every exercise must
 * name a template: exercises without one are left out and reported.
 * @returns {{ body: object, missing: string[] }}
 */
export function toHevyWorkout({ title, start, end, notes, exercises }) {
  const missing = [];
  const ex = [];
  for (const x of exercises || []) {
    if (!x.templateId) { missing.push(x.name); continue; }
    ex.push({
      exercise_template_id: String(x.templateId),
      superset_id: x.supersetId !== null && x.supersetId !== undefined && Number.isFinite(Number(x.supersetId)) ? Number(x.supersetId) : null,
      notes: x.notes || null,
      sets: (x.sets || []).map((s) => ({
        type: SET_TYPES.has(s.type) ? s.type : 'normal',
        weight_kg: fin(s.kg),
        reps: int(s.reps),
        distance_meters: int(s.distanceM),
        duration_seconds: int(s.durationS),
        rpe: rpeOf(s.rpe),
      })),
    });
  }
  return {
    body: {
      title: String(title || 'Workout').slice(0, 80),
      ...(notes ? { description: String(notes).slice(0, 2000) } : {}),
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      is_private: false,
      exercises: ex,
    },
    missing,
  };
}

/** A template as the app keeps it. */
export const fromHevyTemplate = (t) => ({
  id: String(t.id), title: String(t.title || '').slice(0, 120), type: t.type || null,
  primary: t.primary_muscle_group || null, secondary: Array.isArray(t.secondary_muscle_groups) ? t.secondary_muscle_groups : [],
  equipment: t.equipment || t.equipment_category || null, custom: !!t.is_custom,
});

/** A Hevy body measurement row, numbers only, nulls dropped. */
export function fromHevyMeasure(m) {
  const out = { date: String(m.date).slice(0, 10) };
  for (const [k] of MEASURE_FIELDS) { const v = fin(m[k]); if (v !== null && v > 0) out[k] = v; }
  return out;
}
