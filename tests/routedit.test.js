/* Drawing a route in pieces (web/js/routedit.js): points put in the middle,
   taken out joined over or cut out leaving gaps, gaps joined, a picked
   group moved, and only one piece saves. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RE from '../web/js/routedit.js';

const P = (n) => Array.from({ length: n }, (_, i) => [30 + i / 1000, 31]);

test('a point in the middle of a stretch, and after a picked one', () => {
  let st = RE.fromLine(P(4));
  let r = RE.insertAt(st, 0, 2, [9, 9]);
  assert.deepEqual(r.st.segs[0][2], [9, 9]);
  assert.deepEqual(r.sel, ['0:2']);
  assert.equal(r.st.segs[0].length, 5);
  r = RE.insertAfter(r.st, '0:0', [8, 8]);
  assert.deepEqual(r.st.segs[0].slice(0, 3).map((p) => p[0]), [30, 8, 30.001]);
  // A loop's last stretch goes back to the first point: a point there goes at the end.
  st = RE.fromLine(P(4), true);
  assert.equal(RE.edgesOf(st).length, 4);
  r = RE.insertAt(st, 0, 4, [7, 7]);
  assert.deepEqual(r.st.segs[0][4], [7, 7]);
  assert.ok(r.st.loop);
});

test('take out joins over; cut out leaves pieces that do not save until joined', () => {
  const st = RE.fromLine(P(8));
  const t = RE.takeOut(st, ['0:3', '0:4']);
  assert.equal(t.st.segs.length, 1);
  assert.equal(t.st.segs[0].length, 6);
  assert.ok(RE.check(t.st).ok);

  const c = RE.cutOut(st, ['0:3', '0:4']);
  assert.equal(c.st.segs.length, 2);
  assert.deepEqual(c.st.segs.map((g) => g.length), [3, 3]);
  assert.equal(RE.check(c.st).ok, false);
  assert.match(RE.check(c.st).why, /2 pieces/);
  assert.equal(RE.lineOf(c.st), null);
  assert.equal(RE.gapsOf(c.st).length, 1);
  // Cutting the ends only shortens it.
  assert.equal(RE.cutOut(st, ['0:0', '0:7']).st.segs.length, 1);

  // Joined straight across: one piece, the same points.
  const j = RE.join(c.st, 0);
  assert.equal(j.st.segs.length, 1);
  assert.equal(j.st.segs[0].length, 6);
  assert.ok(RE.check(j.st).ok);
  // Joined through a point put down in the gap.
  const jp = RE.join(c.st, 0, [5, 5]);
  assert.deepEqual(jp.st.segs[0][3], [5, 5]);
  assert.deepEqual(jp.sel, ['0:3']);
  assert.equal(RE.lineOf(jp.st).length, 7);

  // Three pieces, a whole piece taken out: two left, still a gap.
  const three = RE.cutOut(st, ['0:2', '0:5']);
  assert.deepEqual(three.st.segs.map((g) => g.length), [2, 2, 2]);
  const two = RE.takeOut(three.st, ['1:0', '1:1']);
  assert.equal(two.st.segs.length, 2);
  // Taking out a piece at an end makes it one again.
  assert.ok(RE.check(RE.takeOut(two.st, ['1:0', '1:1']).st).ok);
});

test('a loop cut is opened where it was cut; cut twice, it is in two pieces', () => {
  const st = RE.fromLine(P(6), true);
  const c = RE.cutOut(st, ['0:2']);
  assert.equal(c.st.loop, false);
  assert.equal(c.st.segs.length, 1);
  // Starts just after the cut, goes round, finishes just before it.
  assert.deepEqual(c.st.segs[0].map((p) => Math.round((p[0] - 30) * 1000)), [3, 4, 5, 0, 1]);
  assert.ok(RE.check(c.st).ok);
  const c2 = RE.cutOut(st, ['0:1', '0:4']);
  assert.deepEqual(c2.st.segs.map((g) => g.map((p) => Math.round((p[0] - 30) * 1000))), [[2, 3], [5, 0]]);
  // Taken out of a loop: still a loop, smaller.
  const t = RE.takeOut(st, ['0:1']);
  assert.ok(t.st.loop);
  assert.equal(RE.lineOf(t.st).length, 6);
  assert.equal(RE.takeOut(st, ['0:1', '0:2', '0:3', '0:4']).st.loop, false, 'under three points: a line');
});

test('a picked group moved together; reverse keeps the picks on their points', () => {
  const st = RE.fromLine(P(4));
  const m = RE.moveBy(st, ['0:1', '0:2'], 0.01, -0.02);
  assert.deepEqual(m.segs[0][1], [30.011, 30.98]);
  assert.deepEqual(m.segs[0][2], [30.012, 30.98]);
  assert.deepEqual(m.segs[0][0], [30, 31], 'others stay');
  const pieces = RE.cutOut(st, ['0:1']).st;   // [0], [2, 3]
  const r = RE.reverse(pieces, ['1:1']);
  assert.deepEqual(r.st.segs.map((g) => g.map((p) => Math.round((p[0] - 30) * 1000))), [[3, 2], [0]]);
  assert.deepEqual(r.sel, ['0:0'], 'the point picked, where it is now');
  const lr = RE.reverse(RE.fromLine(P(4), true), ['0:1']);
  assert.deepEqual(lr.st.segs[0].map((p) => Math.round((p[0] - 30) * 1000)), [0, 3, 2, 1]);
  assert.deepEqual(lr.sel, ['0:3']);
});

test('a loop needs one piece; names say where a point is', () => {
  const pieces = RE.cutOut(RE.fromLine(P(6)), ['0:2']).st;
  assert.equal(RE.setLoop(pieces, true).loop, false);
  assert.ok(RE.setLoop(RE.fromLine(P(4)), true).loop);
  assert.equal(RE.nameOf(pieces, '0:0'), 'Start · point 1 of 5');
  assert.equal(RE.nameOf(pieces, '0:1'), 'End of piece 1 · point 2 of 5');
  assert.equal(RE.nameOf(pieces, '1:0'), 'Start of piece 2 · point 3 of 5');
  assert.equal(RE.nameOf(pieces, '1:2'), 'Finish · point 5 of 5');
  assert.deepEqual(RE.append(RE.fromLine([]), [1, 2]).st.segs, [[[1, 2]]]);
  assert.equal(RE.check(RE.fromLine([[1, 2]])).ok, false);
  const s = RE.startAt(RE.fromLine(P(4), true), '0:2');
  assert.deepEqual(s.st.segs[0].map((p) => Math.round((p[0] - 30) * 1000)), [2, 3, 0, 1]);
});
