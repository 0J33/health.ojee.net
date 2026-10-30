/* The home heart-rate relay and handing the sensor over: a relay delivers
   while nothing else does, is told to step aside when a browser claims the
   sensor or delivers itself, and learns which sensors are the person's. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

let r; let p; let key;
before(async () => {
  r = await rig();
  p = await r.person('hrfan');
  key = (await p.c.post('/api/link/keys', { label: 'Home relay' })).json.key;
});
after(async () => { await r.close(); });
const relay = (path, body) => r.client().call(body ? 'POST' : 'GET', path, { headers: { authorization: `Bearer ${key}` }, origin: null, ...(body ? { body } : {}) });
const sample = (bpm) => ({ samples: [{ t: Date.now(), bpm }], source: 'relay-hp' });

test('a relay delivers while nothing else does; a browser claim or a browser reading makes it step aside', async () => {
  let x = await relay('/api/live/relay?source=relay-hp');
  assert.deepEqual([x.status, x.json.busy, x.json.names], [200, false, []]);
  x = await relay('/api/live/hr', sample(72));
  assert.deepEqual([x.json.ok, x.json.yield], [true, false]);
  assert.deepEqual([(await p.c.get('/api/live')).json.bpm, (await p.c.get('/api/live')).json.source], [72, 'relay-hp']);
  // The browser is about to connect: it claims, the relay hears "yield" at its next post.
  const c = await p.c.post('/api/live/claim', { name: 'Fitbit Air' });
  assert.equal(c.json.relayHeld, true, 'the relay was holding it');
  x = await relay('/api/live/hr', sample(73));
  assert.deepEqual([x.json.yield, x.json.why], [true, 'claimed']);
  assert.equal((await p.c.get('/api/live')).json.bpm, 72, 'a yielding relay\'s reading is not shown');
  x = await relay('/api/live/relay?source=relay-hp');
  assert.deepEqual([x.json.busy, x.json.names], [true, ['Fitbit Air']], 'and it learns the sensor\'s name');
  // The browser delivering itself keeps the relay aside.
  await p.c.post('/api/live/hr', { samples: [{ t: Date.now(), bpm: 80 }] });
  x = await relay('/api/live/hr', sample(74));
  assert.equal(x.json.yield, true);
  assert.equal((await p.c.get('/api/live')).json.source, 'browser');
  // A bad key is refused.
  assert.equal((await r.client().call('GET', '/api/live/relay', { headers: { authorization: 'Bearer hlk_nope' }, origin: null })).status, 401);
});
