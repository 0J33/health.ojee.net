import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { strengthPerf, digest, medalsOf, tally, DAY } from '../web/js/medalcore.js';
import { rig } from './helpers.mjs';

const T0 = Date.parse('2026-06-01T08:00:00Z');
const perf = (sets) => strengthPerf(sets.map(([kg, reps, type = 'normal']) => ({ kg, reps, type })));

test('Cam\'s curls: 20 × 8, 8, 8, then 20 × 10, 8, 8 a week later is a gold for reps at 20', () => {
  const week1 = { t: T0, p: perf([[9.07, 8], [9.07, 8], [9.07, 8]]) };
  const m = medalsOf(perf([[9.07, 10], [9.07, 8], [9.07, 8]]), digest([week1], T0 + 7 * DAY));
  const reps = m.find((x) => x.kind === 'reps_at');
  assert.deepEqual([reps.tier, reps.value, reps.previous, reps.kg], ['gold', 10, 8, 9.07]);
  // It also raises the estimated max, but the lift is said once (reps at the weight); the volume beside it.
  assert.deepEqual(m.map((x) => x.kind).sort(), ['reps_at', 'volume']);
  assert.ok(m.every((x) => x.tier === 'gold'));
  assert.equal(m.find((x) => x.kind === 'heaviest'), undefined, 'the same weight is not a heavier one');
});

test('tiers: gold beats ever, silver beats the year, bronze beats 90 days; a first time and a tie earn nothing', () => {
  const old = { t: T0, p: perf([[100, 5]]) };              // two years ago: the best ever
  const year = { t: T0 + 500 * DAY, p: perf([[90, 5]]) };   // 8 months before
  const recent = { t: T0 + 700 * DAY, p: perf([[80, 5]]) }; // 30 days before
  const at = T0 + 730 * DAY;
  const kg = (k) => medalsOf(perf([[k, 5]]), digest([old, year, recent], at)).find((x) => x.kind === 'heaviest');
  assert.equal(kg(105).tier, 'gold');
  assert.deepEqual([kg(95).tier, kg(95).previous], ['silver', 90]);
  assert.deepEqual([kg(85).tier, kg(85).previous], ['bronze', 80]);
  assert.equal(kg(80), undefined, 'a tie is not a medal');
  assert.equal(kg(75), undefined);
  assert.deepEqual(medalsOf(perf([[200, 1]]), digest([], at)), [], 'nothing to beat: no medal');
  // Warm-ups never count, either side.
  assert.deepEqual(medalsOf(perf([[300, 5, 'warmup']]), digest([old], at)), []);
});

test('reps at a weight look at that weight or heavier, and a new heaviest is not said twice', () => {
  const prior = [{ t: T0, p: perf([[60, 8], [70, 4]]) }];
  const dg = digest(prior, T0 + DAY);
  // 65 × 5: more than the 4 done at 70 (heavier), the best at ≥ 65.
  assert.deepEqual(medalsOf(perf([[65, 5]]), dg).find((x) => x.kind === 'reps_at'), { tier: 'gold', kind: 'reps_at', value: 5, previous: 4, kg: 65 });
  // 65 × 4: no more than 70 × 4 did.
  assert.equal(medalsOf(perf([[65, 4]]), dg).find((x) => x.kind === 'reps_at'), undefined);
  // 75 × 3: heavier than ever (a higher estimated max too): one medal for the lift, the heaviest.
  const m = medalsOf(perf([[75, 3]]), dg);
  assert.deepEqual(m.map((x) => x.kind), ['heaviest']);
  // A silver heaviest and gold reps at it: two feats, both kept; the estimated max says the same, so not.
  const mixed = medalsOf(perf([[68, 8], [62, 12]]), digest([{ t: T0 - 400 * DAY, p: perf([[70, 1]]) }, { t: T0, p: perf([[60, 8]]) }], T0 + DAY));
  assert.deepEqual(mixed.filter((x) => x.kind !== 'volume').map((x) => [x.kind, x.tier, x.kg ?? x.value]), [['reps_at', 'gold', 62], ['heaviest', 'silver', 68]]);
  // Body weight and timed sets: reps in a set, and the longest set.
  const bw = digest([{ t: T0, p: strengthPerf([{ kg: 0, reps: 12 }, { durationS: 60 }]) }], T0 + DAY);
  assert.deepEqual(medalsOf(strengthPerf([{ kg: 0, reps: 15 }]), bw).map((x) => [x.kind, x.value]), [['set_reps', 15]]);
  assert.deepEqual(medalsOf(strengthPerf([{ durationS: 75 }]), bw).map((x) => [x.kind, x.value]), [['hold', 75]]);
  assert.deepEqual(tally([{ tier: 'gold' }, { tier: 'gold' }, { tier: 'bronze' }]), { gold: 2, silver: 0, bronze: 1 });
});

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

test('a workout\'s medals and the achievements, through the API', async () => {
  const p = await r.person('cam');
  const day = 86_400_000;
  const start = Date.now() - 10 * day;
  const log = async (t, sets) => (await p.c.post('/api/workouts/log', { start: t, end: t + 45 * 60_000, title: 'Arms', exercises: [{ name: 'Bicep Curl (Dumbbell)', sets: sets.map(([kg, reps]) => ({ kg, reps })) }] })).json;
  await log(start, [[9, 8], [9, 8], [9, 8]]);
  const second = await log(start + 7 * day, [[9, 10], [9, 8], [9, 8]]);
  const id = second.history.find((w) => w.start === start + 7 * day)?.id || second.history[0].id;
  const d = (await p.c.get(`/api/workouts/${id}`)).json;
  assert.ok(d.medals.some((m) => m.kind === 'reps_at' && m.tier === 'gold' && m.value === 10 && m.exercise === 'Bicep Curl (Dumbbell)'), JSON.stringify(d.medals));
  assert.ok(d.medals.some((m) => m.kind === 'session_volume'), 'the workout\'s own total');
  const a = (await p.c.get('/api/achievements')).json;
  assert.deepEqual(a.medals, { gold: d.medals.filter((m) => m.tier === 'gold').length, silver: 0, bronze: 0 });
  const w = a.achievements.find((x) => x.id === 'workouts');
  assert.deepEqual([w.value, w.level, w.next], [2, 0, 10]);
  assert.ok(a.achievements.every((x) => x.fresh === false), 'the first look is not news');
  assert.equal((await p.c.post('/api/achievements/seen', {})).status, 200);
});

test('medals reach the board, the post and the profile only while workouts are shared', async () => {
  const p = await r.person('lifter');
  const viewer = await r.person('watcher');
  const day = 86_400_000;
  const t0 = Date.now() - 6 * day;
  for (const [i, kg] of [[0, 60], [3, 65]]) {
    await p.c.post('/api/workouts/log', { start: t0 + i * day, end: t0 + i * day + 40 * 60_000, title: 'Push', exercises: [{ name: 'Bench Press (Barbell)', sets: [{ kg, reps: 5 }, { kg, reps: 5 }] }] });
  }
  await r.app.publish(p.id, { announce: false });
  const n = r.app.app.get('SELECT SUM(medals) AS n FROM daily_public WHERE user_id = ?', p.id).n;
  assert.ok(n >= 3, `medals on the board's rows: ${n}`);
  const lbr = await viewer.c.get('/api/leaderboard?metric=medals&period=all&scope=everyone');
  assert.equal(lbr.status, 200, lbr.text);
  const lb = lbr.json;
  assert.equal(lb.entries.find((e) => e.username === 'lifter')?.value, n);
  const post = r.app.app.all('SELECT data FROM post WHERE user_id = ?', p.id).map((x) => JSON.parse(x.data)).find((x) => x.medals);
  assert.ok(post.medals.gold >= 2 && post.medals.top.some((m) => m.kind === 'heaviest' && m.value === 65 && m.previous === 60));
  const prof = (await viewer.c.get('/api/users/lifter')).json;
  assert.equal(prof.medals, n);
  assert.ok(Array.isArray(prof.achievements));
  // Workouts made private: no medals anywhere others look.
  await p.c.patch('/api/settings', { privacy: { workouts: false } });
  const hidden = (await viewer.c.get('/api/users/lifter')).json;
  assert.deepEqual([hidden.medals, hidden.achievements], [null, []]);
  assert.ok(!(await viewer.c.get('/api/leaderboard?metric=medals&period=all&scope=everyone')).json.entries.some((e) => e.username === 'lifter'));
});
