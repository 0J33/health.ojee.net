import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rig } from './helpers.mjs';

let r;
before(async () => {
  r = await rig({ web: {
    'index.html': '<!doctype html><title>shell</title>', 'sw.js': '// service worker', 'js/app.js': 'export const x = 1;', 'css/app.css': 'body{}',
    'manifest.webmanifest': '{"name":"Health"}', 'icon-192.png': 'PNG', 'favicon.svg': '<svg/>',
  } });
});
after(async () => { await r.close(); });

test('client routes get the shell; a missing file with an extension is a real 404', async () => {
  const c = r.client();
  for (const path of ['/', '/u/mira', '/workouts/12', '/settings/privacy', '/ranks']) {
    const x = await c.get(path);
    assert.equal(x.status, 200, path);
    assert.match(x.text, /<title>shell<\/title>/);
    assert.equal(x.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(x.headers.get('cache-control'), 'no-store');
  }
  for (const path of ['/js/missing.js', '/nope.css', '/icon-999.png']) assert.equal((await c.get(path)).status, 404, path);
  // An unknown API path is JSON, not the shell.
  const api = await c.get('/api/nothing-here');
  assert.deepEqual([api.status, api.json.code], [401, 'not_logged_in']);
  assert.equal((await c.get('/auth/nothing')).status, 404);
});

test('the service worker and the manifest are served the way a PWA needs', async () => {
  const c = r.client();
  const sw = await c.get('/sw.js');
  assert.equal(sw.headers.get('cache-control'), 'no-store');
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(sw.headers.get('content-type'), /^text\/javascript/);
  assert.match((await c.get('/manifest.webmanifest')).headers.get('content-type'), /^application\/manifest\+json/);
  assert.equal((await c.get('/favicon.svg')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await c.get('/icon-192.png')).headers.get('content-type'), 'image/png');
  // Other files revalidate: an ETag, and a 304 when nothing changed.
  const js = await c.get('/js/app.js');
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  const etag = js.headers.get('etag');
  assert.ok(etag);
  assert.equal((await c.get('/js/app.js', { headers: { 'if-none-match': etag } })).status, 304);
});

test('a strict CSP and friends on every reply: pages, files, API, errors', async () => {
  const c = r.client();
  for (const path of ['/', '/js/app.js', '/api/me', '/api/health', '/nope.js', '/api/data']) {
    const h = (await c.get(path)).headers;
    const csp = h.get('content-security-policy');
    assert.ok(csp, path);
    for (const part of ["default-src 'self'", "script-src 'self'", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) assert.ok(csp.includes(part), `${path}: ${part}`);
    assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no inline or eval scripts');
    assert.ok(!/https?:/.test(csp), 'no other hosts');
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-frame-options'), 'DENY');
  }
});

test('paths cannot climb out of web/', async () => {
  const c = r.client();
  for (const path of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/js/..%2f..%2f..%2fserver/index.js', '/..%5c..%5cpackage.json', '/%00.js']) {
    const x = await c.get(path);
    assert.ok([400, 404].includes(x.status), `${path} -> ${x.status}`);
    assert.ok(!x.text.includes('"dependencies"'));
  }
  assert.equal((await c.call('POST', '/index.html')).status, 405);
});

test('errors are { error, code }; oversized and malformed bodies are refused; bugs do not leak', async () => {
  const p = await r.person('errors');
  const big = await p.c.patch('/api/profile', { bio: 'x'.repeat(70_000) });
  assert.deepEqual([big.status, big.json.code], [413, 'too_large']);
  const junk = await p.c.call('PATCH', '/api/profile', { raw: '{not json', headers: { 'content-type': 'application/json' } });
  assert.deepEqual([junk.status, junk.json.error], [400, 'The request body is not JSON.']);
  const nf = await p.c.get('/api/workouts/99999');
  assert.deepEqual([nf.status, nf.json.code, nf.json.error], [404, 'not_found', 'No such workout.']);
  const conflict = await p.c.post('/api/workouts/log', { start: Date.now() + 86_400_000, end: Date.now() + 90_000_000 });
  assert.deepEqual([conflict.status, conflict.json.error], [400, 'A workout cannot start in the future.']);
  await p.c.post('/api/workouts/start', {});
  const twice = await p.c.post('/api/workouts/start', {});
  assert.deepEqual([twice.status, twice.json.code], [409, 'conflict']);
  assert.match(twice.json.error, /^A workout is already running/);
  for (const [path, body] of [['/api/settings', { privacy: { account: 'secret' } }], ['/api/settings', { units: { weight: 'stone' } }], ['/api/profile', { tz: 'Mars/Olympus' }], ['/api/profile', { accent: 'red' }], ['/api/profile', { onboarding: 'later' }]]) {
    const x = await p.c.patch(path, body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.ok(x.json.error.length > 10);
  }
  assert.deepEqual((await p.c.get('/api/leaderboard?metric=vibes')).status, 400);
});

test('SSE: a person\'s stream carries their own events and nobody else\'s', async () => {
  const a = await r.person('ssea');
  const b = await r.person('sseb');
  const open = async (c) => {
    const ac = new AbortController();
    const res = await fetch(`${r.base}/api/events`, { headers: { cookie: c.cookie }, signal: ac.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const got = { text: '' };
    (async () => { try { for await (const chunk of res.body) got.text += Buffer.from(chunk).toString(); } catch { /* aborted */ } })();
    return { got, close: () => ac.abort() };
  };
  const sa = await open(a.c); const sb = await open(b.c);
  await a.c.patch('/api/profile', { bio: 'changed' });
  await new Promise((res) => { setTimeout(res, 80); });
  assert.match(sa.got.text, /event: hello/);
  assert.match(sa.got.text, /event: changed\ndata: \{"what":\["me"\]/);
  assert.ok(!sb.got.text.includes('event: changed'));
  sa.close(); sb.close();
  assert.equal((await r.client().get('/api/events')).status, 401);
});

test('the real process: `npm run demo` boots, seeds, serves, and prints the logins but no secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-demo-'));
  const port = 5600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, HEALTH_DEMO: '1', PORT: String(port), DATA_DIR: join(dir, 'health-demo-data'), HEALTH_SCHEDULER: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 150 && !out.includes('listening on'); i += 1) await new Promise((res) => { setTimeout(res, 100); });
    assert.match(out, /DEMO MODE/);
    assert.match(out, /demo\s+Fitbit Air with everything/);
    assert.match(out, /kai\s+Fitbit; PRIVATE account/);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` }, body: JSON.stringify({ username: 'demo', password: 'demo' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie()[0];
    assert.ok(!/Secure/.test(cookie) && /SameSite=Lax/.test(cookie), 'on http://localhost the cookie is not Secure, or no browser would keep it');
    const h = { cookie: cookie.split(';')[0] };
    const me = await (await fetch(`${base}/api/me`, { headers: h })).json();
    assert.deepEqual([me.demo, me.google.state, me.workout.pending], [true, 'ok', 1]);
    const lb = await (await fetch(`${base}/api/leaderboard?metric=steps&period=week`, { headers: h })).json();
    assert.ok(lb.entries.length >= 5 && !lb.entries.some((e) => e.username === 'kai'));
    assert.equal((await fetch(`${base}/api/users/kai`, { headers: h })).status, 404);
    const w = await (await fetch(`${base}/api/workouts`, { headers: h })).json();
    assert.ok(w.history.some((x) => x.source === 'hevy' && x.sets.sets > 10));
    assert.ok(!/demo-rt-|privateKey|password/i.test(out.replace(/password for all: demo/, '')), 'nothing secret on the console');
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => { child.on('exit', res); setTimeout(res, 2000); });
    rmSync(dir, { recursive: true, force: true });
  }
});
