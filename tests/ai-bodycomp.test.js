/* The AI's briefing carries the scale's body composition (server/ai.js compBrief): asked "should I
   increase bone mineral", it once answered that no bone data was there, while Health showed it. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { briefing } from '../server/ai.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const DAY = 86_400_000;

test('bone, muscle, fat and water from the scale reach the AI, with ranges and change', async () => {
  const p = await personWith(r, 'scaleperson');
  const now = Date.now();
  await r.app.worlds.hold(p.id, async (w) => {
    w.db.setMeta('body', { sex: 'male', birthYear: 1998 });
    for (const [daysAgo, kg, fat, muscle, bone] of [[95, 82.0, 21.0, 60.9, 3.0], [32, 81.0, 20.0, 61.0, 3.1], [1, 80.0, 18.5, 61.8, 3.2]]) {
      const t = now - daysAgo * DAY;
      w.db.sampleAdd({ kind: 'bodycomp', t, date: new Date(t).toISOString().slice(0, 10), value: kg, source: 'xiaomi',
        data: { weightKg: kg, fatPct: fat, muscleKg: muscle, waterPct: 56.0, boneKg: bone, bmr: 1750, visceral: 8, heightCm: 180 } });
    }
    const seen = [];
    const text = briefing(w, { topic: 'ask', now, seen });
    assert.match(text, /## Body composition from their smart scale/);
    assert.match(text, /- Bone mineral: 3\.2 kg \(Standard; standard [\d.]+-[\d.]+\), \+0\.1 over 30 days, \+0\.2 over 90 days/);
    assert.match(text, /- Body fat: 18\.5 %/);
    assert.match(text, /- Muscle mass: 61\.8 kg/);
    assert.match(text, /not bone density or a T-score/);
    assert.ok(seen.some((s) => /Body composition from the scale/.test(s)), 'listed under What it read');
    // Body data not shared with the AI: none of it.
    // Weight alone allowed (the old "body" kind): no composition. It has a kind of its own.
    const off = briefing(w, { topic: 'ask', now, allow: { activity: true, sleep: true, heart: true, body: true, bodycomp: false, workouts: true, logged: true, notes: true } });
    assert.doesNotMatch(off, /Bone mineral/);
    assert.match(off, /chose not to share their .*body composition/);
  });
});

test('sensitive data reaches the AI only when its kind is allowed and its group is on', async () => {
  const p = await personWith(r, 'sensitiveperson', { groups: ['nutrition', 'mindfulness'] });
  const now = Date.now();
  await r.app.worlds.hold(p.id, async (w) => {
    const day = new Date(now - 3_600_000).toISOString().slice(0, 10);
    w.db.sampleAdd({ kind: 'food', t: now - 3_600_000, date: day, value: 650, source: 'app', data: { name: 'Chicken rice', protein: 45, carbs: 70, fat: 15 } });
    w.db.sampleAdd({ kind: 'water', t: now - 3_000_000, date: day, value: 500, source: 'app' });
    w.db.sampleAdd({ kind: 'glucose', t: now - 2_000_000, date: day, value: 92, source: 'app', data: {} });
    const base = { activity: true, sleep: true, heart: true, body: true, bodycomp: true, workouts: true, logged: true, notes: true };
    const none = briefing(w, { topic: 'ask', now, allow: base });
    assert.doesNotMatch(none, /Chicken rice|mg\/dL/);
    assert.match(none, /chose not to share their .*food and water/);
    // Allowed, but the group's own "Include in summaries" is off: still not.
    const half = briefing(w, { topic: 'ask', now, allow: { ...base, nutrition: true } });
    assert.doesNotMatch(half, /Food they logged/);
    w.setAiShare?.({ nutrition: true }) ?? w.db.setMeta('aiShare', { nutrition: true });
    const yes = briefing(w, { topic: 'ask', now, allow: { ...base, nutrition: true, vitals: true } });
    assert.match(yes, /## Food they logged.*\n- \w{3} [\d-]+: 650 kcal in 1 entry, protein 45 g, carbs 70 g, fat 15 g/);
    assert.doesNotMatch(yes, /Chicken rice/, 'totals, not what was eaten');
    assert.match(yes, /## Water they logged.*\n- \w{3} [\d-]+: 500 ml/);
    assert.match(yes, /## Blood glucose.*\n.*92 mg\/dL/);
  });
});
