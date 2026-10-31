/* ============================================================
   health.ojee.net — the Log sheet: one place to log anything.

   GET /api/log is everything the sheet needs in one reply, so it opens
   at once from any page:

     kinds     every kind that can be logged, in the order people reach
               for them: whether it can be logged now (and where it is
               kept), the metric it shows up under, and its last entry
     today     the running totals a log is usually checking: water
               against its goal, food (calories and macros), the last
               weigh-in
     recent    the last things logged here, to fix or remove one
     routines  Hevy routines to start a workout from, when Hevy is linked

   The forms themselves are each metric's own (GET /api/metric/<id>
   `add`): nothing here duplicates a field or a limit.
   ============================================================ */

import { metricById } from './catalog.js';
import { addOf, textOfSample, entryView } from './browse.js';
import { KINDS } from './core/entries.js';
import { localToMs, addDays, today as todayIn, utcOffsetSec } from './core/util.js';

/** The tiles, in order: [id, metric, label, group of tiles]. `workout` is the workouts page's own. */
const TILES = [
  ['workout', null, 'Workout', 'Move'],
  ['water', 'water', 'Water', 'Eat and drink'],
  ['food', 'food', 'Food', 'Eat and drink'],
  ['weight', 'weight', 'Weight', 'Body'],
  ['bodyfat', 'body_fat', 'Body fat', 'Body'],
  ['measure', 'measurements', 'Measurements', 'Body'],
  ['height', 'height', 'Height', 'Body'],
  ['sleep', 'sleep', 'Sleep', 'Rest'],
  ['mood', 'mood', 'Mood', 'Mind'],
  ['stress', 'stress', 'Stress', 'Mind'],
  ['glucose', 'glucose', 'Blood glucose', 'Vitals'],
  ['bodytemp', 'body_temp', 'Temperature', 'Vitals'],
  ['symptom', 'symptoms', 'Symptoms', 'Mind'],
  ['period', 'period', 'Period', 'Cycle'],
  ['ovulation', 'ovulation', 'Ovulation test', 'Cycle'],
];

const r1 = (v) => Math.round(v * 10) / 10;
const kgText = (g) => `${r1(g / 1000)} kg`;

/**
 * @param {UserWorld} w
 * @param {object} o
 * @param {Array} o.routines     Hevy routines (hevysync), or []
 * @param {boolean} o.hevy       Hevy is linked
 * @param {object} o.goals       the person's goals (views.goalsView)
 */
export function logView(w, { routines = [], hevy = false, goals = {}, now = Date.now() } = {}) {
  const db = w.db;
  const tz = w.tz;
  const today = todayIn(now, tz);
  const dayStart = localToMs(today, 0, tz);
  const dayEnd = localToMs(addDays(today, 1), 0, tz);

  const lastOf = (kind) => db.samples(kind, { toMs: now + 1, limit: 1 })[0] || null;
  const weights = db.weights(now - 400 * 86_400_000);
  const lastWeight = weights.length ? weights[weights.length - 1] : null;

  const kinds = TILES.map(([id, metricId, label, group]) => {
    if (id === 'workout') {
      const last = db.workoutsDone(Number.MAX_SAFE_INTEGER, 1)[0] || null;
      const running = w.workouts.running();
      return {
        id, label, group, metric: null, icon: 'exercise', available: true, mode: 'local',
        last: last ? { text: last.title || 'Workout', at: last.start } : null,
        running: running ? { id: running.id, start: running.start } : null,
      };
    }
    const m = metricById(metricId);
    const add = addOf(w, m);
    let last = null;
    if (id === 'weight') last = lastWeight ? { text: kgText(lastWeight.grams), at: lastWeight.t } : null;
    else { const r = lastOf(id); if (r) last = { text: textOfSample(r), at: r.t }; }
    return {
      id, label, group, metric: m.id, icon: m.icon, family: m.family,
      available: !!add?.available, mode: add?.mode || 'off', note: add?.note || null, needs: add?.available ? null : (add?.group || KINDS[id]?.group || null),
      last,
    };
  });

  // Today's running totals.
  const dayRows = (kind) => db.samples(kind, { fromMs: dayStart, toMs: dayEnd, limit: 500 });
  const water = dayRows('water').reduce((a, r) => a + (r.value || 0), 0);
  const foods = dayRows('food');
  const sum = (k) => r1(foods.reduce((a, r) => a + (Number(k === 'kcal' ? r.value : r.data?.[k]) || 0), 0));
  const todayView = {
    date: today,
    water: { ml: Math.round(water), goal: goals.waterMl ?? goals.waterTarget ?? null },
    food: { kcal: sum('kcal'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat'), items: foods.length },
    weight: lastWeight ? { kg: r1(lastWeight.grams / 1000), at: lastWeight.t } : null,
  };

  // What was logged here lately, newest first.
  const recent = [];
  for (const kind of Object.keys(KINDS)) {
    for (const r of db.samples(kind, { fromMs: now - 14 * 86_400_000, toMs: now + 1, limit: 20 })) {
      if (r.source !== 'app') continue;
      const e = entryView(w, r);
      recent.push({ id: e.id, kind: r.kind, metric: e.metric, text: e.text, t: r.t, editable: e.editable, deletable: e.deletable, google: e.google, fields: e.fields });
    }
  }
  for (const x of weights.filter((x) => x.source === 'app' && x.t >= now - 14 * 86_400_000)) {
    recent.push({ id: `w-${x.t}`, kind: 'weight', metric: 'weight', text: kgText(x.grams), t: x.t, editable: false, deletable: false, google: null, fields: null });
  }
  recent.sort((a, b) => b.t - a.t);

  return {
    today: todayView,
    kinds,
    recent: recent.slice(0, 12),
    hevy,
    routines: routines.map((r) => ({ id: r.id, title: r.title, folder: r.folder, exercises: r.exercises.length, sets: r.exercises.reduce((n, x) => n + x.sets.length, 0) })),
    tzOffsetMin: Math.round(utcOffsetSec(now, tz) / 60),
  };
}
