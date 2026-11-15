// A walk the watch noticed by itself (Google: PASSIVELY_MEASURED) has no GPS route, so its page
// must carry the distance and pace itself, and say why there is no map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorView } from '../server/history.js';

const walk = { id: 'users/1/dataTypes/exercise/dataPoints/9', startMs: 0, endMs: 2_868_000, type: 'WALKING', name: 'Walk',
  distanceM: 3574.1, steps: 4810, kcal: 349, avgHr: 96, azm: null, activeSec: 2868, paceSecPerKm: 802, method: 'PASSIVELY_MEASURED' };

test("a watch-detected walk: Google's pace, and marked as having no route", () => {
  const v = mirrorView(walk);
  assert.equal(v.distanceM, 3574.1);
  assert.equal(v.paceSPerKm, 802);
  assert.equal(v.autoDetected, true);
});

test('no pace from Google: active time over the distance', () => {
  assert.equal(mirrorView({ ...walk, paceSecPerKm: null }).paceSPerKm, Math.round(2868 / 3.5741));
});

test('a ride has no pace; a session started on the watch is not auto-detected', () => {
  assert.equal(mirrorView({ ...walk, type: 'BIKING' }).paceSPerKm, null);
  assert.equal(mirrorView({ ...walk, method: 'ACTIVELY_MEASURED' }).autoDetected, false);
});
