/* ============================================================
   health.ojee.net — the global store (data/app.sqlite): only what
   crosses people.

     profile         who has a health profile here, and their public face
     daily_public    one row per person per civil date: the numbers the
                     leaderboards and profiles are allowed to show. It is
                     written by that person's own sync (social.js), and
                     a private category is never written into it. It is
                     the ONLY thing a leaderboard reads.
     public_workout  recent workouts for a public profile (same rule)
     records         personal bests and streaks per person
     push_sub        Web Push subscriptions, one per device
     link_key        hashed keys for the console-module link
     secret          per-person encrypted values (the OpenCode key)
     app_meta        registration open/closed, VAPID keys, …
   ============================================================ */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS profile (
  user_id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '', accent TEXT, tz TEXT NOT NULL, units TEXT NOT NULL DEFAULT '{}',
  joined_ms INTEGER NOT NULL, onboarding TEXT NOT NULL DEFAULT 'profile', privacy TEXT NOT NULL DEFAULT '{}',
  last_seen_ms INTEGER NOT NULL DEFAULT 0, google_state TEXT NOT NULL DEFAULT 'needs_auth',
  detect INTEGER NOT NULL DEFAULT 0, step_goal INTEGER NOT NULL DEFAULT 8000, device TEXT,
  last_sync_ms INTEGER, sync_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_username ON profile (username);
CREATE TABLE IF NOT EXISTS daily_public (
  user_id TEXT NOT NULL, date TEXT NOT NULL,
  steps REAL, active_min REAL, kcal REAL, distance_m REAL,
  sleep_min REAL, bed_min REAL, wake_min REAL, rhr REAL, hrv REAL, weight_kg REAL, body_fat REAL,
  workouts INTEGER, workout_min REAL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS public_workout (
  user_id TEXT NOT NULL, uid TEXT NOT NULL, start_ms INTEGER NOT NULL, date TEXT NOT NULL,
  minutes REAL NOT NULL, title TEXT, type TEXT,
  PRIMARY KEY (user_id, uid)
);
CREATE TABLE IF NOT EXISTS records (
  user_id TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, date TEXT,
  PRIMARY KEY (user_id, kind)
);
CREATE TABLE IF NOT EXISTS push_sub (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  label TEXT, enabled INTEGER NOT NULL DEFAULT 1, types TEXT, created_ms INTEGER NOT NULL, last_ok_ms INTEGER, last_error TEXT
);
CREATE INDEX IF NOT EXISTS push_user ON push_sub (user_id);
CREATE TABLE IF NOT EXISTS link_key (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, last4 TEXT NOT NULL, label TEXT,
  created_ms INTEGER NOT NULL, last_seen_ms INTEGER, module_version TEXT
);
CREATE INDEX IF NOT EXISTS link_user ON link_key (user_id);
CREATE TABLE IF NOT EXISTS secret (
  user_id TEXT NOT NULL, name TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, last4 TEXT,
  PRIMARY KEY (user_id, name)
);
`;

export const PRIVACY_DEFAULT = { account: 'public', activity: true, workouts: true, sleep: false, heart: false, body: false };
export const UNITS_DEFAULT = { distance: 'km', weight: 'kg', temp: 'c' };
/** Each unit is its own choice. The first value of each list is the metric one. */
export const UNIT_CHOICES = { distance: ['km', 'mi'], weight: ['kg', 'lb'], temp: ['c', 'f'] };
const UNITS_IMPERIAL = { distance: 'mi', weight: 'lb', temp: 'f' };

/**
 * Whatever was stored or sent → { distance, weight, temp }. Understands the
 * old single switch ('metric' | 'imperial', bare or as { system }), and
 * `temperature` for `temp`. Anything missing or unknown takes `base`.
 */
export function normUnits(v, base = UNITS_DEFAULT) {
  const sys = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.system ?? v.units : null);
  const out = sys === 'imperial' ? { ...UNITS_IMPERIAL } : sys === 'metric' ? { ...UNITS_DEFAULT } : { ...base };
  if (v && typeof v === 'object') {
    for (const [k, allowed] of Object.entries(UNIT_CHOICES)) {
      const x = String(v[k] ?? (k === 'temp' ? v.temperature : undefined) ?? '').toLowerCase().replace(/^°/, '');
      if (allowed.includes(x)) out[k] = x;
    }
  }
  return out;
}
/** The old single value, for anything that still wants one: 'metric' | 'imperial' | 'mixed'. */
export function unitSystem(u) {
  const n = Object.keys(UNIT_CHOICES).filter((k) => u?.[k] === UNITS_IMPERIAL[k]).length;
  return n === 0 ? 'metric' : n === Object.keys(UNIT_CHOICES).length ? 'imperial' : 'mixed';
}
const parseUnits = (s) => { try { return normUnits(JSON.parse(s)); } catch { return normUnits(s); } };
export const ONBOARDING = ['profile', 'google', 'install', 'notifications', 'privacy', 'done'];
/** Tables holding a person's rows, for "delete my health data". */
const USER_TABLES = ['profile', 'daily_public', 'public_workout', 'records', 'push_sub', 'link_key', 'secret'];

const nudgeOf = (s) => { if (!s) return null; try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const parse = (s, fallback) => { try { return { ...fallback, ...JSON.parse(s) }; } catch { return { ...fallback }; } };

export function openAppDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // Added after the first version: the sitting nudge's window, kept on the
  // profile so the scheduler knows who to read steps for without opening
  // anybody's own database. NULL = not switched on (or not available).
  if (!db.prepare('PRAGMA table_info(profile)').all().some((c) => c.name === 'nudge')) db.exec('ALTER TABLE profile ADD COLUMN nudge TEXT');
  // Profiles saved with the single metric/imperial switch (or with a unit
  // missing) are rewritten as one choice per unit. Nothing else is touched.
  const set = db.prepare('UPDATE profile SET units = ? WHERE user_id = ?');
  for (const r of db.prepare('SELECT user_id, units FROM profile').all()) {
    const next = JSON.stringify(parseUnits(r.units));
    if (next !== r.units) set.run(next, r.user_id);
  }
  return new AppDb(db);
}

export class AppDb {
  constructor(db) {
    this.db = db;
    this.stmts = new Map();
  }
  /** A prepared statement, made once. */
  p(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }
  get(sql, ...a) { return this.p(sql).get(...a); }
  all(sql, ...a) { return this.p(sql).all(...a); }
  run(sql, ...a) { return this.p(sql).run(...a); }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  meta(key, fallback = null) {
    const r = this.get('SELECT value FROM app_meta WHERE key = ?', key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch { return fallback; }
  }
  setMeta(key, value) { this.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)); }

  registrationOpen() { return this.meta('registrationOpen', true) !== false; }

  /* ── profiles ─────────────────────────────────────────────────── */

  #profile(r) {
    if (!r) return null;
    return {
      userId: r.user_id, username: r.username, displayName: r.display_name, bio: r.bio, accent: r.accent, tz: r.tz,
      units: parseUnits(r.units), joinedAt: r.joined_ms, onboarding: r.onboarding,
      privacy: parse(r.privacy, PRIVACY_DEFAULT), lastSeenAt: r.last_seen_ms, googleState: r.google_state,
      detect: !!r.detect, stepGoal: r.step_goal, device: r.device, lastSyncAt: r.last_sync_ms, syncError: r.sync_error,
      nudge: nudgeOf(r.nudge),
    };
  }
  profile(userId) { return this.#profile(this.get('SELECT * FROM profile WHERE user_id = ?', String(userId))); }
  profileByName(username) { return this.#profile(this.get('SELECT * FROM profile WHERE username = ?', String(username))); }
  profiles() { return this.all('SELECT * FROM profile ORDER BY joined_ms').map((r) => this.#profile(r)); }

  createProfile({ userId, username, tz, now }) {
    this.run(`INSERT INTO profile (user_id, username, display_name, tz, units, joined_ms, privacy, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING`, String(userId), username, username, tz, JSON.stringify(UNITS_DEFAULT), now, JSON.stringify(PRIVACY_DEFAULT), now);
    return this.profile(userId);
  }

  /** Update columns of a profile from a { camelCase: value } patch. */
  patchProfile(userId, patch) {
    const cols = {
      username: 'username', displayName: 'display_name', bio: 'bio', accent: 'accent', tz: 'tz', onboarding: 'onboarding',
      lastSeenAt: 'last_seen_ms', googleState: 'google_state', stepGoal: 'step_goal', device: 'device', lastSyncAt: 'last_sync_ms', syncError: 'sync_error',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'units' || k === 'privacy') this.run(`UPDATE profile SET ${k} = ? WHERE user_id = ?`, JSON.stringify(v), String(userId));
      else if (k === 'nudge') this.run('UPDATE profile SET nudge = ? WHERE user_id = ?', v ? JSON.stringify(v) : null, String(userId));
      else if (k === 'detect') this.run('UPDATE profile SET detect = ? WHERE user_id = ?', v ? 1 : 0, String(userId));
      else if (cols[k]) this.run(`UPDATE profile SET ${cols[k]} = ? WHERE user_id = ?`, v ?? null, String(userId));
    }
    return this.profile(userId);
  }

  /** Remove every global row of one person. */
  deleteUser(userId) {
    this.tx(() => { for (const t of USER_TABLES) this.run(`DELETE FROM ${t} WHERE user_id = ?`, String(userId)); });
  }

  /* ── secrets ──────────────────────────────────────────────────── */

  secretRow(userId, name) { return this.get('SELECT * FROM secret WHERE user_id = ? AND name = ?', String(userId), name) || null; }
  setSecret(userId, name, sealed, last4) {
    this.run(`INSERT INTO secret (user_id, name, iv, tag, data, last4) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, last4 = excluded.last4`,
    String(userId), name, sealed.iv, sealed.tag, sealed.data, last4);
  }
  deleteSecret(userId, name) { this.run('DELETE FROM secret WHERE user_id = ? AND name = ?', String(userId), name); }

  close() { this.db.close(); }
}
