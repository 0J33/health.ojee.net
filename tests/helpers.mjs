/* Shared by the server tests: the real app over a fake Mongo, a fake Google
   (one synthetic person per user, with a chosen device) and a fake push
   service, on a throwaway port and data directory. No network, no real
   database. */

import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { demoParts } from '../server/demo.js';
import { pkce } from '../server/core/google.js';
import { fakeHevy, fakeStrava, fakeFood, fakeXiaomi, fakeGarmin, fakeOpencode, STRAVA_TEST_URLS, FOOD_TEST_URLS } from '../server/fake-sources.js';

export const ORIGIN = 'https://health.test';

export async function rig({ env = {}, now = () => Date.now(), zenFetch, web = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'health-test-'));
  const webDir = join(dir, 'web');
  mkdirSync(webDir, { recursive: true });
  for (const [name, body] of Object.entries(web || { 'index.html': '<!doctype html><title>health</title>', 'sw.js': '// sw', 'app.js': 'export {};', 'manifest.webmanifest': '{}' })) {
    mkdirSync(join(webDir, name, '..'), { recursive: true });
    writeFileSync(join(webDir, name), body);
  }
  const config = loadConfig({
    PUBLIC_ORIGIN: ORIGIN, DATA_DIR: join(dir, 'data'), WEB_DIR: webDir, APP_SECRET: 'test-secret', COOKIE_DOMAIN: '.ojee.net',
    GOOGLE_HEALTH_CLIENT_ID: 'cid', GOOGLE_HEALTH_CLIENT_SECRET: 'csecret', HEALTH_SCHEDULER: 'off', ADMIN_USERS: 'ojee', DEFAULT_TZ: 'Africa/Cairo',
    STRAVA_CLIENT_ID: '1234', STRAVA_CLIENT_SECRET: 'strava-secret', STRAVA_VERIFY_TOKEN: 'verify-me', HEVY_GAP_MS: '0', OPENCODE_URL: 'http://opencode.test', OPENCODE_SUMMARY_ATTEMPTS: '2', OPENCODE_POLL_MS: '20', ...env,
  });
  config.googleGapMs = 0;
  let app;
  const parts = demoParts({ now, origin: ORIGIN, tzOf: (id) => app?.app.profile(id)?.tz || 'Africa/Cairo' });
  const pushed = [];
  const push = { fail: null };   // set to a status code to make the push service answer that
  const wrap = { fn: null };     // (userId, url, init, accountId) => Response | null, in front of the fake Google
  const googleFetch = (userId, acct) => { const inner = parts.googleFetch(userId); return async (u, init) => (wrap.fn && await wrap.fn(userId, new URL(String(u)), init, acct)) || inner(u, init); };
  // Hevy, Strava and Open Food Facts: in-memory stand-ins (server/fake-sources.js).
  const hevy = fakeHevy({ now });
  const strava = fakeStrava({ now });
  const food = fakeFood();
  const xiaomi = fakeXiaomi({ now });
  const garmin = fakeGarmin({ now, tz: 'Africa/Cairo' });
  const media = [];
  const opencode = fakeOpencode();
  app = createApp({
    hevyFetch: hevy.fetch, stravaFetch: strava.fetch, stravaUrls: STRAVA_TEST_URLS, foodFetch: food.fetch, foodUrls: FOOD_TEST_URLS, xiaomiFetch: xiaomi.fetch, xiaomiGapMs: 5, garminFetch: garmin.fetch, garminGapMs: 0, opencodeFetch: opencode.fetch,
    // The exercise photos and map tiles: tiny stand-ins, counted.
    libraryFetch: async (u) => { media.push(String(u)); return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { headers: { 'content-type': 'image/jpeg' } }); },
    // Strava's photo files: a JPEG carrying an EXIF block with a GPS tag, which must not survive.
    stravaPhotoFetch: async (u) => { media.push(String(u)); return new Response(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPSGPSGP'), Buffer.from([0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9])]), { headers: { 'content-type': 'image/jpeg' } }); },
    tileFetch: async (u) => { media.push(String(u)); return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), { headers: { 'content-type': 'image/png' } }); },
    config, mongo: parts.mongo, googleFetch, googleEndpoints: parts.endpoints, demoConnect: parts.demoConnect, now, log: process.env.RIG_LOG ? (m) => console.error('LOG', m) : () => {},
    zenFetch: zenFetch || (async () => { throw new Error('no network in tests'); }),
    pushSend: async (sub, payload) => { if (push.fail) throw Object.assign(new Error('push failed'), { statusCode: push.fail }); pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); },
  });
  const server = http.createServer(app.handler);
  // As in production (server/index.js): a pause of more than 5 s between two
  // requests (a Garmin backfill) must not meet a socket the server just closed.
  server.keepAliveTimeout = 65_000;
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A browser-ish client with its own cookie jar. */
  let clients = 0;
  function client() {
    let cookie = '';
    // Each client is its own visitor address, so the per-address limits on
    // login and register are tested where they are meant to be, not tripped
    // by every test sharing 127.0.0.1.
    clients += 1;
    const ip = `198.51.${Math.floor(clients / 250)}.${clients % 250}`;
    const call = async (method, path, { body, raw, headers = {}, origin = ORIGIN, redirect = 'manual' } = {}) => {
      const h = { 'cf-connecting-ip': ip, ...headers };
      if (cookie) h.cookie = cookie;
      if (origin && method !== 'GET') h.origin = origin;
      let payload;
      if (raw !== undefined) payload = raw; else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
      const res = await fetch(base + path, { method, headers: h, body: payload, redirect });
      const set = res.headers.getSetCookie?.() || [];
      for (const c of set) { const [kv] = c.split(';'); const v = kv.split('=')[1]; cookie = v ? kv : ''; }
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers, setCookie: set };
    };
    return {
      get: (p, o) => call('GET', p, o), post: (p, body, o) => call('POST', p, { body, ...o }), put: (p, body, o) => call('PUT', p, { body, ...o }),
      patch: (p, body, o) => call('PATCH', p, { body, ...o }), del: (p, o) => call('DELETE', p, o), call,
      get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    };
  }

  /** Register a person and return their client and id. */
  async function person(username, { password = 'pass1234', tz = 'Africa/Cairo', persona = null, privacy = null, onboarding = 'done' } = {}) {
    const c = client();
    const r = await c.post('/auth/register', { username, password, tz });
    if (r.status !== 200) throw new Error(`register ${username}: ${r.status} ${r.text}`);
    const id = r.json.user.id;
    // Signed up all the way, as anybody others see is (people mid-sign-up are not suggested).
    if (onboarding) app.app.patchProfile(id, { onboarding });
    if (privacy) await c.patch('/api/settings', { privacy });
    if (persona) await connect(id, persona);
    return { c, id, username };
  }

  /** Connect a person's fake Google (a persona from core/demo.js) and sync once. */
  async function connect(userId, persona = 'fitbit') {
    parts.personaOf.set(userId, persona);
    await app.worlds.hold(userId, async (w) => {
      const pk = pkce();
      await w.google.exchange({ code: parts.issue(pk.challenge), verifier: pk.verifier });
      app.app.patchProfile(userId, { googleState: 'ok' });
    });
    return app.syncUser(userId);
  }

  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => { server.close(r); });
    app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, base, client, person, connect, parts, pushed, push, wrap, close, dir, config, hevy, strava, food, xiaomi, garmin, media, opencode };
}
