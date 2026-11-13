/* ============================================================
   health.ojee.net — the process: one Node server for the API and
   the static app, on one origin.

     npm start       the real thing (needs .env; see deploy/.env.example)
     npm run demo    everything faked and seeded, on :5020

   Secrets come from the environment and are never printed.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, VERSION } from './config.js';
import { createApp } from './app.js';
import { runMergeJobs } from './merge.js';
import { connectMongo, migrateFromMongo } from './accounts.js';

const config = loadConfig();
const log = (m) => console.warn(`  ${m}`);

let app; let demo = null;

if (config.demo) {
  const { demoParts, wipeDemoData, SEED, SEED_PASSWORD } = await import('./demo.js');
  // Before the wipe: a second demo started by mistake must not pull the
  // data out from under the one that is already running on this port.
  const taken = await new Promise((resolve) => {
    const probe = http.createServer().once('error', () => resolve(true)).once('listening', () => probe.close(() => resolve(false)));
    probe.listen(config.port, config.host);
  });
  if (taken) { console.error(`Port ${config.port} is already in use (is the demo already running?). Stop what is on it, or set PORT.`); process.exit(1); }
  wipeDemoData(config.dataDir);
  demo = demoParts({ origin: config.origin, tzOf: (id) => app?.app.profile(id)?.tz || config.defaultTz });
  // The demo has no Google client of its own; the stand-in accepts any.
  config.google = { clientId: 'demo', clientSecret: 'demo', redirectUri: `${config.origin}/auth/google/callback` };
  config.googleGapMs = 0;
  // The seeded people sign in with their password, as the app reviewers' demo account does.
  config.signin.passwordLogin = [...new Set([...config.signin.passwordLogin, ...SEED.map((x) => x.username.toLowerCase())])];
  // Hevy, Strava and Open Food Facts are stand-ins too (server/fake-sources.js).
  const { fakeHevy, fakeStrava, fakeFood, fakeXiaomi, fakeGarmin, fakeSignin, FOOD_TEST_URLS, SIGNIN_TEST_URLS } = await import('./fake-sources.js');
  const hevy = fakeHevy();
  const strava = fakeStrava();
  const food = fakeFood();
  const DAY = 86_400_000;
  // A scale with two people on it; its code is "scanned" five seconds after it is shown.
  const xiaomi = fakeXiaomi({ autoScanMs: 5000 });
  // Garmin takes its test key, and any key pasted in the demo that starts "demo".
  const garmin = fakeGarmin({ tz: 'Asia/Dubai' });
  const garminFetch = (u, init = {}) => {
    const h = new Headers(init.headers || {});
    const k = (h.get('authorization') || '').replace(/^ApiKey /, '');
    if (/^demo[\x21-\x7e]{12,}$/i.test(k)) garmin.state.keys.add(k);
    return garmin.fetch(u, init);
  };
  for (let back = 20; back >= 0; back -= 2) {
    const d = new Date(Date.now() - back * DAY); d.setHours(7, 20, 0, 0);
    // Numbers that hang together the way the scale's own do: muscle is what is not fat or bone, water about 70% of the lean.
    const kg = Math.round((79.6 + back * 0.06) * 10) / 10; const fat = Math.round((18.1 + back * 0.03) * 10) / 10;
    const muscle = Math.round((kg * (1 - fat / 100) - 3.1) * 10) / 10; const water = Math.round((100 - fat) * 0.668 * 10) / 10;
    xiaomi.weighIn({ t: d.getTime(), kg, fat, muscle, water, bone: 3.1, protein: Math.round(((muscle / kg) * 100 - water) * 8.5) / 10, visceral: 9, bmr: Math.round(1688 + (kg - 79.6) * 15), age: 27, ohm: 478 + back, hr: 62 + (back % 5), bt: back % 6 === 0 ? 5 : null });
    xiaomi.weighIn({ t: d.getTime() + 15 * 60_000, kg: 61.8, profile: 2, fat: 26.4, muscle: 43.1, water: 51.5, bone: 2.4, protein: 18.2, visceral: 6, bmr: 1290, age: 41, ohm: 562, hr: 71 });
  }
  for (const [title, back, h, ex] of [['Push', 1, 18, null], ['Pull', 3, 18, [{ exercise_template_id: 'B5D3A742', sets: [{ weight_kg: 55, reps: 10 }, { weight_kg: 60, reps: 8 }] }, { exercise_template_id: '55E6546F', sets: [{ weight_kg: 50, reps: 10 }] }, { exercise_template_id: 'A5AC6449', sets: [{ weight_kg: 12, reps: 12 }, { weight_kg: 12, reps: 10 }] }]], ['Legs', 5, 17, [{ exercise_template_id: 'D04AC939', sets: [{ weight_kg: 80, reps: 8 }, { weight_kg: 90, reps: 5 }, { weight_kg: 90, reps: 5 }] }, { exercise_template_id: 'C7973E0E', sets: [{ weight_kg: 140, reps: 12 }] }]]]) {
    const d = new Date(Date.now() - back * DAY); d.setHours(h, 0, 0, 0);
    hevy.addWorkout({ title, start: d.getTime(), minutes: 55, ...(ex ? { exercises: ex } : {}) });
  }
  hevy.addRoutine({ title: 'Push day', exercises: [{ exercise_template_id: '79D0BB3A', sets: [{ weight_kg: 60, reps: 8 }, { weight_kg: 60, reps: 8 }, { weight_kg: 60, reps: 8 }] }, { exercise_template_id: '073032BB', sets: [{ weight_kg: 35, reps: 10 }] }, { exercise_template_id: '94B7239B', sets: [{ weight_kg: 25, reps: 12 }] }] });
  hevy.addRoutine({ title: 'Leg day', exercises: [{ exercise_template_id: 'D04AC939', sets: [{ weight_kg: 80, reps: 8 }] }, { exercise_template_id: 'C7973E0E', sets: [{ weight_kg: 120, reps: 12 }] }] });
  { const d = new Date(Date.now() - 2 * DAY); d.setHours(7, 10, 0, 0); strava.addActivity({ name: 'Morning Run', sport: 'Run', start: d.getTime(), minutes: 38, distance: 7200, polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@_seK_fjF' }); }
  { const d = new Date(Date.now() - 4 * DAY); d.setHours(16, 30, 0, 0); strava.addActivity({ name: 'Afternoon Ride', sport: 'Ride', start: d.getTime(), minutes: 70, distance: 28500, hr: 138, calories: 760 }); }
  config.strava = { ...config.strava, clientId: 'demo', clientSecret: 'demo', redirectUri: `${config.origin}/auth/strava/callback`, verifyToken: '' };
  // Sign in with Google and Apple: stand-ins with their own keys, and a page to choose a made-up account on.
  const signin = fakeSignin({ clientId: 'demo', clientSecret: 'demo', urls: { ...SIGNIN_TEST_URLS, googleAuth: `${config.origin}/demo/signin/google`, appleAuth: `${config.origin}/demo/signin/apple` } });
  const stravaUrls = { auth: `${config.origin}/demo/strava/consent`, token: 'https://strava.test/oauth/token', deauth: 'https://strava.test/oauth/deauthorize', api: 'https://strava.test/api/v3' };
  app = createApp({ config, googleFetch: demo.googleFetch, googleEndpoints: demo.endpoints, demoConnect: demo.demoConnect, log,
    hevyFetch: hevy.fetch, stravaFetch: strava.fetch, stravaUrls, foodFetch: food.fetch, foodUrls: FOOD_TEST_URLS, demoStrava: strava, xiaomiFetch: xiaomi.fetch, garminFetch, garminGapMs: 0, signinFetch: signin.fetch, signinUrls: signin.urls, demoSignin: signin });
  console.log(`  Hevy stand-in: link it with the key ${hevy.state.key}`);
  console.log(`health.ojee.net ${VERSION} — DEMO MODE. Nothing real is touched: accounts are in memory, Google is a stand-in, data is in ${config.dataDir}.`);
  console.log('  seeding people (a few seconds)…');
  await demo.seed(app);
  console.log('\n  Sign in with any of these (password for all: ' + SEED_PASSWORD + '):');
  for (const s of SEED) console.log(`    ${s.username.padEnd(6)} ${s.what}`);
  console.log('  Or sign in with the stand-in Google or Apple to make a new account; it lasts until the server stops.\n');
} else {
  if (!config.origin) { console.error('PUBLIC_ORIGIN is not set. Copy deploy/.env.example to .env and fill it in.'); process.exit(1); }
  const passive = passiveGuard();
  if (passive) await passive;
  if (!config.appSecret) console.warn('  APP_SECRET is not set: OpenCode keys cannot be saved until it is.');
  app = createApp({ config, log });
  // Once, before any request: the people who use rep. brought over from mtg's Mongo, with their
  // live sessions (accounts.js migrateFromMongo; Mongo is only read). Until it has worked it is
  // tried again at every start; after that Mongo is not needed at all.
  if (!app.app.meta('mongoMigrated', null)) {
    let client = null;
    try {
      const conn = await connectMongo(config.mongoUri);
      client = conn.client;
      await migrateFromMongo({ app: app.app, db: conn.db, log });
    } catch (e) {
      // The URI may hold credentials: only the reason is printed.
      console.warn(`  accounts: could not bring the logins over from Mongo (MONGODB_URI): ${e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://…')}. Starting without them; tried again at the next start.`);
    } finally { await client?.close().catch(() => {}); }
  }
  // A one-off admin job (merge.js): two accounts of one person made one, before any request.
  try { const done = await runMergeJobs({ app: app.app, dataDir: config.dataDir, log: (m) => console.warn(`  ${m}`) }); if (done) console.log(`  merged accounts: ${done.filter((x) => x.ok).length} of ${done.length}`); } catch (e) { console.error(`  merge job: ${e.message}`); }
  console.log(`health.ojee.net ${VERSION}`);
  console.log(`  origin ${config.origin}; data ${config.dataDir}; accounts ${app.app.get('SELECT COUNT(*) AS n FROM account').n} in rep.'s own store`);
  console.log(`  google ${config.google.clientId && config.google.clientSecret ? 'client configured' : 'GOOGLE_HEALTH_CLIENT_ID/SECRET missing: nobody can connect yet'}; redirect ${config.google.redirectUri}`);
  console.log(`  registration ${app.app.registrationOpen() ? 'open' : 'closed'}; admins: ${config.admins.join(', ')}`);
  console.log(`  sign-in: Google → ${config.signin.googleRedirectUri}; Apple ${config.signin.appleServicesId} / ${config.signin.appleBundleId} → ${config.signin.appleRedirectUri}`);
}

/*
 * Passive: rep. is running from the live copy on the HP box (deploy/failover-hp.sh), so HP's data
 * is the newer one. deploy/replicate.sh leaves a file PASSIVE beside the data folder when it sees
 * that; then this server neither answers (503, so the edge sends everyone to HP) nor runs anything
 * (no syncs, no notifications) until the file is removed after HP's data is brought back. It is
 * looked for at start and every 15 s; either change ends the process, and systemd starts it again
 * in the other mode.
 */
function passiveGuard() {
  const file = path.join(path.dirname(path.resolve(config.dataDir)), 'PASSIVE');
  if (fs.existsSync(file)) {
    console.warn(`health.ojee.net ${VERSION} — PASSIVE: rep. is running on the HP box (${file}). Answering 503 until that file is removed.`);
    http.createServer((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' });
      res.end(JSON.stringify({ error: 'rep. is running from its standby just now.', code: 'passive' }));
    }).listen(config.port, config.host);
    setInterval(() => { if (!fs.existsSync(file)) { console.warn('  PASSIVE removed: starting again in full.'); process.exit(1); } }, 15_000);
    return new Promise(() => {});   // never returns: nothing else starts
  }
  setInterval(() => { if (fs.existsSync(file)) { console.warn(`  ${file} appeared: rep. is running on the HP box. Stopping, to start again passive.`); process.exit(1); } }, 15_000).unref();
  return null;
}

const server = http.createServer((req, res) => { app.handler(req, res); });
// Longer than nginx's idle keep-alive, so the proxy never reuses a socket
// this end is in the middle of closing.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Stop what is on it, or set PORT.` : `Server error: ${e.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`  listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.demo ? `  (open ${config.origin})` : ''}`);
  if (config.scheduler) app.scheduler.start();
  // Everyone's posts brought up to date once after a change to what they carry.
  setTimeout(() => app.refreshPosts().catch((e) => console.error(`posts: ${e.message}`)), 5000).unref?.();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections?.();
    try { app.close(); } catch { /* closing */ }
    process.exit(0);
  });
}
