/* rep.'s own accounts (server/accounts.js): the people who use rep. brought
   over from mtg's Mongo once, with the same ids and their live sessions; the
   old ojeeSession cookie handed over to repSession; Mongo only ever read, so
   mtg and dnd keep their copies exactly as they were. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { rig } from './helpers.mjs';
import { FakeMongo } from '../server/fake-mongo.js';
import { migrateFromMongo } from '../server/accounts.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const DAY = 86_400_000;
const HASH = '$2a$10$abcdefghijklmnopqrstuuJ9wq4o1c2l1x3oY5a7gZbq0V0qX9e8K';

/** mtg's Mongo as it is: rep. people, an mtg-only player, sessions live and expired. Any write throws. */
function mtgMongo(name = 'Veteran') {
  const db = new FakeMongo();
  const tok = { live: randomUUID(), old: randomUUID(), mtg: randomUUID() };
  const users = db.collection('users'); const sessions = db.collection('sessions');
  const rep = { _id: new ObjectId(), username: name, password: HASH, createdAt: new Date(Date.now() - 400 * DAY), lastLogin: new Date(Date.now() - DAY), decks: ['d1'] };
  const mtgOnly = { _id: new ObjectId(), username: 'cardsonly', password: HASH, createdAt: new Date(), lastLogin: new Date() };
  users.docs.push(rep, mtgOnly);
  sessions.docs.push(
    { _id: new ObjectId(), sessionToken: tok.live, userId: rep._id, createdAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + 29 * DAY) },
    { _id: new ObjectId(), sessionToken: tok.old, userId: rep._id, createdAt: new Date(Date.now() - 40 * DAY), expiresAt: new Date(Date.now() - 10 * DAY) },
    { _id: new ObjectId(), sessionToken: tok.mtg, userId: mtgOnly._id, createdAt: new Date(), expiresAt: new Date(Date.now() + 29 * DAY) },
  );
  const before = JSON.stringify([users.docs, sessions.docs]);
  for (const c of [users, sessions]) for (const fn of ['insertOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']) c[fn] = async () => { throw new Error(`Mongo was written: ${fn}`); };
  return { db, rep, mtgOnly, tok, unchanged: () => JSON.stringify([users.docs, sessions.docs]) === before };
}

test('rep. runs with no Mongo at all, and brings its people over once: same ids, same passwords, live sessions only, Mongo untouched', async () => {
  // The rig has no Mongo: signing up and in works on rep.'s own store.
  const fresh = await r.signUp('nomongo');
  assert.equal(fresh.done.status, 200);
  assert.equal((await fresh.c.get('/api/me')).json.user.username, 'nomongo');

  const m = mtgMongo();
  r.app.app.createProfile({ userId: String(m.rep._id), username: 'Veteran', tz: 'Africa/Cairo', now: Date.now() });
  const first = await migrateFromMongo({ app: r.app.app, db: m.db });
  assert.deepEqual([first.users, first.sessions], [1, 1], 'the rep. person and their one live session');
  const acc = await r.app.accounts.byId(String(m.rep._id));
  assert.equal(acc.username, 'Veteran');
  assert.equal(acc.password, HASH, 'the same password hash');
  assert.equal(await r.app.accounts.byUsername('cardsonly'), null, 'mtg-only players stay mtg\'s');
  assert.ok(r.app.app.meta('mongoMigrated', null), 'noted as done');
  // Again: nothing more, nothing doubled.
  const again = await migrateFromMongo({ app: r.app.app, db: m.db });
  assert.deepEqual([again.users, again.sessions], [0, 0]);
  assert.equal(r.app.app.get('SELECT COUNT(*) AS n FROM account WHERE id = ?', String(m.rep._id)).n, 1);
  assert.equal(r.app.app.get('SELECT COUNT(*) AS n FROM session WHERE user_id = ?', String(m.rep._id)).n, 1);
  assert.ok(m.unchanged(), 'Mongo was only read');
});

test('the old ojeeSession cookie is handed over to repSession, once its session was brought over', async () => {
  const m = mtgMongo('Veteran2');
  r.app.app.createProfile({ userId: String(m.rep._id), username: 'Veteran2', tz: 'Africa/Cairo', now: Date.now() });
  await migrateFromMongo({ app: r.app.app, db: m.db });
  const c = r.client();
  c.cookie = `ojeeSession=${m.tok.live}`;
  const me = await c.get('/api/me');
  assert.equal(me.json.user.id, String(m.rep._id), 'signed in, not signed out');
  const sc = me.setCookie.find((x) => x.startsWith('repSession='));
  assert.ok(sc, 'the new cookie is set');
  assert.ok(sc.startsWith(`repSession=${m.tok.live};`) && sc.includes('Domain=.ojee.net'));
  assert.ok(Number(/Max-Age=(\d+)/.exec(sc)[1]) > 28 * 86_400, 'with the session\'s own end');
  assert.equal(c.cookie, `repSession=${m.tok.live}`);
  assert.equal((await c.get('/api/me')).setCookie.length, 0, 'once');
  // An expired session, and an mtg-only one, sign nobody in here.
  for (const t of [m.tok.old, m.tok.mtg]) {
    const x = r.client(); x.cookie = `ojeeSession=${t}`;
    const res = await x.get('/api/me');
    assert.equal(res.json.user, null);
    assert.equal(res.setCookie.length, 0);
  }
  assert.ok(m.unchanged());
});

test('deleting a rep. account, signing out, and the password going leave mtg\'s copy as it was', async () => {
  const m = mtgMongo('Veteran3');
  const id = String(m.rep._id);
  r.app.app.createProfile({ userId: id, username: 'Veteran3', tz: 'Africa/Cairo', now: Date.now() });
  await migrateFromMongo({ app: r.app.app, db: m.db });
  const c = r.client();
  c.cookie = `ojeeSession=${m.tok.live}`;
  // An account from before: it links Google first (its rep. password goes, mtg's stays).
  assert.equal((await c.get('/api/data')).json.code, 'link_required');
  await r.viaGoogle(c, { sub: 'g-veteran3' }, '?link=1');
  assert.equal((await r.app.accounts.byId(id)).password, '');
  assert.deepEqual((await c.post('/api/account/delete', { confirm: 'Veteran3' })).json, { ok: true });
  assert.equal(await r.app.accounts.byId(id), null, 'gone from rep.');
  assert.ok(m.unchanged(), 'the Mongo user, its password and sessions are exactly as they were');
  assert.equal(m.db.collection('users').docs.find((u) => String(u._id) === id).password, HASH);
});
