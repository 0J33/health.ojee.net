import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { addDays, weekOf, localToMs } from '../server/core/util.js';
import {
  weekdayUsual, typicalRange, quantile, metricBrief, bestStreak, streaksFor, workoutWeeks, weekFor, regularity, bedMinOf, wakeMinOf,
  sleepBrief, sleepDebt, changesFor, bandRun, rankInsights, insightsFor, nextFor, brief, dayHours, parseHrStats, histogram, niceStep,
  analyse, avg7, pearson, slope, relation, relationsFor, monthBuckets, weightStats, stagesAverage, trendsAnalysis, dowOf,
} from '../server/analysis.js';

/* ── pure functions, hand-made tables ─────────────────────────────── */

const TODAY = '2026-10-11';            // a Sunday
const TZ = 'Africa/Cairo';
const day = (n) => addDays(TODAY, -n);
/** A table from (daysAgo) => row | null over the last `n` days. */
const tableOf = (n, f) => { const t = {}; for (let i = 0; i < n; i += 1) { const r = f(i, day(i)); if (r) t[day(i)] = r; } return t; };
/** A main night that ends on `date`: bedtime `bed` minutes after 18:00 the evening before, `len` minutes long. */
const night = (date, bed = 330, len = 450, stages = null) => {
  const startMs = Date.parse(`${addDays(date, -1)}T18:00:00Z`) + bed * 60_000;
  return { id: `n-${date}`, date, main: true, startMs, endMs: startMs + len * 60_000, startOff: 0, endOff: 0, asleepMin: len - 20, awakeMin: 20, periodMin: len, stages: [], summary: { stages: stages || {} } };
};
const session = (date, min = 45) => { const start = localToMs(date, 18 * 60, TZ); return { start, end: start + min * 60_000 }; };

test('the usual for a weekday: the same weekday over 8 weeks, never today, null under three', () => {
  // Sundays walk 10,000, every other day 4,000; today (a Sunday) is only at 1,200.
  const t = tableOf(70, (i, d) => ({ steps: i === 0 ? 1200 : dowOf(d) === 6 ? 10_000 : 4000 }));
  assert.deepEqual(weekdayUsual(t, 'steps', TODAY), { usual: 10_000, n: 8 });
  assert.deepEqual(weekdayUsual(t, 'steps', day(1)), { usual: 4000, n: 8 });
  const two = tableOf(15, (i) => ({ steps: 5000 + i }));
  assert.deepEqual(weekdayUsual(two, 'steps', TODAY), { usual: null, n: 2 });
  assert.deepEqual(weekdayUsual({}, 'steps', TODAY), { usual: null, n: 0 });
  // Active minutes are zone minutes, or plain active minutes where there are no zones.
  const am = tableOf(30, (i) => (i % 7 === 0 ? { active_min: 30 } : { azm: 10, active_min: 99 }));
  assert.equal(weekdayUsual(am, 'activeMinutes', TODAY).usual, 30);
});

test('percentiles and the typical range of the 28 days before', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([10, 20, 30, 40], 0.25), 17.5);
  assert.equal(quantile([], 0.5), null);
  // Yesterday back: 1000, 2000 … 28000; today is far outside and not counted.
  const t = tableOf(60, (i) => ({ steps: i === 0 ? 99_999 : i * 1000 }));
  const r = typicalRange(t, 'steps', TODAY);
  assert.deepEqual([r.lo, r.hi, r.n], [7750, 21_250, 28]);
  assert.deepEqual(typicalRange(tableOf(4, () => ({ steps: 5 })), 'steps', TODAY), { lo: null, hi: null, n: 3 });
});

test('a metric in the brief: weekday usual for activity, baseline ± 1 SD for vitals', () => {
  const t = tableOf(70, (i, d) => ({ steps: i === 0 ? 6000 : dowOf(d) === 6 ? 8000 : 5000, rhr: i === 0 ? 63 : i % 2 ? 56 : 58, kcal: 0 }));
  const s = metricBrief(t, 'steps', { today: TODAY, settings: { stepTarget: 9000 } });
  assert.deepEqual(s, { value: 6000, yesterday: 5000, usual: 8000, usualKind: 'weekday', usualN: 8, lo: 5000, hi: 5000, delta: -2000, deltaPct: -25, goal: 9000 });
  const r = metricBrief(t, 'rhr', { today: TODAY, vday: TODAY });
  assert.deepEqual([r.value, r.yesterday, r.usual, r.usualKind, r.usualN, r.goal], [63, 56, 57, 'baseline', 30, null]);
  assert.ok(r.lo < 56.1 && r.lo > 55.9 && r.hi > 57.9 && r.hi < 58.1, `${r.lo}..${r.hi}`);
  assert.deepEqual([r.delta, r.deltaPct], [6, 10.5]);
  // A usual of zero is never divided by; nothing at all is nulls, not a throw.
  assert.equal(metricBrief(t, 'kcal', { today: TODAY }).deltaPct, null);
  const none = metricBrief({}, 'hrv', { today: TODAY });
  assert.deepEqual([none.value, none.usual, none.lo, none.delta, none.deltaPct, none.usualN], [null, null, null, null, null, 0]);
  // The verdict day, not today, is what a vital is read on.
  assert.equal(metricBrief(t, 'rhr', { today: TODAY, vday: day(1) }).value, 56);
});

test('streaks: current, best over the history, at risk and what it needs', () => {
  // Goal 8000. Yesterday back 3 days at goal; an older run of 6; today at 5,896 so far.
  const run = new Set([1, 2, 3, 10, 11, 12, 13, 14, 15]);
  const t = tableOf(40, (i) => ({ steps: i === 0 ? 5896 : run.has(i) ? 9000 : 3000 }));
  const [s] = streaksFor({ table: t, today: TODAY, tz: TZ, settings: { stepTarget: 8000 }, caps: { steps: true } });
  assert.deepEqual(s, { id: 'steps', label: 'Step goal', current: 3, best: 6, unit: 'days', atRisk: true, need: '2,104 steps to go today' });
  // Once today reaches the goal it counts and nothing is at risk.
  t[TODAY].steps = 8000;
  const [done] = streaksFor({ table: t, today: TODAY, tz: TZ, settings: { stepTarget: 8000 }, caps: {} });
  assert.deepEqual([done.current, done.best, done.atRisk, done.need], [4, 6, false, null]);
  assert.equal(bestStreak({ [day(500)]: { v: 9 } }, 5, TODAY), 0, 'the scan stops at 400 days');
  assert.equal(bestStreak({}, 0, TODAY), 0);

  // Sleep: a night under the goal ends the streak there and then; a night not in yet leaves it open.
  const nights = tableOf(10, (i) => (i === 0 ? null : { sleep_min: 460 }));
  const open = streaksFor({ table: nights, today: TODAY, tz: TZ, settings: { sleepTarget: 450 }, caps: {} }).find((x) => x.id === 'sleep');
  assert.deepEqual([open.current, open.atRisk, open.need], [9, true, 'Last night\'s sleep has not arrived yet']);
  nights[TODAY] = { sleep_min: 300 };
  const short = streaksFor({ table: nights, today: TODAY, tz: TZ, settings: { sleepTarget: 450 }, caps: {} }).find((x) => x.id === 'sleep');
  assert.deepEqual([short.current, short.best, short.atRisk], [0, 9, false]);

  // Workout weeks: Monday weeks; this week has none yet, the three before it do, and five older ones.
  const wk = (n) => addDays(weekOf(TODAY), -7 * n);
  const sessions = [1, 2, 3, 6, 7, 8, 9, 10].map((n) => session(addDays(wk(n), 2)));
  assert.deepEqual(workoutWeeks(sessions, TODAY, TZ), { current: 3, best: 5, thisWeek: false, any: true });
  const w = streaksFor({ table: {}, sessions, today: TODAY, tz: TZ, caps: {} });
  assert.deepEqual(w, [{ id: 'workout_weeks', label: 'Weeks with a workout', current: 3, best: 5, unit: 'weeks', atRisk: true, need: 'One workout by Sunday' }]);
  assert.equal(workoutWeeks([...sessions, session(TODAY)], TODAY, TZ).current, 4);
  // Nothing to streak on: nothing listed.
  assert.deepEqual(streaksFor({ table: {}, today: TODAY, tz: TZ, caps: {} }), []);
});

test('this week against last week, up to the same weekday', () => {
  const wed = '2026-10-07';
  const t = tableOf(30, (i, d) => ({ steps: d >= '2026-10-05' ? 1000 : 2000, sleep_min: 400, distance_m: 10.4 }));
  const w = weekFor({ table: t, today: wed, tz: TZ, sessions: [session('2026-10-06', 30), session('2026-09-29', 60), session('2026-10-02', 60)] });
  assert.equal(w.start, '2026-10-05');
  assert.equal(w.days.length, 7);
  assert.deepEqual(w.days.map((d) => d.future), [false, false, false, true, true, true, true]);
  assert.deepEqual(w.days[3], { date: '2026-10-08', future: true, steps: null, lastSteps: 2000, activeMinutes: null, lastActiveMinutes: null, sleepMin: null, lastSleepMin: 400 });
  assert.deepEqual(w.totals.steps, { value: 3000, previous: 6000, deltaPct: -50 });
  assert.deepEqual(w.totals.sleepAvgMin, { value: 400, previous: 400, deltaPct: 0 });
  assert.deepEqual(w.totals.activeMinutes, { value: null, previous: null, deltaPct: null });
  // Last week's Friday session is after "the same weekday", so it is not in `previous`.
  assert.deepEqual(w.totals.workouts, { value: 1, previous: 1, deltaPct: 0 });
  assert.deepEqual(w.totals.workoutMin, { value: 30, previous: 60, deltaPct: -50 });
  assert.equal(weekFor({ table: {}, today: wed, tz: TZ }).totals.workouts.deltaPct, null);
});

test('sleep regularity: 100 for no spread, 0 for two hours of it, null under three nights', () => {
  assert.equal(bedMinOf(night(TODAY, 330)), 330);            // 23:30
  assert.equal(bedMinOf(night(TODAY, 390)), 390);            // 00:30: an hour later, not 23 earlier
  assert.equal(wakeMinOf(night(TODAY, 330, 450)), 420);      // 07:00
  const same = regularity([0, 1, 2, 3].map((i) => night(day(i))));
  assert.deepEqual([same.score, same.bedMean, same.bedSd, same.wakeMean, same.wakeSd], [100, 330, 0, 420, 0]);
  assert.deepEqual(same.nights[0], { date: TODAY, bedMin: 330, wakeMin: 420, asleepMin: 430 });
  const wild = regularity([night(day(0), 60), night(day(1), 600), night(day(2), 60), night(day(3), 600)]);
  assert.equal(wild.score, 0);
  // Bedtime SD 60 (half marks), wake SD 0 (full marks): 75.
  const half = regularity([night(day(0), 270, 510), night(day(1), 330, 450), night(day(2), 390, 390)]);
  assert.deepEqual([half.bedSd, half.wakeSd, half.score], [60, 0, 75]);
  assert.equal(regularity([night(day(0)), night(day(1))]).score, null);
  assert.equal(regularity([{ ...night(day(0)), main: false }, night(day(1)), night(day(2))]).score, null, 'naps do not count');
  assert.deepEqual(regularity([]), { score: null, bedMean: null, bedSd: null, wakeMean: null, wakeSd: null, nights: [] });
});

test('the sleep brief: averages, bedtime against usual, stage shares, debt', () => {
  assert.equal(sleepDebt([450, 400, null, 500, 390], 450), 110);
  assert.equal(sleepDebt([null, undefined], 450), null);
  const st = (deep) => ({ DEEP: deep, REM: 100, LIGHT: 300 - deep, AWAKE: 0 });
  const nights = [];
  for (let i = 13; i >= 1; i -= 1) nights.push(night(day(i), 330, 450, st(80)));
  nights.push(night(TODAY, 390, 420, st(40)));
  const table = tableOf(14, (i) => ({ sleep_min: i === 0 ? 400 : 430 }));
  const s = sleepBrief({ nights, table, today: TODAY, settings: { sleepTarget: 450 } });
  assert.equal(s.nights, 14);
  assert.deepEqual(s.bedtime, { last: '00:30', usual: '23:30', deltaMin: 60 });
  assert.deepEqual(s.wake, { last: '07:30', usual: '07:00', deltaMin: 30 });
  assert.deepEqual(s.stages.DEEP, { min: 40, pct: 10, usualPct: 20 });
  assert.deepEqual(s.stages.AWAKE, { min: 0, pct: 0, usualPct: 0 });
  assert.equal(s.debt7Min, 50 + 6 * 20);
  assert.equal(s.avgMin14, 428);
  assert.equal(s.lastVsAvgMin, 400 - 428);
  assert.ok(s.regularity > 80 && s.regularity < 100);
  // No stages from the device: null, not zeros. No nights: no sleep at all.
  assert.equal(sleepBrief({ nights: nights.map((n) => ({ ...n, summary: { stages: {} } })), table, today: TODAY }).stages, null);
  assert.equal(sleepBrief({ nights: [], table: {}, today: TODAY }), null);
  assert.deepEqual(stagesAverage(nights.slice(0, 3)).REM, { min: 100, pct: 25 });
  assert.equal(stagesAverage([]), null);
});

test('what changed: only real changes, with a direction where there is one', () => {
  const t = { [day(2)]: { steps: 5000, azm: 20 }, [day(1)]: { rhr: 57, hrv: 50, sleep_min: 440, temp_dev: 0.1, steps: 6000, azm: 22 }, [TODAY]: { rhr: 60, hrv: 46, sleep_min: 400, temp_dev: 0.5, steps: 100 } };
  const c = changesFor({ table: t, today: TODAY });
  assert.deepEqual(c.map((x) => [x.key, x.delta, x.good]), [['rhr', 3, false], ['hrv', -4, false], ['sleepMin', -40, false], ['tempDev', 0.4, null], ['steps', 1000, true]]);
  assert.deepEqual(c[0], { key: 'rhr', label: 'Resting heart rate', from: 57, to: 60, delta: 3, unit: 'bpm', good: false, text: 'Resting heart rate is 3 bpm higher than yesterday' });
  assert.equal(c[4].text, 'Yesterday you took 20% more steps than the day before');
  // Under every threshold: nothing to say.
  const quiet = { [day(2)]: { steps: 5000 }, [day(1)]: { rhr: 57, hrv: 50, sleep_min: 440, temp_dev: 0.1, steps: 5600 }, [TODAY]: { rhr: 58, hrv: 51, sleep_min: 455, temp_dev: 0.3 } };
  assert.deepEqual(changesFor({ table: quiet, today: TODAY }), []);
  assert.deepEqual(changesFor({ table: {}, today: TODAY }), []);
  // A verdict day that is not today is not called "yesterday".
  assert.match(changesFor({ table: { [day(2)]: { rhr: 55 }, [day(1)]: { rhr: 59 } }, today: TODAY, vday: day(1) })[0].text, /than the day before$/);
});

test('insights: ranked, one per subject, at most eight, plainly worded', () => {
  const mk = (id, subject, score) => ({ id, subject, score, kind: 'k', tone: 'info', icon: 'steps', title: id, text: '', href: '/trends' });
  const ranked = rankInsights([mk('a', 's1', 40), mk('b', 's1', 70), mk('c', 's2', 55.4), mk('d', 's3', 140), mk('e', 's4', -5), null]);
  assert.deepEqual(ranked.map((x) => [x.id, x.score]), [['d', 100], ['b', 70], ['c', 55], ['e', 0]]);
  assert.deepEqual(Object.keys(ranked[0]), ['id', 'kind', 'score', 'tone', 'icon', 'title', 'text', 'href']);
  assert.equal(rankInsights(Array.from({ length: 20 }, (_, i) => mk(`x${i}`, `s${i}`, i))).length, 8);

  // Resting HR three days above its band; a 7-day step streak; a record step day on Friday; short nights.
  const t = tableOf(60, (i) => ({
    rhr: i <= 2 ? 62 : i % 2 ? 56 : 58,
    steps: i === 0 ? 9000 : i === 2 ? 25_000 : i <= 6 ? 9000 : 4000 + (i % 5) * 100,
    sleep_min: i <= 6 ? 380 : 450,
  }));
  assert.deepEqual((({ days, dir }) => [days, dir])(bandRun(t, 'rhr', TODAY)), [3, 1]);
  assert.equal(bandRun(t, 'rhr', day(5)), null);
  const streaks = streaksFor({ table: t, today: TODAY, tz: TZ, caps: {} });
  const week = weekFor({ table: t, today: TODAY, tz: TZ });
  const sleep = { debt7Min: 490 };
  const ins = insightsFor({ table: t, today: TODAY, streaks, week, sleep });
  assert.ok(ins.length >= 4 && ins.length <= 8);
  assert.deepEqual(ins.map((x) => x.score), ins.map((x) => x.score).sort((a, b) => b - a), 'strongest first');
  const by = Object.fromEntries(ins.map((x) => [x.id, x]));
  assert.equal(by.band_rhr.title, 'Resting heart rate has been 5 bpm above your 30-day average for 3 days');
  assert.deepEqual([by.band_rhr.tone, by.band_rhr.icon, by.band_rhr.href], ['warn', 'heart', '/trends/heart']);
  assert.equal(by.streak_steps_7.title, '7 days in a row at your step goal');
  assert.ok(!by.goal_steps, 'the goal rate tells the same story as the streak: only one of them');
  assert.equal(by.best_steps.title, 'Friday 9 October was your highest step day on record');
  assert.match(by.best_steps.text, /^25,000 steps, the most in the 60 days held here\.$/);
  assert.equal(by.band_sleepMin.title, 'You have slept 1h 03m less than your 30-day average for 7 nights');
  assert.ok(!by.sleep_debt, 'sleep debt and nights under the average are one subject: the stronger one is kept');
  assert.equal(insightsFor({ table: {}, today: TODAY, sleep: { debt7Min: 490 } })[0].title, 'You are 8h 10m short of your sleep goal over the last 7 nights');
  assert.deepEqual(insightsFor({ table: {}, today: TODAY, sleep: { debt7Min: 119 } }), []);
  const ICONS = ['steps', 'moon', 'heart', 'pulse', 'bolt', 'flame', 'scale', 'trophy', 'clock', 'alert', 'up', 'down', 'flat', 'workouts'];
  for (const x of ins) {
    assert.ok(ICONS.includes(x.icon), x.icon);
    assert.ok(['good', 'warn', 'info'].includes(x.tone));
    assert.ok(x.score >= 0 && x.score <= 100 && Number.isInteger(x.score));
    assert.ok(x.href.startsWith('/'));
    assert.ok(!/[!\u{1F300}-\u{1FAFF}]/u.test(x.title + x.text), x.title);
  }
  assert.deepEqual(insightsFor({ table: {}, today: TODAY }), []);

  // A streak that is open today outranks its own goal rate, and says what is needed.
  t[TODAY].steps = 6000;
  const risky = insightsFor({ table: t, today: TODAY, streaks: streaksFor({ table: t, today: TODAY, tz: TZ, caps: {} }), week });
  const risk = risky.find((x) => x.id === 'streak_risk_steps');
  assert.deepEqual([risk.title, risk.text, risk.tone], ['Your 6-day step streak is at risk', '2,000 steps to go today.', 'warn']);

  // Yesterday against its usual weekday needs 10% and three of them.
  const sat = tableOf(40, (i, d) => ({ steps: i === 1 ? 11_200 : dowOf(d) === 5 ? 10_000 : 5000 }));
  const u = insightsFor({ table: sat, today: TODAY }).find((x) => x.kind === 'usual');
  assert.equal(u.title, 'Yesterday you walked 12% more than your usual Saturday');
  sat[day(1)].steps = 10_500;
  assert.ok(!insightsFor({ table: sat, today: TODAY }).some((x) => x.kind === 'usual'));

  // Bedtime drift: the last three nights an hour later than the eleven before.
  const nights = []; for (let i = 13; i >= 0; i -= 1) nights.push(night(day(i), i <= 2 ? 390 : 330));
  const drift = insightsFor({ table: {}, nights, today: TODAY }).find((x) => x.id === 'bedtime_drift');
  assert.deepEqual([drift.title, drift.text, drift.icon], ['Your last 3 bedtimes were 1h 00m later than usual', 'Around 00:30 against a usual 23:30.', 'clock']);

  // Weight over 30 days.
  const weights = []; for (let i = 40; i >= 0; i -= 1) weights.push({ t: Date.parse(`${day(i)}T07:00:00Z`), off: 0, grams: 80_000 - (40 - i) * 50 });
  const w = insightsFor({ table: {}, weights, today: TODAY }).find((x) => x.id === 'weight_30');
  assert.equal(w.title, 'Your weight trend is down 1.5 kg over 30 days');
});

test('the next thing: one line, by priority, never nothing', () => {
  const noon = localToMs(TODAY, 12 * 60, TZ);
  const late = localToMs(TODAY, 21 * 60 + 30, TZ);
  const t = { [day(1)]: { steps: 9000 }, [TODAY]: { steps: 5896 } };
  const base = { table: t, today: TODAY, tz: TZ, now: noon, connected: true, settings: { stepTarget: 8000 } };
  assert.deepEqual(nextFor({ ...base, pending: 1, readiness: { level: 'rest' } }), { kind: 'workout', text: 'A possible workout is waiting for your answer', href: '/workouts' });
  assert.equal(nextFor({ ...base, readiness: { level: 'easy' } }).kind, 'rest');
  assert.deepEqual(nextFor({ ...base, readiness: { level: 'normal' } }), { kind: 'steps', text: '2,104 steps to your goal, about a 20 minute walk', href: '/trends/activity' });
  // Too far to be "within reach": the streak is the thing.
  const far = { ...base, table: { [TODAY]: { steps: 500 } }, streaks: [{ id: 'steps', current: 5, unit: 'days', atRisk: true, need: '7,500 steps to go today' }] };
  assert.deepEqual([nextFor(far).kind, nextFor(far).text], ['streak', '7,500 steps to go today to keep your 5-day streak']);
  // Late, the goal reached, short on sleep: when to turn the lights out.
  const nights = [0, 1, 2, 3].map((i) => night(day(i), 330, 450));
  const done = { ...base, now: late, table: { [TODAY]: { steps: 9000 } }, nights, sleep: { debt7Min: 130 }, settings: { stepTarget: 8000, sleepTarget: 450 } };
  assert.deepEqual([nextFor(done).kind, nextFor(done).text], ['sleep', 'You are 2h 10m short on sleep this week. Lights out by 23:15 allows 7h 30m before your usual 07:00']);
  assert.equal(nextFor({ ...done, now: noon }).kind, 'done');
  assert.equal(nextFor({ ...base, table: { [TODAY]: { rhr: 55 } } }).kind, 'none');
  assert.deepEqual(nextFor({ table: {}, today: TODAY, tz: TZ, now: noon, connected: false }), { kind: 'connect', text: 'Connect Google Health to start seeing your numbers here', href: '/settings' });
  assert.equal(nextFor({ table: {}, today: TODAY, tz: TZ, now: noon, connected: true }).kind, 'sync');
});

test('the brief holds together on nothing, and on steps alone', () => {
  const b = brief({ today: TODAY, tz: TZ, now: localToMs(TODAY, 600, TZ) });
  assert.deepEqual([b.weekday, b.metrics, b.streaks, b.sleep, b.changes, b.insights, b.missing], ['Sunday', {}, [], null, [], [], []]);
  assert.equal(b.week.days.length, 7);
  assert.equal(b.next.kind, 'connect');
  const phone = brief({
    today: TODAY, tz: TZ, now: localToMs(TODAY, 600, TZ), connected: true, caps: { steps: true, distance: true },
    table: tableOf(60, (i) => ({ steps: 5000 + (i % 7) * 300, distance_m: 3700.4 })), missing: [{ cap: 'sleep', text: 'No sleep is arriving. Wear your device at night to see it here', extra: 1 }],
  });
  assert.deepEqual(Object.keys(phone.metrics), ['steps', 'distanceM']);
  assert.equal(phone.metrics.distanceM.value, 3700);
  assert.deepEqual(phone.streaks.map((s) => s.id), ['steps']);
  assert.equal(phone.sleep, null);
  assert.deepEqual(phone.missing, [{ cap: 'sleep', text: 'No sleep is arriving. Wear your device at night to see it here' }]);
  // A capability with no value yet is still listed, as nulls.
  const waiting = brief({ today: TODAY, tz: TZ, caps: { hrv: true } });
  assert.deepEqual(waiting.metrics, { hrv: { value: null, yesterday: null, usual: null, usualKind: 'baseline', usualN: 0, lo: null, hi: null, delta: null, deltaPct: null, goal: null } });
});

test('a day by the hour: windows folded into local hours, the future left empty', () => {
  const date = '2026-10-10';
  const at = (h, m = 0) => localToMs(date, h * 60 + m, TZ);
  const steps = [{ start: at(8), steps: 300 }, { start: at(8, 30), steps: 100 }, { start: at(9), steps: 249 }, { start: at(13), steps: 900 }];
  const hr = [{ start: at(8), avg: 60, min: 55, max: 70 }, { start: at(8, 1), avg: 80, min: null, max: null }, { start: at(13), avg: 120, min: 90, max: 150 }];
  const d = dayHours({ date, tz: TZ, now: at(14, 20), steps, hr });
  assert.equal(d.hours.length, 24);
  assert.deepEqual(d.hours[8], { h: 8, future: false, steps: 400, hrAvg: 70, hrMin: 55, hrMax: 80 });
  assert.deepEqual(d.hours[9], { h: 9, future: false, steps: 249, hrAvg: null, hrMin: null, hrMax: null });
  assert.deepEqual(d.hours[14], { h: 14, future: false, steps: 0, hrAvg: null, hrMin: null, hrMax: null });
  assert.deepEqual(d.hours[15], { h: 15, future: true, steps: null, hrAvg: null, hrMin: null, hrMax: null });
  assert.deepEqual([d.peakHour, d.activeHours], [13, 2]);
  const none = dayHours({ date, tz: TZ, now: at(30) });
  assert.deepEqual([none.peakHour, none.activeHours, none.hours[3].steps, none.hours[23].future], [null, null, null, false]);
  assert.deepEqual(parseHrStats([{ startTime: '2026-10-10T08:00:00Z', heartRate: { beatsPerMinuteAvg: 61.4 } }, { startTime: '2026-10-10T07:00:00Z', heartRate: { beatsPerMinuteAvg: 70, beatsPerMinuteMin: 60, beatsPerMinuteMax: 90 } }, { startTime: '2026-10-10T09:00:00Z' }]),
    [{ start: Date.parse('2026-10-10T07:00:00Z'), avg: 70, min: 60, max: 90 }, { start: Date.parse('2026-10-10T08:00:00Z'), avg: 61.4, min: null, max: null }]);
});

test('histogram: at most ten bins with round edges, every value counted once', () => {
  assert.equal(niceStep(9000), 1000);
  assert.equal(niceStep(21), 2.5);
  assert.equal(niceStep(0), 1);
  const steps = [3100, 5000, 8200, 9999, 12_000];
  const h = histogram(steps);
  assert.deepEqual(h.map((b) => [b.lo, b.hi, b.n]), [[3000, 4000, 1], [4000, 5000, 0], [5000, 6000, 1], [6000, 7000, 0], [7000, 8000, 0], [8000, 9000, 1], [9000, 10_000, 1], [10_000, 11_000, 0], [11_000, 12_000, 1]]);
  for (const v of [[54, 55, 56.5, 61], [0.1, 0.2, 0.35], [0, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [-0.4, 0.1, 0.62], Array.from({ length: 300 }, (_, i) => (i * 7919) % 23_457)]) {
    const b = histogram(v);
    assert.ok(b.length >= 1 && b.length <= 10, `${b.length} bins`);
    assert.equal(b.reduce((a, x) => a + x.n, 0), v.length);
    assert.ok(b[0].lo <= Math.min(...v) && b[b.length - 1].hi >= Math.max(...v));
    for (let i = 1; i < b.length; i += 1) assert.equal(b[i].lo, b[i - 1].hi);
  }
  assert.deepEqual(histogram([45.4]), [{ lo: 45, hi: 46, n: 1 }]);
  assert.deepEqual(histogram([]), []);
});

test('a metric over a range: average, spread, extremes, the previous period, weekdays, goal days', () => {
  const pts = [10, 20, 30, 40, 50, 60, 70].map((value, i) => ({ date: addDays('2026-10-05', i), value }));
  const a = analyse([...pts, { date: '2026-10-12', value: null }], [20, 20, null, 20], { p: 0, goal: 40 });
  assert.deepEqual([a.n, a.avg, a.median, a.p25, a.p75], [7, 40, 40, 25, 55]);
  assert.deepEqual([a.min, a.max], [{ value: 10, date: '2026-10-05' }, { value: 70, date: '2026-10-11' }]);
  assert.deepEqual([a.prevAvg, a.delta, a.deltaPct], [20, 20, 100]);
  assert.deepEqual(a.weekday, [10, 20, 30, 40, 50, 60, 70].map((avg, dow) => ({ dow, avg, n: 1 })));
  assert.deepEqual([a.goal, a.goalDays, a.goalRate, a.outOfBand], [40, 4, 0.57, null]);
  const b = analyse(pts, [], { p: 1, band: { '2026-10-05': { base: 40, sd: 10 }, '2026-10-06': { base: 30, sd: 10 }, '2026-10-11': { base: 40, sd: 10 }, '2026-10-07': { base: null, sd: null } } });
  assert.deepEqual([b.prevAvg, b.delta, b.deltaPct, b.goal, b.goalDays, b.goalRate, b.outOfBand], [null, null, null, null, null, null, 2]);
  assert.equal(analyse([{ date: TODAY, value: null }], []), null);
  // Trailing week: null under four values.
  const t = tableOf(5, (i) => (i < 3 ? { steps: 1000 } : i === 4 ? { steps: 5000 } : null));
  assert.equal(avg7(t, 'steps', TODAY), 2000);
  assert.equal(avg7(t, 'steps', day(1)), null);
});

test('relationships: fourteen pairs before any r, and a careful sentence', () => {
  const def = { id: 'sleep_hrv', xLabel: 'Sleep', yLabel: 'HRV that morning', xUnit: 'min', yUnit: 'ms', words: ['On nights you slept longer, next-morning HRV tended to be', 'higher', 'lower'] };
  const few = relation(def, Array.from({ length: 9 }, (_, i) => [i, i]));
  assert.deepEqual([few.n, few.enough, few.r, few.text], [9, false, null, 'Not enough days yet (9 of 14).']);
  const up = relation(def, Array.from({ length: 14 }, (_, i) => [400 + i, 40 + i]));
  assert.deepEqual([up.enough, up.r, up.text], [true, 1, 'On nights you slept longer, next-morning HRV tended to be higher (r = 1.00 over 14 days). A pattern, not a cause.']);
  assert.match(relation(def, Array.from({ length: 20 }, (_, i) => [i, -i])).text, /tended to be lower \(r = -1\.00 over 20 days\)/);
  const flat = relation(def, Array.from({ length: 16 }, (_, i) => [i, i % 2 ? 40 : 50]));
  assert.ok(Math.abs(flat.r) < 0.2);
  assert.equal(flat.text, 'No clear relationship in these 16 days.');
  assert.equal(relation(def, Array.from({ length: 15 }, (_, i) => [i, 7])).text, 'No clear relationship in these 15 days.');
  assert.equal(relation(def, Array.from({ length: 450 }, (_, i) => [i, i % 9])).points.length, 200);
  assert.equal(pearson([[1, 2]]), null);
  assert.ok(Math.abs(pearson([[1, 1], [2, 2], [3, 2], [4, 5]]) - 0.8944) < 0.001);

  // Which relations exist depends on what the person has; steps of today are left out.
  const t = tableOf(30, (i) => ({ steps: 5000 + i * 10, sleep_min: 400 + i }));
  const rel = relationsFor({ table: t, from: day(29), today: TODAY, caps: {} });
  assert.deepEqual(rel.map((r) => [r.id, r.n]), [['sleep_next_steps', 29], ['steps_sleep', 29]]);
  assert.deepEqual(rel[1].points[rel[1].points.length - 1], [5010, 400], 'yesterday\'s steps against last night\'s sleep');
  assert.deepEqual(relationsFor({ table: t, from: day(29), today: TODAY, caps: { hrv: true } }).map((r) => [r.id, r.n, r.enough]), [['sleep_hrv', 0, false], ['sleep_next_steps', 29, true], ['steps_sleep', 29, true]]);
  assert.deepEqual(relationsFor({ table: {}, from: day(29), today: TODAY, caps: {} }), []);
});

test('months: calendar months touching the range, oldest first, only days inside it', () => {
  const t = tableOf(25, (i) => ({ steps: i === 0 ? 100 : i < 11 ? 8000 : 6000, rhr: 57.26, sleep_min: 430 }));
  const weights = [{ t: Date.parse('2026-10-03T07:00:00Z'), off: 0, grams: 77_000 }, { t: Date.parse('2026-10-05T07:00:00Z'), off: 0, grams: 78_000 }, { t: Date.parse('2026-08-05T07:00:00Z'), off: 0, grams: 99_000 }];
  const m = monthBuckets({ table: t, from: day(19), today: TODAY, tz: TZ, weights, sessions: [session('2026-09-25', 40), session('2026-10-02', 50), session('2026-10-09', 30), session('2026-09-01', 99)] });
  assert.deepEqual(m, [
    { month: '2026-09-01', days: 9, stepsAvg: 6000, activeMinutesAvg: null, sleepAvgMin: 430, rhrAvg: 57.3, hrvAvg: null, workouts: 1, workoutMin: 40, weightKg: null },
    // Today's 100 steps so far are not averaged in.
    { month: '2026-10-01', days: 11, stepsAvg: 8000, activeMinutesAvg: null, sleepAvgMin: 430, rhrAvg: 57.3, hrvAvg: null, workouts: 2, workoutMin: 80, weightKg: 77.5 },
  ]);
  assert.deepEqual(monthBuckets({ table: {}, from: '2026-01-30', today: '2026-03-01', tz: TZ }).map((x) => [x.month, x.days, x.stepsAvg]), [['2026-01-01', 0, null], ['2026-02-01', 0, null], ['2026-03-01', 0, null]]);
});

test('weight: rate per week from the smoothed line, change over the range, extremes', () => {
  assert.equal(slope([[0, 1], [1, 3], [2, 5]]), 2);
  assert.equal(slope([[1, 1], [1, 2]]), null);
  // 100 g down a day for 50 days.
  const weights = []; for (let i = 49; i >= 0; i -= 1) weights.push({ t: Date.parse(`${day(i)}T07:00:00Z`), off: 0, grams: 80_000 - (49 - i) * 100 });
  const w = weightStats({ weights, from: day(29), today: TODAY });
  assert.deepEqual(w, { ratePerWeekKg: -0.7, rangeChangeKg: -2.9, min: { kg: 75.1, date: TODAY }, max: { kg: 78, date: day(29) } });
  // Four smoothed points are not a rate.
  assert.equal(weightStats({ weights: weights.slice(-4), from: day(29), today: TODAY }).ratePerWeekKg, null);
  assert.deepEqual(weightStats({ weights: [], from: day(29), today: TODAY }), { ratePerWeekKg: null, rangeChangeKg: null, min: null, max: null });
});

test('the whole trends analysis on a made table, and on nothing', () => {
  const t = tableOf(200, (i, d) => ({ steps: i === 0 ? 50 : dowOf(d) === 5 ? 12_000 : 7000, rhr: 57, hrv: 50 + (i % 3), sleep_min: 420 + (i % 4) * 20 }));
  const series = []; for (let i = 89; i >= 0; i -= 1) series.push({ date: day(i), rhrBase: 57, rhrSd: 0, hrvBase: 51, hrvSd: 0.5 });
  const a = trendsAnalysis({ today: TODAY, days: 90, tz: TZ, table: t, series, settings: { stepTarget: 8000, sleepTarget: 450 }, caps: {} });
  assert.deepEqual(Object.keys(a.analysis), ['steps', 'sleepMin', 'rhr', 'hrv']);
  assert.equal(a.analysis.steps.n, 89, 'today is not over, so it is not in the step average');
  assert.equal(a.analysis.steps.min.value, 7000);
  assert.equal(a.analysis.rhr.n, 90);
  assert.deepEqual([a.analysis.rhr.prevAvg, a.analysis.rhr.delta, a.analysis.rhr.outOfBand], [57, 0, 0]);
  assert.equal(a.analysis.hrv.outOfBand, 60, 'days more than 1.5 SD from the baseline');
  assert.equal(a.analysis.steps.weekday[5].avg, 12_000);
  assert.ok(a.analysis.steps.goalDays >= 12 && a.analysis.steps.goalRate > 0.1);
  assert.equal(a.rows.length, 90);
  assert.deepEqual(Object.keys(a.rows[0]), ['stepsAvg7', 'sleepAvg7', 'rhrAvg7', 'hrvAvg7', 'activeMinutes', 'activeAvg7']);
  assert.deepEqual([a.rows[0].rhrAvg7, a.rows[0].activeMinutes, a.rows[0].activeAvg7], [57, null, null]);
  assert.equal(a.sleep.goalNights, a.rows.length - [...Array(90)].filter((_, i) => 420 + (i % 4) * 20 < 450).length);
  assert.ok(a.sleep.debtMin > 0);
  assert.equal(a.months.length, 4);
  assert.deepEqual(a.relations.map((r) => r.id), ['sleep_hrv', 'sleep_next_steps', 'steps_sleep']);
  const none = trendsAnalysis({ today: TODAY, days: 365, tz: TZ });
  assert.deepEqual([none.analysis, none.relations, none.sleep.stagesAvg, none.sleep.debtMin, none.sleep.goalNights, none.weight.ratePerWeekKg], [{}, [], null, null, 0, null]);
  assert.equal(none.rows.length, 365);
  assert.equal(none.months.length, 13);
});

/* ── through HTTP ─────────────────────────────────────────────────── */

let r; let fit; let phone; let fresh; let other;
const calls = [];   // every request that reaches the fake Google: [userId, path]
before(async () => {
  r = await rig();
  r.wrap.fn = (userId, url) => { calls.push([userId, url.pathname]); return null; };
  fit = await r.person('anafit', { persona: 'fitbit' });
  other = await r.person('anapixel', { persona: 'pixel', tz: 'Europe/London' });
  phone = await r.person('anaphone', { persona: 'phone' });
  fresh = await r.person('ananew');
});
after(async () => { await r.close(); });
const rollUps = (id) => calls.filter(([u, p]) => u === id && p.endsWith(':rollUp')).length;

test('signed out: 401 on all three', async () => {
  const c = r.client();
  for (const path of ['/api/brief', '/api/day', '/api/day?date=2026-10-10', '/api/trends?days=180']) {
    const x = await c.get(path);
    assert.deepEqual([x.status, x.json.code], [401, 'not_logged_in'], path);
  }
});

test('GET /api/brief: every number with its context', async () => {
  const x = await fit.c.get('/api/brief');
  assert.equal(x.status, 200);
  const b = x.json;
  assert.deepEqual(Object.keys(b), ['today', 'tz', 'weekday', 'verdictDay', 'metrics', 'week', 'streaks', 'sleep', 'changes', 'insights', 'next', 'missing', 'extra']);
  const data = (await fit.c.get('/api/data')).json;
  assert.deepEqual([b.today, b.tz, b.verdictDay], [data.today, 'Africa/Cairo', data.verdictDay]);
  assert.equal(b.weekday, new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${b.today}T00:00:00Z`)));
  assert.deepEqual(Object.keys(b.metrics), ['steps', 'activeMinutes', 'kcal', 'distanceM', 'sleepMin', 'rhr', 'hrv', 'spo2', 'tempDev']);
  for (const [k, m] of Object.entries(b.metrics)) {
    assert.deepEqual(Object.keys(m), ['value', 'yesterday', 'usual', 'usualKind', 'usualN', 'lo', 'hi', 'delta', 'deltaPct', 'goal'], k);
    assert.equal(m.usualKind, ['steps', 'activeMinutes', 'kcal', 'distanceM'].includes(k) ? 'weekday' : 'baseline', k);
    assert.ok(Number.isFinite(m.usual) && m.lo <= m.hi, k);
  }
  assert.deepEqual([b.metrics.steps.value, b.metrics.steps.goal, b.metrics.steps.usualN], [data.activity.today.steps, 8000, 8]);
  assert.deepEqual([b.metrics.activeMinutes.goal, b.metrics.sleepMin.goal, b.metrics.rhr.goal], [22, 450, null]);
  const last = data.series[data.series.length - 1];
  assert.deepEqual([b.metrics.rhr.value, b.metrics.hrv.value, b.metrics.rhr.usual], [last.rhr, last.hrv, last.rhrBase]);
  assert.equal(b.week.days.length, 7);
  assert.deepEqual(Object.keys(b.week.totals), ['steps', 'activeMinutes', 'distanceM', 'sleepAvgMin', 'workouts', 'workoutMin']);
  assert.ok(b.week.days.every((d) => d.future === (d.date > b.today)));
  assert.deepEqual(b.streaks.map((s) => s.id), ['steps', 'active', 'sleep', 'workout_weeks']);
  assert.equal(b.streaks[0].current, data.activity.streak.steps);
  for (const s of b.streaks) assert.ok(s.best >= s.current && (s.need === null) === !s.atRisk, s.id);
  assert.deepEqual(Object.keys(b.sleep), ['nights', 'avgMin14', 'lastVsAvgMin', 'bedtime', 'wake', 'stages', 'debt7Min', 'regularity']);
  assert.match(b.sleep.bedtime.last, /^\d\d:\d\d$/);
  assert.deepEqual(Object.keys(b.sleep.stages), ['DEEP', 'REM', 'LIGHT', 'AWAKE']);
  assert.ok(Math.abs(Object.values(b.sleep.stages).reduce((a, s) => a + s.pct, 0) - 100) < 0.3);
  assert.ok(b.sleep.regularity >= 0 && b.sleep.regularity <= 100);
  assert.ok(b.insights.length >= 1 && b.insights.length <= 8);
  assert.deepEqual(b.insights.map((i) => i.score), b.insights.map((i) => i.score).sort((p, q) => q - p));
  assert.ok(b.next.text.length > 5 && b.next.href.startsWith('/'));
  for (const c of b.changes) assert.deepEqual(Object.keys(c), ['key', 'label', 'from', 'to', 'delta', 'unit', 'good', 'text']);
  // A workout question waiting comes first.
  await r.app.worlds.hold(fit.id, async (w) => { await w.workouts.tick(); });
  if ((await fit.c.get('/api/me')).json.workout.pending > 0) assert.deepEqual((await fit.c.get('/api/brief')).json.next.kind, 'workout');
  // Goals are the person's own.
  await fit.c.patch('/api/settings', { goals: { steps: 12_345 } });
  assert.equal((await fit.c.get('/api/brief')).json.metrics.steps.goal, 12_345);
});

test('GET /api/day: the hours, kept after the first read, and never a 502', async () => {
  const before0 = rollUps(fit.id);
  const x = await fit.c.get('/api/day');
  assert.equal(x.status, 200);
  const d = x.json;
  assert.deepEqual(Object.keys(d).sort(), ['activeHours', 'at', 'date', 'hours', 'hr', 'peakHour', 'steps', 'tz']);
  assert.deepEqual([d.date, d.tz, d.hours.length], [(await fit.c.get('/api/brief')).json.today, 'Africa/Cairo', 24]);
  assert.deepEqual(d.steps, { available: true, reason: null });
  assert.deepEqual(d.hr, { available: true, reason: null });
  assert.deepEqual(Object.keys(d.hours[0]), ['h', 'future', 'steps', 'hrAvg', 'hrMin', 'hrMax']);
  const past = d.hours.filter((h) => !h.future);
  assert.ok(past.length >= 1);
  for (const h of past) assert.ok(Number.isInteger(h.steps) && (h.hrAvg === null || (h.hrMin <= h.hrAvg && h.hrAvg <= h.hrMax)), JSON.stringify(h));
  assert.ok(past.some((h) => h.hrAvg !== null));
  for (const h of d.hours.filter((q) => q.future)) assert.deepEqual([h.steps, h.hrAvg, h.hrMin, h.hrMax], [null, null, null, null]);
  assert.equal(d.activeHours, past.filter((h) => h.steps >= 250).length);
  assert.equal(d.hours[d.peakHour].steps, Math.max(...past.map((h) => h.steps)));
  const asked = rollUps(fit.id) - before0;
  assert.ok(asked >= 2, 'steps and heart rate were read from Google');
  // Again: the same answer, and Google is not asked.
  const again = await fit.c.get(`/api/day?date=${d.date}`);
  assert.deepEqual(again.json, d);
  assert.equal(rollUps(fit.id) - before0, asked);

  // A day that is over: all 24 hours, kept for good.
  const yesterday = addDays(d.date, -1);
  const y = (await fit.c.get(`/api/day?date=${yesterday}`)).json;
  assert.ok(y.hours.every((h) => !h.future && Number.isInteger(h.steps)));
  const n = rollUps(fit.id);
  assert.deepEqual((await fit.c.get(`/api/day?date=${yesterday}`)).json, y);
  assert.equal(rollUps(fit.id), n);
  await r.app.worlds.hold(fit.id, (w) => {
    assert.equal(w.db.meta(`day:${yesterday}`).final, true);
    assert.equal(w.db.meta(`day:${d.date}`).final, false);
    w.db.setMeta(`day:${addDays(d.date, -9)}`, { at: 1, final: true, v: {} });
  });
  // Reading another day prunes what is more than 8 days old.
  await fit.c.get(`/api/day?date=${addDays(d.date, -2)}`);
  await r.app.worlds.hold(fit.id, (w) => { assert.equal(w.db.meta(`day:${addDays(d.date, -9)}`), null); assert.ok(w.db.meta(`day:${yesterday}`)); });

  // Bad dates.
  for (const bad of ['yesterday', '2026-13-40', '2026-02-30', addDays(d.date, 1), addDays(d.date, -7), '20261010']) {
    const e = await fit.c.get(`/api/day?date=${bad}`);
    assert.deepEqual([e.status, e.json.code], [400, 'bad_request'], bad);
  }
  assert.equal((await fit.c.get(`/api/day?date=${addDays(d.date, -6)}`)).status, 200);
});

test('GET /api/day: Google failing is a reason, not an error, and is not kept', async () => {
  const today = (await other.c.get('/api/brief')).json.today;
  const date = addDays(today, -3);
  r.wrap.fn = (userId, url) => { calls.push([userId, url.pathname]); return userId === other.id && url.pathname.endsWith(':rollUp') ? new Response('{"error":{"code":500,"message":"backend error","status":"INTERNAL"}}', { status: 500 }) : null; };
  try {
    const x = await other.c.get(`/api/day?date=${date}`);
    assert.equal(x.status, 200);
    assert.deepEqual(x.json.steps, { available: false, reason: 'Steps could not be read from Google just now' });
    assert.deepEqual(x.json.hr, { available: false, reason: 'Heart rate could not be read from Google just now' });
    assert.deepEqual([x.json.hours.length, x.json.hours[5].steps, x.json.peakHour, x.json.activeHours], [24, null, null, null]);
  } finally { r.wrap.fn = (userId, url) => { calls.push([userId, url.pathname]); return null; }; }
  const ok = await other.c.get(`/api/day?date=${date}`);
  assert.deepEqual([ok.json.steps.available, ok.json.hr.available], [true, true]);
  assert.equal(ok.json.tz, 'Europe/London');
});

test('GET /api/trends: 180 and 365 days, with the analysis', async () => {
  for (const days of [180, 365]) {
    const x = await fit.c.get(`/api/trends?days=${days}`);
    assert.equal(x.status, 200);
    const t = x.json;
    assert.deepEqual([t.days, t.series.length], [days, days]);
    // Everything that was there before still is.
    for (const k of ['today', 'tz', 'days', 'from', 'series', 'weeks', 'sleep', 'weight', 'activity', 'caps', 'months', 'analysis', 'relations']) assert.ok(k in t, k);
    for (const k of ['nights', 'consistency', 'regularity', 'stagesAvg', 'debtMin', 'goalNights']) assert.ok(k in t.sleep, k);
    for (const k of ['latest', 'change30', 'trend', 'points', 'ratePerWeekKg', 'rangeChangeKg', 'min', 'max']) assert.ok(k in t.weight, k);
    const row = t.series[t.series.length - 2];
    for (const k of ['steps', 'rhrBase', 'stepsAvg7', 'sleepAvg7', 'rhrAvg7', 'hrvAvg7', 'activeMinutes', 'activeAvg7']) assert.ok(k in row, k);
    assert.equal(row.activeMinutes, row.azm ?? row.activeMin);
    const week = t.series.slice(-8, -1).map((q) => q.steps);
    assert.equal(row.stepsAvg7, Math.round(week.reduce((a, b) => a + b, 0) / 7));
    assert.deepEqual(Object.keys(t.analysis), ['steps', 'activeMinutes', 'kcal', 'distanceM', 'sleepMin', 'rhr', 'hrv', 'spo2', 'tempDev', 'bodyFat']);
    for (const [k, a] of Object.entries(t.analysis)) {
      assert.deepEqual(Object.keys(a), ['n', 'avg', 'median', 'p25', 'p75', 'min', 'max', 'prevAvg', 'delta', 'deltaPct', 'weekday', 'histogram', 'goal', 'goalDays', 'goalRate', 'outOfBand'], k);
      assert.ok(a.min.value <= a.p25 && a.p25 <= a.median && a.median <= a.p75 && a.p75 <= a.max.value, k);
      assert.ok(a.histogram.length <= 10 && a.histogram.reduce((s, b) => s + b.n, 0) === a.n, k);
      assert.deepEqual(a.weekday.map((w) => w.dow), [0, 1, 2, 3, 4, 5, 6]);
      assert.equal(a.weekday.reduce((s, w) => s + w.n, 0), a.n);
    }
    const s = t.analysis.steps;
    assert.deepEqual([s.goal, s.goalDays, s.goalRate], [12_345, t.series.slice(0, -1).filter((q) => q.steps >= 12_345).length, Math.round((s.goalDays / s.n) * 100) / 100]);
    assert.ok(Number.isInteger(t.analysis.rhr.outOfBand) && t.analysis.steps.outOfBand === null);
    assert.equal(t.months[t.months.length - 1].month, `${t.today.slice(0, 7)}-01`);
    assert.equal(t.months[0].month, `${t.from.slice(0, 7)}-01`);
    assert.ok(t.months.length >= days / 31 && t.months.reduce((a, m) => a + m.workouts, 0) >= 1);
    assert.deepEqual(Object.keys(t.months[0]), ['month', 'days', 'stepsAvg', 'activeMinutesAvg', 'sleepAvgMin', 'rhrAvg', 'hrvAvg', 'workouts', 'workoutMin', 'weightKg']);
    assert.ok(t.sleep.regularity.score >= 0 && t.sleep.regularity.nights.length >= 14);
    assert.deepEqual(Object.keys(t.sleep.regularity.nights[0]), ['date', 'bedMin', 'wakeMin', 'asleepMin']);
    assert.deepEqual(Object.keys(t.sleep.stagesAvg), ['DEEP', 'REM', 'LIGHT', 'AWAKE']);
    assert.ok(t.sleep.debtMin > 0 && t.sleep.goalNights >= 0);
    assert.ok(Number.isFinite(t.weight.ratePerWeekKg) && Number.isFinite(t.weight.rangeChangeKg) && t.weight.min.kg <= t.weight.max.kg);
    assert.deepEqual(t.relations.map((q) => q.id), ['sleep_hrv', 'sleep_next_steps', 'steps_sleep']);
    for (const q of t.relations) {
      assert.deepEqual(Object.keys(q), ['id', 'xLabel', 'yLabel', 'xUnit', 'yUnit', 'n', 'enough', 'r', 'text', 'points'], q.id);
      assert.ok(q.enough && q.points.length <= 200 && q.points.length === Math.min(200, q.n) && Math.abs(q.r) <= 1);
      assert.match(q.text, /^(No clear relationship in these \d+ days\.|.+ \(r = -?\d\.\d\d over \d+ days\)\. A pattern, not a cause\.)$/);
    }
  }
  // The shorter ranges carry the same analysis; an unknown range is still 30.
  const week = (await fit.c.get('/api/trends?days=7')).json;
  assert.deepEqual([week.days, week.analysis.steps.n, week.relations[0].enough, week.relations[0].r], [7, 6, false, null]);
  assert.match(week.relations[0].text, /^Not enough days yet \(\d+ of 14\)\.$/);
  assert.ok(Number.isFinite(week.analysis.rhr.prevAvg), 'the previous seven days');
  assert.equal((await fit.c.get('/api/trends?days=200')).json.days, 30);
});

test('a phone and nothing else: what there is, and no holes', async () => {
  const b = (await phone.c.get('/api/brief')).json;
  assert.deepEqual(Object.keys(b.metrics), ['steps', 'distanceM']);
  assert.equal(b.sleep, null);
  assert.deepEqual(b.streaks.map((s) => s.id), ['steps']);
  assert.ok(b.insights.length >= 1 && b.insights.every((i) => ['/trends/activity'].includes(i.href)));
  assert.ok(b.missing.some((m) => m.cap === 'sleep') && b.missing.every((m) => typeof m.text === 'string'));
  assert.ok(!b.missing.some((m) => m.cap === 'steps'));
  assert.deepEqual(b.changes.filter((c) => !['steps'].includes(c.key)), []);
  const d = (await phone.c.get('/api/day')).json;
  assert.deepEqual([d.steps.available, d.hr], [true, { available: false, reason: 'Your device does not report minute-by-minute heart rate' }]);
  assert.ok(d.hours.every((h) => h.hrAvg === null));
  const t = (await phone.c.get('/api/trends?days=90')).json;
  assert.deepEqual(Object.keys(t.analysis), ['steps', 'distanceM']);
  assert.deepEqual([t.relations, t.sleep.stagesAvg, t.sleep.regularity.score, t.sleep.debtMin, t.weight.ratePerWeekKg], [[], null, null, null, null]);
  assert.equal(t.series[0].sleepAvg7, null);
});

test('a new person with nothing: empty lists, a next step, no errors', async () => {
  const x = await fresh.c.get('/api/brief');
  assert.equal(x.status, 200);
  const b = x.json;
  assert.deepEqual([b.metrics, b.streaks, b.sleep, b.changes, b.insights, b.missing], [{}, [], null, [], [], []]);
  assert.deepEqual(b.next, { kind: 'connect', text: 'Connect Google Health to start seeing your numbers here', href: '/settings' });
  assert.equal(b.week.days.length, 7);
  const n = calls.length;
  const d = await fresh.c.get('/api/day');
  assert.equal(d.status, 200);
  assert.deepEqual([d.json.steps, d.json.hr], [{ available: false, reason: 'Connect Google Health or Garmin to see the day hour by hour' }, { available: false, reason: 'Connect Google Health or Garmin to see the day hour by hour' }]);
  assert.deepEqual([d.json.hours.length, d.json.peakHour, d.json.activeHours], [24, null, null]);
  assert.equal(calls.length, n, 'nobody is asked on behalf of someone who is not connected');
  for (const days of [7, 180, 365]) {
    const t = await fresh.c.get(`/api/trends?days=${days}`);
    assert.equal(t.status, 200);
    assert.deepEqual([t.json.analysis, t.json.relations, t.json.series.length, t.json.sleep.goalNights, t.json.weight.min], [{}, [], days, 0, null]);
  }
});

test('isolation: each person gets their own numbers, their own cache, their own Google', async () => {
  const a = (await fit.c.get('/api/brief')).json;
  const b = (await other.c.get('/api/brief')).json;
  assert.equal(a.metrics.steps.goal, 12_345);
  assert.equal(b.metrics.steps.goal, 8000);
  assert.notEqual(a.week.totals.steps.value, b.week.totals.steps.value);
  assert.notEqual(a.metrics.rhr.usual, b.metrics.rhr.usual);
  assert.ok(!('tempDev' in b.metrics), 'a Pixel Watch has no skin temperature; a Fitbit owner\'s is not shown instead');
  assert.ok(!JSON.stringify(b).includes('12,345') && !JSON.stringify(b).includes('12345'));
  // The same date, cached for one person, is still read from Google for the other, as the other.
  const date = addDays(a.today, -1);
  await fit.c.get(`/api/day?date=${date}`);
  const mine = rollUps(fit.id); const theirs = rollUps(other.id);
  const od = (await other.c.get(`/api/day?date=${date}`)).json;
  assert.equal(rollUps(fit.id), mine);
  assert.ok(rollUps(other.id) > theirs);
  assert.equal(od.tz, 'Europe/London');
  const ta = (await fit.c.get('/api/trends?days=180')).json; const tb = (await other.c.get('/api/trends?days=180')).json;
  assert.notEqual(ta.analysis.steps.avg, tb.analysis.steps.avg);
  assert.equal(tb.analysis.steps.goal, 8000);
  assert.ok(!('bodyFat' in tb.analysis) && 'bodyFat' in ta.analysis);
});
