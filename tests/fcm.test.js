/* The Android app's notifications: Firebase (server/fcm.js), and its tokens as devices (notify.js). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { rig } from './helpers.mjs';
import { Fcm, loadServiceAccount } from '../server/fcm.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { type: 'service_account', project_id: 'demo-proj', client_email: 'fcm@demo-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.example/token' };

test('signs in with the service account once, then sends a notification message on the health channel', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === account.token_uri) {
      const jwt = new URLSearchParams(init.body).get('assertion');
      const [h, c, s] = jwt.split('.');
      assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')), 'signed with the account key');
      assert.equal(JSON.parse(Buffer.from(c, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const f = new Fcm({ account, fetchImpl });
  await f.send('abc', { title: 'Hi', body: 'There', url: '/workouts', tag: 'goal', type: 'goal' });
  await f.send('abc', { title: 'Again', body: '', url: '/' });
  assert.equal(calls.filter((c) => c.url === account.token_uri).length, 1, 'the access token is kept');
  const send = calls.find((c) => c.url.includes('/messages:send'));
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/demo-proj/messages:send');
  assert.equal(send.init.headers.authorization, 'Bearer tok-1');
  const msg = JSON.parse(send.init.body).message;
  assert.deepEqual([msg.token, msg.notification.title, msg.data.url, msg.android.notification.channel_id], ['abc', 'Hi', '/workouts', 'health']);
});

test('a token Firebase no longer knows is gone for good (410); anything else is a failure', async () => {
  const answer = (status, body) => async (url) => (url === account.token_uri ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response(JSON.stringify(body), { status }));
  await assert.rejects(new Fcm({ account, fetchImpl: answer(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) }).send('x', { title: 'a' }), (e) => e.statusCode === 410);
  await assert.rejects(new Fcm({ account, fetchImpl: answer(503, { error: { status: 'UNAVAILABLE' } }) }).send('x', { title: 'a' }), (e) => e.statusCode === 503);
});

test('the key file: read when it is a service account, ignored otherwise', () => {
  assert.equal(loadServiceAccount(null), null);
  assert.equal(loadServiceAccount('/x', { read: () => '{"type":"user"}' }), null);
  assert.equal(loadServiceAccount('/x', { read: () => JSON.stringify(account) }).project_id, 'demo-proj');
});

let r;
before(async () => { r = await rig(); });
after(() => r.close());

test('the app on a phone is a device: added by its token, sent to, tested, renamed by a new token, removed when Firebase forgets it', async () => {
  const p = await r.person('droid');
  const sent = [];
  let gone = false;
  assert.equal((await p.c.get('/api/push')).json.app, false, 'no key file in the tests');
  assert.equal((await p.c.post('/api/push/subscribe', { fcm: 'tokA_0123456789abcdefghij' })).status, 409, 'and so no app devices');
  const prev = r.app.notifier.fcm;
  r.app.notifier.fcm = { send: async (token, n) => { if (gone) throw Object.assign(new Error('unregistered'), { statusCode: 410 }); sent.push([token, n.title]); } };
  try {
    assert.equal((await p.c.get('/api/push')).json.app, true);
    const a = (await p.c.post('/api/push/subscribe', { fcm: 'tokA_0123456789abcdefghij', label: 'Pixel 9' })).json;
    assert.ok(a.deviceId);
    assert.deepEqual(a.devices.map((d) => [d.label, d.kind]), [['Pixel 9', 'app']]);
    await p.c.post('/api/push/test', {});
    assert.deepEqual(sent, [['tokA_0123456789abcdefghij', 'Notifications are working']]);
    // A new token for the same phone: the same device.
    const b = (await p.c.post('/api/push/subscribe', { fcm: 'tokB_0123456789abcdefghij', label: 'Pixel 9', was: a.deviceId })).json;
    assert.equal(b.deviceId, a.deviceId);
    assert.equal(b.devices.length, 1);
    assert.equal((await p.c.post('/api/push/subscribe', { fcm: 'bad token!' })).status, 400);
    gone = true;
    const t = (await p.c.post('/api/push/test', {})).json;
    assert.equal(t.removed, 1);
    assert.equal((await p.c.get('/api/push')).json.devices.length, 0);
  } finally { r.app.notifier.fcm = prev; }
});
