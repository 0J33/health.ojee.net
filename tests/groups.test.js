/* The optional groups through the running app: asking Google for one more
   group, what /api/me says about them, switching one off, and the demo
   people's seeded groups and entries. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { SEED, demoEntries, demoStress } from '../server/demo.js';
import { addEntry, KINDS } from '../server/core/entries.js';
import { GROUP_IDS } from '../server/core/google.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const settle = () => new Promise((res) => { setTimeout(res, 400); });
/** Walk the consent redirect chain the way a browser would. */
async function consent(c, start) {
  const first = await c.get(start);
  const url = new URL(first.headers.get('location'));
  const back = new URL((await c.get(url.pathname + url.search)).headers.get('location'));
  const done = await c.get(back.pathname + back.search);
  return { asked: url.searchParams.get('scope').split(' ').map((s) => s.split('googlehealth.').pop()), url, location: done.headers.get('location') };
}
const group = (me, id) => me.google.groups.find((g) => g.id === id);

test('/api/me lists the five groups; before anything is asked none is chosen, granted or missing', async () => {
  const p = await r.person('plain', { persona: 'fitbit' });
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(me.google.groups.map((g) => g.id), GROUP_IDS);
  for (const g of me.google.groups) {
    assert.deepEqual(Object.keys(g), ['id', 'label', 'about', 'scopes', 'chosen', 'granted', 'usable', 'readOnly', 'note', 'mode', 'canLog', 'kinds', 'start']);
    assert.deepEqual([g.chosen, g.granted, g.usable], [false, false, false], g.id);
  }
  assert.deepEqual(group(me, 'ecg').scopes, ['ecg.readonly', 'irn.readonly']);
  assert.deepEqual(group(me, 'nutrition').scopes, ['nutrition.writeonly']);
  assert.deepEqual([group(me, 'ecg').readOnly, group(me, 'cycle').readOnly], [true, false]);
  assert.match(group(me, 'mindfulness').note, /What you log in Google's own app cannot be read by other apps/);
  assert.deepEqual(me.google.missing, [], 'a group nobody asked for is not a declined permission');
  assert.equal(me.google.scopes.length, 6, 'the core scopes, as before');
  assert.deepEqual([me.sync.streams.ecg.skipped, me.sync.streams.water.skipped], ['group off', 'group off']);
  assert.deepEqual(Object.keys(me.sync.streams.steps), ['at', 'rows', 'error', 'skipped', 'unavailable', 'message', 'unavailableAt', 'backTo']);
  assert.ok(me.sync.streams.hrDay.backTo, 'a heavy stream says how far back it has read');
  assert.deepEqual([me.caps.floors, me.caps.ecg, me.caps.hydration], [true, false, false]);
});

test('start?groups= adds those scopes to the consent, and a successful callback records the choice', async () => {
  const p = await r.person('grower', { persona: 'fitbit' });
  const out = await consent(p.c, '/auth/google/start?groups=nutrition,ecg,bogus&return=/settings/connections');
  assert.equal(out.url.searchParams.get('include_granted_scopes'), 'true');
  for (const s of ['nutrition.writeonly', 'ecg.readonly', 'irn.readonly', 'activity_and_fitness.readonly', 'sleep.readonly']) assert.ok(out.asked.includes(s), s);
  for (const s of ['mindfulness.writeonly', 'reproductive_health.writeonly', 'logged_symptoms.writeonly', 'nutrition.readonly']) assert.ok(!out.asked.includes(s), `${s} was not asked for`);
  assert.equal(out.location, '/settings/connections?google=connected');
  await settle();
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(me.google.groups.map((g) => [g.id, g.chosen, g.granted, g.usable]), [
    ['nutrition', true, true, true], ['mindfulness', false, false, false], ['symptoms', false, false, false], ['cycle', false, false, false], ['sleeplog', false, false, false], ['ecg', true, true, true],
  ]);
  assert.deepEqual(me.google.missing, []);
  assert.equal(me.google.canWriteWeight, true, 'the core grant is still there: the reply listed the combined scopes');
  // The sync that follows reads the new group.
  assert.ok(me.sync.streams.ecg.at && me.sync.streams.water.at);
  assert.equal(me.sync.streams.ecg.skipped, null);
  assert.equal(me.caps.ecg, true);
  await r.app.worlds.hold(p.id, async (w) => {
    assert.deepEqual(w.groups(), { nutrition: true, mindfulness: false, symptoms: false, cycle: false, sleeplog: false, ecg: true });
    assert.equal(w.db.samples('ecg').length, 2);
    // An entry in the new group goes to Google; one in a group not chosen is refused.
    assert.equal((await addEntry(w, 'water', { ml: 250 })).google, 'saved');
    await assert.rejects(addEntry(w, 'mood', { moods: ['CALM'] }), (e) => e.code === 'group_off');
  });

  // A second group later: it joins the first, nothing is lost.
  const more = await consent(p.c, '/auth/google/start?groups=cycle');
  assert.ok(more.asked.includes('reproductive_health.writeonly'));
  assert.ok(more.asked.includes('nutrition.writeonly') && more.asked.includes('ecg.readonly'), 'what was already chosen is asked for again');
  await settle();
  const me2 = (await p.c.get('/api/me')).json;
  assert.deepEqual(me2.google.groups.filter((g) => g.usable).map((g) => g.id), ['nutrition', 'cycle', 'ecg']);
});

test('a group switched off stops at once, though Google still holds the scope; a reconnect asks only for what is chosen', async () => {
  const p = await r.person('offswitch', { persona: 'fitbit' });
  await consent(p.c, '/auth/google/start?groups=nutrition,ecg');
  await settle();
  await r.app.worlds.hold(p.id, async (w) => {
    assert.deepEqual(w.setGroups({ ecg: false, bogus: true, cycle: 'yes' }), { nutrition: true, mindfulness: false, symptoms: false, cycle: false, sleeplog: false, ecg: false });
  });
  let me = (await p.c.get('/api/me')).json;
  assert.deepEqual([group(me, 'ecg').chosen, group(me, 'ecg').granted, group(me, 'ecg').usable], [false, true, false]);
  await r.app.syncUser(p.id);
  me = (await p.c.get('/api/me')).json;
  assert.equal(me.sync.streams.ecg.skipped, 'group off');
  assert.equal(me.sync.streams.water.skipped, null);

  // Disconnect withdraws everything at Google. Connecting again asks for the
  // core set and the one group still chosen.
  assert.equal((await p.c.post('/api/google/disconnect', {})).json.google.state, 'needs_auth');
  me = (await p.c.get('/api/me')).json;
  assert.deepEqual([group(me, 'nutrition').chosen, group(me, 'nutrition').granted, group(me, 'nutrition').usable], [true, false, false], 'the choice outlives the connection');
  const again = await consent(p.c, '/auth/google/start');
  assert.ok(again.asked.includes('nutrition.writeonly'));
  assert.ok(!again.asked.includes('ecg.readonly') && !again.asked.includes('irn.readonly'), 'the group that was switched off is not asked for');
  await settle();
  me = (await p.c.get('/api/me')).json;
  assert.deepEqual(me.google.groups.filter((g) => g.granted).map((g) => g.id), ['nutrition']);
});

test('a cancelled consent chooses nothing', async () => {
  const p = await r.person('canceller', { persona: 'fitbit' });
  const start = new URL((await p.c.get('/auth/google/start?groups=cycle')).headers.get('location'));
  const denied = await p.c.get(`/auth/google/callback?error=access_denied&state=${start.searchParams.get('state')}`);
  assert.equal(denied.headers.get('location'), '/settings/connections?google=cancelled');
  const me = (await p.c.get('/api/me')).json;
  assert.deepEqual(me.google.groups.filter((g) => g.chosen || g.granted), []);
  assert.equal(me.google.state, 'ok', 'and the connection they had is untouched');
});

test('a group\'s capability is only called missing while the group is on', async () => {
  const p = await r.person('capper', { persona: 'phone' });
  let me = (await p.c.get('/api/me')).json;
  assert.ok(!me.capsMeta.missingMore.some((m) => m.group), 'no group is on, so none of theirs is missing');
  await consent(p.c, '/auth/google/start?groups=nutrition,cycle');
  await settle();
  me = (await p.c.get('/api/me')).json;
  assert.deepEqual(me.capsMeta.missingMore.filter((m) => m.group).map((m) => [m.cap, m.group]), [['hydration', 'nutrition'], ['nutrition', 'nutrition'], ['cycle', 'cycle']]);
  assert.match(me.capsMeta.missingMore.find((m) => m.cap === 'hydration').text, /Log a glass here/);
  await r.app.worlds.hold(p.id, async (w) => { await addEntry(w, 'water', { ml: 250 }); await addEntry(w, 'period', { start: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) }); });
  await r.app.syncUser(p.id);
  me = (await p.c.get('/api/me')).json;
  assert.deepEqual([me.caps.hydration, me.caps.nutrition, me.caps.cycle], [true, false, true], 'a period a month ago still counts: cycles are looked for over 45 days');
  assert.deepEqual(me.capsMeta.missingMore.filter((m) => m.group).map((m) => m.cap), ['nutrition']);
});

test('"delete my health data" takes the sample rows with it', async () => {
  const p = await r.person('wiper', { persona: 'fitbit' });
  await consent(p.c, '/auth/google/start?groups=nutrition,mindfulness');
  await settle();
  await r.app.worlds.hold(p.id, async (w) => {
    await addEntry(w, 'water', { ml: 250 });
    await addEntry(w, 'mood', { moods: ['CALM'] });
    assert.ok(w.db.samplesAll().length >= 8, 'entries, and the readings the sync brought');
  });
  assert.deepEqual((await p.c.post('/api/account/delete-data', { confirm: 'wiper' })).json, { ok: true });
  await new Promise((res) => { setTimeout(res, 80); });
  assert.equal(r.app.worlds.has(p.id), false, 'the folder is gone');
  await r.app.worlds.hold(p.id, async (w) => {
    assert.deepEqual(w.db.samplesAll(), []);
    assert.deepEqual(w.db.sampleStats(), {});
    assert.deepEqual(w.groups(), { nutrition: false, mindfulness: false, symptoms: false, cycle: false, sleeplog: false, ecg: false }, 'and so is the choice of groups');
  });
});

test('the demo people: their groups, their entries, and no second copy after another sync', async () => {
  const d = await rig();
  try {
    await d.parts.seed(d.app);
    const idOf = async (name) => String((await d.app.accounts.byUsername(name))._id);
    const want = { demo: ['nutrition', 'mindfulness', 'symptoms', 'cycle', 'ecg'], mira: ['nutrition', 'mindfulness'], lena: ['cycle'], sam: [], noor: [], kai: [], ojee: [] };
    assert.deepEqual(Object.fromEntries(SEED.map((s) => [s.username, s.groups || []])), want);
    const counts = {};
    for (const s of SEED) {
      await d.app.worlds.hold(await idOf(s.username), async (w) => {
        assert.deepEqual(Object.keys(w.groups()).filter((g) => w.groups()[g]), want[s.username], s.username);
        assert.deepEqual(w.groupsView().filter((g) => g.usable).map((g) => g.id), want[s.username], `${s.username}: chosen and granted`);
        const st = w.db.sampleStats();
        counts[s.username] = Object.fromEntries(['water', 'food', 'mood', 'symptom', 'period', 'ovulation', 'ecg', 'irn'].map((k) => [k, st[k]?.n || 0]));
        const mine = w.db.samplesAll().filter((x) => x.source === 'app');
        assert.equal(mine.length, demoEntries(s.groups, s.tz, Date.now()).length + (s.stress ? demoStress(s.tz, Date.now()).length : 0), `${s.username}: every seeded entry is a row`);
        // Tape measurements have no Google type: they stay here (and go to Hevy).
        assert.ok(mine.filter((x) => KINDS[x.kind].type).every((x) => x.gstate === 'saved' && x.gname), `${s.username}: each one reached the stand-in Google`);
        assert.ok(mine.filter((x) => !KINDS[x.kind].type).every((x) => x.gstate === 'local' && !x.gname), `${s.username}: and the rest stayed here`);
        // Nothing sensitive in the table that is published and summarised.
        const metrics = new Set(Object.values(w.db.dailyTable('0000-00-00')).flatMap((m) => Object.keys(m)));
        for (const k of metrics) assert.ok(!/^(water|food|mood|symptom|period|ovulation|cycle|ecg|irn|glucose|bodytemp)/.test(k), `${s.username}: ${k}`);
      });
    }
    // Today's entries stop at the present hour, so the totals have a little give.
    assert.ok(counts.demo.water >= 90 && counts.demo.food >= 60 && counts.demo.mood >= 20 && counts.demo.symptom === 4, JSON.stringify(counts.demo));
    assert.deepEqual([counts.demo.period, counts.demo.ovulation, counts.demo.ecg, counts.demo.irn], [3, 1, 2, 1]);
    assert.ok(counts.mira.water > 0 && counts.mira.food > 0 && counts.mira.mood >= 20);
    assert.deepEqual([counts.mira.symptom, counts.mira.period, counts.mira.ecg], [0, 0, 0]);
    assert.deepEqual(counts.lena, { water: 0, food: 0, mood: 0, symptom: 0, period: 3, ovulation: 1, ecg: 0, irn: 0 });
    for (const who of ['sam', 'noor', 'kai', 'ojee']) assert.deepEqual(Object.values(counts[who]), [0, 0, 0, 0, 0, 0, 0, 0], who);

    // The capabilities follow.
    await d.app.worlds.hold(await idOf('demo'), async (w) => {
      const c = w.db.meta('caps');
      for (const k of ['hydration', 'nutrition', 'mood', 'symptoms', 'cycle', 'ecg', 'glucose', 'bodyTemp', 'height', 'floors', 'vo2max', 'zones']) assert.equal(c.caps[k], true, k);
      assert.deepEqual(c.meta.missingMore, []);
    });
    await d.app.worlds.hold(await idOf('sam'), async (w) => assert.deepEqual(w.db.samplesAll(), [], 'the phone-only person has no readings and no entries'));

    // What each of them sees: everything, part of it, or two metrics.
    const signIn = async (name) => { const c = d.client(); assert.equal((await c.post('/auth/login', { username: name, password: 'demo' })).status, 200); return c; };
    const seen = {};
    for (const s of SEED) {
      const c = await signIn(s.username);
      const b = (await c.get('/api/browse')).json;
      seen[s.username] = { have: b.categories.flatMap((x) => x.metrics.map((m) => m.id)), pinned: b.pinned, extra: (await c.get('/api/brief')).json.extra, me: (await c.get('/api/me')).json };
    }
    assert.equal(seen.demo.have.length, 45, 'demo has every metric there is (but body composition, which needs a scale, and Body Battery, which needs a Garmin)');
    assert.deepEqual(seen.demo.pinned, ['vo2max', 'water', 'resp', 'weight']);
    assert.deepEqual(seen.demo.extra.pinned.map((m) => m.id), ['vo2max', 'water', 'resp', 'weight']);
    assert.deepEqual([seen.demo.me.goals.cardioWeek, seen.demo.me.goals.waterMl, seen.demo.extra.cardio.target, seen.demo.extra.water.target], [180, 2500, 180, 2500]);
    assert.deepEqual(seen.sam.have, ['steps', 'distance']);
    assert.deepEqual(seen.sam.extra, { cardio: null, sleepScore: null, calories: null, floors: null, vitals: [], recovery: null, water: null, food: null, pinned: [], stress: null });
    for (const id of ['water', 'food', 'mood', 'vo2max', 'resp', 'zones', 'sleep_score']) assert.ok(seen.mira.have.includes(id), `mira ${id}`);
    for (const id of ['period', 'symptoms', 'ecg', 'skin_temp', 'body_fat', 'glucose']) assert.ok(!seen.mira.have.includes(id), `mira ${id}`);
    // Noor: a Garmin read directly, no Google account at all.
    for (const id of ['floors', 'calories_active', 'cardio_week', 'recovery', 'sleep_score', 'sleep_stages', 'hrv', 'spo2', 'resp', 'stress', 'body_battery', 'weight', 'workouts']) assert.ok(seen.noor.have.includes(id), `noor ${id}`);
    for (const id of ['vo2max', 'zones', 'skin_temp', 'water', 'period']) assert.ok(!seen.noor.have.includes(id), `noor ${id}`);
    assert.deepEqual([seen.noor.me.google.state, seen.noor.me.garmin.connected, seen.noor.me.sources], ['needs_auth', true, { google: false, garmin: true, hc: false, any: true }]);
    // The watch's stress line is today's: in Noor's first hours after midnight (Asia/Dubai) there is none yet.
    const noorHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (noorHour >= 3) assert.ok(seen.noor.extra.stress?.device && seen.noor.extra.stress.battery, 'Today has a stress line from the watch');
    for (const id of ['period', 'ovulation', 'vo2max', 'resp', 'floors']) assert.ok(seen.lena.have.includes(id), `lena ${id}`);
    for (const id of ['water', 'mood', 'zones', 'activity_levels', 'skin_temp']) assert.ok(!seen.lena.have.includes(id), `lena ${id}`);
    for (const who of ['mira', 'sam', 'noor', 'kai', 'lena', 'ojee']) assert.deepEqual([seen[who].pinned, seen[who].me.goals.cardioWeek, seen[who].me.goals.waterMl], [[], 150, 2000], who);
    assert.ok(Object.values(seen).every((x) => Object.values(x.me.aiShare).every((v) => v === false)), 'nobody shares a group with the summary until they say so');

    // Another sync reads water and food back from Google: onto the same rows.
    for (const who of ['demo', 'mira', 'lena']) {
      const res = await d.app.syncUser(await idOf(who));
      assert.equal(res.ok, true);
      await d.app.worlds.hold(await idOf(who), async (w) => {
        const st = w.db.sampleStats();
        for (const k of ['water', 'food', 'mood', 'symptom', 'period', 'ovulation']) assert.equal(st[k]?.n || 0, counts[who][k], `${who}: ${k} not duplicated`);
        if (who !== 'lena') assert.ok(w.sync.state.streams.water.rows > 10, 'the read-back did see the last days\' glasses');
        assert.ok(w.db.samples('water', { limit: 500 }).every((x) => x.source === 'app'));
      });
    }
  } finally { await d.close(); }
});

test('the seeded entries are the same on every start, and never in the future', () => {
  const now = Date.parse('2026-10-11T09:00:00Z');
  const a = demoEntries(['nutrition', 'mindfulness', 'symptoms', 'cycle'], 'Africa/Cairo', now);
  assert.deepEqual(a, demoEntries(['nutrition', 'mindfulness', 'symptoms', 'cycle'], 'Africa/Cairo', now));
  assert.ok(a.every(([, f]) => f.at === undefined || f.at <= now));
  assert.deepEqual([...new Set(a.map(([k]) => k))].sort(), ['food', 'measure', 'mood', 'ovulation', 'period', 'symptom', 'water']);
  assert.deepEqual(demoEntries([], 'Africa/Cairo', now), []);
  assert.deepEqual([...new Set(demoEntries(['cycle'], 'Europe/Berlin', now).map(([k]) => k))], ['period', 'ovulation']);
});
