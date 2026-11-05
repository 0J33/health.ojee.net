/* Google sends no zone minutes for a worn day with none: Active minutes
   counts that day as 0 (its cardio minutes), so an average is not of the
   active days alone; and a week's cardio range judges this week as it
   stands once it has passed last week. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { addDays, today as todayIn } from '../server/core/util.js';

let r; let p;
before(async () => {
  r = await rig();
  p = await r.person('zed');
  const today = todayIn(Date.now(), 'Africa/Cairo');
  await r.app.worlds.hold(p.id, async (w) => {
    for (let k = 1; k <= 6; k += 1) {
      const date = addDays(today, -k);
      w.db.setDaily(date, 'steps', 3000);
      w.db.setDaily(date, 'zone_light', 600); w.db.setDaily(date, 'zone_moderate', k === 2 ? 30 : 0);
      if (k === 2) { w.db.setDaily(date, 'azm', 30); w.db.setDaily(date, 'azm_fat', 30); }
    }
  });
});
after(async () => { await r.close(); });

test('active minutes: a worn day without zone minutes is 0, not missing', async () => {
  const d = (await p.c.get('/api/metric/active?range=week')).json;
  const zeros = d.chart.points.filter((x) => x.value === 0).length;
  assert.equal(zeros, 5, JSON.stringify(d.chart.points));
  assert.equal(d.stats.avg, 5, 'the average day over all six: 30 / 6');
});

test('active minutes are judged by the week, as the guideline is: the day page, the week page and the list agree', async () => {
  const day = (await p.c.get('/api/metric/active?range=day')).json.ranges[0];
  const week = (await p.c.get('/api/metric/active?range=week')).json.ranges[0];
  assert.deepEqual([day.basis, day.value], ['past-7-now', 30]);
  assert.deepEqual([week.basis, week.value, week.current], ['past-7-now', 30, 'Under guideline']);
  const list = (await p.c.get('/api/browse')).json.categories.flatMap((c) => c.metrics).find((m) => m.id === 'active');
  assert.deepEqual([list.band.basis, list.band.label], ['past-7-now', 'Under guideline']);
});
