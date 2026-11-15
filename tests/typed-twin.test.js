/* A workout typed in by hand and the watch's own guess at the same session (history.js typedTwin):
   one workout, not two, even when the typed times are a quarter of an hour off. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { unified } from '../server/history.js';

const G = (id) => `users/me/dataTypes/exercise/dataPoints/${id}`;
const at = (hm) => Date.parse(`2026-11-14T${hm}:00Z`);

test("a run logged by hand takes in the watch's own walk and run that overlap it", () => {
  const db = openDb(':memory:');
  // Logged at 22:38 as a 40-minute treadmill run, 21:28-22:08.
  db.workoutAdd({ status: 'done', source: 'logged', start: at('21:28'), end: at('22:08'), created: at('22:38'), updated: at('22:38'), confirmedAt: at('22:38'), type: 'TREADMILL', title: null, prompts: {}, distanceM: 3860 });
  // The watch noticed it by itself: a walk 21:45-22:05, then a run 22:05-22:26.
  db.upsertExercise({ id: G('w'), date: '2026-11-14', startMs: at('21:45') + 56_000, endMs: at('22:05') + 1000, type: 'WALKING', name: 'Walk', distanceM: 1578, method: 'PASSIVELY_MEASURED' });
  db.upsertExercise({ id: G('r'), date: '2026-11-14', startMs: at('22:05') + 1000, endMs: at('22:26') + 1000, type: 'RUNNING', name: 'Run', distanceM: 1603, method: 'PASSIVELY_MEASURED' });
  // A separate walk later that evening, and a run started on the watch that overlaps a little.
  db.upsertExercise({ id: G('later'), date: '2026-11-14', startMs: at('23:00'), endMs: at('23:30'), type: 'WALKING', name: 'Walk', distanceM: 2000, method: 'PASSIVELY_MEASURED' });
  const u = unified(db, at('20:00'));
  assert.deepEqual(u.map((s) => (s.local ? 'logged' : s.ex.id.split('/').pop())), ['logged', 'later']);
});

test('a session started on the watch, or another kind, is not taken in', () => {
  const db = openDb(':memory:');
  db.workoutAdd({ status: 'done', source: 'logged', start: at('21:28'), end: at('22:08'), created: at('22:38'), updated: at('22:38'), confirmedAt: at('22:38'), type: 'TREADMILL', title: null, prompts: {} });
  db.upsertExercise({ id: G('started'), date: '2026-11-14', startMs: at('22:05'), endMs: at('22:30'), type: 'RUNNING', name: 'Run', method: 'ACTIVELY_MEASURED' });
  db.upsertExercise({ id: G('ride'), date: '2026-11-14', startMs: at('21:20'), endMs: at('21:35'), type: 'BIKING', name: 'Ride', method: 'PASSIVELY_MEASURED' });
  const u = unified(db, at('20:00'));
  assert.deepEqual(u.map((s) => (s.local ? 'logged' : s.ex.id.split('/').pop())), ['ride', 'logged', 'started']);
});
