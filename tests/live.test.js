import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Live, parseSamples, cleanSource } from '../server/live.js';
import { parseHeartRate, retryDelay } from '../web/js/live.js';
import { rig, ORIGIN } from './helpers.mjs';

/* The app's own clock, so "10 seconds later" is one assignment. */
const clock = { t: Date.parse('2026-10-10T09:00:00Z') };
const tick = (ms) => { clock.t += ms; };

let r; let ann; let ben; let annKey;
before(async () => {
  r = await rig({ now: () => clock.t });
  ann = await r.person('ann');
  ben = await r.person('ben');
  annKey = (await ann.c.post('/api/link/keys', { label: 'Ojee Pulse' })).json.key;
});
after(async () => { await r.close(); });

const keyPost = (body, key = annKey, headers = {}) => fetch(`${r.base}/api/live/hr`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async (res) => ({ status: res.status, json: await res.json(), headers: res.headers }));

/** An open /api/events stream: every event it has received so far. */
function stream(person) {
  const events = [];
  let req;
  const opened = new Promise((resolve, reject) => {
    req = http.get(`${r.base}/api/events`, { headers: { cookie: person.c.cookie } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev) continue;
          events.push({ event: ev, data: data ? JSON.parse(data) : null });
          if (ev === 'hello') resolve();
        }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
  const live = () => events.filter((e) => e.event === 'live').map((e) => e.data);
  /** Wait until this many `live` events have arrived. */
  const until = async (n) => {
    for (let i = 0; i < 200 && live().length < n; i += 1) await new Promise((res) => { setTimeout(res, 10); });
    return live();
  };
  return { opened, events, live, until, close: () => req.destroy() };
}

/** Let anything already written to a socket arrive. */
const settle = () => new Promise((res) => { setTimeout(res, 60); });

/** Start each test with nobody live and a fresh rate-limit window. */
async function fresh() {
  tick(130_000);
  r.app.live.sweep();
}

/* ── the pure parts ───────────────────────────────────────────────── */

test('the body: samples or the short form, bounds, and what is refused', () => {
  const now = clock.t;
  assert.deepEqual(parseSamples({ bpm: 72 }, now), [{ t: now, bpm: 72 }]);
  assert.deepEqual(parseSamples({ samples: [{ t: now, bpm: 80 }, { t: now - 1000, bpm: 79 }] }, now), [{ t: now - 1000, bpm: 79 }, { t: now, bpm: 80 }], 'oldest first');
  assert.deepEqual(parseSamples({ samples: [{ bpm: 0 }] }, now), [{ t: now, bpm: 0 }], 'zero is allowed, and t defaults to now');
  for (const body of [{}, { samples: [] }, { samples: 'x' }, { samples: [{ t: now, bpm: 24 }] }, { samples: [{ t: now, bpm: 251 }] }, { samples: [{ t: now, bpm: 71.5 }] },
    { samples: [{ t: now, bpm: '72' }] }, { samples: [{ t: 'now', bpm: 72 }] }, { samples: [null] }, { bpm: -1 }, { samples: Array.from({ length: 21 }, () => ({ t: now, bpm: 70 })) }]) {
    assert.throws(() => parseSamples(body, now), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(body).slice(0, 60));
  }
  assert.equal(parseSamples({ samples: Array.from({ length: 20 }, (_, i) => ({ t: now + i, bpm: 70 })) }, now).length, 20);
  assert.equal(cleanSource(undefined, 'pulse'), 'pulse');
  assert.equal(cleanSource('Browser', 'pulse'), 'browser');
  assert.equal(cleanSource('<b>garmin edge</b> with a very long name indeed', 'pulse'), 'bgarmin edgeb with a ver');
  assert.throws(() => cleanSource(5, 'pulse'), (e) => e.status === 400);
});

test('the state machine: latest, 120 s of history, one event a second, the end', () => {
  const c = { t: 1_000_000_000_000 };
  const sent = [];
  const live = new Live({ now: () => c.t, emit: (id, d) => sent.push([id, d]) });
  assert.equal(live.latest('u1'), null);
  live.push('u1', [{ t: c.t, bpm: 70 }], 'pulse');
  assert.deepEqual(live.latest('u1'), { bpm: 70, t: c.t, source: 'pulse' });
  assert.deepEqual(sent, [['u1', { bpm: 70, t: c.t, source: 'pulse' }]]);
  // A second reading inside the same second is kept, and its event is held.
  c.t += 400; live.push('u1', [{ t: c.t, bpm: 71 }], 'pulse');
  assert.equal(sent.length, 1);
  assert.equal(live.latest('u1').bpm, 71);
  c.t += 600; live.sweep();
  assert.deepEqual(sent[1], ['u1', { bpm: 71, t: c.t - 600, source: 'pulse' }], 'the held one goes out when the second is up');
  live.sweep();
  assert.equal(sent.length, 2, 'and only once');
  // A late, older sample joins the history without becoming the latest.
  live.push('u1', [{ t: c.t - 5000, bpm: 60 }], 'browser');
  assert.deepEqual(live.latest('u1'), { bpm: 71, t: c.t - 600, source: 'pulse' });
  assert.deepEqual(live.view('u1').recent.map((p) => p[1]), [60, 70, 71]);
  // History is 120 seconds, no more.
  for (let i = 0; i < 130; i += 1) { c.t += 1000; live.push('u1', [{ t: c.t, bpm: 100 + (i % 50) }], 'pulse'); }
  const rec = live.view('u1').recent;
  assert.ok(rec.length <= 121 && rec.length >= 119, `kept ${rec.length}`);
  assert.ok(c.t - rec[0][0] <= 120_000);
  // Somebody else is somebody else.
  assert.equal(live.latest('u2'), null);
  assert.deepEqual(live.view('u2'), { bpm: null, t: null, source: null, recent: [] });
  assert.ok(sent.every(([id]) => id === 'u1'));
  // Ten seconds of silence: over, said once.
  const n = sent.length;
  c.t += 9_999; live.sweep();
  assert.equal(live.latest('u1').bpm, 129);
  c.t += 1; live.sweep(); live.sweep();
  assert.equal(live.latest('u1'), null);
  assert.deepEqual(sent.slice(n), [['u1', { bpm: null, t: c.t, source: null }]]);
  // The history ages out and then the person is forgotten altogether.
  c.t += 121_000; live.sweep();
  assert.equal(live.people.size, 0);
  assert.equal(live.timer, null, 'the timer stops when nobody is live');
  live.close();
});

test('the Bluetooth measurement: 8 and 16 bit values, and the sensor-contact bits', () => {
  const dv = (...bytes) => new DataView(new Uint8Array(bytes).buffer);
  assert.equal(parseHeartRate(dv(0x00, 72)), 72, 'uint8');
  assert.equal(parseHeartRate(dv(0x01, 0x2c, 0x01)), 300, 'uint16, little endian');
  assert.equal(parseHeartRate(dv(0x01, 150, 0)), 150);
  assert.equal(parseHeartRate(dv(0x06, 88)), 88, 'contact supported and detected');
  assert.equal(parseHeartRate(dv(0x04, 88)), 0, 'contact supported, not detected: off the skin');
  assert.equal(parseHeartRate(dv(0x02, 88)), 88, 'contact not supported: the bit means nothing');
  assert.equal(parseHeartRate(dv(0x16, 91, 0x10, 0x03, 0x20, 0x03)), 91, 'RR intervals after the value are ignored');
  assert.equal(parseHeartRate(dv(0x00)), null, 'too short');
  assert.equal(parseHeartRate(dv(0x01, 70)), null, 'too short for uint16');
  assert.equal(parseHeartRate(null), null);
  // Reconnecting: 1 s, 2 s, 5 s, then every 10-15 s for as long as it takes.
  assert.deepEqual([0, 1, 2].map((i) => retryDelay(i)), [1000, 2000, 5000]);
  for (const i of [3, 4, 50, 5000]) { const d = retryDelay(i); assert.ok(d >= 10_000 && d <= 15_000, `attempt ${i}: ${d}`); }
});

/* ── the routes ───────────────────────────────────────────────────── */

test('a signed-in post: the reading comes back from /api/live and in /api/data, to that person only', async () => {
  await fresh();
  const t = clock.t;
  assert.deepEqual((await ann.c.get('/api/live')).json, { bpm: null, t: null, source: null, recent: [] });
  const res = await ann.c.post('/api/live/hr', { samples: [{ t: t - 1000, bpm: 91 }, { t, bpm: 92 }] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.deepEqual((await ann.c.get('/api/live')).json, { bpm: 92, t, source: 'browser', recent: [[t - 1000, 91], [t, 92]] });
  assert.deepEqual((await ann.c.get('/api/data')).json.live, { bpm: 92, t, source: 'browser' });
  // Nobody else: not their own live state, not their data, not her public profile.
  assert.deepEqual((await ben.c.get('/api/live')).json, { bpm: null, t: null, source: null, recent: [] });
  assert.equal((await ben.c.get('/api/data')).json.live, null);
  assert.ok(!JSON.stringify((await ben.c.get('/api/users/ann')).json).includes('"live"'));
  assert.ok(!(await ben.c.get('/api/leaderboard')).text.includes('"live"'));
  // The short form, with a source of the sender's choosing.
  tick(1000);
  assert.equal((await ann.c.post('/api/live/hr', { bpm: 95, source: 'chest strap' })).status, 200);
  assert.deepEqual((await ann.c.get('/api/live')).json.source, 'chest strap');
  assert.equal((await ann.c.get('/api/live')).json.bpm, 95);
  assert.equal((await ann.c.get('/api/live')).json.t, clock.t);
});

test('the session route keeps its guards: signed in, and from this site', async () => {
  await fresh();
  const anon = r.client();
  const a = await anon.post('/api/live/hr', { bpm: 70 });
  assert.deepEqual([a.status, a.json.code], [401, 'not_logged_in']);
  assert.equal((await anon.get('/api/live')).status, 401);
  const b = await ann.c.post('/api/live/hr', { bpm: 70 }, { origin: 'https://evil.example' });
  assert.deepEqual([b.status, b.json.code], [403, 'bad_origin']);
  const c = await ann.c.post('/api/live/hr', { bpm: 70 }, { origin: null });
  assert.deepEqual([c.status, c.json.code], [403, 'bad_origin']);
  assert.equal((await ann.c.get('/api/live')).json.bpm, null);
});

test('a link key: no cookie and no Origin, source "pulse", and a bad key is 401 bad_key', async () => {
  await fresh();
  const t = clock.t;
  const ok = await keyPost({ samples: [{ t, bpm: 64 }] });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.deepEqual((await ann.c.get('/api/live')).json, { bpm: 64, t, source: 'pulse', recent: [[t, 64]] });
  assert.equal((await ben.c.get('/api/live')).json.bpm, null, 'the key is ann\'s');
  // An Origin from anywhere changes nothing for a key.
  tick(1000);
  assert.equal((await keyPost({ bpm: 65 }, annKey, { origin: 'https://elsewhere.example' })).status, 200);
  assert.equal((await ann.c.get('/api/live')).json.bpm, 65);
  // Bad keys, of every kind. A cookie beside a bad key does not rescue it.
  for (const key of ['hlk_notARealKeyNotARealKeyNotARealKey', 'nope', '']) {
    const bad = await keyPost({ bpm: 70 }, key);
    assert.deepEqual([bad.status, bad.json.code], [401, 'bad_key'], key);
  }
  const both = await keyPost({ bpm: 70 }, 'hlk_notARealKeyNotARealKeyNotARealKey', { cookie: ann.c.cookie, origin: ORIGIN });
  assert.deepEqual([both.status, both.json.code], [401, 'bad_key']);
  const basic = await fetch(`${r.base}/api/live/hr`, { method: 'POST', headers: { authorization: 'Basic abc', 'content-type': 'application/json' }, body: '{"bpm":70}' });
  assert.equal(basic.status, 401);
  assert.equal((await ann.c.get('/api/live')).json.bpm, 65, 'none of them changed anything');
  // A revoked key stops at once.
  const made = (await ben.c.post('/api/link/keys', { label: 'temp' })).json;
  assert.equal((await keyPost({ bpm: 80 }, made.key)).status, 200);
  assert.equal((await ben.c.get('/api/live')).json.bpm, 80);
  await ben.c.del(`/api/link/keys/${made.keys.at(-1).id}`);
  const gone = await keyPost({ bpm: 81 }, made.key);
  assert.deepEqual([gone.status, gone.json.code], [401, 'bad_key']);
});

test('validation: a body that is not the contract is 400; stale and future samples are ignored with a 200', async () => {
  await fresh();
  const t = clock.t;
  for (const body of [{}, { samples: [] }, { samples: [{ t, bpm: 10 }] }, { samples: [{ t, bpm: 300 }] }, { samples: [{ t, bpm: 70.5 }] }, { bpm: 'fast' }, { bpm: 70, source: 7 },
    { samples: Array.from({ length: 21 }, (_, i) => ({ t: t - i, bpm: 70 })) }]) {
    const res = await ann.c.post('/api/live/hr', body);
    assert.deepEqual([res.status, res.json.code], [400, 'bad_request'], JSON.stringify(body).slice(0, 50));
    tick(150);
  }
  const notJson = await ann.c.call('POST', '/api/live/hr', { raw: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(notJson.status, 400);
  assert.equal((await ann.c.get('/api/live')).json.bpm, null);
  tick(2000);
  // Older than 60 s, or more than 5 s ahead: accepted, and not used.
  const now = clock.t;
  const res = await keyPost({ samples: [{ t: now - 60_001, bpm: 50 }, { t: now + 5_001, bpm: 200 }] });
  assert.deepEqual([res.status, res.json], [200, { ok: true }]);
  assert.deepEqual((await ann.c.get('/api/live')).json, { bpm: null, t: null, source: null, recent: [] });
  // The edges themselves are fine, and the good ones in a mixed batch are used.
  const mixed = await keyPost({ samples: [{ t: now - 90_000, bpm: 50 }, { t: now - 60_000, bpm: 61 }, { t: now + 5_000, bpm: 62 }] });
  assert.equal(mixed.status, 200);
  assert.deepEqual((await ann.c.get('/api/live')).json, { bpm: 62, t: now + 5_000, source: 'pulse', recent: [[now - 60_000, 61], [now + 5_000, 62]] });
});

test('bpm 0 (off the skin) clears the live state at once', async () => {
  await fresh();
  const s = stream(ann); await s.opened;
  await keyPost({ samples: [{ t: clock.t - 1000, bpm: 70 }, { t: clock.t, bpm: 71 }] });
  assert.equal((await ann.c.get('/api/live')).json.bpm, 71);
  tick(1000);
  assert.equal((await keyPost({ samples: [{ t: clock.t, bpm: 0 }] })).status, 200);
  assert.deepEqual((await ann.c.get('/api/live')).json, { bpm: null, t: null, source: null, recent: [] });
  assert.equal((await ann.c.get('/api/data')).json.live, null);
  const got = await s.until(2);
  assert.deepEqual(got, [{ bpm: 71, t: clock.t - 1000, source: 'pulse' }, { bpm: null, t: clock.t, source: null }]);
  // A zero when nothing is live says nothing; a reading after it starts again.
  tick(1000);
  await keyPost({ bpm: 0 });
  tick(1000);
  await keyPost({ samples: [{ t: clock.t - 500, bpm: 0 }, { t: clock.t, bpm: 66 }] });
  assert.equal((await ann.c.get('/api/live')).json.bpm, 66);
  assert.deepEqual((await s.until(3)).slice(2), [{ bpm: 66, t: clock.t, source: 'pulse' }]);
  s.close();
});

test('it ends 10 seconds after the last sample, and says so once', async () => {
  await fresh();
  const s = stream(ann); await s.opened;
  const t = clock.t;
  await ann.c.post('/api/live/hr', { samples: [{ t, bpm: 120 }] });
  tick(9_999);
  assert.equal((await ann.c.get('/api/live')).json.bpm, 120);
  assert.deepEqual((await ann.c.get('/api/data')).json.live, { bpm: 120, t, source: 'browser' });
  tick(1);
  const after = (await ann.c.get('/api/live')).json;
  assert.deepEqual([after.bpm, after.t, after.source], [null, null, null]);
  assert.deepEqual(after.recent, [[t, 120]], 'the last two minutes stay for the sparkline until they age out');
  assert.equal((await ann.c.get('/api/data')).json.live, null);
  r.app.live.sweep(); r.app.live.sweep();
  assert.deepEqual(await s.until(2), [{ bpm: 120, t, source: 'browser' }, { bpm: null, t: clock.t, source: null }]);
  await settle();
  assert.equal(s.live().length, 2, 'the end is one event');
  // A sample that keeps arriving keeps it alive.
  for (let i = 0; i < 15; i += 1) { tick(1000); await ann.c.post('/api/live/hr', { bpm: 100 + i }); }
  assert.equal((await ann.c.get('/api/live')).json.bpm, 114);
  tick(121_000);
  assert.deepEqual((await ann.c.get('/api/live')).json.recent, []);
  s.close();
});

test('the live event reaches that person\'s own tabs and nobody else\'s, about once a second', async () => {
  await fresh();
  const tab1 = stream(ann); const tab2 = stream(ann); const other = stream(ben);
  await Promise.all([tab1.opened, tab2.opened, other.opened]);
  const t0 = clock.t;
  await keyPost({ samples: [{ t: t0, bpm: 101 }] });
  assert.deepEqual(await tab1.until(1), [{ bpm: 101, t: t0, source: 'pulse' }]);
  assert.deepEqual(await tab2.until(1), [{ bpm: 101, t: t0, source: 'pulse' }]);
  // Three more inside the same second: no event each.
  for (const ms of [200, 200, 200]) { tick(ms); await keyPost({ samples: [{ t: clock.t, bpm: 102 }] }); }
  await settle();
  assert.equal(tab1.live().length, 1);
  // The second is up: the newest goes out, once.
  tick(400); r.app.live.sweep();
  assert.deepEqual((await tab1.until(2))[1], { bpm: 102, t: t0 + 600, source: 'pulse' });
  // A batch is one event, for its newest reading.
  tick(1000);
  await keyPost({ samples: [{ t: clock.t - 800, bpm: 103 }, { t: clock.t - 400, bpm: 104 }, { t: clock.t, bpm: 105 }] });
  assert.deepEqual((await tab1.until(3))[2], { bpm: 105, t: clock.t, source: 'pulse' });
  assert.equal((await tab2.until(3)).length, 3);
  // Ben is live too, with his own number, on his own stream.
  const benKey = (await ben.c.post('/api/link/keys', {})).json.key;
  await keyPost({ bpm: 55 }, benKey);
  assert.deepEqual(await other.until(1), [{ bpm: 55, t: clock.t, source: 'pulse' }]);
  await settle();
  assert.equal(tab1.live().length, 3, 'ann saw none of ben\'s');
  assert.ok(tab1.live().every((e) => e.bpm !== 55));
  assert.equal(other.live().length, 1, 'and ben saw none of ann\'s');
  assert.ok(other.events.every((e) => e.event === 'hello' || e.event === 'live' || e.event === 'changed'));
  // The end goes to each of them separately.
  tick(10_000); r.app.live.sweep();
  assert.deepEqual((await tab1.until(4))[3], { bpm: null, t: clock.t, source: null });
  assert.deepEqual((await other.until(2))[1], { bpm: null, t: clock.t, source: null });
  tab1.close(); tab2.close(); other.close();
});

test('ten requests a second per person, then 429; the next second is open again', async () => {
  await fresh();
  const codes = [];
  for (let i = 0; i < 10; i += 1) codes.push((await keyPost({ bpm: 70 + i })).status);
  assert.deepEqual(codes, Array(10).fill(200));
  const over = await keyPost({ bpm: 90 });
  assert.deepEqual([over.status, over.json.code], [429, 'rate_limited']);
  assert.equal(over.headers.get('retry-after'), '1');
  // The limit is the person's: the session route shares it, somebody else does not.
  assert.equal((await ann.c.post('/api/live/hr', { bpm: 91 })).status, 429);
  assert.equal((await ben.c.post('/api/live/hr', { bpm: 60 })).status, 200);
  assert.equal((await ann.c.get('/api/live')).json.bpm, 79, 'the refused ones were not used');
  tick(1000);
  assert.equal((await keyPost({ bpm: 92 })).status, 200);
});

test('nothing is persisted: no file changes, no export, and a restart forgets', async () => {
  await fresh();
  const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
  const snapshot = () => Object.fromEntries(files(join(r.dir, 'data')).map((p) => [p, createHash('sha1').update(readFileSync(p)).digest('hex')]));
  // Open ann's own database, and let the key's "last used" land, first.
  await ann.c.get('/api/data');
  await keyPost({ bpm: 70 });
  const before = snapshot();
  assert.ok(Object.keys(before).length >= 2, 'the app database and ann\'s own');
  const rev = await r.app.worlds.hold(ann.id, async (w) => w.db.rev);
  for (let i = 0; i < 30; i += 1) {
    tick(1000);
    assert.equal((await keyPost({ samples: [{ t: clock.t, bpm: 171 + (i % 5) }] })).status, 200);
    assert.equal((await ann.c.post('/api/live/hr', { samples: [{ t: clock.t, bpm: 173 }] })).status, 200);
  }
  assert.equal((await ann.c.get('/api/live')).json.recent.length, 31);
  assert.deepEqual(snapshot(), before, 'not one byte on disk moved');
  assert.equal(await r.app.worlds.hold(ann.id, async (w) => w.db.rev), rev);
  assert.equal(r.app.app.get('SELECT COUNT(*) AS n FROM daily_public WHERE user_id = ?', ann.id)?.n ?? 0, 0);
  const exported = (await ann.c.get('/api/export')).text;
  assert.ok(!exported.includes('"live"') && !/"bpm":\s*17[1-5]\b/.test(exported), 'the export has no live readings');
  // Deleting your data ends it too.
  await ann.c.post('/api/account/delete-data', { confirm: 'ann' });
  assert.equal(r.app.live.latest(ann.id), null);
  assert.equal(r.app.live.people.has(ann.id), false);
});
