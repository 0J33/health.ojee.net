/* The MCP tools for training (server/mcp.js, runanalysis.js): lean answers, filters by date and
   type, local dates, and a run read closely on the server. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { analyse, isoWeek, localIso } from '../server/runanalysis.js';

let r; let p; let key;
before(async () => {
  r = await rig();
  p = await r.person('mcprunner', { persona: 'fitbit' });
  key = (await p.c.post('/api/keys', { label: 'AI', scope: 'read' })).json.key;
});
after(async () => { await r.close(); });
const call = async (name, args = {}) => {
  const res = await r.client().call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${key}` }, origin: null });
  assert.equal(res.status, 200, res.text);
  const out = res.json.result;
  assert.equal(out.isError, false, out.content?.[0]?.text);
  return JSON.parse(out.content[0].text);
};

/* A 40-minute run, a fix a second along a straight line: 10 km/h with a 2-minute stop in the
   middle and a 1-minute walk, heart rate climbing slowly (drift). */
function run(t0) {
  const pts = []; let lat = 49.2; let t = t0;
  for (let s = 0; s < 40 * 60; s += 1) {
    const kmh = s >= 1200 && s < 1320 ? 0 : s >= 1800 && s < 1860 ? 5 : 10;
    lat += (kmh / 3.6) / 111_320;
    pts.push([t, Math.round(lat * 1e6) / 1e6, -122.9, 5, 5, Math.round(140 + (s / 2400) * 12), null]);
    t += 1000;
  }
  return pts;
}

test('get_workout: an analysis of the run, the bulk left out unless asked, local times', async () => {
  const t0 = Date.parse('2026-11-12T03:30:00Z');   // evening of the 11th in Vancouver, the 12th in UTC
  await r.app.worlds.hold(p.id, async (w) => {
    w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/mrun', date: '2026-11-12', startMs: t0, endMs: t0 + 40 * 60_000, type: 'RUNNING', name: 'Run', distanceM: 6200, activeSec: 2280, avgHr: 146, hasGps: true });
    w.db.setMeta('route:g-mrun', { v: 2, points: run(t0) });
  });
  const tzr = await p.c.patch('/api/profile', { tz: 'America/Vancouver' }); assert.equal(tzr.status, 200, tzr.text);
  const w = await call('get_workout', { id: 'g-mrun', hr_band: [140, 146] });
  assert.ok(w.analysis, JSON.stringify(Object.keys(w)));
  const a = w.analysis;
  assert.equal(a.sport, 'run');
  assert.ok(a.movingS < a.elapsedS, 'moving time leaves the stop out');
  assert.ok(a.stops.count >= 1, 'the stop');
  assert.ok(a.walkBreaks.count >= 1, 'the walk');
  assert.ok(a.longestRunning.forS >= 15 * 60, `the longest stretch run ${JSON.stringify([a.longestRunning, a.walkBreaks])}`);
  // One moving time: the stops make up elapsed less moving, the splits add up to it.
  assert.equal(a.stops.totalS, a.elapsedS - a.movingS);
  assert.equal(a.stops.listedS + a.stops.shortS, a.stops.totalS);
  // The zones keep the bounds they were first measured with.
  const again = await call('get_workout', { id: 'g-mrun' });
  assert.deepEqual(again.zones?.bounds, w.zones?.bounds);
  assert.equal(again.zones?.boundsSetAt, w.zones?.boundsSetAt);
  assert.ok(a.cardiacDriftPct > 0, `drift ${a.cardiacDriftPct}`);
  assert.ok(a.metresPerBeat > 0);
  assert.ok(a.inHrBand.paceSPerKm > 300 && a.inHrBand.paceSPerKm < 400, JSON.stringify(a.inHrBand));
  assert.equal(a.inHrBand.excludesWalking, true);
  assert.equal(typeof w.track.series, 'undefined', 'series only when asked');
  assert.equal(typeof w.trace === 'object' && Array.isArray(w.trace), false, 'trace only when asked');
  assert.match(w.startLocal, /^2026-11-11T19:30:00-08:00$/);
  assert.equal(w.localDate, '2026-11-11');
  const full = await call('get_workout', { id: 'g-mrun', include: ['series', 'route'] });
  assert.ok(Array.isArray(full.track.series) && full.track.series.length > 100);
  assert.ok(Array.isArray(full.track.line));

  // list_workouts: by type and by local dates, with seconds and local dates.
  const l = await call('list_workouts', { type: 'run', from: '2026-11-11', to: '2026-11-11' });
  assert.deepEqual(l.history.map((x) => x.id), ['g-mrun']);
  assert.equal(l.history[0].durationS, 2400);
  // The list's pace is the analysis's: the same moving time and distance.
  assert.equal(l.history[0].paceFrom, 'track');
  assert.equal(l.history[0].movingS, a.movingS);
  assert.equal(l.history[0].paceSPerKm, a.paceSPerKm);
  assert.equal(l.history[0].avgHr, a.avgHr, 'one average heart rate');
  assert.equal(a.hrSources.avgFrom, 'watch');
  assert.equal(typeof l.strength, 'string', 'strength summary only when asked');
  assert.equal((await call('list_workouts', { type: 'run', from: '2026-11-12', to: '2026-11-12' })).history.length, 0, 'the 12th in Vancouver has none');
  assert.ok((await call('list_workouts', { type: 'RUNNING', limit: 5 })).history.every((x) => x.type === 'RUNNING'));

  const tr = await call('get_run_trends', { from: '2026-11-01', to: '2026-11-14', hr_band: [140, 146] });
  const mine = tr.runs.find((x) => x.id === 'g-mrun');
  assert.ok(mine && mine.week === '2026-W46', JSON.stringify(tr.runs.map((x) => [x.id, x.week])));
  const wk = tr.weeks.find((k) => k.week === '2026-W46');
  assert.ok(wk.inHrBand.paceSPerKm > 0);
  // A week of one run says what the run says.
  const only = tr.runs.filter((x) => x.week === '2026-W46' && !x.flags.length);
  if (only.length === 1) { assert.equal(wk.inHrBand.paceSPerKm, only[0].inHrBand.paceSPerKm); assert.equal(wk.paceSPerKm, only[0].paceSPerKm); }
});

test('flags: no distance, impossible pace, GPS jumps', () => {
  assert.deepEqual(analyse({ type: 'RUNNING', start: 0, end: 125 * 60_000, distanceM: null }).flags, ['no_distance']);
  assert.ok(analyse({ type: 'RUNNING', start: 0, end: 10 * 60_000, distanceM: 9000 }).flags.includes('impossible_pace'));
  const series = Array.from({ length: 30 }, (_, i) => [i * 50 + (i >= 10 ? 400 : 0), 5, 10, i * 18, 150]);   // 400 m in 18 s at the 10th
  // One short jump: counted and kept out of best efforts, but the run still counts.
  const one = analyse({ type: 'RUNNING', start: 0, end: 540_000, distanceM: 1500, track: { type: 'RUNNING', distanceM: 1500, movingS: 540, elapsedS: 540, t0: 0, series, splits: [], efforts: [{ distanceM: 400, label: '400 m', timeS: 30, at: 150_000 }, { distanceM: 1000, label: '1K', timeS: 340, at: 200_000 }] } });
  assert.equal(one.gpsSpikes, 1);
  assert.deepEqual(one.flags, []);
  // The 400 m across the jump (30 s) is looked for again away from it: the steady 50 m in 18 s.
  assert.deepEqual(one.bestEfforts.map((e) => e.label), ['400 m', '1K']);
  assert.equal(one.bestEfforts[0].timeS, 144, 'the 400 m away from the jump, not the 30 s across it');
  // Jumps all along: the data is not to be trusted.
  const many = Array.from({ length: 30 }, (_, i) => [i * 50 + Math.floor(i / 2) * 400, 5, 10, i * 18, 150]);
  assert.ok(analyse({ type: 'RUNNING', start: 0, end: 540_000, distanceM: 7000, track: { type: 'RUNNING', distanceM: 7000, movingS: 540, elapsedS: 540, t0: 0, series: many, splits: [] } }).flags.includes('gps_spikes'));
  assert.equal(isoWeek(Date.parse('2027-01-03T12:00:00Z'), 'UTC'), '2026-W53');
  assert.equal(localIso(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London'), '2026-07-01T13:00:00+01:00');
});

/* A 50-minute run at 9 km/h by the clock, one fix a second, with: a 7-minute walk at 5 km/h
   (100 steps a minute), an uphill jog at 7.2 km/h (160 steps a minute), a 2-minute gap in the GPS. */
function sample({ uneven = false } = {}) {
  const t0 = 1_800_000_000_000;
  const pts = []; const trace = []; let lat = 49.2;
  const kmhAt = (s) => (s >= 1200 && s < 1620 ? 5 : s >= 2400 && s < 2520 ? 7.2 : uneven && s >= 1500 ? 11.5 : 9);
  for (let s = 0; s < 3000; s += 1) {
    lat += (kmhAt(s) / 3.6) / 111_320;
    if (s >= 2700 && s < 2820) continue;   // no fixes for two minutes
    pts.push([t0 + s * 1000, Math.round(lat * 1e7) / 1e7, -122.9, 5, 5, 145, null]);
  }
  for (let m = 0; m < 50; m += 1) trace.push([t0 + m * 60_000, 145, m >= 20 && m < 27 ? 100 : 162]);
  return { t0, pts, trace };
}

test('walk breaks by cadence: the walk counts, an uphill jog and a gap in the GPS do not', async () => {
  const { trackStats } = await import('../server/tracks.js');
  const { t0, pts, trace } = sample();
  const track = trackStats({ type: 'RUNNING', points: pts, pauses: [], start: t0, end: t0 + 3000_000 });
  const a = analyse({ type: 'RUNNING', start: t0, end: t0 + 3000_000, avgHr: 145, track, trace });
  assert.equal(a.walkBreaks.count, 1, JSON.stringify(a.walkBreaks));
  assert.ok(Math.abs(a.walkBreaks.list[0].atS - 1200) <= 30 && a.walkBreaks.list[0].forS >= 360, JSON.stringify(a.walkBreaks.list));
  assert.equal(a.walkBreaks.by, 'speed and cadence');
  assert.equal(a.stops.totalS, a.elapsedS - a.movingS);
  assert.ok(Number.isFinite(a.cardiacDriftPct), 'an even run has its drift');
  // But a 7-minute walk in it makes the drift a weak reading, and says why.
  assert.equal(a.driftHalves.confidence, 'low', JSON.stringify(a.driftHalves));
  assert.ok(a.notes.includes('drift_low_confidence'));
});

test('cardiac drift: none for an uneven effort, with the reason', async () => {
  const { trackStats } = await import('../server/tracks.js');
  const { t0, pts, trace } = sample({ uneven: true });
  const track = trackStats({ type: 'RUNNING', points: pts, pauses: [], start: t0, end: t0 + 3000_000 });
  const a = analyse({ type: 'RUNNING', start: t0, end: t0 + 3000_000, avgHr: 145, track, trace });
  assert.equal(a.cardiacDriftPct, null);
  assert.ok(a.notes.includes('uneven_effort'), JSON.stringify(a.driftHalves));
});

test('Strava: through a key the watch\'s own copy of a run shows, nothing of Strava\'s', async () => {
  const q = await r.person('stravarunner', { persona: 'fitbit' });
  const qkey = (await q.c.post('/api/keys', { label: 'AI', scope: 'read' })).json.key;
  const t0 = Date.parse('2026-11-05T07:00:00Z');
  const G = 'users/me/dataTypes/exercise/dataPoints/srun';
  await r.app.worlds.hold(q.id, async (w) => {
    w.db.upsertExercise({ id: G, date: '2026-11-05', startMs: t0, endMs: t0 + 40 * 60_000, type: 'RUNNING', name: 'Run', distanceM: 6200, activeSec: 2280, avgHr: 146, hasGps: true });
    w.db.setMeta('route:g-srun', { v: 2, points: run(t0) });
    // Strava's copy of the same run, brought in by its history import, naming the watch's session.
    w.db.workoutAdd({ status: 'done', source: 'strava', start: t0, end: t0 + 40 * 60_000, created: t0, updated: t0, confirmedAt: t0, type: 'RUNNING', title: 'Morning Run', prompts: {},
      google: { state: 'foreign', name: G }, strava: { id: '77', name: 'Morning Run', distanceM: 6300, movingS: 2200, polyline: null } });
    // And one only Strava has.
    w.db.workoutAdd({ status: 'done', source: 'strava', start: t0 + 86_400_000, end: t0 + 86_400_000 + 1800_000, created: t0, updated: t0, confirmedAt: t0, type: 'RUNNING', title: 'Lunch Run', prompts: {}, strava: { id: '78', name: 'Lunch Run', distanceM: 5000, polyline: null } });
  });
  const kc = async (name, args) => {
    const res = await r.client().call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${qkey}` }, origin: null });
    return res.json.result;
  };
  const l = JSON.parse((await kc('list_workouts', { type: 'run', from: '2026-11-01', to: '2026-11-10' })).content[0].text);
  assert.ok(l.history.some((x) => x.id === 'g-srun' && x.source === 'google'), JSON.stringify(l.history.map((x) => x.id)));
  assert.ok(l.history.every((x) => x.source !== 'strava'));
  assert.ok(!JSON.stringify(l).includes('Morning Run') && !JSON.stringify(l).includes('Lunch Run'), 'nothing of Strava\'s');
  const d = JSON.parse((await kc('get_workout', { id: 'g-srun' })).content[0].text);
  assert.equal(d.source, 'google');
  assert.ok(d.analysis?.movingS > 0 && d.track, 'the watch\'s route and its analysis');
  assert.ok(!JSON.stringify(d).includes('Morning Run'));
  // Best times: the watch's copy (its g- id), never a Strava-only run or a Strava id.
  const bt = JSON.parse((await kc('get_best_times', {})).content[0].text);
  const ids = bt.sports.flatMap((x) => x.distances.flatMap((d) => d.efforts.map((e) => e.id)));
  assert.ok(ids.includes('g-srun'), JSON.stringify(ids));
  const sid = (await r.app.worlds.hold(q.id, async (w) => w.db.workoutsDoneFrom(0).filter((x) => x.source === 'strava').map((x) => String(x.id))));
  assert.ok(ids.every((id) => !sid.includes(id)), 'no Strava ids');
  // Strava's status stays on the site; the export comes without Strava's.
  assert.equal((await r.client().call('GET', '/api/strava', { headers: { authorization: `Bearer ${qkey}` }, origin: null })).status, 403);
  const ex = await r.client().call('GET', '/api/export', { headers: { authorization: `Bearer ${qkey}` }, origin: null });
  assert.equal(ex.status, 200);
  assert.ok(ex.json.workouts.every((x) => x.source !== 'strava') && !JSON.stringify(ex.json.workouts).includes('Lunch Run'));
  // The person's own screens still have Strava's.
  const own = await q.c.get('/api/workouts');
  assert.ok(own.json.history.some((x) => x.source === 'strava'));
  const ownBt = await q.c.get('/api/best-times');
  assert.ok(ownBt.json.sports.flatMap((x) => x.distances.flatMap((d) => d.efforts.map((e) => e.id))).some((id) => sid.includes(id)), 'the owner sees Strava\'s');
});
