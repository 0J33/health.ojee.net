/* ============================================================
   health.ojee.net — the exercise library.

   876 exercises from free-exercise-db (github.com/yuhonas/free-exercise-db,
   released into the public domain under the Unlicense): name, muscles,
   equipment, level, how to do it step by step, and two photos each (the
   start and the end of the movement). The list ships with the app
   (server/library/exercises.json, trimmed from the project's
   dist/exercises.json); the photos are fetched from the project the first
   time each is shown and kept on disk after that. Another 31 common gym
   lifts it lacks (machine lateral raise, Bulgarian split squat, ...) are
   written here, in server/library/extra.json, without photos; and a lift
   is also found by the other names it goes by (AKA: "Pec Deck" is
   Butterfly, "Lat Pulldown" is Wide-Grip Lat Pulldown).

   Each exercise also gets what the logger needs: the muscle group this
   app totals by (chest, back, shoulders, arms, legs, core, other) and the
   kind of set it takes, the way Hevy names them:
     weight_reps       a weight and reps (barbell, dumbbell, cable, machine)
     bodyweight_reps   reps only (push-ups, pull-ups, jumps)
     duration          a time (planks, stretches, holds)
     distance_duration a distance and a time (cardio)
   ============================================================ */

import { readFileSync, mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const IMAGE_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises';
export const LIBRARY_SOURCE = { name: 'free-exercise-db', url: 'https://github.com/yuhonas/free-exercise-db', license: 'Unlicense (public domain)' };

const GROUP = {
  abdominals: 'core', hamstrings: 'legs', quadriceps: 'legs', adductors: 'legs', abductors: 'legs', glutes: 'legs', calves: 'legs',
  biceps: 'arms', triceps: 'arms', forearms: 'arms', shoulders: 'shoulders', traps: 'back', neck: 'shoulders',
  chest: 'chest', 'middle back': 'back', lats: 'back', 'lower back': 'back',
};
export const EQUIPMENT = ['barbell', 'dumbbell', 'cable', 'machine', 'kettlebells', 'body only', 'bands', 'e-z curl bar', 'medicine ball', 'exercise ball', 'foam roll', 'other'];
export const LIB_MUSCLES = Object.keys(GROUP);

const LOADED = ['barbell', 'dumbbell', 'cable', 'machine', 'kettlebells', 'e-z curl bar', 'medicine ball', 'bands'];
function typeOf(x) {
  if (x.category === 'cardio') return 'distance_duration';
  if (x.category === 'stretching' || x.force === 'static' || /\b(plank|hold|wall sit|hang)\b/i.test(x.name)) return 'duration';
  if (LOADED.includes(x.equipment)) return 'weight_reps';
  return 'bodyweight_reps';
}

const CAT_RANK = { strength: 3, powerlifting: 2, 'olympic weightlifting': 1, plyometrics: 1, strongman: 0, cardio: 0, stretching: -2 };
/** The everyday lifts, first when nothing is searched for. */
const COMMON = new Set(['Barbell_Bench_Press_-_Medium_Grip', 'Barbell_Squat', 'Barbell_Deadlift', 'Standing_Military_Press', 'Pullups', 'Bent_Over_Barbell_Row', 'Wide-Grip_Lat_Pulldown', 'Seated_Cable_Rows',
  'Dumbbell_Bench_Press', 'Incline_Dumbbell_Press', 'Dumbbell_Shoulder_Press', 'Side_Lateral_Raise', 'Barbell_Curl', 'Hammer_Curls', 'Triceps_Pushdown', 'Leg_Press', 'Romanian_Deadlift',
  'Lying_Leg_Curls', 'Leg_Extensions', 'Standing_Calf_Raises', 'Plank', 'Goblet_Squat', 'One-Arm_Dumbbell_Row', 'Barbell_Hip_Thrust', 'Face_Pull', 'Chin-Up', 'Dips_-_Triceps_Version', 'Pushups', 'Crunches', 'Hanging_Leg_Raise']);

/** The same lift under the names people use for it (Hevy's, gym slang), searched and matched like its own name. */
const AKA = {
  Butterfly: ['Pec Deck', 'Chest Fly (Machine)', 'Machine Fly', 'Pec Fly'],
  Leverage_Chest_Press: ['Seated Chest Press', 'Chest Press'],
  Leverage_Incline_Chest_Press: ['Incline Chest Press (Machine)', 'Incline Chest Press'],
  Thigh_Abductor: ['Hip Abduction (Machine)', 'Hip Abduction', 'Abductor Machine'],
  Thigh_Adductor: ['Hip Adduction (Machine)', 'Hip Adduction', 'Adductor Machine'],
  Pull_Through: ['Cable Pull Through', 'Cable Pull-Through'],
  One_Arm_Lat_Pulldown: ['Single Arm Lat Pulldown'],
  'Wide-Grip_Lat_Pulldown': ['Lat Pulldown', 'Lat Pulldown (Cable)', 'Lat Pull Down'],
  'Close-Grip_Front_Lat_Pulldown': ['Close Grip Lat Pulldown'],
  'Lying_T-Bar_Row': ['Chest Supported T-Bar Row'],
  'T-Bar_Row_with_Handle': ['T-Bar Row'],
  Leverage_Iso_Row: ['Iso-Lateral Row (Machine)', 'Iso-Lateral Row'],
  Leverage_High_Row: ['High Row (Machine)', 'High Row'],
  Reverse_Machine_Flyes: ['Reverse Pec Deck', 'Rear Delt Fly (Machine)', 'Rear Delt Machine'],
  Reverse_Flyes: ['Rear Delt Fly', 'Reverse Fly'],
  Dip_Machine: ['Triceps Dip (Machine)', 'Seated Dip (Machine)'],
  'Dips_-_Triceps_Version': ['Dip', 'Triceps Dip', 'Dips'],
  'Dips_-_Chest_Version': ['Chest Dip'],
  Bench_Dips: ['Bench Dip'],
  Knee_Hip_Raise_On_Parallel_Bars: ["Captain's Chair Leg Raise", "Captain's Chair"],
  Ab_Roller: ['Ab Wheel Rollout', 'Ab Wheel'],
  Air_Bike: ['Bicycle Crunch'],
  Standing_Cable_Wood_Chop: ['Woodchopper', 'Cable Woodchop', 'Wood Chop'],
  Stairmaster: ['Stair Climber', 'Stair Machine', 'StairMaster'],
  Rowing_Stationary: ['Rowing Machine', 'Rower', 'Indoor Row'],
  Bicycling_Stationary: ['Stationary Bike', 'Exercise Bike', 'Cycling (Indoor)', 'Spin Bike'],
  Elliptical_Trainer: ['Elliptical', 'Cross Trainer'],
  Running_Treadmill: ['Treadmill', 'Running', 'Treadmill Run'],
  Walking_Treadmill: ['Treadmill Walk', 'Incline Walk'],
  Rope_Jumping: ['Jump Rope', 'Skipping'],
  Cat_Stretch: ['Cat Cow'],
  'Push-Ups_-_Close_Triceps_Position': ['Diamond Push Up', 'Close Grip Push Up'],
  'Palms-Down_Wrist_Curl_Over_A_Bench': ['Reverse Wrist Curl'],
  'Seated_Palm-Up_Barbell_Wrist_Curl': ['Wrist Curl', 'Forearm Curl'],
  Side_Lateral_Raise: ['Lateral Raise', 'Lateral Raise (Dumbbell)', 'Lateral Shoulder Raise', 'Side Raise'],
  Hyperextensions_Back_Extensions: ['Back Extension', 'Hyperextension'],
  Barbell_Glute_Bridge: ['Glute Bridge'],
  'Stiff-Legged_Barbell_Deadlift': ['Stiff Leg Deadlift', 'Stiff Legged Deadlift'],
  Calf_Press_On_The_Leg_Press_Machine: ['Calf Press (Leg Press)', 'Calf Press'],
  Upright_Barbell_Row: ['Upright Row'],
  Machine_Shoulder_Military_Press: ['Shoulder Press (Machine)', 'Machine Shoulder Press'],
  Dumbbell_Shoulder_Press: ['Seated Dumbbell Shoulder Press', 'Dumbbell Overhead Press'],
  Standing_Military_Press: ['Overhead Press', 'OHP', 'Military Press'],
  Arnold_Dumbbell_Press: ['Arnold Press'],
  Front_Dumbbell_Raise: ['Front Raise'],
  Standing_Biceps_Cable_Curl: ['Cable Curl', 'Bicep Curl (Cable)'],
  Reverse_Barbell_Curl: ['Reverse Curl'],
  'Triceps_Pushdown_-_Rope_Attachment': ['Rope Pushdown', 'Triceps Rope Pushdown'],
  Cable_Rope_Overhead_Triceps_Extension: ['Overhead Cable Triceps Extension', 'Overhead Triceps Extension'],
  'EZ-Bar_Skullcrusher': ['Skull Crusher', 'Skullcrusher', 'Lying Triceps Extension'],
  'Close-Grip_Barbell_Bench_Press': ['Close Grip Bench Press'],
  Tricep_Dumbbell_Kickback: ['Triceps Kickback', 'Tricep Kickback'],
  Decline_Barbell_Bench_Press: ['Decline Bench Press'],
  'Barbell_Incline_Bench_Press_-_Medium_Grip': ['Incline Bench Press'],
  Dumbbell_Flyes: ['Dumbbell Fly', 'Chest Fly'],
  'Bent-Arm_Dumbbell_Pullover': ['Dumbbell Pullover', 'Pullover'],
  Barbell_Walking_Lunge: ['Walking Lunge'],
  Dumbbell_Lunges: ['Lunge', 'Lunges'],
  Dumbbell_Step_Ups: ['Step Up', 'Step Ups'],
  Lying_Leg_Curls: ['Leg Curl'],
  Front_Barbell_Squat: ['Front Squat'],
  Barbell_Squat: ['Squat', 'Back Squat'],
  Cable_Crossover: ['Cable Fly', 'Cable Crossover Fly'],
  Battling_Ropes: ['Battle Ropes'],
  Side_Bridge: ['Side Plank'],
  'X_Machine_Lateral_Raise': ['Lateral Raise (Machine)'],
  'X_Cable_Lateral_Raise': ['Lateral Raise (Cable)'],
  'X_Machine_Hack_Squat': ['Hack Squat (Machine)'],
  'X_Machine_Hip_Thrust': ['Hip Thrust (Machine)'],
  'X_Cable_Glute_Kickback': ['Glute Kickback (Cable)'],
  'X_Machine_Seated_Row': ['Seated Row (Machine)'],
  'X_Chest-Supported_Dumbbell_Row': ['Chest Supported Row'],
  'X_Assisted_Pull-Up': ['Assisted Pull Up', 'Assisted Chin Up'],
  'X_Bayesian_Cable_Curl': ['Bayesian Curl'],
  'X_Nordic_Hamstring_Curl': ['Nordic Curl'],
  'X_Burpee': ['Burpees'],
  'X_Jumping_Jack': ['Jumping Jacks'],
  'X_Iso-Lateral_Chest_Press': ['Iso-Lateral Chest Press', 'Hammer Strength Chest Press'],
};

/** One spelling for the "-up" lifts, in names and in what is searched: "push up", "push-ups" and "pushups" are all "pushup". */
const normUps = (s) => String(s || '').toLowerCase().replace(/\b(push|pull|chin|sit|step)[\s-]*ups?\b/g, '$1up');
const wordsOf = (s) => normUps(s).split(/[^a-z0-9]+/).filter(Boolean);

let LIB = null;
let BY_ID = null;
let BY_NAME = null;
function load() {
  if (LIB) return;
  const raw = JSON.parse(readFileSync(join(HERE, 'library', 'exercises.json'), 'utf8'));
  // Common gym lifts free-exercise-db lacks, written for this app (no photos).
  const extra = JSON.parse(readFileSync(join(HERE, 'library', 'extra.json'), 'utf8'));
  LIB = [...raw, ...extra].map((x) => {
    const names = [x.name, ...(AKA[x.id] || [])];
    return { ...x, aka: AKA[x.id] || [], group: GROUP[x.primary[0]] || 'other', type: typeOf(x), _n: x.name.toLowerCase(), _alts: names.map((n) => ({ n: wordsOf(n).join(' '), w: wordsOf(n) })) };
  });
  BY_ID = new Map(LIB.map((x) => [x.id, x]));
  BY_NAME = new Map();
  for (const x of LIB) for (const n of [x.name, ...x.aka]) { const k = n.toLowerCase(); if (!BY_NAME.has(k)) BY_NAME.set(k, x); }
}

/** What the API shows of an exercise. `full` adds the steps. */
export function libView(x, { full = false } = {}) {
  if (!x) return null;
  const out = {
    id: x.id, name: x.name, group: x.group, type: x.type, equipment: x.equipment, level: x.level, mechanic: x.mechanic, force: x.force,
    category: x.category, primary: x.primary, secondary: x.secondary, aka: x.aka, images: Array.from({ length: x.images }, (_, i) => `/api/media/exercises/${x.id}/${i}.jpg`),
  };
  if (full) out.steps = x.steps;
  return out;
}

export function libById(id) { load(); return BY_ID.get(String(id)) || null; }
export function libByName(name) { load(); return BY_NAME.get(String(name || '').trim().toLowerCase()) || null; }
/**
 * The library exercise a name most likely is: the exact name, else (for
 * names like Hevy's "Bicep Curl (Dumbbell)") the best search hit whose name
 * holds every word. Null when nothing is close.
 */
const ALIAS = {
  'bench press (barbell)': 'Barbell_Bench_Press_-_Medium_Grip', 'incline bench press (barbell)': 'Barbell_Incline_Bench_Press_-_Medium_Grip', 'bench press (dumbbell)': 'Dumbbell_Bench_Press',
  'incline bench press (dumbbell)': 'Incline_Dumbbell_Press', 'chest press (machine)': 'Machine_Bench_Press', 'chest fly (dumbbell)': 'Dumbbell_Flyes', 'cable fly crossovers': 'Cable_Crossover',
  'squat (barbell)': 'Barbell_Squat', 'front squat (barbell)': 'Front_Barbell_Squat', 'goblet squat': 'Goblet_Squat', 'leg press (machine)': 'Leg_Press', 'leg press': 'Leg_Press',
  'deadlift (barbell)': 'Barbell_Deadlift', 'romanian deadlift (barbell)': 'Romanian_Deadlift', 'romanian deadlift (dumbbell)': 'Romanian_Deadlift', 'hip thrust (barbell)': 'Barbell_Hip_Thrust',
  'lying leg curl (machine)': 'Lying_Leg_Curls', 'seated leg curl (machine)': 'Seated_Leg_Curl', 'leg extension (machine)': 'Leg_Extensions', 'standing calf raise (machine)': 'Standing_Calf_Raises',
  'seated calf raise': 'Seated_Calf_Raise', 'lunge (dumbbell)': 'Dumbbell_Lunges',
  'pull up': 'Pullups', 'pull ups': 'Pullups', 'chin up': 'Chin-Up', 'lat pulldown (cable)': 'Wide-Grip_Lat_Pulldown', 'seated cable row - v grip (cable)': 'Seated_Cable_Rows', 'seated row (cable)': 'Seated_Cable_Rows',
  'bent over row (barbell)': 'Bent_Over_Barbell_Row', 'dumbbell row': 'One-Arm_Dumbbell_Row', 'face pull': 'Face_Pull', 'shrug (barbell)': 'Barbell_Shrug', 'rear delt reverse fly (dumbbell)': 'Reverse_Flyes',
  'overhead press (barbell)': 'Standing_Military_Press', 'shoulder press (dumbbell)': 'Dumbbell_Shoulder_Press', 'seated overhead press (dumbbell)': 'Dumbbell_Shoulder_Press', 'arnold press (dumbbell)': 'Arnold_Dumbbell_Press',
  'lateral raise (dumbbell)': 'Side_Lateral_Raise', 'bicep curl (dumbbell)': 'Dumbbell_Bicep_Curl', 'bicep curl (barbell)': 'Barbell_Curl', 'hammer curl (dumbbell)': 'Hammer_Curls', 'preacher curl (barbell)': 'Preacher_Curl',
  'triceps pushdown': 'Triceps_Pushdown', 'triceps rope pushdown': 'Triceps_Pushdown_-_Rope_Attachment', 'skullcrusher (barbell)': 'EZ-Bar_Skullcrusher', 'triceps dip': 'Dips_-_Triceps_Version',
  'bench press - close grip (barbell)': 'Close-Grip_Barbell_Bench_Press', 'push up': 'Pushups', 'plank': 'Plank', 'crunch': 'Crunches', 'hanging leg raise': 'Hanging_Leg_Raise',
};

export function libMatch(name) {
  const exact = libByName(name);
  if (exact) return exact;
  const al = ALIAS[String(name || '').trim().toLowerCase()];
  if (al) return libById(al);
  const words = wordsOf(String(name || '').replace(/[()]/g, ' ').replace(/\bbicep\b/gi, 'biceps')).filter((w) => w.length > 1);
  if (!words.length) return null;
  // Strict: the hit's name has no word the given name does not, so a wrong photo is never shown.
  const hit = librarySearch({ q: words.join(' '), limit: 5 }).exercises.find((x) => [x.name, ...(x.aka || [])].some((n) => wordsOf(n).every((w) => words.includes(w) || words.includes(w.replace(/s$/, '')))));
  return hit ? libById(hit.id) : null;
}

export function libSize() { load(); return LIB.length; }

/**
 * Search by words, in any order ("press incline db" finds "Incline
 * Dumbbell Press"), narrowed by muscle group, muscle or equipment. Best
 * first: the whole name, then names that start with the words, then the
 * rest by name.
 */
export function librarySearch({ q = '', group = null, muscle = null, equipment = null, limit = 40, offset = 0 } = {}) {
  load();
  const words = wordsOf(String(q || '').toLowerCase().replace(/\bdb\b/g, 'dumbbell').replace(/\bbb\b/g, 'barbell'));
  const needle = words.join(' ');
  const hits = [];
  for (const x of LIB) {
    if (group && x.group !== group) continue;
    if (muscle && !x.primary.includes(muscle) && !x.secondary.includes(muscle)) continue;
    if (equipment && (x.equipment || 'other') !== equipment) continue;
    let score = 0;
    if (words.length) {
      // Its own name or any other name it goes by; the best of them counts.
      let best = null;
      for (const alt of x._alts) {
        let sc = 0; let ok = true;
        for (const w of words) {
          if (alt.w.includes(w)) sc += 3;
          else if (alt.w.some((y) => y.startsWith(w))) sc += 2;
          else if (alt.n.includes(w) || (w.length > 3 && alt.n.includes(w.replace(/s$/, '')))) sc += 1;
          else { ok = false; break; }
        }
        if (!ok) continue;
        if (alt.n === needle) sc += 100;
        else if (alt.n.startsWith(needle)) sc += 20;
        sc -= alt.n.length / 100;   // the plainer name first
        if (best === null || sc > best) best = sc;
      }
      if (best === null) continue;
      score = best;
      if (x.primary.some((m) => words.includes(m))) score += 2;
    } else {
      // Browsing: the lifts people log most come first, stretches last.
      score = (CAT_RANK[x.category] ?? 0) + (x.mechanic === 'compound' ? 1 : 0) + (x.level === 'expert' ? -1 : 0) + (COMMON.has(x.id) ? 5 : 0);
    }
    hits.push([score, x]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  return { total: hits.length, exercises: hits.slice(offset, offset + limit).map(([, x]) => libView(x)) };
}

/**
 * The photos, kept on disk after the first time. `get` resolves to the
 * JPEG bytes, or null when there is no such photo.
 */
export class ExerciseImages {
  constructor({ dir, fetchImpl = globalThis.fetch, base = IMAGE_BASE } = {}) {
    this.dir = dir; this.fetch = fetchImpl; this.base = base;
    this.inflight = new Map();
    this.mem = new Map();   // without a directory (tests, :memory:): a small cache
  }

  async get(id, n) {
    const x = libById(id);
    if (!x || !Number.isInteger(n) || n < 0 || n >= x.images) return null;
    const key = `${x.id}/${n}`;
    const file = this.dir ? join(this.dir, x.id, `${n}.jpg`) : null;
    if (file && existsSync(file)) return readFileSync(file);
    if (!file && this.mem.has(key)) return this.mem.get(key);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const run = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      timer.unref?.();
      try {
        const res = await this.fetch(`${this.base}/${encodeURIComponent(x.id)}/${n}.jpg`, { signal: ctl.signal });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf.length > 2 * 1024 * 1024) return null;
        if (file) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(`${file}.part`, buf);
          renameSync(`${file}.part`, file);
        } else {
          if (this.mem.size > 200) this.mem.delete(this.mem.keys().next().value);
          this.mem.set(key, buf);
        }
        return buf;
      } catch { return null; } finally { clearTimeout(timer); this.inflight.delete(key); }
    })();
    this.inflight.set(key, run);
    return run;
  }
}
