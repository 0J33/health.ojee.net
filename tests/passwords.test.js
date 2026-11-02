/* Passwords without email (docs/CIRCLES.md, part 3): change it, a
   recovery code, and an admin's one-time link. Every way ends the
   account's other sessions. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { makeCode } from '../server/passwords.js';

test('change password: the current one first; other sessions end, this one stays', async () => {
  const r = await rig();
  try {
    const a = await r.person('pwann', { password: 'first-pass' });
    const other = r.client();
    assert.equal((await other.post('/auth/login', { username: 'pwann', password: 'first-pass' })).status, 200);
    assert.equal((await a.c.post('/api/account/password', { current: 'wrong', password: 'second-pass' })).json.code, 'bad_password');
    assert.equal((await a.c.post('/api/account/password', { current: 'first-pass', password: 'abc' })).status, 400, 'too short');
    assert.deepEqual((await a.c.post('/api/account/password', { current: 'first-pass', password: 'second-pass' })).json, { ok: true });
    assert.equal((await a.c.get('/api/me')).json.user.username, 'pwann', 'still signed in here');
    await new Promise((res) => { setTimeout(res, 20); });
    assert.equal((await other.get('/api/me')).json.user, null, 'the other device is signed out');
    const fresh = r.client();
    assert.equal((await fresh.post('/auth/login', { username: 'pwann', password: 'first-pass' })).status, 401);
    assert.equal((await fresh.post('/auth/login', { username: 'pwann', password: 'second-pass' })).status, 200);
  } finally { await r.close(); }
});

test('recovery code: made with the password, shown once, stored hashed; it resets the password and is replaced', async () => {
  const r = await rig();
  try {
    const a = await r.person('pwben', { password: 'old-pass' });
    assert.equal((await a.c.get('/api/me')).json.recovery, null);
    assert.equal((await a.c.post('/api/account/recovery', { password: 'nope' })).status, 400);
    const made = (await a.c.post('/api/account/recovery', { password: 'old-pass' })).json;
    assert.match(made.code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    assert.equal((await a.c.get('/api/me')).json.recovery, made.createdAt);
    assert.ok(!JSON.stringify(r.app.app.all('SELECT * FROM recovery')).includes(made.code.replace(/-/g, '')), 'only a hash is kept');

    const anon = r.client();
    assert.equal((await anon.post('/auth/reset', { username: 'pwben', code: makeCode(), password: 'new-pass' })).json.code, 'bad_code');
    assert.equal((await anon.post('/auth/reset', { username: 'nobody', code: made.code, password: 'new-pass' })).json.code, 'bad_code', 'no telling who exists');
    // Typed loosely: lower case, spaces for dashes.
    const typed = made.code.toLowerCase().replace(/-/g, ' ');
    const back = await anon.post('/auth/reset', { username: 'PWBEN', code: typed, password: 'new-pass' });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.user.username, 'pwben');
    assert.ok(back.json.recoveryCode && back.json.recoveryCode !== made.code, 'a new code in its place');
    assert.equal((await anon.get('/api/me')).json.user.username, 'pwben', 'signed in on this device');
    await new Promise((res) => { setTimeout(res, 20); });
    assert.equal((await a.c.get('/api/me')).json.user, null, 'every other session ended');
    assert.equal((await anon.post('/auth/reset', { username: 'pwben', code: made.code, password: 'again-pass' })).status, 400, 'the old code is used up');
    assert.equal((await r.client().post('/auth/login', { username: 'pwben', password: 'new-pass' })).status, 200);
  } finally { await r.close(); }
});

test('recovery codes are rate-limited per username', async () => {
  const r = await rig();
  try {
    await r.person('pwcat');
    const anon = r.client();
    let last = 0;
    for (let i = 0; i < 7; i += 1) last = (await anon.post('/auth/reset', { username: 'pwcat', code: makeCode(), password: 'whatever1' })).status;
    assert.equal(last, 429);
  } finally { await r.close(); }
});

test('an admin\'s link: one-time, for 24 hours, a new one replaces the old; admins only', async () => {
  const r = await rig({ env: { ADMIN_USERS: 'boss' } });
  try {
    const boss = await r.person('boss');
    const p = await r.person('pwdan', { password: 'lost-it' });
    assert.equal((await p.c.post('/api/admin/reset', { username: 'pwdan' })).status, 403);
    assert.equal((await boss.c.post('/api/admin/reset', { username: 'nobody' })).status, 404);
    const first = (await boss.c.post('/api/admin/reset', { username: 'PWDAN' })).json;
    const made = (await boss.c.post('/api/admin/reset', { username: 'pwdan' })).json;
    assert.match(made.url, /\/reset\?t=[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(made.links.map((l) => l.username), ['pwdan'], 'one open link a person');
    assert.deepEqual((await boss.c.get('/api/admin')).json.resetLinks.map((l) => l.username), ['pwdan']);
    const t = new URL(made.url, 'https://x').searchParams.get('t');
    const anon = r.client();
    assert.equal((await anon.get(`/auth/reset?t=${new URL(first.url, 'https://x').searchParams.get('t')}`)).status, 404, 'the first was replaced');
    assert.equal((await anon.get(`/auth/reset?t=${t}`)).json.username, 'pwdan');
    assert.equal((await anon.post('/auth/reset', { token: t, password: 'ab' })).status, 400, 'the password rule still holds');
    const done = await anon.post('/auth/reset', { token: t, password: 'found-it' });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.recoveryCode, null);
    assert.equal((await anon.post('/auth/reset', { token: t, password: 'again-it' })).json.code, 'link_gone', 'once');
    assert.equal((await r.client().post('/auth/login', { username: 'pwdan', password: 'found-it' })).status, 200);
    assert.deepEqual((await boss.c.get('/api/admin')).json.resetLinks, []);
  } finally { await r.close(); }
});

test('a link runs out after 24 hours', async () => {
  let t = Date.parse('2026-11-01T10:00:00Z');
  const r = await rig({ env: { ADMIN_USERS: 'boss2' }, now: () => t });
  try {
    const boss = await r.person('boss2');
    await r.person('pweve');
    const made = (await boss.c.post('/api/admin/reset', { username: 'pweve' })).json;
    const tok = new URL(made.url, 'https://x').searchParams.get('t');
    t += 24 * 3_600_000 + 1000;
    assert.equal((await r.client().post('/auth/reset', { token: tok, password: 'late-pass' })).json.code, 'link_gone');
  } finally { await r.close(); }
});
