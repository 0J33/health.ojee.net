import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rig } from './helpers.mjs';
import { validUserId } from '../server/worlds.js';
import { today, localToMs, utcOffsetSec } from '../server/core/util.js';

test('each person lives in their own time zone, not the process\'s', async () => {
  // 2026-10-04 23:30 UTC: already Monday in Auckland, still Sunday in Los Angeles.
  const clock = { t: Date.parse('2026-10-04T23:30:00Z') };
  const r = await rig({ now: () => clock.t });
  try {
    const nz = await r.person('kiwi', { tz: 'Pacific/Auckland' });
    const la = await r.person('angeleno', { tz: 'America/Los_Angeles' });
    const filters = {};
    r.wrap.fn = async (userId, url) => { const f = url.searchParams.get('filter'); if (f && url.pathname.includes('daily-resting-heart-rate')) filters[userId] = f; return null; };
    await r.connect(nz.id, 'fitbit'); await r.connect(la.id, 'fitbit');
    const dn = (await nz.c.get('/api/data?days=7')).json;
    const dl = (await la.c.get('/api/data?days=7')).json;
    assert.deepEqual([dn.today, dn.tz, dn.series.at(-1).date], ['2026-10-05', 'Pacific/Auckland', '2026-10-05']);
    assert.deepEqual([dl.today, dl.tz, dl.series.at(-1).date], ['2026-10-04', 'America/Los_Angeles', '2026-10-04']);
    // The poller asked Google from each person's own civil date.
    assert.match(filters[nz.id], />= "2026-07-08"/);
    assert.match(filters[la.id], />= "2026-07-07"/);
    // Sleep offsets are the wearer's.
    assert.equal(dn.sleep.lastNight.endOff, 13 * 3600);
    assert.equal(dl.sleep.lastNight.endOff, -7 * 3600);
    // A weigh-in is written with the person's offset, and a workout started "now" is theirs too.
    const posted = [];
    r.wrap.fn = async (userId, url, init) => { if (init?.method === 'POST' && /\/(weight|exercise)\/dataPoints$/.test(url.pathname)) posted.push(JSON.parse(init.body)); return null; };
    await nz.c.post('/api/weight', { kg: 70 }); await la.c.post('/api/weight', { kg: 80 });
    assert.deepEqual(posted.map((x) => x.weight.sampleTime.utcOffset), ['46800s', '-25200s']);
    // Moving zone moves "today" at once, here and in the public rows.
    await la.c.patch('/api/profile', { tz: 'Asia/Tokyo' });
    assert.equal((await la.c.get('/api/data?days=7')).json.today, '2026-10-05');
    assert.equal(r.app.worlds.get(la.id).sync.tz, 'Asia/Tokyo');
    assert.equal(r.app.worlds.get(la.id).workouts.tz, 'Asia/Tokyo');
  } finally { await r.close(); }
});

test('zone helpers: civil date, offset and local midnight across a DST change', () => {
  const t = Date.parse('2026-03-29T00:30:00Z');   // Europe springs forward at 01:00 UTC
  assert.equal(today(t, 'Europe/Berlin'), '2026-03-29');
  assert.equal(utcOffsetSec(t, 'Europe/Berlin'), 3600);
  assert.equal(utcOffsetSec(t + 3_600_000, 'Europe/Berlin'), 7200);
  assert.equal(localToMs('2026-03-29', 0, 'Europe/Berlin'), Date.parse('2026-03-28T23:00:00Z'));
  assert.equal(localToMs('2026-03-29', 12 * 60, 'Europe/Berlin'), Date.parse('2026-03-29T10:00:00Z'));
  assert.equal(localToMs('2026-10-09', 15 * 60 + 10, 'Asia/Kolkata'), Date.parse('2026-10-09T09:40:00Z'));
});

test('worlds are opened on demand, kept in an LRU, and never evicted while in use', async () => {
  const r = await rig({ env: { WORLD_CACHE: '4' } });
  try {
    const people = [];
    for (let i = 0; i < 7; i += 1) people.push(await r.person(`lru${i}`));
    for (const p of people) await p.c.patch('/api/profile', { notes: `note of ${p.username}` });
    assert.ok(r.app.worlds.open() <= 4, `${r.app.worlds.open()} open`);
    // Evicted worlds come back with their data, from their own folder.
    for (const p of people) {
      assert.equal((await p.c.get('/api/me')).json.profile.notes, `note of ${p.username}`);
      assert.ok(existsSync(join(r.config.dataDir, 'users', p.id, 'health.sqlite')));
    }
    // A world that is held stays open however many others are opened.
    let release;
    const held = r.app.worlds.hold(people[0].id, (w) => new Promise((res) => { release = () => res(w); }));
    for (const p of people.slice(1)) await p.c.get('/api/me');
    const w = r.app.worlds.map.get(people[0].id);
    assert.ok(w, 'still in the cache');
    assert.equal(w.db.closed, false);
    release();
    assert.equal((await held).userId, people[0].id);
  } finally { await r.close(); }
});

test('a user id is a Mongo ObjectId and nothing else (it becomes a folder name)', () => {
  assert.equal(validUserId('6707a1d2c3b4a5968778695a'), true);
  for (const bad of ['', '../../etc', '6707a1d2c3b4a5968778695', '6707A1D2C3B4A5968778695A', '6707a1d2c3b4a5968778695a/..', null, undefined]) assert.equal(validUserId(bad), false, String(bad));
});
