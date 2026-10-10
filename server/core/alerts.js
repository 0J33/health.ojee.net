/* ============================================================
   health.ojee.net — one person's notifications: WHEN something is
   worth saying.

   This class only decides that, and says each thing once (what was
   said is kept in the person's own store, so a restart repeats
   nothing). Where it goes is not decided here: `emit` hands the
   notification to notify.js, which applies the person's switches and
   quiet hours and sends it to their devices over Web Push and to any
   open tab over /api/events.

   The types (TYPES) are the ones a person can switch on and off.
   Two of them are raised elsewhere: the workout prompts by
   workouts.js, and "passed on the leaderboard" / "new record" by
   social.js, where those facts are computed.
   ============================================================ */

import { addDays } from './util.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const TYPES = [
  { id: 'workout_start', label: 'Workout started?', description: 'Asks once when your heart rate looks like a workout has begun.', default: true },
  { id: 'workout_end', label: 'Workout ended?', description: 'Asks once when a workout looks finished, so you can save it.', default: true },
  { id: 'morning', label: 'Morning readiness', description: 'Your readiness and last night\'s sleep, once a morning.', default: true },
  { id: 'weekly', label: 'Weekly summary', description: 'The week\'s headline and next steps, once a week.', default: true },
  { id: 'step_goal', label: 'Step goal reached', description: 'When you reach your step goal for the day.', default: true },
  { id: 'leaderboard', label: 'Passed on the leaderboard', description: 'When someone passes you on this week\'s steps.', default: false },
  { id: 'record', label: 'New personal record', description: 'When you set a new best.', default: true },
  { id: 'battery', label: 'Device battery low', description: 'When your tracker is at 20% or less.', default: true },
  { id: 'connection', label: 'Google connection needs attention', description: 'When Google stops accepting the connection and syncing has stopped.', default: true },
];
export const TYPE_IDS = TYPES.map((t) => t.id);

export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? v : null;
};
const hhmm = (v, fallback) => (toMin(v) === null ? fallback : `${String(Math.floor(toMin(v) / 60)).padStart(2, '0')}:${String(toMin(v) % 60).padStart(2, '0')}`);

/** The person's notification settings: what is stored over the defaults. */
export function mergePrefs(saved = {}) {
  const types = Object.fromEntries(TYPES.map((t) => [t.id, typeof saved.types?.[t.id] === 'boolean' ? saved.types[t.id] : t.default]));
  const q = saved.quiet;
  const quiet = q && toMin(q.from) !== null && toMin(q.to) !== null && toMin(q.from) !== toMin(q.to) ? { from: hhmm(q.from), to: hhmm(q.to) } : null;
  const wk = saved.weeklyAt || {};
  return {
    types,
    quiet,
    morningAt: hhmm(saved.morningAt, '07:30'),
    weeklyAt: { day: DAYS.includes(wk.day) ? wk.day : 'sun', time: hhmm(wk.time, '18:00') },
  };
}

/** Local wall clock in a zone: { date: 'YYYY-MM-DD', dow: 'mon', min: minutes since midnight }. */
export function wall(now, tz = undefined) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const parts = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow: String(parts.weekday).slice(0, 3).toLowerCase(),
    min: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Is an instant inside the person's quiet hours (which may span midnight). */
export function inQuiet(prefs, now, tz) {
  const q = prefs?.quiet;
  if (!q) return false;
  const a = toMin(q.from); const b = toMin(q.to);
  if (a === null || b === null || a === b) return false;
  const m = wall(now, tz).min;
  return a < b ? (m >= a && m < b) : (m >= a || m < b);
}

const isoWeek = (date) => { const d = new Date(`${date}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return addDays(date, -dow); };

export class Alerts {
  /**
   * @param {object} o
   * @param {object} o.db         the person's Store (meta holds what was said, and the prefs)
   * @param {Function} o.snapshot () => { auth, sync, device, dash } — dash = dashboard()
   * @param {Function} o.emit     (type, title, body, extra) => void
   * @param {Function} o.weekly   async () => { headline, nextSteps, model, why } — the 7-day summary
   * @param {Function} o.tz       () => the person's zone (it can change)
   */
  constructor({ db, snapshot, emit, weekly = null, now = () => Date.now(), tz = () => undefined, log = () => {} }) {
    this.db = db; this.snapshot = snapshot; this.emit = emit; this.weekly = weekly;
    this.now = now; this.tzFn = typeof tz === 'function' ? tz : () => tz; this.log = log;
    this.busy = false;
  }

  prefs() { return mergePrefs(this.db.meta('notifyPrefs', {})); }
  /** Merge a partial change into the stored settings. */
  setPrefs(patch = {}) {
    const cur = this.db.meta('notifyPrefs', {});
    const next = { ...cur };
    if (patch.types && typeof patch.types === 'object') {
      next.types = { ...(cur.types || {}) };
      for (const id of TYPE_IDS) if (typeof patch.types[id] === 'boolean') next.types[id] = patch.types[id];
    }
    if (patch.quiet !== undefined) next.quiet = patch.quiet;
    if (patch.morningAt !== undefined) next.morningAt = patch.morningAt;
    if (patch.weeklyAt !== undefined) next.weeklyAt = patch.weeklyAt;
    this.db.setMeta('notifyPrefs', mergePrefs(next));
    return this.prefs();
  }
  isOn(id) { return !!this.prefs().types[id]; }
  said(key) { return this.db.meta(`said:${key}`, null); }
  remember(key, v) { this.db.setMeta(`said:${key}`, v); }

  send(type, title, body, extra = {}) {
    try { this.emit(type, title, body, extra); } catch (e) { this.log(`notify ${type}: ${e.message}`); }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.snapshot();
      const w = wall(this.now(), this.tzFn());
      this.#connection(s);
      if (!s.dash) return;
      this.#morning(s, w);
      this.#battery(s);
      this.#stepGoal(s, w);
      await this.#weekly(w);
    } finally {
      this.busy = false;
    }
  }

  #morning(s, w) {
    if (!this.isOn('morning')) return;
    const at = toMin(this.prefs().morningAt);
    if (at === null || w.min < at || this.said('morning') === w.date) return;
    // A morning message at six in the evening is not one: past the window
    // (a restart, a late deploy, the box off) the day is skipped.
    if (w.min > at + 240) { this.remember('morning', w.date); return; }
    const d = s.dash;
    const ln = d.sleep.lastNight;
    const fresh = ln && ln.date === w.date;
    // Last night may not have reached Google yet; give it up to three hours.
    if (!fresh && w.min < at + 180) return;
    const r = d.readiness;
    // A device with nothing to judge a morning by has no morning message.
    if (r.level === 'unavailable') { this.remember('morning', w.date); return; }
    this.remember('morning', w.date);
    const sleepTxt = fresh ? `Slept ${Math.floor(ln.asleepMin / 60)}h ${String(Math.round(ln.asleepMin % 60)).padStart(2, '0')}m.` : 'Last night has not synced yet.';
    this.send('morning', r.level === 'learning' ? 'Good morning' : r.label, `${r.text}. ${sleepTxt}`, { tag: `morning:${w.date}`, url: '/' });
  }

  #battery(s) {
    const b = s.device?.battery;
    if (!Number.isFinite(b)) return;
    const th = 20;
    const flagged = this.said('battery');
    // Charged again: the next low battery is a new one.
    if (b > th + 5 && flagged) { this.remember('battery', null); return; }
    if (b > th || flagged || !this.isOn('battery')) return;
    this.remember('battery', this.now());
    this.send('battery', `${s.device.name || 'Tracker'} battery ${b}%`, 'Charge it so tonight\'s sleep and heart rate are recorded.', { tag: 'battery', url: '/' });
  }

  #stepGoal(s, w) {
    if (!this.isOn('step_goal')) return;
    const d = s.dash;
    // Only the person's own today: a late sync of yesterday is old news.
    if (d.today !== w.date) return;
    const steps = d.activity.today.steps;
    const goal = d.activity.stepTarget;
    if (!Number.isFinite(steps) || !(goal > 0) || steps < goal) return;
    if (this.said('step_goal') === w.date) return;
    this.remember('step_goal', w.date);
    this.send('step_goal', 'Step goal reached', `${Math.round(steps).toLocaleString('en-US')} steps today. Your goal is ${goal.toLocaleString('en-US')}.`, { tag: `step_goal:${w.date}`, url: '/' });
  }

  #connection(s) {
    if (!this.isOn('connection')) return;
    const a = s.auth;
    if (a.state === 'expired') {
      const key = `auth:${a.expiredAt}`;
      if (this.said('connection') === key) return;
      this.remember('connection', key);
      this.send('connection', 'Google connection lost', a.testingExpiry
        ? 'Google ended the connection after 7 days. Reconnect to keep syncing.'
        : 'Google ended or revoked the connection. Reconnect to keep syncing.', { tag: 'connection', url: '/settings/connections' });
      return;
    }
    if (a.state !== 'ok') return;
    const lastOk = s.sync.lastOk;
    // A day without one good sync, and an error to show for it.
    if (lastOk && this.now() - lastOk > 24 * 3_600_000 && s.sync.lastError) {
      const key = `stale:${lastOk}`;
      if (this.said('connection') === key) return;
      this.remember('connection', key);
      this.send('connection', 'Syncing has stopped', `Nothing has synced from Google for ${Math.round((this.now() - lastOk) / 3_600_000)} hours. Open Connections to see why.`, { tag: 'connection', url: '/settings/connections' });
    }
  }

  async #weekly(w) {
    if (!this.isOn('weekly') || !this.weekly) return;
    const p = this.prefs().weeklyAt;
    const at = toMin(p.time);
    if (at === null || w.dow !== p.day || w.min < at) return;
    const week = isoWeek(w.date);
    if (this.said('weekly') === week) return;
    this.remember('weekly', week);
    if (w.min > at + 180) return;
    try {
      const r = await this.weekly();
      if (!r) return;
      const steps = (r.nextSteps || []).slice(0, 2).join(' ');
      this.send('weekly', `Your week: ${r.headline}`, steps || 'Open the summary for the details.', { tag: `weekly:${week}`, url: '/summary' });
    } catch (e) {
      this.log(`weekly: ${e.message}`);
    }
  }
}

export { DAYS };
