/* Intervals while recording (web/js/intervals.js) and where their cues are felt (web/js/buzz.js route). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ivConfig, planAt, hrStart, hrStep, skip, hrDefaults, ivSummary, HOLD_MS, MIN_PHASE_MS } from '../web/js/intervals.js';
import { route, PATTERNS, patternOf } from '../web/js/buzz.js';

test('time intervals: push, rest, and done after the last push with no rest after it', () => {
  const c = ivConfig({ on: true, mode: 'time', pushS: 120, restS: 60, reps: 3 });
  assert.deepEqual(planAt(c, 0), { phase: 'push', rep: 1, left: 120 });
  assert.deepEqual(planAt(c, 119), { phase: 'push', rep: 1, left: 1 });
  assert.deepEqual(planAt(c, 120), { phase: 'rest', rep: 1, left: 60 });
  assert.deepEqual(planAt(c, 180), { phase: 'push', rep: 2, left: 120 });
  assert.equal(planAt(c, 2 * 180 + 119).phase, 'push');
  assert.equal(planAt(c, 2 * 180 + 120).phase, 'done', 'the last push ends it');
  assert.equal(planAt(c, 10_000).phase, 'done');
});

test('distance intervals, and until you stop', () => {
  const c = ivConfig({ mode: 'distance', pushM: 400, restM: 200, reps: 0 });
  assert.deepEqual(planAt(c, 399), { phase: 'push', rep: 1, left: 1 });
  assert.deepEqual(planAt(c, 450), { phase: 'rest', rep: 1, left: 150 });
  assert.equal(planAt(c, 600 * 40 + 10).phase, 'push', 'no end without repeats');
  assert.equal(planAt(c, 600 * 40 + 10).rep, 41);
});

test('heart-rate intervals: push until it holds at the top, rest until it holds back down', () => {
  const c = ivConfig({ mode: 'hr', hrUp: 170, hrDown: 135, reps: 2 });
  const t0 = 1_000_000;
  const iv = hrStart(t0);
  // Reaching it too soon (under 20 s in) does not end the push.
  assert.equal(hrStep(iv, c, 172, t0 + 5_000), null);
  assert.equal(hrStep(iv, c, 172, t0 + 11_000), null);
  // One beat over then under again: not held.
  assert.equal(hrStep(iv, c, 165, t0 + 30_000), null);
  assert.equal(iv.holdAt, null);
  assert.equal(hrStep(iv, c, 171, t0 + 40_000), null);
  assert.equal(hrStep(iv, c, 171, t0 + 40_000 + HOLD_MS), 'rest');
  const r0 = t0 + 40_000 + HOLD_MS;
  // No reading: nothing changes.
  assert.equal(hrStep(iv, c, null, r0 + MIN_PHASE_MS + 10_000), null);
  assert.equal(hrStep(iv, c, 134, r0 + MIN_PHASE_MS + 10_000), null);
  assert.equal(hrStep(iv, c, 130, r0 + MIN_PHASE_MS + 10_000 + HOLD_MS), 'push');
  assert.equal(iv.rep, 2);
  // The second push, and its rest ends it.
  const p2 = iv.since;
  hrStep(iv, c, 175, p2 + MIN_PHASE_MS); assert.equal(hrStep(iv, c, 175, p2 + MIN_PHASE_MS + HOLD_MS), 'rest');
  const r2 = iv.since;
  hrStep(iv, c, 120, r2 + MIN_PHASE_MS); assert.equal(hrStep(iv, c, 120, r2 + MIN_PHASE_MS + HOLD_MS), 'done');
  assert.equal(hrStep(iv, c, 180, r2 + 999_999), null, 'done stays done');
});

test('skip by hand moves to the next part', () => {
  const c = ivConfig({ mode: 'hr', hrUp: 170, hrDown: 135, reps: 1 });
  const iv = hrStart(0);
  assert.equal(skip(iv, c, 1), 'rest');
  assert.equal(skip(iv, c, 2), 'done');
  assert.equal(skip(iv, c, 3), null);
});

test('a kept setting is made sane', () => {
  const c = ivConfig({ mode: 'nope', pushS: -4, restS: 'x', hrUp: 150, hrDown: 160, reps: 99, target: 'watch' });
  assert.equal(c.mode, 'time');
  assert.equal(c.pushS, 5);
  assert.equal(c.restS, 60);
  assert.equal(c.hrDown, 145, 'resting down to over the push rate would never change');
  assert.equal(c.reps, 50);
  assert.equal(c.target, 'sensor');
  assert.equal(ivConfig(null).on, false);
  assert.deepEqual(hrDefaults({ bounds: [120, 132, 145, 158] }), { hrUp: 158, hrDown: 132 });
  assert.deepEqual(hrDefaults(null), { hrUp: 165, hrDown: 130 });
  assert.equal(ivSummary(ivConfig({ mode: 'time', pushS: 90, restS: 45, reps: 6 })), '6 × 1:30 push, 0:45 rest');
  assert.equal(ivSummary(ivConfig({ mode: 'hr', hrUp: 170, hrDown: 135, reps: 0 })), 'push to 170 bpm, rest to 135 bpm');
});

test('cues go where asked, fall back to what can vibrate, and to a tone when nothing can', () => {
  // Both can: the choice holds.
  assert.deepEqual(route('sensor', true, true), { sensor: true, phone: false, tone: false });
  assert.deepEqual(route('phone', true, true), { sensor: false, phone: true, tone: false });
  assert.deepEqual(route('both', true, true), { sensor: true, phone: true, tone: false });
  // The sensor can't: the phone, whatever was chosen.
  assert.deepEqual(route('sensor', false, true), { sensor: false, phone: true, tone: false });
  assert.deepEqual(route('both', false, true), { sensor: false, phone: true, tone: false });
  // The phone can't: the sensor.
  assert.deepEqual(route('phone', true, false), { sensor: true, phone: false, tone: false });
  // Neither.
  assert.deepEqual(route('sensor', false, false), { sensor: false, phone: false, tone: true });
});

test('the two default patterns feel different', () => {
  const push = patternOf(ivConfig({}).pushPat); const rest = patternOf(ivConfig({}).restPat);
  assert.notDeepEqual(push, rest);
  const on = (p) => p.filter((_, i) => i % 2 === 0);
  assert.ok(on(push).length !== on(rest).length && Math.max(...on(push)) > 2 * Math.max(...on(rest)), 'more and longer buzzes for push');
  for (const [, , ms] of PATTERNS) assert.ok(ms.length % 2 === 1 && ms.every((x) => x > 0));
});
