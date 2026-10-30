import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAppDb, normUnits, unitSystem, UNITS_DEFAULT } from '../server/appdb.js';
import { rig } from './helpers.mjs';

const EXTRA = { volume: 't', water: 'ml', clock: '24' };
const IMPERIAL = { ...EXTRA, distance: 'mi', weight: 'lb', temp: 'f' };

test('normUnits: one choice per unit, the old single switch, and junk', () => {
  assert.deepEqual(normUnits('metric'), UNITS_DEFAULT);
  assert.deepEqual(normUnits('imperial'), IMPERIAL);
  assert.deepEqual(normUnits({ system: 'imperial' }), IMPERIAL);
  assert.deepEqual(normUnits({ system: 'imperial', weight: 'kg' }), { ...EXTRA, distance: 'mi', weight: 'kg', temp: 'f' });
  assert.deepEqual(normUnits({ ...EXTRA, distance: 'mi' }), { ...EXTRA, distance: 'mi', weight: 'kg', temp: 'c' });
  assert.deepEqual(normUnits({ temperature: '°F' }), { ...EXTRA, distance: 'km', weight: 'kg', temp: 'f' });
  assert.deepEqual(normUnits({ weight: 'stone' }, IMPERIAL), IMPERIAL, 'an unknown value keeps what was there');
  for (const junk of [null, undefined, 7, 'furlongs', [], {}]) assert.deepEqual(normUnits(junk), UNITS_DEFAULT);
  assert.equal(unitSystem(UNITS_DEFAULT), 'metric');
  assert.equal(unitSystem(IMPERIAL), 'imperial');
  assert.equal(unitSystem({ ...EXTRA, distance: 'mi', weight: 'kg', temp: 'c' }), 'mixed');
});

test('profiles saved with the single switch are migrated on open, and nothing else changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-units-'));
  const path = join(dir, 'app.sqlite');
  try {
    let app = openAppDb(path);
    const stored = { a: '"metric"', b: '"imperial"', c: 'imperial', d: '{"system":"imperial"}', e: '{"distance":"mi"}', f: '{}', g: 'not json', h: '{"distance":"mi","weight":"kg","temp":"f"}' };
    for (const id of Object.keys(stored)) {
      app.createProfile({ userId: id, username: `u${id}`, tz: 'Africa/Cairo', now: 1000 });
      app.patchProfile(id, { displayName: `Name ${id}`, bio: 'kept', privacy: { ...app.profile(id).privacy, sleep: true } });
      app.run('UPDATE profile SET units = ? WHERE user_id = ?', stored[id], id);
    }
    app.close();
    app = openAppDb(path);
    const want = { a: UNITS_DEFAULT, b: IMPERIAL, c: IMPERIAL, d: IMPERIAL, e: { ...EXTRA, distance: 'mi', weight: 'kg', temp: 'c' }, f: UNITS_DEFAULT, g: UNITS_DEFAULT, h: { ...EXTRA, distance: 'mi', weight: 'kg', temp: 'f' } };
    for (const id of Object.keys(stored)) {
      const p = app.profile(id);
      assert.deepEqual(p.units, want[id], id);
      assert.deepEqual(JSON.parse(app.get('SELECT units FROM profile WHERE user_id = ?', id).units), want[id], `${id} is rewritten on disk`);
      assert.deepEqual([p.displayName, p.bio, p.privacy.sleep, p.tz, p.joinedAt], [`Name ${id}`, 'kept', true, 'Africa/Cairo', 1000]);
    }
    app.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH /api/settings: each unit by itself, the old single field, and bad values', async () => {
  const r = await rig();
  try {
    const p = await r.person('units');
    const me0 = (await p.c.get('/api/me')).json;
    assert.deepEqual([me0.units, me0.unitSystem], [UNITS_DEFAULT, 'metric']);

    let x = await p.c.patch('/api/settings', { units: { weight: 'lb' } });
    assert.deepEqual([x.status, x.json.units, x.json.unitSystem], [200, { ...EXTRA, distance: 'km', weight: 'lb', temp: 'c' }, 'mixed']);
    x = await p.c.patch('/api/settings', { units: { temp: 'f' } });
    assert.deepEqual(x.json.units, { ...EXTRA, distance: 'km', weight: 'lb', temp: 'f' });
    x = await p.c.patch('/api/settings', { units: { ...EXTRA, distance: 'mi' } });
    assert.deepEqual([x.json.units, x.json.unitSystem], [IMPERIAL, 'imperial']);

    // What an old cached frontend may still send.
    x = await p.c.patch('/api/settings', { units: 'metric' });
    assert.deepEqual([x.status, x.json.units, x.json.unitSystem], [200, UNITS_DEFAULT, 'metric']);
    x = await p.c.patch('/api/settings', { units: 'imperial' });
    assert.deepEqual([x.status, x.json.units], [200, IMPERIAL]);
    x = await p.c.patch('/api/settings', { units: { ...EXTRA, distance: 'km', weight: 'kg', temp: 'c' } });
    assert.deepEqual(x.json.units, UNITS_DEFAULT);

    for (const units of ['furlongs', { weight: 'stone' }, { ...EXTRA, distance: 'm' }, { temp: 'k' }]) {
      const bad = await p.c.patch('/api/settings', { units });
      assert.equal(bad.status, 400, JSON.stringify(units));
    }
    assert.deepEqual((await p.c.get('/api/me')).json.units, UNITS_DEFAULT, 'a refused patch changes nothing');

    // Units are display only: the API stays metric.
    await p.c.patch('/api/settings', { units: 'imperial' });
    const exp = (await p.c.get('/api/export')).json;
    assert.deepEqual(exp.units, IMPERIAL);
  } finally { await r.close(); }
});

test('normUnits: training volume, water and the clock are their own choices', () => {
  assert.deepEqual(normUnits({ volume: 'kg', water: 'oz', clock: '12' }), { distance: 'km', weight: 'kg', temp: 'c', volume: 'kg', water: 'oz', clock: '12' });
  assert.deepEqual(normUnits({ clock: '13' }, { ...UNITS_DEFAULT, clock: '12' }).clock, '12', 'an unknown value keeps what was there');
  assert.equal(unitSystem({ ...UNITS_DEFAULT, volume: 'lb', water: 'oz', clock: '12' }), 'metric', 'only distance, weight and temperature make the system');
});
