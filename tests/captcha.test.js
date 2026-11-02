import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { Captcha, MIN_MS, TTL_MS, drawCode } from '../server/captcha.js';

test('a code: paths only, the answer works once, not too soon and not too late', () => {
  let t = 1_000_000;
  const c = new Captcha({ now: () => t });
  const a = c.issue();
  assert.match(a.code, /^[2-9]{5}$/);
  assert.ok(!a.svg.includes('<text') && !a.svg.includes(a.code), 'the answer is not in the picture as text');
  assert.equal(c.check(a.token, a.code), false, 'answered before a person could read it');
  const b = c.issue(); t += MIN_MS + 10;
  assert.equal(c.check(b.token, b.code), true);
  assert.equal(c.check(b.token, b.code), false, 'a token is spent');
  const w = c.issue(); t += MIN_MS + 10;
  assert.equal(c.check(w.token, '22222' === w.code ? '33333' : '22222'), false);
  assert.equal(c.check(w.token, w.code), false, 'a wrong try spends it too');
  const old = c.issue(); t += TTL_MS + 1;
  assert.equal(c.check(old.token, old.code), false, 'expired');
  assert.equal(c.check('1.x.y', '23456'), false);
  assert.equal(new Captcha().check(c.issue().token, '23456'), false, 'another key');
  assert.ok(drawCode('98765').startsWith('<svg'));
});

let r;
before(async () => { r = await rig({ env: { CAPTCHA: 'on' } }); });
after(async () => { await r.close(); });

test('creating an account asks for the code; the trap field fails it', async () => {
  const c = r.client();
  assert.equal((await c.get('/api/me')).json.captcha, true);
  const no = await c.post('/auth/register', { username: 'botty', password: 'abcd' });
  assert.deepEqual([no.status, no.json.error?.code ?? no.json.code], [400, 'captcha']);
  // A real challenge from the endpoint, answered with the code the server drew.
  const issue = r.app.captcha.issue.bind(r.app.captcha);
  let last;
  r.app.captcha.issue = () => (last = issue());
  const g = await c.get('/auth/captcha');
  assert.equal(g.status, 200);
  assert.ok(g.json.token && g.json.svg.startsWith('<svg') && !('code' in g.json));
  await new Promise((ok) => { setTimeout(ok, MIN_MS + 50); });
  const trap = await c.post('/auth/register', { username: 'botty', password: 'abcd', website: 'http://x', captcha: { token: g.json.token, answer: last.code } });
  assert.equal(trap.status, 400);
  await c.get('/auth/captcha');
  await new Promise((ok) => { setTimeout(ok, MIN_MS + 50); });
  const ok = await c.post('/auth/register', { username: 'human', password: 'abcd', captcha: { token: last.token, answer: last.code } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.user.username, 'human');
  // Signing in never asks.
  assert.equal((await r.client().post('/auth/login', { username: 'human', password: 'abcd' })).status, 200);
});
