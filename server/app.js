/* ============================================================
   health.ojee.net — the application: every route, wired to one
   person's world or to the public tables.

   createApp() builds it from its parts and returns the request
   handler, so the tests and the demo run the very same code with a
   fake Google and a fake push service handed in.

   The shape of a request:
     1. headers every reply gets (CSP and friends);
     2. static files, unless the path is /api/* or /auth/*;
     3. who is asking: rep.'s session cookie, or a link key;
     4. a state-changing request must come from this site (Origin);
     5. the route, which gets the signed-in person's own world and
        nobody else's.

   docs/API.md is the contract. Keep the two in step.
   ============================================================ */

import { normWorkHours } from './workhours.js';
import { movedFrom, RETIRED_WORKER } from './legacyhost.js';
import { join, extname, normalize, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { VERSION } from './config.js';
import { openAppDb, ONBOARDING, PRIVACY_DEFAULT, UNIT_CHOICES, normUnits, unitSystem } from './appdb.js';
import { AUDIENCES, KINDS, audienceOf, lensOf, circleWide, presenceOn } from './audience.js';
import { Accounts, SESSION_COOKIE, OLD_SESSION_COOKIE, SESSION_MS } from './accounts.js';
import { Vault } from './secrets.js';
import { Worlds, UserWorld, validUserId } from './worlds.js';
import { Scheduler } from './scheduler.js';
import { Notifier, TYPES } from './notify.js';
import { DAYS, SITTING_LIMITS, sittingActive, toMin } from './core/alerts.js';
import { computeCaps, readCaps } from './caps.js';
import * as social from './social.js';
import * as friends from './friends.js';
import * as feed from './feed.js';
import * as safety from './safety.js';
import { CONSENT_KINDS, consentView, normAiAllow, withConsent, POLICY_VERSION } from './consent.js';
import * as link from './link.js';
import * as apikeys from './apikeys.js';
import { createMcp } from './mcp.js';
import { createDevDocs } from './devdocs.js';
import { openapi } from './openapi.js';
import { MediaStore, CHUNK as MEDIA_CHUNK, LIMITS as MEDIA_LIMITS } from './media.js';
import { findTools, toolsWork } from './mediaproc.js';
import { Live, parseSamples, cleanSource } from './live.js';
import * as views from './views.js';
import { syncExercises } from './hevyexercises.js';
import { adoptMirrorRow } from './adopt.js';
import { importHevy } from './hevy.js';
import { MUSCLES, muscleOf } from './muscles.js';
import { pkce, SCOPES, ENDPOINTS, cleanGroups, groupById, GROUP_IDS, build as googleBody, LOCATION_SCOPE } from './core/google.js';
import { sportOf, mirrorId, unified, sessionType, isGym, sessionDistance, publicDistance } from './history.js';
import { applyHc, hcMeta, setHcMeta } from './hcsync.js';
import { XiaomiClient, qrStart, qrPoll, qrImage } from './xiaomi.js';
import { syncXiaomi, xiaomiView, xiaomiMeta, setXiaomiMeta, forgetXiaomi, dropOthers, XIAOMI_DEFAULTS } from './xiaomisync.js';
import { flushEntries, addEntry, editEntry, removeEntry, SENSITIVE_KINDS, settleLoggedSleep } from './core/entries.js';
import { HevyApi } from './hevyapi.js';
import { GarminApi, GarminError, keyShape, jwtExp, KEY_DAYS } from './garmin.js';
import { syncGarmin, garminView, garminMeta, setGarminMeta, BACKFILL_CHOICES } from './garminsync.js';
import { syncHevy, hevyView, hevyMeta, setHevyMeta, forgetHevy, exercisePicker, lastSetsOf, createTemplate, saveRoutine, HEVY_DEFAULTS } from './hevysync.js';
import { fetchStream } from './strava.js';
import { StravaApi, StravaBudget, stravaExchange, syncStrava, purgeStrava, expireStrava, refreshActivity, STRAVA_KEEP_MS, stravaView, stravaMeta, setStravaMeta, STRAVA_AUTH, STRAVA_API, STRAVA_SCOPES, STRAVA_DEFAULTS, routeShape } from './strava.js';
import { WithingsApi, withingsExchange, syncWithings, withingsView, withingsMeta, setWithingsMeta, forgetWithings, notifyToken, notifySigned, WITHINGS_AUTH, WITHINGS_SCOPES } from './withings.js';
import { WhoopApi, WhoopBudget, whoopExchange, whoopSigned, syncWhoop, whoopView, whoopMeta, setWhoopMeta, WHOOP_AUTH, WHOOP_SCOPES } from './whoop.js';
import { FoodLookup, ownFoods, commonFoods } from './food.js';
import { MusicLookup, musicView } from './music.js';
import { Weather, pointOf } from './weather.js';
import { logView } from './loghub.js';
import { browseView, metricView, entryView, setPin, setShown, storeDerived, bodyPerson } from './browse.js';
import { ACTIVITY_MODES, WORKOUT_MODES } from './core/merge.js';
import { EXERCISE_TYPES, validType, titleFor, typedDistance } from './core/workouts.js';
import { Presence, workoutNow } from './presence.js';
import { Fcm, loadServiceAccount } from './fcm.js';
import { Apns, loadApnsKey } from './apns.js';
import { clamp, validTz, utcOffsetSec, sleepFor } from './core/util.js';
import { setCustomSource, librarySearch, libById, libByName, libMatch, libView, libSize, ExerciseImages, EQUIPMENT, LIB_MUSCLES, LIBRARY_SOURCE } from './library.js';
import { forgetHevyRoutine } from './hevyroutines.js';
import { cleanRoutine, routineSummary, draftFrom, setsOfDraft, exercisesFromSets, differences, cleanExercises as cleanDraftExercises, previousOf, STARTERS, EX_TYPES, withDumbbell, isDumbbell, exerciseTypeOf } from './routines.js';
import { cleanPoints, cleanPauses, trackStats, routeType, ROUTE_TYPES, toGpx, fromGpx, despike, MEASURE_V } from './tracks.js';
import { linkOf, linkOff, linkOpen, linkPath } from './sharelink.js';
import { createRoute, getRoute, listRoutes, patchRoute, copyRoute, deleteRoute, routeGpx, wayOf, SPORTS as ROUTE_SPORTS } from './routelib.js';
import { TileCache } from './tiles.js';
import { RasterRenderer } from './raster.js';
import { Basemap } from './basemap.js';
import { findTry, markedTry, passesStart, fillAlong } from './routetry.js';
import { medalIndex, medalsFor, achievements as achievementsList, markSeen, tally, bestTimes } from './medals.js';
import { theirBests, bestsBoard } from './besttimes.js';
import { Writer } from './core/writer.js';
import { AiThreads, jobOf } from './aithread.js';
import { workoutAnalysis } from './aianalysis.js';
import { OWN_AI, OwnWriter, checkOwnAi, openRouterAuthUrl, openRouterExchange } from './ownai.js';
import { metricById } from './catalog.js';
import { AiJobs, TOPICS as AI_TOPICS, briefing as aiBriefing, prompt as aiPrompt, workoutDetail as aiWorkout, metricDetail as aiMetric, nightDetail as aiNight, metricKind as aiMetricKind, answerCache, aiWorkoutOk } from './ai.js';
import { addDays as addDaysU, today as todayU } from './core/util.js';
import { napsOn, napsReport } from './core/naps.js';

import { cexCreate, cexPatch, cexGet, cexView, cexVisible, cexAsLib, cexSearch, cexDelete, CexPhotos, syncShared, browseShared, sharedGet, sharedForCopy } from './sharedlib.js';
import * as circles from './circles.js';
import * as challenges from './challenges.js';
import { ratingOf, ladder } from './rating.js';
import * as signin from './signin.js';

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
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "frame-src https://open.spotify.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
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
 * @param {Function} [o.googleFetch]  (userId, accountId) => fetch for that person's Google calls
 * @param {object} [o.googleEndpoints]
 * @param {Function} [o.opencodeFetch]  fetch for the OpenCode server that writes AI answers
 * @param {Function} [o.pushSend]
 */
export function createApp({ config, googleFetch = null, googleEndpoints = ENDPOINTS, pushSend = null, fcm = undefined, apns = undefined, now = () => Date.now(), log = (m) => console.warn(`  ${m}`), demoConnect = null,
  hevyFetch = null, stravaFetch = null, stravaUrls = null, foodFetch = null, foodUrls = null, musicFetch = null, musicUrls = null, weatherFetch = null, demoStrava = null, xiaomiFetch = null, xiaomiGapMs = 1000, garminFetch = null, garminGapMs = null, whoopFetch = null, whoopUrls = null, withingsFetch = null, withingsUrls = null, libraryFetch = null, tileFetch = null, opencodeFetch = null, stravaPhotoFetch = null, ownAiFetch = null, signinFetch = null, signinUrls = null, demoSignin = null }) {
  const startedAt = now();
  const app = openAppDb(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'app.sqlite'));
  // The reviewers' accounts, walled off from everyone else (safety.js); what already crossed goes.
  safety.setWalled(app, config.signin?.walled || []);
  { const n = safety.clearWall(app); if (n) log(`reviewer wall: ${n} friendship or circle row(s) across it removed`); }
  // rep.'s own logins and sessions, in app.sqlite (accounts.js).
  const accounts = new Accounts({ app, cookieDomain: config.cookieDomain, secure: config.cookieSecure, now });
  const vault = new Vault(config.appSecret);
  const limiter = new Limiter(now);
  // Sign in with Google or Apple (signin.js): what is in flight, and each provider's keys.
  const flows = new signin.Flows(now);
  const siUrls = { ...signin.SIGNIN_URLS, ...(signinUrls || {}) };
  const siFetch = signinFetch || globalThis.fetch;
  const googleKeys = new signin.Jwks({ url: siUrls.googleJwks, fetchImpl: siFetch, now });
  const appleKeys = new signin.Jwks({ url: siUrls.appleJwks, fetchImpl: siFetch, now });
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
  // The vector basemap MapLibre draws (basemap.js): OpenFreeMap's styles, tiles, fonts and sprite, through here.
  const basemap = new Basemap({ dir: onDisk ? join(config.dataDir, 'basemap') : null, fetchImpl: tileFetch || globalThis.fetch });
  // Tiles for devices without WebGL (map-raster.js): drawn here from the basemap when RASTER_RENDER=1 (raster.js), else OpenStreetMap's.
  const raster = config.rasterRender ? new RasterRenderer({ basemap, log }) : null;
  const tiles = new TileCache({ dir: onDisk ? join(config.dataDir, 'tiles') : null, fetchImpl: tileFetch || globalThis.fetch, renderer: raster });
  // Photos and videos on posts, and profile photos (media.js): files under data/media/.
  const ffTools = config.videoClean === false ? null : findTools();
  // A video encoded again after its upload answered: on its post now (or gone), so the feed is read again.
  const media = new MediaStore({ app, dir: onDisk ? join(config.dataDir, 'media') : null, now, log, tools: ffTools, onReady: (r) => changed(r.user_id, ['social']) });
  if (ffTools && onDisk) toolsWork(ffTools).then((ok) => log(ok ? `media: ffmpeg at ${ffTools.ffmpeg}` : `media: NO ffmpeg (${ffTools.ffmpeg}): every video upload and HEIC photo will be refused. Set FFMPEG/FFPROBE.`));
  const loose = config.demo ? 20 : 1;   // the demo is hammered by tests and people trying things

  /* ── open tabs (SSE) ────────────────────────────────────────────── */

  const streams = new Map();   // userId -> Set<res>
  const sse = (userId, event, data) => {
    for (const res of streams.get(String(userId)) || []) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } }
  };
  const changed = (userId, what) => sse(userId, 'changed', { what, at: now() });

  /* Live heart rate: in memory, one person's readings to that person's own tabs. */
  const live = new Live({ now, emit: (userId, data) => sse(userId, 'live', data) });

  /* Who is here now, and who is working out (presence.js): in memory too. */
  const presence = new Presence({ now });
  const presenceSweep = setInterval(() => presence.sweep(), 10 * 60_000);
  presenceSweep.unref?.();
  // Sessions past their 30 days (accounts.js), cleared out now and then.
  const sessionSweep = setInterval(() => { try { accounts.sweep(); } catch { /* next time */ } }, 6 * 3_600_000);
  sessionSweep.unref?.();
  // The demo: a few people about, so People's Now strip has something in it.
  if (config.demo) {
    const t0 = now();
    const idOf = (u) => app.profileByName(u)?.userId;
    const demoNow = () => {
      const t = now();
      const mira = idOf('mira'); const lena = idOf('lena'); const noor = idOf('noor'); const sam = idOf('sam');
      if (mira) {
        // A loop of Hyde Park, as far as she has run.
        const m = Math.round(3100 + ((t - t0) / 1000) * 2.9);
        const line = [];
        for (let d = 0; d <= m; d += 25) { const k = (d / 4200) * 2 * Math.PI; line.push([51.5075 + 0.0042 * Math.sin(k) + 0.0004 * Math.sin(k * 5), -0.1650 + 0.0098 * Math.cos(k) - 0.0098 + 0.0005 * Math.sin(k * 3)]); }
        presence.beat(mira, { route: { type: 'RUNNING', start: t0 - 18 * 60_000, m, ms: t - t0 + 17 * 60_000, line } });
      }
      if (lena) {
        presence.beat(lena);
        presence.setWorkout(lena, { start: t0 - 34 * 60_000, title: 'Push day', type: 'STRENGTH_TRAINING', doing: { name: 'Bench Press (Barbell)', set: 3, of: 4 }, exercises: 5, sets: 9, restUntil: null,
          list: [{ name: 'Incline Dumbbell Press', of: 3, done: 3 }, { name: 'Cable Fly', of: 3, done: 3 }, { name: 'Bench Press (Barbell)', of: 4, done: 2 }, { name: 'Overhead Press', of: 3, done: 0 }, { name: 'Triceps Pushdown', of: 3, done: 0 }] });
        live.push(lena, [{ bpm: 118 + Math.round(8 * Math.sin(t / 9000)), t }], 'pulse');
      }
      for (const u of [noor, sam]) if (u) presence.beat(u);
    };
    const demoTimer = setInterval(demoNow, 8_000);
    demoTimer.unref?.();
    setTimeout(demoNow, 3000).unref?.();
  }
  /** The running workout, as the log has it, into presence. */
  const presenceWorkout = (userId, w) => { try { presence.setWorkout(userId, workoutNow(w.workouts.running(), { titleFor })); } catch { /* never in the way */ } };
  /**
   * What one viewer may see of somebody now: { online, activity, bpm } or null.
   * Only for a signed-in viewer, never their own, only when the person shows it
   * (privacy.presence) and the viewer may see the account; what the workout is,
   * only with their workouts; the bpm, only with their heart.
   */
  /** You, as your friends see you: here (you are looking), what is kept to yourself left out. */
  /** Without the exercise and set, for somebody who keeps those to themselves. */
  const plain = (p, a) => (a && a.kind === 'workout' && p.privacy?.nowDetail === false ? { ...a, doing: null, sets: null, exercises: null, list: null, resting: false } : a);
  const selfNow = (me) => {
    let act = plain(me, presence.get(me.userId)?.activity || null);
    if (act && me.privacy?.workouts === 'me') act = { kind: act.kind, start: act.start, paused: act.paused || false };
    const hr = me.privacy?.heart !== 'me' ? live.latest(me.userId) : null;
    return { online: true, activity: act, bpm: hr && hr.bpm > 0 && now() - hr.t < 15_000 ? hr.bpm : null };
  };
  const nowFor = (L, p) => {
    if (!L.id || !p || p.userId === L.id || !presenceOn(p) || !L.knows(p)) return null;
    const n = presence.get(p.userId);
    if (!n) return null;
    let a = plain(p, n.activity);
    if (a && !L.sees(p, 'workouts')) a = { kind: a.kind, start: a.start, paused: a.paused || false };
    const hr = L.sees(p, 'heart') ? live.latest(p.userId) : null;
    return { online: n.online, activity: a, bpm: hr && hr.bpm > 0 && now() - hr.t < 15_000 ? hr.bpm : null };
  };
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

  // The Android app's sender (fcm.js): given (tests), or from the key file (FCM_SERVICE_ACCOUNT), or none.
  const fcmSender = fcm !== undefined ? fcm : (() => { const k = loadServiceAccount(config.fcmServiceAccount); return k ? new Fcm({ account: k, now }) : null; })();
  if (config.fcmServiceAccount && !fcmSender) log('FCM_SERVICE_ACCOUNT is set but the key file could not be read: the app gets no notifications');
  // The iPhone app's sender (apns.js): given (tests), or from the key (APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID), or none.
  const apnsSender = apns !== undefined ? apns : (() => { const c = loadApnsKey(config.apns || {}); return c ? new Apns({ creds: c, now }) : null; })();
  if (config.apns?.keyFile && !apnsSender) log('APNS_KEY_FILE is set but the key could not be read (or APNS_KEY_ID / APNS_TEAM_ID is missing): the iPhone app gets no notifications');
  const notifier = new Notifier({ app, sse, send: pushSend, fcm: fcmSender, apns: apnsSender, subject: config.vapidSubject, now, log });

  /* ── worlds ─────────────────────────────────────────────────────── */

  const notifyUser = (userId, note) => {
    const w = worlds.get(userId);
    const p = app.profile(userId);
    return notifier.notify(userId, note, { prefs: w.alerts.prefs(), tz: p?.tz || w.tz }).catch((e) => { log(`notify: ${e.message}`); });
  };
  const worlds = new Worlds({
    dataDir: config.dataDir,
    max: config.maxWorlds,
    make: (userId, dir) => remeasure(userId, new UserWorld({
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
    })),
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
    const gLast = Math.max(w.garminOn() ? garminMeta(w.db).lastSync || 0 : 0, w.hcOn() ? hcMeta(w.db).lastUpload || 0 : 0, w.whoopOn() ? whoopMeta(w.db).lastSync || 0 : 0) || null;
    app.patchProfile(userId, {
      googleState: googleStateOf(w),
      // Every device that reports, by name ("Fitbit Air and Garmin"), else the one there is.
      device: (() => {
        const names = [...new Set((w.db.meta('devices') || []).map((x) => x?.name).filter(Boolean))];
        if (names.length > 1) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`.slice(0, 80);
        return names[0] || w.db.meta('device')?.name || null;
      })(),
      stepGoal: w.settings().stepTarget,
      lastSyncAt: Math.max(w.sync.state.lastOk || 0, gLast || 0) || null,
      // Google with nothing on it is not an error for somebody whose data comes from Garmin or Health Connect.
      syncError: result && !result.ok && !(result.code === 'not_linked' && w.extraIn()) ? String(result.message || result.code || 'failed').slice(0, 200) : null,
    });
    syncNudge(userId, w);
    // Maps of past runs, walks and rides, a few each sync, for the posts below.
    try { await views.fillRoutes(w); } catch (e) { log(`routes: ${e.message}`); }
    // Strava's seven days (strava.js expireStrava), whether or not Strava is still connected.
    try { stravaExpiry(userId, w); } catch (e) { log(`strava expiry: ${e.message}`); }
    await publish(userId);
    // Photos of Strava activities, onto their posts (once each).
    try { await stravaPhotos(userId, w); } catch (e) { log(`strava photos: ${e.message}`); }
    await w.alerts.tick().catch((e) => log(`alerts: ${e.message}`));
    changed(userId, ['data', 'me', 'social']);
  }

  /**
   * What was read from Strava more than seven days ago (its API Policy 6.2): the workouts cut to
   * references (strava.js), Strava's photos brought onto posts removed, and the author's own
   * version of a post that carried Strava's numbers replaced by the one everybody else sees.
   */
  function stravaExpiry(userId, w) {
    const cut = now() - STRAVA_KEEP_MS;
    const touched = expireStrava({ db: w.db, now: now() });
    for (const m of app.all("SELECT id FROM media WHERE user_id = ? AND name LIKE 'strava:%' AND created_ms < ?", userId, cut)) {
      try { media.remove(userId, m.id); } catch (e) { log(`strava photo ${m.id}: ${e.message}`); }
    }
    for (const row of app.all("SELECT id, data FROM post WHERE user_id = ? AND end_ms < ? AND data LIKE '%\"pub\":%'", userId, cut)) {
      let d; try { d = JSON.parse(row.data); } catch { continue; }
      if (!d?.pub) continue;
      app.run('UPDATE post SET data = ? WHERE id = ?', JSON.stringify(d.pub), row.id);
    }
    return touched.length;
  }

  /** Strava activity photos (their addresses read by strava.js) onto the posts of their workouts, a few a sync. */
  async function stravaPhotos(userId, w) {
    const posts = app.all("SELECT * FROM post WHERE user_id = ? AND kind = 'workout'", userId);
    if (!posts.length) return 0;
    const byUid = new Map(posts.map((x) => [x.uid, x]));
    let n = 0;
    for (const r of w.db.workoutsSince(now() - 40 * 86_400_000)) {
      const urls = r.strava?.photos;
      const post = byUid.get(r.uid);
      if (!post || !Array.isArray(urls) || !urls.length) continue;
      for (const u of urls) {
        if (n >= 6) return n;
        const name = `strava:${createHash('sha1').update(u).digest('hex').slice(0, 16)}`;
        if (app.get('SELECT 1 FROM media WHERE post_id = ? AND name = ?', post.id, name)) continue;
        try {
          const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15_000); t.unref?.();
          const res = await (stravaPhotoFetch || globalThis.fetch)(u, { signal: ctl.signal }).finally(() => clearTimeout(t));
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 12 * 1024 * 1024) continue;
          if (media.importImage(userId, post, buf, { name })) n += 1;
        } catch { /* tried again next sync */ }
      }
    }
    return n;
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
        if (!w.anyConnected() && (extra.hevy || extra.strava || extra.xiaomi || extra.garmin || extra.whoop || extra.withings)) await afterSync(userId, extra.garmin && !extra.garmin.skipped ? extra.garmin : extra.whoop && !extra.whoop.skipped ? extra.whoop : null);
        // Garmin's (or WHOOP's) numbers were folded in after Google's run: the rest follows them.
        else if (w.anyConnected() && (extra.garmin?.wrote || extra.whoop?.wrote || extra.whoop?.removed)) await afterSync(userId, result);
        if (!w.anyConnected() && extra.garmin) result = { ...extra.garmin, extra: true };
        else if (!w.anyConnected() && extra.whoop) result = { ...extra.whoop, extra: true };
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
  /** Samsung Health through the phone, as the Connections page and /api/me show it. */
  const hcPayload = (w) => { const h = hcMeta(w.db); return { connected: w.hcOn(), kept: !w.hcOn() && !!h.kept, connectedAt: h.connectedAt || null, lastUpload: h.lastUpload || null, lastResult: h.lastResult || null, settings: h.settings, device: w.hcIn() ? w.hcDb().meta('device')?.name || null : null, perms: h.perms || null, counts: w.hcIn() ? hcCounts(w.hcDb()) : null }; };
  /** What Samsung Health brought, kind by kind, in the last 30 days: the page says what is missing. */
  const hcCounts = (db) => {
    const from = new Date(now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const t = db.dailyTable(from);
    const has = (k) => Object.values(t).filter((r) => Number.isFinite(r[k])).length;
    return { steps: has('steps'), heart: has('rhr') + has('hr_avg'), hrv: has('hrv'), spo2: has('spo2'), sleep: db.sleeps(from).length, workouts: db.exercises(from).length, weight: db.weights(Date.now() - 365 * 86_400_000).length };
  };
  const garminPayload = (w, userId) => {
    const row = app.secretRow(userId, 'garmin');
    return garminView(w.db, w.garminIn() ? w.garminDb() : null, { connected: !!row && w.garminOn(), last4: row?.last4 || null, now: now(), tz: w.tz });
  };
  /* Withings (withings.js): one developer app for the site; each person's tokens sealed in the vault. */
  const withingsOn = () => !!(config.withings?.clientId && config.withings?.clientSecret && config.withings?.redirectUri);
  const withingsTokens = (userId) => { const t = vault.open(app.secretRow(userId, 'withings'), `${userId}:withings`); try { return t ? JSON.parse(t) : null; } catch { return null; } };
  const keepWithingsTokens = (userId, tokens) => app.setSecret(userId, 'withings', vault.seal(JSON.stringify(tokens), `${userId}:withings`), null);
  const withingsApiFor = (userId) => {
    const tokens = withingsOn() ? withingsTokens(userId) : null;
    if (!tokens) return null;
    return new WithingsApi({ clientId: config.withings.clientId, clientSecret: config.withings.clientSecret, tokens, onTokens: (t) => keepWithingsTokens(userId, t), fetchImpl: withingsFetch || globalThis.fetch, base: withingsUrls?.api || undefined, now });
  };
  const withingsConnected = (userId) => withingsOn() && !!app.secretRow(userId, 'withings');
  const withingsPayload = (w, userId) => withingsView(w.db, { configured: withingsOn(), connected: withingsConnected(userId) });
  /** Withings' people, to find a person from a notification. */
  const withingsUsers = () => app.meta('withingsUsers', {}) || {};
  const setWithingsUser = (wid, userId) => { const a = withingsUsers(); if (userId) a[wid] = userId; else delete a[wid]; app.setMeta('withingsUsers', a); };
  /** The address Withings calls when a weigh-in arrives; its token says the call is real. */
  const withingsNotifyUrl = () => (config.withings?.notifyUrl ? `${config.withings.notifyUrl}?token=${notifyToken(config.withings.clientSecret)}` : null);
  /** Let go of Withings: the notifications stopped, the tokens deleted; what it brought kept or not. */
  async function dropWithings(userId, w, { keepData = true, lost = null } = {}) {
    const api = withingsApiFor(userId);
    if (api && withingsNotifyUrl()) await api.revoke(withingsNotifyUrl());
    const wid = withingsMeta(w.db).userId;
    if (wid && withingsUsers()[wid] === userId) setWithingsUser(wid, null);
    app.deleteSecret(userId, 'withings');
    forgetWithings(w.db, { keepData });
    if (lost) setWithingsMeta(w.db, { lost });
  }

  /* WHOOP (whoop.js): one developer app for the site; each person's tokens sealed in the vault.
     WHOOP's refresh token works once: the new pair is kept the moment it is given. */
  const whoopBudget = new WhoopBudget({ now });
  const whoopOn = () => !!(config.whoop?.clientId && config.whoop?.clientSecret && config.whoop?.redirectUri);
  const whoopTokens = (userId) => { const t = vault.open(app.secretRow(userId, 'whoop'), `${userId}:whoop`); try { return t ? JSON.parse(t) : null; } catch { return null; } };
  const keepWhoopTokens = (userId, tokens) => app.setSecret(userId, 'whoop', vault.seal(JSON.stringify(tokens), `${userId}:whoop`), null);
  const whoopApiFor = (userId) => {
    const tokens = whoopOn() ? whoopTokens(userId) : null;
    if (!tokens) return null;
    return new WhoopApi({ clientId: config.whoop.clientId, clientSecret: config.whoop.clientSecret, tokens, onTokens: (t) => keepWhoopTokens(userId, t), budget: whoopBudget, fetchImpl: whoopFetch || globalThis.fetch, urls: whoopUrls || {}, now });
  };
  const whoopConnected = (w, userId) => w.whoopOn() && !!app.secretRow(userId, 'whoop');
  const whoopPayload = (w, userId) => whoopView(w.db, whoopConnected(w, userId) ? w.whoopDb() : null, { configured: whoopOn(), connected: whoopConnected(w, userId), now: now(), budget: whoopBudget.view() });
  /** WHOOP's members, to find a person from a webhook event. */
  const whoopUsers = () => app.meta('whoopUsers', {}) || {};
  const setWhoopUser = (whoopId, userId) => { const a = whoopUsers(); if (userId) a[whoopId] = userId; else delete a[whoopId]; app.setMeta('whoopUsers', a); };
  /** Let WHOOP go: its grant given back (best effort), its tokens deleted, what it brought removed. */
  async function dropWhoop(userId, w, { lost = null } = {}) {
    const api = whoopApiFor(userId);
    if (api && !lost) await api.revoke();
    const uid = whoopMeta(w.db).user?.id;
    if (uid) setWhoopUser(uid, null);
    app.deleteSecret(userId, 'whoop');
    setWhoopMeta(w.db, { connected: false, user: null, lost, lastError: null, retryAt: null, failures: 0, backTo: null, backDone: false, bodyAt: null, body: null, lastResult: null, connectedAt: null });
    w.dropWhoop();
  }

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
  const music = new MusicLookup({ fetchImpl: musicFetch || globalThis.fetch, now, ...(musicUrls ? { urls: musicUrls } : {}) });
  const weather = new Weather({ fetchImpl: weatherFetch || globalThis.fetch, now });
  /** A post's music from what the browser sent: a pick or a link, resolved here; null takes it off; undefined leaves it. */
  const musicOf = async (m) => (m === undefined ? undefined : m === null ? null : music.resolve(m));

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
        // The exercises each side's person made, kept alike (hevyexercises.js).
        else {
          try { out.hevy.exercises = await syncExercises({ app, userId, db: w.db, api: hevy, now: now(), log }); } catch (e) { log(`hevy exercises ${userId.slice(-6)}: ${e.message}`); }
        }
      }
      const strava = stravaApiFor(userId);
      if (strava && (!only || only === 'strava' || (typeof only === 'object' && !only.whoop))) {
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
      if (w.whoopOn() && (!only || only === 'whoop' || (typeof only === 'object' && only.whoop))) {
        const api = whoopApiFor(userId);
        if (!api) {
          // The tokens are gone, or WHOOP is no longer set up on this server.
          if (whoopOn()) await dropWhoop(userId, w, { lost: { at: now(), message: 'The connection could not be read here. Connect WHOOP again.' } });
        } else {
          out.whoop = await syncWhoop({ main: w.db, src: w.whoopDb(), api, tz: w.tz, now, force, log, only: typeof only === 'object' ? only.whoop : null });
          if (!out.whoop.ok && !out.whoop.skipped) log(`whoop ${userId.slice(-6)}: ${out.whoop.code}`);
          // Who they are on WHOOP, when the sign-in could not ask: for the webhook.
          const wid = whoopMeta(w.db).user?.id;
          if (wid && !whoopUsers()[wid]) setWhoopUser(wid, userId);
          if (out.whoop.code === 'whoop_auth') {
            // The grant was taken back on WHOOP, or has run out: what it brought goes with it.
            await dropWhoop(userId, w, { lost: { at: now(), message: out.whoop.message } });
          } else if (out.whoop.wrote || out.whoop.removed) { try { w.merge(); } catch (e) { log(`whoop merge: ${e.message}`); } }
        }
      }
      if (withingsOn() && app.secretRow(userId, 'withings') && (!only || only === 'withings')) {
        const api = withingsApiFor(userId);
        if (!api) await dropWithings(userId, w, { lost: { at: now(), message: 'The connection could not be read here. Connect Withings again.' } });
        else {
          out.withings = await syncWithings({ db: w.db, api, tz: w.tz, now, full: force && !withingsMeta(w.db).lastSync, log });
          if (!out.withings.ok) log(`withings ${userId.slice(-6)}: ${out.withings.code}`);
          if (out.withings.code === 'withings_auth') await dropWithings(userId, w, { lost: { at: now(), message: out.withings.message } });
        }
      }
      const moved = (x) => x && (x.added || x.merged || x.updated || x.deleted || x.measuresIn || x.pushed || x.removed);
      if (moved(out.xiaomi) || moved(out.withings)) { changed(userId, ['data', 'me']); publish(userId, { announce: false }).catch(() => {}); }
      if (moved(out.hevy) || moved(out.strava)) {
        changed(userId, ['workouts', 'data', 'me']);
        publish(userId, { announce: false }).catch(() => {});
        if (w.google.connected()) w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
      } else if (out.whoop?.wrote || out.whoop?.removed) changed(userId, ['workouts', 'data', 'me']);
      else if (out.hevy || out.strava || out.xiaomi || out.garmin || out.whoop || out.withings) changed(userId, ['me']);
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
      x.extra = !!(app.secretRow(p.userId, 'hevy') || app.secretRow(p.userId, 'strava') || app.secretRow(p.userId, 'xiaomi') || app.secretRow(p.userId, 'garmin') || app.secretRow(p.userId, 'whoop') || app.secretRow(p.userId, 'withings'));
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

  const sessions = new Map();   // token -> { user, at }: spares the store a read per request
  const cookieNamed = (req, name) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
    }
    return null;
  };
  /** The session's token: rep.'s cookie, or the old shared one (still the same session, if it was brought over). */
  const cookieOf = (req) => cookieNamed(req, SESSION_COOKIE) || cookieNamed(req, OLD_SESSION_COOKIE);
  async function userOf(req, res = null) {
    const token = cookieOf(req);
    if (!token) return null;
    // Only the old cookie (from before v296): if its session was brought over, it goes on as a
    // repSession cookie with the same session and end. Nothing is written to Mongo.
    if (res && !cookieNamed(req, SESSION_COOKIE)) {
      const user = await accounts.sessionUser(token);
      if (!user || !validUserId(user.id)) return null;
      res.setHeader('set-cookie', accounts.setCookieUntil(token, accounts.sessionEnd(token) || now() + SESSION_MS));
      sessions.set(token, { user, at: now() });
      return { ...user, token };
    }
    const hit = sessions.get(token);
    if (hit && gone.has(String(hit.user.id))) { sessions.delete(token); return null; }
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
  /** Accounts deleted while this server runs: a request already under way for one makes nothing. */
  const gone = new Set();
  function ensureProfile(user, tz) {
    if (gone.has(String(user.id))) return null;
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
  const redirect = (res, location, headers = {}, status = 302) => { res.writeHead(status, { location, 'cache-control': 'no-store', ...baseHeaders, ...headers }); res.end(); };

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
    const versioned = /^v\/([0-9a-f]{8})\/((?:js|css|vendor)\/.+)$/.exec(rel.replace(/\\/g, '/'));
    if (versioned) rel = versioned[2];
    const current = versioned?.[1] === BUILD;
    // The two plain documents have clean addresses (Google's consent screen links them).
    if (rel === 'privacy' || rel === 'privacy-ar' || rel === 'terms' || rel === 'guidelines' || rel === 'licenses' || rel === 'support') rel += '.html';
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
   * profile photo: anyone signed in (it goes with the name, docs/CIRCLES.md).
   * Everything else (signed out, not allowed, unfinished, no such id) is
   * the same 404. Ranges are answered (Safari plays a video only through
   * 206 replies). The file is named by the id, never by anything sent.
   */
  async function serveMedia(req, res, user, id, thumb) {
    const r = media.row(id);
    const allowed = () => {
      if (!user || !r || r.state !== 'ready') return false;
      if (r.user_id === user.id) return true;
      // A profile photo goes with the name: anyone who may see the name (whoever typed it exactly) may see the photo.
      if (r.kind === 'avatar') { const p = app.profile(r.user_id); return !!p && p.avatar === r.id; }
      if (String(r.name || '').startsWith('strava:')) return false;   // brought in from Strava: its owner's only
      return !!r.post_id && feed.canSeePost(app, user.id, r.post_id);
    };
    if (!allowed() || !media.has(r, thumb)) throw err('Not found', 404);
    const file = thumb ? media.thumbFile(r) : media.file(r);
    const size = (await stat(file)).size;
    const etag = `"${r.id}${thumb ? `-t${r.thumb_bytes || ''}` : ''}"`;
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

  /** A person's achievements, on their own calendar and step goal. */
  const achievementsOf = (w, ix, profile, noStrava = false) => achievementsList(w, ix, { tz: profile.tz, weekStart: profile.weekStart ?? 1, stepGoal: views.goalsView(w).steps || 8000, now: now(), ...(noStrava ? { sessions: unified(w.db, 0, { noStrava: true }) } : {}) });

  /** Workout settings kept in the person's own store. */
  const REST_CHOICES = [30, 45, 60, 75, 90, 120, 150, 180, 240, 300];
  const trainingOf = (w) => ({ restOn: true, restS: 90, detail: 'sets', ...(w.db.meta('training', null) || {}) });

  function mePayload(user, profile) {
    const base = { user: user ? { id: user.id, username: user.username, admin: isAdmin(user) } : null, demo: config.demo, version: VERSION, build: BUILD, registrationOpen: app.registrationOpen(), push: { publicKey: notifier.publicKey } };
    if (!user) return base;
    if (!profile) return { ...base, profile: null };
    const w = worlds.get(user.id);
    const c = readCaps(w.db);
    return {
      ...base,
      profile: { username: profile.username, displayName: profile.displayName, bio: profile.bio, accent: profile.accent, avatar: friends.avatarUrl(profile), avatarId: profile.avatar || null, tz: profile.tz, weekStart: profile.weekStart ?? 1, boardWeek: profile.boardWeek === 'own' ? 'own' : 'shared', city: profile.city, country: profile.country, joinedAt: profile.joinedAt, onboarding: profile.onboarding, notes: w.db.meta('notes', '') },
      units: profile.units,
      unitSystem: unitSystem(profile.units),
      goals: views.goalsView(w),
      privacy: profile.privacy,
      // Which optional groups a summary may read, and the metrics pinned to Today.
      aiShare: w.aiShare(),
      pins: w.pins(),
      // The rest timer after a set: on or off everywhere, and the length for an exercise added new.
      training: trainingOf(w),
      google: views.googleView(w),
      googleAccounts: w.accountsView(),
      merge: w.mergeRules(),
      sync: views.syncView(w, scheduler),
      caps: c.caps,
      capsMeta: c.meta,
      device: w.db.meta('device'),
      // The heart-rate zones the device set (light, moderate, vigorous, peak), for every heart-rate chart.
      hrZones: w.db.meta('hrZones')?.zones || null,
      push: { publicKey: notifier.publicKey, devices: notifier.count(user.id), app: !!notifier.fcm, iosApp: !!notifier.apns },
      link: link.linkState(app, user.id, now()),
      workout: views.workoutBadge(w),
      hevy: { connected: hevyMeta(w.db).connected && !!app.secretRow(user.id, 'hevy') },
      strava: { configured: stravaOn(), connected: !!app.secretRow(user.id, 'strava') },
      whoop: { configured: whoopOn(), connected: whoopConnected(w, user.id), lost: !whoopConnected(w, user.id) && !!whoopMeta(w.db).lost },
      xiaomi: { connected: !!app.secretRow(user.id, 'xiaomi') },
      withings: { configured: withingsOn(), connected: withingsConnected(user.id), lost: !withingsConnected(user.id) && !!withingsMeta(w.db).lost },
      // Sex and year of birth for a scale's body ranges: the person's own, with what the scale said. Private: only ever here.
      body: (() => { const b = bodyPerson(w); return { sex: b.own.sex, birthYear: b.own.birthYear, scale: b.scale ? { sex: b.scale.sex || null, birthYear: b.scale.birthYear || null } : null }; })(),
      garmin: (() => { const g = garminMeta(w.db); return { connected: garminOn(w, user.id), kept: !garminOn(w, user.id) && !!g.kept, lost: !garminOn(w, user.id) && !!g.lost, lastSync: g.lastSync || null, keyExpiresAt: garminOn(w, user.id) ? g.keyExpiresAt || null : null, lastError: garminOn(w, user.id) ? g.lastError || null : null }; })(),
      // Where this person's numbers come from: a Google account, Garmin, or both.
      hc: hcPayload(w),
      sources: { google: w.anyConnected(), garmin: garminOn(w, user.id), hc: w.hcOn(), any: w.anyConnected() || garminOn(w, user.id) || w.hcOn() || whoopConnected(w, user.id) },
      // Friend requests waiting for an answer, for a badge.
      social: { requests: friends.requestCount(app, user.id) },
      consent: consentView(profile.consent),
      // Who writes the AI's answers: the free models, or the person's own AI (ownai.js).
      ai: aiUsing(user.id),
      ...((app.meta('suspended', {}) || {})[user.id] ? { suspended: true } : {}),
      ...(isAdmin(user) ? { reportsOpen: safety.openReports(app) } : {}),
      // Your circles, for the boards' picker, and what waits for you in them.
      circles: (() => { const c = circles.mine(app, user.id); return { list: c.circles.map((x) => ({ id: x.id, name: x.name, accent: x.accent, icon: x.icon, role: x.role, waiting: x.waiting, members: x.members })), invites: c.invites.length }; })(),
      // How this account signs in (signin.js), and whether it must link Google or Apple first.
      signin: signinView(user),
    };
  }
  const pushPayload = (userId) => {
    const w = worlds.get(userId);
    const avail = w.notifyAvailability();
    return {
      publicKey: notifier.publicKey,
      app: !!notifier.fcm,
      iosApp: !!notifier.apns,
      types: TYPES.filter((t) => !t.admin || isAdmin({ username: app.profile(userId)?.username })).map((t) => ({ ...t, available: avail[t.id]?.available ?? true, reason: avail[t.id]?.reason ?? null })),
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

  /**
   * What the AI is given for one request: the briefing of the person's data (ai.js), only the kinds
   * they allowed, never Strava's, never their name; the detail of the workout or metric asked about.
   * Resolves { prompt, cacheKey, seen } (seen: what was read, for the page to show).
   */
  async function aiBuildFor(userId, { topic, refId = null, question = null, history = [] }) {
    const allow = app.profile(userId)?.consent?.ai?.allow || {};
    return worlds.hold(userId, async (w2) => {
      const today = todayU(now(), w2.tz);
      let detail = null; let detailLabel = null;
      // A question about a workout ("analyze my latest run"): the latest one of that kind is what it is about.
      let wid = topic === 'workout' ? refId : null;
      if (!wid && topic === 'ask' && question && allow.workouts === true && AI_WORKOUT_Q.test(question)) wid = aiLatestWorkout(w2, question);
      if (wid) {
        const row = /^\d{1,12}$/.test(String(wid)) ? w2.db.workoutGet(wid) : null;
        if (allow.workouts !== true) detail = 'The person chose not to share workouts with the AI.';
        else if (row && !aiWorkoutOk(row)) detail = 'This workout came from Strava. Strava does not allow its data to be sent to an AI, so nothing about it is shared: say so.';
        else {
          try {
            const d = await views.workoutDetail(w2, wid, { noStrava: true });
            // noStrava: nothing of Strava's (its details, a route or a title read from it); the watch's own route when it has one.
            detail = `${aiWorkout(w2, null, d)}\n${workoutAnalysis(d, aiSimilar(w2, d), w2.tz)}`;
            detailLabel = `${topic === 'ask' ? 'The workout you asked about' : 'This workout'}: ${[d?.track ? 'pace and route' : null, d?.trace?.length ? 'heart rate minute by minute' : null, d?.exercises?.length ? 'every set' : null, 'your similar sessions'].filter(Boolean).join(', ')}`;
          } catch { detail = null; }
        }
      }
      if (topic === 'metric' && refId) {
        // Its kind comes from the catalog; a sensitive metric (or one of no kind) never goes in.
        const kind = aiMetricKind(refId);
        if (!kind) detail = 'This is sensitive data that the app never sends to an AI. Say so, and answer only in general terms.';
        else if (allow[kind] !== true) detail = 'The person chose not to share this kind of data with the AI.';
        else {
          try {
            const mv = await metricView(w2, refId, { range: 'month', noStrava: true });
            const wk = metricById(refId)?.weekly ? await metricView(w2, refId, { range: '6m', noStrava: true }) : null;
            detail = aiMetric(refId, mv, wk);
            detailLabel = 'This measure, as its page shows it, for 30 days';
          } catch { detail = 'This measure could not be read just now.'; }
        }
      }
      // The Sleep page on a night before last night: that night is what it is about.
      if (topic === 'sleep' && refId && /^\d{4}-\d{2}-\d{2}$/.test(refId) && refId < today) {
        if (allow.sleep === true) { detail = aiNight(w2, refId); detailLabel = 'The night you were looking at'; }
        else detail = 'The person chose not to share sleep with the AI.';
      }
      const seen = [];
      const text = aiBriefing(w2, { topic, id: refId, now: now(), extra: { detail, detailLabel }, allow, seen });
      const own = aiOwn(userId);
      // Kept while what the AI would read is the same: a digest of the briefing without the lines
      // that move every minute (the clock, how long ago it synced), and the part of the day it is.
      // Any change to their data (a sync, a log, a workout edited) asks again.
      const steady = text.replace(/^## Now\n.*$/m, '').replace(/^Data last synced.*$/m, '').replace(/It is \d{2}:\d{2}/g, '');
      const hourNow = Number(new Date(now() + utcOffsetSec(now(), w2.tz) * 1000).getUTCHours());
      const cacheKey = question ? null : `${topic}:${refId || ''}:${today}:${Math.floor(hourNow / 3)}:${createHash('sha1').update(steady).digest('hex').slice(0, 16)}:${own ? `${own.provider}/${own.model}` : 'free'}`;
      return { prompt: aiPrompt({ topic, briefingText: text, question, history }), cacheKey, seen };
    });
  }
  /** Words that make a question about a workout, and the sport each one names. */
  const AI_WORKOUT_Q = /\b(run|ran|runs|running|jog\w*|interval\w*|sprint\w*|tempo|ride|rode|bike|biking|cycl\w*|walk\w*|hike|hiking|swim\w*|lift\w*|gym|weights?|strength|workout\w*|session|training|exercise)\b/i;
  const AI_SPORT = [[/\b(run|ran|runs|running|jog\w*|interval\w*|sprint\w*|tempo)\b/i, 'run'], [/\b(ride|rode|bike|biking|cycl\w*)\b/i, 'ride'], [/\b(walk\w*|hike|hiking)\b/i, 'walk'], [/\b(swim\w*)\b/i, 'swim'], [/\b(lift\w*|gym|weights?|strength)\b/i, 'gym']];
  /** The latest workout a question names (its sport, or any), never Strava's: its id for workoutDetail. */
  function aiLatestWorkout(w2, question) {
    const want = AI_SPORT.find(([re]) => re.test(question))?.[1] || null;
    const list = unified(w2.db, now() - 45 * 86_400_000, { noStrava: true }).sort((a, b) => b.start - a.start);
    const ok = (x) => { if (!want) return true; const ty = sessionType(x); if (want === 'gym') return isGym(x); if (want === 'swim') return /SWIM/.test(String(ty)); return sportOf(ty) === want; };
    const hit = list.find(ok) || (want ? null : list[0]);
    return hit ? (hit.local ? String(hit.local.id) : mirrorId(hit.ex.id)) : null;
  }
  /** Their earlier sessions of the same sport, for the analysis to compare with. */
  function aiSimilar(w2, d) {
    const sport = sportOf(d?.type);
    return unified(w2.db, now() - 120 * 86_400_000, { noStrava: true }).filter((x) => sportOf(sessionType(x)) === sport).sort((a, b) => a.start - b.start)
      .map((x) => ({ start: x.start, minutes: Math.round((x.end - x.start) / 60_000), distanceM: publicDistance(x), avgHr: x.local ? x.local.avgHr : x.ex?.avgHr, paceSPerKm: x.local ? (x.local.route?.from === 'strava' ? null : x.local.route?.paceSPerKm ?? null) : x.ex?.paceSecPerKm ?? null }));
  }

  /** The person's own AI (ownai.js), if they connected one. */
  const aiOwn = (userId) => { const s = vault.open(app.secretRow(userId, 'ai'), `${userId}:ai`); try { return s ? JSON.parse(s) : null; } catch { return null; } };
  /** Who writes this person's answers, as the page says it. */
  const aiUsing = (userId) => { const o = aiOwn(userId); return o ? { own: true, provider: o.provider, label: OWN_AI[o.provider]?.label || o.provider, model: o.model } : { own: false, label: 'Free AI models (OpenCode)' }; };
  const aiThreads = new AiThreads({
    writer, worlds, log, now,
    writerFor: (userId) => { const o = aiOwn(userId); return o ? new OwnWriter({ ...o, fetchImpl: ownAiFetch || globalThis.fetch }) : null; },
    build: (userId, turn, history) => aiBuildFor(userId, { topic: turn.topic, refId: turn.refId, question: turn.question, history }),
    cacheFor: (userId) => ({ get: (k) => worlds.hold(userId, (w2) => answerCache(w2.db).get(k)), set: (k, v) => worlds.hold(userId, (w2) => answerCache(w2.db).set(k, v)) }),
    onChange: (userId) => changed(userId, ['ai']),
  });

  function adminPayload() {
    return {
      registrationOpen: app.registrationOpen(),
      reports: safety.reportsView(app),
      // Connection state only. Nothing here is health data.
      people: app.profiles().map((p) => ({
        id: p.userId, username: p.username, displayName: p.displayName, accent: p.accent, avatar: friends.avatarUrl(p), joinedAt: p.joinedAt, lastSeenAt: p.lastSeenAt || null, suspended: safety.suspendedIds(app).has(p.userId),
        private: p.privacy.account === 'private', google: p.googleState, lastSyncAt: p.lastSyncAt || null, syncError: p.syncError || null,
        nextSyncAt: scheduler.dueAt(p.userId), pushDevices: notifier.count(p.userId), linkKeys: link.listKeys(app, p.userId).length,
        detection: p.detect,
      })),
      server: {
        version: VERSION, node: process.version, startedAt, uptimeS: Math.round((now() - startedAt) / 1000), demo: config.demo,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576), worlds: { open: worlds.open(), max: worlds.max },
        scheduler: { inFlight: scheduler.inFlight.size, maxInFlight: scheduler.maxInFlight, ...scheduler.stats },
        google: { configured: !!(config.google.clientId && config.google.clientSecret && config.google.redirectUri), redirectUri: config.google.redirectUri || null },
        push: { configured: true },
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
        // With dumbbells: lifted with one or two. Without saying, or not dumbbells: none.
        ...([1, 2].includes(Number(e.dumbbells)) && isDumbbell({ name, libId: e.libId }) ? { dumbbells: Number(e.dumbbells) } : {}),
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
  /* ── tries at routes (routetry.js) ── */

  /** The track of a workout here or a watch's session: [t, lat, lng, ...] points, or null. */
  const pointsOf = (w, id) => (String(id).startsWith('g-') ? w.db.meta(`route:${id}`)?.points : w.db.trackGet(id)?.points) || null;
  const routeRow = (id) => app.get('SELECT * FROM route WHERE id = ?', String(id));
  // The way a go has to cover: the line, or out along it and back for a route done there and back.
  const lineOfRow = (r) => { try { return wayOf(JSON.parse(r.line), !!r.both_ways); } catch { return null; } };
  /** Every track of the person: their recordings and the watch's sessions read from Google. */
  function allTracks(w) {
    const out = [...w.db.trackIds()].map((id) => ({ id: String(id), workout: w.db.workoutGet(id) })).filter((x) => x.workout && x.workout.status === 'done');
    for (const k of Object.keys(w.db.metaPrefix('route:g-') || {})) out.push({ id: k.slice('route:'.length), workout: null });
    return out;
  }
  /** The try in one workout at one route: marked by hand when it was, else found. */
  function tryIn(w, x, r, line) {
    const pts = pointsOf(w, x.id);
    if (!pts?.length || !passesStart(line, pts)) return null;
    const marks = x.workout?.followRoute === r.id ? x.workout.routeMarks : null;
    if (marks?.startT || marks?.endT) {
      const auto = findTry(line, pts);
      const m = markedTry(pts, marks.startT ?? auto?.startT ?? pts[0][0], marks.endT ?? auto?.endT ?? pts[pts.length - 1][0]);
      if (m) return m;
    }
    return findTry(line, pts);
  }
  /** Your tries at a route, fastest first. */
  function triesAt(w, r) {
    const line = lineOfRow(r);
    if (!line) return [];
    const out = [];
    for (const x of allTracks(w)) {
      const t = tryIn(w, x, r, line);
      if (t) out.push({ workoutId: x.id, ...t });
    }
    return out.sort((a, b) => a.timeS - b.timeS);
  }
  /** The routes a workout went round (the one it followed, yours, or shared ones near it), with the time on each. */
  function triesInWorkout(w, uid, id) {
    const pts = pointsOf(w, id);
    if (!pts?.length) return [];
    const workout = String(id).startsWith('g-') ? null : w.db.workoutGet(id);
    let s = 90; let n = -90; let we = 180; let e = -180;
    for (const p of pts) { s = Math.min(s, p[1]); n = Math.max(n, p[1]); we = Math.min(we, p[2]); e = Math.max(e, p[2]); }
    const pad = 0.01;
    const rows = app.all(`SELECT route.* FROM route LEFT JOIN profile ON profile.user_id = route.user_id
      WHERE start_lat BETWEEN ? AND ? AND start_lng BETWEEN ? AND ? AND (route.user_id = ? OR (route.public = 1 AND json_extract(profile.privacy, '$.account') = 'public'))
      LIMIT 50`, s - pad, n + pad, we - pad, e + pad, uid);
    if (workout?.followRoute && !rows.some((r) => r.id === workout.followRoute)) { const f = routeRow(workout.followRoute); if (f) rows.push(f); }
    const out = [];
    for (const r of rows) {
      const line = lineOfRow(r);
      if (!line) continue;
      const t = tryIn(w, { id: String(id), workout }, r, line);
      if (!t) continue;
      const mine = triesAt(w, r);
      const rank = mine.findIndex((x) => x.workoutId === String(id)) + 1;
      out.push({ routeId: r.id, title: r.title, ...t, best: mine[0] ? mine[0].timeS : null, rank: rank || null, of: mine.length });
    }
    return out;
  }

  /** Everything health holds of a person: their folder, profile, posts, friends, routes and keys; Google's access revoked. */
  async function wipeHealth(uid, w) {
    // Google first, while the token is still here to revoke; Strava's grant given back the same way.
    await w.google.disconnect().catch(() => {});
    try {
      const sapi = stravaApiFor(uid);
      if (sapi) await sapi.deauthorize();
      const ath = stravaMeta(w.db).athlete?.id;
      if (ath) setAthlete(ath, null);
    } catch (e) { log(`delete data, strava: ${e.message}`); }
    try {
      const wapi = whoopApiFor(uid);
      if (wapi) await wapi.revoke();
      const wid = whoopMeta(w.db).user?.id;
      if (wid) setWhoopUser(wid, null);
    } catch (e) { log(`delete data, whoop: ${e.message}`); }
    try {
      const napi = withingsApiFor(uid);
      if (napi && withingsNotifyUrl()) await napi.revoke(withingsNotifyUrl());
      const nid = withingsMeta(w.db).userId;
      if (nid) setWithingsUser(nid, null);
    } catch (e) { log(`delete data, withings: ${e.message}`); }
    garminTokens.delete(uid);
    scheduler.forget(uid);
    live.forget(uid);
    // After this request lets go of the world, it and the folder go.
    setImmediate(() => { try { worlds.destroy(uid); } catch (e) { log(`delete data: ${e.message}`); } });
    app.deleteUser(uid);
    media.forgetUser(uid);
    changed(uid, ['me', 'data', 'workouts', 'social', 'push', 'link']);
  }

  /** A route kept as a workout: its numbers on the workout, its points apart. */
  /** Which cleaning a recording's track has had: 1 its gaps filled, 2 its lone wandering fixes out too. */
  const FILL_V = 2;
  /** A recording's gaps (a phone that gave no position for a while) laid along the route it followed (routetry.js). */
  function fillFollowed(routeId, type, points) {
    const row = routeId && /^r_[0-9a-f]{12}$/.test(String(routeId)) ? routeRow(routeId) : null;
    const line = row && lineOfRow(row);
    return line ? fillAlong(line, points, { maxSpeed: ROUTE_TYPES[routeType(type)].maxSpeed || 12 }) : { points, filled: 0 };
  }
  /** The route's numbers on its workout, from its track. */
  function routeNumbers(r, st) {
    r.distanceM = st.distanceM; r.movingS = st.movingS; r.elevGainM = st.elevGainM;
    r.route = { type: st.type, distanceM: st.distanceM, movingS: st.movingS, paceSPerKm: st.paceSPerKm, avgSpeedKmh: st.avgSpeedKmh };
  }
  /** Routes recorded here, measured again once the way they are measured changed (tracks.js MEASURE_V). */
  function remeasure(uid, w) {
    try {
      if (w.db.meta('measureV', 0) === MEASURE_V) return w;
      let n = 0;
      for (const r of w.db.workoutsDoneFrom(0)) {
        if (r.source !== 'recorded' || !r.route) continue;
        const t = w.db.trackGet(r.id);
        if (!t?.points?.length) continue;
        const st = trackStats(t);
        if (Math.abs(st.distanceM - (r.route.distanceM || 0)) < 1 && st.movingS === r.route.movingS) continue;
        routeNumbers(r, st);
        if (r.google?.state === 'saved') r.google = { ...r.google, dirty: true };
        r.updated = now();
        w.db.workoutPut(r);
        w.db.delMeta(`eff:${r.id}`);
        n += 1;
      }
      w.db.setMeta('measureV', MEASURE_V);
      if (n) { log(`remeasured ${n} route(s) for ${uid}`); setTimeout(() => { changed(uid, ['workouts', 'data']); publish(uid, { announce: false }).catch(() => {}); }, 0); }
    } catch (e) { log(`remeasure ${uid}: ${e.message}`); }
    return w;
  }
  /** A recording saved before its gaps were filled: filled once, its numbers, medals and post after it. */
  function refillTrack(w, uid, id) {
    if (!/^\d{1,12}$/.test(String(id))) return;
    const r = w.db.workoutGet(id);
    if (!r || r.source !== 'recorded' || !r.followRoute) return;
    const t = w.db.trackGet(id);
    if (!t || t.fill >= FILL_V) return;
    // From the fixes the phone gave (a fill made before is laid again: its points have no
    // accuracy), lone wandering ones out (tracks.js despike), then the gaps along the route.
    const raw = t.fill ? t.points.filter((p) => p[4] !== null && p[4] !== undefined) : t.points;
    const clean = despike(raw, t.type);
    const f = fillFollowed(r.followRoute, t.type, clean);
    t.fill = FILL_V;
    const moved = f.filled > 0 || clean.length !== t.points.length;
    if (moved) {
      t.points = f.points;
      routeNumbers(r, trackStats(t));
      if (r.google?.state === 'saved') r.google = { ...r.google, dirty: true };
      r.updated = now();
      w.db.workoutPut(r);
      w.db.delMeta(`eff:${id}`);
    }
    w.db.trackPut(id, t);
    if (moved) { changed(uid, ['workouts', 'data']); publish(uid, { announce: false }).catch(() => {}); }
  }

  function saveRouteIn(w, uid, { type, points, pauses, start, end, title, notes, source, follow = null }) {
    const fill = follow?.routeId ? fillFollowed(follow.routeId, type, points) : { points, filled: 0 };
    points = fill.points;
    const st = trackStats({ type, points, pauses, start, end });
    if (st.distanceM < 20 && st.movingS < 60) throw err('That route is too short to keep.');
    const label = ROUTE_TYPES[type].label;
    const r = w.workouts.logPast({ start, end: Math.max(end, start + 60_000), title: title ? String(title).slice(0, 80) : label, notes: notes || null, type, route: true });
    r.source = source;
    // A watch worn on the same walk sends its own copy to Google a little later: given time to, and then not sent twice.
    if (source === 'recorded' && r.google?.state === 'pending') r.google = { ...r.google, notBefore: Math.max(now(), end) + 30 * 60_000 };
    routeNumbers(r, st);
    // The route it followed, and the try marked by hand on it (routetry.js), if any.
    if (follow?.routeId && /^r_[0-9a-f]{12}$/.test(String(follow.routeId))) {
      r.followRoute = String(follow.routeId);
      const a = follow.startT == null ? NaN : Number(follow.startT); const z = follow.endT == null ? NaN : Number(follow.endT);
      r.routeMarks = Number.isFinite(a) || Number.isFinite(z) ? { startT: Number.isFinite(a) ? a : null, endT: Number.isFinite(z) ? z : null } : null;
    }
    r.updated = now();
    w.db.workoutPut(r);
    w.db.trackPut(r.id, { type, points, pauses, start, end, ...(follow?.routeId ? { fill: FILL_V } : {}) });
    changed(uid, ['workouts', 'data']);
    publish(uid, { announce: false }).catch(() => {});
    w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
    return { id: String(r.id), stats: (({ series: _s, ...x }) => x)(st) };
  }

  /** A watch's workout, changed here: made the person's own first (adopt.js). */
  function adoptMirror(w, id) {
    const r = adoptMirrorRow(w.db, id, { now: now(), log });
    return w.workouts.get(r.id);
  }

  /**
   * After an edit, where else it goes. Everywhere (the default): the copy in Hevy is updated
   * (also a workout that came from Hevy) and the copy in Google, when this app saved it; the
   * watch's own record in Google cannot be changed by any app. Here only: neither copy changes.
   */
  function spread(w, r, everywhere, { googleChanged = false } = {}) {
    const inHevy = !!(w.db.hevyLinkOf(r.id) || r.hevy?.id);
    const inStrava = !!(w.db.stravaLinkOf(r.id) || r.strava?.id);
    if (everywhere) {
      if (googleChanged && r.google?.state === 'saved' && r.google.by !== 'link') r.google = { ...r.google, dirty: true };
      if (inHevy) r.hevyDirty = true;
      if (inStrava) r.stravaDirty = true;
    } else {
      if (r.google?.state === 'saved') r.google = { ...r.google, dirty: false };
      delete r.hevyDirty; delete r.stravaDirty;
      r.hevyPushedAt = Math.max(r.hevyPushedAt || 0, r.updated || 0);   // this version is not Hevy's
    }
  }
  const wantsEverywhere = (b) => b?.everywhere !== false;

  function ownWorkout(w, id) {
    if (String(id).startsWith('g-')) return adoptMirror(w, String(id));
    if (!/^\d{1,12}$/.test(String(id))) throw err('No such workout.', 404);
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
  // A path, with a plain query of its own allowed (a circle's invite link, /circles/<id>?code=…).
  const safeBack = (p) => (typeof p === 'string' && /^\/[A-Za-z0-9/_-]{0,100}(\?[A-Za-z0-9_=&%.-]{0,200})?$/.test(p) && !p.startsWith('//') && !/^\/(auth|api)\//.test(p) ? p : '/settings/connections');
  const backWith = (back, q) => `${back}${back.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`;
  const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sendHtml = (res, status, body) => { res.writeHead(status, { ...baseHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
  /** The page the phone's browser shows at the end of an app handoff (Google connected, or why not), with the way back to the app. */
  const handoffPage = ({ ok, title, text, account = null, back = null }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0A0908"><title>${escHtml(title)} · rep.</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>@font-face{font-family:"Instrument Sans";font-style:normal;font-weight:400 700;font-stretch:75% 100%;font-display:swap;src:url(/fonts/instrument-sans.woff2) format("woff2")}
*{box-sizing:border-box;margin:0}html,body{background:#0A0908;color:#F2EDE5}
body{min-height:100dvh;display:flex;flex-direction:column;font:16px/1.5 "Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;padding:max(22px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom))}
.word{display:inline-flex;align-items:center;gap:9px;font-weight:700;font-size:1.375rem;letter-spacing:-0.04em}.word img{width:26px;height:26px}.word i{color:#E7B653;font-style:normal;margin-left:-9px}
main{flex:1;display:flex;flex-direction:column;justify-content:center;width:100%;max-width:420px;margin:0 auto;padding:32px 0}
.plate{width:88px;height:88px;margin-bottom:28px;position:relative}.plate img{width:100%;height:100%;display:block}.plate.off img{filter:grayscale(1) brightness(.75)}
.plate b{position:absolute;right:-4px;bottom:-4px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:${ok ? '#74C3A1' : '#CBD1DC'};color:#0A0908;font-size:16px;font-weight:700;box-shadow:0 0 0 4px #0A0908}
h1{font-size:2.25rem;line-height:1.05;letter-spacing:-0.035em;font-weight:650;margin-bottom:14px;text-wrap:balance}h1 i{color:#E7B653;font-style:normal}
p{color:#D9D2C7;font-size:1.0625rem;line-height:1.45;margin-bottom:28px;text-wrap:pretty}
.acct{display:flex;flex-direction:column;gap:2px;padding:14px 16px;border-radius:20px;background:#171513;box-shadow:0 0 0 1px rgb(255 246 232/.04) inset;margin-bottom:22px}.acct span{font-size:.8125rem;color:#A39B90}.acct b{font-weight:600}
a.btn{display:flex;align-items:center;justify-content:center;min-height:52px;padding:0 22px;border-radius:999px;background:#E7B653;color:#0A0908;text-decoration:none;font-weight:650;font-size:1.0625rem;letter-spacing:-0.01em}
a.btn:active{transform:scale(.98)}</style></head>
<body><span class="word"><img src="/favicon.svg" alt="" width="26" height="26">rep<i>.</i></span>
<main><div class="plate${ok ? '' : ' off'}" aria-hidden="true"><img src="/favicon.svg" alt=""><b>${ok ? '&#10003;' : '!'}</b></div><h1>${escHtml(title)}<i>.</i></h1>
${account ? `<div class="acct"><span>Your rep. account</span><b>${escHtml(account.displayName || account.username)} · @${escHtml(account.username)}</b></div>` : ''}<p>${escHtml(text)}</p>
<a class="btn" href="ojeehealth://open${escHtml(back ?? `/settings/connections${ok ? '?google=connected' : ''}`)}">Back to the rep. app</a></main></body></html>`;

  /* ── signing in with Google or Apple (signin.js) ─────────────────── */

  const passwordLogin = (username) => config.signin.passwordLogin.includes(String(username || '').toLowerCase());
  /** An account from before Google and Apple (and not one flagged for a password): it links one before anything else. */
  const needsLink = (user) => !passwordLogin(user.username) && !signin.hasIdentity(app, user.id);
  const signinView = (user) => ({ methods: signin.identitiesOf(app, user.id), linkRequired: needsLink(user), passwordLogin: passwordLogin(user.username) });
  const googleSigninOn = () => !!(config.google.clientId && config.google.clientSecret && config.signin.googleRedirectUri);
  const safeNext = (n) => (typeof n === 'string' && /^\/[A-Za-z0-9/_?=&%.-]{0,200}$/.test(n) && !n.startsWith('//') && !/^\/(auth|api)\//.test(n) ? n : '/');
  const statusOf = (code) => ({ closed: 403, identity_taken: 409, provider_linked: 409, bad_token: 401, unverified: 401, upstream: 502 }[code] || 400);

  /** Tie an identity to an account, and take its password away in the same step (accounts flagged for a password keep theirs). */
  async function attach(userId, idn) {
    const u = await accounts.byId(userId);
    if (!u) throw err('There is no such account.', 404, 'not_found');
    const r = signin.linkIdentity(app, { ...idn, userId, now: now() });
    if (r === 'linked' && !passwordLogin(u.username)) {
      try { await accounts.dropPassword(userId); } catch (e) {
        // Not both: the link is undone, so the step can be tried again whole.
        app.run('DELETE FROM identity WHERE provider = ? AND sub = ?', idn.provider, String(idn.sub));
        throw e;
      }
    }
    if (r === 'linked') log(`${idn.provider} sign-in linked to ${u.username}`);
    changed(userId, ['me']);
    return r;
  }

  /** What a checked identity means for this attempt: { kind: 'signedin' | 'linked' | 'pending' | 'error', … }. */
  async function outcome(att, idn) {
    const name = signin.PROVIDER_NAME[idn.provider];
    try {
      if (att.linkUserId) { await attach(att.linkUserId, idn); return { kind: 'linked', provider: idn.provider }; }
      const owner = signin.identityOwner(app, idn.provider, idn.sub);
      if (owner) {
        if (await accounts.byId(owner)) { signin.linkIdentity(app, { ...idn, userId: owner, now: now() }); return { kind: 'signedin', userId: owner }; }
        // Its account is gone: the identity is free again.
        app.run('DELETE FROM identity WHERE user_id = ?', owner);
      }
      if (!app.registrationOpen()) return { kind: 'error', code: 'closed', message: `There is no rep. account for this ${name} account, and rep. is not taking new people right now.` };
      // Somebody new: they choose a username and accept the Terms first (/auth/signin/complete).
      const key = flows.put('pending', { provider: idn.provider, sub: idn.sub, email: idn.email || null });
      return { kind: 'pending', pending: key, provider: idn.provider, email: idn.email || null };
    } catch (e) { return { kind: 'error', code: e.code || 'bad_request', message: e.message }; }
  }

  async function startSignedIn(userId, tz) {
    const r = await accounts.signIn(userId);
    ensureProfile(r.user, tz);
    return r;
  }
  /** The answer as JSON, to the page or the app (Apple's sheet in the iPhone app, a ticket's poll). */
  async function answerJson(res, o, tz) {
    if (o.kind === 'signedin') { const r = await startSignedIn(o.userId, tz); return send(res, 200, { state: 'done', user: r.user }, { 'set-cookie': accounts.setCookie(r.token) }); }
    if (o.kind === 'linked') return send(res, 200, { state: 'linked', provider: o.provider });
    if (o.kind === 'pending') return send(res, 200, { state: 'pending', pending: o.pending, provider: o.provider, email: o.email });
    throw err(o.message, statusOf(o.code), o.code);
  }
  /** The answer in a browser: for an app's ticket, a page saying go back to it; on the site, onwards. */
  async function answerBrowser(res, att, o, status = 302) {
    const name = signin.PROVIDER_NAME[o.provider] || 'It';
    if (att.ticket) {
      const t = flows.peek('ticket', att.ticket);
      if (!t) return sendHtml(res, 410, handoffPage({ ok: false, title: 'This sign-in has expired', text: 'Go back to the rep. app and start again.', back: '/signin' }));
      t.result = o;
      const page = o.kind === 'signedin' ? { ok: true, title: 'You are signed in', text: 'Go back to the rep. app: it signs you in by itself.' }
        : o.kind === 'linked' ? { ok: true, title: `${name} is linked`, text: `Go back to the rep. app. From now on you sign in with ${name}.` }
          : o.kind === 'pending' ? { ok: true, title: 'Almost there', text: 'Go back to the rep. app to choose your username.' }
            : { ok: false, title: 'That did not work', text: `${o.message} Go back to the rep. app to try again.` };
      return sendHtml(res, 200, handoffPage({ ...page, back: '/signin' }));
    }
    if (o.kind === 'signedin') { const r = await startSignedIn(o.userId, att.tz); return redirect(res, att.next || '/', { 'set-cookie': accounts.setCookie(r.token) }, status); }
    if (o.kind === 'linked') return redirect(res, backWith(att.back, { signin: 'linked', provider: o.provider }), {}, status);
    if (o.kind === 'pending') return redirect(res, `/register?${new URLSearchParams({ pending: o.pending, ...(att.next && att.next !== '/' ? { next: att.next } : {}) })}`, {}, status);
    return redirect(res, backWith(att.linkUserId ? att.back : '/signin', { signin: 'error', message: String(o.message).slice(0, 200) }), {}, status);
  }
  const expiredAttempt = { kind: 'error', code: 'expired', message: 'This sign-in has expired. Start again.' };

  /* ── routes ─────────────────────────────────────────────────────── */

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const GET = m === 'GET'; const POST = m === 'POST';

    /* a personal API key (apikeys.js, docs/DEVELOPERS.md): the person, on
       their own data, from a script, an app or an AI assistant. No cookie, so
       no Origin to check; what it may touch is decided here, once. */
    const keyBearer = /^Bearer\s+(hak_\S*)$/i.exec(String(req.headers.authorization || ''))?.[1] || null;
    let apiKey = null;
    if (keyBearer) {
      apiKey = apikeys.keyFor(app, keyBearer, now());
      if (!apiKey || !app.profile(apiKey.userId) || gone.has(String(apiKey.userId))) throw err('This API key is not valid. Make a new one in Settings, API and AI.', 401, 'bad_key');
      const why = apikeys.refusal(apiKey.scope, m, p);
      if (why) throw err(why, 403, 'not_allowed');
      limiter.check(`apikey:${apiKey.id}`, 300, 60_000);
      limiter.add(`apikey:${apiKey.id}`, 60_000);
    }

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
              await purgeStrava({ db: w.db, remove: (id) => w.workouts.remove(id), now: now() });
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

    /* WHOOP's webhook: WHOOP itself calls it, with no cookie and no Origin, signed with the app's
       client secret. Answered at once; the record it names is read (or let go of) after. */
    if (p === '/api/whoop/webhook') {
      if (!whoopOn()) throw err('Not found', 404);
      if (!POST) throw err('Use POST.', 405, 'bad_request');
      const raw = await readRaw(req, 16 * 1024);
      if (!whoopSigned({ secret: config.whoop.clientSecret, signature: req.headers['x-whoop-signature'], timestamp: req.headers['x-whoop-signature-timestamp'], body: raw, now: now() })) throw err('Not signed by WHOOP.', 401, 'bad_signature');
      let ev = null;
      try { ev = JSON.parse(raw.toString('utf8')); } catch { throw err('Not JSON.', 400, 'bad_request'); }
      send(res, 200, { ok: true });
      const userId = whoopUsers()[String(ev?.user_id)];
      const type = String(ev?.type || '');
      if (!userId || !app.profile(userId) || !/^(workout|sleep|recovery)\.(updated|deleted)$/.test(type) || !ev.id) return undefined;
      setImmediate(() => {
        worlds.hold(userId, async (w) => {
          if (!w.whoopOn()) return;
          const r = await syncExtras(userId, w, { only: { whoop: { type, id: String(ev.id) } } });
          if (r.whoop && (r.whoop.wrote || r.whoop.removed)) await afterSync(userId, null);
        }).catch((e) => log(`whoop webhook: ${e.message}`));
      });
      return undefined;
    }

    /* Withings' notification: Withings itself calls it (form-encoded userid, appli, startdate,
       enddate), with no cookie; the token in the address, made from the app's secret, says it
       is real. Withings checks the address answers when it is subscribed, so any method is 200. */
    if (p === '/api/withings/notify') {
      if (!withingsOn()) throw err('Not found', 404);
      if (!POST) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(m === 'HEAD' ? undefined : 'ok'); }
      if (!notifySigned(config.withings.clientSecret, url.searchParams.get('token'))) throw err('Not from Withings.', 401, 'bad_signature');
      const raw = await readRaw(req, 8 * 1024);
      const form = new URLSearchParams(raw.toString('utf8'));
      send(res, 200, { ok: true });
      const userId = withingsUsers()[String(form.get('userid') || '')];
      if (!userId || !app.profile(userId) || !['1', ''].includes(String(form.get('appli') || ''))) return undefined;
      setImmediate(() => {
        worlds.hold(userId, async (w) => {
          const r = await syncExtras(userId, w, { only: 'withings' });
          if (r.withings && (r.withings.added || r.withings.updated || r.withings.removed)) await afterSync(userId, null);
        }).catch((e) => log(`withings notify: ${e.message}`));
      });
      return undefined;
    }

    /* Sign in with Apple's answer (signin.js): Apple's page posts it here (form_post), so it
       comes from appleid.apple.com. The state, made here, single use and ten minutes long, ties
       it to the attempt; the ID token is checked against Apple's keys and our nonce. */
    if (POST && p === '/auth/signin/apple/callback') {
      const ip = ipOf(req);
      limiter.check(`sicb:${ip}`, 60 * loose, 600_000);
      limiter.add(`sicb:${ip}`, 600_000);
      const f = new URLSearchParams((await readRaw(req, 64 * 1024)).toString('utf8'));
      const pend = flows.take('state', f.get('state') || '');
      if (!pend || pend.provider !== 'apple') return answerBrowser(res, {}, expiredAttempt, 303);
      if (f.get('error')) return answerBrowser(res, pend, { kind: 'error', code: 'cancelled', provider: 'apple', message: f.get('error') === 'user_cancelled_authorize' ? 'Nothing was signed in.' : `Apple said: ${f.get('error').slice(0, 80)}.` }, 303);
      let o;
      try {
        const c = await signin.verifyIdToken(f.get('id_token'), { jwks: appleKeys, iss: signin.APPLE_ISSUER, aud: config.signin.appleServicesId, nonce: signin.sha256hex(pend.nonce), now: now() });
        o = await outcome(pend, { provider: 'apple', sub: c.sub, email: c.email });
      } catch (e) { o = { kind: 'error', code: e.code, provider: 'apple', message: e.message }; }
      return answerBrowser(res, pend, o, 303);
    }

    /* every other state-changing request must come from this site */
    if (!GET && m !== 'HEAD' && !apiKey) {
      const origin = req.headers.origin;
      if (!origin || !config.origins.includes(String(origin).replace(/\/+$/, ''))) throw err('This request did not come from the site.', 403, 'bad_origin');
    }

    if (GET && p === '/api/health') return send(res, 200, { ok: true, version: VERSION, build: BUILD, demo: config.demo, uptimeS: Math.round((now() - startedAt) / 1000) });

    /* ── /auth ── */

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
      // A password signs in only the accounts flagged for one (the app reviewers' demo), and accounts
      // from before Google and Apple, which then have to link one (link_required).
      if (!passwordLogin(r.user.username) && signin.hasIdentity(app, r.user.id)) {
        await accounts.logout(r.token);
        throw err('This account signs in with Google or Apple.', 403, 'use_provider');
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

    const user = apiKey ? { id: apiKey.userId, username: app.profile(apiKey.userId).username, token: `key:${apiKey.id}`, apiKey } : await userOf(req, res);
    const user0 = user;

    if (GET && p === '/auth/me') return send(res, 200, { user: user ? { id: user.id, username: user.username } : null });

    /* ── signing in with Google or Apple (signin.js) ── */

    // The way to a provider: on the site; from an app with its ticket (the system browser); or `link=1` to add it to this account.
    const siStart = GET && /^\/auth\/signin\/(google|apple)\/start$/.exec(p);
    if (siStart) {
      const provider = siStart[1];
      const ip = ipOf(req);
      limiter.check(`sistart:${ip}`, 60 * loose, 600_000);
      limiter.add(`sistart:${ip}`, 600_000);
      const q = url.searchParams;
      const att = { next: safeNext(q.get('next')), tz: validTz(q.get('tz')) ? q.get('tz') : null, back: safeBack(q.get('return') || '/settings/account') };
      const tk = q.get('ticket');
      if (tk) {
        const t = flows.peek('ticket', tk);
        if (!t || t.started || t.provider !== provider) return sendHtml(res, 410, handoffPage({ ok: false, title: 'This sign-in link has expired', text: 'Go back to the rep. app and start again.', back: '/signin' }));
        t.started = true;
        Object.assign(att, { ticket: tk, linkUserId: t.linkUserId || null });
      } else if (q.get('link') === '1') {
        if (!user || user.apiKey) return redirect(res, '/signin');
        att.linkUserId = user.id;
      }
      if (provider === 'google') {
        if (!googleSigninOn()) return answerBrowser(res, att, { kind: 'error', code: 'unconfigured', provider, message: 'Google sign-in is not set up on this server yet.' });
        const { verifier, challenge } = pkce();
        const nonce = signin.randomToken();
        const state = flows.put('state', { ...att, provider, verifier, nonce });
        return redirect(res, signin.googleAuthUrl({ urls: siUrls, clientId: config.google.clientId, redirectUri: config.signin.googleRedirectUri, state, challenge, nonce }));
      }
      const nonce = signin.randomToken();
      const state = flows.put('state', { ...att, provider, nonce });
      return redirect(res, signin.appleAuthUrl({ urls: siUrls, servicesId: config.signin.appleServicesId, redirectUri: config.signin.appleRedirectUri, state, nonceHash: signin.sha256hex(nonce) }));
    }
    if (GET && p === '/auth/signin/google/callback') {
      const pend = flows.take('state', url.searchParams.get('state') || '');
      if (!pend || pend.provider !== 'google') return answerBrowser(res, {}, expiredAttempt);
      const denied = url.searchParams.get('error');
      if (denied) return answerBrowser(res, pend, { kind: 'error', code: 'cancelled', provider: 'google', message: denied === 'access_denied' ? 'Nothing was signed in.' : `Google said: ${denied.slice(0, 80)}.` });
      let o;
      try {
        const t = await signin.googleExchange({ urls: siUrls, fetchImpl: siFetch, clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: config.signin.googleRedirectUri, code: url.searchParams.get('code') || '', verifier: pend.verifier });
        const c = await signin.verifyIdToken(t.id_token, { jwks: googleKeys, iss: signin.GOOGLE_ISSUERS, aud: config.google.clientId, nonce: pend.nonce, now: now() });
        if (!(c.email_verified === true || c.email_verified === 'true')) throw err('Google has not verified this account\'s email address.', 401, 'unverified');
        o = await outcome(pend, { provider: 'google', sub: c.sub, email: c.email });
      } catch (e) { o = { kind: 'error', code: e.code, provider: 'google', message: e.message }; }
      return answerBrowser(res, pend, o);
    }
    // Sign in with Apple in the iPhone app: a nonce from here first, then Apple's identity token.
    if (POST && p === '/auth/signin/nonce') {
      const ip = ipOf(req);
      limiter.check(`sinonce:${ip}`, 30 * loose, 600_000);
      limiter.add(`sinonce:${ip}`, 600_000);
      const nonce = signin.randomToken();
      flows.put('nonce', {}, nonce);
      return send(res, 200, { nonce, hashed: signin.sha256hex(nonce) });
    }
    if (POST && p === '/auth/signin/apple/native') {
      const ip = ipOf(req);
      limiter.check(`sinative:${ip}`, 30 * loose, 600_000);
      limiter.add(`sinative:${ip}`, 600_000);
      const b = await readJson(req);
      if (!flows.take('nonce', typeof b.nonce === 'string' ? b.nonce : '')) throw err('This sign-in has expired. Start again.', 410, 'nonce_gone');
      const c = await signin.verifyIdToken(b.identityToken, { jwks: appleKeys, iss: signin.APPLE_ISSUER, aud: config.signin.appleBundleId, nonce: signin.sha256hex(b.nonce), now: now() });
      const att = {};
      if (b.link === true) {
        if (!user || user.apiKey) throw err('Sign in first.', 401, 'not_logged_in');
        att.linkUserId = user.id;
      }
      return answerJson(res, await outcome(att, { provider: 'apple', sub: c.sub, email: c.email }), b.tz);
    }
    // From an app: a ticket for the system browser, bound to a secret only the app holds; then polled.
    if (POST && p === '/auth/signin/ticket') {
      const ip = ipOf(req);
      limiter.check(`siticket:${ip}`, 30 * loose, 600_000);
      limiter.add(`siticket:${ip}`, 600_000);
      const b = await readJson(req);
      if (!signin.PROVIDERS.includes(b.provider)) throw err('provider must be google or apple.');
      const secret = typeof b.secret === 'string' ? b.secret : '';
      if (secret.length < 20 || secret.length > 200) throw err('secret must be 20 to 200 characters.');
      let linkUserId = null;
      if (b.link === true) {
        if (!user || user.apiKey) throw err('Sign in first.', 401, 'not_logged_in');
        linkUserId = user.id;
      }
      const ticket = flows.put('ticket', { provider: b.provider, secretHash: signin.sha256hex(secret), linkUserId, started: false, result: null });
      return send(res, 200, { ticket, path: `/auth/signin/${b.provider}/start?ticket=${ticket}`, expiresIn: signin.FLOW_MS / 1000 });
    }
    if (POST && p === '/auth/signin/ticket/poll') {
      const ip = ipOf(req);
      limiter.check(`sipoll:${ip}`, 400 * loose, 600_000);
      limiter.add(`sipoll:${ip}`, 600_000);
      const b = await readJson(req);
      const key = typeof b.ticket === 'string' ? b.ticket : '';
      const t = flows.peek('ticket', key);
      if (!t || typeof b.secret !== 'string' || signin.sha256hex(b.secret) !== t.secretHash) throw err('This sign-in has expired. Start again.', 410, 'ticket_gone');
      if (!t.result) return send(res, 200, { state: 'waiting' });
      flows.drop('ticket', key);
      return answerJson(res, t.result, b.tz);
    }
    // Somebody new, back from Google or Apple: who they signed in as, for the username step.
    if (GET && p === '/auth/signin/pending') {
      const pend = flows.peek('pending', url.searchParams.get('k') || '');
      if (!pend) throw err('This sign-up has expired. Start again with Google or Apple.', 410, 'pending_gone');
      return send(res, 200, { provider: pend.provider, email: pend.email });
    }
    // …and the account made: their username, the Terms accepted, the identity linked.
    if (POST && p === '/auth/signin/complete') {
      const ip = ipOf(req);
      limiter.check(`signup:${ip}`, 10 * loose, 3_600_000);
      const b = await readJson(req);
      const key = typeof b.pending === 'string' ? b.pending : '';
      const pend = flows.peek('pending', key);
      if (!pend) throw err('This sign-up has expired. Start again with Google or Apple.', 410, 'pending_gone');
      if (!app.registrationOpen()) throw err('Registration is closed', 403, 'closed');
      if (b.accept !== true) throw err('Tick the box to go on: you need to be 18 or older and accept the Terms.', 400, 'accept');
      if (signin.identityOwner(app, pend.provider, pend.sub)) {
        flows.drop('pending', key);
        throw err(`This ${signin.PROVIDER_NAME[pend.provider]} account already has a rep. account. Sign in instead.`, 409, 'identity_taken');
      }
      const r = await accounts.create({ username: b.username });
      try { signin.linkIdentity(app, { provider: pend.provider, sub: pend.sub, userId: r.user.id, email: pend.email, now: now() }); } catch (e) { await accounts.deleteUser(r.user.id); throw e; }
      flows.drop('pending', key);
      limiter.add(`signup:${ip}`, 3_600_000);
      log(`account made with ${pend.provider}: ${r.user.username}`);
      // The sign-up box: 18 or older, and the Terms and Privacy accepted (consent.js).
      if (ensureProfile(r.user, b.tz)) app.patchProfile(r.user.id, { consent: withConsent({}, 'terms', now()) });
      return send(res, 200, { user: r.user }, { 'set-cookie': accounts.setCookie(r.token) });
    }
    // The demo's stand-in for Google's and Apple's own pages (fake-sources.js fakeSignin).
    const demoSi = demoSignin && GET && /^\/demo\/signin\/(google|apple)$/.exec(p);
    if (demoSi) return sendHtml(res, 200, demoSignin.demoPage(demoSi[1], url.href));

    /* Connecting Google from the phone app (shared.js googleInSafari): Google will not sign in
       inside an app, so it happens in the phone's browser, which has its own rep. sign-in, or none,
       or another person's. A one-time handoff ties the attempt to the app's account instead: the
       browser needs no sign-in, and whoever it is signed in as does not matter (before this,
       Google was connected to whichever account the browser had, and the app never saw it). */
    if (POST && p === '/api/google/handoff') {
      if (!user || user.apiKey) return send(res, 401, { error: 'Sign in first.', code: 'unauthorized' });
      if (!ensureProfile(user)) return send(res, 403, { error: 'Registration is closed', code: 'forbidden' });
      const b = await readJson(req);
      for (const [k, v] of oauth) if (now() - v.at > 10 * 60_000) oauth.delete(k);
      const token = randomBytes(24).toString('base64url');
      oauth.set(`ho:${token}`, { kind: 'handoff', userId: user.id, at: now() });
      const q = new URLSearchParams({ handoff: token });
      const g = cleanGroups(b.groups);
      if (g.length) q.set('groups', g.join(','));
      return send(res, 200, { path: `/auth/google/start?${q}` });
    }
    if (GET && p === '/auth/google/start') {
      let back = safeBack(url.searchParams.get('return'));
      let user = user0;
      let handoff = false;
      const ho = url.searchParams.get('handoff');
      if (ho) {
        const h = oauth.get(`ho:${ho}`);
        oauth.delete(`ho:${ho}`);
        const pr = h && now() - h.at <= 10 * 60_000 ? app.profile(h.userId) : null;
        if (!pr) return sendHtml(res, 410, handoffPage({ ok: false, title: 'This link has expired', text: 'Go back to the rep. app and tap Connect Google again.' }));
        user = { id: pr.userId, username: pr.username, token: `handoff:${ho}` };
        handoff = true;
        back = '/settings/connections';
      }
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
      oauth.set(state, { userId: user.id, sid: sid(user.token), handoff, verifier, back, at: now(), groups: asked, account });
      // `pick=1`: the main account swapped for another (the one signed in has no Google Health): Google's chooser, nothing suggested.
      const pick = url.searchParams.get('pick') === '1';
      // Never connected yet: the Google account they sign in with, so connecting is one tap.
      const hint = account === 'new' || pick ? null : (w.accounts.get(account).google.status().email || signin.googleEmailOf(app, user.id));
      // Route maps (groups=routes): the location scope, asked only when chosen, and again on a reconnect once allowed.
      const acctG = account === 'new' ? null : w.accounts.get(account).google;
      const routes = String(url.searchParams.get('groups') || '').split(',').includes('routes') || Boolean(acctG?.granted?.(LOCATION_SCOPE));
      return redirect(res, w.google.authUrl({ state, challenge, groups, routes, chooser: account === 'new' || pick, loginHint: hint }));
    }
    if (GET && p === '/auth/google/callback') {
      const state = url.searchParams.get('state') || '';
      const pend = oauth.get(state);
      oauth.delete(state);
      const back = pend?.back || '/settings/connections';
      // From the app's handoff: the account is the app's (the state, single use and ten minutes
      // long, is what ties it); the browser's own sign-in plays no part. The answer is a page
      // saying which account was connected, with the way back to the app.
      if (pend?.handoff) {
        const pr = app.profile(pend.userId);
        if (!pr || now() - pend.at > 10 * 60_000) return sendHtml(res, 410, handoffPage({ ok: false, title: 'This link has expired', text: 'Go back to the rep. app and tap Connect Google again.' }));
        const denied = url.searchParams.get('error');
        if (denied) return sendHtml(res, 200, handoffPage({ ok: false, title: denied === 'access_denied' ? 'Not connected' : 'Google said no', text: denied === 'access_denied' ? 'Nothing was connected. Go back to the rep. app to try again.' : `Google said: ${denied.slice(0, 80)}. Go back to the rep. app to try again.` }));
        try {
          await worlds.hold(pr.userId, async (w) => {
            const r = await w.connectAccount(pend.account, (g) => g.exchange({ code: url.searchParams.get('code') || '', verifier: pend.verifier }));
            if (pend.groups?.length && r.id === w.primaryId) w.setGroups(pend.groups);
            app.patchProfile(pr.userId, { googleState: 'ok', syncError: null });
          });
        } catch (e) {
          return sendHtml(res, 200, handoffPage({ ok: false, title: 'Google could not be connected', text: `${String(e.message).slice(0, 200)} Go back to the rep. app to try again.` }));
        }
        log(`google connected by app handoff: ${pr.username}`);
        scheduler.poke(pr.userId);
        syncUser(pr.userId, { force: true }).then((r) => scheduler.settle(app.profile(pr.userId) || { userId: pr.userId }, r)).catch((e) => log(`first sync: ${e.message}`));
        changed(pr.userId, ['me']);
        return sendHtml(res, 200, handoffPage({ ok: true, title: 'Google is connected', text: 'Go back to the rep. app: your data starts coming in now.', account: pr }));
      }
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
    // Connect with OpenRouter (ownai.js): its own sign-in hands over a key of the person's own.
    if (GET && p === '/auth/openrouter/start') {
      if (!user || !ensureProfile(user)) return redirect(res, '/');
      const { url: to, verifier } = openRouterAuthUrl(`${config.origin}/auth/openrouter/callback`);
      for (const [k, v] of oauth) if (now() - v.at > 10 * 60_000) oauth.delete(k);
      oauth.set(`or:${user.id}`, { kind: 'openrouter', userId: user.id, verifier, at: now() });
      return redirect(res, to);
    }
    if (GET && p === '/auth/openrouter/callback') {
      if (!user) return redirect(res, '/');
      const o = oauth.get(`or:${user.id}`);
      oauth.delete(`or:${user.id}`);
      const code = url.searchParams.get('code') || '';
      if (!o || !code || now() - o.at > 10 * 60_000) return redirect(res, '/settings/api?ai=error');
      try {
        const key = await openRouterExchange({ code, verifier: o.verifier, fetchImpl: ownAiFetch || globalThis.fetch });
        const cfg = { provider: 'openrouter', key, model: OWN_AI.openrouter.model, base: null };
        app.setSecret(user.id, 'ai', vault.seal(JSON.stringify(cfg), `${user.id}:ai`), key.slice(-4));
        changed(user.id, ['me', 'ai']);
        return redirect(res, '/settings/api?ai=connected');
      } catch (e) { log(`openrouter: ${e.message}`); return redirect(res, '/settings/api?ai=error'); }
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
        // Strava lets a new app serve only a few athletes until its owner raises the limit.
        if (/limit|capacity|athlete/i.test(String(e.message))) {
          log(`strava: athlete limit reached when ${user.id} connected: ${e.message}`);
          return redirect(res, backWith(back, { strava: 'error', message: 'Strava is not letting more people connect to this site yet (its limit for new apps). The site\'s owner has to raise it; your watch\'s runs still arrive through Google Health.' }));
        }
        return redirect(res, backWith(back, { strava: 'error', message: String(e.message).slice(0, 200) }));
      }
      ensureStravaWebhook().catch(() => {});
      scheduler.poke(user.id);
      worlds.hold(user.id, (w) => syncExtras(user.id, w, { force: true, only: 'strava' })).catch((e) => log(`strava first sync: ${e.message}`));
      changed(user.id, ['me']);
      return redirect(res, backWith(back, { strava: 'connected' }));
    }
    if (GET && p === '/auth/withings/start') {
      const back = safeBack(url.searchParams.get('return'));
      if (!user) return redirect(res, '/');
      if (!ensureProfile(user)) return redirect(res, backWith(back, { withings: 'error', message: 'Registration is closed' }));
      if (!withingsOn()) return redirect(res, backWith(back, { withings: 'error', message: 'Withings is not set up on this server yet' }));
      const state = createHash('sha256').update(`${user.id}:${now()}:${Math.random()}`).digest('hex').slice(0, 40);
      for (const [k, v] of oauth) if (now() - v.at > 10 * 60_000) oauth.delete(k);
      oauth.set(state, { kind: 'withings', userId: user.id, sid: sid(user.token), back, at: now() });
      const q = new URLSearchParams({ response_type: 'code', client_id: config.withings.clientId, scope: WITHINGS_SCOPES, redirect_uri: config.withings.redirectUri, state });
      return redirect(res, `${withingsUrls?.auth || WITHINGS_AUTH}?${q}`);
    }
    if (GET && p === '/auth/withings/callback') {
      const state = url.searchParams.get('state') || '';
      const pend = oauth.get(state);
      oauth.delete(state);
      const back = pend?.back || '/settings/connections/devices/scale/withings';
      if (!pend || pend.kind !== 'withings' || !user || pend.userId !== user.id || pend.sid !== sid(user.token) || now() - pend.at > 10 * 60_000) {
        return redirect(res, backWith(back, { withings: 'error', message: 'This sign-in link has expired. Start again.' }));
      }
      const denied = url.searchParams.get('error');
      if (denied) return redirect(res, backWith(back, denied === 'access_denied' ? { withings: 'cancelled' } : { withings: 'error', message: `Withings said: ${denied.slice(0, 80)}` }));
      if (!withingsOn()) return redirect(res, backWith(back, { withings: 'error', message: 'Withings is not set up on this server yet' }));
      try {
        // Withings' code lasts 30 seconds: swapped at once.
        const r = await withingsExchange({ clientId: config.withings.clientId, clientSecret: config.withings.clientSecret, code: url.searchParams.get('code') || '', redirectUri: config.withings.redirectUri, fetchImpl: withingsFetch || globalThis.fetch, base: withingsUrls?.api || undefined, now: now() });
        if (r.userId) {
          const had = withingsUsers()[r.userId];
          if (had && had !== user.id && app.profile(had)) return redirect(res, backWith(back, { withings: 'error', message: 'That Withings account is already connected to another rep. account.' }));
        }
        keepWithingsTokens(user.id, { ...r.tokens, userId: r.userId });
        if (r.userId) setWithingsUser(r.userId, user.id);
        await worlds.hold(user.id, async (w) => {
          const m = withingsMeta(w.db);
          const same = m.userId && m.userId === r.userId;
          setWithingsMeta(w.db, { userId: r.userId, scope: r.scope || null, connectedAt: same && m.connectedAt ? m.connectedAt : now(), lost: null, lastError: null, ...(same ? {} : { cursor: null, checkedAt: null }) });
        });
      } catch (e) {
        return redirect(res, backWith(back, { withings: 'error', message: String(e.message).slice(0, 200) }));
      }
      scheduler.poke(user.id);
      worlds.hold(user.id, async (w) => {
        // Told at once of each new weigh-in, from now on.
        const api = withingsApiFor(user.id);
        if (api && withingsNotifyUrl()) { try { await api.subscribe(withingsNotifyUrl()); setWithingsMeta(w.db, { notify: now() }); } catch (e) { log(`withings subscribe: ${e.message}`); } }
        const r = await syncExtras(user.id, w, { force: true, only: 'withings' });
        if (r.withings) await afterSync(user.id, null);
      }).catch((e) => log(`withings first sync: ${e.message}`));
      changed(user.id, ['me']);
      return redirect(res, backWith(back, { withings: 'connected' }));
    }
    if (GET && p === '/auth/whoop/start') {
      const back = safeBack(url.searchParams.get('return'));
      if (!user) return redirect(res, '/');
      if (!ensureProfile(user)) return redirect(res, backWith(back, { whoop: 'error', message: 'Registration is closed' }));
      if (!whoopOn()) return redirect(res, backWith(back, { whoop: 'error', message: 'WHOOP is not set up on this server yet' }));
      const state = createHash('sha256').update(`${user.id}:${now()}:${Math.random()}`).digest('hex').slice(0, 40);
      for (const [k, v] of oauth) if (now() - v.at > 10 * 60_000) oauth.delete(k);
      oauth.set(state, { kind: 'whoop', userId: user.id, sid: sid(user.token), back, at: now() });
      const q = new URLSearchParams({ client_id: config.whoop.clientId, redirect_uri: config.whoop.redirectUri, response_type: 'code', scope: WHOOP_SCOPES, state });
      return redirect(res, `${whoopUrls?.auth || WHOOP_AUTH}?${q}`);
    }
    if (GET && p === '/auth/whoop/callback') {
      const state = url.searchParams.get('state') || '';
      const pend = oauth.get(state);
      oauth.delete(state);
      const back = pend?.back || '/settings/connections/accounts/whoop';
      if (!pend || pend.kind !== 'whoop' || !user || pend.userId !== user.id || pend.sid !== sid(user.token) || now() - pend.at > 10 * 60_000) {
        return redirect(res, backWith(back, { whoop: 'error', message: 'This sign-in link has expired. Start again.' }));
      }
      const denied = url.searchParams.get('error');
      if (denied) return redirect(res, backWith(back, denied === 'access_denied' ? { whoop: 'cancelled' } : { whoop: 'error', message: `WHOOP said: ${denied.slice(0, 80)}` }));
      if (!whoopOn()) return redirect(res, backWith(back, { whoop: 'error', message: 'WHOOP is not set up on this server yet' }));
      try {
        const r = await whoopExchange({ clientId: config.whoop.clientId, clientSecret: config.whoop.clientSecret, code: url.searchParams.get('code') || '', redirectUri: config.whoop.redirectUri, fetchImpl: whoopFetch || globalThis.fetch, now: now(), ...(whoopUrls?.token ? { tokenUrl: whoopUrls.token } : {}) });
        keepWhoopTokens(user.id, r.tokens);
        // Who this is on WHOOP: for the page, and to find them when a webhook names them.
        let who = null;
        try { const pr = await whoopApiFor(user.id)?.profile(); if (pr?.user_id) who = { id: String(pr.user_id), name: [pr.first_name, pr.last_name].filter(Boolean).join(' ').slice(0, 80) || null }; } catch (e) { log(`whoop profile: ${e.message}`); }
        if (who) {
          const had = whoopUsers()[who.id];
          if (had && had !== user.id && app.profile(had)) {
            app.deleteSecret(user.id, 'whoop');
            return redirect(res, backWith(back, { whoop: 'error', message: 'That WHOOP account is already connected to another rep. account.' }));
          }
          setWhoopUser(who.id, user.id);
        }
        await worlds.hold(user.id, async (w) => {
          const m = whoopMeta(w.db);
          setWhoopMeta(w.db, { connected: true, user: who, scope: r.scope || null, connectedAt: m.connectedAt || now(), lost: null, lastError: null, retryAt: null, failures: 0 });
        });
      } catch (e) {
        return redirect(res, backWith(back, { whoop: 'error', message: String(e.message).slice(0, 200) }));
      }
      scheduler.poke(user.id);
      worlds.hold(user.id, async (w) => {
        const r = await syncExtras(user.id, w, { force: true, only: 'whoop' });
        if (r.whoop) await afterSync(user.id, null);
      }).catch((e) => log(`whoop first sync: ${e.message}`));
      changed(user.id, ['me']);
      return redirect(res, backWith(back, { whoop: 'connected' }));
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
    // How the rank works (rating.js): the tiers, what counts and its par.
    if (GET && p === '/api/rank/ladder') return send(res, 200, ladder());
    if (GET && (mm = /^\/api\/users\/([^/]{1,40})$/.exec(p))) {
      // A public profile is open to anybody, signed out too; a private one is not even found signed out.
      const prof = social.publicProfile(app, { username: decodeURIComponent(mm[1]), viewerId: user?.id || null, now: now() });
      if (!prof) throw err('There is no such profile.', 404);
      if (prof.limited) return send(res, 200, { ...prof, programmes: [] });
      // The routines and programmes they share (sharedlib.js), to look at and add to your own.
      const owner = app.profileByName(decodeURIComponent(mm[1]));
      const shared = owner ? browseShared(app, user?.id || null, { userId: owner.userId }) : [];
      // Rank (rating.js) with activity; honours from circles (challenges.js) with activity or workouts.
      const rank = owner && prof.sections.activity ? ratingOf(app, owner.userId, now()) : null;
      const honours = owner && (prof.sections.activity || prof.sections.workouts) ? challenges.honours(app, owner.userId, user?.id || null) : null;
      const nowIs = !owner || !user ? null : owner.userId === user.id ? (presenceOn(owner) ? selfNow(owner) : null) : nowFor(lensOf(app, user.id), owner);
      return send(res, 200, { ...prof, programmes: shared, rank, honours, now: nowIs });
    }
    if ((GET || m === 'HEAD') && (mm = /^\/media\/(m_[0-9a-f]{10})(\/thumb)?$/.exec(p))) return serveMedia(req, res, user, mm[1], !!mm[2]);

    if (!p.startsWith('/api/')) throw err('Not found', 404);

    /* ── everything below is for the signed-in person ── */

    if (!user) throw err('Not logged in', 401, 'not_logged_in');
    const profile = ensureProfile(user);
    if (!profile) throw err('Registration is closed', 403, 'closed');
    const uid = user.id;
    // Suspended by an admin after reports (safety.js): nothing but /api/me, which says so.
    if (!isAdmin(user) && (app.meta('suspended', {}) || {})[uid] && p !== '/api/me') throw err('This account is suspended after reports. Write to contact@ojee.net.', 403, 'suspended');

    // How this account signs in (signin.js): its Google and Apple, and taking one away while the other stays.
    if (GET && p === '/api/signin') return send(res, 200, signinView(user));
    if (POST && p === '/api/signin/unlink') {
      if (user.apiKey) throw err('Sign-in methods are changed in the app.', 403, 'not_allowed');
      const b = await readJson(req);
      signin.unlinkIdentity(app, uid, b.provider);
      log(`${b.provider} sign-in unlinked from ${user.username}`);
      changed(uid, ['me']);
      return send(res, 200, signinView(user));
    }
    // An account from before Google and Apple links one first: until then, only what that takes.
    if (!user.apiKey && !/^\/api\/(me|events|client-error)$/.test(p) && needsLink(user)) throw err('Link Google or Apple to keep signing in.', 403, 'link_required');

    if (p.startsWith('/api/admin')) {
      if (!isAdmin(user)) throw err('Admins only.', 403, 'forbidden');
      if (GET && p === '/api/admin') return send(res, 200, adminPayload());
      // Reports (safety.js): remove what was reported, or dismiss it.
      if (POST && p === '/api/admin/unsuspend') {
        const b = await readJson(req);
        const who = app.profileByName(String(b.username || '').trim());
        if (!who) throw err('There is no such profile.', 404, 'not_found');
        safety.suspend(app, who.userId, false);
        log(`admin ${user.username} let ${who.username} back`);
        return send(res, 200, adminPayload());
      }
      if (POST && (mm = /^\/api\/admin\/reports\/(rp_[0-9a-f]{12})$/.exec(p))) {
        const b = await readJson(req);
        safety.resolveReport(app, { id: mm[1], action: b.action, by: uid, now: now() });
        log(`admin ${user.username} ${b.action === 'remove' ? 'removed' : 'dismissed'} report ${mm[1]}`);
        for (const pr of app.profiles()) if (isAdmin({ username: pr.username })) changed(pr.userId, ['admin']);
        return send(res, 200, adminPayload());
      }
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
        const out = await media.finish(uid, mm[1], { postOk: (pid) => { try { return !!ownPost(pid); } catch { return false; } } });
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
        if (b.boardWeek !== undefined) { if (!['shared', 'own'].includes(b.boardWeek)) throw err('boardWeek must be "shared" or "own".'); patch.boardWeek = b.boardWeek; }
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
        changed(uid, patch.boardWeek !== undefined ? ['me', 'social'] : ['me']);
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
          // The account (public / private) and an audience per kind (audience.js); true and false from older apps read as 'everyone' and 'me'.
          if (!b.privacy || typeof b.privacy !== 'object' || Array.isArray(b.privacy)) throw err('privacy must be an object.');
          const pv = { ...PRIVACY_DEFAULT, ...profile.privacy };
          if (b.privacy.account !== undefined && !['public', 'private'].includes(b.privacy.account)) throw err('privacy.account must be public or private.');
          if (b.privacy.account !== undefined) pv.account = b.privacy.account;
          for (const k of KINDS) {
            const v = b.privacy[k];
            if (v === undefined) continue;
            if (typeof v !== 'boolean' && !AUDIENCES.includes(v)) throw err(`privacy.${k} must be one of ${AUDIENCES.join(', ')}.`);
            pv[k] = audienceOf(v);
          }
          if (b.privacy.feed !== undefined) { if (typeof b.privacy.feed !== 'boolean') throw err('privacy.feed must be true or false.'); pv.feed = b.privacy.feed; }
          if (b.privacy.workoutHr !== undefined) { if (typeof b.privacy.workoutHr !== 'boolean') throw err('privacy.workoutHr must be true or false.'); pv.workoutHr = b.privacy.workoutHr; }
          if (b.privacy.nowMap !== undefined) { if (typeof b.privacy.nowMap !== 'boolean') throw err('privacy.nowMap must be true or false.'); pv.nowMap = b.privacy.nowMap; }
          if (b.privacy.nowDetail !== undefined) { if (typeof b.privacy.nowDetail !== 'boolean') throw err('privacy.nowDetail must be true or false.'); pv.nowDetail = b.privacy.nowDetail; }
          if (b.privacy.presence !== undefined) {
            if (![true, false, 'auto'].includes(b.privacy.presence)) throw err('privacy.presence must be true, false or auto.');
            pv.presence = b.privacy.presence;
          }
          patch.privacy = pv;
        }
        if (b.goals !== undefined) {
          const g = {};
          const goal = (k, to, lo, hi) => { if (b.goals?.[k] !== undefined) { const n = Math.round(Number(b.goals[k])); if (!(n >= lo && n <= hi)) throw err(`goals.${k} must be ${lo}-${hi}.`); g[to] = n; } };
          goal('steps', 'stepTarget', 1000, 50_000); goal('activeMinutes', 'azmTarget', 5, 240); goal('sleepMinutes', 'sleepTarget', 240, 720);
          goal('cardioWeek', 'cardioTarget', 30, 600); goal('waterMl', 'waterTarget', 500, 6000);
          // A number set by hand stops the cardio target adjusting itself; cardioAuto: true starts it again.
          if (g.cardioTarget !== undefined) g.cardioAuto = false;
          if (b.goals?.cardioAuto !== undefined) { if (typeof b.goals.cardioAuto !== 'boolean') throw err('goals.cardioAuto must be true or false.'); g.cardioAuto = b.goals.cardioAuto; }
          // A wake-up time to plan bedtime from: "HH:MM", or null to go by the usual wake time.
          if (b.goals?.wakeTime !== undefined) {
            const wt = b.goals.wakeTime;
            const mt = wt === null ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(wt));
            if (wt !== null && !mt) throw err('goals.wakeTime must be "HH:MM" or null.');
            g.wakeTarget = mt ? Number(mt[1]) * 60 + Number(mt[2]) : null;
          }
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
        if (b.training !== undefined) {
          // The rest timer: on or off in every workout, and how long it is for an exercise added new.
          if (!b.training || typeof b.training !== 'object' || Array.isArray(b.training)) throw err('training must be { restOn, restS }.');
          const cur = trainingOf(w);
          if (b.training.restOn !== undefined) { if (typeof b.training.restOn !== 'boolean') throw err('training.restOn must be true or false.'); cur.restOn = b.training.restOn; }
          if (b.training.restS !== undefined) { if (!REST_CHOICES.includes(b.training.restS)) throw err(`training.restS must be one of ${REST_CHOICES.join(', ')}.`); cur.restS = b.training.restS; }
          // How precise: sets and reps everywhere, or exercises only (no counts on routines, workouts or posts).
          if (b.training.detail !== undefined) { if (!['sets', 'exercises'].includes(b.training.detail)) throw err('training.detail must be sets or exercises.'); cur.detail = b.training.detail; }
          w.db.setMeta('training', cur);
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
        // Posts say what they show by these too: rewritten now.
        if (patch.privacy || patch.stepGoal || b.training?.detail !== undefined) await publish(uid, { announce: false });
        changed(uid, ['me', 'data', 'social']);
        return me();
      }

      /* ── data ── */

      if (GET && p === '/api/data') return send(res, 200, { ...views.dataView(w, { days: clamp(Math.round(Number(url.searchParams.get('days')) || 30), 7, 90) }), live: live.latest(uid) });
      if (GET && p === '/api/trends') {
        const d = Number(url.searchParams.get('days'));
        return send(res, 200, views.trendsView(w, { days: [7, 30, 90, 180, 365].includes(d) ? d : 30, noStrava: !!user.apiKey }));
      }
      if (GET && p === '/api/brief') return send(res, 200, views.briefView(w, { noStrava: !!user.apiKey }));
      if (GET && p === '/api/widget') {
        const v = views.widgetView(w);
        // Where you stand on this week's steps, for the leaderboard widget. Same
        // public board as /ranks, read-time privacy already applied in social.js.
        try {
          const lb = social.leaderboard(app, { metric: 'steps', period: 'week', scope: 'everyone', viewerId: uid, now: now() });
          v.board = {
            metric: lb.label, period: lb.periodLabel, of: lb.total,
            me: lb.me && lb.me.listed ? { rank: lb.me.rank, value: lb.me.value } : null,
            top: (lb.entries || []).slice(0, 3).map((e) => ({ name: e.displayName || e.username, value: e.value, me: !!e.me })),
          };
        } catch { v.board = null; }
        return send(res, 200, v);
      }
      if (GET && p === '/api/day') {
        const v = await views.dayView(w, url.searchParams.get('date'));
        // Naps are read fresh (the day itself may be kept a while): they end on this day (core/naps.js).
        return send(res, 200, { ...v, naps: napsOn(w.db, v.date) });
      }
      // Naps over a period, with what they add up to and what they say (core/naps.js).
      if (GET && p === '/api/naps') {
        const days = Math.max(7, Math.min(365, Number(url.searchParams.get('days')) || 30));
        return send(res, 200, napsReport(w.db, { today: todayU(now(), w.tz), days }));
      }

      /* ── every metric: Browse, one metric, pins ── */

      if (GET && p === '/api/browse') return send(res, 200, browseView(w));
      if (GET && (mm = /^\/api\/metric\/([a-z0-9_]{1,40})$/.exec(p))) {
        const q = url.searchParams;
        return send(res, 200, await metricView(w, mm[1], { range: q.get('range') || 'week', end: q.get('end'), before: q.get('before'), hours: views.dayView, noStrava: !!user.apiKey }));
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
      /* ── a fault on somebody's screen, for the log (main.js report) ── */
      if (POST && p === '/api/client-error') {
        limiter.check(`cerr:${uid}`, 20, 600_000);
        limiter.add(`cerr:${uid}`, 600_000);
        const b = await readJson(req).catch(() => ({}));
        const t = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' | ').slice(0, n);
        log(`client error ${String(uid).slice(-6)} ${t(b.where, 20)} ${t(b.path, 80)} build ${t(b.build, 20)}: ${t(b.message, 300)} :: ${t(b.stack, 900)}`);
        return send(res, 200, { ok: true });
      }

      /* ── the weather on Today (weather.js) ── */
      if (GET && p === '/api/weather') {
        const point = pointOf(url.searchParams.get('lat'), url.searchParams.get('lon'));
        const w0 = await weather.forProfile(app.profile(uid), { point }).catch((e) => { if (e.code === 'upstream') return { unavailable: true }; throw e; });
        return send(res, 200, { weather: w0?.unavailable ? null : w0, unavailable: !!w0?.unavailable });
      }

      /* ── music on a post (music.js) ── */
      if (GET && p === '/api/music/search') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
        limiter.check(`music:${uid}`, 40 * loose, 60_000);
        limiter.add(`music:${uid}`, 60_000);
        const r = await music.search(q);
        const out = (x) => ({ ...musicView(x), pick: { deezer: x.id } });
        return send(res, 200, { q, tracks: r.tracks.map(out), albums: r.albums.map(out), source: 'Deezer' });
      }
      if (GET && p === '/api/music/resolve') {
        limiter.check(`music:${uid}`, 40 * loose, 60_000);
        limiter.add(`music:${uid}`, 60_000);
        const link = String(url.searchParams.get('url') || '').trim().slice(0, 600);
        return send(res, 200, { item: { ...musicView(await music.resolve({ url: link })), pick: { url: link } } });
      }
      if (GET && (p === '/api/music/art' || p === '/api/music/preview')) {
        const art = p === '/api/music/art';
        const f = art ? await music.art(String(url.searchParams.get('u') || '')) : await music.preview(String(url.searchParams.get('p') || ''));
        const size = f.body.length;
        const headers = { ...baseHeaders, 'content-type': f.type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes', 'cross-origin-resource-policy': 'same-origin' };
        let start = 0; let end = size - 1; let status = 200;
        // Safari asks an <audio> for parts of it.
        const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
        if (!art && rg && (rg[1] !== '' || rg[2] !== '')) {
          if (rg[1] === '') start = Math.max(0, size - Number(rg[2]));
          else { start = Number(rg[1]); end = rg[2] === '' ? size - 1 : Math.min(Number(rg[2]), size - 1); }
          if (start > end || start >= size) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); return res.end(); }
          status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
        }
        res.writeHead(status, { ...headers, 'content-length': end - start + 1 });
        return res.end(req.method === 'HEAD' ? undefined : f.body.subarray(start, end + 1));
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
        for (const x of mine) { const l = libMatch(x.name); x.libId = l?.id || null; x.image = l ? libView(l).images[0] : null; x.source = x.templateId ? 'hevy' : 'yours'; x.type = exerciseTypeOf({ name: x.name, libId: x.libId, type: x.type }); }
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
        for (const s of hist) { const o = by.get(s.workoutId) || { t: s.t, topKg: null, reps: null, volume: 0, sets: 0 }; o.sets += 1; if (s.kg && s.reps) o.volume += s.kg * s.reps * (s.n || 1); if (s.kg && (!o.topKg || s.kg > o.topKg)) { o.topKg = s.kg; o.reps = s.reps; } by.set(s.workoutId, o); }
        return send(res, 200, { exercise: made ? cexView(app, made, uid, { full: true }) : libView(x, { full: true }), last: prev, history: [...by.entries()].slice(-30).map(([id, o]) => ({ workoutId: String(id), ...o, volume: Math.round(o.volume) })), source: LIBRARY_SOURCE });
      }
      if (GET && (mm = /^\/api\/media\/exercises\/([A-Za-z0-9_-]{1,100})\/(\d)\.jpg$/.exec(p))) {
        const buf = await exImages.get(mm[1], Number(mm[2]));
        if (!buf) throw err('No such picture.', 404);
        res.writeHead(200, { ...baseHeaders, 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=2592000, immutable' });
        return res.end(buf);
      }
      if (GET && (mm = /^\/api\/basemap\/(light|dark)\/style\.json$/.exec(p))) {
        const j = await basemap.style(mm[1]);
        if (!j) throw err('The map style could not be read just now.', 503, 'unavailable');
        return send(res, 200, j);
      }
      if (GET && p.startsWith('/api/basemap/f/')) {
        limiter.check(`basemap:${uid}`, 3000 * loose, 60_000);
        limiter.add(`basemap:${uid}`, 60_000);
        const f = await basemap.file(p.slice('/api/basemap/f/'.length));
        if (!f) throw err('No such map file.', 404);
        res.writeHead(200, { ...baseHeaders, 'content-type': f.type, 'content-length': f.buf.length, 'cache-control': 'private, max-age=604800' });
        return res.end(f.buf);
      }
      if (GET && (mm = /^\/api\/tiles\/(?:(light|dark)\/)?(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/.exec(p))) {
        limiter.check(`tiles:${uid}`, 600 * loose, 60_000);
        limiter.add(`tiles:${uid}`, 60_000);
        // For devices that cannot draw the vector map (map-raster.js): drawn here, or OpenStreetMap's.
        const buf = await tiles.get(Number(mm[2]), Number(mm[3]), Number(mm[4]), { theme: mm[1] || 'light' });
        if (!buf) throw err('No such map tile.', 404);
        res.writeHead(200, { ...baseHeaders, 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'private, max-age=604800' });
        return res.end(buf);
      }

      /* ── AI (ai.js): a section's summary, a question, the morning summary ── */

      // AI is off until the person turns it on, and reads only the kinds they allowed (consent.js).
      const aiAllow = () => {
        const c = app.profile(uid)?.consent;
        if (!c?.ai) throw err('Turn on AI summaries first, and choose what the AI may read.', 409, 'ai_consent');
        return c.ai.allow || {};
      };
      // The morning summary on Today: a job of its own (AiJobs), kept for the day.
      const aiStart = ({ topic, onDone }) => {
        aiAllow();
        const title = AI_TOPICS[topic] || AI_TOPICS.ask;
        return aiJobs.start(uid, {
          topic, title,
          cache: { get: (k) => answerCache(w.db).get(k), set: (k, v) => { worlds.hold(uid, (w2) => answerCache(w2.db).set(k, v)).catch(() => {}); } },
          onDone,
          writer: aiThreads.writerOf(uid),
          build: () => aiBuildFor(uid, { topic }),
        });
      };

      /* Your own AI (ownai.js): a key at a provider of your choice writes your answers instead. */
      if (p === '/api/ai/own') {
        const view1 = () => {
          const o = aiOwn(uid);
          return {
            using: aiUsing(uid),
            current: o ? { provider: o.provider, model: o.model, base: o.base || null, last4: app.secretRow(uid, 'ai')?.last4 || null } : null,
            providers: Object.entries(OWN_AI).map(([id, x]) => ({ id, label: x.label, model: x.model, keys: x.keys, ...(x.about ? { about: x.about } : {}), ...(x.models ? { models: x.models } : {}) })),
          };
        };
        if (GET) return send(res, 200, view1());
        if (POST) {
          const b = await readJson(req, 8 * 1024);
          limiter.check(`ownai:${uid}`, 10 * loose, 600_000);
          limiter.add(`ownai:${uid}`, 600_000);
          // Only the model changes: the key kept is used again.
          const had = aiOwn(uid);
          const key = b.key ? String(b.key) : had && had.provider === b.provider ? had.key : '';
          const cfg = await checkOwnAi({ provider: String(b.provider || ''), key, model: b.model, base: b.base }, { fetchImpl: ownAiFetch || globalThis.fetch });
          app.setSecret(uid, 'ai', vault.seal(JSON.stringify(cfg), `${uid}:ai`), cfg.key.slice(-4));
          changed(uid, ['me', 'ai']);
          return send(res, 200, view1());
        }
        if (m === 'DELETE') { app.deleteSecret(uid, 'ai'); changed(uid, ['me', 'ai']); return send(res, 200, view1()); }
      }

      /* The conversation (aithread.js): kept on the server, one request at a time, in order. */
      if (GET && p === '/api/ai/thread') return send(res, 200, { ...(await aiThreads.thread(uid, { limit: Math.min(200, Number(url.searchParams.get('limit')) || 60) })), using: aiUsing(uid) });
      if (m === 'DELETE' && p === '/api/ai/thread') { await aiThreads.clear(uid); return send(res, 200, { turns: [], running: false, using: aiUsing(uid) }); }
      if (POST && p === '/api/ai/stop') {
        const b = await readJson(req);
        await aiThreads.stop(uid, { id: b.id ? String(b.id) : null, all: b.all === true });
        return send(res, 200, { ...(await aiThreads.thread(uid)), using: aiUsing(uid) });
      }
      if (POST && (mm = /^\/api\/ai\/retry\/(ai[a-z0-9]{4,30})$/.exec(p))) {
        aiAllow();
        const t2 = await aiThreads.retry(uid, mm[1]);
        if (!t2) throw err('That request is gone. Ask again.', 404);
        return send(res, 200, { turn: t2, ...jobOf(t2) });
      }
      if (POST && p === '/api/ai') {
        const b = await readJson(req, 64 * 1024);
        const topic = AI_TOPICS[b.topic] ? b.topic : 'ask';
        const question = b.question ? String(b.question).trim().slice(0, 500) : null;
        if (topic === 'ask' && !question) throw err('Ask a question.');
        aiAllow();
        limiter.check(`ai:${uid}`, 30 * loose, 600_000);
        limiter.add(`ai:${uid}`, 600_000);
        const refId = b.id ? String(b.id).slice(0, 80) : null;
        const title = String(b.title || AI_TOPICS[topic] || 'Your question').slice(0, 80);
        const t2 = await aiThreads.add(uid, { kind: question ? 'question' : 'section', topic, refId, title, question });
        // The turn, and the same fields the job polling had (older pages follow GET /api/ai/:id).
        return send(res, 200, { turn: t2, ...jobOf(t2) });
      }
      if (GET && (mm = /^\/api\/ai\/(ai[a-z0-9]{4,30})$/.exec(p))) {
        const j = aiJobs.get(mm[1], uid);
        if (j) return send(res, 200, j);
        const t2 = await aiThreads.turn(uid, mm[1]);
        if (!t2) throw err('That request is gone. Ask again.', 404);
        if (t2.state === 'queued') await aiThreads.thread(uid);   // picked up again after a restart
        return send(res, 200, { turn: t2, ...jobOf(t2) });
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
        const aiOn = !!app.profile(uid)?.consent?.ai;
        const view1 = () => ({ date: today, answer: fresh && aiOn ? kept.answer : null, model: fresh && aiOn ? kept.model : null, due: aiOn && hour >= 4 && hour < 16 && night && !fresh, night, configured: writer.configured(), consent: aiOn });
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
          routine: { ...r, exercises: r.exercises.map((x) => ({ ...withDumbbell({ ...x, type: exerciseTypeOf(x) }), image: x.libId ? libView(libById(x.libId))?.images[0] || null : null, last: prev.get(x.name.toLowerCase())?.sets || null })) },
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
        // Planned with sets and reps, or exercises only: as the person keeps them, unless said.
        const r = cleanRoutine({ ...b, generic: typeof b?.generic === 'boolean' ? b.generic : trainingOf(w).detail === 'exercises' }, null, now());
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
      // Every routine to exercises only (or back): what they planned is kept, unused, for turning back.
      if (POST && p === '/api/routines/generic') {
        const b = await readJson(req);
        if (typeof b.generic !== 'boolean') throw err('generic must be true or false.');
        let n = 0;
        for (const r of w.db.routines()) if (!!r.generic !== b.generic) { r.generic = b.generic; r.updated = now(); w.db.routinePut(r); n += 1; }
        if (n) routinesChanged();
        return send(res, 200, { ...routinesPayload(), changed: n });
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
        // Its link, to send to someone (sharelink.js): asked for (made the first time), or turned off.
        if (sub === '/link') {
          if (GET) { const t = linkOf(app, uid, 'routine', r.id, { make: false }); return send(res, 200, { path: t ? linkPath(t) : null }); }
          if (POST) return send(res, 200, { path: linkPath(linkOf(app, uid, 'routine', r.id, { now: now() })) });
          if (m === 'DELETE') { linkOff(app, uid, 'routine', r.id); return send(res, 200, { path: null }); }
        }
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
          linkOff(app, uid, 'routine', r.id);
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
        return send(res, 200, { sets: lastSetsOf(w.db, url.searchParams.get('name')), note: w.db.exerciseNotes().get(String(url.searchParams.get('name') || '').toLowerCase()) || null });
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
        // toGoogle is retired (strava.js): always off.
        setStravaMeta(w.db, { settings: { ...stravaMeta(w.db).settings, ...cleanSwitches(b, STRAVA_DEFAULTS), toGoogle: false } });
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
        // What Strava brought goes with it (Strava's API agreement).
        await purgeStrava({ db: w.db, remove: (id) => w.workouts.remove(id), now: now() });
        setStravaMeta(w.db, { athlete: null, lost: null, lastError: null, cursor: null, connectedAt: null });
        changed(uid, ['me']);
        return send(res, 200, stravaPayload(w, uid));
      }

      /* ── Withings ── */

      if (GET && p === '/api/withings') return send(res, 200, withingsPayload(w, uid));
      if (POST && p === '/api/withings/sync') {
        if (!withingsConnected(uid)) throw err('Connect Withings first.', 409, 'needs_withings');
        throttle(`withingssync:${uid}`, 30_000 / loose, 'Withings was read less than half a minute ago.');
        const r = await syncExtras(uid, w, { force: true, only: 'withings' });
        if (r.withings) await afterSync(uid, null);
        const x = r.withings || null;
        return send(res, 200, { result: x && { ok: x.ok, code: x.code || null, message: x.ok ? null : x.message, added: x.added, updated: x.updated, removed: x.removed }, withings: withingsPayload(w, uid) });
      }
      if (POST && p === '/api/withings/disconnect') {
        const b = await readJson(req).catch(() => ({}));
        await dropWithings(uid, w, { keepData: b.keepData !== false });
        await afterAccounts(uid, w);
        changed(uid, ['me', 'data']);
        return send(res, 200, withingsPayload(w, uid));
      }

      /* ── WHOOP ── */

      if (GET && p === '/api/whoop') return send(res, 200, whoopPayload(w, uid));
      if (m === 'PATCH' && p === '/api/whoop/settings') {
        const b = await readJson(req);
        const cur = whoopMeta(w.db).settings;
        if (b.prefer !== undefined && !['whoop', 'google'].includes(b.prefer)) throw err('prefer must be whoop or google.');
        const next = { ...cur, ...(b.prefer !== undefined ? { prefer: b.prefer } : {}) };
        setWhoopMeta(w.db, { settings: next });
        if (next.prefer !== cur.prefer && w.whoopIn()) { w.merge(); await afterAccounts(uid, w); }
        changed(uid, ['me', 'data']);
        return send(res, 200, whoopPayload(w, uid));
      }
      if (POST && p === '/api/whoop/sync') {
        if (!whoopConnected(w, uid)) throw err('Connect WHOOP first.', 409, 'needs_whoop');
        throttle(`whoopsync:${uid}`, 30_000 / loose, 'WHOOP was read less than half a minute ago.');
        const r = await syncExtras(uid, w, { force: true, only: 'whoop' });
        if (r.whoop) await afterSync(uid, null);
        const x = r.whoop || null;
        return send(res, 200, { result: x && { ok: x.ok, code: x.code || null, message: x.ok ? null : x.message, days: x.days, nights: x.nights, workouts: x.workouts, removed: x.removed }, whoop: whoopPayload(w, uid) });
      }
      if (POST && p === '/api/whoop/disconnect') {
        // The grant goes back to WHOOP, and what WHOOP brought goes with it.
        await dropWhoop(uid, w);
        await afterAccounts(uid, w);
        changed(uid, ['me', 'data', 'workouts']);
        return send(res, 200, whoopPayload(w, uid));
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

      /* ── Samsung Health (Health Connect on an Android phone), sent by the app (hcsync.js) ── */

      if (GET && p === '/api/hc') return send(res, 200, hcPayload(w));
      if (POST && p === '/api/hc/connect') {
        const b = await readJson(req);
        setHcMeta(w.db, { connected: true, kept: false, connectedAt: hcMeta(w.db).connectedAt || now(), device: b.device ? String(b.device).slice(0, 60) : null });
        changed(uid, ['me']);
        return send(res, 200, hcPayload(w));
      }
      if (POST && p === '/api/hc/upload') {
        if (!w.hcOn()) throw err('Connect Samsung Health first.', 409, 'needs_hc');
        limiter.check(`hcup:${uid}`, 120 * loose, 600_000);
        limiter.add(`hcup:${uid}`, 600_000);
        const b = await readJson(req, 4 * 1024 * 1024);
        const r = applyHc({ main: w.db, src: w.hcDb(), body: b, tz: w.tz, now: now() });
        // Folded in with everything else; the derived numbers, the boards and the posts follow.
        if (r.wrote || r.workouts || r.nights || r.days) {
          w.merge();
          if (b.last !== false) await afterSync(uid, null);
        }
        return send(res, 200, { result: r, hc: hcPayload(w) });
      }
      if (m === 'PATCH' && p === '/api/hc/settings') {
        const b = await readJson(req);
        const cur = hcMeta(w.db).settings;
        if (b.prefer !== undefined && !['hc', 'google'].includes(b.prefer)) throw err('prefer must be hc or google.');
        const next = { ...cur, ...(b.prefer ? { prefer: b.prefer } : {}) };
        setHcMeta(w.db, { settings: next });
        if (next.prefer !== cur.prefer && w.hcIn()) { w.merge(); await afterAccounts(uid, w); }
        return send(res, 200, hcPayload(w));
      }
      if (POST && p === '/api/hc/disconnect') {
        const b = await readJson(req);
        const keep = b.keepData !== false;
        setHcMeta(w.db, { connected: false, kept: keep, ...(keep ? {} : { lastUpload: null, lastResult: null, connectedAt: null }) });
        w.dropHc({ keepData: keep });
        await afterAccounts(uid, w);
        changed(uid, ['me', 'data', 'workouts']);
        return send(res, 200, hcPayload(w));
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

      const listArgs = () => ({ limit: clamp(Math.round(Number(url.searchParams.get('limit')) || 40), 1, 100), before: url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null, kind: url.searchParams.get('kind') ? String(url.searchParams.get('kind')).slice(0, 40) : null, noStrava: !!user.apiKey });
      /** A workout changed here: Google and Hevy hear of it now, not at the next sync. */
      const toHevySoon = () => { if (hevyMeta(w.db).connected) syncExtras(uid, w, { only: 'hevy' }).catch((e) => log(`hevy: ${e.message}`)); };
      const afterWorkout = async () => {
        presenceWorkout(uid, w);
        w.workouts.flush().catch((e) => log(`flush: ${e.message}`));
        toHevySoon();
        return send(res, 200, views.workoutsView(w, listArgs()));
      };
      // Every kind of workout Google Health takes, for the log's picker.
      if (GET && p === '/api/workouts/types') return send(res, 200, { types: views.ALL_TYPES });
      if (GET && p === '/api/workouts') {
        const out = views.workoutsView(w, listArgs());
        // Through an API key (scripts, the MCP connector, an AI assistant): nothing of Strava's (its
        // API agreement keeps its data to the athlete's own screens, and away from AI tools). A run
        // that is on Strava and also the watch's is there as the watch's (Google's) copy (listArgs noStrava).
        // Runs, walks or rides from Google whose maps it would share, once route maps are allowed (Train shows the ask).
        if (w.google?.connected?.() && !w.google.granted(LOCATION_SCOPE)) {
          const from = new Date(now() - 60 * 86_400_000).toISOString().slice(0, 10);
          out.routesAsk = w.db.exercises(from).some((e) => sportOf(e.type) && e.hasGps !== false && e.distanceM > 300);
        }
        return send(res, 200, out);
      }
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
      if (POST && p === '/api/presence') {
        // An open tab in view: "here", and the route it is recording (presence.js).
        limiter.check(`presence:${uid}`, 6, 60_000);
        limiter.add(`presence:${uid}`, 60_000);
        const b = await readJson(req, 64 * 1024);
        presence.beat(uid, { route: b.route || null });
        presenceWorkout(uid, w);
        return send(res, 200, { ok: true });
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
        presenceWorkout(uid, w);
        return send(res, 200, { ...views.workoutsView(w, listArgs()), started: String(r.id) });
      }
      if (POST && p === '/api/workouts/record') {
        // A route recorded with the phone's GPS (or sent whole by an app).
        const b = await readJson(req, 4 * 1024 * 1024);
        const type = routeType(b.type);
        const points = cleanPoints(b.points, { type });
        if (points.length < 2) throw err('The route has too few points. Was location allowed?');
        let start = Number.isFinite(Number(b.start)) ? Math.min(Number(b.start), points[0][0]) : points[0][0];
        let end = Number.isFinite(Number(b.end)) ? Math.max(Number(b.end), points.at(-1)[0]) : points.at(-1)[0];
        let pauses = cleanPauses(b.pauses, start, end);
        let follow = b.follow && typeof b.follow === 'object' ? { ...b.follow } : null;
        // A phone whose clock runs ahead (up to an hour): its times moved back so the route did not end in the future.
        const ahead = end - now();
        if (ahead > 0 && ahead < 3_600_000) {
          for (const pt of points) pt[0] -= ahead;
          start -= ahead; end -= ahead;
          pauses = pauses.map(([a, z]) => [a - ahead, z - ahead]);
          if (follow) for (const k of ['startT', 'endT']) if (Number.isFinite(Number(follow[k])) && follow[k] !== null) follow[k] = Number(follow[k]) - ahead;
        }
        return send(res, 200, saveRouteIn(w, uid, { type, points, pauses, start, end, title: b.title, notes: b.notes, source: 'recorded', follow }));
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
        const r = w.workouts.logPast({ start: b.start, end: b.end, title: b.title, notes: b.notes, type: b.type, distanceM: b.distanceM });
        if (ex) w.db.putSets(r.id, ex);
        return afterWorkout();
      }
      if (POST && p === '/api/workouts/settings') {
        const b = await readJson(req);
        // Work hours (workhours.js): the watch's own guesses while at work are activity, not workouts.
        if (b.workHours !== undefined) {
          w.db.setMeta('workHours', normWorkHours(b.workHours || {}, w.tz));
          w.onChange?.(['workouts', 'social']);
          publish(uid).catch(() => {});
          changed(uid, ['workouts', 'social', 'data']);
          return send(res, 200, views.workoutsView(w, listArgs()));
        }
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
      /* ── medals and achievements (medals.js) ── */
      if (GET && p === '/api/achievements') {
        // Through a key: from the watch's own record of each run, nothing of Strava's (history.js unified noStrava).
        const ix = medalIndex(w, { noStrava: !!user.apiKey });
        let honours = null;
        try { honours = challenges.honours(app, uid, uid); } catch (e) { log(`honours: ${e.message}`); }
        return send(res, 200, { achievements: achievementsOf(w, ix, profile, !!user.apiKey), medals: tally(ix.all), recent: ix.all.slice(0, 40), honours });
      }
      // Best times: each distance's fastest, and when each record fell (medals.js).
      if (GET && p === '/api/best-times') {
        // Through a key: from the watch's own record of each run (the ids list_workouts gives), never Strava's.
        const sports = ['run', 'ride', 'walk'].map((sp) => bestTimes(w, sp, { noStrava: !!user.apiKey })).filter((x) => x.distances.length);
        // Beside somebody else's (besttimes.js: only when you share workouts both ways).
        const withName = url.searchParams.get('with');
        if (!withName) return send(res, 200, { sports });
        const them = theirBests(app, (id) => worlds.get(id), uid, withName, now());
        if (!them) throw err('There is no such profile.', 404);
        return send(res, 200, { sports, them });
      }
      // Everybody you can compare best times with, and you: each one's best at each distance.
      if (GET && p === '/api/best-times/people') {
        const sport = url.searchParams.get('sport') || 'run';
        if (!['run', 'ride', 'walk'].includes(sport)) throw err('sport must be run, ride or walk.');
        return send(res, 200, bestsBoard(app, (id) => worlds.get(id), uid, sport, now()));
      }
      if (POST && p === '/api/achievements/seen') {
        markSeen(w, achievementsOf(w, medalIndex(w), profile));
        return send(res, 200, { ok: true });
      }
      if (POST && p === '/api/workouts/check') {
        if (!w.anyConnected()) throw err('Connect Google Health first.', 409, 'needs_google');
        throttle(`check:${uid}`, 30_000 / loose, 'Checked less than 30 seconds ago.');
        await w.workouts.tick({ force: true });
        return send(res, 200, views.workoutsView(w, listArgs()));
      }
      if (GET && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})$/.exec(p))) {
        try { refillTrack(w, uid, mm[1]); } catch (e) { log(`refill ${mm[1]}: ${e.message}`); }
        // Its owner opens a workout whose Strava details were let go after seven days: read again from Strava.
        if (!user.apiKey && /^\d{1,12}$/.test(mm[1])) {
          const row = w.db.workoutGet(mm[1]);
          const sapi = row?.strava?.ref && !row.strava.own ? stravaApiFor(uid) : null;
          let roomy = true;
          try { limiter.check(`stravaopen:${uid}`, 30, 60_000); } catch { roomy = false; }
          if (sapi && roomy && stravaBudget.room(20)) {
            limiter.add(`stravaopen:${uid}`, 60_000);
            const t = new Promise((resolve) => { const h = setTimeout(resolve, 6000); h.unref?.(); });
            await Promise.race([refreshActivity({ db: w.db, api: sapi, r: row, now: now() }).catch((e) => log(`strava reopen ${mm[1]}: ${e.message}`)), t]);
          }
        }
        const d = await views.workoutDetail(w, mm[1], { noStrava: !!user.apiKey });
        if (user.apiKey) {
          // Through an API key: nothing of Strava's (see /api/workouts).
          // (A Strava id is never listed through a key; the watch's own record of the same session is, under its own id.)
          if (d.source === 'strava') throw err('This workout is not available through the API: its data came from Strava, whose terms keep it away from scripts and AI tools. list_workouts gives the ids of the ones that are.', 404, 'not_found');
          d.strava = null; d.route = null;
          if (w.db.trackGet(mm[1])?.from === 'strava') { d.track = null; d.splits = null; }
        }
        // The route saved from this workout: still there, and shared or not.
        if (d.savedRoute) { const r = app.get('SELECT id, public FROM route WHERE id = ? AND user_id = ?', d.savedRoute.id, uid); d.savedRoute = r ? { id: r.id, public: !!r.public } : null; }
        try { d.routeTries = triesInWorkout(w, uid, mm[1]); } catch (e) { log(`route tries: ${e.message}`); d.routeTries = []; }
        // The medals it earned (medals.js), and any achievement reached since last seen.
        try {
          const ix = medalIndex(w);
          d.medals = medalsFor(ix, mm[1]);
          if (d.medals.length || d.status === 'done') d.achievements = achievementsOf(w, ix, profile).filter((a) => a.fresh);
        } catch (e) { log(`medals: ${e.message}`); d.medals = []; }
        return send(res, 200, d);
      }
      if (m === 'PUT' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/draft$/.exec(p))) {
        // The set-by-set log of a workout in progress, saved as it goes.
        const b = await readJson(req, 512 * 1024);
        const r = ownWorkout(w, mm[1]);
        if (!['running', 'ongoing', 'review'].includes(r.status) && !r.draft) throw err('This workout is over: change its sets instead.', 409, 'conflict');
        r.draft = { routineId: r.draft?.routineId ?? r.routineId ?? null, routineTitle: r.draft?.routineTitle ?? null, exercises: cleanDraftExercises(b.exercises, { draft: true }), restUntil: Number.isFinite(Number(b.restUntil)) ? Number(b.restUntil) : null };
        r.updated = now();
        w.db.workoutPut(r);
        if (r.status === 'running') presenceWorkout(uid, w);
        return send(res, 200, { ok: true, updatedAt: r.updated });
      }
      if (POST && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/routine$/.exec(p))) {
        // Which routine a workout was; with fill, its sets come from the
        // routine (when it has none yet), to be changed to what was done.
        const b = await readJson(req);
        // A watch session (Google, Garmin): the link is kept beside it, as it cannot be changed itself.
        if (mm[1].startsWith('g-')) {
          const routine = b.routineId ? ownRoutine(String(b.routineId)) : null;
          const links = w.db.meta('exRoutine', {}) || {};
          if (routine) links[mm[1]] = routine.id; else delete links[mm[1]];
          w.db.setMeta('exRoutine', links);
          changed(uid, ['workouts']);
          publish(uid, { announce: false }).catch((e) => log(`feed after routine link: ${e.message}`));
          return send(res, 200, await views.workoutDetail(w, mm[1]));
        }
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
        // Brought up to date with the routine as it is now (it was changed since): its exercises and
        // sets again, to change to what was done. In a workout being logged, sets already ticked stay.
        if (routine && b.refill === true) {
          const fresh = draftFrom(w.db, routine);
          if (r.draft) {
            const old = new Map((r.draft.exercises || []).map((x) => [String(x.name).toLowerCase(), x]));
            for (const x of fresh.exercises) {
              const was = old.get(String(x.name).toLowerCase());
              if (!was) continue;
              if (was.done) x.done = true;
              (was.sets || []).forEach((s, j) => { if (s.done) x.sets[j] = { ...(x.sets[j] || {}), ...s }; });
            }
            r.draft = { ...fresh, restUntil: r.draft.restUntil ?? null };
          } else {
            w.db.putSets(r.id, setsOfDraft(fresh, { keep: 'all' }));
            filled = true;
          }
        }
        // Unlinked and asked to: its exercises go too (a draft's as well).
        if (!routine && b.clear === true) {
          w.db.putSets(r.id, []);
          if (r.draft) r.draft = { ...r.draft, exercises: [] };
          filled = true;   // what was sent to Hevy follows
        }
        r.updated = now();
        w.db.workoutPut(r);
        changed(uid, ['workouts']);
        // The post of it says which routine, straight away.
        publish(uid, { announce: false }).catch((e) => log(`feed after routine link: ${e.message}`));
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
        else if (mm[2] === 'save') {
          const wasDone = w.workouts.get(id).status === 'done';
          w.workouts.save(id, { start: b.start, end: b.end }); settle();
          // New times on a finished workout: an edit like any other, here only or everywhere.
          if (wasDone) { const r = w.workouts.get(id); spread(w, r, wantsEverywhere(b), { googleChanged: true }); w.db.workoutPut(r); }
        }
        else if (mm[2] === 'dismiss') w.workouts.dismiss(id);
        else { w.workouts.retry(id); await w.workouts.flush({ force: true }); }
        return afterWorkout();
      }
      if (GET && (mm = /^\/api\/workouts\/uid\/([A-Za-z0-9_-]{1,80})$/.exec(p))) {
        // A post of yours leads here: which of your workouts it is.
        const r = w.db.workoutByUid(mm[1]);
        if (!r || r.status === 'deleted') throw err('That workout is no longer here.', 404);
        return send(res, 200, { id: String(r.id) });
      }
      if (m === 'PATCH' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})$/.exec(p))) {
        const b = await readJson(req);
        const r = ownWorkout(w, mm[1]);
        if (b.title !== undefined) r.title = b.title ? String(b.title).trim().slice(0, 80) : null;
        if (b.notes !== undefined) r.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
        if (b.type !== undefined) { if (b.type !== null && !validType(b.type)) throw err(`type must be one of ${Object.keys(EXERCISE_TYPES).join(', ')}, or another of Google Health's exercise types.`); r.type = b.type; }
        // A distance by hand, for a workout with no route (a route's own is measured, never typed over).
        if (b.distanceM !== undefined) {
          if (r.route || w.db.trackGet(r.id)) throw err('This workout\'s distance is measured from its route.', 409, 'conflict');
          const d = typedDistance(b.distanceM);
          if (d) { r.distanceM = d; r.distanceFrom = 'typed'; } else { delete r.distanceM; delete r.distanceFrom; delete r.distanceFor; }
          w.db.delMeta(`eff:${r.id}`);
        }
        // What Google shows is the title, the type and the distance: a saved point is patched.
        r.updated = now();
        spread(w, r, wantsEverywhere(b), { googleChanged: b.title !== undefined || b.type !== undefined || b.distanceM !== undefined });
        w.db.workoutPut(r);
        changed(uid, ['workouts']);
        publish(uid, { announce: false }).catch(() => {});
        return afterWorkout();
      }
      if (m === 'PUT' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/sets$/.exec(p))) {
        const b = await readJson(req, 512 * 1024);
        const r = ownWorkout(w, mm[1]);
        const ex = cleanExercises(b.exercises);
        w.db.tx(() => { w.db.putSets(r.id, ex); r.updated = now(); spread(w, r, wantsEverywhere(b)); w.db.workoutPut(r); });
        changed(uid, ['workouts']);
        // Its post says the new sets at once.
        publish(uid, { announce: false }).catch(() => {});
        toHevySoon();
        return send(res, 200, await views.workoutDetail(w, r.id));
      }
      if (m === 'DELETE' && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})$/.exec(p))) {
        const gone = ownWorkout(w, mm[1]).id;
        // ?here=1: removed from rep. only; the copies in Google and Hevy stay. Hevy's API has no
        // delete at all, so its copy always stays (the app says so).
        await w.workouts.remove(gone, { here: url.searchParams.get('here') === '1' });
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
        return send(res, 200, { scope, near, sports: ROUTE_SPORTS, routes: listRoutes(app, uid, { scope, near, sport: q.get('sport'), limit: Number(q.get('limit')) || 50 }) });
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
        const made = createRoute(app, uid, { title: b.title, sport, line, isPublic: b.public === true, bothWays: b.bothWays === true, source, trim: source === 'workout' && b.trim !== false, now: now() });
        // Which workout it came from: the workout's page then says it is saved (or shared), not asks again.
        if (b.workoutId !== undefined) { const m = w.db.meta('routeOf', {}) || {}; m[String(b.workoutId)] = made.id; w.db.setMeta('routeOf', m); }
        return send(res, 201, made);
      }
      if ((mm = /^\/api\/routes\/(r_[0-9a-f]{12})(\/route\.gpx)?$/.exec(p))) {
        if (GET && mm[2]) {
          const g = routeGpx(app, uid, mm[1]);
          res.writeHead(200, { ...baseHeaders, 'content-type': 'application/gpx+xml; charset=utf-8', 'content-disposition': `attachment; filename="${g.name}"`, 'cache-control': 'no-store' });
          return res.end(g.body);
        }
        if (GET && !mm[2]) {
          const out = getRoute(app, uid, mm[1]);
          // Your goes at it, from every recording and the watch's sessions, fastest first.
          try { const r = routeRow(mm[1]); out.tries = r ? triesAt(w, r).slice(0, 20).map((t) => ({ ...t, date: new Date(t.startT).toISOString().slice(0, 10) })) : []; } catch (e) { log(`route tries: ${e.message}`); out.tries = []; }
          return send(res, 200, out);
        }
        if (m === 'PATCH' && !mm[2]) { const b = await readJson(req); return send(res, 200, patchRoute(app, uid, mm[1], { title: b.title, sport: b.sport, isPublic: b.public, line: b.line, bothWays: b.bothWays, now: now() })); }
        if (m === 'DELETE' && !mm[2]) { deleteRoute(app, uid, mm[1]); return send(res, 200, { ok: true }); }
      }
      // A route's link, to send to someone (sharelink.js).
      if ((mm = /^\/api\/routes\/(r_[0-9a-f]{12})\/link$/.exec(p))) {
        const r = app.get('SELECT id FROM route WHERE id = ? AND user_id = ?', mm[1], uid);
        if (!r) throw err('There is no such route.', 404);
        if (GET) { const t = linkOf(app, uid, 'route', r.id, { make: false }); return send(res, 200, { path: t ? linkPath(t) : null }); }
        if (POST) return send(res, 200, { path: linkPath(linkOf(app, uid, 'route', r.id, { now: now() })) });
        if (m === 'DELETE') { linkOff(app, uid, 'route', r.id); return send(res, 200, { path: null }); }
      }
      /* What a link sent to you points at (sharelink.js): a routine or a route, as it is now; add it to your own. */
      if ((mm = /^\/api\/share\/([A-Za-z0-9_-]{1,40})(\/copy)?$/.exec(p))) {
        const L1 = linkOpen(app, uid, mm[1]);
        const gone = () => err('This link does not work any more. Ask for a new one.', 404, 'not_found');
        const owner = app.profile(L1.userId);
        const by = owner ? { username: owner.username, displayName: owner.displayName, accent: owner.accent, avatar: friends.avatarUrl(owner) } : null;
        if (L1.kind === 'routine') {
          const rt = L1.mine ? w.db.routineGet(L1.ref) : await worlds.hold(L1.userId, (w2) => w2.db.routineGet(L1.ref));
          if (!rt) throw gone();
          const exercises = rt.exercises.map((x) => ({ ...withDumbbell({ ...x, type: exerciseTypeOf(x) }), image: x.libId ? libView(libById(x.libId))?.images[0] || null : null }));
          if (GET && !mm[2]) return send(res, 200, { kind: 'routine', mine: L1.mine, by, routine: { title: rt.title, folder: rt.folder || null, notes: rt.notes || null, generic: !!rt.generic, exercises }, summary: routineSummary(rt) });
          if (POST && mm[2]) {
            if (w.db.routines().length >= 200) throw err('At most 200 routines.', 409, 'conflict');
            const made = cleanRoutine({ title: L1.mine ? `${rt.title} (copy)`.slice(0, 80) : rt.title, notes: rt.notes || null, generic: !!rt.generic, exercises: rt.exercises, from: { kind: 'link', id: mm[1], by: owner?.username || null } }, null, now());
            made.position = w.db.routines().length;
            w.db.routinePut(made);
            routinesChanged();
            return send(res, 201, { kind: 'routine', id: made.id, path: `/workouts/routines/${made.id}` });
          }
        } else if (L1.kind === 'route') {
          let rv;
          try { rv = getRoute(app, uid, L1.ref, { byLink: true }); } catch { throw gone(); }
          if (GET && !mm[2]) return send(res, 200, { kind: 'route', mine: L1.mine, by, route: rv });
          if (POST && mm[2]) { const c = copyRoute(app, uid, L1.ref, { now: now(), byLink: true }); return send(res, 201, { kind: 'route', id: c.id, path: `/workouts/routes/${c.id}` }); }
        }
        throw err('Not found.', 404);
      }
      // A copy of a route, yours to change.
      if (POST && (mm = /^\/api\/routes\/(r_[0-9a-f]{12})\/copy$/.exec(p))) {
        return send(res, 201, copyRoute(app, uid, mm[1], { now: now() }));
      }
      if (GET && (mm = /^\/api\/workouts\/([A-Za-z0-9_-]{1,120})\/(route\.gpx)$/.exec(p))) {
        const r = ownWorkout(w, mm[1]);
        const t = w.db.trackGet(r.id);
        if (!t) throw err('This workout has no route.', 404);
        // Through a key: never a route read from Strava (its terms keep it to the athlete's own screens).
        if (user.apiKey && (r.source === 'strava' || t.from === 'strava')) throw err('This route came from Strava, whose terms keep it out of the API.', 404, 'not_found');
        const body = toGpx({ title: r.title, type: t.type, points: t.points, pauses: t.pauses });
        const name = `${String(r.title || 'route').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'route'}-${new Date(r.start).toISOString().slice(0, 10)}.gpx`;
        res.writeHead(200, { ...baseHeaders, 'content-type': 'application/gpx+xml; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
        return res.end(body);
      }

      /* ── summary and the OpenCode key ── */


      /* ── social ── */

      // A circle's board, your friends', or everyone's (public accounts).
      const scopeOf = () => {
        const scope = url.searchParams.get('scope') || 'friends';
        if (!social.parseScope(scope)) throw err('scope must be friends, everyone or circle:<id>.');
        return scope;
      };
      if (GET && p === '/api/leaderboard') {
        const metric = url.searchParams.get('metric') || 'steps';
        const period = url.searchParams.get('period') || 'week';
        if (!social.METRICS[metric]) throw err(`metric must be one of ${Object.keys(social.METRICS).join(', ')}.`);
        if (!social.PERIODS[period]) throw err(`period must be one of ${Object.keys(social.PERIODS).join(', ')}.`);
        const scope = scopeOf();
        return send(res, 200, circles.decorateBoard(app, social.leaderboard(app, { metric, period, scope, viewerId: uid, now: now() }), { viewerId: uid, scope, now: now() }));
      }
      if (GET && p === '/api/boards') {
        const period = url.searchParams.get('period') || 'week';
        if (!social.PERIODS[period]) throw err(`period must be one of ${Object.keys(social.PERIODS).join(', ')}.`);
        const scope = scopeOf();
        const out = social.boards(app, { period, scope, viewerId: uid, now: now() });
        // Who won each board last week (kept for a circle, worked out for Friends).
        for (const bd of out.boards) { const d = circles.decorateBoard(app, { metric: bd.metric, entries: [] }, { viewerId: uid, scope, now: now() }); bd.lastWeek = d.lastWeek; }
        return send(res, 200, out);
      }
      if (GET && p === '/api/people') return send(res, 200, { people: social.people(app, uid) });
      if (GET && (mm = /^\/api\/now\/([^/]{1,40})$/.exec(p))) {
        // One person's preview, as the viewer may see it: what they are doing, the route so far
        // (friends only, and only with their map on), the last two minutes of heart rate (with their heart).
        const pr = app.profileByName(decodeURIComponent(mm[1]));
        if (!pr) throw err('There is no such profile.', 404);
        const self = pr.userId === uid;
        const L = lensOf(app, uid);
        const n = self ? (presenceOn(pr) ? selfNow(pr) : null) : nowFor(L, pr);
        const head = { username: pr.username, displayName: pr.displayName, accent: pr.accent, avatar: friends.avatarUrl(pr), me: self, friend: L.friends.has(pr.userId) };
        if (!n) return send(res, 200, { ...head, online: false, activity: null, bpm: null, line: null, hr: null });
        const mapOk = n.activity?.kind === 'route' && pr.privacy?.nowMap !== false && (self || L.friends.has(pr.userId)) && (self || L.sees(pr, 'workouts'));
        const heartOk = self ? pr.privacy?.heart !== 'me' : L.sees(pr, 'heart');
        const hv = heartOk ? live.view(pr.userId) : null;
        return send(res, 200, {
          ...head, ...n,
          line: mapOk ? presence.line(pr.userId) : null,
          map: n.activity?.kind === 'route' ? (mapOk ? 'shown' : pr.privacy?.nowMap === false ? 'off' : 'friends') : null,
          hr: hv && n.bpm ? { recent: hv.recent } : null,
        });
      }
      if (GET && p === '/api/now') {
        // Who is here now, and who is working out (presence.js): those the viewer may see, working out first.
        const L = lensOf(app, uid);
        const out = [];
        for (const pr of app.profiles()) {
          const n = nowFor(L, pr);
          if (n) out.push({ username: pr.username, displayName: pr.displayName, accent: pr.accent, avatar: friends.avatarUrl(pr), friend: L.friends.has(pr.userId), ...n, activity: n.activity && { ...n.activity, list: undefined } });
        }
        out.sort((a, b) => (b.activity ? 1 : 0) - (a.activity ? 1 : 0) || (b.friend ? 1 : 0) - (a.friend ? 1 : 0) || String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
        const me = app.profile(uid);
        const self = me ? { username: me.username, displayName: me.displayName, accent: me.accent, avatar: friends.avatarUrl(me), me: true, ...selfNow(me) } : null;
        return send(res, 200, { people: out, self, me: { shown: presenceOn(me), setting: me?.privacy?.presence ?? 'auto' } });
      }
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
      // Somebody by their exact username: the only way to find a person you do not know.
      if (GET && p === '/api/friends/find') {
        limiter.check(`find:${uid}`, 60 * loose, 600_000);
        limiter.add(`find:${uid}`, 600_000);
        const hit = friends.find(app, uid, url.searchParams.get('username'));
        if (!hit) throw err('Nobody has that username. Check the spelling: it has to be exact.', 404, 'not_found');
        return send(res, 200, { person: hit });
      }

      /* ── circles (circles.js) ── */

      /** Send what a circle call owes somebody, tell the people whose view changed, and answer the rest. */
      const circleDone = (r, also = []) => {
        const { tell, ...rest } = r;
        if (tell) { const { userId, ...note } = tell; notifyUser(userId, note); changed(userId, ['social', 'me']); }
        for (const id of also) changed(id, ['social', 'me']);
        changed(uid, ['social', 'me']);
        return rest;
      };
      if (p === '/api/circles' || p.startsWith('/api/circles/')) {
        if (GET && p === '/api/circles') {
          // Each of yours as a card (challenges.js): this week's goal, events on, faces.
          const r = circles.mine(app, uid);
          r.circles = r.circles.map((x) => ({ ...x, ...challenges.circleCard(app, circles.circleOf(app, x.id), uid, now()) }));
          return send(res, 200, { ...r, icons: circles.ICONS });
        }
        if (GET && p === '/api/circles/browse') return send(res, 200, { circles: circles.browse(app, uid, url.searchParams.get('q') || '') });
        if (POST && p === '/api/circles') {
          limiter.check(`circle:${uid}`, 10 * loose, 3_600_000); limiter.add(`circle:${uid}`, 3_600_000);
          return send(res, 200, circleDone({ ...circles.create(app, uid, await readJson(req), now()) }));
        }
        // Goals and events (challenges.js).
        const ce = /^\/api\/circles\/([A-Za-z0-9_-]{6,40})\/(goals|events)(?:\/([A-Za-z0-9_-]{6,40})(?:\/(join|leave))?)?$/.exec(p);
        if (ce) {
          const [, cid, what, eid, verb] = ce;
          if (what === 'goals' && !eid && GET) return send(res, 200, challenges.goals(app, uid, cid, { past: url.searchParams.get('past') || 12, now: now() }));
          if (what === 'events') {
            if (!eid && GET) return send(res, 200, challenges.events(app, uid, cid, now()));
            if (!eid && POST) {
              limiter.check(`cevent:${uid}`, 20 * loose, 3_600_000); limiter.add(`cevent:${uid}`, 3_600_000);
              const r = challenges.createEvent(app, uid, cid, await readJson(req), now());
              for (const { userId, note } of r.notes) { notifyUser(userId, note); changed(userId, ['social']); }
              changed(uid, ['social']);
              return send(res, 200, r.event);
            }
            if (eid && !verb && GET) return send(res, 200, challenges.event(app, uid, cid, eid, now()));
            const tellAll = () => { for (const id of circles.memberIds(app, cid)) changed(id, ['social']); };
            if (eid && verb === 'join' && POST) { const r = challenges.joinEvent(app, uid, cid, eid, now()); tellAll(); return send(res, 200, r); }
            if (eid && verb === 'leave' && POST) { const r = challenges.leaveEvent(app, uid, cid, eid, now()); tellAll(); return send(res, 200, r); }
            if (eid && !verb && m === 'DELETE') { const r = challenges.endEvent(app, uid, cid, eid); tellAll(); return send(res, 200, r); }
          }
          throw err('Not found', 404);
        }
        const cm = /^\/api\/circles\/([A-Za-z0-9_-]{6,40})(?:\/(join|leave|invite|link|winners|members\/([^/]{1,40})(?:\/(accept|decline))?))?$/.exec(p);
        if (!cm) throw err('Not found', 404);
        const [, cid, act, who, verb] = cm;
        const before = () => circles.memberIds(app, cid);
        if (!act && GET) {
          const v = circles.view(app, uid, cid);
          if (v.status !== 'member') return send(res, 200, v);
          // At a glance (challenges.js, rating.js): goals, events on, trophies, and members by rank.
          const c = circles.circleOf(app, cid);
          const ranks = circles.memberIds(app, cid).map((id) => app.profile(id)).filter((x) => x && circleWide(x, 'activity'))
            .map((x) => { const r = ratingOf(app, x.userId, now()); return { username: x.username, rating: r.rating, rank: r.rank, delta: r.delta, placed: r.placed, weeksToPlace: r.weeksToPlace, best: r.best, last: r.last, week: r.week, history: r.history.map((h) => ({ week: h.week, score: h.score, rating: h.rating, delta: h.delta, rank: h.rank })) }; })
            .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
          return send(res, 200, { ...v, ...challenges.circleGlance(app, c, uid, now()), ranks });
        }
        if (!act && m === 'PATCH') return send(res, 200, circleDone({ ...circles.patch(app, uid, cid, await readJson(req), now()) }, before()));
        if (!act && m === 'DELETE') { const r = circles.remove(app, uid, cid); return send(res, 200, circleDone({ ok: true }, r.members)); }
        if (act === 'link' && GET) return send(res, 200, circles.inviteLink(app, uid, cid));
        if (act === 'winners' && GET) return send(res, 200, circles.winners(app, uid, cid, { weeks: url.searchParams.get('weeks') || 12, now: now() }));
        if (act === 'join' && POST) {
          limiter.check(`cjoin:${uid}`, 30 * loose, 3_600_000); limiter.add(`cjoin:${uid}`, 3_600_000);
          const jb = await readJson(req).catch(() => ({}));
          return send(res, 200, circleDone(circles.join(app, uid, cid, now(), { code: jb?.code || null }), before()));
        }
        if (act === 'leave' && POST) { const was = before(); return send(res, 200, circleDone(circles.leave(app, uid, cid), was)); }
        if (act === 'invite' && POST) {
          const b = await readJson(req);
          return send(res, 200, circleDone(circles.invite(app, uid, cid, b.username, now())));
        }
        if (who && verb === 'accept' && POST) return send(res, 200, circleDone(circles.accept(app, uid, cid, decodeURIComponent(who), now()), before()));
        if (who && verb === 'decline' && POST) return send(res, 200, circleDone(circles.decline(app, uid, cid, decodeURIComponent(who))));
        if (who && !verb && m === 'DELETE') {
          const gone = app.profileByName(decodeURIComponent(who));
          const was = before();
          return send(res, 200, circleDone(circles.removeMember(app, uid, cid, decodeURIComponent(who)), gone ? [...was, gone.userId] : was));
        }
        throw err('Not found', 404);
      }

      /* ── blocking and reporting (safety.js) ── */

      if (GET && p === '/api/blocks') return send(res, 200, { blocked: safety.blockedList(app, uid) });
      if (POST && (p === '/api/block' || p === '/api/unblock')) {
        const b = await readJson(req);
        if (typeof b.username !== 'string' || !b.username.trim()) throw err('username is required.');
        const out = p === '/api/block' ? safety.block(app, uid, b.username, now()) : safety.unblock(app, uid, b.username);
        // Both sides' feeds, boards and people lists change; the blocked person is not told.
        const other = app.profileByName(b.username.trim());
        if (other) changed(other.userId, ['social']);
        changed(uid, ['social', 'me']);
        return send(res, 200, { blocked: out.blocked, list: safety.blockedList(app, uid) });
      }
      if (POST && p === '/api/report') {
        const b = await readJson(req, 8 * 1024);
        limiter.check(`report:${uid}`, 20 * loose, 3_600_000);
        limiter.add(`report:${uid}`, 3_600_000);
        const postOf = (kind, id) => (kind === 'post' ? id : kind === 'comment' ? app.get('SELECT post_id FROM comment WHERE id = ?', String(id))?.post_id
          : kind === 'media' ? app.get('SELECT post_id FROM media WHERE id = ?', String(id))?.post_id : null);
        const canSee = (kind, id, t) => {
          if (kind === 'person') { const L = lensOf(app, uid); const pr = app.profile(t.user); return !!pr && (L.knows(pr) || !!friends.relation(app, uid, t.user) || pr.onboarding === 'done'); }
          const pid = postOf(kind, id);
          return !!pid && feed.canSeePost(app, uid, pid);
        };
        const r = safety.report(app, { me: uid, kind: String(b.kind || ''), id: String(b.id || '').slice(0, 80), reason: String(b.reason || ''), note: b.note, now: now(), canSee });
        if (!r.again) {
          log(`report ${r.id}: ${b.kind} by ${user.username}`);
          for (const pr of app.profiles()) {
            if (!isAdmin({ username: pr.username })) continue;
            notifyUser(pr.userId, { type: 'report', title: 'Something was reported', body: safety.REASONS[b.reason] || '', tag: 'report', url: '/settings/admin' });
            changed(pr.userId, ['admin']);
          }
        }
        return send(res, 200, { ok: true });
      }

      /* ── consent (consent.js): the terms and age at signup, then health, sharing and AI ── */

      if (m === 'PATCH' && p === '/api/consent') {
        const b = await readJson(req, 8 * 1024);
        const c = { ...(profile.consent || {}) };
        for (const k of CONSENT_KINDS) {
          if (b[k] === undefined) continue;
          if (k === 'ai') {
            // AI: on with the kinds of data it may read, or off (null).
            c.ai = b.ai ? { at: now(), allow: normAiAllow(b.ai.allow) } : null;
            if (b.ai) c.versions = { ...(c.versions || {}), ai: POLICY_VERSION };
          } else if (b[k] === true) Object.assign(c, withConsent(c, k, now()));
          else if (b[k] === false && k !== 'terms') delete c[k];
        }
        app.patchProfile(uid, { consent: c });
        changed(uid, ['me']);
        return send(res, 200, consentView(c));
      }

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
        const own = wid.startsWith('g-') ? null : ownWorkout(w, wid);
        const workoutUid = own ? own.uid : wid;
        let cur = feed.postOfWorkout(app, { viewerId: uid, workoutUid, noStrava: !!user.apiKey });
        // Just finished: its post may not be written yet.
        if (!cur.post && cur.canShare && (!own || (own.end ?? own.start) >= now() - feed.FEED_DAYS * 86_400_000)) { await publish(uid, { announce: false }); cur = feed.postOfWorkout(app, { viewerId: uid, workoutUid, noStrava: !!user.apiKey }); }
        if (m === 'PUT') {
          const b = await readJson(req);
          if (!cur.post) throw err(cur.reason || 'This workout cannot be posted.', 409);
          feed.patchPost(app, { viewerId: uid, id: cur.post.id, patch: { shared: b.shared, caption: b.caption, music: await musicOf(b.music) } });
          changed(uid, ['social']);
        }
        return send(res, 200, feed.postOfWorkout(app, { viewerId: uid, workoutUid, noStrava: !!user.apiKey }));
      }
      if (GET && p === '/api/feed') {
        const q = url.searchParams;
        const out = feed.feed(app, { viewerId: uid, before: q.get('before'), limit: q.get('limit') || 20, noStrava: !!user.apiKey });
        // Runs, walks or rides of theirs from Google whose maps could be on their posts, once route maps are allowed.
        if (!q.get('before') && w.google?.connected?.() && !w.google.granted(LOCATION_SCOPE)) {
          const from = new Date(now() - 60 * 86_400_000).toISOString().slice(0, 10);
          out.routesAsk = w.db.exercises(from).some((e) => sportOf(e.type) && e.hasGps !== false && e.distanceM > 0);
        }
        return send(res, 200, out);
      }
      if ((mm = /^\/api\/posts\/([A-Za-z0-9_-]{12})(\/cheer|\/comments(?:\/([A-Za-z0-9_]{1,40}))?)?$/.exec(p))) {
        const id = mm[1];
        /** Cheers and comments: a fixed number per person in ten minutes. */
        const slow = () => { limiter.check(`feed:${uid}`, 60 * loose, 600_000); limiter.add(`feed:${uid}`, 600_000); };
        if (GET && !mm[2]) return send(res, 200, feed.post(app, { viewerId: uid, id, noStrava: !!user.apiKey }));
        if (m === 'PATCH' && !mm[2]) {
          const b = await readJson(req);
          const out = feed.patchPost(app, { viewerId: uid, id, patch: { caption: b.caption, hidden: b.hidden, shared: b.shared, media: b.media, music: await musicOf(b.music) } });
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
        // The Android app: its Firebase token (fcm.js). A browser: its Web Push subscription.
        // The Android app: its Firebase token (fcm.js). The iPhone app: its Apple device token (apns.js). A browser: its Web Push subscription.
        const deviceId = b.fcm ? notifier.subscribeApp(uid, b.fcm, b.label, { was: b.was || null })
          : b.apns ? notifier.subscribeApp(uid, b.apns, b.label, { was: b.was || null, kind: 'apns' })
            : notifier.subscribe(uid, b.subscription, b.label);
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
        if (patch.discreet !== undefined && typeof patch.discreet !== 'boolean') throw err('discreet must be true or false.');
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

      /* ── personal API keys (apikeys.js): made and removed on the site only ── */

      const keysPayload = () => ({ keys: apikeys.listKeys(app, uid), max: apikeys.MAX_KEYS, scopes: apikeys.SCOPES,
        api: `${config.origin || ''}/api`, mcp: `${config.origin || ''}/mcp`, docs: `${config.origin || ''}/developers` });
      if (GET && p === '/api/keys') return send(res, 200, keysPayload());
      // The installed app's own key for its widgets: reads GET /api/widget and nothing else; one per kind of device.
      if (POST && p === '/api/keys/widget') {
        const b = await readJson(req);
        const device = ['android', 'ios'].includes(b.device) ? b.device : 'phone';
        const label = `Widgets (${device})`;
        for (const k of apikeys.listKeys(app, uid)) if (k.label === label) apikeys.deleteKey(app, uid, k.id);
        return send(res, 200, { key: apikeys.createKey(app, uid, { label, scope: 'widget' }, now()).key });
      }
      if (POST && p === '/api/keys') {
        const b = await readJson(req);
        const made = apikeys.createKey(app, uid, { label: b.label, scope: b.scope }, now());
        // The one time the key itself is in a reply.
        return send(res, 200, { ...keysPayload(), key: made.key, id: made.id });
      }
      if (m === 'DELETE' && (mm = /^\/api\/keys\/(ak_[0-9a-f]{10})$/.exec(p))) {
        if (!apikeys.deleteKey(app, uid, mm[1])) throw err('No such key.', 404);
        return send(res, 200, keysPayload());
      }

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
        const body = views.exportView(w, { profile, app, me: mePayload(user, profile), noStrava: !!user.apiKey });
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
        await wipeHealth(uid, w);
        return send(res, 200, { ok: true });
      }
      // The whole account: the health data as above, what they made for
      // everyone (exercises, shared routines), and the rep. login itself (mtg and dnd keep their own).
      if (POST && p === '/api/account/delete') {
        const b = await readJson(req);
        if (String(b.confirm || '').toLowerCase() !== profile.username.toLowerCase()) throw err('Type your username to confirm.');
        limiter.check(`delacct:${uid}`, 5, 600_000);
        // Only an account that still has a password (the demo's) is asked for it.
        if (await accounts.hasPassword(uid) && !(await accounts.checkPassword(uid, b.password))) { limiter.add(`delacct:${uid}`, 600_000); throw err('That is not your password.', 400, 'bad_password'); }
        // The login first: a request the app makes meanwhile (it reloads on the change below)
        // then finds nobody, and cannot make a fresh profile for them.
        gone.add(uid);
        await accounts.deleteUser(uid);
        for (const [k, v] of sessions) if (String(v.user?.id) === uid) sessions.delete(k);
        await wipeHealth(uid, w);
        for (const x of app.all('SELECT id FROM cex WHERE user_id = ?', uid)) { try { cexDelete(app, cexPhotos, uid, x.id); } catch (e) { log(`delete account cex: ${e.message}`); } }
        app.run('DELETE FROM pub_routine WHERE user_id = ?', uid);
        // Its Google and Apple sign-ins: the same Google or Apple account can make a new one.
        app.run('DELETE FROM identity WHERE user_id = ?', uid);
        log(`account deleted: ${uid}`);
        return send(res, 200, { ok: true }, { 'set-cookie': accounts.clearCookie() });
      }

      throw err('Not found', 404);
    });
  }

  /* ── the handler ────────────────────────────────────────────────── */

  // The developer pages (devdocs.js): docs/DEVELOPERS.md and docs/API.md, rendered; the OpenAPI description.
  const devdocs = createDevDocs({ origin: () => config.origin || '', openapi, send, baseHeaders });
  // The MCP server (mcp.js): its tools are this same API, called in-process with the caller's key.
  const mcp = createMcp({ handler: (...a) => handler(...a), keyFor: (b) => apikeys.keyFor(app, b, now()), version: VERSION, origin: () => config.origin || '', readRaw, send, log });

  async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'Bad request', code: 'bad_request' }); }
    const p = url.pathname;
    const moved = movedFrom(config, req, p);
    if (moved?.worker) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(RETIRED_WORKER); }
    if (moved) { res.writeHead(301, { location: `${config.origin}${p}${url.search}`, 'cache-control': 'public, max-age=3600', ...baseHeaders }); return res.end(); }
    const api = p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/demo/') || p.startsWith('/media/');
    // Another site's page may call the API with a key (never with the cookie: no credentials, any origin).
    const keyed = /^Bearer\s+hak_/i.test(String(req.headers.authorization || ''));
    if ((p.startsWith('/api/') || p === '/mcp') && (keyed || req.method === 'OPTIONS')) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-expose-headers', 'retry-after, mcp-session-id');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id', 'access-control-max-age': '600' });
        return res.end();
      }
    }
    try {
      if (p === '/mcp') return await mcp(req, res);
      if (p === '/developers' || p.startsWith('/developers/')) { const r = await devdocs(req, res, p); if (r !== null) return r; }
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

  /** When the shared week has closed: keep each circle's winners and tell them (circles.js). */
  function circleTick(at = now()) {
    try {
      for (const { userId, note } of circles.closeWeeks(app, at)) { notifyUser(userId, note); changed(userId, ['social']); }
      // Goals and events: made when a week or month starts, closed when it is over (challenges.js).
      for (const { userId, note } of challenges.tick(app, at)) { notifyUser(userId, note); changed(userId, ['social']); }
    } catch (e) { log(`circles: ${e.message}`); }
  }
  const circleTimer = config.scheduler ? setInterval(() => circleTick(), 60_000) : null;
  circleTimer?.unref?.();

  function close() {
    if (circleTimer) clearInterval(circleTimer);
    scheduler.stop();
    for (const j of qrJobs.values()) j.cancelled = true;
    live.close();
    clearInterval(presenceSweep); clearInterval(sessionSweep);
    for (const set of streams.values()) for (const res of set) { try { res.end(); } catch { /* closed */ } }
    worlds.closeAll();
    media.close();
    app.close();
  }

  // Strava's webhook subscription, checked once the server is up (not in tests or the demo).
  if (config.scheduler && !config.demo && config.strava.verifyToken) setTimeout(() => { ensureStravaWebhook().then((r) => { if (!r.ok) log(`strava webhook: ${r.reason}`); }); }, 15_000).unref?.();

  /** Connect Garmin for a person as the route does, and wait for the first read (the demo seed). */
  const connectGarminFor = (userId, key, o = {}) => worlds.hold(userId, (w) => connectGarmin(userId, w, key, o)).then(() => garminFirst(userId));
  /* Posts written before they carried routines and watch routes: everyone's
     rewritten once (FEED_VERSION), oldest kept posts included, then not again. */
  const FEED_VERSION = 13;   // 13: a workout's heart-rate graph on its post; 12: a post's route drawn whole, its ends no longer cut off; 11: fit_min and run_steps, the rank's own places; 7: swims in daily_public, for the events; 8: train_min, for the rank; 9: sets shown on a workout with numbers in exercises mode; 10: dumbbells 1x / 2x in volume
  /* 2026-11-03, once: ojee asked for his dumbbell exercises to be 2× (the weight per dumbbell, two of them).
     He had typed both dumbbells together and noted each one's weight ("Each arm (8 KG)"), so each weight is
     halved, the exercise set to 2× and that note dropped (the 2× says it now): the volume stays what it was, the
     number is what is on the dumbbell. His routines, his logged workouts, and a running one. His Lateral Shoulder
     Raise is done on a machine: it was linked to the library's dumbbell raise, so it is linked to the machine one
     instead, its weights as they were. */
  const DUMBBELL_FIX = { user: 'ojee', names: ['dumbbell bicep curl', 'hammer curls', 'dumbbell shrug'] };
  const EACH_ARM = /^\s*each arm\s*\(\s*\d+(?:[.,]\d+)?\s*kg\s*\)\s*$/i;
  async function fixDumbbellsOnce() {
    if (app.meta('fix:dumbbells-2026-11-03', false)) return;
    const prof = app.profileByName(DUMBBELL_FIX.user);
    if (prof) {
      const hit = (x) => DUMBBELL_FIX.names.includes(String(x.name).toLowerCase()) && isDumbbell(x);
      const half = (v) => (Number.isFinite(v) && v > 0 ? Math.round((v / 2) * 4) / 4 : v);
      const fix = (x) => {
        if (String(x.name).toLowerCase() === 'lateral shoulder raise' && x.libId === 'Side_Lateral_Raise') {
          x.libId = 'X_Machine_Lateral_Raise'; delete x.dumbbell; delete x.dumbbells;
          return true;
        }
        if (!hit(x) || x.dumbbells === 2) return false;
        x.sets.forEach((st) => { st.kg = half(st.kg); });
        x.dumbbells = 2; x.dumbbell = true;
        if (x.notes && EACH_ARM.test(x.notes)) x.notes = null;
        return true;
      };
      await worlds.hold(prof.userId, async (w) => {
        let n = 0;
        for (const r of w.db.routines()) { if (r.exercises.map(fix).some(Boolean)) { r.updated = now(); w.db.routinePut(r); n += 1; } }
        for (const { id } of w.db.db.prepare('SELECT DISTINCT workout_id AS id FROM wset').all()) {
          const ex = w.db.setsOf(id);
          if (ex.map(fix).some(Boolean)) { w.db.putSets(id, ex); n += 1; }
        }
        const run = w.workouts.running();
        if (run?.draft && run.draft.exercises.map(fix).some(Boolean)) { run.updated = now(); w.db.workoutPut(run); n += 1; }
        log(`dumbbells: ${n} routines and workouts of ${prof.username} set to 2x`);
      });
    }
    app.setMeta('fix:dumbbells-2026-11-03', true);
  }

  async function refreshPosts() {
    try { await fixDumbbellsOnce(); } catch (e) { log(`dumbbells fix: ${e.message}`); }
    if (app.meta('feedVersion', 0) === FEED_VERSION) return 0;
    let n = 0;
    for (const p of app.profiles()) {
      try { await worlds.hold(p.userId, async () => { await publish(p.userId, { announce: false }); }); n += 1; } catch (e) { log(`posts for ${p.username}: ${e.message}`); }
    }
    app.setMeta('feedVersion', FEED_VERSION);
    log(`posts rewritten for ${n} people`);
    return n;
  }

  return { handler, app, circleTick, media, refreshPosts, accounts, worlds, scheduler, notifier, live, vault, afterSync, syncUser, syncExtras, publish, ensureProfile, oauth, close, config, food, music, stravaBudget, connectGarmin: connectGarminFor };
}
