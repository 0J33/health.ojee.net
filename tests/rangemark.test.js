// The dot of a range bar (web/js/rangemark.js) against every range the server gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markAt } from '../web/js/rangemark.js';
import { rangeFor, RANGED } from '../server/core/ranges.js';

const person = { sex: 'male', age: 30, heightCm: 178, weightKg: 75 };
const baseline = Array.from({ length: 30 }, (_, i) => 50 + (i % 7) * 3);

test('136 cardio minutes of a week sit near the end of "Under guideline", not at its start', () => {
  const r = rangeFor('cardio_week', 136, person);
  const x = markAt(r.bands.map((b) => ({ lo: b.from, hi: b.to })), r.at, 136);
  assert.ok(x > 28 && x < 33.4, String(x));
});

test('every range: the dot is inside the segment of its band, and moves with the value', () => {
  for (const id of [...RANGED, 'deep', 'rem', 'whr']) {
    const probe = rangeFor(id, 1, person, { baseline }) || rangeFor(id, 50, person, { baseline });
    if (!probe) continue;
    const cuts = probe.bands.flatMap((b) => [b.from, b.to]).filter(Number.isFinite);
    const lo = Math.min(...cuts); const hi = Math.max(...cuts); const span = (hi - lo) || Math.abs(hi) || 1;
    let last = -Infinity;
    for (let k = 0; k <= 200; k += 1) {
      const v = lo - span * 0.5 + (span * 2 * k) / 200;
      const r = rangeFor(id, v, person, { baseline });
      if (!r || r.at < 0) continue;
      const n = r.bands.length;
      const x = markAt(r.bands.map((b) => ({ lo: b.from, hi: b.to })), r.at, v);
      assert.ok(x >= (r.at / n) * 100 && x <= ((r.at + 1) / n) * 100, `${id} ${v}: ${x} outside band ${r.at} of ${n}`);
      assert.ok(x >= last - 1e-9, `${id} ${v}: ${x} went back from ${last}`);
      last = x;
    }
  }
});
