/* The iPhone app's notifications (server/apns.js): signed with the account's key, sent to Apple's
   production service and, for a development build's token, its sandbox; a token Apple no longer
   knows removes the device. And the iPhone app registers as a device like the Android app does. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { Apns, APNS_HOSTS, loadApnsKey } from '../server/apns.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const creds = loadApnsKey({ keyFile: 'k.p8', keyId: 'KEY123', teamId: 'TEAM45', topic: 'net.ojee.health' }, { read: () => pem });
const TOKEN = 'a'.repeat(64);

test('a missing setting or an unreadable key turns it off', () => {
  assert.equal(loadApnsKey({ keyFile: 'k.p8', keyId: 'K', teamId: null, topic: 't' }, { read: () => pem }), null);
  assert.equal(loadApnsKey({ keyFile: 'k.p8', keyId: 'K', teamId: 'T', topic: 't' }, { read: () => 'not a key' }), null);
  assert.ok(creds);
});

test('one alert to one phone, signed with the key (ES256), with the page to open', async () => {
  const calls = [];
  const apns = new Apns({ creds, request: async (host, path, headers, body) => { calls.push({ host, path, headers, body: JSON.parse(body) }); return { status: 200, body: '' }; } });
  await apns.send(TOKEN, { title: 'Goal reached', body: '10,000 steps', url: '/today', tag: 'goal', type: 'goal' });
  const c = calls[0];
  assert.equal(c.host, APNS_HOSTS.production);
  assert.equal(c.path, `/3/device/${TOKEN}`);
  assert.equal(c.headers['apns-topic'], 'net.ojee.health');
  assert.equal(c.headers['apns-push-type'], 'alert');
  assert.deepEqual(c.body.aps.alert, { title: 'Goal reached', body: '10,000 steps' });
  assert.equal(c.body.url, '/today');
  const [h, p, s] = c.headers.authorization.replace(/^bearer /, '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, 'TEAM45');
  assert.ok(createVerify('SHA256').update(`${h}.${p}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'Apple can check the signature');
});

test('a development build\'s token goes to the sandbox; a gone one is 410', async () => {
  const hosts = [];
  const dev = new Apns({ creds, request: async (host) => { hosts.push(host); return host === APNS_HOSTS.production ? { status: 400, body: '{"reason":"BadDeviceToken"}' } : { status: 200, body: '' }; } });
  await dev.send(TOKEN, { title: 't' });
  assert.deepEqual(hosts, [APNS_HOSTS.production, APNS_HOSTS.sandbox]);
  const gone = new Apns({ creds, request: async () => ({ status: 410, body: '{"reason":"Unregistered"}' }) });
  await assert.rejects(gone.send(TOKEN, { title: 't' }), (e) => e.statusCode === 410);
  const busy = new Apns({ creds, request: async () => ({ status: 429, body: '{"reason":"TooManyRequests"}' }) });
  await assert.rejects(busy.send(TOKEN, { title: 't' }), (e) => e.statusCode === 429);
});
