/* Logging by hand through the HTTP routes, against the fake Google:
   create, change and remove; kept local without Google and sent once it
   is there; refused while a group is off. Then the group switch itself,
   and the new settings. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { personWith } from './people.mjs';
import { GROUP_IDS, pkce } from '../server/core/google.js';
import { addDays, today as todayIn } from '../server/core/util.js';

let r;
before(async () => { r = await rig(); });
after(async () => { r.wrap.fn = null; await r.close(); });

const TZ = 'Africa/Cairo';
const today = () => todayIn(Date.now(), TZ);
const ok = async (x) => { assert.equal(x.status, 200, x.text.slice(0, 300)); return x.json; };
const rowsOf = (p, kind) => r.app.worlds.hold(p.id, async (w) => w.db.samples(kind, { limit: 1000 }));
/** What the fake Google holds of one data type that this client wrote. */
const atGoogle = (p, type) => r.app.worlds.hold(p.id, async (w) => w.google.list(type, { dataSourceFamily: 'users/me/dataSourceFamilies/self-sources', pageSize: 1000 }).catch((e) => `refused ${e.status}`));
const ENTRY_KEYS = ['id', 'kind', 'metric', 't', 'end', 'date', 'text', 'value', 'unit', 'source', 'device', 'editable', 'deletable', 'google', 'error', 'fields'];

test('POST /api/entries: every kind goes to Google and comes back as an entry of its metric', async () => {
  const p = await personWith(r, 'logger', { groups: GROUP_IDS });
  const t = today();
  const cases = [
    ['water', { ml: 330 }, 'water', '330 ml', 330, 'ml'],
    ['food', { name: 'Soup', meal: 'LUNCH', kcal: 410, protein: 18 }, 'food', 'Soup, 410 kcal (lunch)', 410, 'kcal'],
    ['mood', { moods: ['CALM', 'GRATEFUL'], valence: 'PLEASANT', note: 'a good walk' }, 'mood', 'Calm, Grateful (pleasant)', 1, null],
    ['symptom', { symptoms: ['HEADACHE', 'FATIGUE'] }, 'symptoms', 'Headache, Fatigue', 2, 'symptoms'],
    ['glucose', { mgdl: 104, timing: 'FASTING' }, 'glucose', '104 mg/dL, fasting', 104, 'mg/dL'],
    ['bodytemp', { celsius: 36.9, location: 'MOUTH' }, 'body_temp', '36.9 °C, mouth', 36.9, '°C'],
    ['height', { cm: 171.5 }, 'height', '171.5 cm', 171.5, 'cm'],
    ['bodyfat', { pct: 21.4 }, 'body_fat', '21.4%', 21.4, '%'],
    ['period', { start: addDays(t, -4), end: addDays(t, -1) }, 'period', `4 days, ${addDays(t, -4)} to ${addDays(t, -1)}`, 4, 'days'],
    ['ovulation', { result: 'POSITIVE' }, 'ovulation', 'Positive', 1, 'tests'],
  ];
  for (const [kind, body, metric, text, value, unit] of cases) {
    const x = await ok(await p.c.post('/api/entries', { kind, ...body }));
    assert.deepEqual(Object.keys(x), ['entry', 'google', 'message'], kind);
    assert.deepEqual(Object.keys(x.entry), ENTRY_KEYS, kind);
    assert.deepEqual([x.google, x.message, x.entry.kind, x.entry.metric, x.entry.text, x.entry.value, x.entry.unit, x.entry.source, x.entry.editable, x.entry.deletable, x.entry.google, x.entry.error],
      ['saved', null, kind, metric, text, value, unit, 'app', true, true, 'saved', null], kind);
    assert.match(x.entry.id, /^l-[0-9a-f-]{36}$/);
    // It heads the entries of its metric, and its fields are what an edit form is filled with.
    const m = await ok(await p.c.get(`/api/metric/${metric}`));
    const e = m.entries.find((q) => q.id === x.entry.id);
    assert.ok(e, `${kind} is in /api/metric/${metric}`);
    for (const [k, v] of Object.entries(body)) assert.deepEqual(e.fields[k], v, `${kind}.${k}`);
  }
  // The store keeps what Google named each point.
  for (const kind of ['water', 'mood', 'period']) { const row = (await rowsOf(p, kind)).find((x) => x.source === 'app'); assert.match(row.gname, new RegExp('/dataPoints/ojee-'), kind); }
  assert.equal((await atGoogle(p, 'hydration-log')).length, 1);
  // A sync reads the nutrition logs back onto the same rows: nothing doubles.
  const before = (await rowsOf(p, 'water')).length;
  await r.app.syncUser(p.id);
  assert.equal((await rowsOf(p, 'water')).length, before);
  // Body fat and height also become the day's daily number, as a scale's reading would.
  await r.app.worlds.hold(p.id, async (w) => { assert.equal(w.db.dailyValue(t, 'body_fat'), 21.4); assert.equal(w.db.dailyValue(t, 'height_mm'), 1715); });
  assert.equal((await ok(await p.c.get('/api/metric/height'))).metric.latest.value, 171.5);
  assert.equal((await ok(await p.c.get('/api/me'))).caps.hydration, true, 'capabilities were worked out again');
});

test('POST /api/entries: what is wrong is said in a sentence, and nothing is kept', async () => {
  const p = await personWith(r, 'careless', { groups: ['nutrition'] });
  for (const [body, code, re] of [
    [{ kind: 'water' }, 'bad_entry', /The amount is needed/],
    [{ kind: 'water', ml: 9000 }, 'bad_entry', /between 1 and 5000 ml/],
    [{ kind: 'water', ml: 250, at: Date.now() + 86_400_000 }, 'bad_entry', /cannot be in the future/],
    [{ kind: 'food', meal: 'LUNCH', kcal: 100 }, 'bad_entry', /A name is needed/],
    [{ kind: 'food', name: 'x', meal: 'BRUNCH', kcal: 100 }, 'bad_entry', /not one of the choices/],
    [{ kind: 'steps', count: 5 }, 'bad_kind', /not something that can be logged/],
    [{}, 'bad_kind', /not something that can be logged/],
    [{ kind: 'weight', kg: 80 }, 'bad_kind', /not something that can be logged/],
  ]) {
    const x = await p.c.post('/api/entries', body);
    assert.deepEqual([x.status, x.json.code], [400, code], JSON.stringify(body));
    assert.match(x.json.error, re);
  }
  // A group that is not switched on refuses its kinds.
  const x = await p.c.post('/api/entries', { kind: 'mood', moods: ['CALM'] });
  assert.deepEqual([x.status, x.json.code, x.json.error], [409, 'group_off', 'Switch on mood tracking first.']);
  assert.equal((await rowsOf(p, 'water')).length + (await rowsOf(p, 'food')).length + (await rowsOf(p, 'mood')).length, 0);
  assert.equal((await p.c.call('POST', '/api/entries', { raw: 'not json', headers: { 'content-type': 'application/json' } })).status, 400);
});

test('PATCH and DELETE /api/entries/<id>: the change reaches Google; only what was made here can be changed', async () => {
  const p = await personWith(r, 'editor', { groups: ['nutrition', 'mindfulness'] });
  const made = (await ok(await p.c.post('/api/entries', { kind: 'water', ml: 250 }))).entry;
  let x = await ok(await p.c.patch(`/api/entries/${made.id}`, { ml: 400 }));
  assert.deepEqual([x.google, x.entry.id, x.entry.value, x.entry.text, x.entry.t], ['saved', made.id, 400, '400 ml', made.t]);
  assert.equal((await atGoogle(p, 'hydration-log'))[0].hydrationLog.amountConsumed.milliliters, 400, 'Google has the new amount');
  // Only the fields named are replaced, and the kind cannot be changed by an edit.
  const food = (await ok(await p.c.post('/api/entries', { kind: 'food', name: 'Rice', meal: 'DINNER', kcal: 300, carbs: 60 }))).entry;
  x = await ok(await p.c.patch(`/api/entries/${food.id}`, { kcal: 350, kind: 'water' }));
  assert.deepEqual([x.entry.kind, x.entry.fields.name, x.entry.fields.kcal, x.entry.fields.carbs, x.entry.fields.meal], ['food', 'Rice', 350, 60, 'DINNER']);
  const bad = await p.c.patch(`/api/entries/${made.id}`, { ml: 0 });
  assert.deepEqual([bad.status, bad.json.code], [400, 'bad_entry']);
  assert.equal((await rowsOf(p, 'water'))[0].value, 400, 'a refused edit changes nothing');

  x = await ok(await p.c.del(`/api/entries/${made.id}`));
  assert.deepEqual(x, { ok: true, google: 'saved', message: null });
  assert.deepEqual(await atGoogle(p, 'hydration-log'), [], 'and it is gone from Google');
  assert.equal((await ok(await p.c.get('/api/metric/water'))).entries.length, 0);
  assert.equal((await p.c.del(`/api/entries/${made.id}`)).status, 404, 'removed twice');
  assert.equal((await p.c.patch(`/api/entries/${made.id}`, { ml: 1 })).status, 404);
  assert.equal((await p.c.del('/api/entries/l-nothing')).status, 404);
  assert.equal((await p.c.del('/api/entries/has%2Fslash')).status, 404);

  // A reading that came from Google is shown and cannot be touched.
  const g = (await ok(await p.c.get('/api/metric/glucose'))).entries.find((e) => e.source === 'google');
  assert.deepEqual([g.editable, g.deletable, g.device !== undefined], [false, false, true]);
  await r.app.worlds.hold(p.id, async (w) => { w.db.sampleAdd({ id: 'g-glucose-fixed', kind: 'glucose', t: Date.now() - 3_600_000, off: 7200, date: today(), value: 99, source: 'google', device: 'Meter' }); });
  x = await p.c.patch('/api/entries/g-glucose-fixed', { mgdl: 100 });
  assert.deepEqual([x.status, x.json.code, x.json.error], [403, 'read_only', 'This came from Google Health and can only be changed there.']);
  assert.equal((await p.c.del('/api/entries/g-glucose-fixed')).status, 403);

  // Somebody else's entry does not exist for me.
  const other = await personWith(r, 'nosy', { groups: ['nutrition'] });
  const mine = (await ok(await p.c.post('/api/entries', { kind: 'water', ml: 111 }))).entry;
  assert.equal((await other.c.patch(`/api/entries/${mine.id}`, { ml: 1 })).status, 404);
  assert.equal((await other.c.del(`/api/entries/${mine.id}`)).status, 404);
  assert.equal((await rowsOf(p, 'water'))[0].value, 111);
});

test('Google refusing or out of reach: the entry is kept, marked failed, and sent at the next sync', async () => {
  const p = await personWith(r, 'unlucky', { groups: ['nutrition'] });
  let down = true;
  r.wrap.fn = async (userId, url, init) => (down && userId === p.id && /hydration-log\/dataPoints/.test(url.pathname) && init?.method === 'POST' ? new Response(JSON.stringify({ error: { code: 503, message: 'backend unavailable', status: 'UNAVAILABLE' } }), { status: 503 }) : null);
  const x = await ok(await p.c.post('/api/entries', { kind: 'water', ml: 275 }));
  assert.deepEqual([x.google, x.entry.google, x.entry.value], ['failed', 'failed', 275]);
  assert.match(x.message, /^Saved here\. Google Health did not take it \(.*\); it will be tried again at the next sync\.$/);
  assert.ok(x.entry.error);
  assert.deepEqual(await atGoogle(p, 'hydration-log'), []);
  assert.equal((await ok(await p.c.get('/api/metric/water?range=day'))).stats.total, 275, 'it counts from the moment it was typed');
  down = false;
  await r.app.syncUser(p.id);
  const e = (await ok(await p.c.get('/api/metric/water'))).entries[0];
  assert.deepEqual([e.id, e.google, e.error], [x.entry.id, 'saved', null]);
  assert.equal((await atGoogle(p, 'hydration-log')).length, 1);
  r.wrap.fn = null;
});

test('without Google: a group can be switched on and logged in locally; connecting later sends what was kept', async () => {
  const p = await r.person('offline');
  let me = await ok(await p.c.get('/api/me'));
  assert.ok(me.google.groups.every((g) => g.mode === 'off' && g.start === `/auth/google/start?groups=${g.id}`));
  // The core kinds need no group: kept here.
  let x = await ok(await p.c.post('/api/entries', { kind: 'glucose', mgdl: 97 }));
  assert.deepEqual([x.google, x.entry.google, x.message], ['local', 'local', 'Kept on this site only: Google Health is not connected.']);
  // A group's kinds need the group switched on, which works without Google, in local mode.
  assert.equal((await p.c.post('/api/entries', { kind: 'water', ml: 250 })).json.code, 'group_off');
  x = await ok(await p.c.post('/api/google/groups', { group: 'nutrition', on: true }));
  assert.deepEqual(Object.keys(x), ['group', 'groups', 'purged']);
  assert.deepEqual([x.group.id, x.group.chosen, x.group.granted, x.group.usable, x.group.mode, x.group.canLog, x.purged], ['nutrition', true, false, false, 'local', true, 0]);
  assert.deepEqual(x.groups.map((g) => g.mode), ['local', 'off', 'off', 'off', 'off', 'off']);
  x = await ok(await p.c.post('/api/entries', { kind: 'water', ml: 250 }));
  assert.deepEqual([x.google, x.message], ['local', 'Kept on this site only: Google Health is not connected.']);
  const m = await ok(await p.c.get('/api/metric/water'));
  assert.deepEqual([m.add.mode, m.add.available, m.add.note, m.entries[0].google, m.entries[0].editable], ['local', true, 'Kept on this site only: Google Health is not connected.', 'local', true]);
  assert.deepEqual((await ok(await p.c.get('/api/browse'))).categories.map((c) => c.id), ['vitals', 'nutrition']);
  // Local entries can be changed and removed like any other.
  x = await ok(await p.c.patch(`/api/entries/${m.entries[0].id}`, { ml: 300 }));
  assert.deepEqual([x.google, x.entry.value], ['local', 300]);
  // ECG is only ever read from Google: without it there is nothing to switch on.
  x = await p.c.post('/api/google/groups', { group: 'ecg', on: true });
  assert.deepEqual([x.status, x.json.code, x.json.detail], [409, 'needs_google', { start: '/auth/google/start?groups=ecg', group: 'ecg', canLocal: false }]);

  // Connecting with the group granted: the next sync sends what was kept here.
  r.parts.personaOf.set(p.id, 'phone');
  await r.app.worlds.hold(p.id, async (w) => { const pk = pkce(); await w.google.exchange({ code: r.parts.issue(pk.challenge, r.parts.scopesFor(['nutrition'])), verifier: pk.verifier }); r.app.app.patchProfile(p.id, { googleState: 'ok' }); });
  await r.app.syncUser(p.id);
  me = await ok(await p.c.get('/api/me'));
  assert.equal(me.google.groups[0].mode, 'google');
  const after = (await ok(await p.c.get('/api/metric/water'))).entries[0];
  assert.deepEqual([after.google, after.value], ['saved', 300]);
  assert.equal((await atGoogle(p, 'hydration-log')).length, 1);
  assert.equal((await ok(await p.c.get('/api/metric/glucose'))).entries.find((e) => e.source === 'app').google, 'saved');
});

test('POST /api/google/groups: needs_scope with where to go, local on request, off at once, purge deletes the rows', async () => {
  const p = await personWith(r, 'switcher', { groups: [] });
  // Connected, but Google was never asked for this group.
  let x = await p.c.post('/api/google/groups', { group: 'cycle', on: true });
  assert.deepEqual([x.status, x.json.code, x.json.detail], [409, 'needs_scope', { start: '/auth/google/start?groups=cycle', group: 'cycle', canLocal: true }]);
  assert.match(x.json.error, /^Google Health has not been asked for cycle tracking yet\./);
  assert.equal((await ok(await p.c.get('/api/me'))).google.groups.find((g) => g.id === 'cycle').chosen, false, 'a refusal switches nothing on');
  x = await p.c.post('/api/google/groups', { group: 'ecg', on: true, local: true });
  assert.deepEqual([x.status, x.json.code, x.json.detail.canLocal], [409, 'needs_scope', false], 'a read-only group has no local mode');
  // The person may keep it on this site only.
  x = await ok(await p.c.post('/api/google/groups', { group: 'cycle', on: true, local: true }));
  assert.deepEqual([x.group.mode, x.group.chosen, x.group.granted], ['local', true, false]);
  const t = today();
  x = await ok(await p.c.post('/api/entries', { kind: 'period', start: addDays(t, -3), end: addDays(t, -1) }));
  assert.deepEqual([x.google, x.message], ['local', 'Kept on this site only: Google Health has not been given this permission.']);
  assert.equal((await ok(await p.c.get('/api/metric/period'))).add.note, 'Kept on this site only: Google Health has not been given this permission.');

  // Following `start` grants it: the group becomes 'google' and the kept entry is sent.
  const first = await p.c.get('/auth/google/start?groups=cycle&return=/browse');
  const consentUrl = new URL(first.headers.get('location'));
  assert.ok(consentUrl.searchParams.get('scope').includes('reproductive_health.writeonly'));
  const back = new URL((await p.c.get(consentUrl.pathname + consentUrl.search)).headers.get('location'));
  assert.equal((await p.c.get(back.pathname + back.search)).headers.get('location'), '/browse?google=connected');
  await new Promise((res) => { setTimeout(res, 500); });
  await r.app.syncUser(p.id);
  assert.equal((await ok(await p.c.get('/api/me'))).google.groups.find((g) => g.id === 'cycle').mode, 'google');
  assert.equal((await ok(await p.c.get('/api/metric/period'))).entries[0].google, 'saved');
  // Granted already: switching on needs nothing more.
  await ok(await p.c.post('/api/google/groups', { group: 'cycle', on: false }));
  x = await ok(await p.c.post('/api/google/groups', { group: 'cycle', on: true }));
  assert.deepEqual([x.group.mode, x.purged], ['google', 0]);

  // Off: enforced here at once. The rows stay unless asked otherwise.
  x = await ok(await p.c.post('/api/google/groups', { group: 'cycle', on: false }));
  assert.deepEqual([x.group.mode, x.group.chosen, x.group.granted, x.group.usable, x.purged], ['off', false, true, false, 0]);
  assert.equal((await p.c.get('/api/metric/period')).status, 409);
  assert.equal((await p.c.post('/api/entries', { kind: 'period', start: t })).json.code, 'group_off');
  assert.ok(!(await ok(await p.c.get('/api/browse'))).categories.some((c) => c.id === 'cycle'));
  assert.equal((await rowsOf(p, 'period')).length, 1, 'kept, out of sight');
  // An entry of a group that is off can still be removed: it is the person's own.
  const kept = (await rowsOf(p, 'period'))[0];
  assert.equal((await p.c.patch(`/api/entries/${kept.id}`, { note: 'x' })).json.code, 'group_off');
  // On again and it is all still there; off with purge and it is not.
  await ok(await p.c.post('/api/google/groups', { group: 'cycle', on: true }));
  assert.equal((await ok(await p.c.get('/api/metric/period'))).entries.length, 1);
  await ok(await p.c.post('/api/entries', { kind: 'ovulation', result: 'NEGATIVE' }));
  x = await ok(await p.c.post('/api/google/groups', { group: 'cycle', on: false, purge: true }));
  assert.deepEqual([x.purged, x.group.mode], [2, 'off']);
  assert.deepEqual([(await rowsOf(p, 'period')).length, (await rowsOf(p, 'ovulation')).length], [0, 0]);
  await r.app.worlds.hold(p.id, async (w) => { assert.equal(w.db.db.prepare("SELECT COUNT(*) AS n FROM sample WHERE kind IN ('period', 'ovulation')").get().n, 0, 'tombstones too'); });
  // Purging one group leaves the others' rows alone.
  assert.ok((await rowsOf(p, 'glucose')).length > 0);

  for (const [body, code] of [[{ group: 'vitamins', on: true }, 'bad_group'], [{ on: true }, 'bad_group'], [{ group: 'cycle' }, 'bad_request'], [{ group: 'cycle', on: 'yes' }, 'bad_request']]) {
    x = await p.c.post('/api/google/groups', body);
    assert.deepEqual([x.status, x.json.code], [400, code], JSON.stringify(body));
  }
});

test('PATCH /api/settings: the cardio and water targets and the per-group summary switches, validated', async () => {
  const p = await personWith(r, 'tuner', { groups: ['nutrition'] });
  let me = await ok(await p.c.get('/api/me'));
  assert.deepEqual(me.goals, { steps: 8000, activeMinutes: 22, sleepMinutes: 450, cardioWeek: 150, waterMl: 2000 });
  assert.deepEqual(me.aiShare, { nutrition: false, mindfulness: false, symptoms: false, cycle: false, sleeplog: false, ecg: false });
  assert.deepEqual(me.pins, []);
  me = await ok(await p.c.patch('/api/settings', { goals: { cardioWeek: 200, waterMl: 2750.4 }, aiShare: { nutrition: true } }));
  assert.deepEqual([me.goals.cardioWeek, me.goals.waterMl, me.goals.steps], [200, 2750, 8000]);
  assert.deepEqual(me.aiShare, { nutrition: true, mindfulness: false, symptoms: false, cycle: false, sleeplog: false, ecg: false });
  me = await ok(await p.c.patch('/api/settings', { aiShare: { cycle: true, nutrition: false } }));
  assert.deepEqual([me.aiShare.cycle, me.aiShare.nutrition], [true, false], 'a group can be shared before it is switched on; it is read only while both are true');
  for (const [body, re] of [
    [{ goals: { cardioWeek: 29 } }, /goals\.cardioWeek must be 30-600/], [{ goals: { cardioWeek: 601 } }, /30-600/], [{ goals: { cardioWeek: 'lots' } }, /30-600/],
    [{ goals: { waterMl: 499 } }, /goals\.waterMl must be 500-6000/], [{ goals: { waterMl: 6001 } }, /500-6000/],
    [{ aiShare: { glucose: true } }, /aiShare\.glucose is not a group/], [{ aiShare: { nutrition: 'yes' } }, /aiShare\.nutrition must be true or false/],
    [{ aiShare: true }, /aiShare must be an object/], [{ aiShare: ['nutrition'] }, /aiShare must be an object/],
    [{ privacy: { nutrition: true, account: 'open' } }, /privacy\.account must be public or private/],
  ]) {
    const x = await p.c.patch('/api/settings', body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.match(x.json.error, re);
  }
  me = await ok(await p.c.get('/api/me'));
  assert.deepEqual([me.goals.cardioWeek, me.goals.waterMl, me.aiShare.cycle], [200, 2750, true], 'a refused change changes nothing');
  // The targets are what the metric pages and Today hold the numbers against.
  assert.equal((await ok(await p.c.get('/api/metric/water'))).metric.goal, 2750);
  assert.equal((await ok(await p.c.get('/api/metric/cardio_week'))).metric.goal, 200);
  const extra = (await ok(await p.c.get('/api/brief'))).extra;
  assert.deepEqual([extra.cardio.target, extra.water.target, extra.cardio.weeks[0].target], [200, 2750, 200]);
  // The privacy switches did not gain a category: an unknown one is ignored, never stored.
  me = await ok(await p.c.patch('/api/settings', { privacy: { nutrition: true, cycle: true, glucose: true, sleep: true } }));
  assert.deepEqual(Object.keys(me.privacy).sort(), ['account', 'activity', 'body', 'heart', 'sleep', 'workouts']);
  // A new sleep goal re-scores the nights.
  const was = (await ok(await p.c.get('/api/metric/sleep_score?range=month'))).stats.avg;
  await ok(await p.c.patch('/api/settings', { goals: { sleepMinutes: 600 } }));
  const now = (await ok(await p.c.get('/api/metric/sleep_score?range=month'))).stats.avg;
  assert.ok(now < was - 2, `a ten-hour goal lowers the scores (less than in proportion, as Google's does) (${was} -> ${now})`);
});
