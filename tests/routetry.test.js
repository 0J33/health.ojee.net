/* A try at a route inside a longer outing (routetry.js): walked to, run, walked on from. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTry, markedTry, densify } from '../server/routetry.js';

const LAT = 44.65; const LNG = -63.58;
const mPerLat = 111_320; const mPerLng = 111_320 * Math.cos((LAT * Math.PI) / 180);
const at = (x, y) => [LAT + y / mPerLat, LNG + x / mPerLng];   // metres east, north of a point
// A loop of about 2 km: a circle of radius 320 m, starting at its south point.
const loop = Array.from({ length: 41 }, (_, i) => { const a = -Math.PI / 2 + (i / 40) * 2 * Math.PI; return at(320 * Math.cos(a), 320 + 320 * Math.sin(a)); });

test('a loop run inside a longer walk: only the loop is the try, start and end where it starts and ends', () => {
  const pts = []; let t = 0;
  const go = (x, y, sec) => { t += sec * 1000; const [la, ln] = at(x, y); pts.push([t, la, ln]); };
  for (let i = 0; i <= 50; i += 1) go(0, -500 + i * 10, 8);             // 500 m walk north to the loop's start
  const startT = t;
  for (let i = 1; i <= 400; i += 1) { const a = -Math.PI / 2 + (i / 400) * 2 * Math.PI; go(320 * Math.cos(a), 320 + 320 * Math.sin(a) + (i % 7) * 2, 1.5); }   // the loop, with GPS wobble
  const endT = t;
  for (let i = 1; i <= 40; i += 1) go(i * 10, 0, 8);                      // walking on, east, off the loop
  const r = findTry(loop, pts);
  assert.ok(r, 'found');
  assert.ok(Math.abs(r.startT - startT) <= 16_000, `starts at the loop: ${(r.startT - startT) / 1000} s off`);
  assert.ok(Math.abs(r.endT - endT) <= 16_000, `ends at the loop's end: ${(r.endT - endT) / 1000} s off`);
  assert.ok(r.distanceM > 1900 && r.distanceM < 2600, `about the loop (and the wobble)'s length: ${r.distanceM}`);
  assert.ok(r.covered >= 0.9);
});

test('half the loop, or somewhere else, is no try; marked by hand, it is what was marked', () => {
  const half = []; let t = 0;
  for (let i = 0; i <= 200; i += 1) { t += 1500; const a = -Math.PI / 2 + (i / 400) * 2 * Math.PI; const [la, ln] = at(320 * Math.cos(a), 320 + 320 * Math.sin(a)); half.push([t, la, ln]); }
  assert.equal(findTry(loop, half), null);
  const away = half.map(([tt, la, ln]) => [tt, la + 0.02, ln]);
  assert.equal(findTry(loop, away), null);
  const m = markedTry(half, half[10][0], half[100][0]);
  assert.equal(m.timeS, Math.round((half[100][0] - half[10][0]) / 1000));
  assert.ok(m.byHand && m.distanceM > 0);
  assert.ok(densify(loop).length > 70, 'every 25 m');
});
