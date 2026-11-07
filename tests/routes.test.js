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

test('a saved route is edited: its kind, and its points (moved, cut short, turned round) measured again', async () => {
  const a = await r.person('editor', { privacy: { account: 'public' } });
  const route = (await a.c.post('/api/routes', { title: 'Square', sport: 'run', line: loop })).json;
  const half = loop.slice(0, 3);
  const e = (await a.c.patch(`/api/routes/${route.id}`, { sport: 'walk', line: [...half].reverse() })).json;
  assert.equal(e.sport, 'walk');
  assert.equal(e.line.length, 3);
  assert.deepEqual(e.start, half.at(-1), 'turned round: it starts where it ended');
  assert.ok(e.distanceM > 1600 && e.distanceM < 1900, String(e.distanceM));
  assert.equal((await a.c.patch(`/api/routes/${route.id}`, { line: [[30.0444, 31.2357], [30.0444, 31.2358]] })).status, 400, 'too short');
  assert.equal((await a.c.patch(`/api/routes/${route.id}`, { line: [[1, 2]] })).status, 400, 'one point');
  assert.equal((await a.c.get(`/api/routes/${route.id}`)).json.line.length, 3, 'a refused edit changes nothing');
});

test('a route is copied: yours ("Copy of"), or one shared with you (its name), private either way', async () => {
  const a = await r.person('copier', { privacy: { account: 'public' } });
  const b = await r.person('borrower', { privacy: { account: 'public' } });
  const route = (await a.c.post('/api/routes', { title: 'River loop', sport: 'walk', line: loop, public: true })).json;
  const mine = await a.c.post(`/api/routes/${route.id}/copy`);
  assert.equal(mine.status, 201);
  assert.notEqual(mine.json.id, route.id);
  assert.equal(mine.json.title, 'Copy of River loop');
  assert.equal(mine.json.sport, 'walk');
  assert.equal(mine.json.public, false);
  assert.equal(mine.json.distanceM, route.distanceM);
  const theirs = (await b.c.post(`/api/routes/${route.id}/copy`)).json;
  assert.equal(theirs.title, 'River loop');
  assert.equal(theirs.mine, true);
  // A private one of somebody else's: as if there were none.
  await a.c.patch(`/api/routes/${route.id}`, { public: false });
  assert.equal((await b.c.post(`/api/routes/${route.id}/copy`)).status, 404);
});

test('there and back: twice the distance, the GPX out and back, and only a go both ways counts', async () => {
  const { outAndBack } = await import('../server/routelib.js');
  const { findTry } = await import('../server/routetry.js');
  const out = [[30.0444, 31.2357], [30.0444, 31.2457], [30.0514, 31.2457]];   // about 1.75 km, not a loop
  assert.deepEqual(outAndBack(out), [...out, out[1], out[0]]);
  const a = await r.person('outback');
  const one = (await a.c.post('/api/routes', { title: 'Corniche', line: out })).json;
  const both = (await a.c.post('/api/routes', { title: 'Corniche both', line: out, bothWays: true })).json;
  assert.equal(both.bothWays, true);
  assert.equal(one.bothWays, false);
  assert.ok(Math.abs(both.distanceM - 2 * one.distanceM) <= 1, `${both.distanceM} vs ${one.distanceM}`);
  assert.equal(both.line.length, 3, 'the line is the way out');
  const gpx = (await a.c.get(`/api/routes/${both.id}/route.gpx`)).text;
  assert.equal((gpx.match(/<trkpt/g) || []).length, 5, 'the GPX goes back to the start');
  // Switched off and on again: measured again each time.
  const off = (await a.c.patch(`/api/routes/${both.id}`, { bothWays: false })).json;
  assert.deepEqual([off.bothWays, off.distanceM], [false, one.distanceM]);
  const on = (await a.c.patch(`/api/routes/${both.id}`, { bothWays: true })).json;
  assert.equal(on.distanceM, both.distanceM);
  assert.equal((await a.c.patch(`/api/routes/${both.id}`, { bothWays: 'yes' })).status, 400);
  // A copy keeps it.
  assert.equal((await a.c.post(`/api/routes/${both.id}/copy`)).json.bothWays, true);
  // A go: out only matches the one-way route, out and back matches both.
  const track = (line) => { const pts = []; let t = 0; for (let i = 1; i < line.length; i += 1) for (let s = 0; s < 40; s += 1) { const f = s / 40; pts.push([t += 5000, line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f]); } pts.push([t + 5000, ...line.at(-1)]); return pts; };
  assert.ok(findTry(out, track(out)), 'one way, gone one way');
  assert.equal(findTry(outAndBack(out), track(out)), null, 'there and back, gone one way: no');
  const go = findTry(outAndBack(out), track(outAndBack(out)));
  assert.ok(go && Math.abs(go.distanceM - both.distanceM) < 60, JSON.stringify(go));
});
