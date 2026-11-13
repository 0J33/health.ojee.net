/* ============================================================
   health.ojee.net — work hours: when the watch's own guesses are not workouts.

   Somebody whose work is physical (construction, a warehouse, a kitchen)
   has a watch that "recognises" a workout most working days: volleyball,
   strength training, a walk. Those sessions are real effort, and their
   steps, active minutes, distance and calories still count, in the day's
   totals as always; they are just not workouts. With work hours set:

     - a session the watch recorded by itself (Google says PASSIVELY_MEASURED,
       or says nothing) whose middle falls in work hours is left out of the
       workouts everywhere they are listed or counted (history.js unified:
       History, the feed, boards, medals, training, the AI; the weekly
       summary; going to Hevy);
     - one started on purpose (ACTIVELY_MEASURED, MANUAL, logged by hand)
       stays a workout;
     - rep.'s own detector asks nothing in work hours.

   Kept in the person's store (meta `workHours`): { on, days, from, to, tz }.
   ============================================================ */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** The setting as kept, cleaned; null when it is off. */
export function workHoursOf(db) {
  const w = db.meta('workHours', null);
  return w && w.on ? w : null;
}

/** Clean what the page sends. */
export function normWorkHours(b, tz) {
  const days = Array.isArray(b.days) ? DAYS.filter((d) => b.days.includes(d)) : ['sun', 'mon', 'tue', 'wed', 'thu'];
  const from = toMin(b.from) === null ? '08:00' : b.from;
  const to = toMin(b.to) === null ? '17:00' : b.to;
  if (b.on && !days.length) throw Object.assign(new Error('Pick at least one work day.'), { status: 400, expose: true });
  if (toMin(from) === toMin(to)) throw Object.assign(new Error('Work starts and ends at the same time.'), { status: 400, expose: true });
  return { on: b.on === true, days, from, to, tz: tz || 'UTC' };
}

const parts = (ms, tz) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t) => f.find((x) => x.type === t)?.value;
  return { day: String(get('weekday')).slice(0, 3).toLowerCase(), min: Number(get('hour')) * 60 + Number(get('minute')) };
};

/** Is this moment inside work hours (a shift past midnight belongs to the day it started)? */
export function atWork(wh, ms) {
  if (!wh?.on) return false;
  let p;
  try { p = parts(ms, wh.tz || 'UTC'); } catch { return false; }
  const a = toMin(wh.from); const b = toMin(wh.to);
  if (a < b) return wh.days.includes(p.day) && p.min >= a && p.min < b;
  // Overnight: from the start on a work day, or until the end on the morning after one.
  const prev = DAYS[(DAYS.indexOf(p.day) + 6) % 7];
  return (wh.days.includes(p.day) && p.min >= a) || (wh.days.includes(prev) && p.min < b);
}

/** A watch session that work hours turn back into plain activity. */
export function hiddenAtWork(e, wh) {
  if (!wh?.on || !e) return false;
  if (e.method === 'ACTIVELY_MEASURED' || e.method === 'MANUAL') return false;
  if (/by hand/i.test(String(e.device || ''))) return false;
  return atWork(wh, (e.startMs + e.endMs) / 2);
}
