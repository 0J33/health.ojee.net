/* ============================================================
   health.ojee.net — per-person worlds.

   The single-user module had one store, one Google connection, one
   poller, one workout machine. Here each person gets their own set,
   a UserWorld, over their own folder:

     data/users/<mongoUserId>/health.sqlite   their data
     data/users/<mongoUserId>/google.json     their refresh token (0600)

   Worlds are opened on demand and kept in a small LRU, so a hundred
   people do not mean a hundred open databases. A world that is in
   use (a request, a sync) is `held` and never evicted mid-flight.

   Isolation is structural: a route gets the world of the signed-in
   person's id and nothing else; there is no function here that takes
   a username or opens "someone else's" world for a reader. What
   other people may see goes through the public tables (social.js).
   ============================================================ */

import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { openDb } from './core/db.js';
import { GoogleHealth, SCOPES, GROUPS, GROUP_IDS, cleanGroups, shortScope } from './core/google.js';
import { Sync } from './core/sync.js';
import { Workouts, EXERCISE_TYPE, EXERCISE_TYPES } from './core/workouts.js';
import { Alerts, availability } from './core/alerts.js';
import { detectSettings, minuteSeries, DETECT_DEFAULTS } from './core/detect.js';
import { parseHrWindows, parseStepWindows, pickDevice } from './core/parse.js';
import { dashboard } from './core/metrics.js';
import { today as todayIn, addDays, num } from './core/util.js';
import { readCaps } from './caps.js';

export const validUserId = (id) => /^[a-f0-9]{24}$/.test(String(id));

export const GOAL_DEFAULTS = { stepTarget: 8000, azmTarget: 22, sleepTarget: 450 };

export class UserWorld {
  /**
   * @param {object} o
   * @param {string} o.userId
   * @param {string} o.dir          this person's folder
   * @param {string} o.tz           their zone
   * @param {object} o.google       { clientId, clientSecret, redirectUri, fetchImpl, endpoints }
   * @param {Function} o.onChange   (what[]) => void — tell their open tabs
   * @param {Function} o.notify     (type, title, body, extra) => void
   * @param {Function} o.weekly     async () => the 7-day summary, for the weekly notification
   */
  constructor({ userId, dir, tz, google, onChange = () => {}, notify = () => {}, weekly = null, now = () => Date.now(), log = () => {}, memory = false }) {
    this.userId = userId;
    this.dir = dir;
    this.tz = tz;
    this.now = now;
    this.held = 0;
    this.usedAt = now();
    this.db = openDb(memory ? ':memory:' : join(dir, 'health.sqlite'));
    this.google = new GoogleHealth({ ...google, tokenFile: memory ? undefined : join(dir, 'google.json'), now });
    this.sync = new Sync({
      google: this.google, db: this.db, tz, now, auto: false, gapMs: google.gapMs ?? 150,
      groups: () => this.groups(),
      log: { warn: (m) => log(`${userId.slice(-6)}${m}`) },
    });
    this.alerts = new Alerts({
      db: this.db, now, tz: () => this.tz, log, weekly,
      emit: notify,
      intraday: (from, to) => this.intraday(from, to),
      snapshot: () => ({
        auth: this.google.status(),
        sync: this.sync.state,
        device: this.db.meta('device'),
        avail: this.notifyAvailability(),
        workout: this.workouts.open().some((r) => r.status === 'running' || r.status === 'ongoing'),
        dash: this.google.connected() ? dashboard(this.db, { today: todayIn(now(), this.tz), days: 7, settings: this.settings(), caps: readCaps(this.db).caps }) : null,
      }),
    });
    this.workouts = new Workouts({
      db: this.db, now, tz, log,
      api: this.#api(),
      settings: () => this.detection(),
      rest: () => this.rest(),
      external: (fromMs) => this.external(fromMs),
      emit: notify,
      notifyOn: (id) => this.alerts.isOn(id),
      canWrite: () => this.google.connected() && this.google.granted(SCOPES.activityWrite),
      exerciseType: () => this.exerciseType(),
      onChange: () => onChange(['workouts']),
    });
  }

  setTz(tz) { this.tz = tz; this.sync.tz = tz; this.workouts.tz = tz; }

  /** Goals. Kept in the person's own store: they are nobody else's business. */
  settings() { return { ...GOAL_DEFAULTS, ...this.db.meta('settings', {}) }; }
  setSettings(patch) { this.db.setMeta('settings', { ...this.settings(), ...patch }); }

  /**
   * The optional groups this person has switched on: `{ nutrition: bool, … }`.
   * Their CHOICE, kept in their own store, apart from what Google granted:
   * a group is usable when it is chosen AND its scopes are granted, and one
   * switched off stops at once (its streams are skipped, its entries
   * refused) even while Google still holds the scope.
   */
  groups() {
    const g = this.db.meta('groups', {}) || {};
    return Object.fromEntries(GROUP_IDS.map((id) => [id, g[id] === true]));
  }
  /** Switch groups on or off: `{ cycle: true }`, or a list of ids to switch on. */
  setGroups(patch) {
    const next = this.groups();
    if (Array.isArray(patch) || typeof patch === 'string') for (const id of cleanGroups(patch)) next[id] = true;
    else for (const id of GROUP_IDS) if (typeof patch?.[id] === 'boolean') next[id] = patch[id];
    this.db.setMeta('groups', next);
    return next;
  }
  /** Each group as the page shows it: chosen, granted, and usable (both). */
  groupsView() {
    const on = this.groups();
    const ok = this.google.connected();
    return GROUPS.map((g) => {
      const granted = ok && this.google.groupGranted(g.id);
      return { id: g.id, label: g.label, about: g.about, scopes: g.scopes.map(shortScope), chosen: on[g.id], granted, usable: on[g.id] && granted, readOnly: g.readOnly, note: g.note };
    });
  }

  /** Detection is opt-in: off until the person switches it on. */
  detection() { return detectSettings({ ...DETECT_DEFAULTS, enabled: false, ...this.db.meta('workoutSettings', {}) }); }
  setDetection(patch) { this.db.setMeta('workoutSettings', detectSettings({ ...this.detection(), ...patch })); return this.detection(); }

  exerciseType() { const t = this.db.meta('exerciseType'); return EXERCISE_TYPES[t] ? t : EXERCISE_TYPE; }

  /** Resting heart rate the detector measures against: the mean of the last
      30 days' daily resting HR, 70 until there is any. */
  rest() {
    const tbl = this.db.dailyTable(addDays(todayIn(this.now(), this.tz), -30));
    const v = Object.values(tbl).map((x) => x.rhr).filter(Number.isFinite);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 70;
  }

  /** What is already accounted for: Google's exercise sessions and sleep. */
  external(fromMs) {
    const from = todayIn(fromMs - 86_400_000, this.tz);
    return [
      ...this.db.exercises(from).map((e) => ({ start: e.startMs, end: e.endMs, kind: 'exercise', id: e.id, type: e.type, name: e.name || e.type })),
      ...this.db.sleeps(from).map((x) => ({ start: x.startMs, end: x.endMs, kind: 'sleep', id: x.id })),
    ];
  }

  /** Minute-by-minute heart rate and steps over a period, from Google. */
  async series(from, to) {
    const g = this.google;
    const hr = parseHrWindows(await g.rollUpAll('heart-rate', from, to, 60));
    const steps = parseStepWindows(await g.rollUpAll('steps', from, to, 60));
    return minuteSeries(hr, steps);
  }

  /**
   * The last two hours of steps in quarter-hour windows, and when the
   * tracker last reached the phone: what the sitting nudge judges by.
   * Two Google calls; only made for somebody whose nudge may speak now.
   */
  async intraday(from, to) {
    const windows = parseStepWindows(await this.google.rollUp('steps', from, to, 900));
    let device = null;
    try { device = pickDevice(await this.google.pairedDevices()); } catch (e) { if (e.code === 'rate_limited' || e.code === 'needs_auth') throw e; }
    if (device) this.db.setMeta('device', device);
    if (windows.some((x) => x.steps > 0)) this.db.setMeta('stepsIntraday', { ok: true, at: this.now() });
    return { windows, device };
  }

  /** Does Google have this person's steps through the day, or only daily
      totals? One call over the last day, asked when they switch the nudge on. */
  async probeIntraday() {
    const now = this.now();
    const windows = parseStepWindows(await this.google.rollUp('steps', now - 86_400_000, now, 900));
    const ok = windows.some((x) => x.steps > 0);
    this.db.setMeta('stepsIntraday', { ok, at: now });
    return ok;
  }

  /** Which notification types this person's device can carry. A "no steps
      through the day" answer is believed for a day, then asked again. */
  notifyAvailability() {
    const seen = this.db.meta('stepsIntraday', null);
    const intraday = !seen ? null : seen.ok ? true : (this.now() - (seen.at || 0) < 86_400_000 ? false : null);
    return availability(readCaps(this.db).caps, { connected: this.google.connected(), intraday });
  }

  /** The Google calls the workout machine needs. */
  #api() {
    const g = () => this.google;
    return {
      series: (from, to) => this.series(from, to),
      device: async () => pickDevice(await g().pairedDevices()),
      /** Total calories over exactly the workout: Google's own number. */
      calories: async (from, to) => {
        const pts = await g().rollUpAll('total-calories', from, to, Math.max(60, Math.round((to - from) / 1000)));
        let k = 0; let any = false;
        for (const x of pts) { const v = num(x.totalCalories?.kcalSum); if (v !== null) { k += v; any = true; } }
        return any ? k : null;
      },
      create: (dp) => g().createExercise(dp),
      patch: (name, dp) => g().patchExercise(name, dp),
      remove: (names) => g().deleteExercises(names),
      /** The name of the point this client wrote at a start time, when the
          create's Operation did not say. */
      findOwn: async (start) => {
        const pts = await g().list('exercise', {
          filter: `exercise.interval.civil_start_time >= "${todayIn(start - 86_400_000, this.tz)}"`, pageSize: 25, maxPages: 4,
          dataSourceFamily: 'users/me/dataSourceFamilies/self-sources',
        });
        return pts.find((x) => Math.abs(Date.parse(x.exercise?.interval?.startTime) - start) < 90_000)?.name || null;
      },
    };
  }

  close() { try { this.db.close(); } catch { /* closing */ } }
}

export class Worlds {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {number} o.max        how many worlds stay open
   * @param {Function} o.make     (userId, dir) => UserWorld
   */
  constructor({ dataDir, max = 40, make }) {
    this.dataDir = dataDir;
    this.max = max;
    this.make = make;
    this.map = new Map();   // insertion order = least recently used first
  }

  dirOf(userId) {
    if (!validUserId(userId)) throw Object.assign(new Error('bad user id'), { status: 400 });
    return join(this.dataDir, 'users', String(userId));
  }

  /** This person's world, opened if need be. */
  get(userId) {
    const id = String(userId);
    let w = this.map.get(id);
    if (w) this.map.delete(id);
    else w = this.make(id, this.dirOf(id));
    this.map.set(id, w);
    w.usedAt = Date.now();
    this.#trim();
    return w;
  }

  /** Run something with a world that cannot be evicted while it runs. */
  async hold(userId, fn) {
    const w = this.get(userId);
    w.held += 1;
    try { return await fn(w); } finally { w.held -= 1; }
  }

  #trim() {
    if (this.map.size <= this.max) return;
    for (const [id, w] of this.map) {
      if (this.map.size <= this.max) break;
      // In use, or mid-sync: its turn comes later.
      if (w.held > 0 || w.sync.running || w.workouts.busy || w.workouts.flushing) continue;
      this.map.delete(id);
      w.close();
    }
  }

  open() { return this.map.size; }
  has(userId) { return existsSync(join(this.dirOf(userId), 'health.sqlite')); }

  /** Close a person's world and remove their folder: "delete my health data". */
  destroy(userId) {
    const id = String(userId);
    const w = this.map.get(id);
    if (w) { this.map.delete(id); w.close(); }
    rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  closeAll() { for (const w of this.map.values()) w.close(); this.map.clear(); }
}
