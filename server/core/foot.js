/* Runs and walks logged as exercises in a workout: the treadmill in a gym session (from Hevy or
   logged here), or a "Running" / "Walking" exercise. They count as runs and walks
   (history.js, social.js) however old the workout is: it is read from the sets each time. */

const NOT = /lunge|farmer|carry|bear|crab|duck|plank|hand|overhead|suitcase|sled|knee|lateral|band|monster/;
const MACHINE = /cycl|bike|spin|row(ing)?\b|rower|erg\b|elliptical|cross ?trainer|stair|step ?mill|swim|ski ?erg|air ?bike|assault/;

/** 'run' | 'walk' | null for one exercise, by its name and, for a plain "Treadmill", its pace. */
export function footKind(name, { distanceM = 0, durationS = 0 } = {}) {
  const n = String(name || '').toLowerCase();
  if (!n || NOT.test(n)) return null;
  if (/treadmill/.test(n)) {
    if (/run|jog|sprint/.test(n)) return 'run';
    if (/walk|incline|hike/.test(n)) return 'walk';
    // Plain "Treadmill": 7.5 km/h and faster is a run; no numbers, a walk.
    if (distanceM > 0 && durationS > 0) return distanceM / durationS * 3.6 >= 7.5 ? 'run' : 'walk';
    return 'walk';
  }
  if (/^(running|run|jogging|jog|indoor run|trail run)\b/.test(n)) return 'run';
  if (/^(walking|walk|hiking|hike|incline walk|power walk)\b/.test(n)) return 'walk';
  return null;
}

/** Any cardio exercise: on foot, or a machine (bike, rower, elliptical, stairs, swim). */
export const isCardioExercise = (name) => Boolean(footKind(name)) || MACHINE.test(String(name || '').toLowerCase());
