/* The weather on Today (server/weather.js): the place, the words, the
   training line, and GET /api/weather over a stand-in Open-Meteo. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { conditionOf, placeOf, trainingNote, pointOf, spotName } from '../server/weather.js';

const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });

test('where: the profile\'s city, else the time zone\'s; nothing for UTC', () => {
  assert.deepEqual(placeOf({ city: 'Alexandria', country: 'EG', tz: 'Africa/Cairo' }), { name: 'Alexandria', country: 'EG' });
  assert.deepEqual(placeOf({ tz: 'America/New_York' }), { name: 'New York', country: null });
  assert.equal(placeOf({ tz: 'UTC' }), null);
  assert.equal(placeOf({ tz: 'Etc/GMT+3' }), null);
});

test('words, icons, and a line only when the weather matters for training', () => {
  assert.deepEqual(conditionOf(0, true), { text: 'Clear', icon: 'sun' });
  assert.deepEqual(conditionOf(0, false), { text: 'Clear night', icon: 'moon' });
  assert.equal(conditionOf(63).icon, 'cloud_rain');
  assert.equal(conditionOf(95).text, 'Thunderstorm');
  assert.equal(trainingNote({ feels: 22, hi: 26, uv: 5, rain: 10, wind: 12, code: 1 }), null, 'an ordinary day says nothing');
  assert.match(trainingNote({ feels: 30, hi: 36, uv: 9, rain: 0, wind: 5, code: 0 }), /^Hot later/);
  assert.match(trainingNote({ feels: 18, hi: 20, uv: 2, rain: 80, wind: 10, code: 61 }), /Rain is likely \(80%\)/);
  assert.match(trainingNote({ feels: 25, hi: 28, uv: 10, rain: 0, wind: 5, code: 0 }), /UV/);
  assert.match(trainingNote({ feels: 20, hi: 22, uv: 1, rain: 90, wind: 5, code: 96 }), /indoors/);
});

test('GET /api/weather: the city looked up once, the forecast kept a while; nothing when the service is down', async () => {
  const t = await rig();
  try {
    const asked = [];
    t.weather.fn = async (u) => {
      asked.push(u.hostname);
      if (u.hostname === 'geocoding-api.open-meteo.com') {
        assert.equal(u.searchParams.get('name'), 'Cairo');
        return json({ results: [{ name: 'Cairo', latitude: 30.06263, longitude: 31.24967, country_code: 'EG', country: 'Egypt' }] });
      }
      if (u.hostname === 'api.open-meteo.com') {
        assert.equal(u.searchParams.get('latitude'), '30.06');
        return json({ current: { temperature_2m: 33.4, apparent_temperature: 36.1, weather_code: 0, wind_speed_10m: 8, is_day: 1 }, daily: { temperature_2m_max: [37], temperature_2m_min: [22], precipitation_probability_max: [0], uv_index_max: [9.2], sunrise: ['2026-11-06T06:10'], sunset: ['2026-11-06T17:01'] } });
      }
      return null;
    };
    const p = await t.person('sunny');   // Africa/Cairo
    const r = (await p.c.get('/api/weather')).json;
    assert.equal(r.weather.place, 'Cairo');
    assert.deepEqual([r.weather.now.tempC, r.weather.now.text, r.weather.now.icon, r.weather.today.hiC, r.weather.today.uv], [33.4, 'Clear', 'sun', 37, 9.2]);
    assert.match(r.weather.note, /^Very hot/);
    await p.c.get('/api/weather');
    assert.deepEqual(asked, ['geocoding-api.open-meteo.com', 'api.open-meteo.com'], 'the second ask from memory');
    // Down: no weather, and Today goes on without it.
    t.weather.fn = async () => new Response('', { status: 503 });
    const q = await t.person('rainy', { tz: 'Europe/London' });
    const down = (await q.c.get('/api/weather')).json;
    assert.deepEqual([down.weather, down.unavailable], [null, true]);
    assert.equal((await t.client().get('/api/weather')).status, 401);
  } finally { await t.close(); }
});

test('where the phone is: rounded to about a kilometre, named by its neighbourhood; the city when the name will not come', async () => {
  assert.deepEqual(pointOf('31.21234', '29.94567'), { lat: 31.21, lon: 29.95 });
  assert.equal(pointOf('', '29.9'), null);
  assert.equal(pointOf('95', '10'), null);
  assert.equal(pointOf(null, null), null);
  assert.equal(spotName({ address: { suburb: 'Smouha', city: 'Alexandria' } }), 'Smouha');
  assert.equal(spotName({ address: { city: 'Alexandria' } }), 'Alexandria');
  const t = await rig();
  try {
    const asked = [];
    let named = true;
    t.weather.fn = async (u) => {
      asked.push(u.hostname);
      if (u.hostname === 'nominatim.openstreetmap.org') {
        assert.deepEqual([u.searchParams.get('lat'), u.searchParams.get('lon')], ['31.21', '29.95'], 'only the rounded position leaves');
        return named ? json({ address: { suburb: 'Smouha', city: 'Alexandria' } }) : new Response('', { status: 429 });
      }
      if (u.hostname === 'geocoding-api.open-meteo.com') return json({ results: [{ name: 'Cairo', latitude: 30.06, longitude: 31.25, country_code: 'EG' }] });
      if (u.hostname === 'api.open-meteo.com') {
        assert.equal(u.searchParams.get('latitude'), '31.21');
        return json({ current: { temperature_2m: 21, apparent_temperature: 21, weather_code: 1, wind_speed_10m: 10, is_day: 1 }, daily: { temperature_2m_max: [24], temperature_2m_min: [17] } });
      }
      return null;
    };
    const p = await t.person('walker');   // Africa/Cairo
    const r = (await p.c.get('/api/weather?lat=31.21234&lon=29.94567')).json.weather;
    assert.deepEqual([r.place, r.here, r.now.tempC], ['Smouha', true, 21]);
    await p.c.get('/api/weather?lat=31.2101&lon=29.9499');
    assert.deepEqual(asked, ['nominatim.openstreetmap.org', 'api.open-meteo.com'], 'the same square kilometre from memory');
    // No name for a new spot: the profile's city stands in.
    named = false;
    t.weather.fn = ((fn) => async (u) => (u.hostname === 'api.open-meteo.com' ? json({ current: { temperature_2m: 20, is_day: 1, weather_code: 0 }, daily: {} }) : fn(u)))(t.weather.fn);
    const q = await t.person('wanderer');
    const r2 = (await q.c.get('/api/weather?lat=31.5&lon=30.5')).json.weather;
    assert.equal(r2.here, true);
    assert.equal(r2.place, 'Cairo');
    // Without a position: the city, as before.
    assert.equal((await q.c.get('/api/weather?lat=abc')).json.weather.here, false);
  } finally { await t.close(); }
});
