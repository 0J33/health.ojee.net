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
  for (const name of Object.keys(pages).filter((n) => /\/api\/(users|leaderboard|compare|people|admin)/.test(n))) {
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
      ['user_id', 'date', 'steps', 'active_min', 'kcal', 'distance_m', 'sleep_min', 'bed_min', 'wake_min', 'rhr', 'hrv', 'weight_kg', 'body_fat', 'workouts', 'workout_min']);
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

test('the console-module link carries workouts and sets, and nothing that was logged', async () => {
  const key = (await canary.c.post('/api/link/keys', { label: 'console' })).json.key;
  const x = await fetch(`${r.base}/api/link/changes?since=0`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(x.status, 200);
  assert.deepEqual(found(await x.text()), []);
});

/** What each group gives a summary once shared, and what stays out whatever is shared. */
const SHARED_MARKS = { nutrition: ['Zorblat', '3917.25'], mindfulness: ['awestruck'], symptoms: ['burning mouth'], cycle: ['estrogen surge'], ecg: ['sentinel rhythm qzx'] };
const NEVER = ['moodnote-qzx', 'symptomnote-qzx', 'periodnote-qzx', 'gluconote-qzx', '613.25', '41.73', 'URINARY_BLADDER', 'urinary bladder', '43.19', '171.37', '147.31'];

test('the summary: nothing logged reaches the model until the person shares that group, and then only that group', async () => {
  assert.equal((await canary.c.put('/api/ai/key', { key: 'sk-test-key-123456' })).status, 200);
  const write = async () => {
    prompts.length = 0;
    const x = await canary.c.post('/api/summary', { window: 30 });
    assert.ok(x.status === 200 || x.status === 202, x.text.slice(0, 200));
    for (let i = 0; i < 50 && !prompts.length; i += 1) await new Promise((res) => { setTimeout(res, 50); });
    assert.equal(prompts.length, 1, 'one prompt was sent');
    await new Promise((res) => { setTimeout(res, 100); });
    const page = (await canary.c.get('/api/summary')).text;
    const stored = await r.app.worlds.hold(canary.id, async (w) => JSON.stringify(w.db.meta('insight:30')));
    return { prompt: prompts[0], page, stored };
  };
  // Shared with nobody: the default.
  let out = await write();
  assert.ok(out.prompt.includes('"stepsAvg"') && out.prompt.length > 2000, 'the prompt does carry the ordinary numbers');
  assert.deepEqual(found(out.prompt), []);
  assert.deepEqual(found(out.page), []);
  assert.deepEqual(found(out.stored), []);
  assert.ok(!out.prompt.includes('"logged"'));
  // The app's own non-sensitive numbers are there, named as its own.
  assert.match(out.prompt, /"cardio":\{"thisWeekMin":\d+,"targetMin":150,"source":"zone minutes"/);
  assert.match(out.prompt, /"score":\{"nights":\d+,"avg":\d+/);
  assert.match(out.prompt, /"resp":\{"days":\d+/);

  // One group at a time: its marks appear, and nobody else's.
  for (const g of GROUP_IDS) {
    const share = Object.fromEntries(GROUP_IDS.map((id) => [id, id === g]));
    assert.equal((await canary.c.patch('/api/settings', { aiShare: share })).status, 200);
    out = await write();
    const seen = found(out.prompt);
    for (const m of SHARED_MARKS[g]) assert.ok(seen.includes(m) || found(out.prompt, [m]).length, `${g}: ${m} should be in the prompt once shared`);
    const others = GROUP_IDS.filter((id) => id !== g).flatMap((id) => SHARED_MARKS[id]);
    assert.deepEqual(found(out.prompt, others), [], `sharing ${g} must not share another group`);
    assert.deepEqual(found(out.prompt, NEVER), [], `sharing ${g}: notes, glucose and body temperature never go`);
    assert.ok(out.prompt.includes('"logged"'));
  }
  // Everything shared: still no notes, no glucose, no body temperature, no rhythm-notice heart rates.
  await canary.c.patch('/api/settings', { aiShare: Object.fromEntries(GROUP_IDS.map((id) => [id, true])) });
  out = await write();
  for (const m of Object.values(SHARED_MARKS).flat()) assert.equal(found(out.prompt, [m]).length, 1, m);
  assert.deepEqual(found(out.prompt, NEVER), []);
  assert.ok(!/glucose|bodytemp|body_temp/i.test(out.prompt));

  // Shared, but the group switched off: it is not read.
  await canary.c.post('/api/google/groups', { group: 'nutrition', on: false });
  out = await write();
  assert.deepEqual(found(out.prompt, SHARED_MARKS.nutrition), [], 'a group that is off is not read, whatever the switch says');
  assert.equal(found(out.prompt, SHARED_MARKS.mindfulness).length, 1);
  await canary.c.post('/api/google/groups', { group: 'nutrition', on: true });

  // Switched back off: gone from the next prompt.
  await canary.c.patch('/api/settings', { aiShare: Object.fromEntries(GROUP_IDS.map((id) => [id, false])) });
  out = await write();
  assert.deepEqual(found(out.prompt), []);
  assert.deepEqual(found(out.stored), [], 'and from what is kept of the summary');
});

test('the rule-based summary keeps the same rule, and says so plainly when a group is shared', async () => {
  const { summaryStats } = await import('../server/views.js');
  const { rules } = await import('../server/core/insight.js');
  await r.app.worlds.hold(canary.id, async (w) => {
    let s = summaryStats(w, 30).stats;
    assert.equal(s.logged, undefined);
    let text = JSON.stringify(rules(s, ''));
    assert.deepEqual(found(text), []);
    assert.match(text, /Cardio minutes \(calculated by this app from zone minutes\): \d+ of your 150 a week so far this week/);
    assert.match(text, /Sleep score \(calculated by this app\): \d+ of 100 on average/);
    w.setAiShare({ nutrition: true, cycle: true });
    s = summaryStats(w, 30).stats;
    assert.deepEqual(Object.keys(s.logged), ['nutrition', 'cycle']);
    const out = rules(s, '');
    text = JSON.stringify(out);
    assert.deepEqual(out.sections.map((x) => x.id), ['sleep', 'heart', 'activity', 'weight', 'readiness', 'logged']);
    assert.match(out.sections[5].text, /^Water: [\d,]+ ml a day on the 1 day you logged it\. Food: [\d,]+ kcal a day on the 1 day you logged it, about 92 g protein\. Periods logged: \d{4}-\d{2}-\d{2} \(4 days\)\.$/);
    assert.deepEqual(found(text, NEVER), []);
    // "Last night" looks at one day, not at a month of entries.
    assert.deepEqual(summaryStats(w, 'night').stats.logged.cycle.periods, []);
    w.setAiShare({ nutrition: false, cycle: false });
    assert.equal(summaryStats(w, 30).stats.logged, undefined);
  });
});

test('the privacy switches are the five they were; a private account still has no public rows at all', async () => {
  const me = (await canary.c.get('/api/me')).json;
  assert.deepEqual(Object.keys(me.privacy).sort(), ['account', 'activity', 'body', 'heart', 'sleep', 'workouts']);
  await canary.c.patch('/api/settings', { privacy: { account: 'private' } });
  assert.equal((await friend.c.get('/api/users/canary')).status, 404);
  const db = new DatabaseSync(join(r.config.dataDir, 'app.sqlite'), { readOnly: true });
  try { for (const t of ['daily_public', 'public_workout', 'records']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(canary.id).n, 0, t); } finally { db.close(); }
  assert.ok(existsSync(join(r.config.dataDir, 'users', canary.id, 'health.sqlite')));
});
