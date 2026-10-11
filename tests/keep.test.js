/* What is kept and what is not: a database from before the app's own
   numbers gets them for its whole history; the export has everything
   logged; disconnecting keeps the history; "delete my health data"
   leaves nothing. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rig } from './helpers.mjs';
import { personWith, SENTINELS, ALL_MARKS } from './people.mjs';
import { openDb } from '../server/core/db.js';
import { storeDerived, DERIVED_VERSION } from '../server/browse.js';
import { GROUP_IDS } from '../server/core/google.js';
import { GOAL_DEFAULTS } from '../server/worlds.js';
import { rules } from '../server/core/insight.js';
import { addDays, today as todayIn } from '../server/core/util.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const TZ = 'Africa/Cairo';
const found = (text, marks = ALL_MARKS) => { const hay = String(text).toLowerCase(); return marks.filter((m) => hay.includes(m.toLowerCase())); };

test('storeDerived on a bare store: the whole history once, then nothing to do; a new sleep goal re-scores', () => {
  const db = openDb(':memory:');
  const now = Date.parse('2026-06-15T10:00:00Z');
  const today = '2026-06-15';
  let goal = 450;
  const world = { db, tz: 'UTC', now: () => now, settings: () => ({ ...GOAL_DEFAULTS, sleepTarget: goal }) };
  for (let k = 0; k < 200; k += 1) {
    const date = addDays(today, -k);
    db.setDaily(date, 'steps', 8000);
    if (k % 3 === 0) db.setDaily(date, 'azm', 30);
    else if (k % 3 === 1) { db.setDaily(date, 'zone_moderate', 10); db.setDaily(date, 'zone_peak', 5); }
    const startMs = Date.parse(`${addDays(date, -1)}T23:00:00Z`);
    db.upsertSleep({ id: `n-${date}`, date, startMs, endMs: startMs + 480 * 60_000, startOff: 0, endOff: 0, main: true, asleepMin: 420, awakeMin: 60, periodMin: 480, stages: [], summary: { stages: { DEEP: 70, REM: 90, LIGHT: 260, AWAKE: 60 } } });
    db.setDaily(date, 'sleep_min', 420);
  }
  db.upsertSleep({ id: 'nap', date: today, startMs: now - 3_600_000, endMs: now, startOff: 0, endOff: 0, main: false, asleepMin: 50, awakeMin: 10, periodMin: 60, stages: [], summary: {} });
  assert.equal(db.meta('derived'), null);
  const n = storeDerived(world);
  // 67 + 67 days of cardio (a third have nothing to count), 200 nights.
  assert.equal(n, 67 + 67 + 200);
  assert.deepEqual(db.meta('derived'), { v: DERIVED_VERSION, at: now, sleepGoal: 450 });
  const t = db.dailyTable('0000-00-00');
  assert.deepEqual([t[today].cardio_min, t[addDays(today, -1)].cardio_min, t[addDays(today, -2)].cardio_min], [30, 20, undefined]);
  assert.equal(t[addDays(today, -199)].cardio_min, 20, 'the oldest day too');
  // 420 of 450 min: 46.7 of 50; stages 20; 87.5% asleep: 12.5 of 15; perfectly regular: 15.
  assert.equal(t[today].sleep_score, 94);
  // The first nights have no "usual" yet: scored out of 85.
  assert.equal(t[addDays(today, -199)].sleep_score, Math.round(((46.7 + 20 + 12.5) / 85) * 100));
  assert.equal(Object.values(t).filter((x) => Number.isFinite(x.sleep_score)).length, 200);
  // Again: nothing changes, nothing is written.
  assert.equal(storeDerived(world), 0);
  assert.equal(storeDerived(world, { full: true }), 0);
  // A day's source going away takes its cardio minutes with it.
  db.deleteDaily(today, 'azm');
  assert.equal(storeDerived(world), 1);
  assert.equal(db.dailyValue(today, 'cardio_min'), null);
  // A new goal: every night is scored again, old ones included.
  goal = 420;
  assert.equal(storeDerived(world), 200);
  assert.equal(db.dailyValue(addDays(today, -150), 'sleep_score'), Math.round(50 + 20 + 12.5 + 15));
  assert.equal(db.meta('derived').sleepGoal, 420);
  db.close();
});

test('a database from before the scores gets them: at the next read, and at the next sync', async () => {
  const p = await personWith(r, 'veteran');
  const scores = () => r.app.worlds.hold(p.id, async (w) => w.db.db.prepare("SELECT metric, COUNT(*) AS n, SUM(value) AS s FROM daily WHERE metric IN ('sleep_score', 'cardio_min') GROUP BY metric ORDER BY metric").all().map((x) => ({ ...x })));
  const had = await scores();
  assert.deepEqual(had.map((x) => x.metric), ['cardio_min', 'sleep_score']);
  assert.ok(had[0].n >= 85 && had[1].n >= 85, 'the first sync already scored the whole backfill');
  /** Make it the database it would have been before this change. */
  const age = () => r.app.worlds.hold(p.id, async (w) => { w.db.db.exec("DELETE FROM daily WHERE metric IN ('sleep_score', 'cardio_min'); DELETE FROM meta WHERE key = 'derived'"); });
  await age();
  assert.deepEqual(await scores(), []);
  // Opening Browse is enough.
  const b = (await p.c.get('/api/browse')).json;
  assert.ok(b.categories.find((c) => c.id === 'sleep').metrics.some((m) => m.id === 'sleep_score'));
  assert.deepEqual(await scores(), had);
  // So is the metric page, or Today, or a sync.
  for (const go of [() => p.c.get('/api/metric/sleep_score?range=year'), () => p.c.get('/api/brief'), () => r.app.syncUser(p.id)]) {
    await age();
    await go();
    assert.deepEqual(await scores(), had);
  }
  const year = (await p.c.get('/api/metric/sleep_score?range=year')).json;
  assert.equal(year.stats.count, had[1].n, 'every past night has its score');
  // Each night's entry carries the parts the score was made of, and they add up to it.
  for (const e of year.entries.slice(0, 5)) {
    assert.ok(e.parts.length >= 2 && e.parts.every((x) => x.label && x.points >= 0 && x.points <= x.max), 'a score comes with its parts');
    const got = e.parts.reduce((a, x) => a + x.points, 0); const max = e.parts.reduce((a, x) => a + x.max, 0);
    assert.equal(Math.round((got / max) * 100), e.value);
  }
  assert.equal((await p.c.get('/api/metric/steps?range=week')).json.entries[0].parts, undefined, 'only a score has parts');
  // The public rows know nothing of either.
  assert.ok(!JSON.stringify((await p.c.get('/api/users/veteran')).json).match(/sleep_score|cardio/i));
});

test('GET /api/export: everything logged, without what was deleted and without the sync bookkeeping', async () => {
  const p = await personWith(r, 'exporter', { groups: GROUP_IDS });
  const today = todayIn(Date.now(), TZ);
  const ids = {};
  for (const [kind, s] of Object.entries(SENTINELS)) {
    const body = kind === 'period' ? { ...s.body, start: addDays(today, -9), end: addDays(today, -6) } : s.body;
    ids[kind] = (await p.c.post('/api/entries', { kind, ...body })).json.entry.id;
  }
  const gone = (await p.c.post('/api/entries', { kind: 'water', ml: 4444.75 })).json.entry.id;
  assert.equal((await p.c.del(`/api/entries/${gone}`)).status, 200);
  await p.c.post('/api/pins', { id: 'water', on: true });
  await p.c.patch('/api/settings', { goals: { cardioWeek: 210, waterMl: 3000 }, aiShare: { cycle: true } });
  // A row with a failed write keeps its error inside `data._g`: that must not be exported.
  await r.app.worlds.hold(p.id, async (w) => { const row = w.db.sampleGet(ids.mood); w.db.samplePatch(row.id, { data: { ...row.data, _g: { error: 'internal-qzx', attempts: 2 } } }); });

  const x = await p.c.get('/api/export');
  assert.equal(x.status, 200);
  const e = x.json;
  for (const k of ['samples', 'groups', 'pins', 'aiShare', 'goals', 'daily', 'sleep', 'weight']) assert.ok(k in e, k);
  assert.deepEqual(e.groups, { nutrition: true, mindfulness: true, symptoms: true, cycle: true, ecg: true });
  assert.deepEqual(e.pins, ['water']);
  assert.deepEqual(e.aiShare, { nutrition: false, mindfulness: false, symptoms: false, cycle: true, ecg: false });
  assert.deepEqual([e.goals.cardioWeek, e.goals.waterMl], [210, 3000]);
  const total = await r.app.worlds.hold(p.id, async (w) => w.db.db.prepare('SELECT COUNT(*) AS n FROM sample WHERE deleted = 0').get().n);
  assert.equal(e.samples.length, total);
  assert.deepEqual(Object.keys(e.samples[0]), ['id', 'kind', 't', 'end', 'date', 'value', 'text', 'data', 'source', 'device', 'google']);
  for (const kind of [...Object.keys(SENTINELS), 'ecg', 'bodyfat', 'height']) assert.ok(e.samples.some((s) => s.kind === kind), `export has ${kind}`);
  for (const kind of Object.keys(SENTINELS)) assert.ok(e.samples.some((s) => s.id === ids[kind] && s.source === 'app'), kind);
  const mood = e.samples.find((s) => s.id === ids.mood);
  assert.deepEqual(mood.data, { moods: ['AWESTRUCK'], valence: 'UNPLEASANT', note: 'moodnote-qzx' });
  assert.ok(!x.text.includes('"_g"') && !x.text.includes('internal-qzx') && !x.text.includes('"attempts"'), 'no bookkeeping');
  assert.ok(!e.samples.some((s) => s.id === gone) && !x.text.includes('4444.75'), 'a deleted entry is not exported');
  assert.ok(Number.isFinite(Object.values(e.daily).pop().sleep_score ?? Object.values(e.daily).slice(-2)[0].sleep_score), 'the scores are in the daily table');
  assert.ok(!/refresh|access_token|demo-rt/.test(x.text), 'no tokens');
});

test('disconnecting keeps the history; "delete my health data" leaves nothing', async () => {
  const p = await personWith(r, 'leaver', { groups: GROUP_IDS, privacy: { account: 'public', activity: true, workouts: true, sleep: true, heart: true, body: true } });
  const today = todayIn(Date.now(), TZ);
  for (const [kind, s] of Object.entries(SENTINELS)) await p.c.post('/api/entries', { kind, ...(kind === 'period' ? { ...s.body, start: addDays(today, -9), end: addDays(today, -6) } : s.body) });
  await p.c.post('/api/pins', { id: 'mood', on: true });
  const before = (await p.c.get('/api/browse')).json;
  const rows = await r.app.worlds.hold(p.id, async (w) => w.db.db.prepare('SELECT COUNT(*) AS n FROM sample').get().n);
  assert.ok(rows >= 12);

  // Disconnect: Google is gone, what is here stays, and the groups become local.
  const me = (await p.c.post('/api/google/disconnect', {})).json;
  assert.equal(me.google.state, 'needs_auth');
  assert.deepEqual(me.google.groups.map((g) => g.mode), ['local', 'local', 'local', 'local', 'local']);
  const after = (await p.c.get('/api/browse')).json;
  assert.deepEqual(after.categories.flatMap((c) => c.metrics.map((m) => [m.id, m.latest.text])), before.categories.flatMap((c) => c.metrics.map((m) => [m.id, m.latest.text])));
  assert.equal(await r.app.worlds.hold(p.id, async (w) => w.db.db.prepare('SELECT COUNT(*) AS n FROM sample').get().n), rows);
  assert.equal((await p.c.get('/api/metric/food?range=month')).json.entries[0].text, 'Zorblat stew, 7,613.5 kcal (dinner)');
  // Logging goes on, kept here.
  const x = (await p.c.post('/api/entries', { kind: 'water', ml: 250 })).json;
  assert.deepEqual([x.google, x.message], ['local', 'Kept on this site only: Google Health is not connected.']);
  // An edit of an entry Google already holds is owed to it, and said so.
  const food = (await p.c.get('/api/metric/food')).json.entries[0];
  const ed = (await p.c.patch(`/api/entries/${food.id}`, { kcal: 7613.5 })).json;
  assert.equal(ed.google, 'failed');
  assert.match(ed.message, /^Saved here\. Google Health did not take it \(it is not connected\)/);

  // Delete: the folder, the profile, the public rows.
  const dir = join(r.config.dataDir, 'users', p.id);
  assert.ok(existsSync(join(dir, 'health.sqlite')));
  assert.equal((await p.c.post('/api/account/delete-data', { confirm: 'nope' })).status, 400);
  assert.ok(existsSync(join(dir, 'health.sqlite')), 'a wrong confirmation deletes nothing');
  assert.equal((await p.c.post('/api/account/delete-data', { confirm: 'leaver' })).status, 200);
  await new Promise((res) => { setTimeout(res, 150); });
  assert.equal(existsSync(dir), false, 'the person\'s folder is gone, sample rows and all');
  for (const t of ['daily_public', 'public_workout', 'records']) assert.equal(r.app.app.all(`SELECT * FROM ${t} WHERE user_id = ?`, p.id).length, 0, t);
  // Nothing of theirs is left under the data directory: no folder of
  // their own, and nothing in the files that are everybody's. (Other
  // people's folders are other people's.)
  assert.ok(!readdirSync(join(r.config.dataDir, 'users')).includes(p.id));
  const shared = readdirSync(r.config.dataDir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => join(r.config.dataDir, f.name));
  assert.ok(shared.some((f) => f.endsWith('app.sqlite')));
  for (const file of shared) assert.deepEqual(found(readFileSync(file).toString('latin1')), [], `${file} still holds an entry`);
  // The account still signs in, to an empty app: no entries, no pins, no groups.
  const again = (await p.c.get('/api/browse')).json;
  assert.deepEqual([again.categories, again.pinned, again.groups.filter((g) => g.chosen)], [[], [], []]);
  const m = (await p.c.get('/api/metric/glucose?range=year')).json;
  assert.deepEqual([m.entries, m.chart.points, m.metric.latest], [[], [], null]);
  assert.deepEqual((await p.c.get('/api/me')).json.pins, []);
  assert.equal((await p.c.get('/api/metric/food')).status, 409);
});

test('the rule-based summary: cardio against the target, the score with its weakest part, breathing only when it moved', () => {
  const base = {
    window: 7, label: 'the last 7 days', today: '2026-06-15', from: '2026-06-09', to: '2026-06-15', completeFrom: '2026-06-08', completeTo: '2026-06-14',
    coverage: { days: 7, stepsDays: 7, rhrDays: 7, hrvDays: 7, sleepNights: 7, firstData: '2026-01-01', firstWearable: '2026-01-01' },
    sleep: { nights: 7, asleepAvgMin: 440, asleepMedianMin: 440, asleepMinMin: 400, asleepMaxMin: 470, inBedAvgMin: 480, efficiencyPct: 91.7, under7h: 1, under6h: 0, stagesPct: null, stagedNights: 0, wakeBoutsPerNight: 0, wakeMinPerNight: 0, wakeCluster: null, bedtimeAvg: '23:10', bedtimeSdMin: 20, wakeAvg: '07:00', wakeSdMin: 15, fallAsleepAvgMin: null },
    heart: {
      rhr: { days: 7, mean: 58, min: 56, max: 60, latest: 58, latestDate: '2026-06-15', baseline: 58, baselineDays: 30, vsBaseline: 0, vsBaselinePct: 0, perWeek: 0 },
      hrv: { days: 7, mean: 50, min: 45, max: 55, latest: 50, latestDate: '2026-06-15', baseline: 50, baselineDays: 30, vsBaseline: 0, vsBaselinePct: 0, perWeek: 0 },
    },
    activity: { stepTarget: 8000, azmTarget: 22, completeDays: 7, stepsAvg: 9000, stepsMedian: 9000, stepsMin: 7000, stepsMax: 11000, daysUnder5k: 0, daysUnder7500: 1, daysAtTarget: 6, pctUnder5k: 0, weekday: [], bestDay: null, worstDay: null, todaySoFar: 3000, yesterday: 9000, azmAvg: null, azmPerWeek: null, azmDaysAtTarget: 0, azmZones: { fatBurn: 0, cardio: 0, peak: 0 }, workouts: [], gym: { days: [], sessions: 0, sets: 0, volumeKg: 0, muscles: {} } },
    weight: { weighIns: 5, latestKg: 80, firstAvg7: 80, lastAvg7: 80, change: 0, perWeek: 0, timeOfDaySpreadH: 0.5, bodyFatLatest: null, caveats: [] },
    readiness: { latest: { date: '2026-06-15', level: 'normal', label: 'Normal day', text: 'in your usual range', score: 0 }, levels: { push: 0, normal: 7, easy: 0, rest: 0, learning: 0, unavailable: 0 }, avgScore: 0, illness: null },
  };
  const text = (s) => Object.fromEntries(rules(s, '').sections.map((x) => [x.id, x.text]));
  const plain = text(base);
  assert.ok(!/Cardio minutes|Sleep score|Breathing|VO2/.test(JSON.stringify(plain)), 'nothing is said about what is not there');
  const s = structuredClone(base);
  s.activity.cardio = { thisWeekMin: 96, targetMin: 150, source: 'zone minutes', lastWeekMin: 162, weeksAtTarget: 3, weeksCounted: 4 };
  s.sleep.score = { nights: 7, avg: 81, weakestPart: 'regularity' };
  s.heart.resp = { days: 7, mean: 14.2, latest: 14.3, baseline: 14.0, vsBaseline: 0.2 };
  s.heart.vo2max = { latest: 44.3, date: '2026-06-12' };
  let t = text(s);
  assert.match(t.activity, /Cardio minutes \(calculated by this app from zone minutes\): 96 of your 150 a week so far this week, 162 last week; target met in 3 of the last 4 full weeks\./);
  assert.match(t.sleep, /Sleep score \(calculated by this app\): 81 of 100 on average; regularity is the part that held it back most\./);
  assert.match(t.heart, /VO2 max estimate 44\.3 ml\/kg\/min \(2026-06-12\)\./);
  assert.ok(!/Breathing/.test(t.heart), 'a breathing rate at its usual is not worth a sentence');
  s.heart.resp = { days: 7, mean: 15.9, latest: 16.1, baseline: 14.0, vsBaseline: 1.9 };
  t = text(s);
  assert.match(t.heart, /Breathing rate during sleep 15\.9 a minute, \+1\.9 against your usual 14\./);
  assert.ok(!/Breathing/.test(t.readiness), 'and it is no warning on its own');
  s.readiness.illness = 'Possible illness coming on: resting HR up +5 bpm or more for 2 days. Take it easy and watch for symptoms.';
  t = text(s);
  assert.match(t.readiness, /Early warning: Possible illness coming on.* Breathing rate during sleep is also 1\.9 a minute above your usual\.$/);
  assert.ok(!/stress|diagnos/i.test(JSON.stringify(t)));
  // The headline and the five sections are what they were.
  assert.deepEqual(Object.keys(t), ['sleep', 'heart', 'activity', 'weight', 'readiness']);
});
