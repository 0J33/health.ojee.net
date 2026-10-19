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

