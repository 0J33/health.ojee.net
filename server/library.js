/* ============================================================
   health.ojee.net — the exercise library.

   876 exercises from free-exercise-db (github.com/yuhonas/free-exercise-db,
   released into the public domain under the Unlicense): name, muscles,
   equipment, level, how to do it step by step, and two photos each (the
   start and the end of the movement). The list ships with the app
   (server/library/exercises.json, trimmed from the project's
   dist/exercises.json); the photos are fetched from the project the first
   time each is shown and kept on disk after that.

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

let LIB = null;
let BY_ID = null;
let BY_NAME = null;
function load() {
  if (LIB) return;
  const raw = JSON.parse(readFileSync(join(HERE, 'library', 'exercises.json'), 'utf8'));
  LIB = raw.map((x) => ({ ...x, group: GROUP[x.primary[0]] || 'other', type: typeOf(x), _n: x.name.toLowerCase(), _w: x.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) }));
  BY_ID = new Map(LIB.map((x) => [x.id, x]));
  BY_NAME = new Map(LIB.map((x) => [x._n, x]));
}

/** What the API shows of an exercise. `full` adds the steps. */
export function libView(x, { full = false } = {}) {
  if (!x) return null;
  const out = {
    id: x.id, name: x.name, group: x.group, type: x.type, equipment: x.equipment, level: x.level, mechanic: x.mechanic, force: x.force,
    category: x.category, primary: x.primary, secondary: x.secondary, images: Array.from({ length: x.images }, (_, i) => `/api/media/exercises/${x.id}/${i}.jpg`),
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
  const words = String(name || '').toLowerCase().replace(/[()]/g, ' ').replace(/\bbicep\b/g, 'biceps').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (!words.length) return null;
  // Strict: the hit's name has no word the given name does not, so a wrong photo is never shown.
  const hit = librarySearch({ q: words.join(' '), limit: 5 }).exercises.find((x) => x.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).every((w) => words.includes(w) || words.includes(w.replace(/s$/, ''))));
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
  const words = String(q || '').toLowerCase().replace(/\bdb\b/g, 'dumbbell').replace(/\bbb\b/g, 'barbell').replace(/\b(push|pull)[\s-]*ups?\b/g, '$1ups').replace(/\b(chin|sit)[\s-]*ups\b/g, '$1 up').split(/[^a-z0-9]+/).filter(Boolean);
  const needle = words.join(' ');
  const hits = [];
  for (const x of LIB) {
    if (group && x.group !== group) continue;
    if (muscle && !x.primary.includes(muscle) && !x.secondary.includes(muscle)) continue;
    if (equipment && (x.equipment || 'other') !== equipment) continue;
    let score = 0;
    if (words.length) {
      let ok = true;
      for (const w of words) {
        if (x._w.includes(w)) score += 3;
        else if (x._w.some((y) => y.startsWith(w))) score += 2;
        else if (x._n.includes(w) || (w.length > 3 && x._n.includes(w.replace(/s$/, '')))) score += 1;
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (x._n === needle) score += 100;
      else if (x._n.startsWith(needle)) score += 20;
      if (x.primary.some((m) => words.includes(m))) score += 2;
      score -= x._n.length / 100;   // the plainer name first
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
