// Naps (server/core/naps.js): which sleeps they are, the day's, and what a month of them says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { napsOn, napsReport, isNap } from '../server/core/naps.js';
import { addDays } from '../server/core/util.js';

const H = 3_600_000;
/** A sleep in UTC (offset 0) from `date` at hour h0 for `hours`. */
function sleep(db, id, date, h0, hours, main, asleep = hours * 60 - 5) {
  const startMs = Date.parse(`${date}T00:00:00Z`) + h0 * H;
  const endMs = startMs + hours * H;
  db.upsertSleep({ id, date: new Date(endMs).toISOString().slice(0, 10), startMs, endMs, startOff: 0, endOff: 0, main, asleepMin: asleep, awakeMin: 5, periodMin: hours * 60, stages: [], summary: { stages: { LIGHT: asleep }, nap: !main, source: null } });
}
const TODAY = '2026-11-15';

test('a nap is a sleep that is not the main one; the day has its own', () => {
  const db = openDb(':memory:');
  sleep(db, 'n1', '2026-11-14', 23, 8, true);
  sleep(db, 'p1', TODAY, 14, 0.5, false, 26);
  sleep(db, 'p2', TODAY, 17, 1, false, 50);
  const naps = napsOn(db, TODAY);
  assert.deepEqual(naps.map((x) => [x.id, x.start, x.asleepMin, x.late]), [['p1', '14:00', 26, false], ['p2', '17:00', 50, true]]);
  assert.equal(isNap({ main: true }), false);
});

test("a month of naps: how many, how long, when, and the night after against nights without", () => {
  const db = openDb(':memory:');
  const from = addDays(TODAY, -29);
  for (let i = 0; i < 30; i += 1) {
    const d = addDays(from, i);
    const nap = i % 3 === 0;
    // The night after day d ends on d + 1: after a nap day it starts an hour later and is 40 minutes shorter.
    if (nap) sleep(db, `night-${d}`, addDays(d, 1), 0, 7, true, 400); else sleep(db, `night-${d}`, d, 23, 8, true, 440);
    if (nap) sleep(db, `nap-${d}`, d, 15, 0.75, false, 40);
  }
  const r = napsReport(db, { today: TODAY, days: 30 });
  assert.equal(r.stats.naps, 10);
  assert.equal(r.stats.daysWithNap, 10);
  assert.equal(r.stats.avgMin, 40);
  assert.equal(r.stats.usualStart, '15:00');
  assert.equal(r.stats.late, 0);
  assert.equal(r.naps[0].date, addDays(from, 27), 'newest first');
  assert.ok(r.stats.nightAfter, 'enough nights to compare');
  assert.equal(r.stats.nightAfter.diffMin, -40);
  assert.equal(r.stats.nightAfter.bedtimeDiffMin, 60);
  assert.ok(r.insights.some((t) => /slept 40 min less/.test(t)) && r.insights.some((t) => /1 h 00 later/.test(t)), r.insights.join(' | '));
  assert.ok(r.insights.length >= 2 && /10 naps in the last 30 days/.test(r.insights[0]), r.insights.join(' | '));
});

test('no naps: said plainly, and nothing to compare', () => {
  const db = openDb(':memory:');
  sleep(db, 'n1', '2026-11-14', 23, 8, true);
  const r = napsReport(db, { today: TODAY, days: 30 });
  assert.equal(r.stats.naps, 0);
  assert.equal(r.stats.nightAfter, null);
  assert.deepEqual(r.insights, ['No naps in the last 30 days.']);
});
