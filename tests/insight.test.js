import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { stats, rules, prompt, parseAnswer, slope, wakeBouts, profileFlags, windowOf } from '../server/core/insight.js';
import { addDays } from '../server/core/util.js';

const TODAY = '2026-10-08';
const at = (date, hh, mm, off = 3 * 3600) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) - off * 1000;

/** 40 days of steps, 10 of heart data, 5 nights, weigh-ins, gym sets. */
function seeded() {
  const db = openDb(':memory:');
  for (let i = 1; i <= 40; i += 1) {
    const d = addDays(TODAY, -i);
    // Sundays are lazy, the rest climb a little.
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    db.setDaily(d, 'steps', dow === 0 ? 2000 : 6000 + (i % 3) * 1000);
    db.setDaily(d, 'azm', 10 + (i % 4) * 5);
    db.setDaily(d, 'azm_fat', 8); db.setDaily(d, 'azm_cardio', 2);
  }
  db.setDaily(TODAY, 'steps', 1500);
  // Heart: a baseline before the 7-day window, then lower RHR / higher HRV in it.
  for (let i = 8; i <= 25; i += 1) { db.setDaily(addDays(TODAY, -i), 'rhr', 70); db.setDaily(addDays(TODAY, -i), 'hrv', 30); }
  for (let i = 0; i <= 6; i += 1) { db.setDaily(addDays(TODAY, -i), 'rhr', 66 + i * 0.5); db.setDaily(addDays(TODAY, -i), 'hrv', 36 - i); }
  // Five nights: 22:30 → 05:30 local, 6h20m asleep, one wake bout at 02:10.
  for (let i = 0; i < 5; i += 1) {
    const wakeDate = addDays(TODAY, -i);
    const bedDate = addDays(wakeDate, -1);
    const s = at(bedDate, 22, 30); const e = at(wakeDate, 5, 30);
    const boutS = at(wakeDate, 2, 10); const boutE = boutS + 12 * 60_000;
    db.upsertSleep({
      id: `n${i}`, date: wakeDate, startMs: s, endMs: e, startOff: 10800, endOff: 10800, main: true,
      asleepMin: 380, awakeMin: 40, periodMin: 420,
      stages: [
        { s, e: s + 10 * 60_000, t: 'AWAKE' },
        { s: s + 10 * 60_000, e: boutS, t: 'LIGHT' },
        { s: boutS, e: boutE, t: 'AWAKE' },
        { s: boutE, e: e - 5 * 60_000, t: 'DEEP' },
        { s: e - 5 * 60_000, e, t: 'AWAKE' },
      ],
      summary: { stages: { DEEP: 70, REM: 80, LIGHT: 230, AWAKE: 40 }, toFallAsleep: 10 },
    });
    db.setDaily(wakeDate, 'sleep_min', 380);
  }
  db.upsertWeight({ t: at(addDays(TODAY, -6), 7, 0), grams: 68000, off: 10800 });
  db.upsertWeight({ t: at(addDays(TODAY, -1), 19, 0), grams: 67000, off: 10800 });
  const sets = [
    { date: TODAY, exercise: 'Squat', muscle: 'legs', kg: 40, reps: 10, sets: 3 },
    { date: TODAY, exercise: 'Row', muscle: 'back', kg: 30, reps: 10, sets: 3 },
  ];
  return { db, sets };
}

test('stats: steps are averaged over complete days only, with the weekday pattern', () => {
  const { db, sets } = seeded();
  const s = stats(db, { today: TODAY, window: 7, settings: { stepTarget: 8000 }, sets });
  assert.equal(s.from, '2026-10-02');
  assert.equal(s.completeFrom, '2026-10-01');
  assert.equal(s.completeTo, '2026-10-07');
  assert.equal(s.activity.completeDays, 7, 'today (1,500 so far) is not a complete day');
  assert.equal(s.activity.todaySoFar, 1500);
  assert.equal(s.activity.daysUnder5k, 1, 'the one Sunday');
  assert.equal(s.activity.stepsMin, 2000);
  assert.equal(s.activity.worstDay.day, 'Sun');
  assert.equal(s.activity.weekday.length, 7);
  assert.equal(s.activity.gym.sessions, 1);
  assert.equal(s.activity.gym.sets, 6);
  assert.equal(s.activity.gym.volumeKg, 40 * 10 * 3 + 30 * 10 * 3);
});

test('stats: heart against the baseline from BEFORE the window, with a trend', () => {
  const { db } = seeded();
  const s = stats(db, { today: TODAY, window: 7 });
  assert.equal(s.heart.rhr.baseline, 70);
  assert.equal(s.heart.hrv.baseline, 30);
  assert.equal(s.heart.rhr.latest, 66);
  assert.ok(s.heart.rhr.vsBaseline < -2);
  assert.ok(s.heart.hrv.vsBaselinePct > 0);
  // Day index runs oldest → newest: RHR falls 0.5/day, i.e. -3.5/week.
  assert.equal(s.heart.rhr.perWeek, -3.5);
});

test('stats: sleep duration, efficiency, stages, wake cluster and consistency', () => {
  const { db } = seeded();
  const s = stats(db, { today: TODAY, window: 7 });
  assert.equal(s.sleep.nights, 5);
  assert.equal(s.sleep.asleepAvgMin, 380);
  assert.equal(s.sleep.under7h, 5);
  assert.equal(s.sleep.efficiencyPct, 90.5);
  assert.equal(s.sleep.stagesPct.deep, 17);
  assert.equal(s.sleep.bedtimeAvg, '22:30');
  assert.equal(s.sleep.wakeAvg, '05:30');
  assert.equal(s.sleep.bedtimeSdMin, 0);
  assert.equal(s.sleep.wakeBoutsPerNight, 1);
  assert.equal(s.sleep.wakeCluster, '02:00–03:00');
});

test('stats: last night in detail; the first and last stretch are not wake bouts', () => {
  const { db } = seeded();
  const s = stats(db, { today: TODAY, window: 'night' });
  assert.equal(s.window, 'night');
  assert.equal(s.sleep.lastNight.date, TODAY);
  assert.equal(s.sleep.lastNight.bedtime, '22:30');
  assert.deepEqual(s.sleep.lastNight.wakeBouts, [{ at: '02:10', min: 12 }]);
  const n = db.sleeps(TODAY)[0];
  assert.equal(wakeBouts(n).length, 1);
});

test('stats: weight caveats — too few weigh-ins, different times of day', () => {
  const { db } = seeded();
  const s = stats(db, { today: TODAY, window: 7 });
  assert.equal(s.weight.weighIns, 2);
  assert.equal(s.weight.latestKg, 67);
  assert.ok(s.weight.caveats.some((c) => /too few/.test(c)));
  assert.ok(s.weight.caveats.some((c) => /times of day/.test(c)));
});

test('stats: coverage says how little wearable data there is', () => {
  const db = openDb(':memory:');
  for (let i = 1; i <= 30; i += 1) db.setDaily(addDays(TODAY, -i), 'steps', 5000);
  db.setDaily(TODAY, 'rhr', 64);
  const s = stats(db, { today: TODAY, window: 30 });
  assert.equal(s.coverage.firstWearable, TODAY);
  assert.equal(s.coverage.rhrDays, 1);
  const r = rules(s, '');
  assert.ok(r.caveats[0].includes(TODAY));
  assert.match(r.sections.find((x) => x.id === 'sleep').text, /No tracked sleep/);
});

test('rules: every section, 3–5 next steps, shaped by the profile notes', () => {
  const { db, sets } = seeded();
  const notes = 'Desk job, back pain from sitting all day. Acid reflux. Plan gym 3 days a week. I sleep early and wake early now.';
  const s = stats(db, { today: TODAY, window: 7, sets });
  const r = rules(s, notes);
  assert.deepEqual(r.sections.map((x) => x.id), ['sleep', 'heart', 'activity', 'weight', 'readiness']);
  assert.ok(r.nextSteps.length >= 3 && r.nextSteps.length <= 5, r.nextSteps.join(' | '));
  assert.ok(r.nextSteps.some((x) => /45–60 minutes/.test(x)), 'desk job → break up sitting');
  assert.ok(r.nextSteps.some((x) => /Reflux/.test(x)));
  assert.ok(r.nextSteps.some((x) => /Gym: 1 session/.test(x)));
  assert.ok(r.nextSteps.some((x) => /early by design|routine/.test(x)), 'early bedtime is normal for them');
  assert.match(r.headline, /^6h 20m sleep · 6,286 steps\/day · normal day$/);
  for (const x of [r.headline, ...r.nextSteps, ...r.sections.map((y) => y.text)]) assert.ok(!/\p{Extended_Pictographic}/u.test(x));
});

test('profileFlags reads the notes loosely', () => {
  const f = profileFlags('Plans gym >=3 days/week; desk job; acid reflux; fast food often');
  assert.equal(f.desk, true); assert.equal(f.reflux, true); assert.equal(f.fastFood, true); assert.equal(f.gym, true);
  assert.equal(profileFlags('').desk, false);
});

test('prompt carries the numbers and notes, asks for JSON, no tools, no emoji', () => {
  const { db } = seeded();
  const s = stats(db, { today: TODAY, window: 7 });
  const p = prompt(s, 'my notes here');
  assert.ok(p.includes('my notes here'));
  assert.ok(p.includes('"asleepAvgMin":380'));
  assert.match(p, /Do not use any tools/);
  assert.match(p, /Do not use emoji/);
});

test('parseAnswer: takes JSON out of chatter and fences, rejects the unusable, strips emoji', () => {
  const good = { headline: 'Good week 💪', sections: [{ id: 'sleep', title: 'Sleep', text: 'Fine.' }], nextSteps: ['Walk', 'Sleep'], caveats: [] };
  const r = parseAnswer(`Sure!\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
  assert.equal(r.headline, 'Good week');
  assert.equal(r.sections[0].id, 'sleep');
  assert.equal(parseAnswer('no json here'), null);
  assert.equal(parseAnswer('{"headline":"x"}'), null);
  assert.equal(parseAnswer(JSON.stringify({ ...good, nextSteps: ['only one'] })), null);
  assert.equal(parseAnswer(''), null);
});

test('slope and windowOf', () => {
  assert.equal(slope([[0, 1], [1, 2], [2, 3]]), 1);
  assert.equal(slope([[0, 1], [1, 2]]), null);
  assert.equal(windowOf('night'), 'night');
  assert.equal(windowOf('30'), 30);
  assert.equal(windowOf('nonsense'), 7);
});
