/* AI (server/ai.js): the briefing every request carries, a section's
   summary as a job the page follows, questions with the conversation,
   the morning summary once a day, and what happens when no model answers. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { parseReply, metricKind, metricDetail } from '../server/ai.js';
import { workoutAnalysis } from '../server/aianalysis.js';
import { OWN_AI, OwnWriter, checkOwnAi } from '../server/ownai.js';
import { GO_ZDR } from '../server/core/writer.js';

let r; let p;
const ALL = { activity: true, sleep: true, heart: true, body: true, workouts: true, logged: true, notes: true };
before(async () => {
  r = await rig(); p = await personWith(r, 'thinker');
  // Off until turned on: refused before.
  const no = await p.c.post('/api/ai', { topic: 'sleep' });
  assert.deepEqual([no.status, no.json.code], [409, 'ai_consent']);
  assert.equal((await p.c.get('/api/ai/morning')).json.due, false);
  await p.c.patch('/api/consent', { ai: { allow: ALL } });
});
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };
async function done(job) {
  let j = job;
  for (let i = 0; i < 100 && (j.state === 'reading' || j.state === 'asking'); i += 1) { await new Promise((res) => setTimeout(res, 30)); j = await ok(await p.c.get(`/api/ai/${j.id}`)); }
  return j;
}

test('a section\'s summary: a job that ends with the answer; the model saw a dated briefing of everything', async () => {
  const job = await ok(await p.c.post('/api/ai', { topic: 'sleep' }));
  assert.match(job.id, /^ai/);
  assert.ok(['reading', 'asking'].includes(job.state));
  const j = await done(job);
  assert.equal(j.state, 'done');
  assert.equal(j.answer.headline, 'You slept well last night');
  assert.equal(j.answer.followUps.length, 2);
  const sent = r.opencode.state.prompts.at(-1);
  for (const part of ['## Now', '## Today so far', '## The last 14 days, day by day', '## Averages and trends', '## Recent workouts', 'Answer with JSON only', 'Their sleep', 'Their usual: asleep around']) assert.ok(sent.includes(part), part);
  assert.match(sent, /## (Last night|Sleep: the night ending)/);
  assert.match(sent, /\d{4}-\d{2}-\d{2}/, 'every number has its day');
  // Asked again: from the cache, at once.
  const again = await done(await ok(await p.c.post('/api/ai', { topic: 'sleep' })));
  assert.equal(again.cached, true);
  assert.equal(r.opencode.state.prompts.at(-1), sent, 'no second call');
});

test('a question with the conversation so far; a workout\'s detail goes in', async () => {
  const j = await done(await ok(await p.c.post('/api/ai', { topic: 'ask', question: 'How was my week?' })));
  assert.equal(j.state, 'done');
  const sent = r.opencode.state.prompts.at(-1);
  assert.match(sent, /The person asks: "How was my week\?"/);
  // The conversation so far comes from the thread kept on the server (aithread.js), whatever page asks.
  assert.match(sent, /You: You slept well last night/);
  assert.match(sent, /Person: \(asked for a summary: /);
  assert.equal((await p.c.post('/api/ai', { topic: 'ask' })).status, 400, 'a question needs words');
  const list = await ok(await p.c.get('/api/workouts'));
  const w = list.history.find((x) => !x.readOnly);
  if (w) {
    await done(await ok(await p.c.post('/api/ai', { topic: 'workout', id: w.id })));
    assert.match(r.opencode.state.prompts.at(-1), /## Detail of what was asked about/);
  }
});

test('the morning summary: written once a day, kept, shown again; with no model it says so', async () => {
  const m = await ok(await p.c.get('/api/ai/morning'));
  assert.ok('due' in m && 'answer' in m);
  if (m.night) {
    const s = await ok(await p.c.post('/api/ai/morning', {}));
    if (s.job) await done(s.job);
    await new Promise((res) => setTimeout(res, 100));
    const m2 = await ok(await p.c.get('/api/ai/morning'));
    assert.equal(m2.answer.headline, 'You slept well last night');
    assert.equal(m2.due, false, 'once a day');
  }
  // Refused by every model: an error in words, not an empty answer.
  r.opencode.state.refuse = true;
  const j = await done(await ok(await p.c.post('/api/ai', { topic: 'ask', question: 'Anything?' })));
  r.opencode.state.refuse = false;
  assert.equal(j.state, 'error');
  assert.match(j.error, /busy or refused|could not be reached/);
});

test('the reply: JSON taken from around it; not JSON is no answer', () => {
  assert.deepEqual(parseReply('Here: {"headline":"Hi","summary":"S","points":["a"],"followUps":["q"]} thanks'), { headline: 'Hi', summary: 'S', points: ['a'], followUps: ['q'] });
  assert.equal(parseReply('no json here'), null);
  assert.equal(parseReply('{"other":1}'), null);
});

test('the AI reads only what the person allowed, never their name, never Strava', async () => {
  const q = await personWith(r, 'privatethinker');
  await q.c.patch('/api/settings', { profile: { displayName: 'Zebulon Quixote' } }).catch(() => {});
  r.app.app.patchProfile(q.id, { displayName: 'Zebulon Quixote' });
  const c = await ok(await q.c.patch('/api/consent', { ai: { allow: { activity: true, workouts: true } } }));
  assert.deepEqual(Object.keys(c.ai.allow).filter((k) => c.ai.allow[k]), ['activity', 'workouts']);
  // A run from Strava, with its own name.
  await r.app.worlds.hold(q.id, async (w) => {
    const t0 = Date.now() - 3 * 3_600_000;
    w.db.workoutAdd({ status: 'done', source: 'strava', start: t0, end: t0 + 40 * 60_000, created: t0, updated: t0, title: 'Stravaonly Tempo', type: 'RUNNING', prompts: {}, google: { state: 'local' }, strava: { id: '77', name: 'Stravaonly Tempo', distanceM: 8000 } });
  });
  const ask = async (body) => {
    let j = await ok(await q.c.post('/api/ai', body));
    for (let i = 0; i < 100 && (j.state === 'reading' || j.state === 'asking'); i += 1) { await new Promise((res) => setTimeout(res, 30)); j = await ok(await q.c.get(`/api/ai/${j.id}`)); }
    return r.opencode.state.prompts.at(-1);
  };
  const sent = await ask({ topic: 'ask', question: 'How am I doing?' });
  assert.ok(sent.includes('## Recent workouts'));
  assert.ok(!sent.includes('## Last night'), 'no sleep');
  assert.ok(!/resting HR|HRV ms|asleep \d/.test(sent), 'no heart or sleep numbers');
  assert.ok(sent.includes('chose not to share'), 'the model is told what is missing');
  assert.ok(!sent.includes('Zebulon') && !sent.includes('privatethinker'), 'no name');
  assert.ok(!sent.includes('Stravaonly'), 'nothing from Strava');
  const id = (await ok(await q.c.get('/api/workouts?limit=50'))).history.find((x) => x.title === 'Stravaonly Tempo')?.id;
  if (id) assert.match(await ask({ topic: 'workout', id }), /came from Strava/);
  // A metric page is the kind its catalog category says: heart, body and vitals stay out with
  // only activity allowed, a sensitive one never goes in, and an activity one does, by its name.
  for (const id of ['recovery', 'body_fat', 'stress', 'spo2']) assert.match(await ask({ topic: 'metric', id }), /chose not to share this kind/, id);
  // A sensitive one goes in only when its own kind is allowed (consent.js AI_SENSITIVE): here it is not.
  assert.match(await ask({ topic: 'metric', id: 'glucose' }), /chose not to share this kind/);
  assert.match(await ask({ topic: 'metric', id: 'steps' }), /The metric is "Steps"/);
  // Turned off again: refused.
  await ok(await q.c.patch('/api/consent', { ai: null }));
  assert.equal((await q.c.post('/api/ai', { topic: 'sleep' })).status, 409);
});

test('your own OpenCode Go or Zen key: checked with its model list, then only your prompts go there', async () => {
  const KEY = 'oc_abcdefghijklmnopqrstuvwxyz0123456789';
  const ANSWER = JSON.stringify({ headline: 'Rest today', sections: [{ id: 'recovery', title: 'Recovery', text: 'Sleep was short.' }], nextSteps: ['Walk instead.'] });
  const calls = [];
  const fake = async (u, init = {}) => {
    const url = String(u); calls.push({ url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if ((init.headers || {}).authorization !== `Bearer ${KEY}`) return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid credential' } }), { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [...GO_ZDR, 'glm-5.3', 'kimi-k3'].map((id) => ({ id, object: 'model' })) }));
    if (url.endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: ANSWER } }] }));
    return new Response('{}', { status: 404 });
  };
  // OpenCode Go is the first choice offered, and the default model is one that keeps nothing.
  assert.equal(Object.keys(OWN_AI)[0], 'opencode-go');
  assert.ok(GO_ZDR.includes(OWN_AI['opencode-go'].model));
  const go = await checkOwnAi({ provider: 'opencode-go', key: KEY }, { fetchImpl: fake });
  assert.deepEqual([go.provider, go.model, go.base], ['opencode-go', GO_ZDR[0], null]);
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/models');
  await assert.rejects(checkOwnAi({ provider: 'opencode-go', key: 'oc_wrongwrongwrongwrongwrong' }, { fetchImpl: fake }), (e) => e.code === 'ai_key' && /OpenCode Go/.test(e.message));
  await assert.rejects(checkOwnAi({ provider: 'opencode-go', key: KEY, model: 'gpt-9' }, { fetchImpl: fake }), /no model called "gpt-9"/);
  await assert.rejects(checkOwnAi({ provider: 'opencode-go', key: 'short' }, { fetchImpl: fake }), /does not look like/);
  calls.length = 0;
  const out = await new OwnWriter({ ...go, fetchImpl: fake }).write('the stats', { parse: parseReply });
  assert.equal(out.summary.headline, 'Rest today');
  assert.match(out.model, /glm-5\.3-flash \(your OpenCode Go\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  assert.equal(calls[0].body.model, GO_ZDR[0]);
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'the stats' }]);
  assert.match(calls[0].headers['x-opencode-session'], /^[0-9a-f-]{36}$/, 'Go wants a session id on every conversation');
  assert.match(calls[0].headers['user-agent'], /rep\./);
  // Zen: the same key shape, its own address, a model of the person's choosing.
  calls.length = 0;
  const zen = await checkOwnAi({ provider: 'opencode-zen', key: KEY, model: 'kimi-k3' }, { fetchImpl: fake });
  assert.equal(calls[0].url, 'https://opencode.ai/inference/openai/v1/models');
  await new OwnWriter({ ...zen, fetchImpl: fake }).write('p', { parse: parseReply });
  assert.equal(calls[1].url, 'https://opencode.ai/inference/openai/v1/chat/completions');
  assert.equal(calls[1].body.model, 'kimi-k3');
  // Out of the month's allowance: said in words, not as a crash.
  const limited = async () => new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), { status: 429 });
  await assert.rejects(new OwnWriter({ ...go, fetchImpl: limited }).write('p', { parse: parseReply }), (e) => e.code === 'ai_limit' && /OpenCode Go/.test(e.message));
});

test('a metric is read as its page shows it: its name, its parts, a range\'s low and high, a weekly one by the week', async () => {
  assert.deepEqual(['steps', 'recovery', 'resilience', 'weight', 'skin_temp', 'body_battery', 'workouts', 'glucose', 'ecg', 'nope'].map(metricKind),
    ['activity', 'heart', 'heart', 'body', 'heart', 'heart', 'workouts', 'vitals', 'ecg', null]);
  const zones = metricDetail('zones', { chart: { points: [{ date: '2026-11-12', value: 50, parts: { light: 30, moderate: 12, vigorous: 6, peak: 2 } }], stackKeys: [{ key: 'light', label: 'Light' }, { key: 'moderate', label: 'Moderate' }, { key: 'vigorous', label: 'Vigorous' }, { key: 'peak', label: 'Peak' }] }, stats: {} });
  assert.match(zones, /Time in heart-rate zones/);
  assert.match(zones, /Light 30 min, Moderate 12 min, Vigorous 6 min, Peak 2 min/);
  const bb = metricDetail('body_battery', { chart: { points: [{ date: '2026-11-12', value: 80, lo: 15, hi: 80 }] }, stats: {} });
  assert.match(bb, /80 of 100, low 15 of 100, high 80 of 100/);
  const cw = metricDetail('cardio_week', { chart: { points: [{ date: '2026-11-12', value: 20 }] }, stats: {} }, { chart: { points: [{ date: '2026-11-02', value: 140 }, { date: '2026-11-09', value: 60 }] } });
  assert.match(cw, /week by week[^]*2026-11-09: 60 min\n2026-11-02: 140 min/);
  const lb = metricDetail('resilience', { chart: { points: [{ date: '2026-11-12', value: 61 }] }, stats: { count: 1, avg: 61, min: { value: 61, date: '2026-11-12' }, max: { value: 61, date: '2026-11-12' }, latest: { value: 61, date: '2026-11-12' } } });
  assert.match(lb, /The metric is "Load balance"/);
  assert.ok(!/resilience/i.test(lb.replace(/"Load balance"/, '')), 'never its internal id');
  // Through the app: the page's own numbers go in.
  const j = await done(await ok(await p.c.post('/api/ai', { topic: 'metric', id: 'readiness' })));
  assert.equal(j.state, 'done');
  const sent = r.opencode.state.prompts.at(-1);
  assert.match(sent, /The metric is "Recovery"/);
  assert.match(sent, /Call the app's scores by the app's names/);
});

test('a workout\'s start is in the person\'s own time; a past night on the Sleep page is that night', async () => {
  const t = Date.UTC(2026, 10, 12, 4, 30);
  const out = workoutAnalysis({ start: t, end: t + 30 * 60_000, type: 'RUNNING' }, [], 'America/Halifax');
  assert.match(out, /started 00:30 their local time/);
  const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  await done(await ok(await p.c.post('/api/ai', { topic: 'sleep', id: past })));
  assert.match(r.opencode.state.prompts.at(-1), new RegExp(`The night ending \\w+ ${past} \\(the one they are looking at`));
});
