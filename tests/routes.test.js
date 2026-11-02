/* Routes (server/routelib.js): drawn or saved from a workout; private
   until shared; public ones seen by anybody signed in, nearest first,
   and never from a private account. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { toGpx } from '../server/tracks.js';
import { trimEnds, lineStats, cleanLine } from '../server/routelib.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

// A loop in Cairo, about 3.5 km.
const loop = [[30.0444, 31.2357], [30.0444, 31.2457], [30.0514, 31.2457], [30.0514, 31.2357], [30.0444, 31.2357]];

test('pure: a line is cleaned, measured and its ends trimmed', () => {
  assert.throws(() => cleanLine([[1, 2]]), /two points/);
  const st = lineStats(cleanLine(loop));
  assert.ok(st.distanceM > 3300 && st.distanceM < 3700, String(st.distanceM));
  assert.equal(st.climbM, null);
  assert.equal(lineStats([[30, 31, 10], [30.001, 31, 15], [30.002, 31, 13], [30.003, 31, 20]]).climbM, 12, '5 up, a 2 m dip, 7 up');
  const long = Array.from({ length: 101 }, (_, i) => [30 + i * 0.0001, 31]);   // about 1.1 km north
  const t = trimEnds(long);
  assert.ok(t[0][0] > 30.0015 && t.at(-1)[0] < 30.0085, 'about 165 m off each end (15% of a short route)');
});

test('drawn, private, then public: the maker and everyone else', async () => {
  const a = await r.person('maker', { privacy: { account: 'public' } });
  const b = await r.person('walker', { privacy: { account: 'public' } });
  const made = await a.c.post('/api/routes', { title: '  Nile loop ', sport: 'run', line: loop });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const route = made.json;
  assert.deepEqual([route.title, route.sport, route.public, route.mine, route.source], ['Nile loop', 'run', false, true, 'drawn']);
  assert.equal((await b.c.get(`/api/routes/${route.id}`)).status, 404, 'private: not seen by anybody else');
  assert.deepEqual((await b.c.get('/api/routes?scope=public')).json.routes.map((x) => x.id).filter((id) => id === route.id), []);
  const pub = await a.c.patch(`/api/routes/${route.id}`, { public: true });
  assert.equal(pub.json.public, true);
  const seen = (await b.c.get(`/api/routes?scope=public&near=30.05,31.24`)).json;
  const hit = seen.routes.find((x) => x.id === route.id);
  assert.ok(hit && hit.by.username === 'maker' && hit.mine === false && hit.awayM < 2000, JSON.stringify(hit));
  assert.ok(hit.line.length >= 2 && hit.line.length <= 80, 'a light line for the list');
  assert.equal((await b.c.get(`/api/routes/${route.id}`)).json.line.length, 5);
  const gpx = await b.c.get(`/api/routes/${route.id}/route.gpx`);
  assert.match(gpx.headers.get('content-disposition'), /Nile-loop\.gpx/);
  assert.match(gpx.text, /<trkpt lat="30\.0444" lon="31\.2357">/);
  // Only the maker changes or deletes it.
  assert.equal((await b.c.patch(`/api/routes/${route.id}`, { title: 'Mine now' })).status, 404);
  assert.equal((await b.c.del(`/api/routes/${route.id}`)).status, 404);
  // A private account: its public routes are seen by nobody else.
  await a.c.patch('/api/settings', { privacy: { account: 'private' } });
  assert.equal((await b.c.get(`/api/routes/${route.id}`)).status, 404);
  assert.ok(!(await b.c.get('/api/routes?scope=public')).json.routes.some((x) => x.id === route.id));
  assert.equal((await a.c.get(`/api/routes/${route.id}`)).status, 200, 'its maker still sees it');
  assert.equal((await a.c.del(`/api/routes/${route.id}`)).status, 200);
  assert.equal((await a.c.get(`/api/routes/${route.id}`)).status, 404);
  for (const badBody of [{ title: '', line: loop }, { title: 'x', line: [[1, 2]] }, { title: 'x'.repeat(81), line: loop }]) assert.equal((await a.c.post('/api/routes', badBody)).status, 400, JSON.stringify(badBody).slice(0, 40));
});

test('saved from a recorded workout: the ends trimmed off by default', async () => {
  const p = await r.person('recorder');
  const t0 = Date.parse('2026-09-01T06:00:00Z');
  const points = Array.from({ length: 200 }, (_, i) => [t0 + i * 5000, 30.0444 + i * 0.00012, 31.2357, 20 + (i % 10), null]);
  const imp = await p.c.call('POST', '/api/workouts/import/gpx', { raw: toGpx({ title: 'Morning run', type: 'RUNNING', points }), headers: { 'content-type': 'application/gpx+xml' } });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  const full = await p.c.post('/api/routes', { workoutId: imp.json.id, title: 'Corniche', trim: false });
  const cut = await p.c.post('/api/routes', { workoutId: imp.json.id, title: 'Corniche, trimmed' });
  assert.deepEqual([full.status, cut.status], [201, 201]);
  assert.equal(full.json.source, 'workout');
  assert.ok(cut.json.distanceM < full.json.distanceM - 300, `${cut.json.distanceM} vs ${full.json.distanceM}`);
  assert.ok(full.json.climbM >= 0);
  assert.equal((await p.c.post('/api/routes', { workoutId: 'nope', title: 'x' })).status, 404);
  assert.equal((await p.c.get('/api/routes')).json.routes.length, 2);
});
