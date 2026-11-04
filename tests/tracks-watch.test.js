import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromTcx, cleanPoints, trackStats } from '../server/tracks.js';

/* A TCX with the watch's own distance at each point (DistanceMeters): splits and fastest
   stretches are measured on it, as the watch's laps, Google's pace laps and Strava's best efforts are. */

const T0 = Date.parse('2026-10-05T23:28:00Z');
function tcx({ withDistance = true } = {}) {
  // 5.1 km due north at a fast first km (4:40) then 6:10 per km, one point a second. The GPS line
  // is laid 2 % short (as a smoothed track can come out); the watch's distance is the true one.
  const pts = [];
  let t = 0; let d = 0;
  while (d < 5100) {
    const pace = d < 1000 ? 280 : 370;   // s per km
    const lat = 49.2 + (d * 0.98) / 111_320;
    pts.push(`<Trackpoint><Time>${new Date(T0 + t * 1000).toISOString()}</Time><Position><LatitudeDegrees>${lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>-122.9</LongitudeDegrees></Position>${withDistance ? `<DistanceMeters>${d.toFixed(1)}</DistanceMeters>` : ''}<HeartRateBpm><Value>170</Value></HeartRateBpm></Trackpoint>`);
    t += 1; d += 1000 / pace;
  }
  return `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Lap><Track>${pts.join('')}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

test('the watch\'s distance at each point is kept, after the heart rate', () => {
  const p = cleanPoints(fromTcx(tcx()), { type: 'RUNNING' });
  assert.equal(p[0].length, 7);
  assert.equal(p[0][5], 170);
  assert.equal(p[0][6], 0);
  assert.ok(p.at(-1)[6] > 5090);
  // Without it, the points are as before.
  assert.equal(cleanPoints(fromTcx(tcx({ withDistance: false })), { type: 'RUNNING' })[0].length, 6);
});

test('fastest stretches and splits on the watch\'s distance: the first km and the 5 km as the watch has them', () => {
  const points = cleanPoints(fromTcx(tcx()), { type: 'RUNNING' });
  const st = trackStats({ type: 'RUNNING', points, start: T0, end: points.at(-1)[0], distanceM: 5100 });
  const eff = Object.fromEntries(st.efforts.map((e) => [e.distanceM, e.timeS]));
  assert.ok(Math.abs(eff[1000] - 280) <= 2, `1 km ${eff[1000]}`);
  assert.ok(Math.abs(eff[5000] - (280 + 4 * 370)) <= 3, `5 km ${eff[5000]}`);
  assert.ok(Math.abs(st.splits[0].movingS - 280) <= 3, `first split ${st.splits[0].movingS}`);
  assert.ok(Math.abs(st.distanceM - 5100) <= 2);
  // The GPS line alone (2 % short, then scaled to the 5.1 km) spreads the distance evenly instead.
  const gps = trackStats({ type: 'RUNNING', points: points.map((q) => q.slice(0, 6)), start: T0, end: points.at(-1)[0], distanceM: 5100 });
  assert.equal(gps.distanceM, 5100);
});
