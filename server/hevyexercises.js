/* ============================================================
   health.ojee.net — the exercise lists of rep. and Hevy, kept alike.

   Hevy's own library (its built-in exercises) is already in rep.'s
   picker once Hevy is linked (hevysync.js exercisePicker), and rep.'s
   built-in library matches Hevy's by name (hevyroutines.js). What could
   be missing on one side is what a person made themselves:

     made in Hevy, not in rep.   a custom exercise in rep.'s library,
                                 kept to the person (not shared), with
                                 Hevy's muscle, equipment and kind of sets
     made in rep., not in Hevy   a custom exercise in their Hevy library,
                                 unless Hevy already has one like it
                                 (matched as for a workout: same name,
                                 the library's Hevy name, the same words)

   Run after each Hevy sync. Each side's own copy is never changed by the
   other: a rename in one is a new exercise in the other.
   ============================================================ */

import { cexCreate } from './sharedlib.js';
import { libMatch } from './library.js';
import { resolveTemplates } from './hevyroutines.js';
import { createTemplate } from './hevysync.js';

/** Hevy's muscle groups as rep.'s: the group, and the library's muscle. */
const GROUP = {
  chest: 'chest', upper_back: 'back', lats: 'back', lower_back: 'back', traps: 'back', neck: 'other',
  shoulders: 'shoulders', biceps: 'arms', triceps: 'arms', forearms: 'arms', abdominals: 'core',
  quadriceps: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs', adductors: 'legs', abductors: 'legs',
  cardio: 'other', full_body: 'other', other: 'other',
};
const LIB_MUSCLE = {
  chest: 'chest', upper_back: 'middle back', lats: 'lats', lower_back: 'lower back', traps: 'traps', neck: 'neck',
  shoulders: 'shoulders', biceps: 'biceps', triceps: 'triceps', forearms: 'forearms', abdominals: 'abdominals',
  quadriceps: 'quadriceps', hamstrings: 'hamstrings', glutes: 'glutes', calves: 'calves', adductors: 'adductors', abductors: 'abductors',
};
const EQUIP = { barbell: 'barbell', dumbbell: 'dumbbell', machine: 'machine', kettlebell: 'kettlebells', resistance_band: 'bands', none: 'body only', plate: 'other', suspension: 'other', other: 'other' };
const TYPE = { weight_reps: 'weight_reps', reps_only: 'bodyweight_reps', bodyweight_reps: 'bodyweight_reps', bodyweight_weighted: 'bodyweight_reps', bodyweight_assisted: 'bodyweight_reps', duration: 'duration', distance_duration: 'distance_duration', short_distance_weight: 'distance_duration', weight_distance: 'distance_duration' };

/**
 * Both ways, for one person. `app` holds rep.'s custom exercises (cex), `db` the person's
 * store with Hevy's templates as last read, `api` their Hevy client.
 * @returns {{ toRep: number, toHevy: number }}
 */
export async function syncExercises({ app, userId, db, api, now = Date.now(), log = () => {} }) {
  const out = { toRep: 0, toHevy: 0 };
  const have = new Set(app.all('SELECT name FROM cex WHERE user_id = ?', userId).map((r) => r.name.toLowerCase()));

  // Made in Hevy: into rep.'s library, unless rep. has it (its own library or one of theirs).
  for (const t of db.hevyTemplates().filter((x) => x.custom)) {
    const key = t.title.toLowerCase();
    if (have.has(key) || libMatch(t.title)) continue;
    try {
      cexCreate(app, userId, {
        name: t.title, muscle: GROUP[t.primary] || 'other', equipment: EQUIP[t.equipment] || null, type: TYPE[t.type] || 'weight_reps',
        primary: LIB_MUSCLE[t.primary] ? [LIB_MUSCLE[t.primary]] : [],
        secondary: (t.secondary || []).map((m) => LIB_MUSCLE[m]).filter(Boolean),
        notes: 'From your Hevy library.', public: false,
      }, now);
      have.add(key);
      out.toRep += 1;
    } catch (e) { log(`hevy exercise ${t.title}: ${e.message}`); }
  }

  // Made in rep.: into Hevy, where it has nothing like it.
  const mine = app.all('SELECT name, muscle, type FROM cex WHERE user_id = ?', userId).map((r) => ({ name: r.name, muscle: r.muscle, type: r.type }));
  if (mine.length) {
    const res = await resolveTemplates({ db, api, exercises: mine, createTemplate, now });
    out.toHevy = res.made;
    if (res.missing.length) log(`hevy exercises not made: ${res.missing.slice(0, 5).join(', ')}`);
  }
  return out;
}
