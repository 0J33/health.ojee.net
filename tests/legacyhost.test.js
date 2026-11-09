import test from 'node:test';
import assert from 'node:assert/strict';
import { movedFrom } from '../server/legacyhost.js';

const config = { origin: 'https://rep.ojee.net', legacyHosts: ['health.ojee.net'] };
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36';
const req = (o = {}) => ({ method: 'GET', headers: { host: 'health.ojee.net', 'user-agent': SAFARI, ...o.headers }, ...(o.method ? { method: o.method } : {}) });

test('a browser at the old address is sent on', () => {
  assert.deepEqual(movedFrom(config, req(), '/'), { redirect: true });
  assert.deepEqual(movedFrom(config, req(), '/sleep'), { redirect: true });
  assert.deepEqual(movedFrom(config, req(), '/auth/google/start'), { redirect: true });
});
test('the new address, and a site with no old address, are served as usual', () => {
  assert.equal(movedFrom(config, req({ headers: { host: 'rep.ojee.net' } }), '/'), null);
  assert.equal(movedFrom({ origin: 'https://x', legacyHosts: [] }, req(), '/'), null);
});
test('what others call at the old address keeps working', () => {
  for (const p of ['/api/health', '/api/strava/webhook', '/mcp', '/auth/google/callback', '/auth/strava/callback']) assert.equal(movedFrom(config, req(), p), null, p);
  assert.equal(movedFrom(config, req({ method: 'POST' }), '/auth/login'), null);
});
test('installed apps stay at the old address until they are replaced', () => {
  for (const ua of [IOS_APP, ANDROID_APP, 'Mozilla/5.0 (X11; Linux x86_64) Health/1.0 Chrome/130 Electron/33.0 Safari/537.36']) {
    assert.equal(movedFrom(config, req({ headers: { 'user-agent': ua } }), '/'), null, ua);
    assert.equal(movedFrom(config, req({ headers: { 'user-agent': ua } }), '/sw.js'), null, ua);
  }
});
test('a browser gets the worker that removes itself, never a redirected one', () => {
  assert.deepEqual(movedFrom(config, req(), '/sw.js'), { worker: true });
});
