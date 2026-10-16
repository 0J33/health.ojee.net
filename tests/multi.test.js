/* Several Google accounts for one person (one tracker per account): the
   fold of their stores into the person's own (core/merge.js), the
   quarter-hour check of days two devices share, and the whole thing
   through the running app: adding, reconnecting, renaming, the main
   account, leaving one out, removing one, the rules, and a store from
   before there could be several. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../server/core/db.js';
import { mergeAll, mergeRules, reconcile, MERGE_DEFAULTS } from '../server/core/merge.js';
import { UserWorld, maxWindows, combineHr } from '../server/worlds.js';
import { rig } from './helpers.mjs';
import { addDays, today as todayIn, localToMs } from '../server/core/util.js';

const TZ = 'Africa/Cairo';
const D = '2026-10-10';
const at = (hh, mm = 0, date = D) => localToMs(date, hh * 60 + mm, TZ);
const src = (id, fill = () => {}) => { const db = openDb(); fill(db); return { id, db }; };
const day = (db, date, m) => { for (const [k, v] of Object.entries(m)) db.setDaily(date, k, v); };
const sleep = (id, start, end, asleep, extra = {}) => ({
  id, date: extra.date || D, startMs: start, endMs: end, startOff: 7200, endOff: 7200, main: extra.main ?? true,
  asleepMin: asleep, awakeMin: extra.awake ?? 20, periodMin: Math.round((end - start) / 60_000), stages: [], summary: { stages: extra.stages || { DEEP: 60, REM: 90, LIGHT: asleep - 150 } },
});
const ex = (id, start, end, extra = {}) => ({ id, date: D, startMs: start, endMs: end, type: 'WALKING', name: 'Walk', kcal: null, azm: null, avgHr: null, steps: null, distanceM: null, ...extra });

/* ── the fold ─────────────────────────────────────────────────────── */

test('one account: the fold is a plain copy, whatever the rules say', () => {
  const a = src('main', (db) => {
    day(db, D, { steps: 9000, kcal: 2100, kcal_active: 2300, kcal_basal: 0, rhr: 58, level_sedentary: 1500, level_light: 50 });
    db.upsertSleep(sleep('s1', at(-2), at(6), 420));
  });
  const main = openDb();
  mergeAll(main, [a], { rules: { ...MERGE_DEFAULTS, activity: 'max' } });
  const t = main.dailyTable(D)[D];
  // Odd numbers stay as the device sent them: nothing is "fixed" for one device.
  assert.deepEqual([t.steps, t.kcal, t.kcal_basal, t.rhr, t.level_sedentary], [9000, 2100, 0, 58, 1500]);
  assert.equal(t.sleep_min, 420);
  assert.equal(main.sleeps(D).length, 1);
});

test('activity totals: added up, the larger, or the main account\'s', () => {
  const mk = () => [src('main', (db) => day(db, D, { steps: 6000, distance_m: 4500, azm: 20 })), src('work', (db) => day(db, D, { steps: 4000, distance_m: 3000, azm: 10 }))];
  const run = (activity) => { const main = openDb(); mergeAll(main, mk(), { rules: mergeRules({ activity }) }); return main.dailyTable(D)[D]; };
  assert.deepEqual([run('sum').steps, run('sum').distance_m, run('sum').azm], [10000, 7500, 30]);
  assert.deepEqual([run('max').steps, run('max').azm], [6000, 20]);
  assert.deepEqual([run('primary').steps, run('primary').azm], [6000, 20]);
  // 'auto' before the quarter-hours were read: added up.
  assert.equal(run('auto').steps, 10000);
});

test('auto: what the quarter-hours showed was counted twice comes off, and later growth still adds', () => {
  const srcs = [src('main', (db) => day(db, D, { steps: 6000 })), src('work', (db) => day(db, D, { steps: 4000 }))];
  const main = openDb();
  // The check found 1500 steps both devices counted (the commute, wearing both).
  main.setMeta(`recon:${D}`, { fp: 'x', at: 0, sum: { steps: 10000 }, val: { steps: 8500 } });
  mergeAll(main, srcs, { rules: mergeRules({ activity: 'auto' }) });
  assert.equal(main.dailyTable(D)[D].steps, 8500);
  // 600 more steps since, on one device: they count.
  srcs[1].db.setDaily(D, 'steps', 4600);
  mergeAll(main, srcs, { rules: mergeRules({ activity: 'auto' }) });
  assert.equal(main.dailyTable(D)[D].steps, 9100);
  // Never below what one device alone recorded.
  main.setMeta(`recon:${D}`, { fp: 'x', at: 0, sum: { steps: 10600 }, val: { steps: 100 } });
  mergeAll(main, srcs, { rules: mergeRules({ activity: 'auto' }) });
  assert.equal(main.dailyTable(D)[D].steps, 6000);
});

test('calories: one resting burn for the day, plus both devices\' active energy', () => {
  // Each tracker counts the resting burn all day long, worn or not.
  const srcs = [
    src('main', (db) => day(db, D, { kcal: 2400, kcal_active: 600, kcal_basal: 1800 })),
    src('work', (db) => day(db, D, { kcal: 2150, kcal_active: 400, kcal_basal: 1750 })),
  ];
  const main = openDb();
  mergeAll(main, srcs, { rules: mergeRules({ activity: 'sum' }) });
  const t = main.dailyTable(D)[D];
  assert.deepEqual([t.kcal_basal, t.kcal_active, t.kcal], [1800, 1000, 2800]);
  // Without the active part, the larger total.
  const s2 = [src('main', (db) => day(db, D, { kcal: 2400 })), src('work', (db) => day(db, D, { kcal: 2150 }))];
  const m2 = openDb();
  mergeAll(m2, s2);
  assert.equal(m2.dailyTable(D)[D].kcal, 2400);
});

test('minutes in the activity levels never add up past a day', () => {
  const srcs = [
    src('main', (db) => day(db, D, { level_sedentary: 900, level_light: 200, sedentary_min: 900 })),
    src('work', (db) => day(db, D, { level_sedentary: 500, level_light: 100, level_moderate: 30, sedentary_min: 500 })),
  ];
  const main = openDb();
  mergeAll(main, srcs, { rules: mergeRules({ activity: 'sum' }) });
  const t = main.dailyTable(D)[D];
  assert.equal(t.level_light + t.level_moderate + t.level_sedentary, 1440);
  assert.equal(t.level_sedentary, 1110);
  assert.equal(t.sedentary_min, 1440 - 330);
});

test('overnight readings come from the device that recorded the night, or from the chosen account', () => {
  const srcs = [
    src('main', (db) => { day(db, D, { rhr: 60, hrv: 30, spo2: 95 }); db.upsertSleep(sleep('home', at(-1, -30), at(6, 30), 430)); }),
    // The work tracker was only worn at work: a nap, no night.
    src('work', (db) => { day(db, D, { rhr: 66, hrv: 22, spo2: 97, vo2max: 44, hr_min: 48, hr_max: 150 }); db.upsertSleep(sleep('nap', at(14), at(14, 40), 35, { main: false })); }),
  ];
  srcs[0].db.setDaily(D, 'hr_min', 52); srcs[0].db.setDaily(D, 'hr_max', 170); srcs[0].db.setDaily(D, 'vo2max', 41);
  const main = openDb();
  mergeAll(main, srcs);
  let t = main.dailyTable(D)[D];
  assert.deepEqual([t.rhr, t.hrv, t.spo2], [60, 30, 95], 'the home device slept');
  assert.deepEqual([t.hr_min, t.hr_max], [48, 170], 'the day\'s range covers both');
  assert.equal(t.vo2max, 41, 'one reading a day: the main account\'s');
  assert.equal(main.sleeps(D).length, 2, 'the nap is kept: it is not the same sleep');
  assert.equal(t.sleep_min, 430);
  // The other way round: the work tracker slept (worn to bed that night).
  srcs[1].db.upsertSleep(sleep('worknight', at(-1), at(7), 460));
  mergeAll(main, srcs);
  t = main.dailyTable(D)[D];
  assert.deepEqual([t.rhr, t.hrv, t.sleep_min], [66, 22, 460], 'the fuller night, and its readings');
  assert.deepEqual(main.sleeps(D).map((s) => s.id).sort(), ['nap', 'worknight'], 'the same night twice: the fuller one stays');
  // Chosen: always the main account's overnight readings.
  mergeAll(main, srcs, { rules: mergeRules({ overnight: 'main' }, ['main', 'work']) });
  assert.equal(main.dailyTable(D)[D].rhr, 60);
});

test('a night split across two trackers adds up', () => {
  const srcs = [
    src('main', (db) => db.upsertSleep(sleep('first', at(-1), at(3), 220, { stages: { DEEP: 50, REM: 40, LIGHT: 130 } }))),
    src('work', (db) => db.upsertSleep(sleep('second', at(3, 20), at(7), 200, { stages: { DEEP: 30, REM: 60, LIGHT: 110 } }))),
  ];
  const main = openDb();
  mergeAll(main, srcs);
  const t = main.dailyTable(D)[D];
  assert.deepEqual([t.sleep_min, t.sleep_deep, t.sleep_rem, t.sleep_light], [420, 80, 100, 240]);
});

test('workouts: one recorded by both is kept once, the fuller record; or both, if asked', () => {
  const srcs = [
    src('main', (db) => db.upsertExercise(ex('users/me/dataTypes/exercise/dataPoints/a', at(18), at(19)))),
    src('work', (db) => {
      db.upsertExercise(ex('users/me/dataTypes/exercise/dataPoints/b', at(18, 5), at(19, 2), { avgHr: 128, kcal: 420 }));
      db.upsertExercise(ex('users/me/dataTypes/exercise/dataPoints/c', at(8), at(8, 30)));
    }),
  ];
  const main = openDb();
  mergeAll(main, srcs);
  assert.deepEqual(main.exercises(D).map((e) => e.id.split('/').pop()), ['c', 'b'], 'the one with heart rate and calories');
  mergeAll(main, srcs, { rules: mergeRules({ workouts: 'keep' }) });
  assert.deepEqual(main.exercises(D).map((e) => e.id.split('/').pop()), ['c', 'a', 'b']);
  // One this app saved is always the one kept: it is the workout here.
  mergeAll(main, srcs, { own: new Set(['users/me/dataTypes/exercise/dataPoints/a']) });
  assert.deepEqual(main.exercises(D).map((e) => e.id.split('/').pop()), ['c', 'a']);
  // Deleted at Google (gone from its account's store): gone here.
  srcs[1].db.deleteExercise('c');
  mergeAll(main, srcs);
  assert.deepEqual(main.exercises(D).map((e) => e.id.split('/').pop()), ['b']);
});

test('one scale syncing to both accounts: the weigh-in and the reading appear once', () => {
  const t0 = at(7, 30);
  const srcs = [
    src('main', (db) => { db.upsertWeight({ t: t0, grams: 80_100, source: 'google' }); db.sampleUpsert({ kind: 'glucose', t: t0, date: D, value: 95, gname: 'users/me/dataTypes/blood-glucose/dataPoints/m1' }); }),
    src('work', (db) => {
      db.upsertWeight({ t: t0 + 60_000, grams: 80_100, source: 'google' });
      db.upsertWeight({ t: at(20), grams: 80_900, source: 'google' });
      db.sampleUpsert({ kind: 'glucose', t: t0 + 30_000, date: D, value: 95, gname: 'users/me/dataTypes/blood-glucose/dataPoints/w1' });
      db.sampleUpsert({ kind: 'glucose', t: at(12), date: D, value: 140, gname: 'users/me/dataTypes/blood-glucose/dataPoints/w2' });
    }),
  ];
  const main = openDb();
  mergeAll(main, srcs);
  assert.deepEqual(main.weights(0).map((w) => [w.t, w.grams]), [[t0, 80_100], [at(20), 80_900]]);
  assert.deepEqual(main.samples('glucose').map((r) => r.value).sort(), [140, 95]);
  assert.equal(main.samples('glucose').find((r) => r.value === 95).gname, 'users/me/dataTypes/blood-glucose/dataPoints/m1', 'the main account\'s copy');
});

test('an account taken out takes what only it had, and leaves what is shared', () => {
  const a = src('main', (db) => { day(db, D, { steps: 6000, rhr: 60 }); db.upsertSleep(sleep('home', at(-1), at(6), 400)); });
  const b = src('work', (db) => {
    day(db, D, { steps: 4000, floors: 9 });
    day(db, addDays(D, -1), { steps: 3000 });
    db.upsertExercise(ex('users/me/dataTypes/exercise/dataPoints/w', at(12), at(12, 40)));
    db.upsertWeight({ t: at(9), grams: 81_000, source: 'google' });
    db.sampleUpsert({ kind: 'bodytemp', t: at(9), date: D, value: 36.6, gname: 'users/me/dataTypes/core-body-temperature/dataPoints/t' });
  });
  const main = openDb();
  main.setDaily(D, 'cardio_min', 40);   // the app's own
  main.setDaily(addDays(D, -5), 'height_mm', 1800);   // logged here, never from any account
  mergeAll(main, [a, b], { rules: mergeRules({ activity: 'sum' }) });
  assert.deepEqual([main.dailyTable(D)[D].steps, main.dailyTable(D)[D].floors], [10000, 9]);
  mergeAll(main, [a], { gone: [b.db] });
  const t = main.dailyTable(addDays(D, -5));
  assert.deepEqual([t[D].steps, t[D].floors, t[D].rhr, t[addDays(D, -1)]], [6000, undefined, 60, undefined]);
  assert.equal(t[D].cardio_min, 40, 'the app\'s own numbers are not the fold\'s');
  assert.equal(t[addDays(D, -5)].height_mm, 1800, 'nor what no account ever had');
  assert.deepEqual([main.exercises(D).length, main.weights(0).length, main.samples('bodytemp').length], [0, 0, 0]);
  assert.equal(main.sleeps(D).length, 1);
});

test('quarter-hours: each window keeps the larger device, so nothing counts twice and nothing is lost', async () => {
  // Home tracker 07:00-09:00, both 09:00-09:30 (the commute), work tracker 09:30-17:00.
  const win = (h0, h1, perQ) => {
    const out = [];
    for (let t = at(h0); t < at(h1); t += 900_000) out.push({ startTime: new Date(t).toISOString(), endTime: new Date(t + 900_000).toISOString(), steps: { countSum: String(perQ) } });
    return out;
  };
  const home = [...win(7, 9, 500), ...win(9, 9.5, 300)];
  const work = [...win(9, 9.5, 320), ...win(9.5, 17, 200)];
  const fake = (pts) => ({ rollUp: async (type) => (type === 'steps' ? pts : []) });
  const a = { id: 'main', db: openDb(), google: fake(home) };
  const b = { id: 'work', db: openDb(), google: fake(work) };
  day(a.db, D, { steps: 8 * 500 + 2 * 300 });
  day(b.db, D, { steps: 2 * 320 + 30 * 200 });
  const main = openDb();
  const now = localToMs(addDays(D, 1), 600, TZ);
  assert.equal(await reconcile({ main, accounts: [a, b], tz: TZ, now }), 1);
  const rec = main.meta(`recon:${D}`);
  assert.deepEqual([rec.sum.steps, rec.val.steps], [4600 + 6640, 4000 + 640 + 6000]);
  mergeAll(main, [a, b]);
  assert.equal(main.dailyTable(D)[D].steps, 10640, 'the commute once, at the larger count');
  // Nothing changed: not asked again.
  assert.equal(await reconcile({ main, accounts: [a, b], tz: TZ, now: now + 3_600_000 }), 0);
  // A device that will not give a type in windows: that type stays added up.
  const refuse = { rollUp: async () => { throw Object.assign(new Error('nope'), { status: 400 }); } };
  const m2 = openDb();
  await reconcile({ main: m2, accounts: [a, { ...b, google: refuse }], tz: TZ, now });
  assert.deepEqual(m2.meta(`recon:${D}`).val, {});
  // Google saying stop ends the check without a mark.
  const m3 = openDb();
  await reconcile({ main: m3, accounts: [a, { ...b, google: { rollUp: async () => { throw Object.assign(new Error('slow'), { code: 'rate_limited' }); } } }], tz: TZ, now });
  assert.equal(m3.meta(`recon:${D}`), null);
});

test('minute series from two devices: one pulse per minute, the larger step count', () => {
  assert.deepEqual(maxWindows([[{ start: 1, steps: 10 }, { start: 2, steps: 0 }], [{ start: 1, steps: 4 }, { start: 2, steps: 7 }, { start: 3, steps: 1 }]]).map((w) => w.steps), [10, 7, 1]);
  assert.deepEqual(combineHr([[{ start: 1, avg: 100, max: 110 }], [{ start: 1, avg: 90, max: 120 }, { start: 2, avg: 70, max: 70 }]]), [{ start: 1, avg: 95, max: 120 }, { start: 2, avg: 70, max: 70 }]);
});

/* ── a store from before there could be several ─────────────────── */

test('an existing person\'s store becomes their first account\'s source, once, and reads the same', async () => {
  const r = await rig();
  try {
    const dir = join(r.config.dataDir, 'users', 'aaaaaaaaaaaaaaaaaaaaaaaa');
    mkdirSync(dir, { recursive: true });
    // As the single-account version left it.
    const old = openDb(join(dir, 'health.sqlite'));
    day(old, D, { steps: 7000, rhr: 61, cardio_min: 25, sleep_score: 80 });
    old.upsertSleep(sleep('n1', at(-1), at(6), 400));
    old.upsertExercise(ex('users/me/dataTypes/exercise/dataPoints/x', at(18), at(19)));
    old.upsertWeight({ t: at(8), grams: 79_000, source: 'app' });
    old.setMeta('sync', { lastOk: 1, streams: { steps: { through: D } } });
    old.setMeta('settings', { stepTarget: 12000 });
    old.workoutAdd({ uid: 'u1', status: 'done', source: 'manual', start: at(18), end: at(19), created: 1, updated: 1, prompts: {} });
    old.close();
    const w = new UserWorld({ userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', dir, tz: TZ, google: { gapMs: 0 } });
    try {
      assert.ok(existsSync(join(dir, 'src', 'main.sqlite')));
      const s = w.accounts.get('main').db;
      assert.deepEqual(s.meta('sync').streams.steps, { through: D }, 'the sync carries on where it was');
      assert.equal(s.dailyTable(D)[D].steps, 7000);
      assert.equal(s.dailyTable(D)[D].cardio_min, undefined, 'the app\'s own numbers stay out of a source');
      assert.deepEqual([s.weights(0).length, s.db.prepare('SELECT COUNT(*) AS n FROM workout').get().n, s.meta('settings')], [0, 0, null]);
      w.merge();
      const t = w.db.dailyTable(D)[D];
      assert.deepEqual([t.steps, t.rhr, t.cardio_min, t.sleep_score, t.sleep_min], [7000, 61, 25, 80, 400]);
      assert.deepEqual([w.db.exercises(D).length, w.db.weights(0).length, w.db.sleeps(D).length], [1, 1, 1]);
      assert.equal(w.settings().stepTarget, 12000);
      assert.deepEqual(w.accountList().map((a) => a.id), ['main']);
    } finally { w.close(); }
    // Opened again: not copied again.
    const w2 = new UserWorld({ userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', dir, tz: TZ, google: { gapMs: 0 } });
    try { assert.equal(w2.accounts.get('main').db.dailyTable(D)[D].cardio_min, undefined); } finally { w2.close(); }
  } finally { await r.close(); }
});

/* ── through the running app ──────────────────────────────────────── */

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

/** The consent redirect chain the way a browser walks it, signing in at
    the fake Google as `as` ('me' = the person's own account). */
async function consent(c, start, as = null) {
  const first = await c.get(start);
  const url = new URL(first.headers.get('location'));
  if (as) url.searchParams.set('demo_as', as);
  const back = new URL((await c.get(url.pathname + url.search)).headers.get('location'));
  const done = await c.get(back.pathname + back.search);
  return { url, location: new URL(done.headers.get('location'), 'https://x') };
}
const settle = async (p) => { for (let i = 0; i < 60; i += 1) { const me = (await p.c.get('/api/me')).json; if (!me.sync.running) return me; await new Promise((res) => { setTimeout(res, 50); }); } return null; };

test('adding a second account: the chooser, a second tracker, and both in the numbers', async () => {
  const p = await r.person('twodev', { persona: 'fitbit' });
  const before = (await p.c.get('/api/me')).json;
  assert.deepEqual(before.googleAccounts.map((a) => [a.id, a.primary, a.state]), [['main', true, 'ok']]);
  const today = todayIn(Date.now(), TZ);
  const oneSteps = (await p.c.get('/api/data')).json.activity?.today?.steps;

  const add = await consent(p.c, '/auth/google/start?account=new&return=/settings/connections', 'work');
  assert.match(add.url.searchParams.get('prompt'), /select_account/, 'Google\'s account chooser, not the signed-in account');
  assert.deepEqual(add.url.searchParams.get('scope').includes('nutrition'), false, 'no optional group is asked of another account');
  assert.equal(add.location.searchParams.get('google'), 'added');
  await new Promise((res) => { setTimeout(res, 300); });
  await r.app.syncUser(p.id, { force: true });
  const me = await settle(p);
  assert.equal(me.googleAccounts.length, 2);
  const work = me.googleAccounts.find((a) => !a.primary);
  assert.match(work.email, /\+work@/);
  assert.equal(work.state, 'ok');
  assert.ok(work.device?.name, 'its own tracker');
  assert.ok(Array.isArray(me.merge && Object.keys(me.merge)));
  // Both trackers' steps are in today's total: more than the first alone.
  const w = r.app.worlds.get(p.id);
  const a = w.accounts.get('main').db.dailyTable(today)[today]?.steps;
  const b = w.accounts.get(work.id).db.dailyTable(today)[today]?.steps;
  const merged = w.db.dailyTable(today)[today]?.steps;
  assert.ok(a > 0 && b > 0, 'each account synced its own');
  assert.ok(merged >= Math.max(a, b) && merged <= a + b, `${merged} between ${Math.max(a, b)} and ${a + b}`);
  assert.ok(oneSteps === undefined || merged >= oneSteps);
  // Two devices, each one listed.
  assert.equal(w.db.meta('devices').length, 2);
  // The quarter-hour check ran for today, and its reading is what the total uses.
  const rec = w.db.meta(`recon:${today}`);
  assert.ok(rec && rec.val.steps > 0, 'today was read quarter-hour by quarter-hour');
  assert.equal(merged, Math.max(Math.max(a, b), a + b - Math.max(0, rec.sum.steps - rec.val.steps)));

  // The same account added again: it is refreshed, not added twice.
  const again = await consent(p.c, '/auth/google/start?account=new', 'work');
  assert.equal(again.location.searchParams.get('google'), 'already');
  assert.equal((await p.c.get('/api/google/accounts')).json.accounts.length, 2);

  // Reconnecting the main account but signing in as the other one: refused, nothing mixed.
  const wrong = await consent(p.c, `/auth/google/start?account=main`, 'work');
  assert.equal(wrong.location.searchParams.get('google'), 'error');
  assert.match(wrong.location.searchParams.get('message'), /already connected here as/);
  // As a third account nobody connected: refused too, and the hint names the right one.
  const third = await consent(p.c, `/auth/google/start?account=${work.id}`, 'gym');
  assert.match(third.url.searchParams.get('login_hint'), /\+work@/);
  assert.match(third.location.searchParams.get('message'), /You signed in as .*\+gym@.*but this connection is/);
  assert.equal(w.accounts.get(work.id).google.connected(), true, 'the work connection survived both');
  assert.equal(w.accounts.get('main').google.connected(), true);
});

test('label, main account, leaving one out, rules: each one checked and applied', async () => {
  const p = await r.person('rules', { persona: 'fitbit' });
  await consent(p.c, '/auth/google/start?account=new', 'work');
  await new Promise((res) => { setTimeout(res, 300); });
  await r.app.syncUser(p.id, { force: true });
  const list = (await p.c.get('/api/google/accounts')).json;
  const work = list.accounts.find((a) => !a.primary).id;
  assert.deepEqual(list.rules, MERGE_DEFAULTS);

  let x = await p.c.patch(`/api/google/accounts/${work}`, { label: '  Work watch  ' });
  assert.equal(x.json.accounts.find((a) => a.id === work).label, 'Work watch');
  assert.equal((await p.c.patch(`/api/google/accounts/${work}`, { primary: false })).status, 400);
  assert.equal((await p.c.patch('/api/google/accounts/zzz', { label: 'x' })).status, 404);

  // The main account changes: writes go there now.
  x = await p.c.patch(`/api/google/accounts/${work}`, { primary: true });
  assert.equal(x.json.primary, work);
  assert.equal(r.app.worlds.get(p.id).google, r.app.worlds.get(p.id).accounts.get(work).google);
  x = await p.c.patch('/api/google/accounts/main', { primary: true });

  // Left out: its numbers leave, its store stays.
  const w = r.app.worlds.get(p.id);
  const today = todayIn(Date.now(), TZ);
  const both = w.db.dailyTable(today)[today].steps;
  x = await p.c.patch(`/api/google/accounts/${work}`, { include: false });
  assert.equal(x.status, 200);
  assert.equal(w.db.dailyTable(today)[today].steps, w.accounts.get('main').db.dailyTable(today)[today].steps);
  assert.ok(w.db.dailyTable(today)[today].steps <= both);
  assert.equal((await p.c.patch('/api/google/accounts/main', { include: false })).status, 409, 'one has to stay in');
  assert.equal((await p.c.patch(`/api/google/accounts/${work}`, { primary: true })).status, 409, 'not a left-out one');
  await p.c.patch(`/api/google/accounts/${work}`, { include: true });
  assert.equal(w.db.dailyTable(today)[today].steps, both);

  // Rules.
  assert.equal((await p.c.patch('/api/google/merge', { activity: 'double' })).status, 400);
  assert.equal((await p.c.patch('/api/google/merge', { overnight: 'nobody' })).status, 400);
  x = await p.c.patch('/api/google/merge', { activity: 'sum', overnight: work, workouts: 'keep' });
  assert.deepEqual(x.json.rules, { activity: 'sum', overnight: work, workouts: 'keep' });
  const a = w.accounts.get('main').db.dailyTable(today)[today].steps;
  const b = w.accounts.get(work).db.dailyTable(today)[today].steps;
  assert.equal(w.db.dailyTable(today)[today].steps, a + b);
  x = await p.c.patch('/api/google/merge', { activity: 'max' });
  assert.equal(w.db.dailyTable(today)[today].steps, Math.max(a, b));
  assert.equal((await p.c.get('/api/me')).json.merge.activity, 'max');
});

test('removing an account: its data leaves, its token and store go, the other carries on', async () => {
  const p = await r.person('remover', { persona: 'fitbit' });
  await consent(p.c, '/auth/google/start?account=new', 'work');
  await new Promise((res) => { setTimeout(res, 300); });
  await r.app.syncUser(p.id, { force: true });
  const w = r.app.worlds.get(p.id);
  const work = w.accountList().find((a) => a.id !== 'main').id;
  await p.c.patch(`/api/google/accounts/${work}`, { primary: true });
  await p.c.patch('/api/google/merge', { overnight: work });
  const dir = join(r.config.dataDir, 'users', p.id);
  assert.ok(existsSync(join(dir, `google-${work}.json`)) && existsSync(join(dir, 'src', `${work}.sqlite`)));
  assert.equal((await p.c.del('/api/google/accounts/main')).status, 200, 'any account can go, the main one too');
  // The first account went: the other is the main one now, and the only one.
  let list = (await p.c.get('/api/google/accounts')).json;
  assert.deepEqual(list.accounts.map((a) => [a.id, a.primary]), [[work, true]]);
  assert.equal(list.rules.overnight, work);
  assert.ok(!existsSync(join(dir, 'google.json')) || JSON.parse(readFileSync(join(dir, 'google.json'), 'utf8')) === null);
  assert.ok(!existsSync(join(dir, 'src', 'main.sqlite')));
  const today = todayIn(Date.now(), TZ);
  assert.equal(w.db.dailyTable(today)[today].steps, w.accounts.get(work).db.dailyTable(today)[today].steps);
  assert.equal(w.db.meta('devices'), null, 'one device again');
  assert.equal((await p.c.del(`/api/google/accounts/${work}`)).status, 409, 'the last one is disconnected, not removed');
  // Disconnect keeps what it brought.
  const kept = w.db.dailyTable(today)[today].steps;
  assert.equal((await p.c.post(`/api/google/accounts/${work}/disconnect`)).status, 200);
  list = (await p.c.get('/api/google/accounts')).json;
  assert.equal(list.accounts[0].state, 'needs_auth');
  assert.equal(w.db.dailyTable(today)[today].steps, kept);
  assert.equal((await p.c.get('/api/me')).json.google.state, 'needs_auth');
});

test('a workout saved to one account is changed and removed in that account, even after the main one changes', async () => {
  const p = await r.person('writer', { persona: 'fitbit' });
  await consent(p.c, '/auth/google/start?account=new', 'work');
  await new Promise((res) => { setTimeout(res, 300); });
  const w = r.app.worlds.get(p.id);
  const work = w.accountList().find((a) => a.id !== 'main').id;
  const calls = [];
  r.wrap.fn = (userId, url, init, acct) => { if (userId === p.id && /exercise\/dataPoints/.test(url.pathname) && init?.method !== 'GET') calls.push([acct, init.method, url.pathname.split(':').pop()]); return null; };
  try {
    const now = Date.now();
    const made = await p.c.post('/api/workouts/log', { start: now - 3_600_000, end: now - 1_800_000, title: 'Legs' });
    assert.equal(made.status, 200, made.text);
    const id = w.db.workoutsSince(0).find((x) => x.title === 'Legs').id;
    await w.workouts.flush();
    assert.equal(w.workouts.get(id).google.acct, 'main');
    await p.c.patch(`/api/google/accounts/${work}`, { primary: true });
    await p.c.del(`/api/workouts/${id}`);
    assert.deepEqual(calls.map((c) => c[0]), ['main', 'main'], 'created and deleted in the first account');
  } finally { r.wrap.fn = null; }
});
