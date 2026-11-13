/* Connecting Google from the phone app (app.js /api/google/handoff): it happens in the phone's
   browser, whose rep. sign-in may be another account (the one made last week) or none. The
   handoff connects the app's account all the same, never the browser's; it is used once. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

test('Google connected from the app goes to the app\'s account, whoever the browser is signed in as', async () => {
  const r = await rig();
  try {
    const inApp = await r.person('newacct');     // the account the app is signed in to
    const inBrowser = await r.person('oldacct');  // the browser's: an older account of the same person
    r.parts.personaOf.set(inApp.id, 'fitbit');
    assert.equal((await r.client().post('/api/google/handoff', {})).status, 401, 'signed out: no handoff');
    const { path } = (await inApp.c.post('/api/google/handoff', { groups: [] })).json;
    assert.match(path, /^\/auth\/google\/start\?handoff=/);

    // The browser, signed in as the other account, opens it.
    const start = await inBrowser.c.get(path);
    const consent = new URL(start.headers.get('location'));
    const back = new URL((await inBrowser.c.get(consent.pathname + consent.search)).headers.get('location'));
    const done = await inBrowser.c.get(back.pathname + back.search);
    assert.equal(done.status, 200);
    assert.match(done.text, /Google is connected/);
    assert.match(done.text, /@newacct/, 'the page names the account it went to');
    assert.match(done.text, /ojeehealth:\/\/open\/settings\/connections\?google=connected/);
    await new Promise((res) => { setTimeout(res, 200); });
    assert.equal((await inApp.c.get('/api/me')).json.google.state, 'ok', 'the app\'s account is connected');
    assert.notEqual((await inBrowser.c.get('/api/me')).json.google.state, 'ok', 'the browser\'s is not');

    // Once only; and a signed-out browser works the same.
    assert.equal((await r.client().get(path)).status, 410);
    const p2 = (await inApp.c.post('/api/google/handoff', {})).json.path;
    const anon = r.client();
    const s2 = new URL((await anon.get(p2)).headers.get('location'));
    assert.equal(s2.hostname !== 'rep.test' && s2.searchParams.has('state'), true, 'straight on to Google, no sign-in asked');
  } finally { await r.close(); }
});
