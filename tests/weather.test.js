/* The weather on Today (server/weather.js): the place, the words, the
   training line, and GET /api/weather over a stand-in Open-Meteo. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';
import { conditionOf, placeOf, trainingNote } from '../server/weather.js';

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
