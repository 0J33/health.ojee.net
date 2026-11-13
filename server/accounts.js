/* ============================================================
   health.ojee.net — rep.'s own accounts.

   Logins live in this site's own store (app.sqlite, appdb.js), and the
   cookie is `repSession` on COOKIE_DOMAIN (.ojee.net, so rep.ojee.net and
   the old health.ojee.net host share it):

     account   { id, username, password (bcrypt, cost 10, or '' for an
               account that signs in with Google or Apple), created_ms,
               last_login_ms }. The id is 24 hex characters, as Mongo's
               were: an account brought over keeps its id, and with it its
               folder, profile, friends and everything else.
     session   { token_hash (sha-256 of the cookie's uuid), user_id,
               created_ms, expires_ms (+30 d) }

   Until v296 the login was the one mtg.ojee.net and dnd.ojee.net use, in
   their Mongo database. migrateFromMongo() copies, once, the people who use
   rep. and their live sessions over (reading only: Mongo is never written),
   and the old `ojeeSession` cookie of such a session is swapped for a
   `repSession` one on its next request (app.js). mtg and dnd keep their own
   copies and go on without this site.
   ============================================================ */

import bcrypt from 'bcryptjs';
import { randomUUID, createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'repSession';
/** The cookie shared with mtg and dnd before v296: read once, to hand its session over. */
export const OLD_SESSION_COOKIE = 'ojeeSession';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const USERNAME_RULE = 'Username must be 2-24 characters';
const PASSWORD_RULE = 'Password must be at least 4 characters';
const bad = (msg, status = 400, code = 'bad_request') => Object.assign(new Error(msg), { status, code });
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
/** A new account id: 24 hex characters, time first, like the Mongo ids the old accounts keep. */
export const newUserId = (t = Date.now()) => Math.floor(t / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex');

/** The row as the rest of the server reads it (`_id` too, as Mongo's documents had). */
const shape = (r) => (r ? { _id: r.id, id: r.id, username: r.username, password: r.password, createdAt: new Date(r.created_ms), lastLogin: r.last_login_ms ? new Date(r.last_login_ms) : null } : null);
const pub = (u) => ({ id: String(u.id ?? u._id), username: u.username });

export class Accounts {
  /** `app` is the AppDb (appdb.js). */
  constructor({ app, cookieDomain = '', secure = true, now = () => Date.now() }) {
    this.app = app;
    this.cookieDomain = cookieDomain;
    this.secure = secure;
    this.now = now;
  }

  /** Case-insensitive, exact: "Sam" and "sam" are one account. */
  async byUsername(username) { return shape(this.app.get('SELECT * FROM account WHERE username = ? COLLATE NOCASE', String(username ?? '').trim())); }
  async byId(id) { return shape(this.app.get('SELECT * FROM account WHERE id = ?', String(id ?? ''))); }

  async startSession(userId) {
    const token = randomUUID();
    const t = this.now();
    this.app.run('INSERT INTO session (token_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', sha(token), String(userId), t, t + SESSION_MS);
    return token;
  }

  /** The username rules, and that it is free here. */
  async #checkName(username) {
    if (!username) throw bad('Username required');
    if (username.length < 2 || username.length > 24) throw bad(USERNAME_RULE);
    if (await this.byUsername(username)) throw bad('That username is taken');
  }
  #insert(username, password) {
    const t = this.now();
    const id = newUserId(t);
    this.app.run('INSERT INTO account (id, username, password, created_ms, last_login_ms) VALUES (?, ?, ?, ?, ?)', id, username, password, t, t);
    return id;
  }

  /** An account that signs in with Google or Apple (signin.js): a username and no password. */
  async create({ username }) {
    username = String(username || '').trim();
    await this.#checkName(username);
    const id = this.#insert(username, '');
    return { user: { id, username }, token: await this.startSession(id) };
  }

  /** An account with a password: the demo's seeded people and the tests only (nobody signs up with one). */
  async register({ username, password }) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) throw bad('Username and password required');
    if (password.length < 4) throw bad(PASSWORD_RULE);
    await this.#checkName(username);
    const id = this.#insert(username, await bcrypt.hash(password, 10));
    return { user: { id, username }, token: await this.startSession(id) };
  }

  async login({ username, password }) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) throw bad('Username and password required');
    const user = await this.byUsername(username);
    if (!user || !(await bcrypt.compare(password, String(user.password || '')))) throw bad('Wrong username or password', 401, 'bad_login');
    this.app.run('UPDATE account SET last_login_ms = ? WHERE id = ?', this.now(), user.id);
    return { user: pub(user), token: await this.startSession(user.id) };
  }

  /** Does the account have a password at all (the demo's, an account from before Google and Apple)? */
  async hasPassword(userId) { return Boolean((await this.byId(userId))?.password); }

  /** The password is gone for good: the account signs in with Google or Apple now. */
  async dropPassword(userId) { this.app.run("UPDATE account SET password = '' WHERE id = ?", String(userId)); }

  /** Is this the account's password? (Asked again before an account with one is deleted.) */
  async checkPassword(userId, password) {
    const user = await this.byId(userId);
    return Boolean(user && password && (await bcrypt.compare(String(password), String(user.password || ''))));
  }

  /** Start a session for an account (signed in with Google or Apple): the cookie's token. */
  async signIn(userId) {
    const user = await this.byId(userId);
    if (!user) throw bad('There is no such account', 404, 'not_found');
    this.app.run('UPDATE account SET last_login_ms = ? WHERE id = ?', this.now(), user.id);
    return { user: pub(user), token: await this.startSession(user.id) };
  }

  /** Delete the login itself, and every session of it on every device. */
  async deleteUser(userId) {
    this.app.tx(() => {
      this.app.run('DELETE FROM session WHERE user_id = ?', String(userId));
      this.app.run('DELETE FROM account WHERE id = ?', String(userId));
    });
  }

  async logout(token) { if (token) this.app.run('DELETE FROM session WHERE token_hash = ?', sha(token)); }

  /** The user a session cookie belongs to, or null. */
  async sessionUser(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const s = this.app.get('SELECT * FROM session WHERE token_hash = ?', sha(token));
    if (!s) return null;
    if (s.expires_ms < this.now()) { this.app.run('DELETE FROM session WHERE token_hash = ?', s.token_hash); return null; }
    const user = await this.byId(s.user_id);
    if (!user) { this.app.run('DELETE FROM session WHERE token_hash = ?', s.token_hash); return null; }
    return pub(user);
  }

  /** Sessions run out after 30 days; the rows go now and then. */
  sweep() { this.app.run('DELETE FROM session WHERE expires_ms < ?', this.now()); }

  /* ── the cookie ─────────────────────────────────────────────── */

  #attrs() {
    const a = ['Path=/', 'HttpOnly'];
    if (this.secure) a.push('Secure', 'SameSite=None'); else a.push('SameSite=Lax');
    if (this.cookieDomain) a.push(`Domain=${this.cookieDomain}`);
    return a.join('; ');
  }
  setCookie(token) {
    return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MS / 1000}; Expires=${new Date(this.now() + SESSION_MS).toUTCString()}; ${this.#attrs()}`;
  }
  /** With a session's real end: the old cookie's session keeps its own expiry when handed over. */
  setCookieUntil(token, expiresMs) {
    const s = Math.max(0, Math.floor((expiresMs - this.now()) / 1000));
    return `${SESSION_COOKIE}=${token}; Max-Age=${s}; Expires=${new Date(expiresMs).toUTCString()}; ${this.#attrs()}`;
  }
  clearCookie() { return `${SESSION_COOKIE}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${this.#attrs()}`; }
  /** When a session ends: its expiry, for the hand-over. */
  sessionEnd(token) { return this.app.get('SELECT expires_ms FROM session WHERE token_hash = ?', sha(String(token)))?.expires_ms ?? null; }
}

/**
 * Once, at start: everybody with a rep. profile brought over from mtg's Mongo
 * with the same id, username and password hash, and their live sessions with
 * them (so nobody is signed out). Only reads Mongo. Safe to run again: what is
 * already here is left as it is. @returns { users, sessions, skipped }
 */
export async function migrateFromMongo({ app, db, now = Date.now(), log = () => {} }) {
  const { ObjectId } = await import('mongodb');
  const out = { users: 0, sessions: 0, skipped: [] };
  const profiles = app.profiles();
  for (const p of profiles) {
    let oid;
    try { oid = new ObjectId(String(p.userId)); } catch { out.skipped.push(`${p.username}: not a Mongo id`); continue; }
    const u = await db.collection('users').findOne({ _id: oid });
    if (!u) { out.skipped.push(`${p.username}: no login in Mongo`); continue; }
    const id = String(u._id);
    const have = app.get('SELECT id FROM account WHERE id = ?', id);
    const clash = app.get('SELECT id FROM account WHERE username = ? COLLATE NOCASE AND id != ?', String(u.username), id);
    if (clash) { out.skipped.push(`${u.username}: the name is another account's here`); continue; }
    if (!have) {
      const created = u.createdAt ? new Date(u.createdAt).getTime() : now;
      app.run('INSERT INTO account (id, username, password, created_ms, last_login_ms) VALUES (?, ?, ?, ?, ?)', id, String(u.username), typeof u.password === 'string' ? u.password : '', created, u.lastLogin ? new Date(u.lastLogin).getTime() : null);
      out.users += 1;
    }
    for (const s of await db.collection('sessions').find({ userId: oid }).toArray()) {
      const exp = s.expiresAt ? new Date(s.expiresAt).getTime() : 0;
      if (!s.sessionToken || exp <= now) continue;
      const r = app.run('INSERT OR IGNORE INTO session (token_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', sha(s.sessionToken), id, s.createdAt ? new Date(s.createdAt).getTime() : now, exp);
      out.sessions += Number(r.changes || 0);
    }
  }
  app.setMeta('mongoMigrated', { at: now, users: out.users, sessions: out.sessions, skipped: out.skipped.length });
  log(`accounts: ${out.users} brought over from Mongo with ${out.sessions} live session(s)${out.skipped.length ? `; skipped ${out.skipped.join('; ')}` : ''}`);
  return out;
}

/** Connect to mtg's Mongo, for the migration only. */
export async function connectMongo(uri) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  return { client, db: client.db() };
}
