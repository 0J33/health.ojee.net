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

   Two depend on what the person's device reports (availability):
   the illness early warning needs one of the signals the flag is
   made from, and the sitting nudge needs steps through the day. The
   nudge is also the only one that needs fresher data than the
   20-minute sync: the scheduler reads the recent step windows for
   the people who switched it on, inside their hours, and hands them
   to readSteps(). Judging never touches the network.
   ============================================================ */

import { addDays } from './util.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const TYPES = [
  { id: 'workout_start', label: 'Workout started?', description: 'Asks once when your heart rate looks like a workout has begun.', default: true },
  { id: 'workout_end', label: 'Workout ended?', description: 'Asks once when a workout looks finished, so you can save it.', default: true },
  { id: 'morning', label: 'Morning readiness', description: 'Your readiness and last night\'s sleep, once a morning.', default: true },
  { id: 'illness', label: 'Illness early warning', description: 'Once a day when your resting heart rate or sleep temperature has stayed above your usual.', default: true },
  { id: 'weekly', label: 'Weekly summary', description: 'The week\'s headline and next steps, once a week.', default: true },
  { id: 'step_goal', label: 'Step goal reached', description: 'When you reach your step goal for the day.', default: true },
  { id: 'sitting', label: 'Sitting nudge', description: 'During the hours you choose, when you have taken few steps in the last hour. At most once an hour.', default: false },
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

/** The sitting nudge: when it may speak, and under how many steps an hour. */
export const SITTING_DEFAULTS = { from: '09:00', to: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], threshold: 250 };
export const SITTING_LIMITS = { threshold: { min: 50, max: 2000, step: 50 } };
/** Step data older than this cannot say how the last hour went. */
export const SITTING_STALE_MS = 20 * 60_000;

function mergeSitting(s) {
  const d = SITTING_DEFAULTS;
  const from = hhmm(s?.from, d.from); const to = hhmm(s?.to, d.to);
  const ordered = toMin(from) < toMin(to);
  const days = Array.isArray(s?.days) ? DAYS.filter((x) => s.days.includes(x)) : [];
  const th = Math.round(Number(s?.threshold));
  const { min, max } = SITTING_LIMITS.threshold;
  return {
    from: ordered ? from : d.from, to: ordered ? to : d.to,
    days: days.length ? days : [...d.days],
    threshold: Number.isFinite(th) && th >= min && th <= max ? th : d.threshold,
  };
}

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
    sitting: mergeSitting(saved.sitting),
  };
}

/**
 * Which types this person's device can carry: { id: { available, reason } }.
 * `intraday` is what a look at Google said about steps through the day:
 * true, false, or null when nobody has looked.
 */
export function availability(caps = {}, { connected = true, intraday = null } = {}) {
  const out = Object.fromEntries(TYPES.map((t) => [t.id, { available: true, reason: null }]));
  const no = (id, reason) => { out[id] = { available: false, reason }; };
  if (!connected) {
    no('illness', 'Connect Google Health to use the illness early warning');
    no('sitting', 'Connect Google Health to use the sitting nudge');
    return out;
  }
  if (!(caps.restingHr || caps.hrv || caps.skinTemp)) no('illness', 'Needs resting heart rate, HRV or sleep temperature, which your device does not report');
  if (!caps.steps) no('sitting', 'Needs steps, and none are arriving from your device');
  else if (intraday === false) no('sitting', 'Needs steps through the day, and your device only reports a daily total');
  return out;
}

/**
 * Steps in the 60 minutes up to `end`, from 15-minute roll-up windows.
 * Windows partly inside count in proportion.
 */
export function stepsInHour(windows, end) {
  const start = end - 3_600_000;
  let n = 0;
  for (const w of windows || []) {
    const a = Math.max(start, w.start); const b = Math.min(end, w.end);
    if (b > a && w.end > w.start) n += w.steps * ((b - a) / (w.end - w.start));
  }
  return Math.round(n);
}

/**
 * May the sitting nudge speak right now: switched on, one of the person's
 * days, inside their hours, and not in quiet hours. Also what decides
 * whether their step windows are worth reading at all.
 */
export function sittingActive(prefs, now, tz) {
  if (!prefs?.types?.sitting) return { active: false, state: 'off', note: null };
  const p = prefs.sitting || SITTING_DEFAULTS;
  const w = wall(now, tz);
  const from = toMin(p.from); const to = toMin(p.to);
  if (!(p.days || []).includes(w.dow) || from === null || to === null || w.min < from || w.min >= to) return { active: false, state: 'outside', note: 'outside your hours' };
  if (inQuiet(prefs, now, tz)) return { active: false, state: 'quiet', note: 'quiet hours' };
  return { active: true, state: 'on', note: null };
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
   * @param {Function} o.intraday async (fromMs, toMs) => { windows: [{ start, end, steps }], device }
   *
   * snapshot() may also carry `avail` (availability()) and `workout`
   * (true while a workout is running): both are honoured when present.
   */
  constructor({ db, snapshot, emit, weekly = null, intraday = null, now = () => Date.now(), tz = () => undefined, log = () => {} }) {
    this.db = db; this.snapshot = snapshot; this.emit = emit; this.weekly = weekly;
    this.now = now; this.tzFn = typeof tz === 'function' ? tz : () => tz; this.log = log;
    this.busy = false;
    this.intraday = intraday;
    this.sitting = { windows: [], fetchedAt: 0, asOf: null, upTo: null, steps: null, state: 'off', note: null };
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
    if (patch.sitting && typeof patch.sitting === 'object') next.sitting = { ...mergeSitting(cur.sitting), ...patch.sitting };
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
      this.#illness(s);
      this.#sitting(s, w);
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

  /**
   * Once per day the flag is raised. The words say what changed and
   * suggest an easy day; they name no condition.
   */
  #illness(s) {
    if (!this.isOn('illness')) return;
    if (s.avail && !s.avail.illness?.available) return;
    const d = s.dash;
    const ill = d.illness;
    if (!ill?.flag || !d.verdictDay) return;
    // Numbers from days ago are not news about today.
    if (Number.isFinite(d.stale) && d.stale > 1) return;
    if (this.said('illness') === d.verdictDay) return;
    this.remember('illness', d.verdictDay);
    const what = (ill.reasons || []).join('; ');
    const body = what ? `${what[0].toUpperCase()}${what.slice(1)}. It may be worth taking it easy today.` : 'Some of your numbers are away from your usual. It may be worth taking it easy today.';
    this.send('illness', 'Your body looks under strain', body, { tag: `illness:${d.verdictDay}`, url: '/' });
  }

  /**
   * Read the recent step windows from Google (the scheduler calls this,
   * about every 15 minutes, only for people whose nudge may speak now).
   * How fresh the reading is: the tracker's last sync with the phone, or
   * the newest quarter-hour that has steps in it, whichever is later.
   * Somebody with no paired tracker who has not moved at all looks the
   * same as a phone that has not synced, so for them it stays silent.
   */
  async readSteps() {
    if (!this.intraday) return null;
    const now = this.now();
    const st = this.sitting;
    const r = await this.intraday(now - 2 * 3_600_000, now);
    const windows = r?.windows || [];
    const moved = windows.filter((x) => x.steps > 0);
    const synced = r?.device?.lastSync || 0;
    // A quarter-hour with steps in it proves data as new as its start, and
    // the hour can be counted up to its end.
    const asOf = Math.min(now, Math.max(synced, ...moved.map((x) => x.start)));
    const upTo = Math.min(now, Math.max(synced, ...moved.map((x) => x.end)));
    st.windows = windows; st.fetchedAt = now; st.asOf = asOf > 0 ? asOf : null; st.upTo = upTo > 0 ? upTo : null;
    return st;
  }

  #sitting(s, w) {
    const st = this.sitting;
    const set = (state, note = null) => { st.state = state; st.note = note; };
    const prefs = this.prefs();
    if (!prefs.types.sitting) { st.steps = null; set('off'); return; }
    if (s.avail && !s.avail.sitting?.available) { st.steps = null; set('unavailable', s.avail.sitting?.reason || null); return; }
    const now = this.now();
    const act = sittingActive(prefs, now, this.tzFn());
    if (!act.active) { set(act.state, act.note); return; }
    if (s.workout) { set('workout', 'a workout is running'); return; }
    if (!st.fetchedAt || now - st.fetchedAt > SITTING_STALE_MS) { st.steps = null; set('waiting', 'waiting for the next step reading'); return; }
    // It cannot know how an hour went from data that stops before it.
    if (!st.asOf || now - st.asOf > SITTING_STALE_MS) { st.steps = null; set('stale', st.asOf ? 'the newest step data is over 20 minutes old' : 'no recent step data'); return; }
    const end = Math.min(st.upTo || st.asOf, now);
    st.steps = stepsInHour(st.windows, end);
    const p = prefs.sitting;
    // Not in the first hour of the window: there is no hour to judge yet.
    if (w.min < toMin(p.from) + 60) { set('warming', 'first hour of your window'); return; }
    if (st.steps >= p.threshold) { set('ok'); return; }
    set('low');
    if (now - (this.said('sitting') || 0) < 3_600_000) return;
    this.remember('sitting', now);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: this.tzFn() || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(end));
    this.send('sitting', 'Time to stand up', `${st.steps.toLocaleString('en-US')} ${st.steps === 1 ? 'step' : 'steps'} in the hour to ${clock}. A few minutes on your feet would break it up.`, { tag: 'sitting', url: '/' });
  }

  /** What the settings page shows about the nudge, and why it is silent. */
  view() {
    const st = this.sitting;
    return { state: st.state, steps: st.steps, asOf: st.asOf, note: st.note, checkedAt: st.fetchedAt || null };
  }

  /** One battery notice per tracker: with two accounts, each device's own.
      The first account's keeps the key it always had. */
  #battery(s) {
    const many = (s.accounts || []).filter((a) => a.device).length > 1;
    const list = many ? s.accounts.filter((a) => a.device).map((a) => ({ d: a.device, key: a.id === 'main' ? 'battery' : `battery:${a.id}` })) : [{ d: s.device, key: 'battery' }];
    for (const { d, key } of list) {
      const b = d?.battery;
      if (!Number.isFinite(b)) continue;
      const th = 20;
      const flagged = this.said(key);
      // Charged again: the next low battery is a new one.
      if (b > th + 5 && flagged) { this.remember(key, null); continue; }
      if (b > th || flagged || !this.isOn('battery')) continue;
      this.remember(key, this.now());
      this.send('battery', `${d.name || 'Tracker'} battery ${b}%`, 'Charge it so tonight\'s sleep and heart rate are recorded.', { tag: key, url: '/' });
    }
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

  /** Per account: its connection lost, or a day without one good sync.
      The first account keeps the key it always had. */
  #connection(s) {
    if (!this.isOn('connection')) return;
    const list = s.accounts?.length > 1 ? s.accounts : [{ id: 'main', auth: s.auth, sync: s.sync, multi: false }];
    for (const a of list) {
      const key = a.id === 'main' || !a.multi ? 'connection' : `connection:${a.id}`;
      const which = a.multi ? ` (${a.label || a.auth.email || 'another account'})` : '';
      const st = a.auth;
      if (st.state === 'expired') {
        const mark = `auth:${st.expiredAt}`;
        if (this.said(key) === mark) continue;
        this.remember(key, mark);
        this.send('connection', `Google connection lost${which}`, st.testingExpiry
          ? 'Google ended the connection after 7 days. Reconnect to keep syncing.'
          : 'Google ended or revoked the connection. Reconnect to keep syncing.', { tag: key, url: '/settings/connections' });
        continue;
      }
      if (st.state !== 'ok') continue;
      const lastOk = a.sync.lastOk;
      // A day without one good sync, and an error to show for it.
      if (lastOk && this.now() - lastOk > 24 * 3_600_000 && a.sync.lastError) {
        const mark = `stale:${lastOk}`;
        if (this.said(key) === mark) continue;
        this.remember(key, mark);
        this.send('connection', `Syncing has stopped${which}`, `Nothing has synced from Google for ${Math.round((this.now() - lastOk) / 3_600_000)} hours. Open Connections to see why.`, { tag: key, url: '/settings/connections' });
      }
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
