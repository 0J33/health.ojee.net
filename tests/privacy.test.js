/* The always-private rule, proved rather than promised.

   One person logs an entry of every sensitive kind, each with a value or
   a word that nothing else in the app produces (tests/people.mjs), with
   every privacy switch they have set to public. Then every place that is
   not theirs alone is searched for those values: what anybody can see of
   them, what other signed-in people get from their own routes, what the
   admin sees, the console-module link, the whole global database, and
   the text that would be sent to a language model. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rig } from './helpers.mjs';
import { personWith, SENTINELS, SENTINEL_ROWS, ALL_MARKS, GROUP_OF } from './people.mjs';
import { GROUP_IDS } from '../server/core/google.js';
import { SENSITIVE_KINDS } from '../server/core/entries.js';
import { METRICS } from '../server/catalog.js';
import { METRICS as BOARD, PERIODS } from '../server/social.js';
import { addDays, today as todayIn } from '../server/core/util.js';

const TZ = 'Africa/Cairo';
const OPEN = { account: 'public', activity: true, workouts: true, sleep: true, heart: true, body: true };
const GOOD = JSON.stringify({ headline: 'A steady week', sections: [{ id: 'sleep', title: 'Sleep', text: 'Seven hours a night.' }], nextSteps: ['Walk after lunch.', 'Lights out by 23:00.'], caveats: [] });

let r; let canary; let friend; let admin;
const prompts = [];   // every text this server tried to send to a model
/** Every file under a folder (a person's folder holds their accounts' stores in src/). */
const filesIn = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesIn(join(dir, n)).map((x) => join(n, x)) : [n]));
const found = (text, marks = ALL_MARKS) => { const hay = String(text).toLowerCase(); return marks.filter((m) => hay.includes(m.toLowerCase())); };
const keysOf = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); } return out; };
/** Names a public payload must not grow: the new metrics, sensitive or not. */
const NEW_KEYS = /floor|vo2|resp|cardio|sleepscore|sleep_score|glucose|water|food|mood|symptom|ovulat|cycle|ecg|irn|bodytemp|body_temp|kcal_active|kcalactive|basal|zone|spo2|skin|altitude|sedentary|aishare|pins/i;

before(async () => {
  r = await rig({
    zenFetch: async (url, init) => { prompts.push(JSON.parse(init.body).messages[0].content); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: GOOD } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  canary = await personWith(r, 'canary', { groups: GROUP_IDS, privacy: OPEN });
  friend = await personWith(r, 'friend', { groups: GROUP_IDS, privacy: OPEN });
  admin = await personWith(r, 'ojee', { persona: 'fitbit3' });
  const today = todayIn(Date.now(), TZ);
  for (const [kind, s] of Object.entries(SENTINELS)) {
    const body = kind === 'period' ? { ...s.body, start: addDays(today, -9), end: addDays(today, -6) } : s.body;
    const x = await canary.c.post('/api/entries', { kind, ...body });
    assert.equal(x.status, 200, `${kind}: ${x.text}`);
    assert.equal(x.json.google, 'saved');
  }
  await r.app.worlds.hold(canary.id, async (w) => {
    for (const s of SENTINEL_ROWS) w.db.sampleAdd({ id: `users/me/dataTypes/x/dataPoints/sentinel-${s.kind}`, kind: s.kind, t: Date.now() - 7_200_000, off: 7200, date: today, value: s.value, data: s.data, source: 'google', device: 'Sentinel Watch QZX' });
  });
  // A sync, so everything that publishes has run over the rows.
  await r.app.syncUser(canary.id);
  await r.app.publish(canary.id);
  await canary.c.post('/api/pins', { id: 'glucose', on: true });
  await canary.c.post('/api/pins', { id: 'food', on: true });
  // Friends, so the friend sees the boards and the feed a friend sees.
  assert.equal((await friend.c.post('/api/friends/request', { username: 'canary' })).json.status, 'requested');
  assert.equal((await canary.c.post('/api/friends/accept', { username: 'friend' })).json.status, 'friends');
});
after(async () => { await r.close(); });

test('the search can find them: the person\'s own pages do show every one', async () => {
  const own = [];
  for (const m of METRICS.filter((x) => x.sensitive)) own.push((await canary.c.get(`/api/metric/${m.id}?range=month`)).text);
  const seen = found(own.join('\n'));
  for (const kind of [...Object.keys(SENTINELS), ...SENTINEL_ROWS.map((s) => s.kind)]) {
    const marks = (SENTINELS[kind] || SENTINEL_ROWS.find((s) => s.kind === kind)).marks;
    assert.ok(marks.some((m) => seen.includes(m)), `${kind}: none of ${marks.join(', ')} on the person's own metric page`);
  }
  assert.ok(found(own.join('\n'), ['moodnote-qzx', 'periodnote-qzx', 'gluconote-qzx', 'Sentinel Watch QZX']).length === 4);
  assert.deepEqual(SENSITIVE_KINDS.slice().sort(), Object.keys(GROUP_OF).sort(), 'every sensitive kind has a sentinel');
});

test('nothing sensitive in anything another person, a visitor or the admin can read', async () => {
  const pages = {};
  const grab = async (who, c, path) => { const x = await c.get(path); assert.ok(x.status < 500, `${path}: ${x.status}`); pages[`${who} ${path}`] = x; };
  const anon = r.client();
  // What is public about the person, signed out and signed in.
  for (const [who, c] of [['visitor', anon], ['friend', friend.c], ['admin', admin.c]]) await grab(who, c, '/api/users/canary');
  for (const metric of Object.keys(BOARD)) for (const period of Object.keys(PERIODS)) await grab('friend', friend.c, `/api/leaderboard?metric=${metric}&period=${period}`);
  for (const period of Object.keys(PERIODS)) await grab('friend', friend.c, `/api/boards?period=${period}`);
  // The feed, and every post of the canary's in it, in full.
  await grab('friend', friend.c, '/api/feed?limit=50');
  await grab('friend', friend.c, '/api/friends');
  const posts = pages['friend /api/feed?limit=50'].json.posts.filter((x) => x.author.username === 'canary');
  assert.ok(posts.length > 0, 'the canary has posts to search');
  for (const x of posts.slice(0, 10)) await grab('friend', friend.c, `/api/posts/${x.id}`);
  for (const period of Object.keys(PERIODS)) await grab('friend', friend.c, `/api/compare?with=canary&period=${period}`);
  await grab('friend', friend.c, '/api/people');
  // Everything of another person's own, which must be about them and only them.
  const mine = ['/api/me', '/api/browse', '/api/brief', '/api/data', '/api/trends?days=90', '/api/workouts', '/api/summary', '/api/export', '/api/push', '/api/link', '/api/day', '/api/live',
    ...METRICS.flatMap((m) => ['week', 'year'].map((rg) => `/api/metric/${m.id}?range=${rg}`))];
  for (const path of mine) await grab('friend', friend.c, path);
  // The admin page, and the admin's own routes.
  await grab('admin', admin.c, '/api/admin');
  for (const path of ['/api/me', '/api/browse', '/api/people', '/api/leaderboard']) await grab('admin', admin.c, path);
  // A visitor gets nothing but the public profile.
  for (const path of ['/api/browse', '/api/metric/food', '/api/export']) assert.equal((await anon.get(path)).status, 401, path);

  assert.equal(pages['visitor /api/users/canary'].status, 200, 'the profile is public, so there is something to search');
  assert.ok(pages['friend /api/people'].text.includes('canary'));
  assert.ok(Object.keys(pages).length > 120);
  // A metric page carries its form, and a form lists every choice there is
  // (every mood, every symptom) for everybody alike: that is the catalogue,
  // not somebody's data, so it is set aside before the search.
  const body = (name, x) => (/\/api\/metric\//.test(name) && x.json ? JSON.stringify({ ...x.json, add: null }) : x.text);
  assert.ok(found(pages['friend /api/metric/mood?range=week'].text).includes('AWESTRUCK'), 'the form does list the choice');
  for (const [name, x] of Object.entries(pages)) assert.deepEqual(found(body(name, x)), [], `${name} leaks`);

  // And the public payloads did not grow: none of the new metrics, sensitive or not, is in them.
  for (const name of Object.keys(pages).filter((n) => /\/api\/(users|leaderboard|boards|compare|people|admin|feed|posts|friends)/.test(n))) {
    const grown = [...keysOf(pages[name].json)].filter((k) => NEW_KEYS.test(k));
    assert.deepEqual(grown, [], `${name} has new keys`);
  }
});

test('nothing sensitive in the global database: every table, every row, and the bytes on disk', async () => {
  const file = join(r.config.dataDir, 'app.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    for (const t of ['daily_public', 'public_workout', 'records', 'profile']) assert.ok(tables.includes(t), t);
    let rows = 0;
    for (const t of tables) {
      for (const row of db.prepare(`SELECT * FROM "${t}"`).all()) { rows += 1; assert.deepEqual(found(JSON.stringify(row)), [], `${t} holds a sentinel`); }
    }
    assert.ok(rows > 300, `searched ${rows} rows`);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM daily_public WHERE user_id = ?').get(canary.id).n > 50, 'the person does have public rows');
    // Nothing new became public with this change: the public table is the one it was.
    assert.deepEqual(db.prepare('PRAGMA table_info(daily_public)').all().map((c) => c.name),
      ['user_id', 'date', 'steps', 'active_min', 'kcal', 'distance_m', 'sleep_min', 'bed_min', 'wake_min', 'rhr', 'hrv', 'weight_kg', 'body_fat', 'workouts', 'workout_min', 'run_m', 'ride_m', 'walk_m']);
    const kinds = db.prepare('SELECT DISTINCT kind FROM records').all().map((x) => x.kind).sort();
    assert.deepEqual(kinds.filter((k) => NEW_KEYS.test(k)), []);
  } finally { db.close(); }
  for (const name of readdirSync(r.config.dataDir).filter((n) => n.startsWith('app.sqlite'))) {
    assert.deepEqual(found(readFileSync(join(r.config.dataDir, name)).toString('latin1')), [], `${name} holds a sentinel on disk`);
  }
  // The same search does find them where they belong: the person's own file.
  const own = readdirSync(join(r.config.dataDir, 'users', canary.id)).filter((n) => n.startsWith('health.sqlite')).map((n) => readFileSync(join(r.config.dataDir, 'users', canary.id, n)).toString('latin1')).join('');
  assert.ok(found(own).length >= 8);
  // And in nobody else's.
  for (const id of readdirSync(join(r.config.dataDir, 'users')).filter((x) => x !== canary.id)) {
    for (const name of filesIn(join(r.config.dataDir, 'users', id))) assert.deepEqual(found(readFileSync(join(r.config.dataDir, 'users', id, name)).toString('latin1')), [], `${id}/${name}`);
  }
});

test('sex and year of birth, kept for a scale\'s body ranges, are the person\'s alone: in their own /api/me, nowhere else', async () => {
  const set = await canary.c.patch('/api/settings', { body: { sex: 'female', birthYear: 1937 } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual([set.json.body.sex, set.json.body.birthYear], ['female', 1937]);
  await r.app.publish(canary.id);
  const anon = r.client();
  const seen = [];
  for (const [c, path] of [[anon, '/api/users/canary'], [friend.c, '/api/users/canary'], [admin.c, '/api/users/canary'], [friend.c, '/api/people'], [friend.c, '/api/friends'], [friend.c, '/api/feed?limit=50'],
    [friend.c, '/api/compare?with=canary&period=week'], [friend.c, '/api/boards?period=week'], [friend.c, '/api/me'], [admin.c, '/api/admin']]) {
    const x = await c.get(path);
    assert.ok(x.status < 500, path);
    seen.push([path, x]);
  }
  for (const [path, x] of seen) {
    const keys = [...keysOf(x.json)];
    if (path === '/api/me') assert.deepEqual(x.json.body, { sex: null, birthYear: null, scale: null }, 'the friend sees only their own');
    else assert.deepEqual(keys.filter((k) => /^(sex|birthYear|birth|gender)$/i.test(k)), [], `${path} has a body key`);
  }
  // Not in the global database, in any table or on disk: only in the person's own store.
  for (const name of readdirSync(r.config.dataDir).filter((n) => n.startsWith('app.sqlite'))) {
    const bytes = readFileSync(join(r.config.dataDir, name)).toString('latin1');
    assert.ok(!bytes.includes('birthYear') && !bytes.includes('"sex"'), `${name} holds the body settings`);
  }
  const own = readdirSync(join(r.config.dataDir, 'users', canary.id)).filter((n) => n.startsWith('health.sqlite')).map((n) => readFileSync(join(r.config.dataDir, 'users', canary.id, n)).toString('latin1')).join('');
  assert.ok(own.includes('birthYear'), 'it is in the person\'s own file');
  await canary.c.patch('/api/settings', { body: { sex: null, birthYear: null } });
});

test('the console-module link carries workouts and sets, and nothing that was logged', async () => {
  const key = (await canary.c.post('/api/link/keys', { label: 'console' })).json.key;
  const x = await fetch(`${r.base}/api/link/changes?since=0`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(x.status, 200);
  assert.deepEqual(found(await x.text()), []);
});

test('the privacy switches are the five they were and the feed; a private account still has no public rows at all', async () => {
  const me = (await canary.c.get('/api/me')).json;
  assert.deepEqual(Object.keys(me.privacy).sort(), ['account', 'activity', 'body', 'feed', 'heart', 'sleep', 'workouts']);
  await canary.c.patch('/api/settings', { privacy: { account: 'private' } });
  assert.equal((await friend.c.get('/api/users/canary')).status, 404);
  const db = new DatabaseSync(join(r.config.dataDir, 'app.sqlite'), { readOnly: true });
  try { for (const t of ['daily_public', 'public_workout', 'records', 'post']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(canary.id).n, 0, t); } finally { db.close(); }
  assert.deepEqual((await friend.c.get('/api/feed')).json.posts.filter((x) => x.author.username === 'canary'), []);
  assert.ok(existsSync(join(r.config.dataDir, 'users', canary.id, 'health.sqlite')));
});
