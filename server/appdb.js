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
     friend          who is friends with whom, and the requests between
                     (friends.js); one row per pair, a < b
     post            a recent workout as a feed post, with only the numbers
                     a friend may see (feed.js); never a GPS point
     cheer, comment  what friends said about a post
     push_sub        Web Push subscriptions, one per device
     link_key        hashed keys for the console-module link
     secret          per-person encrypted values (the OpenCode key)
     media           photos and videos on posts, and profile photos
                     (media.js); the bytes are files under data/media/
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
CREATE TABLE IF NOT EXISTS friend (
  a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, requester TEXT NOT NULL,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS friend_b ON friend (b);
CREATE TABLE IF NOT EXISTS post (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, uid TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'workout',
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}', caption TEXT,
  hidden INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS post_user_uid ON post (user_id, uid);
CREATE INDEX IF NOT EXISTS post_end ON post (end_ms);
CREATE TABLE IF NOT EXISTS cheer (
  post_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS cheer_user ON cheer (user_id);
CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comment_post ON comment (post_id, at);
CREATE INDEX IF NOT EXISTS comment_user ON comment (user_id);
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
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, post_id TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, w INTEGER, h INTEGER, duration_ms INTEGER, thumb TEXT, thumb_bytes INTEGER,
  created_ms INTEGER NOT NULL, touched_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'uploading',
  received INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, name TEXT
);
CREATE INDEX IF NOT EXISTS media_user ON media (user_id);
CREATE INDEX IF NOT EXISTS media_post ON media (post_id, pos);
`;

/** `feed`: are this person's workouts posted to their friends' feed (when
    workouts are shared at all). On unless switched off. */
export const PRIVACY_DEFAULT = { account: 'public', activity: true, workouts: true, sleep: false, heart: false, body: false, feed: true };
export const UNITS_DEFAULT = { distance: 'km', weight: 'kg', temp: 'c', volume: 't', water: 'ml', clock: '24' };
/** Each unit is its own choice. The first value of each list is the default. */
export const UNIT_CHOICES = { distance: ['km', 'mi'], weight: ['kg', 'lb'], temp: ['c', 'f'], volume: ['t', 'kg', 'lb'], water: ['ml', 'oz'], clock: ['24', '12'] };
/** The three the old single metric/imperial switch covers. */
const SYSTEM_KEYS = ['distance', 'weight', 'temp'];
const UNITS_IMPERIAL = { ...UNITS_DEFAULT, distance: 'mi', weight: 'lb', temp: 'f' };

/**
 * Whatever was stored or sent → { distance, weight, temp, volume, water,
 * clock }. Understands the old single switch ('metric' | 'imperial', bare
 * or as { system }), and `temperature` for `temp`. Anything missing or
 * unknown takes `base`.
 */
export function normUnits(v, base = UNITS_DEFAULT) {
  const sys = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.system ?? v.units : null);
  const out = sys === 'imperial' ? { ...UNITS_IMPERIAL } : sys === 'metric' ? { ...UNITS_DEFAULT } : { ...UNITS_DEFAULT, ...base };
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
  const n = SYSTEM_KEYS.filter((k) => u?.[k] === UNITS_IMPERIAL[k]).length;
  return n === 0 ? 'metric' : n === SYSTEM_KEYS.length ? 'imperial' : 'mixed';
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
  // The profile photo: a media id (media.js), or NULL for the initials.
  if (!db.prepare('PRAGMA table_info(profile)').all().some((c) => c.name === 'avatar')) db.exec('ALTER TABLE profile ADD COLUMN avatar TEXT');
  // Added with the running, cycling and walking boards: metres a day of each,
  // written only where workouts are shared.
  const dp = new Set(db.prepare('PRAGMA table_info(daily_public)').all().map((c) => c.name));
  for (const c of ['run_m', 'ride_m', 'walk_m']) if (!dp.has(c)) db.exec(`ALTER TABLE daily_public ADD COLUMN ${c} REAL`);
  // A post's own share choice (feed.js): 1, 0, or NULL to follow auto-share. Hidden posts were "not shared".
  if (!db.prepare('PRAGMA table_info(post)').all().some((c) => c.name === 'shared')) {
    db.exec('ALTER TABLE post ADD COLUMN shared INTEGER');
    db.exec('UPDATE post SET shared = 0 WHERE hidden = 1');
  }
  // Profiles saved with the single metric/imperial switch (or with a unit
  // missing) are rewritten as one choice per unit. Nothing else is touched.
  const set = db.prepare('UPDATE profile SET units = ? WHERE user_id = ?');
  for (const r of db.prepare('SELECT user_id, units FROM profile').all()) {
    const next = JSON.stringify(parseUnits(r.units));
    if (next !== r.units) set.run(next, r.user_id);
  }
  // Boards became friends-only by default. So that the boards people had
  // do not empty out, everyone public when that came in is made friends
  // with everyone else public, once. People who join later start with none.
  if (!db.prepare("SELECT 1 FROM app_meta WHERE key = 'friends_seeded'").get()) {
    const pub = db.prepare('SELECT user_id, privacy FROM profile ORDER BY joined_ms').all()
      .filter((r) => parse(r.privacy, PRIVACY_DEFAULT).account === 'public').map((r) => r.user_id);
    const ins = db.prepare("INSERT OR IGNORE INTO friend (a, b, status, requester, created_ms, updated_ms) VALUES (?, ?, 'friends', ?, ?, ?)");
    const t = Date.now();
    db.exec('BEGIN');
    try {
      for (let i = 0; i < pub.length; i += 1) {
        for (let j = i + 1; j < pub.length; j += 1) {
          const [a, b] = pub[i] < pub[j] ? [pub[i], pub[j]] : [pub[j], pub[i]];
          ins.run(a, b, a, t, t);
        }
      }
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('friends_seeded', ?)").run(JSON.stringify({ at: t, people: pub.length }));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return new AppDb(db);
}

export class AppDb {
  constructor(db) {
    this.db = db;
    this.stmts = new Map();
    /** (rows) => void: removes the files of media rows that were deleted. Set by media.js. */
    this.onMediaGone = null;
    this.goneMedia = [];
    this.inTx = 0;
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
    this.inTx += 1;
    try {
      const r = fn(); this.db.exec('COMMIT'); this.inTx -= 1; this.#flushMedia(); return r;
    } catch (e) { this.db.exec('ROLLBACK'); this.inTx -= 1; this.goneMedia = []; throw e; }
  }

  /* ── media rows ───────────────────────────────────────────────── */

  /** Delete the media rows matching `where`; their files go once the
      deletion is committed (at once outside a transaction). */
  dropMedia(where, ...args) {
    const rows = this.all(`SELECT id, user_id, mime, thumb FROM media WHERE ${where}`, ...args);
    if (!rows.length) return 0;
    this.run(`DELETE FROM media WHERE ${where}`, ...args);
    for (const r of rows) this.run('UPDATE profile SET avatar = NULL WHERE user_id = ? AND avatar = ?', r.user_id, r.id);
    this.goneMedia.push(...rows);
    if (!this.inTx) this.#flushMedia();
    return rows.length;
  }
  #flushMedia() {
    const rows = this.goneMedia; this.goneMedia = [];
    if (rows.length && this.onMediaGone) { try { this.onMediaGone(rows); } catch { /* a file already gone */ } }
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
      nudge: nudgeOf(r.nudge), avatar: r.avatar || null,
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
      lastSeenAt: 'last_seen_ms', googleState: 'google_state', stepGoal: 'step_goal', device: 'device', lastSyncAt: 'last_sync_ms', syncError: 'sync_error', avatar: 'avatar',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'units' || k === 'privacy') this.run(`UPDATE profile SET ${k} = ? WHERE user_id = ?`, JSON.stringify(v), String(userId));
      else if (k === 'nudge') this.run('UPDATE profile SET nudge = ? WHERE user_id = ?', v ? JSON.stringify(v) : null, String(userId));
      else if (k === 'detect') this.run('UPDATE profile SET detect = ? WHERE user_id = ?', v ? 1 : 0, String(userId));
      else if (cols[k]) this.run(`UPDATE profile SET ${cols[k]} = ? WHERE user_id = ?`, v ?? null, String(userId));
    }
    return this.profile(userId);
  }

  /** Remove every global row of one person: their friendships and
      requests, their posts (with what others said on them), and what they
      said on other people's. */
  deleteUser(userId) {
    const id = String(userId);
    this.tx(() => {
      this.deletePostsOf(id);
      this.dropMedia('user_id = ?', id);
      this.run('DELETE FROM cheer WHERE user_id = ?', id);
      this.run('DELETE FROM comment WHERE user_id = ?', id);
      this.run('DELETE FROM friend WHERE a = ? OR b = ?', id, id);
      for (const t of USER_TABLES) this.run(`DELETE FROM ${t} WHERE user_id = ?`, id);
    });
  }
  /** Every post of one person, and the cheers, comments, photos and videos on them. */
  deletePostsOf(userId) {
    const id = String(userId);
    this.dropMedia("post_id IS NOT NULL AND user_id = ? AND kind != 'avatar'", id);
    this.run('DELETE FROM cheer WHERE post_id IN (SELECT id FROM post WHERE user_id = ?)', id);
    this.run('DELETE FROM comment WHERE post_id IN (SELECT id FROM post WHERE user_id = ?)', id);
    this.run('DELETE FROM post WHERE user_id = ?', id);
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
