/* AI (server/ai.js): the briefing every request carries, a section's
   summary as a job the page follows, questions with the conversation,
   the morning summary once a day, and what happens when no model answers. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { parseReply } from '../server/ai.js';

let r; let p;
before(async () => { r = await rig(); p = await personWith(r, 'thinker'); });
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
  for (const part of ['## Now', '## Today so far', '## Last night', '## The last 7 days', '## Averages and trends', '## Recent workouts', 'Answer with JSON only', 'Focus on last night']) assert.ok(sent.includes(part), part);
  assert.match(sent, /\d{4}-\d{2}-\d{2}/, 'every number has its day');
  // Asked again: from the cache, at once.
  const again = await done(await ok(await p.c.post('/api/ai', { topic: 'sleep' })));
  assert.equal(again.cached, true);
  assert.equal(r.opencode.state.prompts.at(-1), sent, 'no second call');
});

test('a question with the conversation so far; a workout\'s detail goes in', async () => {
  const j = await done(await ok(await p.c.post('/api/ai', { topic: 'ask', question: 'How was my week?', history: [{ role: 'ai', text: 'You slept well.' }] })));
  assert.equal(j.state, 'done');
  const sent = r.opencode.state.prompts.at(-1);
  assert.match(sent, /The person asks: "How was my week\?"/);
  assert.match(sent, /You: You slept well\./);
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
