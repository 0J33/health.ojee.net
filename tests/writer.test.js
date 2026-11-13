// The free models through an OpenCode server (server/core/writer.js): the
// same writer as the console's health module, with this app's rules on top
// (free models only, zero-retention first, never a logging/training one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, PREFERRED, BLOCKED, reasonFor } from '../server/core/writer.js';
import { loadConfig } from '../server/config.js';

const GOOD = JSON.stringify({ headline: 'A steady week', sections: [{ id: 'activity', title: 'Activity', text: 'You walked more than last week.' }], nextSteps: ['Keep the evening walk.', 'Lights out by 23:00.'] });

/** A stand-in `opencode serve`: answers[modelID] is the reply text, or an error name. */
function fakeOpencode(answers, { models } = {}) {
  const calls = [];
  const sessions = new Map();
  let n = 0;
  const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
  const all = models || ['space-bunny-free', 'longcat-2.5-preview-free', 'exo-free', 'ling-3.1-flash-free', 'big-pickle', 'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free', 'paid-model'];
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(String(u));
    const p = url.pathname;
    const m = init.method || 'GET';
    if (p === '/provider') return json({ all: [{ id: 'opencode', models: Object.fromEntries(all.map((id) => [id, { id }])) }, { id: 'opencode-go', models: { 'glm-5.3': { id: 'glm-5.3' }, 'glm-5.3-flash': { id: 'glm-5.3-flash' }, 'muse-spark-1.3-contributor': { id: 'muse-spark-1.3-contributor' } } }] });
    if (p === '/session' && m === 'POST') { const id = `s${++n}`; sessions.set(id, null); return json({ id }); }
    const s = /^\/session\/([^/]+)\/(prompt_async|message|abort)$/.exec(p);
    if (s && s[2] === 'prompt_async') { const b = JSON.parse(init.body); calls.push({ model: b.model.modelID, provider: b.model.providerID, text: b.parts[0].text }); sessions.set(s[1], b.model.modelID); return json({}); }
    if (p === '/session/status') return json({});
    if (p === '/permission') return json([]);
    if (s && s[2] === 'message') {
      const a = answers[sessions.get(s[1])];
      if (a === undefined) return json([]);
      if (a && typeof a === 'object') return json([{ info: { role: 'assistant', error: a }, parts: [] }]);
      return json([{ info: { role: 'assistant' }, parts: [{ type: 'text', text: a }] }]);
    }
    if (s && s[2] === 'abort') return json({});
    if (/^\/session\/[^/]+$/.test(p) && m === 'DELETE') { sessions.delete(p.split('/')[2]); return json({}); }
    return json({ error: 'nope' }, 404);
  };
  return { fetchImpl, calls, sessions };
}
const writerFor = (answers, opts = {}) => {
  const f = fakeOpencode(answers, opts);
  return { ...f, writer: new Writer({ url: 'http://127.0.0.1:1', fetchImpl: f.fetchImpl, pollMs: 1, attempts: opts.attempts || 4, sharedGo: !!opts.sharedGo, ...(opts.providers ? { providers: opts.providers } : {}) }) };
};

test('the zero-retention free models are asked first, and the first good answer wins', async () => {
  assert.deepEqual(PREFERRED.filter((k) => k.startsWith('opencode/')).slice(0, 3), ['opencode/space-bunny-free', 'opencode/longcat-2.5-preview-free', 'opencode/step-5-preview-free']);
  const { writer, calls, sessions } = writerFor({ 'space-bunny-free': '', 'longcat-2.5-preview-free': GOOD });
  const r = await writer.write('the stats');
  assert.equal(r.model, 'opencode/longcat-2.5-preview-free');
  assert.equal(r.summary.headline, 'A steady week');
  assert.deepEqual(calls.map((c) => c.model), ['space-bunny-free', 'longcat-2.5-preview-free']);
  assert.ok(calls.every((c) => c.provider === 'opencode' && c.text === 'the stats'));
  assert.equal(sessions.size, 0, 'every throwaway session is deleted');
});

test('never a model that logs or trains, never a paid one, never another provider', async () => {
  assert.ok(BLOCKED.test('opencode/nemotron-3.5-lightning-free') && BLOCKED.test('opencode/muse-spark-1.3-contributor-free'));
  // Free, but kept or trained on while free (opencode.ai/docs/zen, Privacy): never sent anything either.
  assert.ok(BLOCKED.test('opencode/big-pickle') && BLOCKED.test('opencode/mimo-v2.6-flash-free') && BLOCKED.test('opencode-go/iceman-contributor-free') && BLOCKED.test('opencode-go/beam-free'));
  assert.ok(!BLOCKED.test('opencode-go/mimo-v2.6-flash') && !BLOCKED.test('opencode/space-bunny-free') && !BLOCKED.test('opencode/exo-free'));
  const { writer } = writerFor({}, { attempts: 20 });
  const list = await writer.candidates();
  assert.ok(list.length >= 4);
  assert.ok(list.every((k) => k.startsWith('opencode/') && !/nemotron|muse|paid-model|glm|big-pickle|mimo/.test(k)), list.join(','));
});

test('when no model answers it throws with what each one did, and says why in one line', async () => {
  const { writer } = writerFor({ 'space-bunny-free': { name: 'APIError', data: { statusCode: 429, message: 'rate limit exceeded' } } });
  await assert.rejects(writer.write('p'), (e) => {
    assert.equal(e.code, 'all-failed');
    assert.equal(e.tried.length, 4);
    assert.equal(e.tried[0].kind, 'quota');
    assert.match(reasonFor(e), /OpenCode/);
    return true;
  });
  const off = new Writer({ url: '' });
  assert.equal(off.configured(), false);
  await assert.rejects(off.write('p'), (e) => e.code === 'unconfigured');
});

test('the owner\'s OpenCode Go is not spent on everyone: only the free models, even when the box is signed in to Go', async () => {
  const { writer, calls } = writerFor({ 'glm-5.3-flash': GOOD, 'space-bunny-free': GOOD }, { providers: 'opencode-go,opencode', attempts: 20 });
  const list = await writer.candidates();
  assert.ok(list.length >= 2 && list.every((k) => k.startsWith('opencode/') && k.endsWith('-free')), list.join(','));
  const r = await writer.write('p');
  assert.equal(r.model, 'opencode/space-bunny-free');
  assert.ok(calls.every((c) => c.provider === 'opencode'));
  // Pinning a Go model by name does not get round it.
  const pinned = new Writer({ url: 'http://127.0.0.1:1', fetchImpl: fakeOpencode({}).fetchImpl, providers: 'opencode-go,opencode', models: 'opencode-go/glm-5.3-flash,glm-5.3-flash', attempts: 20 });
  assert.ok(!(await pinned.candidates()).some((k) => k.startsWith('opencode-go/')));
});

test('the config: AI_SHARED_GO off by default (free models only), 1 brings back Go for everyone', () => {
  const off = loadConfig({}).opencode;
  assert.deepEqual([off.sharedGo, off.providers], [false, 'opencode']);
  const on = loadConfig({ AI_SHARED_GO: '1' }).opencode;
  assert.deepEqual([on.sharedGo, on.providers], [true, 'opencode-go,opencode']);
});

test('AI_SHARED_GO=1 and signed in to OpenCode Go: its models that keep nothing go first, its others never', async () => {
  const { writer, calls } = writerFor({ 'glm-5.3-flash': GOOD }, { providers: 'opencode-go,opencode', attempts: 6, sharedGo: true });
  const list = await writer.candidates();
  assert.equal(list[0], 'opencode-go/glm-5.3-flash');
  assert.ok(!list.includes('opencode-go/glm-5.3') && !list.some((k) => /muse|big-pickle|mimo-v2.6-flash-free/.test(k)), list.join(','));
  const r = await writer.write('p');
  assert.equal(r.model, 'opencode-go/glm-5.3-flash');
  assert.deepEqual(calls.map((c) => [c.provider, c.model]), [['opencode-go', 'glm-5.3-flash']]);
});
