/* ============================================================
   health.ojee.net — per-person worlds.

   The single-user module had one store, one Google connection, one
   poller, one workout machine. Here each person gets their own set,
   a UserWorld, over their own folder:

     data/users/<mongoUserId>/health.sqlite   their data, as every page reads it
     data/users/<mongoUserId>/google.json     their first Google account's refresh token (0600)
     data/users/<mongoUserId>/google-<acct>.json   any further account's (0600)
     data/users/<mongoUserId>/src/<acct>.sqlite    what each account's sync read
     data/users/<mongoUserId>/src/garmin.sqlite    what Garmin's sync read (garminsync.js)

   A person may connect more than one Google account (the Google Health
   app takes one tracker per account, so two trackers mean two
   accounts). Each account syncs into its own source store; MultiSync
   then folds them into health.sqlite (core/merge.js). One account is
   the "main" one: workouts, weigh-ins and logged entries are written
   to it, and its numbers win where two devices disagree on a single
   reading. Garmin, read directly, is folded in the same way as a source
   of its own, first or after Google as the person chose (core/merge.js).

   Worlds are opened on demand and kept in a small LRU, so a hundred
   people do not mean a hundred open databases. A world that is in
   use (a request, a sync) is `held` and never evicted mid-flight.

   Isolation is structural: a route gets the world of the signed-in
   person's id and nothing else; there is no function here that takes
   a username or opens "someone else's" world for a reader. What
   other people may see goes through the public tables (social.js).
   ============================================================ */

import { join } from 'node:path';
import { rmSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb } from './core/db.js';
import { GoogleHealth, SCOPES, GROUPS, GROUP_IDS, cleanGroups, shortScope, ApiError } from './core/google.js';
import { Sync } from './core/sync.js';
import { mergeAll, mergeRules, reconcile, cleanSourceCopy } from './core/merge.js';
import { Workouts, EXERCISE_TYPE, EXERCISE_TYPES } from './core/workouts.js';
import { Alerts, availability } from './core/alerts.js';
import { detectSettings, minuteSeries, DETECT_DEFAULTS } from './core/detect.js';
import { parseHrWindows, parseStepWindows, pickDevice } from './core/parse.js';
import { dashboard } from './core/metrics.js';
import { today as todayIn, addDays, num } from './core/util.js';
import { readCaps } from './caps.js';

export const validUserId = (id) => /^[a-f0-9]{24}$/.test(String(id));

export const GOAL_DEFAULTS = { stepTarget: 8000, azmTarget: 22, sleepTarget: 450, cardioTarget: 150, waterTarget: 2000 };

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
    this.log = log;
    this.memory = memory;
    this.gopts = google;
    this.held = 0;
    this.usedAt = now();
    this.db = openDb(memory ? ':memory:' : join(dir, 'health.sqlite'));
    this.accounts = new Map();   // account id -> { id, google, db, sync }
    this.#firstAccount();
    for (const a of this.accountList()) this.#open(a.id);
    this.sync = new MultiSync(this);
    this.alerts = new Alerts({
      db: this.db, now, tz: () => this.tz, log, weekly,
      emit: notify,
      intraday: (from, to) => this.intraday(from, to),
      snapshot: () => ({
        auth: this.google.status(),
        sync: this.sync.state,
        device: this.db.meta('device'),
        accounts: this.accountsView().map((a) => ({ id: a.id, label: a.label, primary: a.primary, auth: this.accounts.get(a.id).google.status(), sync: this.accounts.get(a.id).sync.state, device: a.device, multi: this.accounts.size > 1 })),
        avail: this.notifyAvailability(),
        workout: this.workouts.open().some((r) => r.status === 'running' || r.status === 'ongoing'),
        dash: this.anyConnected() ? dashboard(this.db, { today: todayIn(now(), this.tz), days: 7, settings: this.settings(), caps: readCaps(this.db).caps }) : null,
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

  /* ── Google accounts ─────────────────────────────────────────────── */

  /** The accounts as stored: [{ id, label, include, addedAt }], in order. */
  accountList() { const l = this.db.meta('gaccounts', []); return Array.isArray(l) ? l : []; }
  #saveList(list) { this.db.setMeta('gaccounts', list); }
  /** The main account's id: the one written to. */
  get primaryId() {
    const p = this.db.meta('gprimary');
    return this.accounts.has(p) ? p : this.accountList()[0]?.id;
  }
  /** The main account's Google: status, writes, the optional groups. */
  get google() { return this.accounts.get(this.primaryId).google; }
  /** Included accounts, the main one first. */
  included() {
    const p = this.primaryId;
    const list = this.accountList().filter((a) => a.include !== false);
    return [...list.filter((a) => a.id === p), ...list.filter((a) => a.id !== p)].map((a) => this.accounts.get(a.id)).filter(Boolean);
  }
  /** Included accounts that can be read from now. */
  readable() { return this.included().filter((a) => a.google.connected()); }
  anyConnected() { return this.readable().length > 0; }
  /** The Google a write goes to: the account it was made in, else the main one.
      A write from before there were several accounts went to the first. */
  googleFor(acct) {
    if (acct && this.accounts.has(acct)) return this.accounts.get(acct).google;
    if (!acct && this.accounts.has('main')) return this.accounts.get('main').google;
    return this.google;
  }

  #tokenFile(id) { return this.memory ? undefined : join(this.dir, id === 'main' ? 'google.json' : `google-${id}.json`); }
  #srcPath(id) { return this.memory ? ':memory:' : join(this.dir, 'src', `${id}.sqlite`); }
  #googleOf(id, tokenFile = this.#tokenFile(id)) {
    const g = this.gopts;
    return new GoogleHealth({ ...g, ...(g.fetchFor ? { fetchImpl: g.fetchFor(id) } : {}), tokenFile, now: this.now });
  }

  #open(id) {
    if (this.accounts.has(id)) return this.accounts.get(id);
    const google = this.#googleOf(id);
    const db = openDb(this.#srcPath(id));
    const sync = new Sync({
      google, db, tz: this.tz, now: this.now, auto: false, gapMs: this.gopts.gapMs ?? 150,
      groups: () => this.groups(),
      log: { warn: (m) => this.log(`${this.userId.slice(-6)}${id === 'main' ? '' : `/${id}`}${m}`) },
    });
    const a = { id, google, db, sync };
    this.accounts.set(id, a);
    return a;
  }

  /**
   * The first account. A store from before there could be several holds
   * the first account's data itself: it is copied once to that account's
   * source (src/main.sqlite) and trimmed to what its sync wrote, so the
   * sync carries on where it was and nothing is read twice.
   */
  #firstAccount() {
    if (this.accountList().length) return;
    if (!this.memory) {
      const src = this.#srcPath('main');
      if (!existsSync(src) && (this.db.meta('sync') || this.db.firstDate())) {
        mkdirSync(join(this.dir, 'src'), { recursive: true });
        this.db.db.exec(`VACUUM INTO '${src.replace(/'/g, "''")}'`);
        const copy = openDb(src);
        try { cleanSourceCopy(copy); } finally { copy.close(); }
      }
    }
    this.#saveList([{ id: 'main', label: '', include: true, addedAt: this.now() }]);
    this.db.setMeta('gprimary', 'main');
  }

  /** How two devices' numbers are put together (core/merge.js). */
  mergeRules() { return mergeRules(this.db.meta('mergeRules', {}), this.accountList().map((a) => a.id)); }
  setMergeRules(patch) {
    const next = mergeRules({ ...this.mergeRules(), ...patch }, this.accountList().map((a) => a.id));
    this.db.setMeta('mergeRules', next);
    return next;
  }

  /** Fold the accounts' stores into this person's own. `gone`: stores of
      accounts just taken out, whose data must leave with them. */
  merge({ gone = [] } = {}) {
    const own = new Set(this.db.workoutsSince(0).map((r) => r.google?.name).filter(Boolean));
    const srcs = this.included().map((a) => ({ id: a.id, db: a.db, label: this.accountList().find((x) => x.id === a.id)?.label || '' }));
    return mergeAll(this.db, srcs, { rules: this.mergeRules(), gone, own, extra: this.extraSources() });
  }

  /* ── Garmin, read directly (garmin.js, garminsync.js) ────────────── */

  /** Garmin's own store, opened when first needed. */
  garminDb() {
    if (!this.gdb) {
      if (!this.memory) mkdirSync(join(this.dir, 'src'), { recursive: true });
      this.gdb = openDb(this.#srcPath('garmin'));
    }
    return this.gdb;
  }
  garminState() { return this.db.meta('garmin', null) || {}; }
  /** Garmin is connected: its key is here and it is read. */
  garminOn() { return !!this.garminState().connected; }
  /** Garmin's numbers are part of this person's: connected, or let go of with its data kept. */
  garminIn() { const g = this.garminState(); return !!(g.connected || g.kept); }
  /** The sources that are not Google accounts, for the fold. */
  extraSources() {
    if (!this.garminIn()) return [];
    return [{ id: 'garmin', db: this.garminDb(), label: 'Garmin', first: (this.garminState().settings?.prefer || 'garmin') !== 'google' }];
  }
  /** Anything that brings this person's numbers in: a Google account or Garmin. */
  anySource() { return this.anyConnected() || this.garminOn(); }
  /**
   * Garmin let go of. With keepData its numbers stay part of this
   * person's (folded in as before, never read again); without, what only
   * it brought leaves, and its store is emptied.
   */
  dropGarmin({ keepData = true } = {}) {
    if (keepData) { this.merge(); this.#forgetCaches(); return; }
    const db = this.garminDb();
    this.merge({ gone: [db] });
    this.#forgetCaches();
    db.tx(() => db.db.exec(`DELETE FROM daily; DELETE FROM sleep; DELETE FROM exercise; DELETE FROM weight; DELETE FROM sample; DELETE FROM meta;`));
  }

  /** Each account as the Connections page shows it. No token leaves. */
  accountsView() {
    const p = this.primaryId;
    return this.accountList().map((x) => {
      const a = this.accounts.get(x.id);
      const st = a.google.status();
      const s = a.sync.state;
      return {
        id: x.id, label: x.label || '', include: x.include !== false, primary: x.id === p, addedAt: x.addedAt || null,
        state: st.state, email: st.email, connectedAt: st.connectedAt, expiredAt: st.expiredAt, testingExpiry: st.testingExpiry,
        missing: st.missing, lastOk: s.lastOk || null, lastError: s.lastError || null,
        device: a.db.meta('device'),
      };
    });
  }

  /** A name for an account in a sentence: its label, its address, or "the first account". */
  accountName(id) {
    const x = this.accountList().find((a) => a.id === id);
    const a = this.accounts.get(id);
    return x?.label || a?.google.status().email || (id === this.accountList()[0]?.id ? 'your first account' : 'that account');
  }

  /**
   * Take the tokens of a finished Google sign-in into an account.
   * `target`: an account id (reconnect it), 'new' (add one), or empty (the
   * main account). `exchange(google)` runs the code exchange on a fresh,
   * unsaved client, so nothing is stored until the account it belongs to
   * is known: the same Google account twice, or a different one signed
   * into by mistake when reconnecting, is caught before it mixes data.
   * @returns {{ id, added: boolean, already: boolean }}
   */
  async connectAccount(target, exchange) {
    const tmp = this.#googleOf('tmp', undefined);
    await exchange(tmp);
    const email = tmp.status().email;
    const norm = (e) => String(e || '').trim().toLowerCase();
    const list = this.accountList();
    const owner = email ? list.find((x) => norm(this.accounts.get(x.id).google.status().email) === norm(email)) : null;
    const id = target === 'new' ? null : (target && this.accounts.has(target) ? target : this.primaryId);
    if (id) {
      const known = this.accounts.get(id).google.status().email;
      if (owner && owner.id !== id) {
        // Not revoked: that grant is the other account's connection.
        await tmp.disconnect({ revoke: false });
        throw new ApiError(`${email} is already connected here as ${this.accountName(owner.id)}. Reconnect that one instead.`, { code: 'other_account' });
      }
      if (known && email && norm(known) !== norm(email)) {
        await tmp.disconnect();
        throw new ApiError(`You signed in as ${email}, but this connection is ${known}. Choose ${known} at Google, or add ${email} as another account.`, { code: 'wrong_account' });
      }
      this.accounts.get(id).google.adopt(tmp.tok);
      return { id, added: false, already: false };
    }
    if (owner) {
      // Added again: it is the same account, so its connection is refreshed.
      this.accounts.get(owner.id).google.adopt(tmp.tok);
      return { id: owner.id, added: false, already: true };
    }
    let nid;
    do nid = `a${randomBytes(3).toString('hex')}`; while (this.accounts.has(nid));
    const a = this.#open(nid);
    a.google.adopt(tmp.tok);
    this.#saveList([...list, { id: nid, label: '', include: true, addedAt: this.now() }]);
    return { id: nid, added: true, already: false };
  }

  /** Rename, include or leave out, or make an account the main one. */
  patchAccount(id, { label, include, primary } = {}) {
    const list = this.accountList();
    const x = list.find((a) => a.id === id);
    if (!x) throw Object.assign(new Error('There is no such account.'), { status: 404 });
    let gone = [];
    if (typeof label === 'string') x.label = label.trim().slice(0, 30);
    if (typeof include === 'boolean' && include !== (x.include !== false)) {
      if (!include && list.filter((a) => a.include !== false).length <= 1) throw Object.assign(new Error('At least one account has to stay in.'), { status: 409 });
      x.include = include;
      if (!include) gone = [this.accounts.get(id).db];
    }
    this.#saveList(list);
    if (primary === true) {
      if (x.include === false) throw Object.assign(new Error('Include this account before making it the main one.'), { status: 409 });
      this.db.setMeta('gprimary', id);
    }
    const r = this.mergeRules();
    if (r.overnight === id && x.include === false) this.setMergeRules({ overnight: 'auto' });
    this.merge({ gone });
    this.#forgetCaches();
    return x;
  }

  /**
   * Remove an account: Google's access is revoked, and its data leaves
   * with it (what another account also has stays). The last account
   * cannot be removed; it can be disconnected.
   */
  async removeAccount(id) {
    const list = this.accountList();
    if (!list.some((a) => a.id === id)) throw Object.assign(new Error('There is no such account.'), { status: 404 });
    if (list.length <= 1) throw Object.assign(new Error('This is your only account. Disconnect it instead, or delete your health data.'), { status: 409 });
    const a = this.accounts.get(id);
    await a.google.disconnect().catch(() => {});
    const rest = list.filter((x) => x.id !== id);
    if (!rest.some((x) => x.include !== false)) rest[0].include = true;
    this.#saveList(rest);
    if (this.db.meta('gprimary') === id) this.db.setMeta('gprimary', rest.find((x) => x.include !== false).id);
    if (this.mergeRules().overnight === id) this.setMergeRules({ overnight: 'auto' });
    this.accounts.delete(id);
    this.merge({ gone: [a.db] });
    this.#forgetCaches();
    a.db.close();
    if (!this.memory) {
      for (const f of [this.#srcPath(id), `${this.#srcPath(id)}-wal`, `${this.#srcPath(id)}-shm`, this.#tokenFile(id)]) { try { unlinkSync(f); } catch { /* not there */ } }
    }
  }

  /** Disconnect one account and keep what it brought. */
  async disconnectAccount(id) {
    const a = this.accounts.get(id);
    if (!a) throw Object.assign(new Error('There is no such account.'), { status: 404 });
    await a.google.disconnect();
  }

  /** Cached day views were read from the accounts as they were. */
  #forgetCaches() {
    for (const k of Object.keys(this.db.metaPrefix('day:'))) this.db.delMeta(k);
  }

  setTz(tz) { this.tz = tz; for (const a of this.accounts.values()) a.sync.tz = tz; this.workouts.tz = tz; }

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
  /**
   * Each group as the page shows it. `chosen` is the person's switch,
   * `granted` is Google's, `usable` is both. `mode` is the one word a page
   * needs:
   *   'off'     not switched on: its metrics do not exist for this person
   *   'google'  on and granted: entries are saved to Google Health too
   *             (for ECG: readings are read from it)
   *   'local'   on, but Google is not connected or has not been given the
   *             permission: entries are kept on this site only, and go to
   *             Google if the permission is granted later
   * `canLog` says whether anything can be logged in it at all (ECG is read
   * only), and `start` is where to send the person to grant it at Google.
   */
  groupsView() {
    const on = this.groups();
    const ok = this.google.connected();
    return GROUPS.map((g) => {
      const granted = ok && this.google.groupGranted(g.id);
      return {
        id: g.id, label: g.label, about: g.about, scopes: g.scopes.map(shortScope), chosen: on[g.id], granted, usable: on[g.id] && granted, readOnly: g.readOnly, note: g.note,
        mode: !on[g.id] ? 'off' : granted ? 'google' : 'local', canLog: on[g.id] && !g.readOnly, kinds: g.kinds,
        start: `/auth/google/start?groups=${g.id}`,
      };
    });
  }

  /**
   * Which optional groups the summary may read: `{ nutrition: bool, … }`,
   * all false until the person says otherwise. A group that is not here as
   * true never reaches the numbers a summary is written from, and so never
   * reaches a language model.
   */
  aiShare() {
    const a = this.db.meta('aiShare', {}) || {};
    return Object.fromEntries(GROUP_IDS.map((id) => [id, a[id] === true]));
  }
  setAiShare(patch) {
    const next = this.aiShare();
    for (const id of GROUP_IDS) if (typeof patch?.[id] === 'boolean') next[id] = patch[id];
    this.db.setMeta('aiShare', next);
    return next;
  }

  /** The metric ids pinned to Today, in the order they were pinned. */
  pins() { const p = this.db.meta('pins', []); return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []; }

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

  /**
   * Run one read on every account that can be read, and give back what
   * each answered. An account that fails is left out; when they all fail,
   * the main account's error (or the first) is thrown.
   */
  async #each(fn) {
    const list = this.readable();
    if (!list.length) return fn(this.google).then((v) => [v]);
    const out = [];
    let err = null;
    for (const a of list) {
      try { out.push(await fn(a.google, a)); } catch (e) { err ||= e; if (list.length === 1) throw e; }
    }
    if (!out.length && err) throw err;
    return out;
  }

  /** Minute-by-minute heart rate and steps over a period, from Google: from
      every device, a minute worn on both taking the mean pulse, the higher
      peak and the larger step count. */
  async series(from, to) {
    const per = await this.#each(async (g) => ({
      hr: parseHrWindows(await g.rollUpAll('heart-rate', from, to, 60)),
      steps: parseStepWindows(await g.rollUpAll('steps', from, to, 60)),
    }));
    if (per.length === 1) return minuteSeries(per[0].hr, per[0].steps);
    return minuteSeries(combineHr(per.map((x) => x.hr)), maxWindows(per.map((x) => x.steps)));
  }

  /**
   * The last two hours of steps in quarter-hour windows, and when the
   * tracker last reached the phone: what the sitting nudge judges by.
   * Two Google calls per account; only made for somebody whose nudge may
   * speak now. A quarter-hour counted by two devices counts once.
   */
  async intraday(from, to) {
    const per = await this.#each(async (g, a) => {
      const windows = parseStepWindows(await g.rollUp('steps', from, to, 900));
      let device = null;
      try { device = pickDevice(await g.pairedDevices()); } catch (e) { if (e.code === 'rate_limited' || e.code === 'needs_auth') throw e; }
      if (device && a) a.db.setMeta('device', device);
      return { windows, device };
    });
    const windows = per.length === 1 ? per[0].windows : maxWindows(per.map((x) => x.windows));
    // The device that reached its phone last is the one being worn.
    const device = per.map((x) => x.device).filter(Boolean).sort((x, y) => (y.lastSync || 0) - (x.lastSync || 0))[0] || null;
    if (device) {
      if (this.accounts.size > 1) this.merge(); else this.db.setMeta('device', device);
    }
    if (windows.some((x) => x.steps > 0)) this.db.setMeta('stepsIntraday', { ok: true, at: this.now() });
    return { windows, device };
  }

  /** Does Google have this person's steps through the day, or only daily
      totals? One call per account over the last day, asked when they
      switch the nudge on. */
  async probeIntraday() {
    const now = this.now();
    const per = await this.#each(async (g) => parseStepWindows(await g.rollUp('steps', now - 86_400_000, now, 900)));
    const ok = per.some((windows) => windows.some((x) => x.steps > 0));
    this.db.setMeta('stepsIntraday', { ok, at: now });
    return ok;
  }

  /** Which notification types this person's device can carry. A "no steps
      through the day" answer is believed for a day, then asked again. */
  notifyAvailability() {
    const seen = this.db.meta('stepsIntraday', null);
    const intraday = !seen ? null : seen.ok ? true : (this.now() - (seen.at || 0) < 86_400_000 ? false : null);
    return availability(readCaps(this.db).caps, { connected: this.anyConnected(), intraday });
  }

  /** The Google calls the workout machine needs. Reads come from every
      account; a workout is written to the main one, and changed or
      removed in the account it was written to. */
  #api() {
    const g = () => this.google;
    return {
      acct: () => this.primaryId,
      series: (from, to) => this.series(from, to),
      device: async () => pickDevice(await g().pairedDevices()),
      /** Total calories over exactly the workout: Google's own number. Two
          devices each count the resting burn, so the larger is taken. */
      calories: async (from, to) => {
        const per = await this.#each(async (gg) => {
          const pts = await gg.rollUpAll('total-calories', from, to, Math.max(60, Math.round((to - from) / 1000)));
          let k = 0; let any = false;
          for (const x of pts) { const v = num(x.totalCalories?.kcalSum); if (v !== null) { k += v; any = true; } }
          return any ? k : null;
        });
        const got = per.filter((v) => v !== null);
        return got.length ? Math.max(...got) : null;
      },
      create: (dp) => g().createExercise(dp),
      patch: (name, dp, acct) => this.googleFor(acct).patchExercise(name, dp),
      remove: async (names, acct) => {
        const r = await this.googleFor(acct).deleteExercises(names);
        // Gone from the account's own copy too, so the next fold does not bring it back.
        const a = this.accounts.get(acct) || (!acct && this.accounts.get('main')) || this.accounts.get(this.primaryId);
        if (a) for (const n of names) a.db.deleteExercise(n);
        return r;
      },
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

  close() {
    try { this.db.close(); } catch { /* closing */ }
    try { this.gdb?.close(); } catch { /* closing */ }
    for (const a of this.accounts.values()) { try { a.db.close(); } catch { /* closing */ } }
  }
}

/** Step windows from several devices: per window, the larger count. */
export function maxWindows(lists) {
  const m = new Map();
  for (const list of lists) {
    for (const w of list) {
      const c = m.get(w.start);
      if (!c || w.steps > c.steps) m.set(w.start, { ...w });
    }
  }
  return [...m.values()].sort((a, b) => a.start - b.start);
}

/** Heart-rate windows from several devices: per window, the mean pulse and the higher peak. */
export function combineHr(lists) {
  const m = new Map();
  for (const list of lists) {
    for (const w of list) {
      const c = m.get(w.start);
      if (!c) { m.set(w.start, { ...w, n: 1 }); continue; }
      c.avg = (c.avg * c.n + w.avg) / (c.n + 1);
      c.n += 1;
      c.max = Math.max(c.max ?? c.avg, w.max ?? w.avg);
    }
  }
  return [...m.values()].map(({ n, ...w }) => w).sort((a, b) => a.start - b.start);
}

/**
 * One person's sync over all their accounts: each included account's own
 * Sync, one after the other, then the quarter-hour check of days two
 * devices share, then the fold. It stands where a single Sync used to:
 * `run()`, `running`, `state`, `tz`.
 */
export class MultiSync {
  constructor(world) { this.w = world; this.running = null; }

  get tz() { return this.w.tz; }
  set tz(v) { this.w.setTz(v); }

  /** The accounts together. Each account's own stays in accountsView(). */
  get state() {
    const list = this.w.included();
    const states = list.map((a) => a.sync.state);
    const main = states[0] || { streams: {} };
    if (states.length <= 1) return main;
    const maxOf = (k) => states.map((s) => s[k]).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const errs = states.map((s) => s.lastError).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0));
    const connected = list.map((a, i) => (a.google.connected() ? states[i] : null)).filter(Boolean);
    // "Last sync" is the oldest of the connected accounts' last good syncs:
    // the whole picture is only as fresh as its stalest part.
    const oks = connected.map((s) => s.lastOk || 0);
    const lastOk = oks.length && oks.every(Boolean) ? Math.min(...oks) : maxOf('lastOk');
    return {
      lastRun: maxOf('lastRun'), lastOk, lastError: errs[0] || null,
      failures: Math.min(...states.map((s) => s.failures || 0)),
      nextAt: states.map((s) => s.nextAt).filter(Boolean).sort((a, b) => a - b)[0] || null,
      streams: main.streams,
    };
  }

  /** Run now. Concurrent callers share the one run in flight. `force` also
      runs an account that is waiting out a backoff (Sync now). */
  run({ force = false } = {}) {
    this.running ||= this.#run(force).finally(() => { this.running = null; });
    return this.running;
  }

  async #run(force) {
    const w = this.w;
    const list = w.included();
    const results = [];
    for (const a of list) {
      const st = a.sync.state;
      // Waiting out its own backoff: the others carry on without it.
      if (!force && list.length > 1 && st.failures > 0 && st.nextAt && st.nextAt > w.now() && a.google.connected()) continue;
      results.push({ a, r: await a.sync.run() });
    }
    const readable = w.readable();
    if (readable.length > 1 && w.mergeRules().activity === 'auto') {
      try {
        await reconcile({ main: w.db, accounts: readable, tz: w.tz, now: w.now(), gapMs: w.gopts.gapMs ?? 150, log: (m) => w.log(`${w.userId.slice(-6)} ${m}`) });
      } catch (e) { w.log(`${w.userId.slice(-6)} reconcile: ${e.message}`); }
    }
    let merged = 0;
    try { merged = w.merge(); } catch (e) { w.log(`${w.userId.slice(-6)} merge: ${e.message}`); }
    if (!results.length) return { ok: true, wrote: merged, nextInMs: Math.max(60_000, ...[Math.min(...list.map((a) => (a.sync.state.nextAt || w.now()) - w.now()))]) };
    // One account alone: its result, as it always was.
    if (list.length === 1) return results[0].r;
    const tried = results.filter((x) => x.a.google.connected() || x.r.ok);
    const good = results.filter((x) => x.r.ok);
    const wrote = results.reduce((n, x) => n + (x.r.wrote || 0), 0);
    if (good.length) {
      // Fine while any account is: one that is not says so on its own row.
      const delays = good.map((x) => x.r.nextInMs || 0).filter(Boolean);
      return { ok: true, wrote, nextInMs: delays.length ? Math.min(...delays) : 20 * 60_000, accounts: results.map((x) => ({ id: x.a.id, ok: x.r.ok, code: x.r.code || null })) };
    }
    const first = (tried.find((x) => x.a.id === w.primaryId) || tried[0] || results[0]).r;
    return { ...first, wrote, accounts: results.map((x) => ({ id: x.a.id, ok: x.r.ok, code: x.r.code || null })) };
  }
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
