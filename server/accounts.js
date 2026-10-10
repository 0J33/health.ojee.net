/* ============================================================
   health.ojee.net — the shared ojee.net account.

   One login for mtg.ojee.net, dnd.ojee.net and this site: users and
   sessions live in mtg's Mongo database, and the cookie is
   `ojeeSession` on .ojee.net. This file is the only place the health
   server touches that database, and it keeps to two collections and
   to exactly the fields the other two sites use:

     users     { username, password (bcrypt, cost 10), createdAt, lastLogin }
               — every other field on a user (mtg's decks, preferences)
               is never read into an update and never written.
     sessions  { sessionToken (uuid v4), userId, createdAt, expiresAt (+30 d) }

   Rules and messages are copied from mtg.ojee.net/server/routes/auth.js
   so the three sites answer identically. Keep them in step.

   `db` is a mongodb driver Db, or the FakeMongo with the same calls.
   ============================================================ */

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';

export const SESSION_COOKIE = 'ojeeSession';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const USERNAME_RULE = 'Username must be 2-24 characters';
const PASSWORD_RULE = 'Password must be at least 4 characters';
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bad = (msg, status = 400, code = 'bad_request') => Object.assign(new Error(msg), { status, code });

const oid = (id) => { try { return id instanceof ObjectId ? id : new ObjectId(String(id)); } catch { return null; } };
const pub = (u) => ({ id: String(u._id), username: u.username });

export class Accounts {
  constructor({ db, cookieDomain = '', secure = true, now = () => Date.now() }) {
    this.db = db;
    this.cookieDomain = cookieDomain;
    this.secure = secure;
    this.now = now;
  }
  get users() { return this.db.collection('users'); }
  get sessions() { return this.db.collection('sessions'); }

  /** Case-insensitive, exact: "Sam" and "sam" are one account. */
  byUsername(username) { return this.users.findOne({ username: { $regex: new RegExp(`^${escapeRegex(username)}$`, 'i') } }); }
  async byId(id) { const _id = oid(id); return _id ? this.users.findOne({ _id }) : null; }

  async startSession(userId) {
    const sessionToken = randomUUID();
    const t = this.now();
    await this.sessions.insertOne({ sessionToken, userId: oid(userId), createdAt: new Date(t), expiresAt: new Date(t + SESSION_MS) });
    return sessionToken;
  }

  /** Create the account. It is at once an mtg and a dnd account too. */
  async register({ username, password }) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) throw bad('Username and password required');
    if (username.length < 2 || username.length > 24) throw bad(USERNAME_RULE);
    if (password.length < 4) throw bad(PASSWORD_RULE);
    if (await this.byUsername(username)) throw bad('That username is taken');
    const hashed = await bcrypt.hash(password, 10);
    const t = new Date(this.now());
    const r = await this.users.insertOne({ username, password: hashed, createdAt: t, lastLogin: t });
    const user = { _id: r.insertedId, username };
    return { user: pub(user), token: await this.startSession(user._id) };
  }

  async login({ username, password }) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) throw bad('Username and password required');
    const user = await this.byUsername(username);
    if (!user || !(await bcrypt.compare(password, String(user.password || '')))) throw bad('Wrong username or password', 401, 'bad_login');
    // $set of one field: nothing else on the document is touched.
    await this.users.updateOne({ _id: user._id }, { $set: { lastLogin: new Date(this.now()) } });
    return { user: pub(user), token: await this.startSession(user._id) };
  }

  /** Deleting the session signs out of mtg and dnd too: one store. */
  async logout(token) { if (token) await this.sessions.deleteOne({ sessionToken: String(token) }); }

  /** The user a session cookie belongs to, or null. */
  async sessionUser(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const session = await this.sessions.findOne({ sessionToken: token });
    if (!session) return null;
    // Mongo's TTL index removes expired sessions within a minute or so; until
    // it has, an expired one is not a login.
    if (session.expiresAt && new Date(session.expiresAt).getTime() < this.now()) return null;
    const user = await this.users.findOne({ _id: session.userId });
    if (!user) { await this.sessions.deleteOne({ _id: session._id }); return null; }
    return pub(user);
  }

  /* ── the cookie, exactly as mtg and dnd set it ─────────────────── */

  #attrs() {
    const a = ['Path=/', 'HttpOnly'];
    if (this.secure) a.push('Secure', 'SameSite=None'); else a.push('SameSite=Lax');
    if (this.cookieDomain) a.push(`Domain=${this.cookieDomain}`);
    return a.join('; ');
  }
  setCookie(token) {
    return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MS / 1000}; Expires=${new Date(this.now() + SESSION_MS).toUTCString()}; ${this.#attrs()}`;
  }
  clearCookie() { return `${SESSION_COOKIE}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${this.#attrs()}`; }
}

/** Connect to the real accounts database. */
export async function connectMongo(uri) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  return { client, db: client.db() };
}
