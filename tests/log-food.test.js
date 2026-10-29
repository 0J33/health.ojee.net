/* The Log sheet's one reply, looking food up (your foods, common foods,
   Open Food Facts by name and by barcode), and the two new kinds: a
   night logged by hand, and tape measurements. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { fromOff, portionOf, commonFoods } from '../server/food.js';
import { validate, settleLoggedSleep } from '../server/core/entries.js';
import { openDb } from '../server/core/db.js';

const HOUR = 3_600_000;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

test('GET /api/log: every kind with where it goes, today\'s totals, what was logged lately', async () => {
  const p = await personWith(r, 'logger', { groups: ['nutrition'] });
  const t = Date.now();
  await ok(await p.c.post('/api/entries', { kind: 'water', ml: 500, at: t - 3 * 60_000 }));
  await ok(await p.c.post('/api/entries', { kind: 'water', ml: 250, at: t - 2 * 60_000 }));
  await ok(await p.c.post('/api/entries', { kind: 'food', name: 'Koshari', meal: 'LUNCH', kcal: 640, protein: 20, at: t - 60_000 }));
  const l = await ok(await p.c.get('/api/log'));
  assert.deepEqual(Object.keys(l), ['today', 'kinds', 'recent', 'hevy', 'routines', 'tzOffsetMin']);
  assert.deepEqual(l.kinds.map((k) => k.id), ['workout', 'water', 'food', 'weight', 'bodyfat', 'measure', 'height', 'sleep', 'mood', 'glucose', 'bodytemp', 'symptom', 'period', 'ovulation']);
  const k = Object.fromEntries(l.kinds.map((x) => [x.id, x]));
  assert.deepEqual([k.water.available, k.water.mode], [true, 'google']);
  assert.deepEqual([k.mood.available, k.mood.needs], [false, 'mindfulness'], 'a group that is off says which');
  assert.deepEqual([k.sleep.available, k.sleep.needs], [false, 'sleeplog']);
  assert.deepEqual([k.measure.available, k.measure.mode], [true, 'local']);
  assert.equal(k.water.last.text, '250 ml');
  assert.deepEqual(l.today.water, { ml: 750, goal: 2000 });
  assert.deepEqual([l.today.food.kcal, l.today.food.protein, l.today.food.items], [640, 20, 1]);
  assert.deepEqual(l.recent.slice(0, 3).map((x) => x.kind), ['food', 'water', 'water']);
  assert.ok(l.recent.every((x) => x.deletable));
  assert.deepEqual([l.hevy, l.routines], [false, []]);
});

test('food search: your own foods first, then common ones, then Open Food Facts; still useful when it is down', async () => {
  const p = await personWith(r, 'eater', { groups: ['nutrition'] });
  await ok(await p.c.post('/api/entries', { kind: 'food', name: 'Greek yoghurt bowl', meal: 'BREAKFAST', kcal: 310, protein: 24 }));
  await ok(await p.c.post('/api/entries', { kind: 'food', name: 'Greek yoghurt bowl', meal: 'BREAKFAST', kcal: 310, protein: 24 }));
  const s = await ok(await p.c.get('/api/food/search?q=greek'));
  assert.deepEqual([s.mine[0].name, s.mine[0].times, s.mine[0].portion.kcal], ['Greek yoghurt bowl', 2, 310]);
  assert.ok(s.common.some((f) => f.name === 'Greek yogurt, plain' && f.per100.kcal === 97));
  assert.equal(s.found[0].name, 'Nonfat Greek Yogurt');
  assert.deepEqual(s.found[0].per100, { kcal: 52.9, protein: 9.4, carbs: 3.5, fat: 0 });
  assert.deepEqual(s.found[0].serving, { g: 150, label: '150 g' });
  assert.match(s.source, /Open Food Facts/);
  // Down: a sentence, and the rest still answers.
  r.food.state.down = true;
  const d = await ok(await p.c.get('/api/food/search?q=nutella&online=1'));
  assert.deepEqual(d.found, []);
  assert.match(d.note, /could not be reached/);
  r.food.state.down = false;
  // An empty query: recent own foods only, no network.
  const calls = r.food.state.calls.length;
  const e = await ok(await p.c.get('/api/food/search'));
  assert.equal(e.mine.length, 1);
  assert.equal(r.food.state.calls.length, calls);
});

test('barcodes: found, not found, not a barcode', async () => {
  const p = await r.person('scanner');
  const f = await ok(await p.c.get('/api/food/barcode/3017620422003'));
  assert.deepEqual([f.food.name, f.food.brand, f.food.per100.kcal, f.food.serving.g], ['Nutella', 'Ferrero', 539, 15]);
  const nf = await p.c.get('/api/food/barcode/1234567890123');
  assert.deepEqual([nf.status, nf.json.code], [404, 'not_found']);
  assert.equal((await p.c.get('/api/food/barcode/12ab')).status, 404, 'not a route');
});

test('the numbers of a portion, and of a product\'s fields', () => {
  const f = fromOff({ code: '1', product_name: 'Bar', brands: 'X, Y', serving_quantity: 40, serving_size: '1 bar', nutriments: { 'energy-kj_100g': 2092, proteins_100g: 20, carbohydrates_100g: 50, fat_100g: 10 } });
  assert.deepEqual([f.brand, f.per100.kcal], ['X', 500], 'kJ when there are no kcal');
  assert.deepEqual(portionOf(f, { servings: 2 }), { grams: 80, kcal: 400, protein: 16, carbs: 40, fat: 8 });
  assert.deepEqual(portionOf(f, { grams: 25 }), { grams: 25, kcal: 125, protein: 5, carbs: 12.5, fat: 2.5 });
  assert.equal(fromOff({ product_name: 'No energy', nutriments: {} }), null);
  assert.deepEqual(commonFoods('rice').map((x) => x.name), ['White rice, cooked', 'Brown rice, cooked']);
});

test('a night logged by hand: needs its group; kept here without Google; on the sleep pages; one copy once Google has it', async () => {
  const p = await r.person('sleeper');
  const end = Date.now() - HOUR;
  const start = end - 7.5 * HOUR;
  let x = await p.c.post('/api/entries', { kind: 'sleep', start, end });
  assert.equal(x.json.code, 'group_off');
  await ok(await p.c.post('/api/google/groups', { group: 'sleeplog', on: true }));
  x = await ok(await p.c.post('/api/entries', { kind: 'sleep', start, end, awakeMin: 30 }));
  assert.deepEqual([x.google, x.entry.value, x.entry.text], ['local', 420, '7h 00m asleep, 30 min awake']);
  const s = await ok(await p.c.get('/api/metric/sleep?range=week'));
  assert.equal(s.add.kind, 'sleep');
  const wake = x.entry.date;   // the night's own date (just after midnight it is yesterday's)
  await r.app.worlds.hold(p.id, async (w) => {
    const night = w.db.sleeps('0000-00-00');
    assert.equal(night.length, 1);
    assert.deepEqual([night[0].asleepMin, night[0].periodMin, night[0].main], [420, 450, true]);
    assert.equal(w.db.dailyTable(wake)[wake].sleep_min, 420);
  });
  // Bad times are refused in words.
  for (const [body, re] of [[{ start: end, end: start }, /after falling asleep/], [{ start, end: end + 5 * HOUR }, /future/], [{ start: end - 20 * HOUR, end }, /16 hours/]]) {
    const bad = await p.c.post('/api/entries', { kind: 'sleep', ...body });
    assert.equal(bad.status, 400); assert.match(bad.json.error, re);
  }
  // Removing it takes the night away.
  await ok(await p.c.del(`/api/entries/${x.entry.id}`));
  await r.app.worlds.hold(p.id, async (w) => {
    assert.equal(w.db.sleeps('0000-00-00').length, 0);
    assert.equal(w.db.dailyTable(wake)[wake]?.sleep_min, undefined);
  });
});

test('a logged night and the device\'s night for the same time: the device\'s stands, once', () => {
  const db = openDb(':memory:');
  const t = Date.parse('2026-10-20T22:00:00Z');
  db.upsertSleep({ id: 'app-l-1', date: '2026-10-21', startMs: t, endMs: t + 8 * HOUR, startOff: 0, endOff: 0, main: true, asleepMin: 470, awakeMin: 10, periodMin: 480, stages: [], summary: {} });
  db.upsertSleep({ id: 'g-sleep-9', date: '2026-10-21', startMs: t + 5 * 60_000, endMs: t + 8 * HOUR - 2 * 60_000, startOff: 0, endOff: 0, main: true, asleepMin: 455, awakeMin: 18, periodMin: 473, stages: [], summary: {} });
  assert.equal(settleLoggedSleep(db, { now: t + 9 * HOUR }), 1);
  assert.deepEqual(db.sleeps('0000-00-00').map((x) => x.id), ['g-sleep-9']);
});

test('tape measurements: at least one, each in range, kept here and shown on their own metric', async () => {
  const p = await r.person('tape');
  const bad = await p.c.post('/api/entries', { kind: 'measure' });
  assert.match(bad.json.error, /at least one/);
  const big = await p.c.post('/api/entries', { kind: 'measure', waist: 400 });
  assert.match(big.json.error, /Waist must be between 5 and 250 cm/);
  const x = await ok(await p.c.post('/api/entries', { kind: 'measure', waist: 84.5, chest_cm: 101, left_bicep_cm: 36 }));
  assert.equal(x.entry.text, 'Chest 101, left biceps 36, waist 84.5 cm');
  const m = await ok(await p.c.get('/api/metric/measurements?range=month'));
  assert.equal(m.entries[0].value, 84.5);
  assert.equal(m.add.mode, 'local');
  assert.ok(validate('measure', { lean_mass_kg: 60 }, { now: Date.now(), tz: 'UTC' }), 'lean mass alone is enough');
});
