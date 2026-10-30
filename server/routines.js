/* ============================================================
   health.ojee.net — routines, and a workout logged set by set.

   A routine is a plan: a name, an optional folder ("Push Pull Legs"),
   notes, and its exercises in order, each with its sets (kind, weight,
   reps or a rep range, time, distance), a rest between sets and notes.
   They are made here (from nothing, from a workout, from a Hevy routine)
   and kept in the person's own store (table `routine`).

   A workout started from a routine carries a draft: the routine's
   exercises with each set's target and, beside it, what was done last
   time. Sets are ticked off as they are done; the draft is saved as it
   goes, so a closed tab loses nothing. Ending the workout keeps the sets
   that were done (or every filled-in one) as the workout's sets, and
   says how the workout differed from the routine, so the routine can be
   brought up to date in one tap.
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { MUSCLES, muscleOf } from './muscles.js';
import { libById, libByName } from './library.js';

const SET_TYPES = ['normal', 'warmup', 'dropset', 'failure'];
export const EX_TYPES = ['weight_reps', 'bodyweight_reps', 'duration', 'distance_duration'];
const DEFAULT_REST = 90;

const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
const str = (v, max) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

/** What kind of sets an exercise takes, from the library or its name. */
export function exerciseTypeOf({ name, libId, type }) {
  if (EX_TYPES.includes(type)) return type;
  const lib = libId ? libById(libId) : libByName(name);
  if (lib) return lib.type;
  const n = String(name || '').toLowerCase();
  if (/plank|hold|stretch|wall sit|dead hang/.test(n)) return 'duration';
  if (/run|walk|row(ing)? machine|bike|cycl|elliptical|stair|treadmill|swim/.test(n)) return 'distance_duration';
  if (/push.?up|pull.?up|chin.?up|dip|sit.?up|crunch|burpee|jump|lunge \(body/.test(n)) return 'bodyweight_reps';
  return 'weight_reps';
}

/** One exercise of a routine or a draft, checked. `sets` keep `done` when asked. */
export function cleanExercise(e, i, { draft = false } = {}) {
  const name = str(e?.name, 80);
  if (!name) throw bad(`Exercise ${i + 1} needs a name.`);
  const lib = (e.libId ? libById(e.libId) : null) || libByName(name);
  const sets = Array.isArray(e.sets) ? e.sets : [];
  if (sets.length > 30) throw bad(`${name}: at most 30 sets.`);
  const numIn = (v, lo, hi, what, j) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!(n >= lo && n <= hi)) throw bad(`${name}, set ${j + 1}: ${what} must be ${lo} to ${hi}.`);
    return n;
  };
  const rest = e.restS === undefined || e.restS === null || e.restS === '' ? DEFAULT_REST : Number(e.restS);
  if (!(rest >= 0 && rest <= 900)) throw bad(`${name}: rest must be 0 to 15 minutes.`);
  return {
    name, libId: lib ? lib.id : null,
    templateId: e.templateId && /^[A-Za-z0-9_-]{1,40}$/.test(String(e.templateId)) ? String(e.templateId) : null,
    muscle: MUSCLES.includes(e.muscle) ? e.muscle : lib ? lib.group : muscleOf(name),
    type: exerciseTypeOf({ name, libId: lib?.id, type: e.type }),
    notes: str(e.notes, 500), restS: Math.round(rest),
    supersetId: str(e.supersetId, 40),
    sets: sets.map((s, j) => {
      const reps = numIn(s?.reps, 0, 500, 'reps', j);
      const repsMax = numIn(s?.repsMax, 0, 500, 'the top of the rep range', j);
      const out = {
        type: SET_TYPES.includes(s?.type) ? s.type : 'normal',
        kg: numIn(s?.kg, 0, 1000, 'weight', j),
        reps: reps === null ? null : Math.round(reps),
        repsMax: repsMax === null || reps === null || repsMax <= reps ? null : Math.round(repsMax),
        durationS: numIn(s?.durationS, 0, 86_400, 'time', j),
        distanceM: numIn(s?.distanceM, 0, 1_000_000, 'distance', j),
      };
      if (draft) { out.done = !!s?.done; out.rpe = numIn(s?.rpe, 0, 10, 'RPE', j); }
      return out;
    }),
  };
}

export function cleanExercises(list, opts) {
  if (!Array.isArray(list)) throw bad('exercises must be a list.');
  if (list.length > 40) throw bad('At most 40 exercises.');
  return list.map((e, i) => cleanExercise(e, i, opts));
}

/** A routine as given, checked; `prev` is the one it replaces. */
export function cleanRoutine(b, prev = null, now = Date.now()) {
  const title = str(b?.title ?? prev?.title, 80);
  if (!title) throw bad('Give the routine a name.');
  return {
    id: prev?.id || `r-${randomUUID().slice(0, 12)}`,
    title,
    folder: b?.folder !== undefined ? str(b.folder, 60) : prev?.folder ?? null,
    notes: b?.notes !== undefined ? str(b.notes, 1000) : prev?.notes ?? null,
    position: Number.isFinite(Number(b?.position)) ? Math.round(Number(b.position)) : prev?.position ?? 0,
    exercises: b?.exercises !== undefined ? cleanExercises(b.exercises) : prev?.exercises || [],
    created: prev?.created || now, updated: now,
    lastUsed: prev?.lastUsed || null, uses: prev?.uses || 0,
    from: prev?.from || (b?.from && typeof b.from === 'object' ? { kind: str(b.from.kind, 20), id: str(b.from.id, 80) } : null),
  };
}

/** About how long a routine takes: sets times (work + rest). */
export function estimateMin(exercises) {
  let s = 0;
  for (const x of exercises) {
    for (const st of x.sets) s += (x.type === 'duration' || x.type === 'distance_duration' ? (st.durationS || 60) : 40) + (x.restS ?? DEFAULT_REST);
  }
  return Math.max(5, Math.round(s / 60 / 5) * 5);
}

/** A routine as a list shows it. */
export function routineSummary(r) {
  const sets = r.exercises.reduce((a, x) => a + x.sets.length, 0);
  const muscles = {};
  for (const x of r.exercises) muscles[x.muscle] = (muscles[x.muscle] || 0) + x.sets.filter((s) => s.type !== 'warmup').length;
  return {
    id: r.id, title: r.title, folder: r.folder, notes: r.notes, position: r.position,
    exercises: r.exercises.length, sets, estimateMin: estimateMin(r.exercises),
    names: r.exercises.map((x) => x.name), libIds: r.exercises.map((x) => x.libId),
    muscles: Object.entries(muscles).sort((a, b) => b[1] - a[1]).map(([m]) => m),
    lastUsed: r.lastUsed, uses: r.uses, updated: r.updated, from: r.from || null,
  };
}

/** The last time each exercise was done, set by set: the "previous" column. */
export function previousOf(db, names, { before = Number.MAX_SAFE_INTEGER } = {}) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out = new Map();
  const rows = db.exerciseSets(0);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const s = rows[i];
    const k = s.exercise.toLowerCase();
    if (!want.has(k) || s.t >= before) continue;
    const got = out.get(k);
    if (got && got.workoutId !== s.workoutId) continue;
    if (!got) out.set(k, { workoutId: s.workoutId, t: s.t, sets: [] });
    out.get(k).sets.unshift({ type: s.type || 'normal', kg: s.kg ?? null, reps: s.reps ?? null, durationS: s.durationS ?? null, distanceM: s.distanceM ?? null });
  }
  return out;
}

/**
 * A draft to log a routine with: its exercises, each set's target filled
 * in from the routine, or, where the routine leaves a weight open, from
 * last time.
 */
export function draftFrom(db, routine) {
  const prev = previousOf(db, routine.exercises.map((x) => x.name));
  return {
    routineId: routine.id, routineTitle: routine.title,
    exercises: routine.exercises.map((x) => {
      const p = prev.get(x.name.toLowerCase());
      return {
        ...x,
        sets: x.sets.map((s, j) => {
          const last = p?.sets[j] || null;
          return {
            ...s, done: false, rpe: null,
            kg: s.kg ?? (x.type === 'weight_reps' ? last?.kg ?? null : null),
            reps: s.reps ?? last?.reps ?? null,
          };
        }),
      };
    }),
  };
}

/** The sets a draft leaves behind when the workout ends. */
export function setsOfDraft(draft, { keep = 'done' } = {}) {
  const out = [];
  for (const x of draft?.exercises || []) {
    const filled = (s) => [s.kg, s.reps, s.durationS, s.distanceM].some((v) => Number.isFinite(v) && v > 0);
    const sets = x.sets.filter((s) => (keep === 'all' ? filled(s) : s.done && filled(s)));
    if (!sets.length) continue;
    out.push({
      name: x.name, muscle: x.muscle, notes: x.notes, supersetId: x.supersetId, templateId: x.templateId, libId: x.libId,
      sets: sets.map((s, j) => ({ index: j, type: s.type, kg: s.kg, reps: s.reps, distanceM: s.distanceM, durationS: s.durationS, rpe: s.rpe ?? null })),
    });
  }
  return out;
}

/** A routine made from what was done (a workout's sets). */
export function exercisesFromSets(sets, oldRoutine = null) {
  return sets.map((x) => {
    const was = oldRoutine?.exercises.find((y) => y.name.toLowerCase() === x.name.toLowerCase());
    return {
      name: x.name, libId: x.libId || was?.libId || libByName(x.name)?.id || null, templateId: x.templateId || was?.templateId || null,
      muscle: x.muscle, type: was?.type || exerciseTypeOf(x), notes: x.notes ?? was?.notes ?? null, restS: was?.restS ?? DEFAULT_REST, supersetId: x.supersetId || null,
      sets: x.sets.map((s, j) => ({ type: s.type || 'normal', kg: s.kg ?? null, reps: s.reps ?? null, repsMax: was?.sets[j]?.repsMax && s.reps && was.sets[j].repsMax > s.reps ? was.sets[j].repsMax : null, durationS: s.durationS ?? null, distanceM: s.distanceM ?? null })),
    };
  });
}

/**
 * How a workout's sets differ from its routine, in words: exercises
 * added, left out, more or fewer sets, other weights or reps. Empty when
 * it was done as planned.
 */
export function differences(routine, sets) {
  const out = [];
  const by = new Map(sets.map((x) => [x.name.toLowerCase(), x]));
  const planned = new Set(routine.exercises.map((x) => x.name.toLowerCase()));
  for (const x of routine.exercises) {
    const d = by.get(x.name.toLowerCase());
    if (!d) { out.push({ kind: 'skipped', name: x.name, text: `${x.name} was not done` }); continue; }
    if (d.sets.length !== x.sets.length) out.push({ kind: 'sets', name: x.name, text: `${x.name}: ${d.sets.length} sets instead of ${x.sets.length}` });
    const n = Math.min(d.sets.length, x.sets.length);
    let heavier = 0; let lighter = 0; let reps = 0;
    for (let j = 0; j < n; j += 1) {
      const a = x.sets[j]; const b = d.sets[j];
      if (Number.isFinite(a.kg) && Number.isFinite(b.kg) && Math.abs(a.kg - b.kg) > 0.01) { if (b.kg > a.kg) heavier += 1; else lighter += 1; }
      if (Number.isFinite(a.reps) && Number.isFinite(b.reps) && b.reps !== a.reps && !(a.repsMax && b.reps >= a.reps && b.reps <= a.repsMax)) reps += 1;
    }
    if (heavier || lighter) out.push({ kind: 'weight', name: x.name, text: `${x.name}: ${heavier ? `${heavier} heavier` : ''}${heavier && lighter ? ', ' : ''}${lighter ? `${lighter} lighter` : ''}` });
    if (reps) out.push({ kind: 'reps', name: x.name, text: `${x.name}: other reps in ${reps} ${reps === 1 ? 'set' : 'sets'}` });
  }
  for (const d of sets) if (!planned.has(d.name.toLowerCase())) out.push({ kind: 'added', name: d.name, text: `${d.name} was added` });
  return out;
}

/** Estimated one-rep max (Epley), from a set of up to 12 reps. */
export const e1rm = (kg, reps) => (Number.isFinite(kg) && kg > 0 && Number.isFinite(reps) && reps > 0 && reps <= 12 ? Math.round((reps === 1 ? kg : kg * (1 + reps / 30)) * 10) / 10 : null);

/**
 * What a strength session added up to, the way Hevy's summary shows it:
 * volume, sets, reps, records, the best set of each exercise, sets per
 * muscle group, and the same numbers last time this routine was done.
 * `exercises` are the detail's, with `pr` marked on each set.
 */
export function workoutSummary(db, r, exercises) {
  if (!exercises?.length) return null;
  const work = (s) => s.type !== 'warmup';
  let volume = 0; let sets = 0; let reps = 0; let records = 0; let distanceM = 0; let timeS = 0;
  const muscles = {};
  const best = [];
  for (const x of exercises) {
    let top = null;
    for (const s of x.sets) {
      // Volume and sets count every set, warm-ups too, as the rest of the
      // app does; best sets and muscle groups count working sets only.
      sets += 1;
      if (Number.isFinite(s.kg) && Number.isFinite(s.reps)) volume += s.kg * s.reps;
      if (!work(s)) { if (Number.isFinite(s.reps)) reps += s.reps; continue; }
      if (Number.isFinite(s.reps)) reps += s.reps;
      if (Number.isFinite(s.distanceM)) distanceM += s.distanceM;
      if (Number.isFinite(s.durationS)) timeS += s.durationS;
      if (s.pr) records += 1;
      const est = e1rm(s.kg, s.reps);
      const score = est ?? (s.kg || 0) * 100 + (s.reps || 0);
      if (!top || score > top.score) top = { score, kg: s.kg ?? null, reps: s.reps ?? null, durationS: s.durationS ?? null, distanceM: s.distanceM ?? null, e1rm: est };
      muscles[x.muscle] = (muscles[x.muscle] || 0) + 1;
    }
    if (top) { const { score: _s, ...b } = top; best.push({ name: x.name, libId: x.libId || null, ...b, sets: x.sets.filter(work).length, pr: x.sets.some((s) => s.pr) }); }
  }
  const out = {
    volumeKg: Math.round(volume), sets, reps, records, distanceM: Math.round(distanceM), timeS: Math.round(timeS),
    exercises: exercises.length, muscles: Object.entries(muscles).sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ muscle: m, sets: n })),
    best, last: null,
  };
  // The same routine, the time before.
  if (r.routineId) {
    const before = db.workoutsDone(r.start, 60).find((o) => o.routineId === r.routineId && o.id !== r.id);
    if (before) {
      const t = db.setTotals()[before.id];
      out.last = { id: String(before.id), start: before.start, durationMin: before.end ? Math.round((before.end - before.start) / 60_000) : null, volumeKg: t ? Math.round(t.volumeKg) : null, sets: t?.sets ?? null };
    }
  }
  return out;
}

/* ── starter programmes ─────────────────────────────────────────── */

const W = (name, n, reps, { restS = 90, repsMax = null, warm = false } = {}) => ({
  name, restS, sets: [...(warm ? [{ type: 'warmup', reps: 10 }] : []), ...Array.from({ length: n }, () => ({ reps, repsMax }))],
});
const T = (name, n, durationS) => ({ name, restS: 60, sets: Array.from({ length: n }, () => ({ durationS })) });

/** Ready-made routines to start from: names from the library, weights left for the first session. */
export const STARTERS = [
  { id: 'ppl', title: 'Push Pull Legs', text: 'Three days: chest, shoulders and triceps; back and biceps; legs. Six days a week, or each once.', routines: [
    { title: 'Push', exercises: [W('Barbell Bench Press - Medium Grip', 3, 6, { restS: 150, repsMax: 10, warm: true }), W('Incline Dumbbell Press', 3, 8, { repsMax: 12 }), W('Standing Military Press', 3, 6, { restS: 120, repsMax: 10 }), W('Side Lateral Raise', 3, 12, { restS: 60, repsMax: 15 }), W('Triceps Pushdown', 3, 10, { restS: 60, repsMax: 15 })] },
    { title: 'Pull', exercises: [W('Barbell Deadlift', 3, 5, { restS: 180, warm: true }), W('Pullups', 3, 6, { restS: 120, repsMax: 10 }), W('Bent Over Barbell Row', 3, 8, { repsMax: 12 }), W('Face Pull', 3, 12, { restS: 60, repsMax: 15 }), W('Barbell Curl', 3, 8, { restS: 60, repsMax: 12 }), W('Hammer Curls', 2, 10, { restS: 60, repsMax: 15 })] },
    { title: 'Legs', exercises: [W('Barbell Squat', 3, 6, { restS: 180, repsMax: 10, warm: true }), W('Romanian Deadlift', 3, 8, { restS: 120, repsMax: 12 }), W('Leg Press', 3, 10, { repsMax: 15 }), W('Lying Leg Curls', 3, 10, { restS: 60, repsMax: 15 }), W('Standing Calf Raises', 4, 12, { restS: 60, repsMax: 20 }), T('Plank', 3, 45)] },
  ] },
  { id: 'upperlower', title: 'Upper Lower', text: 'Two days, each twice a week: the whole upper body, then the legs and core.', routines: [
    { title: 'Upper', exercises: [W('Barbell Bench Press - Medium Grip', 4, 6, { restS: 150, repsMax: 8, warm: true }), W('Bent Over Barbell Row', 4, 6, { restS: 120, repsMax: 10 }), W('Dumbbell Shoulder Press', 3, 8, { repsMax: 12 }), W('Wide-Grip Lat Pulldown', 3, 10, { repsMax: 12 }), W('Barbell Curl', 2, 10, { restS: 60 }), W('Triceps Pushdown', 2, 10, { restS: 60 })] },
    { title: 'Lower', exercises: [W('Barbell Squat', 4, 6, { restS: 180, repsMax: 8, warm: true }), W('Romanian Deadlift', 3, 8, { restS: 120, repsMax: 10 }), W('Dumbbell Lunges', 3, 10, { repsMax: 12 }), W('Leg Extensions', 3, 12, { restS: 60 }), W('Standing Calf Raises', 3, 15, { restS: 60 }), W('Hanging Leg Raise', 3, 10, { restS: 60 })] },
  ] },
  { id: 'fullbody', title: 'Full body', text: 'One session for the whole body, three times a week. A good start.', routines: [
    { title: 'Full body', exercises: [W('Goblet Squat', 3, 10, { repsMax: 12 }), W('Dumbbell Bench Press', 3, 8, { repsMax: 12 }), W('One-Arm Dumbbell Row', 3, 10, { repsMax: 12 }), W('Dumbbell Shoulder Press', 2, 10, { repsMax: 12 }), W('Barbell Hip Thrust', 3, 10, { repsMax: 12 }), T('Plank', 3, 30)] },
  ] },
];
