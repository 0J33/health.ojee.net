/* Withings (server/withings.js) against a stand-in for its API: a measure
   group read as a weigh-in, the sign-in swap, a token renewed, a pass
   (new, changed, deleted), letting go; and the scales beside each other:
   a Garmin Index's composition, a copy from Health Connect not kept twice,
   and the Xiaomi scale's clean-up leaving other scales' rows alone. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/core/db.js';
import { mergeAll } from '../server/core/merge.js';
import { readWeights } from '../server/garmin.js';
import { dropOthers, applyWeighIn } from '../server/xiaomisync.js';
import {
  readGroup, applyWithings, syncWithings, forgetWithings, withingsView, withingsExchange, WithingsApi, notifyToken, notifySigned,
} from '../server/withings.js';

const TZ = 'Africa/Cairo';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 6, 30) ;   // 08:30 in Cairo

/** A measure group as Withings sends it. */
const group = (grpid, t, { kg = 72.4, fat = 18.2, muscle = 56.1, water = 41.0, bone = 2.9, attrib = 0, modified = null } = {}) => ({
  grpid, attrib, date: Math.floor(t / 1000), created: Math.floor(t / 1000), modified: modified ?? Math.floor(t / 1000), category: 1, deviceid: 'dev1',
  measures: [
    { value: Math.round(kg * 1000), unit: -3, type: 1 },
    ...(fat === null ? [] : [{ value: Math.round(fat * 1000), unit: -3, type: 6 }]),
    ...(muscle === null ? [] : [{ value: Math.round(muscle * 100), unit: -2, type: 76 }]),
    ...(water === null ? [] : [{ value: Math.round(water * 100), unit: -2, type: 77 }]),
    ...(bone === null ? [] : [{ value: Math.round(bone * 100), unit: -2, type: 88 }]),
    { value: 9, unit: 0, type: 170 }, { value: 1650, unit: 0, type: 226 }, { value: 62, unit: 0, type: 11 },
  ],
});

/** A stand-in Withings: its groups, its tokens, and every call made to it. */
function fakeWithings({ groups = [] } = {}) {
  const s = { groups, calls: [], access: 'acc-1', refresh: 'ref-1', n: 1, expireNext: false, subscribed: [] };
  s.fetch = async (url, init) => {
    const u = new URL(url);
    const b = new URLSearchParams(init.body.toString());
    s.calls.push({ path: u.pathname, action: b.get('action'), body: Object.fromEntries(b), auth: init.headers.authorization || null });
    const json = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j });
    if (u.pathname === '/v2/oauth2') {
      if (b.get('grant_type') === 'authorization_code') return json(b.get('code') === 'good' ? { status: 0, body: { userid: 4242, access_token: s.access, refresh_token: s.refresh, expires_in: 10800, scope: 'user.metrics,user.info' } } : { status: 503, error: 'Invalid Params: invalid code' });
      if (b.get('refresh_token') !== s.refresh) return json({ status: 503, error: 'Invalid Params: invalid refresh_token' });
      s.n += 1; s.access = `acc-${s.n}`; s.refresh = `ref-${s.n}`;
      return json({ status: 0, body: { userid: 4242, access_token: s.access, refresh_token: s.refresh, expires_in: 10800 } });
    }
    if (init.headers.authorization !== `Bearer ${s.access}` || s.expireNext) { s.expireNext = false; return json({ status: 401, error: 'invalid_token' }); }
    if (u.pathname === '/notify') { s.subscribed.push(b.get('callbackurl')); return json({ status: 0, body: {} }); }
    if (u.pathname === '/measure') {
      let list = s.groups;
      if (b.get('lastupdate')) list = list.filter((g) => g.modified >= Number(b.get('lastupdate')));
      if (b.get('startdate')) list = list.filter((g) => g.date >= Number(b.get('startdate')) && g.date <= Number(b.get('enddate')));
      const off = Number(b.get('offset') || 0);
      const page = list.slice(off, off + 2);
      return json({ status: 0, body: { updatetime: Math.floor(Date.now() / 1000), timezone: TZ, measuregrps: page, more: off + 2 < list.length ? 1 : 0, offset: off + 2 < list.length ? off + 2 : 0 } });
    }
    return json({ status: 2554, error: 'unknown action' });
  };
  return s;
}
const apiOf = (s, tokens = { access: s.access, refresh: s.refresh, expiresAt: Date.now() + 3 * 3600_000 }, onTokens = () => {}) =>
  new WithingsApi({ clientId: 'cid', clientSecret: 'sec', tokens, onTokens, fetchImpl: s.fetch, base: 'https://wbsapi.test' });

test('a measure group is a weigh-in; a guest\'s and an objective are not', () => {
  const w = readGroup(group(11, T0));
  assert.equal(w.id, '11');
  assert.equal(w.t, Math.floor(T0 / 1000) * 1000);
  assert.equal(w.weightKg, 72.4);
  assert.equal(w.fatPct, 18.2);
  assert.equal(w.muscleKg, 56.1);
  assert.equal(w.waterPct, 56.6);   // 41 kg of 72.4
  assert.equal(w.boneKg, 2.9);
  assert.equal(w.visceral, 9);
  assert.equal(w.bmr, 1650);
  assert.equal(w.heartRate, 62);
  assert.equal(readGroup(group(12, T0, { attrib: 1 })), null);
  assert.equal(readGroup({ ...group(13, T0), category: 2 }), null);
  // Fat mass alone gives the share.
  const g = group(14, T0, { fat: null });
  g.measures.push({ value: 14480, unit: -3, type: 8 });
  assert.equal(readGroup(g).fatPct, 20);
  // No weight in it (a blood-pressure monitor's pulse): not a weigh-in.
  assert.equal(readGroup({ ...group(15, T0), measures: [{ value: 70, unit: 0, type: 11 }] }), null);
});

test('the sign-in code is swapped for tokens, and a token Withings stops taking is renewed once', async () => {
  const s = fakeWithings({ groups: [group(1, T0)] });
  const r = await withingsExchange({ clientId: 'cid', clientSecret: 'sec', code: 'good', redirectUri: 'https://x/cb', fetchImpl: s.fetch, base: 'https://wbsapi.test', now: 1000 });
  assert.equal(r.userId, '4242');
  assert.equal(r.tokens.refresh, 'ref-1');
  await assert.rejects(withingsExchange({ clientId: 'cid', clientSecret: 'sec', code: 'bad', redirectUri: 'https://x/cb', fetchImpl: s.fetch, base: 'https://wbsapi.test' }), (e) => e.code === 'withings_auth');

  let kept = null;
  const api = apiOf(s, r.tokens.expiresAt > Date.now() ? r.tokens : { ...r.tokens, expiresAt: Date.now() + 3600_000 }, (t) => { kept = t; });
  s.expireNext = true;
  const m = await api.measures({ startdate: 0, enddate: Math.floor(T0 / 1000) + 10 });
  assert.equal(m.groups.length, 1);
  assert.equal(kept.refresh, 'ref-2', 'the new refresh token is kept at once');
  // A refresh token Withings no longer has: the connection is lost.
  const stale = apiOf(s, { access: 'old', refresh: 'ref-1', expiresAt: 0 });
  await assert.rejects(stale.measures({ lastupdate: 1 }), (e) => e.code === 'withings_auth');
});

test('a pass brings weigh-ins in, keeps changes, and takes away what was deleted at Withings', async () => {
  const db = openDb();
  const s = fakeWithings({ groups: [group(1, T0 - 2 * DAY), group(2, T0 - DAY), group(3, T0)] });
  let r = await syncWithings({ db, api: apiOf(s), tz: TZ });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.added, 3);
  assert.equal(db.weights(0).filter((w) => w.source === 'withings').length, 3);
  assert.equal(db.samples('bodycomp', { limit: 10 }).length, 3);
  assert.equal(db.samples('bodyfat', { limit: 10 }).length, 3);
  const date = new Date(T0 + 2 * 3600_000).toISOString().slice(0, 10);
  assert.equal(db.dailyValue(date, 'body_fat'), 18.2);

  // Nothing new: nothing written.
  r = await syncWithings({ db, api: apiOf(s), tz: TZ });
  assert.equal(r.added + r.updated + r.removed, 0);

  // Changed at Withings (the weight corrected), and one deleted there.
  s.groups = [group(1, T0 - 2 * DAY), group(3, T0, { kg: 71.9, fat: 17.9, modified: Math.floor(Date.now() / 1000) + 5 })];
  db.setMeta('withings', { ...db.meta('withings'), checkedAt: 0 });
  r = await syncWithings({ db, api: apiOf(s), tz: TZ });
  assert.equal(r.updated, 1);
  assert.equal(r.removed, 1);
  const ws = db.weights(0).filter((w) => w.source === 'withings').map((w) => w.grams).sort();
  assert.deepEqual(ws, [71900, 72400]);
  assert.equal(db.dailyValue(date, 'body_fat'), 17.9);
  const v = withingsView(db, { configured: true, connected: true });
  assert.equal(v.count, 2);
  assert.equal(v.last.weightKg, 71.9);

  // Let go of, with what it brought.
  forgetWithings(db, { keepData: false });
  assert.equal(db.weights(0).length, 0);
  assert.equal(db.samples('bodycomp', { limit: 10 }).length, 0);
  assert.equal(db.dailyValue(date, 'body_fat'), null);
});

test('a weigh-in already here from elsewhere is not written twice, either way round', () => {
  const db = openDb();
  const t = Math.floor(T0 / 1000) * 1000;
  // Health Connect's copy first: Withings keeps its composition, not a second weight.
  db.upsertWeight({ t: t + 60_000, grams: 72400, off: 7200, source: 'hc', note: null });
  applyWithings({ db, w: readGroup(group(5, T0)), tz: TZ, now: Date.now() });
  assert.equal(db.weights(0).length, 1);
  assert.equal(db.samples('bodycomp', { limit: 5 }).length, 1);

  // Withings first: the copy that comes back through Health Connect is not kept beside it.
  const main = openDb();
  applyWithings({ db: main, w: readGroup(group(6, T0)), tz: TZ, now: Date.now() });
  const hc = openDb();
  hc.upsertWeight({ t: t + 90_000, grams: 72400, off: 7200, source: 'hc', note: null });
  hc.upsertWeight({ t: t + 5 * DAY, grams: 72000, off: 7200, source: 'hc', note: null });
  mergeAll(main, [{ db: hc }]);
  assert.deepEqual(main.weights(0).map((w) => w.source), ['withings', 'hc']);
});

test('a Garmin Index weigh-in brings its composition', () => {
  const ws = readWeights({ dailyWeightSummaries: [{ allWeightMetrics: [
    { samplePk: 9, timestampGMT: T0, weight: 72400, bodyFat: 18.2, bodyWater: 55.1, muscleMass: 33500, boneMass: 3100, visceralFat: 8, metabolicAge: 31, bmi: 22.9, sourceType: 'INDEX_SCALE' },
    { samplePk: 10, timestampGMT: T0 + DAY, weight: 72100, sourceType: 'MANUAL' },
  ] }] });
  assert.deepEqual(ws[0].comp, { weightKg: 72.4, fatPct: 18.2, muscleKg: 33.5, boneKg: 3.1, waterPct: 55.1, visceral: 8, metabolicAge: 31, bmi: 22.9, sourceType: 'INDEX_SCALE' });
  assert.equal(ws[1].comp, null);
});

test('the Xiaomi scale\'s clean-up leaves another scale\'s weigh-ins alone', () => {
  const db = openDb();
  applyWithings({ db, w: readGroup(group(7, T0)), tz: TZ, now: Date.now() });
  applyWeighIn({ db, w: { t: T0 + DAY, weightKg: 70, fatPct: 20, profile: 'p1' }, tz: TZ, now: Date.now() });
  dropOthers(db, null);
  const left = db.samples('bodycomp', { limit: 10 });
  assert.deepEqual(left.map((r) => r.source), ['withings']);
  assert.equal(db.weights(0).filter((w) => w.source === 'withings').length, 1);
});

test('a notification\'s token is the site\'s own', () => {
  const tok = notifyToken('sec');
  assert.equal(notifySigned('sec', tok), true);
  assert.equal(notifySigned('sec', `${tok.slice(0, -1)}x`), false);
  assert.equal(notifySigned('other', tok), false);
  assert.equal(notifySigned('sec', ''), false);
});

test('through the routes: not offered unset; sign-in, first read, a notification, letting go', async () => {
  const { rig } = await import('./helpers.mjs');
  const off = await rig();
  try {
    const p = await off.person('nowithings');
    assert.equal((await p.c.get('/api/me')).json.withings.configured, false);
    assert.match((await p.c.get('/auth/withings/start')).headers.get('location'), /withings=error/);
    assert.equal((await p.c.post('/api/withings/sync', {})).status, 409);
    assert.equal((await p.c.get('/api/withings/notify')).status, 404);
    assert.equal(off.withings.calls.length, 0, 'Withings is never called');
  } finally { await off.close(); }

  const r = await rig({ env: { WITHINGS_CLIENT_ID: 'wid', WITHINGS_CLIENT_SECRET: 'wsec' } });
  const s = fakeWithings({ groups: [group(21, Date.now() - 2 * DAY), group(22, Date.now() - DAY)] });
  r.withings.fn = (u, init) => s.fetch(u, init);
  try {
    const p = await r.person('scaled');
    const other = await r.person('notscaled');
    assert.deepEqual(Object.values((await p.c.get('/api/me')).json.withings), [true, false, false]);
    const start = await p.c.get('/auth/withings/start?return=/settings/connections/devices/scale/withings');
    const to = new URL(start.headers.get('location'));
    assert.equal(to.origin + to.pathname, 'https://withings.test/oauth2_user/authorize2');
    assert.equal(to.searchParams.get('redirect_uri'), 'https://health.test/auth/withings/callback');
    assert.equal(to.searchParams.get('scope'), 'user.metrics,user.info');
    // Someone else cannot finish this sign-in.
    const stolen = await other.c.get(`/auth/withings/callback?state=${to.searchParams.get('state')}&code=good`);
    assert.match(stolen.headers.get('location'), /withings=error/);
    const s2 = new URL((await p.c.get('/auth/withings/start')).headers.get('location'));
    const back = await p.c.get(`/auth/withings/callback?state=${s2.searchParams.get('state')}&code=good`);
    assert.match(back.headers.get('location'), /withings=connected/);
    assert.ok(!JSON.stringify(r.app.app.secretRow(p.id, 'withings')).includes('ref-'), 'the tokens are sealed');
    const sync = await p.c.post('/api/withings/sync', {});
    assert.equal(sync.status, 200, sync.text);
    const v = (await p.c.get('/api/withings')).json;
    assert.deepEqual([v.connected, v.count], [true, 2]);
    assert.ok(!JSON.stringify(v).includes('acc-'), 'no token in a reply');
    // Told of new weigh-ins at the notify address, with the site's token.
    const sub = s.subscribed[0];
    assert.ok(sub && sub.startsWith('https://health.test/api/withings/notify?token='), sub);
    assert.equal((await p.c.get('/api/withings/notify')).status, 200, 'Withings\' check of the address');
    s.groups.push(group(23, Date.now() - 60_000, { modified: Math.floor(Date.now() / 1000) + 1 }));
    const bad = await fetch(`${r.base}/api/withings/notify?token=nope`, { method: 'POST', body: 'userid=4242&appli=1' });
    assert.equal(bad.status, 401);
    const good = await fetch(`${r.base}/api/withings/notify?${new URL(sub).search.slice(1)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'userid=4242&appli=1&startdate=1&enddate=2' });
    assert.equal(good.status, 200);
    const end = Date.now() + 3000;
    while ((await p.c.get('/api/withings')).json.count < 3) { assert.ok(Date.now() < end, 'the notification brought the new weigh-in'); await new Promise((res) => setTimeout(res, 20)); }
    // Letting go, with what it brought.
    const gone = await p.c.post('/api/withings/disconnect', { keepData: false });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.connected, false);
    assert.equal(r.app.app.secretRow(p.id, 'withings'), null);
    await r.app.worlds.hold(p.id, (w) => { assert.equal(w.db.weights(0).filter((x) => x.source === 'withings').length, 0); });
  } finally { await r.close(); }
});
