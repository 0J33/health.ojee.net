/* ============================================================
   health.ojee.net — the application: every route, wired to one
   person's world or to the public tables.

   createApp() builds it from its parts and returns the request
   handler, so the tests and the demo run the very same code with a
   fake Mongo, a fake Google and a fake push service handed in.

   The shape of a request:
     1. headers every reply gets (CSP and friends);
     2. static files, unless the path is /api/* or /auth/*;
     3. who is asking: the shared ojee.net cookie, or a link key;
     4. a state-changing request must come from this site (Origin);
     5. the route, which gets the signed-in person's own world and
        nobody else's.

   docs/API.md is the contract. Keep the two in step.
   ============================================================ */

import { join, extname, normalize, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { VERSION } from './config.js';
import { openAppDb, ONBOARDING, PRIVACY_DEFAULT, UNIT_CHOICES, normUnits, unitSystem } from './appdb.js';
import { Accounts, SESSION_COOKIE } from './accounts.js';
import { Vault } from './secrets.js';
import { Worlds, UserWorld, validUserId } from './worlds.js';
import { Scheduler } from './scheduler.js';
import { Notifier, TYPES } from './notify.js';
import { DAYS, SITTING_LIMITS, sittingActive, toMin } from './core/alerts.js';
import { computeCaps, readCaps } from './caps.js';
import * as social from './social.js';
import * as friends from './friends.js';
import * as feed from './feed.js';
import * as link from './link.js';
import { MediaStore, CHUNK as MEDIA_CHUNK, LIMITS as MEDIA_LIMITS } from './media.js';
import { Live, parseSamples, cleanSource } from './live.js';
import * as views from './views.js';
import { importHevy } from './hevy.js';
import { MUSCLES, muscleOf } from './muscles.js';
import { pkce, SCOPES, ENDPOINTS, cleanGroups, groupById, GROUP_IDS, build as googleBody, LOCATION_SCOPE } from './core/google.js';
import { XiaomiClient, qrStart, qrPoll, qrImage } from './xiaomi.js';
import { syncXiaomi, xiaomiView, xiaomiMeta, setXiaomiMeta, forgetXiaomi, dropOthers, XIAOMI_DEFAULTS } from './xiaomisync.js';
import { flushEntries, addEntry, editEntry, removeEntry, SENSITIVE_KINDS, settleLoggedSleep } from './core/entries.js';
import { HevyApi } from './hevyapi.js';
import { GarminApi, GarminError, keyShape, jwtExp, KEY_DAYS } from './garmin.js';
import { syncGarmin, garminView, garminMeta, setGarminMeta, BACKFILL_CHOICES } from './garminsync.js';
import { syncHevy, hevyView, hevyMeta, setHevyMeta, forgetHevy, exercisePicker, lastSetsOf, createTemplate, saveRoutine, HEVY_DEFAULTS } from './hevysync.js';
import { fetchStream } from './strava.js';
import { StravaApi, StravaBudget, stravaExchange, syncStrava, stravaView, stravaMeta, setStravaMeta, STRAVA_AUTH, STRAVA_API, STRAVA_SCOPES, STRAVA_DEFAULTS, routeShape } from './strava.js';
import { FoodLookup, ownFoods, commonFoods } from './food.js';
import { logView } from './loghub.js';
import { browseView, metricView, entryView, setPin, setShown, storeDerived, bodyPerson } from './browse.js';
import { ACTIVITY_MODES, WORKOUT_MODES } from './core/merge.js';
import { EXERCISE_TYPES, validType } from './core/workouts.js';
import { clamp, validTz, utcOffsetSec, sleepFor } from './core/util.js';
import { setCustomSource, librarySearch, libById, libByName, libMatch, libView, libSize, ExerciseImages, EQUIPMENT, LIB_MUSCLES, LIBRARY_SOURCE } from './library.js';
import { forgetHevyRoutine } from './hevyroutines.js';
import { cleanRoutine, routineSummary, draftFrom, setsOfDraft, exercisesFromSets, differences, cleanExercises as cleanDraftExercises, previousOf, STARTERS, EX_TYPES } from './routines.js';
import { cleanPoints, cleanPauses, trackStats, routeType, ROUTE_TYPES, toGpx, fromGpx } from './tracks.js';
import { createRoute, getRoute, listRoutes, patchRoute, deleteRoute, routeGpx, SPORTS as ROUTE_SPORTS } from './routelib.js';
import { TileCache } from './tiles.js';
import { Writer } from './core/writer.js';
import { AiJobs, TOPICS as AI_TOPICS, briefing as aiBriefing, prompt as aiPrompt, workoutDetail as aiWorkout, metricDetail as aiMetric, answerCache } from './ai.js';
import { addDays as addDaysU, today as todayU } from './core/util.js';

import { cexCreate, cexPatch, cexGet, cexView, cexVisible, cexAsLib, cexSearch, cexDelete, CexPhotos, syncShared, browseShared, sharedGet, sharedForCopy } from './sharedlib.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

/** No inline scripts, no other hosts. Inline styles are allowed: charts set
    them, and a style cannot run code. blob: for images and video is the
    preview of a photo or video picked to upload, before it is sent. */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const STATUS_CODE = { 400: 'bad_request', 401: 'not_logged_in', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited', 502: 'upstream', 503: 'server_error' };
const err = (message, status = 400, code = null, detail = undefined) => Object.assign(new Error(message), { status, code: code || STATUS_CODE[status] || 'server_error', detail, expose: true });

/** Fixed-window attempt counter, in memory: enough for one small process. */
class Limiter {
  constructor(now) { this.now = now; this.hits = new Map(); }
  #slot(key, windowMs) {
    const t = this.now();
    let s = this.hits.get(key);
    if (!s || t - s.start >= windowMs) { s = { start: t, n: 0 }; this.hits.set(key, s); }
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (t - v.start > 3_600_000) this.hits.delete(k);
    return s;
  }
  /** Throw 429 if this key has used up its attempts. */
  check(key, max, windowMs) {
    const s = this.#slot(key, windowMs);
    if (s.n >= max) {
      const retryAfter = Math.max(1, Math.ceil((s.start + windowMs - this.now()) / 1000));
      throw err('Too many attempts. Wait a little and try again.', 429, 'rate_limited', { retryAfter });
    }
  }
  add(key, windowMs) { this.#slot(key, windowMs).n += 1; }
  clear(key) { this.hits.delete(key); }
}

/**
 * @param {object} o
 * @param {object} o.config        loadConfig()
 * @param {object} o.mongo         a mongodb Db (or FakeMongo)
 * @param {Function} [o.googleFetch]  (userId, accountId) => fetch for that person's Google calls
 * @param {object} [o.googleEndpoints]
 * @param {Function} [o.opencodeFetch]  fetch for the OpenCode server that writes AI answers
 * @param {Function} [o.pushSend]
 */
export function createApp({ config, mongo, googleFetch = null, googleEndpoints = ENDPOINTS, pushSend = null, now = () => Date.now(), log = (m) => console.warn(`  ${m}`), demoConnect = null,
  hevyFetch = null, stravaFetch = null, stravaUrls = null, foodFetch = null, foodUrls = null, demoStrava = null, xiaomiFetch = null, xiaomiGapMs = 1000, garminFetch = null, garminGapMs = null, libraryFetch = null, tileFetch = null, opencodeFetch = null }) {
  const startedAt = now();
  const app = openAppDb(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'app.sqlite'));
  const accounts = new Accounts({ db: mongo, cookieDomain: config.cookieDomain, secure: config.cookieSecure, now });
  const vault = new Vault(config.appSecret);
  const limiter = new Limiter(now);
  /** Which build of the page this server serves: a hash of every file in web/, so any deploy that changes the page changes it. */
  const BUILD = (() => {
    const h = createHash('sha1');
    const walk = (dir) => { let names = []; try { names = readdirSync(dir).sort(); } catch { return; } for (const n of names) { const f = join(dir, n); let st; try { st = statSync(f); } catch { continue; } if (st.isDirectory()) walk(f); else { h.update(f.slice(config.webDir.length)); try { h.update(readFileSync(f)); } catch { /* gone */ } } } };
    walk(config.webDir);
    return h.digest('hex').slice(0, 8);
  })();
  const onDisk = config.dataDir !== ':memory:';
  // Exercises people made, found by their ids wherever a library exercise is (routines, the logger).
  setCustomSource((id) => cexAsLib(cexGet(app, id)));
  const cexPhotos = new CexPhotos({ dir: onDisk ? join(config.dataDir, 'cex-img') : null });
  /** Exercises made before they were shared (kept in the person's own store): moved to everyone's, once. */
  const migrateMine = (w, uid) => {
    const old = w.db.meta('myExercises', null);
    if (!Array.isArray(old)) return;
    for (const o of old) { try { if (o?.name) cexCreate(app, uid, { name: o.name, muscle: o.muscle, equipment: o.equipment, type: o.type }, o.at || now()); } catch { /* skip a bad one */ } }
    w.db.setMeta('myExercises', null);
  };
  const exImages = new ExerciseImages({ dir: onDisk ? join(config.dataDir, 'exercise-img') : null, fetchImpl: libraryFetch || globalThis.fetch });
  // AI summaries and questions (ai.js): the free models through the box's OpenCode server.
  const writer = new Writer({ ...(config.opencode || {}), ...(opencodeFetch ? { fetchImpl: opencodeFetch } : {}), log });
  const aiJobs = new AiJobs({ writer, log, now });
  const tiles = new TileCache({ dir: onDisk ? join(config.dataDir, 'tiles') : null, fetchImpl: tileFetch || globalThis.fetch });
  // Photos and videos on posts, and profile photos (media.js): files under data/media/.
  const media = new MediaStore({ app, dir: onDisk ? join(config.dataDir, 'media') : null, now, log });
  const loose = config.demo ? 20 : 1;   // the demo is hammered by tests and people trying things

  /* ── open tabs (SSE) ────────────────────────────────────────────── */

  const streams = new Map();   // userId -> Set<res>
  const sse = (userId, event, data) => {
    for (const res of streams.get(String(userId)) || []) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } }
  };
  const changed = (userId, what) => sse(userId, 'changed', { what, at: now() });

  /* Live heart rate: in memory, one person's readings to that person's own tabs. */
  const live = new Live({ now, emit: (userId, data) => sse(userId, 'live', data) });
  /** POST /api/live/hr, for either kind of caller. */
  async function liveHr(req, res, userId, fallbackSource) {
    limiter.check(`live:${userId}`, 10, 1000);
    limiter.add(`live:${userId}`, 1000);
    const body = await readJson(req, 16 * 1024);
    const source = cleanSource(body.source, fallbackSource);
    const samples = parseSamples(body, now());
    const relay = /^relay/.test(source);
    // A relay that should step aside does not have its readings shown over the one that took over.
    const v = relay ? live.verdict(userId, source) : { yield: false };
    if (!v.yield) live.push(userId, samples, source);
    if (samples.length) live.noteSource(userId, source, { relay });
    return send(res, 200, { ok: true, ...(relay ? { yield: v.yield, why: v.why } : {}) });
  }

  const notifier = new Notifier({ app, sse, send: pushSend, subject: config.vapidSubject, now, log });

  /* ── worlds ─────────────────────────────────────────────────────── */

  const notifyUser = (userId, note) => {
    const w = worlds.get(userId);
    const p = app.profile(userId);
    return notifier.notify(userId, note, { prefs: w.alerts.prefs(), tz: p?.tz || w.tz }).catch((e) => { log(`notify: ${e.message}`); });
  };
  const worlds = new Worlds({
    dataDir: config.dataDir,
    max: config.maxWorlds,
    make: (userId, dir) => new UserWorld({
      userId, dir, now, log, memory: config.dataDir === ':memory:',
      tz: app.profile(userId)?.tz || config.defaultTz,
      weekStart: app.profile(userId)?.weekStart ?? 1,
      google: {
        clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: config.google.redirectUri,
        endpoints: googleEndpoints, gapMs: config.googleGapMs ?? 150,
        ...(googleFetch ? { fetchFor: (acct) => googleFetch(userId, acct) } : {}),
      },
      onChange: (what) => { changed(userId, what); publish(userId).catch(() => {}); },
      notify: (type, title, body, extra = {}) => { notifyUser(userId, { type, title, body, ...extra }); },
    }),
  });

  /* ── after anything changed for a person ────────────────────────── */

  /** Rewrite this person's public rows; tell whoever needs telling. */
  async function publish(userId, { announce = true } = {}) {
    const profile = app.profile(userId);
    if (!profile) return;
    const w = worlds.get(userId);
    const r = social.recompute(app, { profile, db: w.db, settings: w.settings(), now: now() });
    if (!announce) return;
    for (const rec of r.records) {
      const key = `record:${rec.kind}`;
      if (w.alerts.said(key) === rec.date) continue;
      w.alerts.remember(key, rec.date);
      const val = rec.unit === 'steps' ? `${Math.round(rec.value).toLocaleString('en-US')} steps` : rec.unit === 'min' ? `${Math.round(rec.value)} minutes` : `${Math.round(rec.value)} workouts`;
      notifyUser(userId, { type: 'record', title: 'New personal record', body: `${rec.label}: ${val}.`, tag: key, url: `/u/${profile.username}` });
    }
    for (const other of r.passed) {
      notifyUser(other.userId, { type: 'leaderboard', title: 'You were passed', body: `${profile.displayName} passed you on this week's steps.`, tag: 'leaderboard', url: '/ranks' });
    }
  }

  /**
   * The sitting nudge's window, copied to the profile: null unless the
   * person switched it on and their device can carry it. The scheduler
   * reads this instead of opening everybody's own database.
   */
  function syncNudge(userId, w = worlds.get(userId)) {
    const pr = w.alerts.prefs();
    const on = pr.types.sitting && w.notifyAvailability().sitting.available;
    const next = on ? { sitting: pr.sitting, quiet: pr.quiet } : null;
    if (JSON.stringify(app.profile(userId)?.nudge ?? null) !== JSON.stringify(next)) app.patchProfile(userId, { nudge: next });
  }
  /** Is it worth reading this person's step windows now: inside their
      hours and days, outside quiet hours, and somewhere to send a nudge. */
  const nudgeDue = (p) => !!p.nudge && p.googleState === 'ok'
    && sittingActive({ types: { sitting: true }, sitting: p.nudge.sitting, quiet: p.nudge.quiet }, now(), p.tz || config.defaultTz).active
    && (notifier.count(p.userId) > 0 || streams.get(p.userId)?.size > 0);

  /** What follows every sync: capabilities, public rows, notifications. */
  async function afterSync(userId, result = null) {
    const w = worlds.get(userId);
    const profile = app.profile(userId);
    if (!profile) return;
    // The app's own numbers (cardio minutes, sleep score) for the days this
    // sync touched; the whole history once, for a database from before them.
    try { storeDerived(w); } catch (e) { log(`derived: ${e.message}`); }
    computeCaps(w.db, { now: now(), tz: profile.tz, googleOn: w.anyConnected() });
    const gLast = w.garminOn() ? garminMeta(w.db).lastSync || null : null;
    app.patchProfile(userId, {
      googleState: googleStateOf(w),
      device: w.db.meta('device')?.name || null,
      stepGoal: w.settings().stepTarget,
      lastSyncAt: Math.max(w.sync.state.lastOk || 0, gLast || 0) || null,
      syncError: result && !result.ok ? String(result.message || result.code || 'failed').slice(0, 200) : null,
    });
    syncNudge(userId, w);
    await publish(userId);
    await w.alerts.tick().catch((e) => log(`alerts: ${e.message}`));
    changed(userId, ['data', 'me', 'social']);
  }

  /** The profile's one word for Google: 'ok' while any included account
      is connected (so the scheduler keeps syncing it), else the main one's. */
  function googleStateOf(w) {
    if (w.anyConnected()) return 'ok';
    const st = w.google.status().state;
    return st === 'unconfigured' ? 'needs_auth' : st;
  }

  async function syncUser(userId, { force = false } = {}) {
    return worlds.hold(userId, async (w) => {
      sse(userId, 'sync', { running: true, at: now() });
      let result = { ok: true, code: null, extra: true };
      try {
        if (w.anyConnected()) {
          result = await w.sync.run({ force });
          // A night logged here that Google now holds too is shown once.
          try { settleLoggedSleep(w.db, { now: now() }); } catch (e) { log(`sleep settle: ${e.message}`); }
          await afterSync(userId, result);
        }
        // Hevy and Strava on the same clock, with Google or without it.
        const extra = await syncExtras(userId, w, { force });
        if (!w.anyConnected() && (extra.hevy || extra.strava || extra.xiaomi || extra.garmin)) await afterSync(userId, extra.garmin && !extra.garmin.skipped ? extra.garmin : null);
        // Garmin's numbers were folded in after Google's run: the rest follows them.
        else if (w.anyConnected() && extra.garmin?.wrote) await afterSync(userId, result);
        if (!w.anyConnected() && extra.garmin) result = { ...extra.garmin, extra: true };
        // Confirmed workouts still owed to Google go up on the same clock.
        if (result.ok && w.google.connected()) await w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
        // So do entries logged by hand that Google has not got yet.
        if (result.ok && w.google.connected()) await flushEntries(w).catch((e) => log(`entries flush: ${e.message}`));
      } finally {
        sse(userId, 'sync', { running: false, at: now() });
      }
      return result;
    });
  }

  /* ── Hevy, Strava, food: the other sources ──────────────────────── */

  const hevyKey = (userId) => vault.open(app.secretRow(userId, 'hevy'), `${userId}:hevy`);
  const hevyApiFor = (userId, key = hevyKey(userId)) => (key ? new HevyApi({ key, fetchImpl: hevyFetch || globalThis.fetch, base: config.hevy.base, gapMs: config.hevy.gapMs }) : null);
  const hevyPayload = (w, userId) => { const row = app.secretRow(userId, 'hevy'); return hevyView(w.db, { keySet: !!row, last4: row?.last4 || null }); };

  const stravaBudget = new StravaBudget();
  const stravaOn = () => !!(config.strava.clientId && config.strava.clientSecret && config.strava.redirectUri);
  const stravaTokens = (userId) => { const t = vault.open(app.secretRow(userId, 'strava'), `${userId}:strava`); try { return t ? JSON.parse(t) : null; } catch { return null; } };
  const keepStravaTokens = (userId, tokens) => app.setSecret(userId, 'strava', vault.seal(JSON.stringify(tokens), `${userId}:strava`), null);
  const stravaApiFor = (userId) => {
    const tokens = stravaOn() ? stravaTokens(userId) : null;
    if (!tokens) return null;
    return new StravaApi({ clientId: config.strava.clientId, clientSecret: config.strava.clientSecret, tokens, onTokens: (t) => keepStravaTokens(userId, t), budget: stravaBudget, fetchImpl: stravaFetch || globalThis.fetch, urls: stravaUrls || {} });
  };
  const stravaPayload = (w, userId) => stravaView(w.db, { configured: stravaOn(), connected: !!app.secretRow(userId, 'strava'), budget: stravaBudget.view() });
  /** Strava's athletes, to find a person from a webhook event. */
  const athletes = () => app.meta('stravaAthletes', {}) || {};
  const setAthlete = (athleteId, userId) => { const a = athletes(); if (userId) a[athleteId] = userId; else delete a[athleteId]; app.setMeta('stravaAthletes', a); };

  /* The Xiaomi scale: { userId, passToken } sealed; the session (service
     token and ssecurity) kept in memory only, renewed from the pass token. */
  const xiaomiCreds = (userId) => { const t = vault.open(app.secretRow(userId, 'xiaomi'), `${userId}:xiaomi`); try { return t ? JSON.parse(t) : null; } catch { return null; } };
  const xiaomiSessions = new Map();
  const xiaomiClientFor = (userId, w) => {
    const creds = xiaomiCreds(userId);
    if (!creds) return null;
    return new XiaomiClient({ creds, region: xiaomiMeta(w.db).region || null, session: xiaomiSessions.get(userId) || null, onSession: (x) => xiaomiSessions.set(userId, x), fetchImpl: xiaomiFetch || globalThis.fetch, now });
  };
  const qrJobs = new Map();   // userId -> the sign-in waiting to be scanned
  const qrView = (userId) => { const j = qrJobs.get(userId); return j ? { state: j.state, qr: j.state === 'waiting' ? j.qr : null, loginUrl: j.state === 'waiting' ? j.loginUrl : null, expiresAt: j.expiresAt, message: j.message || null } : null; };
  const xiaomiPayload = (w, userId) => xiaomiView(w.db, { connected: !!app.secretRow(userId, 'xiaomi'), pending: qrView(userId) });

  /* Garmin (garmin.js): the person's key sealed in the vault; the day-long
     token Garmin swaps it for kept in memory only, never on disk. Neither
     is ever logged or sent back: only the key's last four characters. */
  const garminKey = (userId) => vault.open(app.secretRow(userId, 'garmin'), `${userId}:garmin`);
  const garminTokens = new Map();
  // Unexpected answers are noted by their keys only, and only when asked for.
  const garminDebug = (m) => { if (process.env.GARMIN_DEBUG) log(m); };
  const garminApiFor = (userId, key = garminKey(userId)) => (key ? new GarminApi({
    key, token: garminTokens.get(userId) || null, onToken: (t) => garminTokens.set(userId, t),
    fetchImpl: garminFetch || globalThis.fetch, base: config.garmin.base, gapMs: garminGapMs ?? config.garmin.gapMs, now, log: garminDebug,
  }) : null);
  const garminOn = (w, userId) => w.garminOn() && !!app.secretRow(userId, 'garmin');
  const garminPayload = (w, userId) => {
    const row = app.secretRow(userId, 'garmin');
    return garminView(w.db, w.garminIn() ? w.garminDb() : null, { connected: !!row && w.garminOn(), last4: row?.last4 || null, now: now(), tz: w.tz });
  };
  /** A Garmin failure as a sentence for the person, with the right status. */
  const garminErr = (e) => {
    if (!(e instanceof GarminError)) return e;
    if (e.code === 'garmin_key') return err(e.message, 400, 'bad_key');
    if (e.code === 'rate_limited') return err(e.message, 429, 'rate_limited');
    return err(`${e.message} Nothing was saved; try again in a little while.`, 502, 'upstream');
  };
  /**
   * Test a key and keep it: swapped for a token at once (so a key Garmin
   * refuses is said so now, not at the next sync), one read made with the
   * token, then sealed. `keyDays`: how long the person made it for, when
   * the key does not say itself.
   */
  async function connectGarmin(userId, w, key, { keyDays = null, backfill = null } = {}) {
    garminTokens.delete(userId);
    const api = garminApiFor(userId, key);
    await api.token(true);
    try { await api.profile(); } catch (e) { if (e.code !== 'unavailable') throw e; }
    app.setSecret(userId, 'garmin', vault.seal(key, `${userId}:garmin`), key.slice(-4));
    const m = garminMeta(w.db);
    const keyExp = jwtExp(key);
    setGarminMeta(w.db, {
      connected: true, kept: false, lost: null, lastError: null, retryAt: null, failures: 0,
      connectedAt: m.connectedAt && (m.connected || m.kept) ? m.connectedAt : now(),
      keyExpiresAt: keyExp || (KEY_DAYS.includes(keyDays) ? now() + keyDays * 86_400_000 : null), keyExpiresKnown: !!keyExp,
      tokenExpiresAt: api.tok?.expiresAt || null,
      ...(BACKFILL_CHOICES.includes(backfill) ? { settings: { ...m.settings, backfill } } : {}),
    });
    w.merge();
    return api;
  }
  /** Garmin's first read, after the key was saved. Resolves when it is in. */
  const garminFirst = (userId) => worlds.hold(userId, async (w) => {
    const r = await syncExtras(userId, w, { force: true, only: 'garmin' });
    if (r.garmin) await afterSync(userId, null);
    return r.garmin || null;
  }).catch((e) => { log(`garmin first sync: ${e.message}`); return null; });
  /** A scale's weigh-in (and its body fat) saved to Google, when allowed. */
  async function scaleToGoogle(w, { grams, pct, at, off }) {
    if (!w.google.connected() || !w.google.granted(SCOPES.weightWrite)) return false;
    const fail = (op) => { if (op?.error) throw Object.assign(new Error(op.error.message || 'Google Health refused it'), { status: op.error.code || 0 }); };
    const wt = await w.google.createWeight({ grams, at, offsetSec: off });
    fail(wt);
    let fat = null;
    if (Number.isFinite(pct)) { fat = await w.google.createPoint('body-fat', googleBody['body-fat']({ pct, at, offsetSec: off })); fail(fat); }
    return { weight: wt?.response?.name || null, fat: fat?.response?.name || null };
  }
  /** Take back from Google what the scale sent there that was not the person's. */
  async function scaleFromGoogle(w, list) {
    // What each Google account's sync already read of them, so a merge does not bring them back.
    for (const t of list?.times || []) {
      for (const a of w.accounts.values()) {
        if (a.db === w.db) continue;
        if (a.db.weights(t).some((x) => x.t === t && x.source === 'google')) a.db.deleteWeight(t);
        for (const x of a.db.samples('bodyfat', { fromMs: t, toMs: t + 1, limit: 5 })) if (x.source === 'google') a.db.sampleDrop(x.id);
      }
    }
    if (!list?.length || !w.google.connected()) return 0;
    let n = 0;
    for (const type of ['weight', 'body-fat']) {
      const names = list.filter((x) => x.type === type).map((x) => x.name);
      if (!names.length) continue;
      try { await w.google.deletePoints(type, names); n += names.length; } catch (e) { log(`scale google cleanup: ${e.message}`); }
    }
    return n;
  }
  /** Wait for the code to be scanned, then keep what Xiaomi gave. */
  async function runQr(userId, job) {
    const f = xiaomiFetch || globalThis.fetch;
    const until = Date.now() + Math.max(0, job.expiresAt - now());
    try {
      while (!job.cancelled && Date.now() < until) {
        const got = await qrPoll({ pollUrl: job.pollUrl, fetchImpl: f, waitMs: Math.max(1000, Math.min(30_000, until - Date.now())) });
        if (job.cancelled) break;
        if (got) {
          app.setSecret(userId, 'xiaomi', vault.seal(JSON.stringify(got), `${userId}:xiaomi`), got.userId.slice(-3));
          xiaomiSessions.delete(userId);
          job.state = 'linked';
          await worlds.hold(userId, async (w) => {
            const m = xiaomiMeta(w.db);
            const account = `…${got.userId.slice(-3)}`;
            const same = m.accountId && m.accountId === got.userId;
            setXiaomiMeta(w.db, { accountId: got.userId, account, connectedAt: same ? m.connectedAt : now(), lost: null, lastError: null, ...(same ? {} : { profile: null, profiles: {}, cursor: null, region: null }) });
          });
          scheduler.poke(userId);
          changed(userId, ['me']);
          worlds.hold(userId, (w) => syncExtras(userId, w, { force: true, only: 'xiaomi' })).catch((e) => log(`xiaomi first sync: ${e.message}`));
          return;
        }
        await sleepFor(xiaomiGapMs);
      }
      if (job.state === 'waiting') job.state = job.cancelled ? 'cancelled' : 'expired';
    } catch (e) {
      job.state = e.code === 'expired' ? 'expired' : 'error';
      job.message = e.code === 'expired' ? null : e.message;
    }
    changed(userId, ['me']);
  }

  const food = new FoodLookup({ fetchImpl: foodFetch || globalThis.fetch, now, ...(foodUrls ? { urls: foodUrls } : {}) });

  /** A weigh-in from Hevy, saved to Google when that is allowed. */
  async function weightToGoogle(w, { grams, at, off }) {
    if (!w.google.connected() || !w.google.granted(SCOPES.weightWrite)) return false;
    await w.google.createWeight({ grams, at, offsetSec: off });
    return true;
  }

  const extraBusy = new Map();   // userId -> the pass running now
  /** One pass of Hevy and Strava for a person. Never throws. A pass asked
      for while one runs waits for it, then runs its own. */
  async function syncExtras(userId, w, opts = {}) {
    while (extraBusy.has(userId)) await extraBusy.get(userId).catch(() => {});
    const run = extrasOnce(userId, w, opts);
    extraBusy.set(userId, run);
    try { return await run; } finally { if (extraBusy.get(userId) === run) extraBusy.delete(userId); }
  }
  async function extrasOnce(userId, w, { force = false, only = null } = {}) {
    const out = {};
    try {
      const hevy = hevyMeta(w.db).connected ? hevyApiFor(userId) : null;
      if (hevy && (!only || only === 'hevy')) {
        out.hevy = await syncHevy({ db: w.db, api: hevy, tz: w.tz, now, force, log, remove: (id) => w.workouts.remove(id), saveWeight: (x) => weightToGoogle(w, x) });
        if (!out.hevy.ok) log(`hevy ${userId.slice(-6)}: ${out.hevy.code} ${out.hevy.message}`);
      }
      const strava = stravaApiFor(userId);
      if (strava && (!only || only === 'strava' || typeof only === 'object')) {
        out.strava = await syncStrava({ db: w.db, api: strava, tz: w.tz, now, force, log, remove: (id) => w.workouts.remove(id), only: typeof only === 'object' ? only : null });
        if (!out.strava.ok) log(`strava ${userId.slice(-6)}: ${out.strava.code} ${out.strava.message}`);
        if (out.strava.code === 'strava_auth') { app.deleteSecret(userId, 'strava'); setStravaMeta(w.db, { lost: now() }); }
      }
      const scale = xiaomiClientFor(userId, w);
      if (scale && (!only || only === 'xiaomi')) {
        out.xiaomi = await syncXiaomi({ db: w.db, client: scale, tz: w.tz, now, log, toGoogle: (x) => scaleToGoogle(w, x) });
        if (!out.xiaomi.ok) log(`xiaomi ${userId.slice(-6)}: ${out.xiaomi.code} ${out.xiaomi.message}`);
        if (out.xiaomi.dropped?.length) await scaleFromGoogle(w, out.xiaomi.dropped);
        if (out.xiaomi.code === 'auth') { app.deleteSecret(userId, 'xiaomi'); xiaomiSessions.delete(userId); setXiaomiMeta(w.db, { lost: now() }); }
      }
      if (w.garminOn() && (!only || only === 'garmin')) {
        const api = garminApiFor(userId);
        if (!api) {
          // The key is gone or the vault cannot open it (APP_SECRET changed).
          setGarminMeta(w.db, { connected: false, kept: true, lost: { at: now(), message: 'The saved key could not be read here. Paste it again.' } });
        } else {
          out.garmin = await syncGarmin({ main: w.db, src: w.garminDb(), api, tz: w.tz, now, force, log: garminDebug });
          if (!out.garmin.ok && !out.garmin.skipped) log(`garmin ${userId.slice(-6)}: ${out.garmin.code}`);
          if (out.garmin.code === 'garmin_key') {
            // Expired or deleted at Garmin: the key is no use, what it brought stays.
            app.deleteSecret(userId, 'garmin'); garminTokens.delete(userId);
            setGarminMeta(w.db, { connected: false, kept: true, lost: { at: now(), message: out.garmin.message } });
          }
          if (out.garmin.wrote) { try { w.merge(); } catch (e) { log(`garmin merge: ${e.message}`); } }
        }
      }
      const moved = (x) => x && (x.added || x.merged || x.updated || x.deleted || x.measuresIn || x.pushed);
      if (moved(out.xiaomi)) { changed(userId, ['data', 'me']); publish(userId, { announce: false }).catch(() => {}); }
      if (moved(out.hevy) || moved(out.strava)) {
        changed(userId, ['workouts', 'data', 'me']);
        publish(userId, { announce: false }).catch(() => {});
        if (w.google.connected()) w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
      } else if (out.hevy || out.strava || out.xiaomi || out.garmin) changed(userId, ['me']);
    } catch (e) { log(`extras ${userId.slice(-6)}: ${e.message}`); }
    return out;
  }

  /** Strava's webhook needs one subscription for the whole app. Made when
      it is missing; Strava calls GET /api/strava/webhook to check it. */
  async function ensureStravaWebhook({ force = false } = {}) {
    if (!stravaOn() || !config.strava.verifyToken || !config.strava.webhookUrl) return { ok: false, reason: 'not configured' };
    const f = stravaFetch || globalThis.fetch;
    const base = stravaUrls?.api || STRAVA_API;
    const q = new URLSearchParams({ client_id: config.strava.clientId, client_secret: config.strava.clientSecret });
    try {
      const list = await (await f(`${base}/push_subscriptions?${q}`)).json().catch(() => []);
      const mine = Array.isArray(list) ? list.find((x) => x.callback_url === config.strava.webhookUrl) : null;
      if (mine && !force) { app.setMeta('stravaWebhook', { id: mine.id, at: now() }); return { ok: true, id: mine.id, existed: true }; }
      const body = new URLSearchParams({ client_id: config.strava.clientId, client_secret: config.strava.clientSecret, callback_url: config.strava.webhookUrl, verify_token: config.strava.verifyToken });
      const res = await f(`${base}/push_subscriptions`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: `Strava answered ${res.status}: ${JSON.stringify(j.errors || j.message || j).slice(0, 200)}` };
      app.setMeta('stravaWebhook', { id: j.id, at: now() });
      return { ok: true, id: j.id };
    } catch (e) { return { ok: false, reason: e.message }; }
  }

  const scheduler = new Scheduler({
    now, log,
    intervalMs: config.syncMinutes * 60_000, idleMs: config.idleSyncHours * 3_600_000, idleAfterMs: config.idleAfterDays * 86_400_000, maxInFlight: config.maxInFlight,
    people: () => app.profiles().map((p) => {
      const x = p.nudge ? { ...p, steps: nudgeDue(p) } : { ...p };
      x.extra = !!(app.secretRow(p.userId, 'hevy') || app.secretRow(p.userId, 'strava') || app.secretRow(p.userId, 'xiaomi') || app.secretRow(p.userId, 'garmin'));
      return x;
    }),
    sync: syncUser,
    // The sitting nudge: the last two hours of steps, then judge them.
    steps: (userId) => worlds.hold(userId, async (w) => {
      if (!w.anyConnected()) return { ok: false, code: 'needs_auth' };
      try {
        await w.alerts.readSteps();
      } catch (e) {
        return { ok: false, code: e.code || 'error', message: e.message, nextInMs: e.retryAfter ? e.retryAfter * 1000 : 0 };
      }
      await w.alerts.tick();
      return { ok: true };
    }),
    minute: (userId, { detect }) => worlds.hold(userId, async (w) => {
      if (w.anyConnected()) {
        // Detection only for people who asked for it and whose device can
        // carry it; an open workout is followed to its end either way.
        const can = detect && readCaps(w.db).caps.heartRateMinute;
        if (can || w.workouts.open().length) await w.workouts.tick();
      }
      // Time-of-day notifications are only worth working out for somebody
      // who can receive them.
      if (notifier.count(userId) > 0 || streams.get(userId)?.size) await w.alerts.tick();
    }),
  });

  /* ── who is asking ──────────────────────────────────────────────── */

  const sessions = new Map();   // token -> { user, at }: spares Mongo a read per request
  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  };
  async function userOf(req) {
    const token = cookieOf(req);
    if (!token) return null;
    const hit = sessions.get(token);
    if (hit && now() - hit.at < 15_000) return { ...hit.user, token };
    const user = await accounts.sessionUser(token);
    if (!user || !validUserId(user.id)) { sessions.delete(token); return null; }
    sessions.set(token, { user, at: now() });
    if (sessions.size > 2000) for (const [k, v] of sessions) if (now() - v.at > 60_000) sessions.delete(k);
    return { ...user, token };
  }
  const isAdmin = (user) => !!user && config.admins.includes(String(user.username).toLowerCase());

  /** The person's health profile, made on their first visit here. Null when
      registration is closed and they have none (admins are let in). */
  function ensureProfile(user, tz) {
    let p = app.profile(user.id);
    if (p) {
      if (p.username !== user.username) p = app.patchProfile(user.id, { username: user.username });
      return p;
    }
    if (!app.registrationOpen() && !isAdmin(user)) return null;
    return app.createProfile({ userId: user.id, username: user.username, tz: validTz(tz) ? tz : config.defaultTz, now: now() });
  }

  const ipOf = (req) => {
    if (config.trustProxy) {
      const cf = req.headers['cf-connecting-ip'];
      if (cf) return String(cf);
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket?.remoteAddress || 'unknown';
  };

  /* ── replies ────────────────────────────────────────────────────── */

  const baseHeaders = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
  };
  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string' && !Buffer.isBuffer(body);
    const out = json ? JSON.stringify(body) : body;
    res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...baseHeaders, ...headers });
    res.end(out);
  };
  const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...baseHeaders, ...headers }); res.end(); };

  const readRaw = (req, max) => new Promise((resolve, reject) => {
    let n = 0; const chunks = []; let over = false;
    req.on('data', (c) => {
      n += c.length;
      // Keep reading (and dropping) so the 413 can be delivered, but never
      // hold more than the cap.
      if (n > max) { over = true; chunks.length = 0; } else if (!over) chunks.push(c);
    });
    req.on('end', () => (over ? reject(err('That is too large.', 413, 'too_large', { maxBytes: max })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
  const readJson = async (req, max = 64 * 1024) => {
    const buf = await readRaw(req, max);
    if (!buf.length) return {};
    try { const j = JSON.parse(buf.toString('utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { throw err('The request body is not JSON.'); }
  };

  /* ── static files ───────────────────────────────────────────────── */

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ''); } catch { return send(res, 400, { error: 'Bad path', code: 'bad_request' }); }
    if (rel.split(/[/\\]/).includes('..') || rel.includes('\0')) return send(res, 404, { error: 'Not found', code: 'not_found' });
    // /v/<build>/js/... and /v/<build>/css/...: the same files under an
    // address that changes with every deploy (the shell points at them), so
    // no cache anywhere (a phone's, Cloudflare's 4-hour one) can hand a new
    // page old code. An old build's address still answers, with today's file.
    const versioned = /^v\/([0-9a-f]{8})\/((?:js|css)\/.+)$/.exec(rel.replace(/\\/g, '/'));
    if (versioned) rel = versioned[2];
    const current = versioned?.[1] === BUILD;
    // The two plain documents have clean addresses (Google's consent screen links them).
    if (rel === 'privacy' || rel === 'terms') rel += '.html';
    const ext = extname(rel).toLowerCase();
    // A client route (/u/mira, /workouts/12): the app shell. A missing file
    // WITH an extension is a real 404, so a typo in a script path never
    // comes back as HTML.
    const shell = !ext;
    const file = join(config.webDir, shell ? 'index.html' : rel);
    if (!file.startsWith(config.webDir + sep) && file !== join(config.webDir, 'index.html')) return send(res, 404, { error: 'Not found', code: 'not_found' });
    let body; let st;
    try { st = await stat(file); if (!st.isFile()) throw new Error('not a file'); body = await readFile(file); } catch {
      if (shell) return send(res, 503, 'The app has not been built into web/ yet.', {});
      return send(res, 404, { error: 'Not found', code: 'not_found' });
    }
    const type = MIME[shell ? '.html' : ext] || 'application/octet-stream';
    const isShell = shell || rel === 'index.html';
    if (isShell) body = Buffer.from(body.toString('utf8').replace(/(href|src)="\/(js|css)\//g, `$1="/v/${BUILD}/$2/`));
    const isSw = rel === 'sw.js';
    const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
    const headers = {
      ...baseHeaders, 'content-type': type,
      // The shell and the service worker are never cached: they are how an
      // update reaches a phone. Everything else revalidates (a cheap 304).
      'cache-control': isShell || isSw ? 'no-store' : current && !config.demo ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(isShell || isSw ? {} : { etag }),
      ...(isSw ? { 'service-worker-allowed': '/' } : {}),
    };
    if (!isShell && !isSw && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  /* ── photos and videos ─────────────────────────────────────────── */

  /**
   * GET /media/:id and /media/:id/thumb: a photo, a video or a preview,
   * to whoever may see what it belongs to. A post's: its author, or a
   * friend who sees the post (feed.js, the same rule as the post). A
   * profile photo: you, or anyone signed in while the profile is public.
   * Everything else (signed out, not allowed, unfinished, no such id) is
   * the same 404. Ranges are answered (Safari plays a video only through
   * 206 replies). The file is named by the id, never by anything sent.
   */
  async function serveMedia(req, res, user, id, thumb) {
    const r = media.row(id);
    const allowed = () => {
      if (!user || !r || r.state !== 'ready') return false;
      if (r.user_id === user.id) return true;
      if (r.kind === 'avatar') { const p = app.profile(r.user_id); return !!p && p.avatar === r.id && p.privacy.account === 'public'; }
      return !!r.post_id && feed.canSeePost(app, user.id, r.post_id);
    };
    if (!allowed() || !media.has(r, thumb)) throw err('Not found', 404);
    const file = thumb ? media.thumbFile(r) : media.file(r);
    const size = (await stat(file)).size;
    const etag = `"${r.id}${thumb ? '-t' : ''}"`;
    const headers = {
      ...baseHeaders, 'content-type': thumb ? r.thumb : r.mime, 'x-content-type-options': 'nosniff',
      // The id never changes what it points to: a new photo is a new id.
      'cache-control': 'private, max-age=31536000, immutable', etag, 'accept-ranges': 'bytes',
      'content-disposition': 'inline', 'cross-origin-resource-policy': 'same-origin',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    let start = 0; let end = size - 1; let status = 200;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (rg && (rg[1] !== '' || rg[2] !== '')) {
      if (rg[1] === '') start = Math.max(0, size - Number(rg[2]));
      else { start = Number(rg[1]); end = rg[2] === '' ? size - 1 : Math.min(Number(rg[2]), size - 1); }
      if (start > end || start >= size) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); return res.end(); }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    res.writeHead(status, { ...headers, 'content-length': end - start + 1 });
    if (req.method === 'HEAD' || size === 0) return res.end();
    return new Promise((resolve) => {
      const rs = createReadStream(file, { start, end });
      rs.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { rs.destroy(); resolve(); });
      rs.pipe(res);
    });
  }

  /* ── payloads that need more than one part ──────────────────────── */

  function mePayload(user, profile) {
    const base = { user: user ? { id: user.id, username: user.username, admin: isAdmin(user) } : null, demo: config.demo, version: VERSION, build: BUILD, registrationOpen: app.registrationOpen(), push: { publicKey: notifier.publicKey } };
    if (!user) return base;
    if (!profile) return { ...base, profile: null };
    const w = worlds.get(user.id);
    const c = readCaps(w.db);
    return {
      ...base,
      profile: { username: profile.username, displayName: profile.displayName, bio: profile.bio, accent: profile.accent, avatar: friends.avatarUrl(profile), avatarId: profile.avatar || null, tz: profile.tz, weekStart: profile.weekStart ?? 1, city: profile.city, country: profile.country, joinedAt: profile.joinedAt, onboarding: profile.onboarding, notes: w.db.meta('notes', '') },
      units: profile.units,
      unitSystem: unitSystem(profile.units),
      goals: views.goalsView(w),
      privacy: profile.privacy,
      // Which optional groups a summary may read, and the metrics pinned to Today.
      aiShare: w.aiShare(),
      pins: w.pins(),
      google: views.googleView(w),
      googleAccounts: w.accountsView(),
      merge: w.mergeRules(),
      sync: views.syncView(w, scheduler),
      caps: c.caps,
      capsMeta: c.meta,
      device: w.db.meta('device'),
      push: { publicKey: notifier.publicKey, devices: notifier.count(user.id) },
      link: link.linkState(app, user.id, now()),
      workout: views.workoutBadge(w),
      hevy: { connected: hevyMeta(w.db).connected && !!app.secretRow(user.id, 'hevy') },
      strava: { configured: stravaOn(), connected: !!app.secretRow(user.id, 'strava') },
      xiaomi: { connected: !!app.secretRow(user.id, 'xiaomi') },
      // Sex and year of birth for a scale's body ranges: the person's own, with what the scale said. Private: only ever here.
      body: (() => { const b = bodyPerson(w); return { sex: b.own.sex, birthYear: b.own.birthYear, scale: b.scale ? { sex: b.scale.sex || null, birthYear: b.scale.birthYear || null } : null }; })(),
      garmin: (() => { const g = garminMeta(w.db); return { connected: garminOn(w, user.id), kept: !garminOn(w, user.id) && !!g.kept, lost: !garminOn(w, user.id) && !!g.lost, lastSync: g.lastSync || null, keyExpiresAt: garminOn(w, user.id) ? g.keyExpiresAt || null : null, lastError: garminOn(w, user.id) ? g.lastError || null : null }; })(),
      // Where this person's numbers come from: a Google account, Garmin, or both.
      sources: { google: w.anyConnected(), garmin: garminOn(w, user.id), any: w.anyConnected() || garminOn(w, user.id) },
      // Friend requests waiting for an answer, for a badge.
      social: { requests: friends.requestCount(app, user.id) },
    };
  }
  const pushPayload = (userId) => {
    const w = worlds.get(userId);
    const avail = w.notifyAvailability();
    return {
      publicKey: notifier.publicKey,
      types: TYPES.map((t) => ({ ...t, available: avail[t.id].available, reason: avail[t.id].reason })),
      prefs: w.alerts.prefs(),
      limits: { sitting: SITTING_LIMITS },
      status: { sitting: w.alerts.view() },
      devices: notifier.devices(userId),
    };
  };
  /** The accounts, how they are put together, and what each rule means. */
  const accountsPayload = (w) => ({ accounts: w.accountsView(), rules: w.mergeRules(), primary: w.primaryId });
  /** After accounts or their rules changed: every number made from them again. */
  async function afterAccounts(userId, w) {
    try { storeDerived(w, { full: true }); } catch (e) { log(`derived: ${e.message}`); }
    app.patchProfile(userId, { googleState: googleStateOf(w) });
    if (!w.anyConnected()) scheduler.forget(userId);
    await afterSync(userId);
  }
  const linkPayload = (userId) => ({ keys: link.listKeys(app, userId), active: link.linkState(app, userId, now()).active, prompter: 'web', url: config.origin || null });

  function adminPayload() {
    return {
      registrationOpen: app.registrationOpen(),
      // Connection state only. Nothing here is health data.
      people: app.profiles().map((p) => ({
        id: p.userId, username: p.username, displayName: p.displayName, accent: p.accent, avatar: friends.avatarUrl(p), joinedAt: p.joinedAt, lastSeenAt: p.lastSeenAt || null,
        private: p.privacy.account !== 'public', google: p.googleState, lastSyncAt: p.lastSyncAt || null, syncError: p.syncError || null,
        nextSyncAt: scheduler.dueAt(p.userId), pushDevices: notifier.count(p.userId), linkKeys: link.listKeys(app, p.userId).length,
        detection: p.detect,
      })),
      server: {
        version: VERSION, node: process.version, startedAt, uptimeS: Math.round((now() - startedAt) / 1000), demo: config.demo,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576), worlds: { open: worlds.open(), max: worlds.max },
        scheduler: { inFlight: scheduler.inFlight.size, maxInFlight: scheduler.maxInFlight, ...scheduler.stats },
        google: { configured: !!(config.google.clientId && config.google.clientSecret && config.google.redirectUri), redirectUri: config.google.redirectUri || null },
        push: { configured: true }, mongo: { ok: true },
        strava: { configured: stravaOn(), webhook: config.strava.verifyToken ? app.meta('stravaWebhook', null) : null, athletes: Object.keys(athletes()).length, usage: stravaBudget.view() },
      },
    };
  }

  /* ── small validators ───────────────────────────────────────────── */

  function cleanExercises(list) {
    if (!Array.isArray(list)) throw err('exercises must be a list.');
    if (list.length > 60) throw err('At most 60 exercises in one workout.');
    let total = 0;
    return list.map((e, i) => {
      const name = String(e?.name || '').trim().slice(0, 80);
      if (!name) throw err(`Exercise ${i + 1} needs a name.`);
      const sets = Array.isArray(e.sets) ? e.sets : [];
      total += sets.length;
      if (total > 400) throw err('At most 400 sets in one workout.');
      return {
        name, muscle: MUSCLES.includes(e.muscle) ? e.muscle : muscleOf(name), notes: e.notes ? String(e.notes).slice(0, 500) : null, supersetId: e.supersetId ? String(e.supersetId).slice(0, 40) : null,
        // The Hevy exercise it is, when it was picked from the library.
        templateId: e.templateId && /^[A-Za-z0-9_-]{1,40}$/.test(String(e.templateId)) ? String(e.templateId) : null,
        // The library exercise it is (library.js), when it was picked from there.
        libId: e.libId && libById(e.libId) ? String(e.libId) : libByName(name)?.id || null,
        sets: sets.map((s, j) => {
          const numIn = (v, lo, hi, what) => {
            if (v === undefined || v === null || v === '') return null;
            const n = Number(v);
            if (!(n >= lo && n <= hi)) throw err(`${name}, set ${j + 1}: ${what} must be ${lo}-${hi}.`);
            return n;
          };
          return {
            index: j, type: ['normal', 'warmup', 'dropset', 'failure'].includes(s?.type) ? s.type : 'normal',
            kg: numIn(s?.kg, 0, 1000, 'kg'), reps: numIn(s?.reps, 0, 500, 'reps') === null ? null : Math.round(Number(s.reps)),
            distanceM: numIn(s?.distanceM, 0, 1_000_000, 'distance'), durationS: numIn(s?.durationS, 0, 86_400, 'duration'), rpe: numIn(s?.rpe, 0, 10, 'RPE'),
          };
        }),
      };
    });
  }

  /** Only the known switches, only true or false. */
  function cleanSwitches(b, defaults) {
    const out = {};
    for (const k of Object.keys(defaults)) {
      if (b?.[k] === undefined) continue;
      if (typeof b[k] !== 'boolean') throw err(`${k} must be true or false.`);
      out[k] = b[k];
    }
    return out;
  }

  /** A local workout row the person may edit, by its id in the URL. */
  /** A route kept as a workout: its numbers on the workout, its points apart. */
  function saveRouteIn(w, uid, { type, points, pauses, start, end, title, notes, source }) {
    const st = trackStats({ type, points, pauses, start, end });
    if (st.distanceM < 20 && st.movingS < 60) throw err('That route is too short to keep.');
    const label = ROUTE_TYPES[type].label;
    const r = w.workouts.logPast({ start, end: Math.max(end, start + 60_000), title: title ? String(title).slice(0, 80) : label, notes: notes || null, type, route: true });
    r.source = source;
    r.distanceM = st.distanceM; r.movingS = st.movingS; r.elevGainM = st.elevGainM;
    r.route = { type, distanceM: st.distanceM, movingS: st.movingS, paceSPerKm: st.paceSPerKm, avgSpeedKmh: st.avgSpeedKmh };
    r.updated = now();
    w.db.workoutPut(r);
    w.db.trackPut(r.id, { type, points, pauses, start, end });
    changed(uid, ['workouts', 'data']);
    publish(uid, { announce: false }).catch(() => {});
    w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
    return { id: String(r.id), stats: (({ series: _s, ...x }) => x)(st) };
  }

  function ownWorkout(w, id) {
    if (!/^\d{1,12}$/.test(String(id))) throw err(String(id).startsWith('g-') ? 'This workout lives in Google Health and cannot be changed here.' : 'No such workout.', String(id).startsWith('g-') ? 409 : 404);
    const r = w.workouts.get(id);
    if (r.status === 'deleted') throw err('No such workout.', 404);
    return r;
  }

  const throttles = new Map();
  const throttle = (key, ms, message) => {
    const last = throttles.get(key) || 0;
    if (now() - last < ms) throw err(message, 429, 'rate_limited', { retryAfter: Math.ceil((ms - (now() - last)) / 1000) });
    throttles.set(key, now());
  };

  /* ── Google sign-in attempts, bound to the session ──────────────── */

  const oauth = new Map();   // state -> { userId, sid, verifier, back, at }
  const sid = (token) => createHash('sha256').update(String(token)).digest('hex');
  const safeBack = (p) => (typeof p === 'string' && /^\/[A-Za-z0-9/_-]{0,100}$/.test(p) && !p.startsWith('//') ? p : '/settings/connections');
  const backWith = (back, q) => `${back}?${new URLSearchParams(q)}`;

  /* ── routes ─────────────────────────────────────────────────────── */

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const GET = m === 'GET'; const POST = m === 'POST';

    /* the console module, with its key: no cookie, no Origin */
    if (p === '/api/link/changes') {
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1] || null;
      const key = link.keyFor(app, bearer, now());
      if (!key) throw err('This link key is not valid. Make a new one in Settings, Connections.', 401, 'bad_key');
      const profile = app.profile(key.userId);
      if (!profile) throw err('This link key is not valid. Make a new one in Settings, Connections.', 401, 'bad_key');
      return worlds.hold(key.userId, async (w) => {
        const det = views.detectionView(w);
        const who = { serverTime: now(), prompter: 'web', detection: { enabled: det.settings.enabled, available: det.available, reason: det.reason } };
        if (GET) {
          const r = link.changesSince(w.db, url.searchParams.get('since'), key.id);
          return send(res, 200, { cursor: r.cursor, ...who, tz: profile.tz, workouts: r.workouts, sets: r.sets, more: r.more });
        }
        if (POST) {
          const body = await readJson(req, 2 * 1024 * 1024);
          if (body.module && typeof body.module.version === 'string') app.run('UPDATE link_key SET module_version = ? WHERE id = ?', body.module.version.slice(0, 20), key.id);
          const r = link.applyChanges(w.db, body, key.id);
          if (r.applied) { changed(key.userId, ['workouts']); publish(key.userId, { announce: false }).catch(() => {}); }
          return send(res, 200, { ok: true, ...who, ...r });
        }
        throw err('Use GET or POST.', 405, 'bad_request');
      });
    }

    /* live heart rate from another of the person's devices, with a link
       key: no cookie, no Origin. Without the header it is the signed-in
       person's own browser, further down. */
    if (POST && p === '/api/live/hr' && req.headers.authorization !== undefined) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1] || null;
      // A reading a second must not mean a database write a second.
      const key = link.keyFor(app, bearer, now(), { touchEveryMs: 60_000 });
      if (!key || !app.profile(key.userId)) throw err('This link key is not valid. Make a new one in Settings, Connections.', 401, 'bad_key');
      return liveHr(req, res, key.userId, 'pulse');
    }
    if (GET && p === '/api/live/relay' && req.headers.authorization !== undefined) {
      // A relay asks: may I take the sensor, and which sensors are this person's?
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1] || null;
      const key = link.keyFor(app, bearer, now(), { touchEveryMs: 60_000 });
      if (!key || !app.profile(key.userId)) throw err('This link key is not valid. Make a new one in Settings, Connections.', 401, 'bad_key');
      const src = cleanSource(url.searchParams.get('source'), 'relay');
      const v = live.verdict(key.userId, src);
      return send(res, 200, { busy: v.yield, why: v.why, names: app.meta(`liveSensors:${key.userId}`, []) || [] });
    }

    /* Strava's webhook: Strava itself calls it, with no cookie and no Origin.
       GET is its check of the address (it echoes the verify token's
       challenge); POST is an event, answered at once and handled after. */
    if (p === '/api/strava/webhook') {
      if (GET) {
        const q = url.searchParams;
        if (!config.strava.verifyToken || q.get('hub.mode') !== 'subscribe' || q.get('hub.verify_token') !== config.strava.verifyToken) throw err('Not found', 404);
        return send(res, 200, { 'hub.challenge': String(q.get('hub.challenge') || '').slice(0, 200) });
      }
      if (POST) {
        const ev = await readJson(req, 16 * 1024);
        send(res, 200, { ok: true });
        const userId = athletes()[String(ev.owner_id)];
        if (!userId || !app.profile(userId)) return undefined;
        setImmediate(() => {
          worlds.hold(userId, async (w) => {
            if (ev.object_type === 'athlete' && String(ev.updates?.authorized) === 'false') {
              // They took the site's access back on Strava.
              app.deleteSecret(userId, 'strava'); setAthlete(String(ev.owner_id), null);
              setStravaMeta(w.db, { lost: now() });
              changed(userId, ['me']);
              return;
            }
            if (ev.object_type !== 'activity' || !ev.object_id) return;
            await syncExtras(userId, w, { only: { id: String(ev.object_id), deleted: ev.aspect_type === 'delete' } });
          }).catch((e) => log(`strava webhook: ${e.message}`));
        });
        return undefined;
      }
      throw err('Use GET or POST.', 405, 'bad_request');
    }

    /* every other state-changing request must come from this site */
    if (!GET && m !== 'HEAD') {
      const origin = req.headers.origin;
      if (!origin || !config.origins.includes(String(origin).replace(/\/+$/, ''))) throw err('This request did not come from the site.', 403, 'bad_origin');
    }

    if (GET && p === '/api/health') return send(res, 200, { ok: true, version: VERSION, build: BUILD, demo: config.demo, uptimeS: Math.round((now() - startedAt) / 1000) });

    /* ── /auth ── */

    if (POST && p === '/auth/register') {
      const ip = ipOf(req);
      limiter.check(`reg:${ip}`, 5 * loose, 3_600_000);
      const b = await readJson(req);
      if (!app.registrationOpen()) throw err('Registration is closed', 403, 'closed');
      const r = await accounts.register(b);
      limiter.add(`reg:${ip}`, 3_600_000);
      ensureProfile(r.user, b.tz);
      return send(res, 200, { user: r.user }, { 'set-cookie': accounts.setCookie(r.token) });
    }
    if (POST && p === '/auth/login') {
      const ip = ipOf(req);
      const b = await readJson(req);
      const name = String(b.username || '').trim().toLowerCase().slice(0, 40);
      limiter.check(`login:${ip}`, 10 * loose, 600_000);
      limiter.check(`loginu:${name}`, 5 * loose, 600_000);
      let r;
      try { r = await accounts.login(b); } catch (e) {
        // Only failures count: somebody signing in on three devices is not an attack.
        if (e.status === 401) { limiter.add(`login:${ip}`, 600_000); limiter.add(`loginu:${name}`, 600_000); }
        throw e;
      }
      limiter.clear(`loginu:${name}`);
      ensureProfile(r.user, b.tz);
      return send(res, 200, { user: r.user }, { 'set-cookie': accounts.setCookie(r.token) });
    }
    if (POST && p === '/auth/logout') {
      const token = cookieOf(req);
      if (token) { sessions.delete(token); await accounts.logout(token); }
      return send(res, 200, { success: true }, { 'set-cookie': accounts.clearCookie() });
    }

    const user = await userOf(req);

    if (GET && p === '/auth/me') return send(res, 200, { user: user ? { id: user.id, username: user.username } : null });

    if (GET && p === '/auth/google/start') {
      const back = safeBack(url.searchParams.get('return'));
      if (!user) return redirect(res, '/');
      const profile = ensureProfile(user);
      if (!profile) return redirect(res, backWith(back, { google: 'error', message: 'Registration is closed' }));
      const w = worlds.get(user.id);
      if (!w.google.configured()) return redirect(res, backWith(back, { google: 'error', message: 'Google sign-in is not set up on this server yet' }));
      const { verifier, challenge, state } = pkce();
      for (const [k, v] of oauth) if (now() - v.at > 10 * 60_000) oauth.delete(k);
      // `groups=nutrition,cycle` asks for those optional groups too. The
      // ones already switched on are asked for again, so a reconnect after
      // a disconnect brings back exactly what the person chose.
      // `account=new` adds another Google account; `account=<id>` reconnects
      // that one; neither is the main account, as it always was. The
      // optional groups belong to the main account.
      const want = url.searchParams.get('account') || '';
      const account = want === 'new' ? 'new' : w.accounts.has(want) ? want : w.primaryId;
      const forMain = account === w.primaryId;
      const asked = forMain ? cleanGroups(url.searchParams.get('groups')) : [];
      const on = w.groups();
      const groups = forMain ? cleanGroups([...asked, ...Object.keys(on).filter((id) => on[id])]) : [];
      oauth.set(state, { userId: user.id, sid: sid(user.token), verifier, back, at: now(), groups: asked, account });
      const hint = account === 'new' ? null : w.accounts.get(account).google.status().email;
      // Route maps (groups=routes): the location scope, asked only when chosen, and again on a reconnect once allowed.
      const acctG = account === 'new' ? null : w.accounts.get(account).google;
      const routes = String(url.searchParams.get('groups') || '').split(',').includes('routes') || Boolean(acctG?.granted?.(LOCATION_SCOPE));
      return redirect(res, w.google.authUrl({ state, challenge, groups, routes, chooser: account === 'new', loginHint: hint }));
    }
    if (GET && p === '/auth/google/callback') {
      const state = url.searchParams.get('state') || '';
      const pend = oauth.get(state);
      oauth.delete(state);
      const back = pend?.back || '/settings/connections';
      // The attempt belongs to the session that started it: a link carried
      // to another browser, or replayed, connects nothing.
      if (!pend || !user || pend.userId !== user.id || pend.sid !== sid(user.token) || now() - pend.at > 10 * 60_000) {
        return redirect(res, backWith(back, { google: 'error', message: 'This sign-in link has expired. Start again.' }));
      }
      const denied = url.searchParams.get('error');
      if (denied) return redirect(res, backWith(back, denied === 'access_denied' ? { google: 'cancelled' } : { google: 'error', message: `Google said: ${denied.slice(0, 80)}` }));
      let done;
      try {
        done = await worlds.hold(user.id, async (w) => {
          const r = await w.connectAccount(pend.account, (g) => g.exchange({ code: url.searchParams.get('code') || '', verifier: pend.verifier }));
          // The groups this attempt asked for are now the person's choice.
          // Whether Google granted each one is read from the token, not assumed.
          if (pend.groups?.length && r.id === w.primaryId) w.setGroups(pend.groups);
          app.patchProfile(user.id, { googleState: 'ok', syncError: null });
          return r;
        });
      } catch (e) {
        return redirect(res, backWith(back, { google: 'error', message: String(e.message).slice(0, 200) }));
      }
      scheduler.poke(user.id);
      // The first sync starts now rather than at the scheduler's next look.
      syncUser(user.id, { force: true }).then((r) => scheduler.settle(app.profile(user.id) || { userId: user.id }, r)).catch((e) => log(`first sync: ${e.message}`));
      changed(user.id, ['me']);
      return redirect(res, backWith(back, { google: done.added ? 'added' : done.already ? 'already' : 'connected' }));
    }
    if (GET && p === '/auth/strava/start') {
      const back = safeBack(url.searchParams.get('return'));
      if (!user) return redirect(res, '/');
      if (!ensureProfile(user)) return redirect(res, backWith(back, { strava: 'error', message: 'Registration is closed' }));
      if (!stravaOn()) return redirect(res, backWith(back, { strava: 'error', message: 'Strava is not set up on this server yet' }));
      const state = createHash('sha256').update(`${user.id}:${now()}:${Math.random()}`).digest('hex').slice(0, 40);
      for (const [k, v] of oauth) if (now() - v.at > 10 * 60_000) oauth.delete(k);
      oauth.set(state, { kind: 'strava', userId: user.id, sid: sid(user.token), back, at: now() });
      const q = new URLSearchParams({ client_id: config.strava.clientId, redirect_uri: config.strava.redirectUri, response_type: 'code', approval_prompt: 'auto', scope: STRAVA_SCOPES, state });
      return redirect(res, `${stravaUrls?.auth || STRAVA_AUTH}?${q}`);
    }
    if (GET && p === '/auth/strava/callback') {
      const state = url.searchParams.get('state') || '';
      const pend = oauth.get(state);
      oauth.delete(state);
      const back = pend?.back || '/settings/connections';
      if (!pend || pend.kind !== 'strava' || !user || pend.userId !== user.id || pend.sid !== sid(user.token) || now() - pend.at > 10 * 60_000) {
        return redirect(res, backWith(back, { strava: 'error', message: 'This sign-in link has expired. Start again.' }));
      }
      const denied = url.searchParams.get('error');
      if (denied) return redirect(res, backWith(back, denied === 'access_denied' ? { strava: 'cancelled' } : { strava: 'error', message: `Strava said: ${denied.slice(0, 80)}` }));
      const scope = String(url.searchParams.get('scope') || '');
      if (!scope.includes('activity:read')) return redirect(res, backWith(back, { strava: 'error', message: 'Strava was connected without permission to read activities. Connect it again and leave that box ticked.' }));
      try {
        const r = await stravaExchange({ clientId: config.strava.clientId, clientSecret: config.strava.clientSecret, code: url.searchParams.get('code') || '', fetchImpl: stravaFetch || globalThis.fetch, ...(stravaUrls?.token ? { tokenUrl: stravaUrls.token } : {}) });
        keepStravaTokens(user.id, r.tokens);
        if (r.athlete?.id) setAthlete(r.athlete.id, user.id);
        await worlds.hold(user.id, async (w) => {
          const m = stravaMeta(w.db);
          setStravaMeta(w.db, { athlete: r.athlete, scope, connectedAt: m.connectedAt || now(), lost: null, lastError: null });
        });
      } catch (e) {
        return redirect(res, backWith(back, { strava: 'error', message: String(e.message).slice(0, 200) }));
      }
      ensureStravaWebhook().catch(() => {});
      scheduler.poke(user.id);
      worlds.hold(user.id, (w) => syncExtras(user.id, w, { force: true, only: 'strava' })).catch((e) => log(`strava first sync: ${e.message}`));
      changed(user.id, ['me']);
      return redirect(res, backWith(back, { strava: 'connected' }));
    }
    if (demoStrava && GET && p === '/demo/strava/consent') {
      // The stand-in for Strava's own page: approve and come back.
      const q = url.searchParams;
      return redirect(res, `${q.get('redirect_uri')}?${new URLSearchParams({ state: q.get('state') || '', code: demoStrava.approve(), scope: q.get('scope') || '' })}`);
    }
    if (demoConnect && GET && p === '/demo/google/consent') {
      // The stand-in for Google's consent screen: say yes and come back.
      return redirect(res, demoConnect(url));
    }

    /* ── public ── */

    if (GET && p === '/api/me') {
      if (!user) return send(res, 200, mePayload(null, null));
      const profile = ensureProfile(user, url.searchParams.get('tz'));
      if (profile && now() - (profile.lastSeenAt || 0) > 5 * 60_000) app.patchProfile(user.id, { lastSeenAt: now() });
      return send(res, 200, mePayload(user, profile));
    }
    let mm;
    if (GET && (mm = /^\/api\/users\/([^/]{1,40})$/.exec(p))) {
      const prof = social.publicProfile(app, { username: decodeURIComponent(mm[1]), viewerId: user?.id || null, now: now() });
      // Unknown and private look the same from outside.
      if (!prof) throw err('There is no such profile.', 404);
      // The routines and programmes they share (sharedlib.js), to look at and add to your own.
      const owner = app.profileByName(decodeURIComponent(mm[1]));
      const shared = owner ? browseShared(app, user?.id || null, { userId: owner.userId }) : [];
      return send(res, 200, { ...prof, programmes: shared });
    }
    if ((GET || m === 'HEAD') && (mm = /^\/media\/(m_[0-9a-f]{10})(\/thumb)?$/.exec(p))) return serveMedia(req, res, user, mm[1], !!mm[2]);

    if (!p.startsWith('/api/')) throw err('Not found', 404);

    /* ── everything below is for the signed-in person ── */

    if (!user) throw err('Not logged in', 401, 'not_logged_in');
    const profile = ensureProfile(user);
    if (!profile) throw err('Registration is closed', 403, 'closed');
    const uid = user.id;

    if (p.startsWith('/api/admin')) {
      if (!isAdmin(user)) throw err('Admins only.', 403, 'forbidden');
      if (GET && p === '/api/admin') return send(res, 200, adminPayload());
      if (POST && p === '/api/admin/strava/webhook') return send(res, 200, await ensureStravaWebhook({ force: true }));
      if (POST && p === '/api/admin/registration') {
        const b = await readJson(req);
        if (typeof b.open !== 'boolean') throw err('open must be true or false.');
        app.setMeta('registrationOpen', b.open);
        return send(res, 200, adminPayload());
      }
      throw err('Not found', 404);
    }

    if (GET && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...baseHeaders });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: now() })}\n\n`);
      if (!streams.has(uid)) streams.set(uid, new Set());
      streams.get(uid).add(res);
      const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* gone */ } }, 25_000);
      beat.unref?.();
      req.on('close', () => { clearInterval(beat); streams.get(uid)?.delete(res); if (!streams.get(uid)?.size) streams.delete(uid); });
      return undefined;
    }

    /* live heart rate: memory only, so the person's database is not opened */
    if (POST && p === '/api/live/hr') return liveHr(req, res, uid, 'browser');
    if (POST && p === '/api/live/claim') {
      // This browser (or the iPhone app) is about to connect the sensor: a relay holding it lets go.
      const b = await readJson(req, 4096);
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
      if (name) {
        const names = app.meta(`liveSensors:${uid}`, []) || [];
        if (!names.includes(name)) app.setMeta(`liveSensors:${uid}`, [name, ...names].slice(0, 8));
      }
      return send(res, 200, live.claim(uid, 'browser'));
    }
    if (GET && p === '/api/live') return send(res, 200, live.view(uid));

    /* ── photos and videos (media.js): chunked uploads, no world opened ── */

    if (p === '/api/media' || p.startsWith('/api/media/m_')) {
      /** One of your own posts, for an upload: 404 if you cannot see it, 403 if it is a friend's. */
      const ownPost = (id) => {
        const row = app.get('SELECT * FROM post WHERE id = ?', String(id));
        if (!row || !feed.canSeePost(app, uid, row.id)) throw err('There is no such post.', 404);
        if (row.user_id !== uid) throw err('Photos and videos can only be added to your own posts.', 403);
        return row;
      };
      if (POST && p === '/api/media') {
        limiter.check(`media:${uid}`, 120 * loose, 3_600_000);
        const b = await readJson(req, 4096);
        let post = null;
        if (b.kind === 'post') {
          if (typeof b.postId !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(b.postId)) throw err('postId is needed for a photo or video on a post.');
          post = ownPost(b.postId);
        }
        const out = media.create(uid, b, post);
        limiter.add(`media:${uid}`, 3_600_000);
        return send(res, 200, out);
      }
      if (m === 'PUT' && (mm = /^\/api\/media\/(m_[0-9a-f]{10})\/chunk$/.exec(p))) {
        const i = url.searchParams.get('i');
        if (!/^\d{1,4}$/.test(i || '')) throw err('i must be the chunk number, from 0.');
        const buf = await readRaw(req, MEDIA_CHUNK);
        return send(res, 200, media.putChunk(uid, mm[1], Number(i), buf));
      }
      if (m === 'PUT' && (mm = /^\/api\/media\/(m_[0-9a-f]{10})\/thumb$/.exec(p))) {
        const buf = await readRaw(req, MEDIA_LIMITS.thumbBytes);
        return send(res, 200, media.putThumb(uid, mm[1], req.headers['content-type'], buf));
      }
      if (POST && (mm = /^\/api\/media\/(m_[0-9a-f]{10})\/done$/.exec(p))) {
        const out = media.finish(uid, mm[1], { postOk: (pid) => { try { return !!ownPost(pid); } catch { return false; } } });
        changed(uid, media.row(mm[1])?.kind === 'avatar' ? ['me', 'social'] : ['social']);
        return send(res, 200, out);
      }
      if (m === 'DELETE' && (mm = /^\/api\/media\/(m_[0-9a-f]{10})$/.exec(p))) {
        const out = media.remove(uid, mm[1]);
        changed(uid, out.avatar ? ['me', 'social'] : ['social']);
        return send(res, 200, out);
      }
      throw err('Not found', 404);
    }

    return worlds.hold(uid, async (w) => {
      const me = () => send(res, 200, mePayload(user, app.profile(uid)));

      /* ── the person ── */

      if (m === 'PATCH' && p === '/api/profile') {
        const b = await readJson(req);
        const patch = {};
        if (b.displayName !== undefined) {
          const v = String(b.displayName).trim();
          if (v.length < 1 || v.length > 40) throw err('Your display name must be 1-40 characters.');
          patch.displayName = v;
        }
        if (b.bio !== undefined) { const v = String(b.bio ?? '').trim(); if (v.length > 200) throw err('Your bio can be at most 200 characters.'); patch.bio = v; }
        if (b.accent !== undefined) {
          if (b.accent !== null && !/^#[0-9a-fA-F]{6}$/.test(String(b.accent))) throw err('The accent colour must look like #2fbf71.');
          patch.accent = b.accent === null ? null : String(b.accent).toLowerCase();
        }
        if (b.tz !== undefined) { if (!validTz(b.tz)) throw err('That is not a time zone this server knows.'); patch.tz = b.tz; }
        if (b.weekStart !== undefined) { if (!Number.isInteger(b.weekStart) || b.weekStart < 0 || b.weekStart > 6) throw err('weekStart must be 0 (Sunday) to 6 (Saturday).'); patch.weekStart = b.weekStart; }
        if (b.city !== undefined) { const v = b.city === null ? '' : String(b.city).replace(/\s+/g, ' ').trim(); if (v.length > 60) throw err('The city can be at most 60 characters.'); patch.city = v || null; }
        if (b.country !== undefined) { if (b.country !== null && !/^[A-Z]{2}$/.test(String(b.country))) throw err('country must be a two-letter code such as EG, or null.'); patch.country = b.country; }
        if (b.onboarding !== undefined) { if (!ONBOARDING.includes(b.onboarding)) throw err(`onboarding must be one of ${ONBOARDING.join(', ')}.`); patch.onboarding = b.onboarding; }
        if (b.notes !== undefined) w.db.setMeta('notes', String(b.notes ?? '').replace(/\r\n/g, '\n').slice(0, 4000));
        // The profile photo is set by uploading one (POST /api/media, kind avatar); here it can only be taken away.
        if (b.avatar !== undefined) {
          if (b.avatar !== null) throw err('avatar can only be null here. A new photo is uploaded through /api/media.');
          if (profile.avatar) app.dropMedia('id = ?', profile.avatar);
          changed(uid, ['social']);
        }
        if (Object.keys(patch).length) app.patchProfile(uid, patch);
        if (patch.tz) { w.setTz(patch.tz); computeCaps(w.db, { now: now(), tz: patch.tz }); }
        if (patch.weekStart !== undefined) w.weekStart = patch.weekStart;
        // A new zone moves which day every number belongs to in public too; a new week start, which week.
        if (patch.tz || patch.weekStart !== undefined || patch.displayName !== undefined) await publish(uid, { announce: false });
        changed(uid, ['me']);
        return me();
      }

      if (m === 'PATCH' && p === '/api/settings') {
        const b = await readJson(req);
        const patch = {};
        if (b.units !== undefined) {
          // One choice per unit. The old single switch ('metric' | 'imperial') still sets all three.
          if (typeof b.units === 'string' && !['metric', 'imperial'].includes(b.units)) throw err('units must be metric or imperial, or one choice per unit.');
          if (b.units && typeof b.units === 'object') {
            for (const [k, allowed] of Object.entries(UNIT_CHOICES)) if (b.units[k] !== undefined && !allowed.includes(b.units[k])) throw err(`units.${k} must be one of ${allowed.join(', ')}.`);
          }
          patch.units = normUnits(b.units, profile.units);
        }
        if (b.privacy !== undefined) {
          const pv = { ...PRIVACY_DEFAULT, ...profile.privacy };
          if (b.privacy?.account !== undefined) { if (!['public', 'private'].includes(b.privacy.account)) throw err('privacy.account must be public or private.'); pv.account = b.privacy.account; }
          for (const k of ['activity', 'workouts', 'sleep', 'heart', 'body', 'feed']) {
            if (b.privacy?.[k] !== undefined) { if (typeof b.privacy[k] !== 'boolean') throw err(`privacy.${k} must be true or false.`); pv[k] = b.privacy[k]; }
          }
          patch.privacy = pv;
        }
        if (b.goals !== undefined) {
          const g = {};
          const goal = (k, to, lo, hi) => { if (b.goals?.[k] !== undefined) { const n = Math.round(Number(b.goals[k])); if (!(n >= lo && n <= hi)) throw err(`goals.${k} must be ${lo}-${hi}.`); g[to] = n; } };
          goal('steps', 'stepTarget', 1000, 50_000); goal('activeMinutes', 'azmTarget', 5, 240); goal('sleepMinutes', 'sleepTarget', 240, 720);
          goal('cardioWeek', 'cardioTarget', 30, 600); goal('waterMl', 'waterTarget', 500, 6000);
          w.setSettings(g);
          if (g.stepTarget) patch.stepGoal = g.stepTarget;
        }
        if (b.body !== undefined) {
          // For a body composition scale's standard ranges; kept in the person's own store only.
          if (!b.body || typeof b.body !== 'object' || Array.isArray(b.body)) throw err('body must be { sex, birthYear }.');
          const cur = w.db.meta('body', null) || {};
          const next = { sex: cur.sex ?? null, birthYear: cur.birthYear ?? null };
          if (b.body.sex !== undefined) { if (![null, 'female', 'male'].includes(b.body.sex)) throw err('body.sex must be female, male or null.'); next.sex = b.body.sex; }
          if (b.body.birthYear !== undefined) {
            const y = new Date(now()).getUTCFullYear();
            if (b.body.birthYear !== null && !(Number.isInteger(b.body.birthYear) && b.body.birthYear >= y - 110 && b.body.birthYear <= y - 5)) throw err(`body.birthYear must be a year from ${y - 110} to ${y - 5}, or null.`);
            next.birthYear = b.body.birthYear;
          }
          w.db.setMeta('body', next);
        }
        if (b.aiShare !== undefined) {
          // Per optional group: may a summary read what was logged in it.
          if (!b.aiShare || typeof b.aiShare !== 'object' || Array.isArray(b.aiShare)) throw err('aiShare must be an object of switches, one per group.');
          for (const [k, v] of Object.entries(b.aiShare)) {
            if (!GROUP_IDS.includes(k)) throw err(`aiShare.${k} is not a group. The groups are ${GROUP_IDS.join(', ')}.`);
            if (typeof v !== 'boolean') throw err(`aiShare.${k} must be true or false.`);
          }
          w.setAiShare(b.aiShare);
        }
        if (Object.keys(patch).length) app.patchProfile(uid, patch);
        // Before the reply: by the time the person reads "private", it is.
        if (patch.privacy || patch.stepGoal) await publish(uid, { announce: false });
        changed(uid, ['me', 'data', 'social']);
        return me();
      }

      /* ── data ── */

      if (GET && p === '/api/data') return send(res, 200, { ...views.dataView(w, { days: clamp(Math.round(Number(url.searchParams.get('days')) || 30), 7, 90) }), live: live.latest(uid) });
      if (GET && p === '/api/trends') {
        const d = Number(url.searchParams.get('days'));
        return send(res, 200, views.trendsView(w, { days: [7, 30, 90, 180, 365].includes(d) ? d : 30 }));
      }
      if (GET && p === '/api/brief') return send(res, 200, views.briefView(w));
      if (GET && p === '/api/day') return send(res, 200, await views.dayView(w, url.searchParams.get('date')));

      /* ── every metric: Browse, one metric, pins ── */

      if (GET && p === '/api/browse') return send(res, 200, browseView(w));
      if (GET && (mm = /^\/api\/metric\/([a-z0-9_]{1,40})$/.exec(p))) {
        const q = url.searchParams;
        return send(res, 200, await metricView(w, mm[1], { range: q.get('range') || 'week', end: q.get('end'), before: q.get('before'), hours: views.dayView }));
      }
      if (m === 'PUT' && p === '/api/shown') {
        const b = await readJson(req);
        const shown = setShown(w, b.ids === undefined ? null : b.ids);
        changed(uid, ['data']);
        return send(res, 200, { shown });
      }
      if (POST && p === '/api/pins') {
        const b = await readJson(req);
        const pinned = setPin(w, b.id, b.on);
        changed(uid, ['me', 'data']);
        return send(res, 200, { pinned });
      }

      /* ── entries: what a person logs by hand ── */

      /** After an entry changed: capabilities, and the person's open tabs.
          Nothing an entry holds is published, with one old exception: body
          fat has always been a public number for somebody who shares "body". */
      const afterEntry = async (kind) => {
        computeCaps(w.db, { now: now(), tz: profile.tz });
        if (kind === 'bodyfat' && !SENSITIVE_KINDS.includes(kind)) await publish(uid, { announce: false });
        changed(uid, ['data']);
      };
      if (POST && p === '/api/entries') {
        limiter.check(`entry:${uid}`, 120 * loose, 60_000);
        limiter.add(`entry:${uid}`, 60_000);
        const { kind, ...fields } = await readJson(req);
        const r = await addEntry(w, String(kind || ''), fields);
        await afterEntry(r.entry.kind);
        return send(res, 200, { entry: entryView(w, w.db.sampleGet(r.entry.id)), google: r.google, message: r.message || null });
      }
      if (m === 'PATCH' && (mm = /^\/api\/entries\/([A-Za-z0-9_-]{1,80})$/.exec(p))) {
        const { kind: _k, ...fields } = await readJson(req);
        const r = await editEntry(w, mm[1], fields);
        await afterEntry(r.entry.kind);
        return send(res, 200, { entry: entryView(w, w.db.sampleGet(r.entry.id)), google: r.google, message: r.message || null });
      }
      if (m === 'DELETE' && (mm = /^\/api\/entries\/([A-Za-z0-9_-]{1,80})$/.exec(p))) {
        const kind = w.db.sampleGet(mm[1])?.kind;
        const r = await removeEntry(w, mm[1]);
        await afterEntry(kind);
        return send(res, 200, { ok: true, google: r.google, message: r.message || null });
      }

      /* ── the optional groups ── */

      if (POST && p === '/api/google/groups') {
        const b = await readJson(req);
        const g = groupById(String(b.group || ''));
        if (!g) throw err(`group must be one of ${GROUP_IDS.join(', ')}.`, 400, 'bad_group');
        if (typeof b.on !== 'boolean') throw err('on must be true or false.');
        let purged = 0;
        if (!b.on) {
          // Off is enforced here at once, whatever Google still holds.
          w.setGroups({ [g.id]: false });
          if (b.purge === true) purged = w.db.samplesPurge(g.kinds);
        } else {
          const connected = w.google.connected();
          if (!(connected && w.google.groupGranted(g.id))) {
            const detail = { start: `/auth/google/start?groups=${g.id}`, group: g.id, canLocal: !g.readOnly };
            // A group that is only ever read from Google is nothing without it.
            if (g.readOnly) {
              if (!connected) throw err(`Connect Google Health first: ${g.label} are read from it.`, 409, 'needs_google', detail);
              throw err(`Google Health has not been asked for ${g.label.toLowerCase()} yet.`, 409, 'needs_scope', detail);
            }
            // Connected, but this permission was never given: ask for it,
            // unless the person said to keep the entries here only.
            if (connected && b.local !== true) throw err(`Google Health has not been asked for ${g.label.toLowerCase()} yet. Allow it there, or keep what you log on this site only.`, 409, 'needs_scope', detail);
          }
          w.setGroups({ [g.id]: true });
          if (connected) scheduler.poke(uid);
        }
        computeCaps(w.db, { now: now(), tz: profile.tz });
        changed(uid, ['me', 'data']);
        const groups = w.groupsView();
        return send(res, 200, { group: groups.find((x) => x.id === g.id), groups, purged });
      }
      if (POST && p === '/api/sync') {
        const b = await readJson(req).catch(() => ({}));
        // The app open in front asks once a minute (auto): a light pass that
        // respects backoffs, skipped when anything synced in the last minute.
        if (b.auto === true) {
          const last = Math.max(w.sync.state?.lastRun || 0, scheduler.lastRunOf?.(uid) || 0);
          if (now() - last < 60_000 || w.sync.running) return send(res, 200, { skipped: true, sync: views.syncView(w, scheduler) });
          limiter.check(`autosync:${uid}`, 2, 55_000);
          limiter.add(`autosync:${uid}`, 55_000);
          const r = await syncUser(uid, { force: false });
          scheduler.settle(profile, r);
          return send(res, 200, { result: { ok: !!r.ok, code: r.code || null }, sync: views.syncView(w, scheduler) });
        }
        if (!w.anySource()) throw err('Connect Google Health or Garmin first.', 409, 'needs_google');
        throttle(`sync:${uid}`, 60_000 / loose, 'A sync ran less than a minute ago.');
        const r = await syncUser(uid, { force: true });
        scheduler.settle(profile, r);
        return send(res, 200, { result: { ok: !!r.ok, code: r.code || null, message: r.message || null, wrote: r.wrote || 0 }, sync: views.syncView(w, scheduler) });
      }
      if (POST && p === '/api/weight') {
        const b = await readJson(req);
        // Without Google (or its permission) a weigh-in is kept here, and
        // goes to Hevy when that is linked.
        const toGoogle = w.google.connected() && w.google.granted(SCOPES.weightWrite);
        const kg = Number(b.kg);
        if (!(kg >= 20 && kg <= 400)) throw err('Weight must be between 20 and 400 kg.');
        const at = b.at === undefined ? Math.floor(now() / 1000) * 1000 : Math.floor(Number(b.at) / 1000) * 1000;
        if (!Number.isFinite(at) || at > now() + 120_000) throw err('A weigh-in cannot be in the future.');
        if (at < now() - 30 * 86_400_000) throw err('That is more than 30 days ago.');
        const off = utcOffsetSec(at, profile.tz);
        const note = b.note ? String(b.note).slice(0, 200) : null;
        if (toGoogle) await w.google.createWeight({ grams: Math.round(kg * 1000), at, offsetSec: off, notes: note });
        // Keyed by the same instant Google stores, so the next sync's copy of
        // this weigh-in lands on this row instead of beside it.
        w.db.upsertWeight({ t: at, grams: Math.round(kg * 1000), off, source: 'app', note });
        w.db.setMeta('hevyMeasureDirty', true);
        computeCaps(w.db, { now: now(), tz: profile.tz });
        await publish(uid, { announce: false });
        changed(uid, ['data']);
        const hevyOn = hevyMeta(w.db).connected;
        const message = toGoogle ? null : `Saved here${hevyOn ? ', and it goes to Hevy at the next sync' : ''}. ${w.google.connected() ? 'Reconnect Google Health and allow saving your weight to save it there too.' : 'Connect Google Health to save weigh-ins there too.'}`;
        return send(res, 200, { ok: true, google: toGoogle ? 'saved' : 'local', message, point: { t: at, kg: Math.round(kg * 100) / 100, source: 'app' } });
      }

      /* ── the Log sheet, and looking food up ── */

      if (GET && p === '/api/log') {
        const hv = hevyMeta(w.db).connected && !!app.secretRow(uid, 'hevy');
        return send(res, 200, logView(w, { routines: hv ? w.db.hevyRoutines() : [], hevy: hv, goals: views.goalsView(w), now: now() }));
      }
      if (GET && p === '/api/food/search') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
        const mine = ownFoods(w.db, { q, limit: q ? 8 : 12 });
        const common = commonFoods(q, q ? 8 : 0);
        let found = []; let note = null;
        if (q.length >= 2 && url.searchParams.get('online') !== '0') {
          try {
            // Typing searches as it goes: plenty a minute, but not a flood.
            limiter.check(`food:${uid}`, 30 * loose, 60_000);
            limiter.add(`food:${uid}`, 60_000);
            found = await food.search(q, { limit: 20 });
          } catch (e) { note = e.code === 'rate_limited' ? 'That was a lot of searches. Wait a moment and type again.' : 'The food database could not be reached. Your own and common foods are still here.'; }
        }
        return send(res, 200, { q, mine, common, found, note, source: 'Open Food Facts (openfoodfacts.org)' });
      }
      if (GET && (mm = /^\/api\/food\/barcode\/(\d{6,14})$/.exec(p))) {
        limiter.check(`barcode:${uid}`, 30 * loose, 60_000);
        limiter.add(`barcode:${uid}`, 60_000);
        const f = await food.barcode(mm[1]).catch((e) => { if (e.status) throw e; throw err('The food database could not be reached. Try again, or enter the food by hand.', 502, 'upstream'); });
        if (!f) throw err('That barcode is not in Open Food Facts yet. Enter the food by hand.', 404);
        return send(res, 200, { food: f });
      }

      /* ── exercises to pick from (the Hevy library, and what you did before) ── */

      if (GET && p === '/api/exercises/pick') {
        const q = String(url.searchParams.get('q') || '').slice(0, 80);
        const limit = clamp(Number(url.searchParams.get('limit')) || 40, 1, 100);
        const group = MUSCLES.includes(url.searchParams.get('group')) ? url.searchParams.get('group') : null;
        const equipment = EQUIPMENT.includes(url.searchParams.get('equipment')) ? url.searchParams.get('equipment') : null;
        // What you did before and your Hevy library first, then the library.
        const mine = group || equipment ? [] : exercisePicker(w.db, { q, limit });
        const seen = new Set(mine.map((x) => x.name.toLowerCase()));
        for (const x of mine) { const l = libMatch(x.name); x.libId = l?.id || null; x.image = l ? libView(l).images[0] : null; x.source = x.templateId ? 'hevy' : 'yours'; }
        // The same lift once: a library exercise you already have under another name (Hevy's) is not listed again.
        for (const x of mine) if (x.libId) seen.add(`lib:${x.libId}`);
        // Exercises people made (yours first, then everyone's shared ones), as they described them.
        migrateMine(w, uid);
        const made = cexSearch(app, uid, { q, group, equipment, limit });
        const madeBy = new Map(); for (const o of made) if (!madeBy.has(o.name.toLowerCase())) madeBy.set(o.name.toLowerCase(), o);
        const asItem = (o) => { const v = cexView(app, o, uid); return { name: o.name, templateId: null, libId: o.id, muscle: null, group: o.muscle, equipment: o.equipment, type: o.type, custom: true, mine: v.mine, by: v.mine ? null : v.by, image: v.images[0] || null, source: v.mine ? 'yours' : 'shared' }; };
        // Done before and made by you: it takes what you said about it.
        for (const x of mine) { const o = madeBy.get(x.name.toLowerCase()); if (o) Object.assign(x, { ...asItem(o), lastAt: x.lastAt, best: x.best, sets: x.sets }); }
        for (const o of made) {
          const k = o.name.toLowerCase();
          if (seen.has(k)) continue;
          mine.push({ ...asItem(o), lastAt: null, best: null, sets: 0 });
          seen.add(k);
        }
        const lib = librarySearch({ q, group, equipment, limit }).exercises.filter((x) => !seen.has(x.name.toLowerCase()) && !seen.has(`lib:${x.id}`))
          .map((x) => ({ name: x.name, templateId: null, libId: x.id, muscle: x.primary[0] || null, group: x.group, equipment: x.equipment, type: x.type, custom: false, lastAt: null, best: null, sets: 0, image: x.images[0] || null, source: 'library' }));
        return send(res, 200, { exercises: [...mine, ...lib].slice(0, limit), hevy: !!hevyMeta(w.db).connected && !!app.secretRow(uid, 'hevy') });
      }

      /* ── exercises people made (sharedlib.js): for everyone, with steps and photos ── */
      if (POST && (p === '/api/exercises/mine' || p === '/api/exercises/custom')) {
        const b = await readJson(req, 32 * 1024);
        const x = cexCreate(app, uid, b, now());
        return send(res, 200, { exercise: cexView(app, x, uid, { full: true }) });
      }
      if (GET && p === '/api/exercises/custom') {
        migrateMine(w, uid);
        const list = cexSearch(app, uid, { q: String(url.searchParams.get('q') || '').slice(0, 80), mineOnly: url.searchParams.get('scope') === 'mine', limit: 200 });
        return send(res, 200, { exercises: list.map((x) => cexView(app, x, uid)) });
      }
      if ((mm = /^\/api\/exercises\/custom\/(c_[0-9a-f]{12})(?:\/photos(?:\/(\d)(\/first)?)?)?$/.exec(p))) {
        const id = mm[1]; const photos = p.includes('/photos');
        const view = (x) => send(res, 200, { exercise: cexView(app, x, uid, { full: true }) });
        if (!photos && GET) { const x = cexGet(app, id); if (!cexVisible(app, x, uid)) throw err('There is no such exercise.', 404); return view(x); }
        if (!photos && m === 'PATCH') { const b = await readJson(req, 32 * 1024); return view(cexPatch(app, uid, id, b, now())); }
        if (!photos && m === 'DELETE') { cexDelete(app, cexPhotos, uid, id); return send(res, 200, { ok: true }); }
        if (photos && POST && mm[2] === undefined) {
          limiter.check(`cexphoto:${uid}`, 60, 3_600_000); limiter.add(`cexphoto:${uid}`, 3_600_000);
          const buf = await readRaw(req, 3 * 1024 * 1024 + 1);
          return view(cexPhotos.add(app, uid, id, buf, now()));
        }
        if (photos && m === 'DELETE' && mm[2] !== undefined && !mm[3]) return view(cexPhotos.remove(app, uid, id, Number(mm[2]), now()));
        if (photos && POST && mm[3]) return view(cexPhotos.first(app, uid, id, Number(mm[2]), now()));
      }
      if (GET && (mm = /^\/api\/media\/cex\/(c_[0-9a-f]{12})\/(\d)\.jpg$/.exec(p))) {
        const x = cexGet(app, mm[1]);
        // A routine holding someone's exercise still shows its photo, so only a missing one is refused.
        const buf = x && Number(mm[2]) < x.images ? cexPhotos.get(x.id, Number(mm[2])) : null;
        if (!buf) throw err('No such picture.', 404);
        res.writeHead(200, { ...baseHeaders, 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=2592000, immutable' });
        return res.end(buf);
      }

      /* ── the exercise library (library.js) ── */

      if (GET && p === '/api/library') {
        const n = (k, lo, hi, d) => clamp(Math.round(Number(url.searchParams.get(k)) || d), lo, hi);
        const group = MUSCLES.includes(url.searchParams.get('group')) ? url.searchParams.get('group') : null;
        const muscle = LIB_MUSCLES.includes(url.searchParams.get('muscle')) ? url.searchParams.get('muscle') : null;
        const equipment = EQUIPMENT.includes(url.searchParams.get('equipment')) ? url.searchParams.get('equipment') : null;
        const q1 = String(url.searchParams.get('q') || '').slice(0, 80);
        const r = librarySearch({ q: q1, group, muscle, equipment, limit: n('limit', 1, 100, 40), offset: n('offset', 0, 2000, 0) });
        // Exercises people made, on the first page: yours, then everyone's shared ones.
        const custom = muscle || n('offset', 0, 2000, 0) ? [] : cexSearch(app, uid, { q: q1, group, equipment, limit: 60 }).map((x) => cexView(app, x, uid));
        return send(res, 200, { ...r, custom, size: libSize(), groups: MUSCLES.filter((x) => x !== 'other'), muscles: LIB_MUSCLES, equipment: EQUIPMENT, source: LIBRARY_SOURCE });
      }
      if (GET && (mm = /^\/api\/library\/([A-Za-z0-9_-]{1,100})$/.exec(p))) {
        const x = libById(mm[1]);
        if (!x) throw err('There is no such exercise.', 404);
        const made = x.custom ? cexGet(app, x.id) : null;
        // Someone else's that is no longer shared: still shown by name to those whose routine holds it.
        if (made && !cexVisible(app, made, uid) && !w.db.routines().some((r) => r.exercises.some((e) => e.libId === made.id))) throw err('There is no such exercise.', 404);
        // Your own history of it, when you have done it.
        const prev = previousOf(w.db, [x.name]).get(x.name.toLowerCase()) || null;
        const hist = w.db.exerciseSets(0).filter((s) => s.exercise.toLowerCase() === x.name.toLowerCase());
        const by = new Map();
        for (const s of hist) { const o = by.get(s.workoutId) || { t: s.t, topKg: null, reps: null, volume: 0, sets: 0 }; o.sets += 1; if (s.kg && s.reps) o.volume += s.kg * s.reps; if (s.kg && (!o.topKg || s.kg > o.topKg)) { o.topKg = s.kg; o.reps = s.reps; } by.set(s.workoutId, o); }
        return send(res, 200, { exercise: made ? cexView(app, made, uid, { full: true }) : libView(x, { full: true }), last: prev, history: [...by.entries()].slice(-30).map(([id, o]) => ({ workoutId: String(id), ...o, volume: Math.round(o.volume) })), source: LIBRARY_SOURCE });
      }
      if (GET && (mm = /^\/api\/media\/exercises\/([A-Za-z0-9_-]{1,100})\/(\d)\.jpg$/.exec(p))) {
        const buf = await exImages.get(mm[1], Number(mm[2]));
        if (!buf) throw err('No such picture.', 404);
        res.writeHead(200, { ...baseHeaders, 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=2592000, immutable' });
        return res.end(buf);
      }
      if (GET && (mm = /^\/api\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/.exec(p))) {
        limiter.check(`tiles:${uid}`, 600 * loose, 60_000);
        limiter.add(`tiles:${uid}`, 60_000);
        const buf = await tiles.get(Number(mm[1]), Number(mm[2]), Number(mm[3]));
        if (!buf) throw err('No such map tile.', 404);
        res.writeHead(200, { ...baseHeaders, 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'private, max-age=604800' });
        return res.end(buf);
      }

      /* ── AI (ai.js): a section's summary, a question, the morning summary ── */

      const aiStart = ({ topic, id = null, question = null, history = [], onDone }) => {
        const today = todayU(now(), w.tz);
        const title = AI_TOPICS[topic] || AI_TOPICS.ask;
        return aiJobs.start(uid, {
          topic, title,
          cache: { get: (k) => answerCache(w.db).get(k), set: (k, v) => { worlds.hold(uid, (w2) => answerCache(w2.db).set(k, v)).catch(() => {}); } },
          onDone,
          build: () => worlds.hold(uid, async (w2) => {
            let detail = null;
            if (topic === 'workout' && id) { try { detail = aiWorkout(w2, null, await views.workoutDetail(w2, id)); } catch { detail = null; } }
            if (topic === 'metric' && id) detail = aiMetric(w2, id);
            const text = aiBriefing(w2, { topic, id, profile: { ...profile, username: user.username }, now: now(), extra: { detail } });
            const stamp = w2.sync?.state?.lastOk || 0;
            const cacheKey = question ? null : `${topic}:${id || ''}:${today}:${Math.floor(stamp / 600_000)}:${w2.db.meta('derived')?.models || ''}`;
            return { prompt: aiPrompt({ topic, briefingText: text, question, history }), cacheKey };
          }),
        });
      };
      if (POST && p === '/api/ai') {
        const b = await readJson(req, 64 * 1024);
        const topic = AI_TOPICS[b.topic] ? b.topic : 'ask';
        if (topic === 'ask' && !String(b.question || '').trim()) throw err('Ask a question.');
        limiter.check(`ai:${uid}`, 20 * loose, 600_000);
        limiter.add(`ai:${uid}`, 600_000);
        const history = Array.isArray(b.history) ? b.history.filter((h) => h && typeof h.text === 'string').map((h) => ({ role: h.role === 'user' ? 'user' : 'ai', text: h.text.slice(0, 1000) })).slice(-8) : [];
        return send(res, 200, aiStart({ topic, id: b.id ? String(b.id).slice(0, 80) : null, question: b.question ? String(b.question).slice(0, 500) : null, history }));
      }
      if (GET && (mm = /^\/api\/ai\/(ai[a-z0-9]{4,30})$/.exec(p))) {
        const j = aiJobs.get(mm[1], uid);
        if (!j) throw err('That request is gone. Ask again.', 404);
        return send(res, 200, j);
      }
      if (p === '/api/ai/morning') {
        // Once a day, after waking: last night and what it means for today.
        const today = todayU(now(), w.tz);
        const kept = w.db.meta('aiMorning', null);
        const hour = new Date(now() + utcOffsetSec(now(), w.tz) * 1000).getUTCHours();
        const last = w.db.sleeps(addDaysU(today, -1)).filter((n) => n.main && n.date === today).sort((x, y) => (y.asleepMin || 0) - (x.asleepMin || 0))[0];
        const night = Boolean(last);
        // The night as it stands: a note written while the night was still
        // coming in (a phone opened at 5 am, half the night synced) is not
        // kept once more of it arrives; it is written again.
        const sig = last ? `${last.endMs}:${Math.round(last.asleepMin || 0)}` : '';
        const fresh = kept?.date === today && (!night || kept.night === sig);
        const view1 = () => ({ date: today, answer: fresh ? kept.answer : null, model: fresh ? kept.model : null, due: hour >= 4 && hour < 16 && night && !fresh, night, configured: writer.configured() });
        if (GET) return send(res, 200, view1());
        if (POST) {
          if (fresh) return send(res, 200, view1());
          if (!night) throw err('Last night has not arrived from your device yet.', 409, 'conflict');
          const job = aiStart({ topic: 'morning', onDone: (j) => { worlds.hold(uid, (w2) => w2.db.setMeta('aiMorning', { date: today, night: sig, answer: j.answer, model: j.model, at: now() })).catch(() => {}); changed(uid, ['ai']); } });
          return send(res, 200, { ...view1(), job });
        }
      }

      /* ── routines (routines.js) ── */

      const routinesPayload = () => {
        const all = w.db.routines();
        const list = all.map(routineSummary);
        // Hevy routines already here (synced, or copied before).
        const synced = new Set(all.flatMap((r) => [r.hevy?.id, r.from?.kind === 'hevy' ? r.from.id : null]).filter(Boolean));
        const folders = [...new Set(list.map((r) => r.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        const hevy = w.db.hevyRoutines().map((r) => ({ id: r.id, title: r.title, folder: r.folder || null, exercises: (r.exercises || []).length, sets: (r.exercises || []).reduce((a, x) => a + (x.sets || []).length, 0), copied: synced.has(r.id) }));
        return { routines: list, folders, hevy };
      };
      /** A routine changed here: the page hears it, and Hevy gets it at once (hevyroutines.js). */
      const routinesChanged = (more = []) => {
        // The shared copies of the public ones (sharedlib.js), the same as these now.
        syncShared(app, uid, w.db.routines(), now());
        changed(uid, ['routines', ...more]);
        if (hevyMeta(w.db).connected && hevyMeta(w.db).settings.routines) {
          w.db.setMeta('hevyRoutinesDirty', true);
          syncExtras(uid, w, { only: 'hevy' }).catch((e) => log(`hevy routines: ${e.message}`));
        }
      };
      const ownRoutine = (id) => { const r = w.db.routineGet(id); if (!r) throw err('There is no such routine.', 404); return r; };
      const routineDetail = (r) => {
        const done = w.db.workoutsDone(Number.MAX_SAFE_INTEGER, 300).filter((o) => o.routineId === r.id).slice(0, 10);
        const totals = w.db.setTotals();
        const prev = previousOf(w.db, r.exercises.map((x) => x.name));
        return {
          routine: { ...r, exercises: r.exercises.map((x) => ({ ...x, image: x.libId ? libView(libById(x.libId))?.images[0] || null : null, last: prev.get(x.name.toLowerCase())?.sets || null })) },
          summary: routineSummary(r),
          history: done.map((o) => ({ id: String(o.id), start: o.start, durationMin: o.end ? Math.round((o.end - o.start) / 60_000) : null, volumeKg: totals[o.id]?.volumeKg ?? null, sets: totals[o.id]?.sets ?? null })),
        };
      };
      if (GET && p === '/api/routines') return send(res, 200, { ...routinesPayload(), starters: STARTERS.map((x) => ({ id: x.id, title: x.title, text: x.text, routines: x.routines.map((r) => ({ title: r.title, exercises: r.exercises.map((e) => e.name) })) })) });
      if (POST && p === '/api/routines/starter') {
        const b = await readJson(req);
        const st = STARTERS.find((x) => x.id === b.id);
        if (!st) throw err('There is no such programme.', 404);
        let pos = w.db.routines().length;
        const made = st.routines.map((x) => { const r = cleanRoutine({ ...x, folder: st.title, from: { kind: 'starter', id: st.id } }, null, now()); r.position = pos++; w.db.routinePut(r); return r.id; });
        routinesChanged();
        return send(res, 200, { ...routinesPayload(), made });
      }
      if (POST && p === '/api/routines') {
        const b = await readJson(req, 256 * 1024);
        if (w.db.routines().length >= 200) throw err('At most 200 routines.', 409, 'conflict');
        const r = cleanRoutine(b, null, now());
        r.position = r.position || w.db.routines().length;
        w.db.routinePut(r);
        routinesChanged();
        return send(res, 200, routineDetail(r));
      }
      if (POST && p === '/api/routines/from-workout') {
        const b = await readJson(req);
        const wk = ownWorkout(w, b.workoutId);
        const sets = w.db.setsOf(wk.id);
        if (!sets.length) throw err('That workout has no exercises to make a routine of.', 409, 'conflict');
        const r = cleanRoutine({ title: b.title || wk.title || 'Routine', folder: b.folder, exercises: exercisesFromSets(sets), from: { kind: 'workout', id: String(wk.id) } }, null, now());
        r.position = w.db.routines().length;
        w.db.routinePut(r);
        if (!wk.routineId) { wk.routineId = r.id; wk.updated = now(); w.db.workoutPut(wk); }
        routinesChanged(['workouts']);
        return send(res, 200, routineDetail(r));
      }
      if (POST && p === '/api/routines/from-hevy') {
        const b = await readJson(req);
        const h = w.db.hevyRoutine(String(b.id || ''));
        if (!h) throw err('There is no such Hevy routine.', 404);
        const exercises = (h.exercises || []).map((x) => ({ name: x.name, templateId: x.templateId, libId: libByName(x.name)?.id || null, restS: x.restS ?? x.rest_seconds ?? 90, notes: x.notes || null, sets: (x.sets || []).map((st) => ({ type: st.type, kg: st.kg, reps: st.reps ?? st.repRange?.start ?? null, repsMax: st.repRange?.end ?? null, durationS: st.durationS, distanceM: st.distanceM })) }));
        const r = cleanRoutine({ title: h.title, folder: h.folder || null, exercises, from: { kind: 'hevy', id: h.id } }, null, now());
        r.position = w.db.routines().length;
        w.db.routinePut(r);
        routinesChanged();
        return send(res, 200, routineDetail(r));
      }
      if (m === 'PATCH' && p === '/api/routines/folders') {
        const b = await readJson(req);
        const from = String(b.from || '');
        // Share a whole programme (a folder), or stop sharing it; else rename the folder.
        if (typeof b.public === 'boolean') {
          let n = 0;
          for (const r of w.db.routines()) if ((r.folder || '') === from) { r.public = b.public; r.updated = now(); w.db.routinePut(r); n += 1; }
          routinesChanged();
          return send(res, 200, { ...routinesPayload(), changed: n });
        }
        const to = b.to ? String(b.to).trim().slice(0, 60) : null;
        let n = 0;
        for (const r of w.db.routines()) if (r.folder === from) { r.folder = to; r.updated = now(); w.db.routinePut(r); n += 1; }
        routinesChanged();
        return send(res, 200, { ...routinesPayload(), moved: n });
      }
      /* Routines others share (sharedlib.js): browse them as programmes, look at one, add them to your own. */
      if (GET && p === '/api/routines/browse') {
        return send(res, 200, { programmes: browseShared(app, uid, { q: String(url.searchParams.get('q') || '').slice(0, 80) }) });
      }
      if (GET && (mm = /^\/api\/routines\/shared\/(r-[a-f0-9-]{1,40})$/.exec(p))) return send(res, 200, sharedGet(app, uid, mm[1]));
      if (POST && p === '/api/routines/copy') {
        const b = await readJson(req);
        const list = sharedForCopy(app, uid, b.ids);
        if (w.db.routines().length + list.length > 200) throw err('At most 200 routines.', 409, 'conflict');
        let pos = w.db.routines().length;
        const made = list.map((s) => {
          const r = cleanRoutine({ title: s.routine.title, folder: s.routine.folder || null, notes: s.routine.notes || null, exercises: s.routine.exercises, from: { kind: 'shared', id: s.id, by: s.by } }, null, now());
          r.position = pos++;
          w.db.routinePut(r);
          return r.id;
        });
        routinesChanged();
        return send(res, 200, { ...routinesPayload(), made });
      }
      if (POST && p === '/api/routines/order') {
        const b = await readJson(req);
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
        ids.forEach((id, i) => { const r = w.db.routineGet(id); if (r) { r.position = i; w.db.routinePut(r); } });
        syncShared(app, uid, w.db.routines(), now());
        return send(res, 200, routinesPayload());
      }
      if ((mm = /^\/api\/routines\/(r-[a-f0-9-]{1,40})(\/[a-z-]+)?$/.exec(p))) {
        const r = ownRoutine(mm[1]);
        const sub = mm[2] || '';
        if (GET && !sub) return send(res, 200, routineDetail(r));
        if (m === 'PUT' && !sub) {
          const b = await readJson(req, 256 * 1024);
          const next = cleanRoutine(b, r, now());
          w.db.routinePut(next);
          routinesChanged();
          return send(res, 200, routineDetail(next));
        }
        if (m === 'PATCH' && !sub) {
          const b = await readJson(req);
          const next = cleanRoutine({ title: b.title, folder: b.folder, notes: b.notes, position: b.position, public: b.public }, r, now());
          w.db.routinePut(next);
          routinesChanged();
          return send(res, 200, routineDetail(next));
        }
        if (m === 'DELETE' && !sub) {
          // Hevy's API cannot delete a routine: it stays there, and is not brought back here.
          const inHevy = forgetHevyRoutine(w.db, r);
          w.db.routineDel(r.id);
          changed(uid, ['routines']);
          return send(res, 200, { ...routinesPayload(), keptInHevy: inHevy });
        }
        if (POST && sub === '/duplicate') {
          const copy = cleanRoutine({ ...r, title: `${r.title} (copy)`.slice(0, 80) }, null, now());
          copy.position = w.db.routines().length;
          w.db.routinePut(copy);
          routinesChanged();
          return send(res, 200, routineDetail(copy));
        }
        if (POST && sub === '/from-workout') {
          // Bring the routine up to date with what was done in a workout.
          const b = await readJson(req);
          const wk = ownWorkout(w, b.workoutId);
          const sets = w.db.setsOf(wk.id);
          if (!sets.length) throw err('That workout has no exercises.', 409, 'conflict');
          const next = cleanRoutine({ exercises: exercisesFromSets(sets, r) }, r, now());
          w.db.routinePut(next);
          routinesChanged();
          return send(res, 200, routineDetail(next));
        }
        throw err('Not found', 404);
      }
      if (GET && p === '/api/exercises/last') {
        return send(res, 200, { sets: lastSetsOf(w.db, url.searchParams.get('name')) });
      }

      /* ── Hevy ── */

      if (GET && p === '/api/hevy') return send(res, 200, hevyPayload(w, uid));
      if (POST && p === '/api/hevy/connect') {
        limiter.check(`hevykey:${uid}`, 10 * loose, 600_000);
        limiter.add(`hevykey:${uid}`, 600_000);
        const b = await readJson(req);
        const key = String(b.key || '').trim();
        if (!/^[A-Za-z0-9-]{16,80}$/.test(key)) throw err('That does not look like a Hevy API key. Copy it from Hevy, Settings, Developer.', 400, 'bad_key');
        const api = hevyApiFor(uid, key);
        let info;
        try { info = await api.user(); } catch (e) {
          if (e.code === 'hevy_key') throw err('Hevy did not accept this key. Make a new one in Hevy, Settings, Developer, and paste it again.', 400, 'bad_key');
          if (e.code === 'hevy_pro') throw err('Hevy refused this key: the Hevy API needs Hevy Pro.', 409, 'hevy_pro');
          throw err(`Hevy could not be reached: ${e.message}`, 502, 'upstream');
        }
        app.setSecret(uid, 'hevy', vault.seal(key, `${uid}:hevy`), key.slice(-4));
        const m = hevyMeta(w.db);
        setHevyMeta(w.db, {
          connected: true, lastError: null,
          user: info ? { username: info.username || null, name: info.name || null, url: info.url || null, weightUnit: info.weight_unit || null, distanceUnit: info.distance_unit || null, pro: info.is_pro !== false } : null,
          // A new account starts again; the same one reconnecting carries on.
          ...(m.user?.username && info?.username && m.user.username !== info.username ? { first: null, since: null, templatesAt: 0, routinesAt: 0 } : {}),
          connectedAt: m.connectedAt && m.user?.username === info?.username ? m.connectedAt : now(),
          ...(b.settings && typeof b.settings === 'object' ? { settings: { ...m.settings, ...cleanSwitches(b.settings, HEVY_DEFAULTS) } } : {}),
        });
        scheduler.poke(uid);
        // The first sync starts now; the page hears when it is done.
        syncExtras(uid, w, { force: true, only: 'hevy' }).catch((e) => log(`hevy first sync: ${e.message}`));
        changed(uid, ['me']);
        return send(res, 200, hevyPayload(w, uid));
      }
      if (m === 'PATCH' && p === '/api/hevy/settings') {
        const b = await readJson(req);
        setHevyMeta(w.db, { settings: { ...hevyMeta(w.db).settings, ...cleanSwitches(b, HEVY_DEFAULTS) } });
        changed(uid, ['me']);
        return send(res, 200, hevyPayload(w, uid));
      }
      if (POST && p === '/api/hevy/sync') {
        if (!hevyMeta(w.db).connected || !app.secretRow(uid, 'hevy')) throw err('Connect Hevy first.', 409, 'needs_hevy');
        throttle(`hevysync:${uid}`, 30_000 / loose, 'Hevy was read less than half a minute ago.');
        const r = await syncExtras(uid, w, { force: true, only: 'hevy' });
        return send(res, 200, { result: r.hevy || null, hevy: hevyPayload(w, uid) });
      }
      if (POST && p === '/api/hevy/disconnect') {
        const b = await readJson(req);
        app.deleteSecret(uid, 'hevy');
        forgetHevy(w.db, { keepData: b.keepData !== false });
        changed(uid, ['me', 'workouts']);
        return send(res, 200, hevyPayload(w, uid));
      }
      if (POST && p === '/api/hevy/templates') {
        const api = hevyMeta(w.db).connected ? hevyApiFor(uid) : null;
        if (!api) throw err('Connect Hevy first: a new exercise is made in your Hevy library.', 409, 'needs_hevy');
        const b = await readJson(req);
        try {
          const t = await createTemplate({ db: w.db, api, title: b.title, muscle: b.muscle, equipment: ['none', 'barbell', 'dumbbell', 'kettlebell', 'machine', 'plate', 'resistance_band', 'suspension', 'other'].includes(b.equipment) ? b.equipment : 'other', type: b.type || 'weight_reps', now: now() });
          return send(res, 200, { exercise: { name: t.title, templateId: t.id, muscle: t.primary, equipment: t.equipment, type: t.type, custom: true } });
        } catch (e) { if (e.expose) throw e; throw err(e.code === 'hevy_limit' ? e.message : `Hevy did not make the exercise: ${e.message}`, e.code === 'hevy_limit' ? 409 : 502, e.code === 'hevy_limit' ? 'conflict' : 'upstream'); }
      }
      if (GET && p === '/api/hevy/routines') return send(res, 200, { routines: w.db.hevyRoutines() });
      if (GET && (mm = /^\/api\/hevy\/routines\/([A-Za-z0-9_-]{1,80})$/.exec(p))) {
        const r = w.db.hevyRoutine(mm[1]);
        if (!r) throw err('There is no such routine.', 404);
        return send(res, 200, { routine: r });
      }
      if (POST && p === '/api/hevy/routines') {
        const api = hevyMeta(w.db).connected ? hevyApiFor(uid) : null;
        if (!api) throw err('Connect Hevy first.', 409, 'needs_hevy');
        const b = await readJson(req);
        const r = ownWorkout(w, b.workoutId);
        try {
          const made = await saveRoutine({ db: w.db, api, workoutId: r.id, title: b.title, now: now() });
          syncExtras(uid, w, { force: true, only: 'hevy' }).catch(() => {});
          return send(res, 200, { routine: made });
        } catch (e) { if (e.expose) throw e; throw err(e.code === 'hevy_limit' ? e.message : `Hevy did not save the routine: ${e.message}`, e.code === 'hevy_limit' ? 409 : 502, e.code === 'hevy_limit' ? 'conflict' : 'upstream'); }
      }

      /* ── Strava ── */

      if (GET && p === '/api/strava') return send(res, 200, stravaPayload(w, uid));
      if (m === 'PATCH' && p === '/api/strava/settings') {
        const b = await readJson(req);
        setStravaMeta(w.db, { settings: { ...stravaMeta(w.db).settings, ...cleanSwitches(b, STRAVA_DEFAULTS) } });
        changed(uid, ['me']);
        return send(res, 200, stravaPayload(w, uid));
      }
      if (POST && p === '/api/strava/sync') {
        if (!app.secretRow(uid, 'strava')) throw err('Connect Strava first.', 409, 'needs_strava');
        throttle(`stravasync:${uid}`, 60_000 / loose, 'Strava was read less than a minute ago.');
        const r = await syncExtras(uid, w, { force: true, only: 'strava' });
        return send(res, 200, { result: r.strava || null, strava: stravaPayload(w, uid) });
      }
      if (POST && p === '/api/strava/disconnect') {
        const api = stravaApiFor(uid);
        if (api) await api.deauthorize();
        const ath = stravaMeta(w.db).athlete?.id;
        if (ath) setAthlete(ath, null);
        app.deleteSecret(uid, 'strava');
        setStravaMeta(w.db, { athlete: null, lost: null, lastError: null, cursor: null, connectedAt: null });
        changed(uid, ['me']);
        return send(res, 200, stravaPayload(w, uid));
      }

      /* ── Garmin ── */

      if (GET && p === '/api/garmin') return send(res, 200, garminPayload(w, uid));
      if (POST && p === '/api/garmin/connect') {
        limiter.check(`garminkey:${uid}`, 10 * loose, 600_000);
        limiter.add(`garminkey:${uid}`, 600_000);
        const b = await readJson(req);
        const key = String(b.key || '').trim().replace(/^ApiKey\s+/i, '');
        if (!keyShape(key)) throw err('That does not look like a Garmin key. Copy the whole key from Garmin Connect (Settings, Personal API key) and paste it here.', 400, 'bad_key');
        const keyDays = b.keyDays === undefined || b.keyDays === null || b.keyDays === '' ? null : Number(b.keyDays);
        if (keyDays !== null && !KEY_DAYS.includes(keyDays)) throw err(`keyDays must be one of ${KEY_DAYS.join(', ')}.`);
        const backfill = b.backfill === undefined || b.backfill === null || b.backfill === '' ? null : Number(b.backfill);
        if (backfill !== null && !BACKFILL_CHOICES.includes(backfill)) throw err(`backfill must be one of ${BACKFILL_CHOICES.join(', ')} days.`);
        try { await connectGarmin(uid, w, key, { keyDays, backfill }); } catch (e) { throw garminErr(e); }
        scheduler.poke(uid);
        changed(uid, ['me']);
        // The first read starts now; the page hears when it is done.
        garminFirst(uid);
        return send(res, 200, garminPayload(w, uid));
      }
      if (m === 'PATCH' && p === '/api/garmin/settings') {
        const b = await readJson(req);
        const cur = garminMeta(w.db).settings;
        const next = { ...cur };
        if (b.prefer !== undefined) { if (!['garmin', 'google'].includes(b.prefer)) throw err('prefer must be garmin or google.'); next.prefer = b.prefer; }
        if (b.backfill !== undefined) { if (!BACKFILL_CHOICES.includes(Number(b.backfill))) throw err(`backfill must be one of ${BACKFILL_CHOICES.join(', ')} days.`); next.backfill = Number(b.backfill); }
        setGarminMeta(w.db, { settings: next });
        if (next.prefer !== cur.prefer && w.garminIn()) { w.merge(); await afterAccounts(uid, w); }
        if (next.backfill !== cur.backfill && garminOn(w, uid)) scheduler.poke(uid);
        changed(uid, ['me']);
        return send(res, 200, garminPayload(w, uid));
      }
      if (POST && p === '/api/garmin/sync') {
        if (!garminOn(w, uid)) throw err('Connect Garmin first.', 409, 'needs_garmin');
        throttle(`garminsync:${uid}`, 30_000 / loose, 'Garmin was read less than half a minute ago.');
        const r = await syncExtras(uid, w, { force: true, only: 'garmin' });
        if (r.garmin) await afterSync(uid, null);
        const g = r.garmin || null;
        return send(res, 200, { result: g && { ok: g.ok, code: g.code || null, message: g.ok ? null : g.message, days: g.days, nights: g.nights, activities: g.activities, weighIns: g.weighIns }, garmin: garminPayload(w, uid) });
      }
      if (POST && p === '/api/garmin/disconnect') {
        const b = await readJson(req);
        const keep = b.keepData !== false;
        app.deleteSecret(uid, 'garmin');
        garminTokens.delete(uid);
        setGarminMeta(w.db, { connected: false, kept: keep, lost: null, lastError: null, retryAt: null, failures: 0, keyExpiresAt: null, tokenExpiresAt: null, ...(keep ? {} : { backTo: null, lastSync: null, lastResult: null, connectedAt: null }) });
        w.dropGarmin({ keepData: keep });
        await afterAccounts(uid, w);
        changed(uid, ['me', 'data', 'workouts']);
        return send(res, 200, garminPayload(w, uid));
      }

      /* ── the Xiaomi scale ── */

      if (GET && p === '/api/xiaomi') return send(res, 200, xiaomiPayload(w, uid));
      if (POST && p === '/api/xiaomi/start') {
        if (qrJobs.get(uid)?.state === 'waiting') throttle(`xiaomiqr:${uid}`, 10_000 / loose, 'A code was made a moment ago.');
        const old = qrJobs.get(uid);
        if (old) old.cancelled = true;
        const f = xiaomiFetch || globalThis.fetch;
        let job;
        try {
          const q = await qrStart({ fetchImpl: f, now });
          job = { ...q, qr: await qrImage(q.qrUrl, { fetchImpl: f }), state: 'waiting', cancelled: false };
        } catch (e) { throw err(`Xiaomi did not give a sign-in code: ${e.message}`, 502, 'upstream'); }
        qrJobs.set(uid, job);
        runQr(uid, job).catch((e) => log(`xiaomi qr: ${e.message}`));
        return send(res, 200, xiaomiPayload(w, uid));
      }
      if (POST && p === '/api/xiaomi/cancel') {
        const job = qrJobs.get(uid);
        if (job) { job.cancelled = true; qrJobs.delete(uid); }
        return send(res, 200, xiaomiPayload(w, uid));
      }
      if (POST && p === '/api/xiaomi/profile') {
        if (!app.secretRow(uid, 'xiaomi')) throw err('Connect the scale first.', 409, 'needs_xiaomi');
        const b = await readJson(req);
        const id = String(b.profile ?? '');
        if (!Object.hasOwn(xiaomiMeta(w.db).profiles || {}, id)) throw err('That is not one of the people on this scale.', 400, 'bad_profile');
        // Someone else's weigh-ins, from an earlier pick, go: here and in Google.
        await scaleFromGoogle(w, dropOthers(w.db, id));
        setXiaomiMeta(w.db, { profile: id, cursor: null });
        const r = await syncExtras(uid, w, { force: true, only: 'xiaomi' });
        return send(res, 200, { result: r.xiaomi || null, xiaomi: xiaomiPayload(w, uid) });
      }
      if (m === 'PATCH' && p === '/api/xiaomi/settings') {
        const b = await readJson(req);
        setXiaomiMeta(w.db, { settings: { ...xiaomiMeta(w.db).settings, ...cleanSwitches(b, XIAOMI_DEFAULTS) } });
        changed(uid, ['me']);
        return send(res, 200, xiaomiPayload(w, uid));
      }
      if (POST && p === '/api/xiaomi/sync') {
        if (!app.secretRow(uid, 'xiaomi')) throw err('Connect the scale first.', 409, 'needs_xiaomi');
        throttle(`xiaomisync:${uid}`, 30_000 / loose, 'The scale was read less than half a minute ago.');
        const r = await syncExtras(uid, w, { force: true, only: 'xiaomi' });
        return send(res, 200, { result: r.xiaomi || null, xiaomi: xiaomiPayload(w, uid) });
      }
      if (POST && p === '/api/xiaomi/disconnect') {
        const b = await readJson(req);
        app.deleteSecret(uid, 'xiaomi');
        xiaomiSessions.delete(uid);
        qrJobs.delete(uid);
        forgetXiaomi(w.db, { keepData: b.keepData !== false });
        changed(uid, ['me', 'data']);
        return send(res, 200, xiaomiPayload(w, uid));
      }

      /* ── workouts ── */

      const listArgs = () => ({ limit: clamp(Math.round(Number(url.searchParams.get('limit')) || 40), 1, 100), before: url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null });
      /** A workout changed here: Google and Hevy hear of it now, not at the next sync. */
      const toHevySoon = () => { if (hevyMeta(w.db).connected) syncExtras(uid, w, { only: 'hevy' }).catch((e) => log(`hevy: ${e.message}`)); };
      const afterWorkout = async () => {
        w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
        toHevySoon();
        return send(res, 200, views.workoutsView(w, listArgs()));
      };
      if (GET && p === '/api/workouts') return send(res, 200, views.workoutsView(w, listArgs()));
      if (POST && p === '/api/workouts/import/hevy') {
        const text = (await readRaw(req, 5 * 1024 * 1024)).toString('utf8');
        if (!text.trim()) throw err('Send the Hevy CSV file as the request body.');
        const on = (k) => ['1', 'true', 'on', 'yes'].includes(String(url.searchParams.get(k) || '').toLowerCase());
        const out = importHevy({ db: w.db, text, tz: profile.tz, upload: on('upload'), dryRun: on('dryRun'), canWrite: w.google.connected() && w.google.granted(SCOPES.activityWrite), now: now() });
        if (!out.dryRun && (out.imported || out.merged)) {
          await publish(uid);
          changed(uid, ['workouts', 'social']);
          if (out.toUpload) w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
        }
        return send(res, 200, out);
      }
      if (POST && p === '/api/workouts/start') {
        const b = await readJson(req);
        const routine = b.routineId ? ownRoutine(String(b.routineId)) : null;
        const r = w.workouts.startNow(b.at);
        // Logged set by set: the routine's plan, or an empty one to fill in.
        if (routine || b.log) {
          r.draft = routine ? draftFrom(w.db, routine) : { routineId: null, routineTitle: null, exercises: [] };
          if (routine) { r.routineId = routine.id; r.title = routine.title; r.type = r.type || 'STRENGTH_TRAINING'; routine.lastUsed = now(); routine.uses = (routine.uses || 0) + 1; w.db.routinePut(routine); }
          r.updated = now();
          w.db.workoutPut(r);
        }
        changed(uid, ['workouts']);
        return send(res, 200, { ...views.workoutsView(w, listArgs()), started: String(r.id) });
      }
      if (POST && p === '/api/workouts/record') {
        // A route recorded with the phone's GPS (or sent whole by an app).
        const b = await readJson(req, 4 * 1024 * 1024);
        const type = routeType(b.type);
        const points = cleanPoints(b.points, { type });
        if (points.length < 2) throw err('The route has too few points. Was location allowed?');
        const start = Number.isFinite(Number(b.start)) ? Math.min(Number(b.start), points[0][0]) : points[0][0];
        const end = Number.isFinite(Number(b.end)) ? Math.max(Number(b.end), points.at(-1)[0]) : points.at(-1)[0];
        return send(res, 200, saveRouteIn(w, uid, { type, points, pauses: cleanPauses(b.pauses, start, end), start, end, title: b.title, notes: b.notes, source: 'recorded' }));
      }
      if (POST && p === '/api/workouts/import/gpx') {
        const text = (await readRaw(req, 8 * 1024 * 1024)).toString('utf8');
        const g = fromGpx(text);
        const type = ROUTE_TYPES[url.searchParams.get('type')] ? url.searchParams.get('type') : g.type;
        const points = cleanPoints(g.points, { type });
        if (points.length < 2) throw err('The GPX file has too few usable points.');
        return send(res, 200, saveRouteIn(w, uid, { type, points, pauses: cleanPauses(g.pauses, points[0][0], points.at(-1)[0]), start: points[0][0], end: points.at(-1)[0], title: g.title, source: 'gpx' }));
      }
      if (POST && p === '/api/workouts/log') {
        const b = await readJson(req);
        const ex = b.exercises !== undefined ? cleanExercises(b.exercises) : null;
        const r = w.workouts.logPast({ start: b.start, end: b.end, title: b.title, notes: b.notes, type: b.type });
        if (ex) w.db.putSets(r.id, ex);
        return afterWorkout();
      }
      if (POST && p === '/api/workouts/settings') {
        const b = await readJson(req);
        if (b.exerciseType !== undefined) {
          if (!EXERCISE_TYPES[b.exerciseType]) throw err(`exerciseType must be one of ${Object.keys(EXERCISE_TYPES).join(', ')}.`);
          w.db.setMeta('exerciseType', b.exerciseType);
        }
        const wants = b.enabled === true || b.enabled === 'true';
        if (wants && !views.detectionView(w).available) throw err(views.detectionView(w).reason, 409, 'conflict');
        const s = w.setDetection(b);
        app.patchProfile(uid, { detect: s.enabled });
        changed(uid, ['workouts']);
        return send(res, 200, views.workoutsView(w, listArgs()));
      }
      if (POST && p === '/api/workouts/check') {
        if (!w.anyConnected()) throw err('Connect Google Health first.', 409, 'needs_google');
        throttle(`check:${uid}`, 30_000 / loose, 'Checked less than 30 seconds ago.');
        await w.workouts.tick({ force: true });
        return send(res, 200, views.workoutsView(w, listArgs()));
      }
      if (GET && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})$/.exec(p))) return send(res, 200, await views.workoutDetail(w, mm[1]));
      if (m === 'PUT' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/draft$/.exec(p))) {
        // The set-by-set log of a workout in progress, saved as it goes.
        const b = await readJson(req, 512 * 1024);
        const r = ownWorkout(w, mm[1]);
        if (!['running', 'ongoing', 'review'].includes(r.status) && !r.draft) throw err('This workout is over: change its sets instead.', 409, 'conflict');
        r.draft = { routineId: r.draft?.routineId ?? r.routineId ?? null, routineTitle: r.draft?.routineTitle ?? null, exercises: cleanDraftExercises(b.exercises, { draft: true }), restUntil: Number.isFinite(Number(b.restUntil)) ? Number(b.restUntil) : null };
        r.updated = now();
        w.db.workoutPut(r);
        return send(res, 200, { ok: true, updatedAt: r.updated });
      }
      if (POST && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/routine$/.exec(p))) {
        // Which routine a workout was; with fill, its sets come from the
        // routine (when it has none yet), to be changed to what was done.
        const b = await readJson(req);
        const r = ownWorkout(w, mm[1]);
        const routine = b.routineId ? ownRoutine(String(b.routineId)) : null;
        r.routineId = routine?.id || null;
        if (routine && !r.title) r.title = routine.title;
        if (r.draft) r.draft = { ...r.draft, routineId: r.routineId };
        let filled = false;
        if (routine && b.fill && !w.db.setsOf(r.id).length) {
          if (r.draft && !r.draft.exercises?.length) r.draft = draftFrom(w.db, routine);
          else if (!r.draft) { w.db.putSets(r.id, setsOfDraft(draftFrom(w.db, routine), { keep: 'all' })); filled = true; }
        }
        r.updated = now();
        w.db.workoutPut(r);
        changed(uid, ['workouts']);
        if (filled) toHevySoon();
        return send(res, 200, await views.workoutDetail(w, r.id));
      }
      if (POST && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/(confirm|end|save|dismiss|retry)$/.exec(p))) {
        const b = await readJson(req);
        const id = ownWorkout(w, mm[1]).id;
        // Ending or saving a workout logged set by set: what was done
        // becomes its sets (only ticked ones, or every filled-in one), once
        // the end itself was accepted.
        const draft = (mm[2] === 'end' || mm[2] === 'save') ? w.workouts.get(id).draft : null;
        const settle = () => {
          if (!draft) return;
          const r = w.workouts.get(id);
          w.db.putSets(id, setsOfDraft(draft, { keep: b.keep === 'all' ? 'all' : 'done' }));
          delete r.draft;
          r.updated = now();
          w.db.workoutPut(r);
        };
        if (mm[2] === 'confirm') w.workouts.confirmStart(id, { start: b.start });
        else if (mm[2] === 'end') { w.workouts.end(id, b.at); settle(); }
        else if (mm[2] === 'save') { w.workouts.save(id, { start: b.start, end: b.end }); settle(); }
        else if (mm[2] === 'dismiss') w.workouts.dismiss(id);
        else { w.workouts.retry(id); await w.workouts.flush({ force: true }); }
        return afterWorkout();
      }
      if (m === 'PATCH' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})$/.exec(p))) {
        const b = await readJson(req);
        const r = ownWorkout(w, mm[1]);
        if (b.title !== undefined) r.title = b.title ? String(b.title).trim().slice(0, 80) : null;
        if (b.notes !== undefined) r.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
        if (b.type !== undefined) { if (b.type !== null && !validType(b.type)) throw err(`type must be one of ${Object.keys(EXERCISE_TYPES).join(', ')}, or another of Google Health's exercise types.`); r.type = b.type; }
        // What Google shows is the title and type: a saved point is patched.
        if (r.google?.state === 'saved' && r.google.by !== 'link' && (b.title !== undefined || b.type !== undefined)) r.google = { ...r.google, dirty: true };
        r.updated = now();
        w.db.workoutPut(r);
        changed(uid, ['workouts']);
        publish(uid, { announce: false }).catch(() => {});
        return afterWorkout();
      }
      if (m === 'PUT' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/sets$/.exec(p))) {
        const b = await readJson(req, 512 * 1024);
        const r = ownWorkout(w, mm[1]);
        const ex = cleanExercises(b.exercises);
        w.db.tx(() => { w.db.putSets(r.id, ex); r.updated = now(); w.db.workoutPut(r); });
        changed(uid, ['workouts']);
        toHevySoon();
        return send(res, 200, await views.workoutDetail(w, r.id));
      }
      if (m === 'DELETE' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})$/.exec(p))) {
        const gone = ownWorkout(w, mm[1]).id;
        await w.workouts.remove(gone);
        if (w.workouts.get(gone).status === 'deleted') w.db.trackDel(gone);
        return afterWorkout();
      }
      if (POST && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/route\/strava$/.exec(p))) {
        // A Strava activity opened before its whole route was read: read it now, if Strava's limit allows.
        const r = ownWorkout(w, mm[1]);
        const sapi = stravaApiFor(uid);
        if (!r.strava?.id || r.strava.own || !sapi) throw err('This workout has no Strava route to read.', 409, 'conflict');
        throttle(`stream:${uid}`, 5000 / loose, 'A route was read a moment ago.');
        if (!stravaBudget.room(10)) throw err('Strava\'s limit for this site is nearly used up. The route is read later on its own.', 429, 'rate_limited');
        try { await fetchStream({ db: w.db, api: sapi, r }); } catch (e) { throw err(`Strava did not give the route: ${e.message}`, 502, 'upstream'); }
        return send(res, 200, await views.workoutDetail(w, r.id));
      }
      /* ── routes (routelib.js): drawn or saved from a workout; private, or public for everyone ── */
      if (GET && p === '/api/routes') {
        const q = url.searchParams;
        const scope = q.get('scope') === 'public' ? 'public' : 'mine';
        let near = null;
        const nq = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(q.get('near') || '');
        if (nq) near = [Number(nq[1]), Number(nq[2])];
        // No place given: from where the person's newest route starts.
        if (!near) { const own = app.get('SELECT start_lat, start_lng FROM route WHERE user_id = ? ORDER BY created_ms DESC LIMIT 1', uid); if (own) near = [own.start_lat, own.start_lng]; }
        // No route of theirs: where their newest recorded run, walk or ride started.
        if (!near) near = w.db.trackLatestStart();
        return send(res, 200, { scope, near, sports: ROUTE_SPORTS, routes: listRoutes(app, uid, { scope, near, sport: q.get('sport') }) });
      }
      if (POST && p === '/api/routes') {
        const b = await readJson(req);
        let line = b.line; let source = 'drawn'; let sport = b.sport;
        if (b.workoutId !== undefined) {
          // From a workout's map: its track (recorded, GPX, Strava) or the route read from Google.
          const id = String(b.workoutId);
          let pts = null;
          if (id.startsWith('g-')) pts = w.db.meta(`route:${id}`)?.points || null;
          else { const r = ownWorkout(w, id); pts = w.db.trackGet(r.id)?.points || null; sport = sport || ({ WALKING: 'walk', HIKING: 'hike', BIKING: 'ride', MOUNTAIN_BIKE: 'ride' }[w.db.trackGet(r.id)?.type] || 'run'); }
          if (!pts?.length) throw err('That workout has no route to save. Open it once so its map is read, then try again.', 409, 'conflict');
          line = pts.map((q) => [q[1], q[2], q[3]]);
          source = 'workout';
        }
        const made = createRoute(app, uid, { title: b.title, sport, line, isPublic: b.public === true, source, trim: source === 'workout' && b.trim !== false, now: now() });
        return send(res, 201, made);
      }
      if ((mm = /^\/api\/routes\/(r_[0-9a-f]{12})(\/route\.gpx)?$/.exec(p))) {
        if (GET && mm[2]) {
          const g = routeGpx(app, uid, mm[1]);
          res.writeHead(200, { ...baseHeaders, 'content-type': 'application/gpx+xml; charset=utf-8', 'content-disposition': `attachment; filename="${g.name}"`, 'cache-control': 'no-store' });
          return res.end(g.body);
        }
        if (GET && !mm[2]) return send(res, 200, getRoute(app, uid, mm[1]));
        if (m === 'PATCH' && !mm[2]) { const b = await readJson(req); return send(res, 200, patchRoute(app, uid, mm[1], { title: b.title, sport: b.sport, isPublic: b.public, now: now() })); }
        if (m === 'DELETE' && !mm[2]) { deleteRoute(app, uid, mm[1]); return send(res, 200, { ok: true }); }
      }
      if (GET && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/(route\.gpx)$/.exec(p))) {
        const r = ownWorkout(w, mm[1]);
        const t = w.db.trackGet(r.id);
        if (!t) throw err('This workout has no route.', 404);
        const body = toGpx({ title: r.title, type: t.type, points: t.points, pauses: t.pauses });
        const name = `${String(r.title || 'route').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'route'}-${new Date(r.start).toISOString().slice(0, 10)}.gpx`;
        res.writeHead(200, { ...baseHeaders, 'content-type': 'application/gpx+xml; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
        return res.end(body);
      }

      /* ── summary and the OpenCode key ── */


      /* ── social ── */

      const scopeOf = () => {
        const scope = url.searchParams.get('scope') || 'friends';
        if (!social.SCOPES.includes(scope)) throw err(`scope must be one of ${social.SCOPES.join(', ')}.`);
        return scope;
      };
      if (GET && p === '/api/leaderboard') {
        const metric = url.searchParams.get('metric') || 'steps';
        const period = url.searchParams.get('period') || 'week';
        if (!social.METRICS[metric]) throw err(`metric must be one of ${Object.keys(social.METRICS).join(', ')}.`);
        if (!social.PERIODS[period]) throw err(`period must be one of ${Object.keys(social.PERIODS).join(', ')}.`);
        return send(res, 200, social.leaderboard(app, { metric, period, scope: scopeOf(), viewerId: uid, now: now() }));
      }
      if (GET && p === '/api/boards') {
        const period = url.searchParams.get('period') || 'week';
        if (!social.PERIODS[period]) throw err(`period must be one of ${Object.keys(social.PERIODS).join(', ')}.`);
        return send(res, 200, social.boards(app, { period, scope: scopeOf(), viewerId: uid, now: now() }));
      }
      if (GET && p === '/api/people') return send(res, 200, { people: social.people(app, uid) });
      if (GET && p === '/api/compare') {
        const period = url.searchParams.get('period') || 'week';
        if (!social.PERIODS[period]) throw err(`period must be one of ${Object.keys(social.PERIODS).join(', ')}.`);
        const out = social.compare(app, { viewerId: uid, username: String(url.searchParams.get('with') || ''), period, now: now() });
        if (!out) throw err('There is no such profile.', 404);
        return send(res, 200, out);
      }

      /* ── friends ── */

      /** Send what a friends or feed call owes the other person, and answer the rest. */
      const told = (r) => {
        const { tell, ...rest } = r;
        if (tell) { const { userId, ...note } = tell; notifyUser(userId, note); changed(userId, ['social']); }
        return rest;
      };
      if (GET && p === '/api/friends') return send(res, 200, friends.friendsView(app, uid));
      if (POST && (mm = /^\/api\/friends\/(request|accept|decline|remove)$/.exec(p))) {
        const b = await readJson(req);
        if (typeof b.username !== 'string' || !b.username.trim()) throw err('username is required.');
        if (mm[1] === 'request') { limiter.check(`friend:${uid}`, 30 * loose, 3_600_000); limiter.add(`friend:${uid}`, 3_600_000); }
        const out = mm[1] === 'request' ? friends.request(app, uid, b.username, now())
          : mm[1] === 'accept' ? friends.accept(app, uid, b.username, now())
            : mm[1] === 'decline' ? friends.decline(app, uid, b.username) : friends.remove(app, uid, b.username);
        const other = app.profileByName(b.username.trim());
        if (other && mm[1] !== 'request' && mm[1] !== 'accept') changed(other.userId, ['social']);
        changed(uid, ['social', 'me']);
        return send(res, 200, told(out));
      }

      /* ── the feed ── */

      // A workout's post: whether friends see it, and Share / Stop sharing (feed.js).
      if ((GET || m === 'PUT') && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/post$/.exec(p))) {
        const wid = mm[1];
        const workoutUid = wid.startsWith('g-') ? wid : ownWorkout(w, wid).uid;
        if (m === 'PUT') {
          const b = await readJson(req);
          const cur = feed.postOfWorkout(app, { viewerId: uid, workoutUid });
          if (!cur.post) throw err(cur.reason || 'This workout cannot be posted.', 409);
          feed.patchPost(app, { viewerId: uid, id: cur.post.id, patch: { shared: b.shared, caption: b.caption } });
          changed(uid, ['social']);
        }
        return send(res, 200, feed.postOfWorkout(app, { viewerId: uid, workoutUid }));
      }
      if (GET && p === '/api/feed') {
        const q = url.searchParams;
        return send(res, 200, feed.feed(app, { viewerId: uid, before: q.get('before'), limit: q.get('limit') || 20 }));
      }
      if ((mm = /^\/api\/posts\/([A-Za-z0-9_-]{12})(\/cheer|\/comments(?:\/([A-Za-z0-9_]{1,40}))?)?$/.exec(p))) {
        const id = mm[1];
        /** Cheers and comments: a fixed number per person in ten minutes. */
        const slow = () => { limiter.check(`feed:${uid}`, 60 * loose, 600_000); limiter.add(`feed:${uid}`, 600_000); };
        if (GET && !mm[2]) return send(res, 200, feed.post(app, { viewerId: uid, id }));
        if (m === 'PATCH' && !mm[2]) {
          const b = await readJson(req);
          const out = feed.patchPost(app, { viewerId: uid, id, patch: { caption: b.caption, hidden: b.hidden, shared: b.shared, media: b.media } });
          changed(uid, ['social']);
          return send(res, 200, out);
        }
        if (POST && mm[2] === '/cheer') { slow(); return send(res, 200, told(feed.cheer(app, { viewerId: uid, id, now: now() }))); }
        if (POST && mm[2] === '/comments') {
          slow();
          const b = await readJson(req);
          return send(res, 200, told(feed.addComment(app, { viewerId: uid, id, text: b.text, now: now() })).comment);
        }
        if (m === 'DELETE' && mm[3]) return send(res, 200, feed.deleteComment(app, { viewerId: uid, id, commentId: mm[3] }));
        throw err('Not found', 404);
      }

      /* ── notifications ── */

      if (GET && p === '/api/push') return send(res, 200, pushPayload(uid));
      if (POST && p === '/api/push/subscribe') {
        const b = await readJson(req);
        const deviceId = notifier.subscribe(uid, b.subscription, b.label);
        changed(uid, ['push', 'me']);
        return send(res, 200, { ...pushPayload(uid), deviceId });
      }
      if (POST && p === '/api/push/unsubscribe') { const b = await readJson(req); notifier.removeEndpoint(uid, b.endpoint); changed(uid, ['push', 'me']); return send(res, 200, pushPayload(uid)); }
      if (m === 'PATCH' && (mm = /^\/api\/push\/devices\/([A-Za-z0-9_]{1,40})$/.exec(p))) { notifier.patchDevice(uid, mm[1], await readJson(req)); changed(uid, ['push']); return send(res, 200, pushPayload(uid)); }
      if (m === 'DELETE' && (mm = /^\/api\/push\/devices\/([A-Za-z0-9_]{1,40})$/.exec(p))) {
        if (!notifier.removeDevice(uid, mm[1])) throw err('No such device.', 404);
        changed(uid, ['push', 'me']);
        return send(res, 200, pushPayload(uid));
      }
      if (m === 'PUT' && p === '/api/push/prefs') {
        const b = await readJson(req);
        const t = (v, what) => { if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v))) throw err(`${what} must be a time like 07:30.`); return v; };
        const patch = {};
        if (b.types !== undefined) patch.types = b.types;
        if (b.quiet !== undefined) patch.quiet = b.quiet === null ? null : { from: t(b.quiet?.from, 'quiet.from'), to: t(b.quiet?.to, 'quiet.to') };
        if (b.morningAt !== undefined) patch.morningAt = t(b.morningAt, 'morningAt');
        if (b.weeklyAt !== undefined) {
          if (!['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(b.weeklyAt?.day)) throw err('weeklyAt.day must be one of sun, mon, tue, wed, thu, fri, sat.');
          patch.weeklyAt = { day: b.weeklyAt.day, time: t(b.weeklyAt.time, 'weeklyAt.time') };
        }
        if (b.sitting !== undefined) {
          const x = b.sitting;
          if (!x || typeof x !== 'object' || Array.isArray(x)) throw err('sitting must be an object with any of from, to, days, threshold.');
          const cur = w.alerts.prefs().sitting;
          const out = {};
          if (x.from !== undefined) out.from = t(x.from, 'sitting.from');
          if (x.to !== undefined) out.to = t(x.to, 'sitting.to');
          if (toMin(out.from ?? cur.from) >= toMin(out.to ?? cur.to)) throw err('sitting.to must be later than sitting.from.');
          if (x.days !== undefined) {
            if (!Array.isArray(x.days) || !x.days.length || x.days.some((d) => !DAYS.includes(d))) throw err('sitting.days must be a list with at least one of sun, mon, tue, wed, thu, fri, sat.');
            out.days = DAYS.filter((d) => x.days.includes(d));
          }
          if (x.threshold !== undefined) {
            const { min, max } = SITTING_LIMITS.threshold;
            if (!Number.isInteger(x.threshold) || x.threshold < min || x.threshold > max) throw err(`sitting.threshold must be a whole number of steps from ${min} to ${max}.`);
            out.threshold = x.threshold;
          }
          patch.sitting = out;
        }
        if (patch.types !== undefined && (typeof patch.types !== 'object' || patch.types === null || Array.isArray(patch.types))) throw err('types must be an object of switches.');
        // A type the person's device cannot carry cannot be switched on.
        const was = w.alerts.prefs().types;
        if (patch.types?.sitting === true && !was.sitting && w.anyConnected() && w.notifyAvailability().sitting.available && w.db.meta('stepsIntraday', null)?.ok !== true) {
          // Steps through the day, or only a daily total? Ask Google once.
          // If it cannot be asked right now, the benefit of the doubt.
          await w.probeIntraday().catch(() => null);
        }
        const avail = w.notifyAvailability();
        for (const id of ['illness', 'sitting']) {
          if (patch.types?.[id] === true && !was[id] && !avail[id].available) throw err(avail[id].reason, 409, 'conflict');
        }
        w.alerts.setPrefs(patch);
        syncNudge(uid, w);
        changed(uid, ['push']);
        return send(res, 200, pushPayload(uid));
      }
      if (POST && p === '/api/push/test') { const b = await readJson(req); return send(res, 200, await notifier.test(uid, b.deviceId || null)); }

      /* ── the console-module link, the person's side ── */

      if (GET && p === '/api/link') return send(res, 200, linkPayload(uid));
      if (POST && p === '/api/link/keys') {
        const b = await readJson(req);
        const made = link.createKey(app, uid, b.label, now());
        changed(uid, ['link', 'me']);
        // The one time the key itself is in a reply.
        return send(res, 200, { ...linkPayload(uid), key: made.key });
      }
      if (m === 'DELETE' && (mm = /^\/api\/link\/keys\/([A-Za-z0-9_]{1,40})$/.exec(p))) {
        if (!link.deleteKey(app, uid, mm[1])) throw err('No such key.', 404);
        changed(uid, ['link', 'me']);
        return send(res, 200, linkPayload(uid));
      }

      /* ── account and data ── */

      if (GET && p === '/api/export') {
        const stem = `health-${profile.username.replace(/[^A-Za-z0-9_-]/g, '_')}-${new Date(now()).toISOString().slice(0, 10)}`;
        const body = views.exportView(w, { profile, app, me: mePayload(user, profile) });
        if ((url.searchParams.get('format') || '').toLowerCase() === 'csv') {
          // daily is { date: { metric: value } } — pivot to one row per day,
          // every metric that appears anywhere becoming a column.
          const daily = body.daily || {};
          const dates = Object.keys(daily).sort();
          const cols = ['date', ...[...new Set(dates.flatMap((d) => Object.keys(daily[d])))].sort()];
          const cell = (v) => (v == null || v === '' ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
          const csv = [cols.join(','), ...dates.map((d) => [d, ...cols.slice(1).map((c) => daily[d][c])].map(cell).join(','))].join('\n') + '\n';
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${stem}.csv"`,
            'cache-control': 'no-store',
          });
          return res.end(csv);
        }
        return send(res, 200, JSON.stringify(body, null, 1), { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${stem}.json"` });
      }
      if (POST && p === '/api/google/disconnect') {
        await w.google.disconnect();
        app.patchProfile(uid, { googleState: googleStateOf(w), syncError: null });
        if (!w.anyConnected()) scheduler.forget(uid);
        changed(uid, ['me', 'data']);
        return me();
      }

      /* ── several Google accounts ── */

      if (GET && p === '/api/google/accounts') return send(res, 200, accountsPayload(w));
      if ((mm = /^\/api\/google\/accounts\/([a-z0-9]{1,12})(\/disconnect)?$/.exec(p)) && (((m === 'PATCH' || m === 'DELETE') && !mm[2]) || (POST && mm[2]))) {
        const id = mm[1];
        if (!w.accounts.has(id)) throw err('There is no such account.', 404);
        if (POST) await w.disconnectAccount(id);
        else if (m === 'DELETE') await w.removeAccount(id);
        else {
          const b = await readJson(req);
          if (b.label !== undefined && typeof b.label !== 'string') throw err('label must be text.');
          if (b.include !== undefined && typeof b.include !== 'boolean') throw err('include must be true or false.');
          if (b.primary !== undefined && b.primary !== true) throw err('primary can only be set to true: make another account the main one instead.');
          w.patchAccount(id, b);
        }
        await afterAccounts(uid, w);
        return send(res, 200, accountsPayload(w));
      }
      if (m === 'PATCH' && p === '/api/google/merge') {
        const b = await readJson(req);
        const ids = w.accountList().map((a) => a.id);
        if (b.activity !== undefined && !ACTIVITY_MODES.includes(b.activity)) throw err(`activity must be one of ${ACTIVITY_MODES.join(', ')}.`);
        if (b.workouts !== undefined && !WORKOUT_MODES.includes(b.workouts)) throw err(`workouts must be one of ${WORKOUT_MODES.join(', ')}.`);
        if (b.overnight !== undefined && b.overnight !== 'auto' && !ids.includes(b.overnight)) throw err('overnight must be auto or one of your accounts.');
        w.setMergeRules({ activity: b.activity, workouts: b.workouts, overnight: b.overnight });
        w.merge();
        await afterAccounts(uid, w);
        // A rule that needs Google's quarter-hours starts reading them now.
        if (b.activity === 'auto') scheduler.poke(uid);
        return send(res, 200, accountsPayload(w));
      }
      if (POST && p === '/api/account/delete-data') {
        const b = await readJson(req);
        if (String(b.confirm || '').toLowerCase() !== profile.username.toLowerCase()) throw err('Type your username to confirm.');
        // Google first, while the token is still here to revoke.
        await w.google.disconnect().catch(() => {});
        garminTokens.delete(uid);
        scheduler.forget(uid);
        live.forget(uid);
        // After this request lets go of the world, it and the folder go.
        setImmediate(() => { try { worlds.destroy(uid); } catch (e) { log(`delete data: ${e.message}`); } });
        app.deleteUser(uid);
        media.forgetUser(uid);
        changed(uid, ['me', 'data', 'workouts', 'social', 'push', 'link']);
        return send(res, 200, { ok: true });
      }

      throw err('Not found', 404);
    });
  }

  /* ── the handler ────────────────────────────────────────────────── */

  async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'Bad request', code: 'bad_request' }); }
    const p = url.pathname;
    const api = p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/demo/') || p.startsWith('/media/');
    try {
      if (!api) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Not allowed', code: 'bad_request' });
        return await serveStatic(req, res, p);
      }
      return await route(req, res, url);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* closed */ } return undefined; }
      // Errors made here, or by the workout machine and friends (which set a
      // status), are meant for the person. Google's own failures become a
      // sentence about Google. Anything else is a bug: logged, not shown.
      let status = Number(e.status) || 0;
      let code = e.code && typeof e.code === 'string' && /^[a-z_]+$/.test(e.code) ? e.code : null;
      let message = e.message;
      if (e.code === 'needs_auth') { status = 409; code = 'needs_google'; message = 'Google Health needs reconnecting. Open Settings, Connections.'; }
      else if (e.code === 'rate_limited' && !e.expose) { status = 502; code = 'upstream'; message = 'Google asked us to slow down. Try again in a few minutes.'; }
      else if (e.code === 'network' || e.constructor?.name === 'ApiError') {
        if (status === 403) { status = 409; code = 'needs_scope'; message = 'Google refused this. Reconnect and allow the permission it needs.'; }
        else { status = 502; code = 'upstream'; message = `Google Health did not accept that: ${String(e.message).slice(0, 200)}`; }
      } else if (!(status >= 400 && status < 600)) {
        log(`error ${req.method} ${p}: ${e.stack || e.message}`);
        status = 500; code = 'server_error'; message = 'Something went wrong on the server. Try again.';
      }
      code ||= STATUS_CODE[status] || 'server_error';
      const headers = status === 429 && e.detail?.retryAfter ? { 'retry-after': String(e.detail.retryAfter) } : {};
      return send(res, status, { error: message, code, ...(e.detail !== undefined ? { detail: e.detail } : {}) }, headers);
    }
  }

  function close() {
    scheduler.stop();
    for (const j of qrJobs.values()) j.cancelled = true;
    live.close();
    for (const set of streams.values()) for (const res of set) { try { res.end(); } catch { /* closed */ } }
    worlds.closeAll();
    media.close();
    app.close();
  }

  // Strava's webhook subscription, checked once the server is up (not in tests or the demo).
  if (config.scheduler && !config.demo && config.strava.verifyToken) setTimeout(() => { ensureStravaWebhook().then((r) => { if (!r.ok) log(`strava webhook: ${r.reason}`); }); }, 15_000).unref?.();

  /** Connect Garmin for a person as the route does, and wait for the first read (the demo seed). */
  const connectGarminFor = (userId, key, o = {}) => worlds.hold(userId, (w) => connectGarmin(userId, w, key, o)).then(() => garminFirst(userId));
  return { handler, app, media, accounts, worlds, scheduler, notifier, live, vault, afterSync, syncUser, syncExtras, publish, ensureProfile, oauth, close, config, food, stravaBudget, connectGarmin: connectGarminFor };
}
