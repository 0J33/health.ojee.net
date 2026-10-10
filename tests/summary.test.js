import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Zen, reasonFor, allowedModels, BLOCKED } from '../server/zen.js';
import { ZEN_DEFAULT_MODELS, loadConfig } from '../server/config.js';
import { Vault } from '../server/secrets.js';
import { rig } from './helpers.mjs';

const GOOD = JSON.stringify({ headline: 'A steady week', sections: [{ id: 'sleep', title: 'Sleep', text: 'Seven hours a night.' }], nextSteps: ['Walk after lunch.', 'Lights out by 23:00.'], caveats: [] });
const reply = (content, status = 200) => new Response(JSON.stringify(status === 200 ? { choices: [{ message: { role: 'assistant', content } }] } : { error: { message: content } }), { status, headers: { 'content-type': 'application/json' } });

/** A fake OpenCode Zen: `answers[model]` is a status, a string, or a function. */
function zenRig(answers, models = ZEN_DEFAULT_MODELS) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), model: body.model, auth: init.headers.authorization, body });
    const a = answers[body.model];
    if (a === undefined) return reply('model not found', 404);
    if (a === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (typeof a === 'number') return reply(a === 429 ? 'rate limit exceeded' : 'nope', a);
    return reply(a);
  };
  return { zen: new Zen({ url: 'https://opencode.ai/zen/v1/chat/completions', models, fetchImpl }), calls };
}

test('the models: zero-retention ones first, in order; logging/training families never', () => {
  assert.deepEqual(ZEN_DEFAULT_MODELS, ['space-bunny-free', 'longcat-2.5-preview-free', 'step-5-preview-free', 'big-pickle', 'mimo-v2.6-flash-free']);
  assert.deepEqual(loadConfig({ ZEN_MODELS: ' a-free , b-free ' }).zen.models, ['a-free', 'b-free']);
  // Even when somebody puts one in the override.
  assert.deepEqual(allowedModels(['nemotron-3.5-lightning-free', 'big-pickle', 'muse-2-free', 'Nemotron-X', 'big-pickle']), ['big-pickle']);
  assert.ok(BLOCKED.test('nemotron-3.5-lightning-free') && BLOCKED.test('muse-spark') && !BLOCKED.test('mimo-v2.6-flash-free'));
});

test('one HTTPS call per attempt, OpenAI-shaped, with the person\'s key as a bearer', async () => {
  const { zen, calls } = zenRig({ 'space-bunny-free': GOOD });
  const out = await zen.write('sk-person-key', 'PROMPT');
  assert.equal(out.model, 'space-bunny-free');
  assert.equal(out.summary.headline, 'A steady week');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-person-key');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'PROMPT' }]);
  assert.equal(calls[0].body.stream, false);
});

test('a model that refuses is skipped for the next: quota, an empty reply, not the JSON asked for', async () => {
  const { zen, calls } = zenRig({ 'space-bunny-free': 429, 'longcat-2.5-preview-free': '', 'step-5-preview-free': 'Sure! Here is your summary: you slept well.', 'big-pickle': `\`\`\`json\n${GOOD}\n\`\`\`` });
  const out = await zen.write('k', 'p');
  assert.equal(out.model, 'big-pickle');
  assert.deepEqual(calls.map((c) => c.model), ['space-bunny-free', 'longcat-2.5-preview-free', 'step-5-preview-free', 'big-pickle']);
  assert.deepEqual(out.tried.map((t) => t.kind), ['quota', 'refused', 'invalid', 'ok']);
});

test('when nothing answers, it says why; a key is rejected only when every model refuses it', async () => {
  const all = (v) => Object.fromEntries(ZEN_DEFAULT_MODELS.map((m) => [m, v]));
  const why = async (answers, key = 'k') => { try { await zenRig(answers).zen.write(key, 'p'); return null; } catch (e) { return [reasonFor(e), e.tried.length]; } };
  assert.deepEqual(await why(all(429)), ['The free models are at their limit right now', 5]);
  assert.deepEqual(await why(all('network')), ['OpenCode could not be reached', 5]);
  assert.deepEqual(await why(all(500)), ['Every free model refused or failed', 5]);
  assert.deepEqual(await why(all(401)), ['OpenCode rejected the key', 5]);
  // One model answering 403 is that model, not the key: another model that
  // answered at all (even "limit reached") proves the key is accepted.
  assert.deepEqual(await why({ ...all(403), [ZEN_DEFAULT_MODELS[0]]: 429 }), ['Every free model refused or failed', 5]);
  assert.deepEqual(await why(all(GOOD), ''), ['No OpenCode key saved', 0]);
  // A blocked model in the list is never called, even as a last resort.
  const { zen, calls } = zenRig({ 'nemotron-3.5-lightning-free': GOOD, 'big-pickle': 500 }, ['nemotron-3.5-lightning-free', 'big-pickle']);
  await assert.rejects(zen.write('k', 'p'));
  assert.deepEqual(calls.map((c) => c.model), ['big-pickle']);
});

test('test my key: a few words, no health data', async () => {
  const { zen, calls } = zenRig({ 'space-bunny-free': 429, 'longcat-2.5-preview-free': 'ok' });
  const ok = await zen.test('k');
  assert.deepEqual([ok.ok, ok.model], [true, 'longcat-2.5-preview-free']);
  assert.ok(calls.every((c) => c.body.messages[0].content.length < 60));
  const bad = await zenRig(Object.fromEntries(ZEN_DEFAULT_MODELS.map((m) => [m, 401]))).zen.test('k');
  assert.deepEqual([bad.ok, bad.reason, bad.tried.length], [false, 'OpenCode rejected the key', 5]);
  const oneDenied = await zenRig({ 'space-bunny-free': 403, 'longcat-2.5-preview-free': 'ok' }).zen.test('k');
  assert.equal(oneDenied.ok, true, 'a 403 from one model does not condemn the key');
});

test('the vault: AES-256-GCM, bound to the person, useless with another secret', () => {
  const v = new Vault('app-secret-one');
  const a = v.seal('sk-very-secret', 'user1:zen');
  const b = v.seal('sk-very-secret', 'user1:zen');
  assert.notEqual(a.data, b.data, 'a fresh nonce every time');
  assert.ok(!JSON.stringify(a).includes('sk-very-secret'));
  assert.equal(v.open(a, 'user1:zen'), 'sk-very-secret');
  assert.equal(v.open(a, 'user2:zen'), null, 'a row copied onto someone else does not open');
  assert.equal(new Vault('app-secret-two').open(a, 'user1:zen'), null);
  assert.equal(v.open({ ...a, data: Buffer.from('tampered').toString('base64') }, 'user1:zen'), null);
  assert.throws(() => new Vault('').seal('x', 'y'), /APP_SECRET/);
});

test('through the app: the key is stored encrypted and never returned; the summary falls back to rules with the reason', async () => {
  const seen = [];
  const state = { mode: 'ok' };
  const zenFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ auth: init.headers.authorization, model: body.model, prompt: body.messages[0].content });
    if (state.mode === 'down') throw new TypeError('fetch failed');
    if (state.mode === 'badkey') return reply('invalid api key', 401);
    return reply(body.messages[0].content.startsWith('Reply with') ? 'ok' : GOOD);
  };
  const skew = { ms: 0 };
  const r = await rig({ zenFetch, now: () => Date.now() + skew.ms });
  try {
    const p = await r.person('writer', { persona: 'fitbit' });
    await p.c.patch('/api/profile', { notes: 'Desk job, gym 3 days a week.' });
    // No key: rules, labelled.
    let s = (await p.c.post('/api/summary', { window: 7 })).json;
    assert.deepEqual([s.latest['7'].source, s.latest['7'].model, s.latest['7'].why], ['rules', null, 'No OpenCode key saved']);
    assert.ok(s.latest['7'].summary.sections.length >= 4 && s.latest['7'].summary.nextSteps.length >= 1);
    assert.equal(seen.length, 0, 'nothing was sent anywhere');
    // Save a key.
    assert.equal((await p.c.put('/api/ai/key', { key: 'short' })).status, 400);
    const KEY = 'sk-live-person-key-abcd9f2c';
    assert.deepEqual((await p.c.put('/api/ai/key', { key: KEY })).json, { keySet: true, last4: '9f2c' });
    assert.ok(!JSON.stringify(r.app.app.all('SELECT * FROM secret')).includes(KEY), 'not in the database in the clear');
    for (const path of ['/api/me', '/api/summary', '/api/export', '/api/admin']) assert.ok(!(await p.c.get(path)).text.includes(KEY), `${path} never returns it`);
    assert.deepEqual((await p.c.get('/api/me')).json.ai, { keySet: true, last4: '9f2c' });
    assert.deepEqual((await p.c.post('/api/ai/test', {})).json.ok, true);
    // With a key: the model writes it, from the computed stats and the notes only.
    seen.length = 0;
    s = (await p.c.post('/api/summary', { window: 30 })).json;
    assert.deepEqual([s.latest['30'].source, s.latest['30'].model, s.latest['30'].why], ['model', 'space-bunny-free', null]);
    assert.equal(s.latest['30'].summary.headline, 'A steady week');
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.match(seen[0].prompt, /Desk job, gym 3 days a week\./);
    assert.match(seen[0].prompt, /"stepsAvg":\d+/);
    assert.ok(!seen[0].prompt.includes('writer@example.com') && !seen[0].prompt.includes('"stages":['), 'no identity, no raw samples');
    assert.ok(!/emoji|Fitbit Air/.test(seen[0].prompt.replace('Do not use emoji.', '')));
    // OpenCode down, then the key revoked: rules each time, saying why. The last good summary of another window stays.
    state.mode = 'down';
    s = (await p.c.post('/api/summary', { window: 7 })).json;
    assert.deepEqual([s.latest['7'].source, s.latest['7'].why], ['rules', 'OpenCode could not be reached']);
    assert.equal(s.latest['30'].source, 'model');
    state.mode = 'badkey';
    s = (await p.c.post('/api/summary', { window: 'night' })).json;
    assert.deepEqual([s.latest.night.source, s.latest.night.why], ['rules', 'OpenCode rejected the key']);
    skew.ms += 10_000;   // past the few seconds asked for between tests
    assert.deepEqual((await p.c.post('/api/ai/test', {})).json.reason, 'OpenCode rejected the key');
    assert.deepEqual((await p.c.del('/api/ai/key')).json, { keySet: false, last4: null });
    assert.equal((await p.c.post('/api/ai/test', {})).status, 400);
    // Nothing to summarise before any data.
    const empty = await r.person('nodata');
    assert.deepEqual([(await empty.c.post('/api/summary', { window: 7 })).status], [409]);
  } finally { await r.close(); }
});
