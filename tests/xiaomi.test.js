/* The Xiaomi scale, through the routes, against the stand-in Xiaomi cloud
   (server/fake-sources.js): the QR sign-in, choosing whose weigh-ins are
   yours, what a weigh-in becomes here, a session renewed, Google, letting go. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { rc4, fromRecord, personOf } from '../server/xiaomi.js';

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
  // The shape the real S400 sends: a family member (userType 2, like every
  // family member) told apart by the record's accountId.
  const w = fromRecord({ uid: 6900161431, accountId: 547297076586521, createTime: 1_793_353_639_000,
    data: JSON.stringify({ miid: '6900161431', userType: '2', weight: 59.5, heartRate: '0', bfp: 34.7, slm: 36.7, bwp: 46.9, bmc: 2.2, vfl: '10', pp: 14.1, pm: 8.4, bmr: '1210', ma: '45', bodyRes: 596, bodyRes2: 537, user: { type: 2, name: 'Rania', accountId: '547297076586521', uid: '6900161431' } }) });
  assert.deepEqual([w.t, w.profile, w.name, w.owner, w.weightKg, w.fatPct, w.muscleKg, w.proteinPct, w.visceral, w.heartRate, w.impedance], [1_793_353_639_000, '547297076586521', 'Rania', false, 59.5, 34.7, 36.7, 14.1, 10, null, 596]);
  const own = fromRecord({ uid: 6900161431, accountId: 6900161431, createTime: 1_793_352_080_000, data: JSON.stringify({ userType: '1', weight: 73.5, user: { name: 'Omar' } }) });
  assert.deepEqual([own.profile, own.name, own.owner], ['6900161431', 'Omar', true]);
  assert.deepEqual([w.proteinKg, w.bmi, w.bodyType, w.person], [8.4, null, null, null], 'protein in kg kept; this record says nothing about who she is');
  // What a record could say about the person, in the shapes Xiaomi uses.
  assert.deepEqual(personOf({ sex: '2', height: '160', birthday: '1981-03-02' }), { sex: 'female', birthYear: 1981, heightCm: 160 });
  assert.deepEqual(personOf({ gender: 'male', height: 1.78 }), { sex: 'male', birthYear: null, heightCm: 178 });
  assert.deepEqual(personOf({ sex: '0', height: 20, birthday: 'soon' }), null);
  assert.equal(fromRecord({ createTime: 1, data: '{"weight":0}' }), null);
  assert.equal(fromRecord({ createTime: 1, data: 'not json' }), null);
});

const OWNER = '6170431';
const RANIA = '400000002';
const HABIBA = '400000003';

test('connecting with the QR code; three people on the scale, two of them family members: each is a choice, by name; nothing is written until you pick', async () => {
  const p = await personWith(r, 'weigher1');
  r.xiaomi.state.records.length = 0;
  const t0 = Date.now() - 3 * HOUR;
  r.xiaomi.weighIn({ t: t0, kg: 81.4, profile: 1 });
  r.xiaomi.weighIn({ t: t0 + 20 * MIN, kg: 62.3, profile: 2, fat: 27.1 });
  r.xiaomi.weighIn({ t: t0 + 30 * MIN, kg: 48.2, profile: 3, fat: 25.3 });
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
  assert.deepEqual(v.profiles.map((x) => [x.id, x.name, x.owner, x.n, x.lastKg]), [[OWNER, 'Omar', true, 2, 81.1], [HABIBA, 'Habiba', false, 1, 48.2], [RANIA, 'Rania', false, 1, 62.3]]);
  assert.equal((await ok(await p.c.get('/api/me'))).xiaomi.connected, true);
  // Not one of them.
  assert.equal((await p.c.post('/api/xiaomi/profile', { profile: '7' })).status, 400);
  const pick = await ok(await p.c.post('/api/xiaomi/profile', { profile: OWNER }));
  assert.deepEqual([pick.result.ok, pick.result.added, pick.xiaomi.profile, pick.xiaomi.count], [true, 2, OWNER, 2]);
  // What a weigh-in became: the weight, the body fat, the composition.
  const wt = await ok(await p.c.get('/api/metric/weight?range=week'));
  const mine = wt.entries.filter((e) => e.source === 'scale' || e.t === t0 || e.t === t0 + HOUR);
  assert.deepEqual(mine.map((e) => e.value).sort(), [81.1, 81.4]);
  assert.ok(!wt.entries.some((e) => e.value === 62.3 || e.value === 48.2), 'the other people\'s weigh-ins are not here');
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
  assert.deepEqual([v.profile, v.count], [OWNER, 1], 'one person on the scale: that is them');
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

test('picking the wrong person, then yourself: their weigh-ins go, here and in Google', async () => {
  const p = await personWith(r, 'weigher5');
  const sent = []; const gone = [];
  let seq = 0;
  r.wrap.fn = async (uid, url, init) => {
    if (uid !== p.id || (init?.method || 'GET') !== 'POST') return null;
    const m = /dataTypes\/(weight|body-fat)\/dataPoints(:batchDelete)?$/.exec(url.pathname);
    if (!m) return null;
    if (m[2]) { gone.push(...JSON.parse(init.body).names); return new Response(JSON.stringify({ done: true }), { headers: { 'content-type': 'application/json' } }); }
    const name = `users/me/dataTypes/${m[1]}/dataPoints/p${(seq += 1)}`;
    sent.push(name);
    return new Response(JSON.stringify({ done: true, response: { name } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    r.xiaomi.state.records.length = 0;
    const t0 = Date.now() - 2 * HOUR;
    r.xiaomi.weighIn({ t: t0, kg: 73.5, profile: 1, fat: 21.9 });
    r.xiaomi.weighIn({ t: t0 + 25 * MIN, kg: 59.5, profile: 2, fat: 34.7 });
    r.xiaomi.weighIn({ t: t0 + 35 * MIN, kg: 46.4, profile: 3, fat: 27.2 });
    await connect(p);
    const wrong = await ok(await p.c.post('/api/xiaomi/profile', { profile: RANIA }));
    assert.deepEqual([wrong.xiaomi.count, sent.length], [1, 2]);
    const raniaInGoogle = sent.slice();
    // A Google sync reads her points back into this site's copy of Google.
    await r.app.worlds.hold(p.id, async (w) => {
      const t = Math.floor((t0 + 25 * MIN) / 1000) * 1000;
      for (const a of w.accounts.values()) { a.db.upsertWeight({ t, grams: 59500, off: 0, source: 'google' }); a.db.sampleUpsert({ kind: 'bodyfat', t, off: 0, date: w.db.sampleGet(`scale-bc-${t}`).date, value: 34.7, gname: 'users/me/dataTypes/body-fat/dataPoints/p2', data: {} }); }
    });
    const right = await ok(await p.c.post('/api/xiaomi/profile', { profile: OWNER }));
    assert.deepEqual([right.xiaomi.profile, right.xiaomi.count], [OWNER, 1]);
    assert.deepEqual(gone.sort(), raniaInGoogle.sort(), 'what was sent of hers is deleted from Google');
    const wt = await ok(await p.c.get('/api/metric/weight?range=week'));
    assert.ok(wt.entries.some((e) => e.value === 73.5));
    assert.ok(!wt.entries.some((e) => e.value === 59.5 || e.value === 46.4));
    await r.app.worlds.hold(p.id, async (w) => {
      const day = w.db.sampleGet(`scale-bf-${Math.floor(t0 / 1000) * 1000}`).date;
      assert.equal(w.db.dailyTable(day)[day].body_fat, 21.9, 'the day\'s body fat is yours again');
    });
  } finally { r.wrap.fn = null; }
});

test('the first version told family members apart by userType: on the next sync the owner keeps theirs, the rest goes, nothing is sent twice', async () => {
  const p = await personWith(r, 'weigher6');
  r.xiaomi.state.records.length = 0;
  const t0 = Date.now() - 2 * HOUR;
  r.xiaomi.weighIn({ t: t0, kg: 73.5, profile: 1, fat: 21.9 });
  r.xiaomi.weighIn({ t: t0 + 25 * MIN, kg: 59.5, profile: 2, fat: 34.7 });
  r.xiaomi.weighIn({ t: t0 + 35 * MIN, kg: 46.4, profile: 3, fat: 27.2 });
  await connect(p);
  await ok(await p.c.post('/api/xiaomi/profile', { profile: OWNER }));
  // Make it look like the first version's store: every weigh-in here, no `who`, old ids.
  await r.app.worlds.hold(p.id, async (w) => {
    const { applyWeighIn, setXiaomiMeta } = await import('../server/xiaomisync.js');
    const { fromRecord: fr } = await import('../server/xiaomi.js');
    for (const rec of r.xiaomi.state.records) applyWeighIn({ db: w.db, w: fr(rec), tz: w.tz, now: Date.now() });
    for (const x of w.db.samples('bodycomp', { limit: 100 })) { const { who, ...d } = x.data; w.db.samplePatch(x.id, { data: { ...d, proteinPct: 14.5, google: 'saved' } }); }
    setXiaomiMeta(w.db, { scheme: undefined, profile: '1', profiles: { 1: { n: 1 }, 2: { n: 2 } } });
  });
  const sent = [];
  r.wrap.fn = async (uid, url, init) => { if (uid === p.id && (init?.method || 'GET') === 'POST' && /dataTypes\/(weight|body-fat)\/dataPoints$/.test(url.pathname)) sent.push(url.pathname); return null; };
  try {
    const x = await ok(await p.c.post('/api/xiaomi/sync', {}));
    assert.deepEqual([x.result.ok, x.xiaomi.profile, x.xiaomi.count, x.xiaomi.profiles.length], [true, OWNER, 1, 3]);
    assert.equal(sent.length, 0, 'the owner\'s weigh-in is not sent to Google again');
    const bc = await ok(await p.c.get('/api/metric/body_composition?range=week'));
    assert.equal(bc.entries[0].details.find((d) => d.label === 'Protein').value, 18.9, 'protein read again as a percentage');
    const wt = await ok(await p.c.get('/api/metric/weight?range=week'));
    assert.ok(!wt.entries.some((e) => e.value === 59.5 || e.value === 46.4));
  } finally { r.wrap.fn = null; }
});

test('everything the scale sends is kept (protein mass, BMI, body type too), and Body composition works it out the way the Xiaomi app does once sex and year of birth are known', async () => {
  const p = await personWith(r, 'weigher7', { persona: 'phone' });
  r.xiaomi.state.records.length = 0;
  const t1 = Date.now() - 3 * HOUR; const t2 = Date.now() - HOUR;
  r.xiaomi.weighIn({ t: t1, kg: 59.9, profile: 2, fat: 34.9, muscle: 36.8, water: 46.8, bone: 2.2, protein: 14.0, visceral: 10, bmr: 1205, age: 46, ohm: 600, bt: 'balanced' });
  r.xiaomi.weighIn({ t: t2, kg: 59.5, profile: 2, fat: 34.7, muscle: 36.7, water: 46.9, bone: 2.2, protein: 14.1, visceral: 10, bmr: 1210, age: 45, ohm: 596 });
  const v = await connect(p);
  assert.deepEqual([v.profile, v.count], [RANIA, 2]);
  await r.app.worlds.hold(p.id, async (w) => {
    const [b, a] = w.db.samples('bodycomp', { limit: 5 }).map((x) => x.data);
    assert.deepEqual([b.proteinKg, b.bmi, b.bodyType, a.bodyType], [8.39, 23.2, undefined, 'balanced']);
    assert.deepEqual([b.impedance, b.metabolicAge, b.who], [596, 45, RANIA]);
  });
  // The scale's record says who she is: sex, birthday, height. Used, until she says otherwise.
  const me = await ok(await p.c.get('/api/me'));
  assert.deepEqual(me.body, { sex: null, birthYear: null, scale: { sex: 'female', birthYear: 1981 } });
  let bc = await ok(await p.c.get('/api/metric/body_composition?range=week'));
  let b = bc.body;
  const year = new Date().getUTCFullYear();
  assert.deepEqual([b.person.sex, b.person.birthYear, b.person.heightCm, b.person.from], ['female', 1981, 160, { sex: 'scale', birthYear: 'scale', height: 'scale' }]);
  assert.deepEqual(b.needs, []);
  const by = (x) => Object.fromEntries(x.metrics.map((m) => [m.id, m]));
  let m = by(b);
  assert.deepEqual([m.fatKg.value, m.leanKg.value, m.waterKg.value, m.proteinKg.value, m.musclePct.value, m.bonePct.value], [20.6, 38.9, 27.9, 8.4, 61.7, 3.7]);
  assert.deepEqual([m.fatPct.range.label, m.proteinPct.range.label, m.visceral.range.label, m.muscleKg.range.label, m.bmi.range.label], [year - 1981 < 60 ? 'Standard' : 'Lean', 'Low', 'High', 'Standard', 'Standard']);
  assert.deepEqual([m.weightKg.change, m.fatPct.change, m.weightKg.sent, m.fatKg.sent], [-0.4, -0.2, true, false]);
  assert.ok(m.skeletalKg.value > 15 && m.skeletalKg.value < 25, 'skeletal muscle, estimated from impedance');
  assert.equal(m.metabolicAge.vsAge, 45 - (year - 1981));
  assert.equal(b.bodyType.from, 'estimate', 'the last weigh-in sent no body type');
  assert.ok(b.score.value > 50 && b.score.value <= 100 && b.score.parts.length === 8);
  assert.equal(b.goals.standardWeight, 54);
  assert.equal(b.history.length, 2);
  assert.deepEqual(b.history.map((x) => x.t), [Math.floor(t1 / 1000) * 1000, Math.floor(t2 / 1000) * 1000]);
  assert.match(b.note, /Our estimate, worked out the way the Xiaomi app does/);
  // Her own choice wins over the scale's.
  assert.equal((await p.c.patch('/api/settings', { body: { sex: 'other' } })).status, 400);
  assert.equal((await p.c.patch('/api/settings', { body: { birthYear: 1800 } })).status, 400);
  assert.equal((await p.c.patch('/api/settings', { body: { birthYear: 1981.5 } })).status, 400);
  const set = await ok(await p.c.patch('/api/settings', { body: { sex: 'male', birthYear: 1990 } }));
  assert.deepEqual([set.body.sex, set.body.birthYear], ['male', 1990]);
  bc = await ok(await p.c.get('/api/metric/body_composition?range=week'));
  b = bc.body; m = by(b);
  assert.deepEqual([b.person.sex, b.person.from.sex, b.person.from.birthYear], ['male', 'you', 'you']);
  assert.equal(m.fatPct.range.label, 'Very high', 'the same number, a man\'s range');
  assert.equal(b.goals.standardWeight, 56);
  // Not set: the scale's again.
  await ok(await p.c.patch('/api/settings', { body: { sex: null } }));
  bc = await ok(await p.c.get('/api/metric/body_composition?range=week'));
  assert.equal(bc.body.person.sex, 'female');
  // The main numbers on their own, with a chart: the scale's, and the score, ours.
  const mm = await ok(await p.c.get('/api/metric/muscle_mass?range=week'));
  assert.deepEqual([mm.metric.latest.value, mm.entries.length, mm.entries[0].source], [36.7, 2, 'scale']);
  const sc = await ok(await p.c.get('/api/metric/body_score?range=week'));
  assert.deepEqual([sc.metric.own, sc.entries[0].source, sc.entries[0].value], [true, 'calculated', bc.body.score.value]);
  for (const id of ['body_water', 'protein_mass', 'bone_mineral', 'visceral_fat', 'basal_rate', 'body_age']) assert.equal((await ok(await p.c.get(`/api/metric/${id}?range=week`))).entries.length, 2, id);
  const browse = await ok(await p.c.get('/api/browse'));
  const have = browse.categories.flatMap((x) => x.metrics).map((x) => x.id);
  for (const id of ['body_composition', 'muscle_mass', 'body_water', 'protein_mass', 'bone_mineral', 'visceral_fat', 'basal_rate', 'body_age', 'body_score']) assert.ok(have.includes(id), id);
});

test('rows kept before protein mass, BMI and the body type were gain them on the next sync, and keep what they had', async () => {
  const p = await personWith(r, 'weigher8', { persona: 'phone' });
  r.xiaomi.state.records.length = 0;
  r.xiaomi.weighIn({ t: Date.now() - 5 * 86_400_000, kg: 70.1, profile: 1, bt: 'balanced' });
  await connect(p);
  await r.app.worlds.hold(p.id, async (w) => {
    const { setXiaomiMeta } = await import('../server/xiaomisync.js');
    for (const x of w.db.samples('bodycomp', { limit: 10 })) { const { proteinKg, bmi, bodyType, ...d } = x.data; w.db.samplePatch(x.id, { data: { ...d, google: 'saved' } }); }
    // An older store: its cursor is recent, so an ordinary pass would not read five days back.
    setXiaomiMeta(w.db, { fields: undefined, cursor: Date.now() - HOUR });
  });
  await ok(await p.c.post('/api/xiaomi/sync', {}));
  await r.app.worlds.hold(p.id, async (w) => {
    const d = w.db.samples('bodycomp', { limit: 10 })[0].data;
    assert.deepEqual([d.proteinKg, d.bmi, d.bodyType, d.google], [13.25, 22.1, 'balanced', 'saved']);
  });
});
