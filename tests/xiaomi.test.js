/* The Xiaomi scale, through the routes, against the stand-in Xiaomi cloud
   (server/fake-sources.js): the QR sign-in, choosing whose weigh-ins are
   yours, what a weigh-in becomes here, a session renewed, Google, letting go. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { rc4, fromRecord } from '../server/xiaomi.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });
const ok = async (res) => { assert.equal(res.status, 200, res.text); return res.json; };

/** Wait for the page's view of the scale to say something. */
async function until(p, test1, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ok(await p.c.get('/api/xiaomi'));
    if (test1(v)) return v;
    if (Date.now() > end) assert.fail(`never: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** Sign in with the QR code, scanned at once. */
async function connect(p) {
  const s = await ok(await p.c.post('/api/xiaomi/start', {}));
  assert.equal(s.pending.state, 'waiting');
  r.xiaomi.scan();
  return until(p, (v) => v.connected && v.lastSync);
}

test('the cipher and a record', () => {
  const key = Buffer.alloc(32, 7);
  const x = rc4(key, Buffer.from('{"a":1}'));
  assert.equal(rc4(key, x).toString(), '{"a":1}');
  const w = fromRecord({ createTime: 1_790_000_000, data: JSON.stringify({ weight: 80.15, bfp: 19.2, slm: 60.1, bwp: 55, bmc: 3.2, pm: 18, vfl: 9, bmr: 1750, ma: 31, heartRate: 0, bodyRes: 500, userType: 2 }) });
  assert.deepEqual([w.t, w.profile, w.weightKg, w.fatPct, w.muscleKg, w.heartRate, w.impedance], [1_790_000_000_000, '2', 80.15, 19.2, 60.1, null, 500]);
  assert.equal(fromRecord({ createTime: 1, data: '{"weight":0}' }), null);
  assert.equal(fromRecord({ createTime: 1, data: 'not json' }), null);
});

test('connecting with the QR code; two people on the scale: nothing is written until you say which is you', async () => {
  const p = await personWith(r, 'weigher1');
  r.xiaomi.state.records.length = 0;
  const t0 = Date.now() - 3 * HOUR;
  r.xiaomi.weighIn({ t: t0, kg: 81.4, profile: 1 });
  r.xiaomi.weighIn({ t: t0 + 20 * MIN, kg: 62.3, profile: 2, fat: 27.1 });
  r.xiaomi.weighIn({ t: t0 + HOUR, kg: 81.1, profile: 1, fat: 18.2 });
  const before = await ok(await p.c.get('/api/xiaomi'));
  assert.deepEqual([before.connected, before.pending], [false, null]);
  const s = await ok(await p.c.post('/api/xiaomi/start', {}));
  assert.match(s.pending.qr, /^data:image\/png;base64,/);
  assert.match(s.pending.loginUrl, /^https:\/\/account\.xiaomi\.com\//);
  r.xiaomi.scan();
  const v = await until(p, (x) => x.connected && x.lastSync);
  assert.ok(!JSON.stringify(v).includes('pass-token'), 'no token in a reply');
  assert.equal(r.app.app.secretRow(p.id, 'xiaomi').last4, '431');
  assert.deepEqual([v.account, v.region, v.profile, v.count], ['…431', 'sg', null, 0]);
  assert.deepEqual(v.profiles.map((x) => [x.id, x.n, x.lastKg]), [['1', 2, 81.1], ['2', 1, 62.3]]);
  assert.equal((await ok(await p.c.get('/api/me'))).xiaomi.connected, true);
  // Not one of them.
  assert.equal((await p.c.post('/api/xiaomi/profile', { profile: '7' })).status, 400);
  const pick = await ok(await p.c.post('/api/xiaomi/profile', { profile: '1' }));
  assert.deepEqual([pick.result.ok, pick.result.added, pick.xiaomi.profile, pick.xiaomi.count], [true, 2, '1', 2]);
  // What a weigh-in became: the weight, the body fat, the composition.
  const wt = await ok(await p.c.get('/api/metric/weight?range=week'));
  const mine = wt.entries.filter((e) => e.source === 'scale' || e.t === t0 || e.t === t0 + HOUR);
  assert.deepEqual(mine.map((e) => e.value).sort(), [81.1, 81.4]);
  assert.ok(!wt.entries.some((e) => e.value === 62.3), 'the other person\'s weigh-in is not here');
  const bc = await ok(await p.c.get('/api/metric/body_composition?range=week'));
  assert.equal(bc.entries.length, 2);
  assert.equal(bc.entries[0].text, '81.1 kg, fat 18.2%, muscle 58.2 kg, water 56.1%');
  assert.deepEqual(bc.entries[0].details.slice(0, 3), [{ label: 'Weight', value: 81.1, unit: 'kg' }, { label: 'Body fat', value: 18.2, unit: '%' }, { label: 'Muscle', value: 58.2, unit: 'kg' }]);
  assert.deepEqual([bc.entries[0].source, bc.entries[0].deletable, bc.entries[0].editable], ['scale', false, false]);
  const bf = await ok(await p.c.get('/api/metric/body_fat?range=week'));
  assert.ok(bf.entries.some((e) => e.source === 'scale' && e.value === 18.2));
  // The next pass brings only what is new, once.
  r.xiaomi.weighIn({ t: Date.now() - 5 * MIN, kg: 80.9, profile: 1 });
  const again = await ok(await p.c.post('/api/xiaomi/sync', {}));
  assert.deepEqual([again.result.ok, again.result.added, again.xiaomi.count], [true, 1, 3]);
});

test('a session Xiaomi stops taking is renewed from the pass token; a pass token it stops taking ends the connection', async () => {
  const p = await personWith(r, 'weigher2');
  r.xiaomi.state.records.length = 0;
  r.xiaomi.weighIn({ t: Date.now() - HOUR, kg: 75.2, profile: 1 });
  const v = await connect(p);
  assert.deepEqual([v.profile, v.count], ['1', 1], 'one person on the scale: that is them');
  const logins = r.xiaomi.state.logins;
  r.xiaomi.dropSession();
  r.xiaomi.weighIn({ t: Date.now() - 10 * MIN, kg: 75.0, profile: 1 });
  const x = await r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true, only: 'xiaomi' }));
  assert.deepEqual([x.xiaomi.ok, x.xiaomi.added, r.xiaomi.state.logins], [true, 1, logins + 1]);
  // Signed out on Xiaomi's side.
  r.xiaomi.dropSession();
  r.xiaomi.state.passOk = false;
  const y = await r.app.worlds.hold(p.id, (w) => r.app.syncExtras(p.id, w, { force: true, only: 'xiaomi' }));
  r.xiaomi.state.passOk = true;
  assert.equal(y.xiaomi.code, 'auth');
  const gone = await ok(await p.c.get('/api/xiaomi'));
  assert.deepEqual([gone.connected, gone.lost, gone.count], [false, true, 2], 'what it brought is kept');
});

test('to Google: weight and body fat, unless Google has that weigh-in or the switch is off', async () => {
  const p = await personWith(r, 'weigher3');
  const sent = [];
  r.wrap.fn = async (uid, url, init) => { if (uid === p.id && (init?.method || 'GET') === 'POST' && /dataTypes\/(weight|body-fat)\/dataPoints$/.test(url.pathname)) sent.push([url.pathname.split('/').at(-2), JSON.parse(init.body)]); return null; };
  try {
    r.xiaomi.state.records.length = 0;
    const t = Date.now() - 2 * HOUR;
    r.xiaomi.weighIn({ t, kg: 70.5, profile: 1, fat: 15.5 });
    const v = await connect(p);
    assert.equal(v.count, 1);
    assert.deepEqual(sent.map((x) => x[0]), ['weight', 'body-fat']);
    assert.equal(sent[0][1].weight.weightGrams, 70500);
    assert.equal(sent[1][1].bodyFat.percentage, 15.5);
    // Switched off: the next weigh-in stays here.
    await ok(await p.c.patch('/api/xiaomi/settings', { toGoogle: false }));
    r.xiaomi.weighIn({ t: Date.now() - 30 * MIN, kg: 70.2, profile: 1 });
    await ok(await p.c.post('/api/xiaomi/sync', {}));
    assert.equal(sent.length, 2);
  } finally { r.wrap.fn = null; }
});

test('a code nobody scans expires; cancelling stops it; letting go keeps the data or takes it away', async () => {
  const p = await personWith(r, 'weigher4');
  await ok(await p.c.post('/api/xiaomi/start', {}));
  r.xiaomi.state.expired = true;
  const v = await until(p, (x) => x.pending?.state === 'expired');
  assert.equal(v.connected, false);
  assert.equal(v.pending.qr, null, 'an expired code is not shown');
  r.xiaomi.state.expired = false;
  // Cancelled: a scan after it connects nothing.
  await ok(await p.c.post('/api/xiaomi/start', {}));
  const cx = await ok(await p.c.post('/api/xiaomi/cancel', {}));
  assert.equal(cx.pending, null);
  r.xiaomi.scan();
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(r.app.app.secretRow(p.id, 'xiaomi'), null);
  // Connect, then let go and take the data with it.
  r.xiaomi.state.records.length = 0;
  r.xiaomi.weighIn({ t: Date.now() - HOUR, kg: 90.1, profile: 1 });
  const c = await connect(p);
  assert.equal(c.count, 1);
  const off = await ok(await p.c.post('/api/xiaomi/disconnect', { keepData: false }));
  assert.deepEqual([off.connected, off.count, off.profile], [false, 0, null]);
  assert.equal(r.app.app.secretRow(p.id, 'xiaomi'), null);
  const wt = await ok(await p.c.get('/api/metric/weight?range=week'));
  assert.ok(!wt.entries.some((e) => e.value === 90.1));
});
