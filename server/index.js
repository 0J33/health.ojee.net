/* ============================================================
   health.ojee.net — the process: one Node server for the API and
   the static app, on one origin.

     npm start       the real thing (needs .env; see deploy/.env.example)
     npm run demo    everything faked and seeded, on :5020

   Secrets come from the environment and are never printed.
   ============================================================ */

import http from 'node:http';
import { loadConfig, VERSION } from './config.js';
import { createApp } from './app.js';
import { connectMongo } from './accounts.js';

const config = loadConfig();
const log = (m) => console.warn(`  ${m}`);

let app; let mongoClient = null; let demo = null;

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
  app = createApp({ config, mongo: demo.mongo, googleFetch: demo.googleFetch, googleEndpoints: demo.endpoints, demoConnect: demo.demoConnect, log });
  console.log(`health.ojee.net ${VERSION} — DEMO MODE. Nothing real is touched: accounts are in memory, Google is a stand-in, data is in ${config.dataDir}.`);
  console.log('  seeding people (a few seconds)…');
  await demo.seed(app);
  console.log('\n  Sign in with any of these (password for all: ' + SEED_PASSWORD + '):');
  for (const s of SEED) console.log(`    ${s.username.padEnd(6)} ${s.what}`);
  console.log('  New accounts can be registered too; they last until the server stops.\n');
} else {
  if (!config.origin) { console.error('PUBLIC_ORIGIN is not set. Copy deploy/.env.example to .env and fill it in.'); process.exit(1); }
  if (!config.appSecret) console.warn('  APP_SECRET is not set: OpenCode keys cannot be saved until it is.');
  let conn;
  try { conn = await connectMongo(config.mongoUri); } catch (e) {
    // The URI may hold credentials: only the reason is printed.
    console.error(`Cannot reach the accounts database (MONGODB_URI): ${e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://…')}`);
    process.exit(1);
  }
  mongoClient = conn.client;
  app = createApp({ config, mongo: conn.db, log });
  console.log(`health.ojee.net ${VERSION}`);
  console.log(`  origin ${config.origin}; data ${config.dataDir}; accounts database connected`);
  console.log(`  google ${config.google.clientId && config.google.clientSecret ? 'client configured' : 'GOOGLE_HEALTH_CLIENT_ID/SECRET missing: nobody can connect yet'}; redirect ${config.google.redirectUri}`);
  console.log(`  registration ${app.app.registrationOpen() ? 'open' : 'closed'}; admins: ${config.admins.join(', ')}`);
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
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections?.();
    try { app.close(); } catch { /* closing */ }
    mongoClient?.close().catch(() => {});
    process.exit(0);
  });
}
