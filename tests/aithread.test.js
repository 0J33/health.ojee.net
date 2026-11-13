/* The AI conversation kept on the server (server/aithread.js): one at a time and in order,
   stop and clear, what each answer read, the night read rightly, and the person's own AI. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { briefing } from '../server/ai.js';
import { OwnWriter, checkOwnAi } from '../server/ownai.js';
import { parseReply } from '../server/ai.js';
import { openDb } from '../server/core/db.js';

let r; let p;
const ALL = { activity: true, sleep: true, heart: true, body: true, workouts: true, logged: true, notes: true };
before(async () => { r = await rig(); p = await personWith(r, 'threader'); await p.c.patch('/api/consent', { ai: { allow: ALL } }); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text.slice(0, 300)); return res.json; };
const thread = async () => ok(await p.c.get('/api/ai/thread'));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((res) => setTimeout(res, 40)); }
}

test('one at a time, in order; kept on the server with what each read; stop and clear', async () => {
  r.opencode.state.hold = true;
  const a = await ok(await p.c.post('/api/ai', { topic: 'sleep', title: 'Last night' }));
  const b = await ok(await p.c.post('/api/ai', { topic: 'ask', question: 'Should I train today?' }));
  assert.equal(a.turn.kind, 'section');
  assert.equal(b.turn.kind, 'question');
  await until(async () => (await thread()).turns.find((t) => t.id === a.id)?.state === 'asking');
  let th = await thread();
  assert.equal(th.running, true);
  assert.deepEqual(th.turns.map((t) => t.state), ['asking', 'queued'], 'the second waits for the first');
  assert.ok(th.turns[0].seen.some((s) => /Last night/.test(s)) && th.turns[0].seen.some((s) => /workouts/.test(s)), JSON.stringify(th.turns[0].seen));
  // Stop: the running one and the one waiting.
  th = await ok(await p.c.post('/api/ai/stop', { all: true }));
  await until(async () => (await thread()).turns.every((t) => t.state === 'stopped'));
  r.opencode.state.hold = false;
  // Try again: the same turn, in place, answered; no new message.
  const again = await ok(await p.c.post(`/api/ai/retry/${a.id}`, {}));
  assert.equal(again.turn?.id || again.id, a.id);
  await until(async () => (await thread()).turns.find((t) => t.id === a.id)?.state === 'done');
  th = await thread();
  assert.equal(th.turns.length, 2, 'retried in place');
  assert.equal(th.turns[0].id, a.id);
  assert.equal(th.turns[0].answer.headline, 'You slept well last night');
  assert.ok(th.turns[0].model);
  // Clear.
  await ok(await p.c.del('/api/ai/thread'));
  assert.deepEqual((await thread()).turns, []);
});

test('the night, read rightly: still going on before waking; not synced; not recorded', () => {
  const db = openDb(':memory:');
  const tz = 'UTC';
  const world = (now, lastOk) => ({ tz, db, settings: () => ({}), sync: { state: { lastOk } }, now: () => now });
  // Two weeks of nights, 23:00 to 07:00, ending on the day.
  for (let i = 1; i <= 14; i += 1) {
    const end = Date.parse('2026-11-10T07:00:00Z') - (i - 1) * 86_400_000;
    db.upsertSleep({ id: `n${i}`, date: new Date(end).toISOString().slice(0, 10), startMs: end - 8 * 3_600_000, endMs: end, startOff: 0, endOff: 0, asleepMin: 450, awakeMin: 30, periodMin: 480, main: true, stages: [], summary: { stages: {} } });
  }
  const at2am = Date.parse('2026-11-11T02:00:00Z');
  const t1 = briefing(world(at2am, at2am - 600_000), { topic: 'sleep', now: at2am });
  assert.match(t1, /still going on/);
  assert.match(t1, /NOT missing/);
  const at11 = Date.parse('2026-11-11T11:00:00Z');
  assert.match(briefing(world(at11, at11 - 5 * 3_600_000), { topic: 'sleep', now: at11 }), /Not synced yet/);
  assert.match(briefing(world(at11, at11 - 600_000), { topic: 'sleep', now: at11 }), /stayed up all night/);
});

test('your own AI: a key checked with the provider\'s model list, answers in the same shape, its refusals in words', async () => {
  const calls = [];
  const fake = async (u, init = {}) => {
    calls.push({ url: String(u), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (String(u).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }] }), { status: 200 });
    if (String(u).endsWith('/messages')) return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"headline":"Rest today","summary":"Your HRV is under your usual.","points":["Keep it easy"],"followUps":["Why?"]}' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  await assert.rejects(checkOwnAi({ provider: 'anthropic', key: 'nope' }, { fetchImpl: fake }), /does not look like/);
  const cfg = await checkOwnAi({ provider: 'anthropic', key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }, { fetchImpl: fake });
  assert.equal(cfg.model, 'claude-haiku-5-5');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  await assert.rejects(checkOwnAi({ provider: 'anthropic', key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', model: 'gpt-9' }, { fetchImpl: fake }), /no model called "gpt-9"/);
  await assert.rejects(checkOwnAi({ provider: 'custom', key: 'secret-key-123', base: 'https://192.168.1.5/v1', model: 'x' }, { fetchImpl: fake }), /private network/);
  const w = new OwnWriter({ ...cfg, fetchImpl: fake });
  const out = await w.write('prompt', { parse: parseReply });
  assert.equal(out.summary.headline, 'Rest today');
  const refuse = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  await assert.rejects(new OwnWriter({ ...cfg, fetchImpl: refuse }).write('p', { parse: parseReply }), (e) => e.own && /did not accept your key/.test(e.message));
});

test('the analysis: an interval jog is seen as intervals; a late night is put ahead of training as the cause', async () => {
  const { workoutAnalysis, recoveryDrivers } = await import('../server/aianalysis.js');
  // 6 x (3 min at 10 km/h, 90 s at 5 km/h), HR 165 and 135.
  const series = []; let t = 0; let dist = 0;
  for (let k = 0; k < 6; k += 1) {
    for (let s = 0; s < 180; s += 15) { dist += 10 / 3.6 * 15; series.push([Math.round(dist), null, 10, t, 165]); t += 15; }
    for (let s = 0; s < 90; s += 15) { dist += 5 / 3.6 * 15; series.push([Math.round(dist), null, 5, t, 135]); t += 15; }
  }
  const start = Date.parse('2026-11-10T18:00:00Z');
  const d = { type: 'RUNNING', start, end: start + t * 1000, trace: [], track: { distanceM: dist, movingS: t, elapsedS: t, paceSPerKm: Math.round(t / (dist / 1000)), series, splits: [] } };
  const text = workoutAnalysis(d, [{ start: start - 86_400_000 * 3, minutes: 30, distanceM: 4000, avgHr: 150, paceSPerKm: 420 }]);
  assert.match(text, /INTERVALS: 6 faster bouts of about 3:\d\d at about 6:00\/km/);
  assert.match(text, /Their last 1 similar sessions/);
  // Recovery: bedtime 2 h late last night after a week at 23:00, and one hard session.
  const nights = [];
  for (let i = 1; i <= 14; i += 1) {
    const date = new Date(Date.parse('2026-11-11T00:00:00Z') - (i - 1) * 86_400_000).toISOString().slice(0, 10);
    const bed = i === 1 ? Date.parse(`${date}T01:00:00Z`) : Date.parse(`${date}T00:00:00Z`) - 3_600_000;
    nights.push({ main: true, date, startMs: bed, endMs: Date.parse(`${date}T07:00:00Z`), startOff: 0, endOff: 0, asleepMin: (Date.parse(`${date}T07:00:00Z`) - bed) / 60_000 - 20 });
  }
  const table = { '2026-11-11': { hrv: 33 } };
  for (let i = 1; i <= 20; i += 1) table[new Date(Date.parse('2026-11-11T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)] = { hrv: 37 };
  const dr = recoveryDrivers({ nights, table, today: '2026-11-11', sessions: [{ date: '2026-11-10', minutes: 60, avgHr: 160 }], restHr: 60 });
  const lines = dr.split('\n').filter((l) => l.startsWith('- '));
  assert.match(lines[0], /\[strong\] Bedtime last night was 120 min later than usual/);
  assert.ok(lines.some((l) => /Hard training/.test(l)));
  assert.match(dr, /HRV 33 ms vs usual 37/);
});

test('"analyze my latest run": the run itself goes to the model, with its analysis', async () => {
  const q = await personWith(r, 'runasker');
  await q.c.patch('/api/consent', { ai: { allow: ALL } });
  const t0 = Date.now() - 3 * 3_600_000;
  await r.app.worlds.hold(q.id, async (w) => { w.db.upsertExercise({ id: 'users/me/dataTypes/exercise/dataPoints/askrun', date: new Date(t0).toISOString().slice(0, 10), startMs: t0, endMs: t0 + 40 * 60_000, type: 'RUNNING', name: 'Run', avgHr: 158, distanceM: 6000 }); });
  const a = await ok(await q.c.post('/api/ai', { topic: 'ask', question: 'analyze my latest run' }));
  const t2 = await until(async () => { const x = (await ok(await q.c.get('/api/ai/thread'))).turns.find((y) => y.id === a.id); return x?.state === 'done' ? x : null; });
  const sent = r.opencode.state.prompts.at(-1);
  assert.match(sent, /## Detail of what was asked about/);
  assert.match(sent, /Structure: /);
  assert.ok(t2.seen.some((s) => /The workout you asked about/.test(s)), JSON.stringify(t2.seen));
  assert.match(sent, /Answer the thing asked about first/);
});
