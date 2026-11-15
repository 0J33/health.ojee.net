/* ============================================================
   health.ojee.net — configuration, read once from the environment.

   Everything the server needs to know about where it runs. Secrets
   are read here and handed to the one module that uses each; they
   are never logged and never put in a reply.
   ============================================================ */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '3.0.0';

/** Free OpenCode Zen models, tried in this order: the zero-retention ones
    first. */
export const ZEN_DEFAULT_MODELS = ['space-bunny-free', 'longcat-2.5-preview-free', 'step-5-preview-free'];

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const demo = ['1', 'true', 'on', 'force'].includes(String(env.HEALTH_DEMO || '').toLowerCase());
  const port = Number(env.PORT) || 5020;
  const origin = (env.PUBLIC_ORIGIN || (demo ? `http://localhost:${port}` : '')).replace(/\/+$/, '');
  const dataDir = env.DATA_DIR || join(ROOT, 'data', ...(demo ? ['demo'] : []));
  return {
    demo,
    port,
    host: env.HOST || (demo ? '127.0.0.1' : '127.0.0.1'),
    origin,
    // Other origins allowed to make state-changing requests (none normally).
    // In demo mode the two loopback spellings of this port are both fine.
    origins: [...new Set([origin, ...list(env.ALLOWED_ORIGINS), ...(demo ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`] : [])].filter(Boolean))],
    // Addresses this site used to live at: browsers are sent on to `origin` (server/legacyhost.js).
    legacyHosts: list(env.LEGACY_HOSTS).map((h) => h.toLowerCase()),
    dataDir,
    webDir: env.WEB_DIR || join(ROOT, 'web'),
    // mtg's Mongo, read once at start to bring rep.'s people and sessions over into rep.'s own
    // store (accounts.js migrateFromMongo); not needed once that has run.
    mongoUri: env.MONGODB_URI || 'mongodb://localhost:27017/mtg',
    // repSession on this domain (.ojee.net: rep.ojee.net and the old health.ojee.net share it).
    cookieDomain: env.COOKIE_DOMAIN || '',
    // The session cookie is Secure + SameSite=None. A browser will not keep a Secure cookie
    // from plain http, so on an http origin (local runs, the demo) it is sent as Lax without Secure.
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : !origin.startsWith('http://'),
    admins: list(env.ADMIN_USERS || 'ojee').map((s) => s.toLowerCase()),
    appSecret: env.APP_SECRET || (demo ? randomBytes(32).toString('hex') : ''),
    google: {
      clientId: (env.GOOGLE_HEALTH_CLIENT_ID || '').trim(),
      clientSecret: (env.GOOGLE_HEALTH_CLIENT_SECRET || '').trim(),
      redirectUri: env.GOOGLE_HEALTH_REDIRECT_URI || (origin ? `${origin}/auth/google/callback` : ''),
    },
    // Sign in with Google (the same OAuth client as Google Health, its own callback) and Apple
    // (signin.js). Each callback address must be listed with the provider.
    signin: {
      googleRedirectUri: env.GOOGLE_SIGNIN_REDIRECT_URI || (origin ? `${origin}/auth/signin/google/callback` : ''),
      appleServicesId: (env.APPLE_SERVICES_ID || 'net.ojee.health.signin').trim(),
      appleBundleId: (env.APPLE_BUNDLE_ID || 'net.ojee.health').trim(),
      appleRedirectUri: env.APPLE_SIGNIN_REDIRECT_URI || (origin ? `${origin}/auth/signin/apple/callback` : ''),
      // Accounts that may still sign in with a username and password (the app reviewers' `demo`;
      // in demo mode, the seeded people too: index.js). They are never asked to link Google or Apple.
      passwordLogin: list(env.PASSWORD_LOGIN_USERS ?? 'demo').map((s) => s.toLowerCase()),
      // Accounts walled off from everyone else (safety.js): the app reviewers' `demo`, so a
      // reviewer (or Google's pre-launch robot) never reaches a real person. Off in demo mode.
      walled: list(env.WALLED_USERS ?? 'demo').map((s) => s.toLowerCase()),
    },
    zen: {
      url: env.ZEN_URL || 'https://opencode.ai/zen/v1/chat/completions',
      models: list(env.ZEN_MODELS).length ? list(env.ZEN_MODELS) : ZEN_DEFAULT_MODELS,
      timeoutMs: Number(env.ZEN_TIMEOUT_MS) || 45_000,
    },
    // The free models, through an `opencode serve` on this box (see
    // server/core/writer.js). Unset = only a person's own key can write prose.
    opencode: {
      url: (env.OPENCODE_URL || '').trim(),
      dir: env.OPENCODE_SUMMARY_DIR || '/tmp',
      models: env.OPENCODE_SUMMARY_MODELS || '',
      // OpenCode's free tier only, for everyone. AI_SHARED_GO=1 also spends this box's OpenCode Go
      // subscription on everyone (only Go's models that keep nothing: writer.js GO_ZDR); off, a
      // person who wants Go brings their own key (ownai.js).
      sharedGo: env.AI_SHARED_GO === '1',
      providers: env.OPENCODE_PROVIDERS || (env.AI_SHARED_GO === '1' ? 'opencode-go,opencode' : 'opencode'),
      attempts: Number(env.OPENCODE_SUMMARY_ATTEMPTS) || 4,
      turnMs: Number(env.OPENCODE_SUMMARY_TIMEOUT_MS) || 120_000,
      pollMs: Number(env.OPENCODE_POLL_MS) || 1500,
    },
    // Hevy: each person's own API key (hevysync.js). Only the address and
    // the spacing between calls are the server's.
    hevy: {
      base: (env.HEVY_API_URL || 'https://api.hevyapp.com').replace(/\/+$/, ''),
      gapMs: Math.max(0, Number(env.HEVY_GAP_MS ?? 300)),
    },
    // Garmin's Personal API: each person's own key (garminsync.js). Only the
    // address and the spacing between calls are the server's.
    garmin: {
      base: (env.GARMIN_API_URL || 'https://personal.connectapi.garmin.com').replace(/\/+$/, ''),
      gapMs: Math.max(0, Number(env.GARMIN_GAP_MS ?? 1000)),
    },
    // Strava: one API application for the site (strava.com/settings/api),
    // its callback domain this site's host. Unset = Strava is not offered.
    strava: {
      clientId: (env.STRAVA_CLIENT_ID || '').trim(),
      clientSecret: (env.STRAVA_CLIENT_SECRET || '').trim(),
      redirectUri: env.STRAVA_REDIRECT_URI || (origin ? `${origin}/auth/strava/callback` : ''),
      // The token Strava echoes when it checks the webhook address. Unset =
      // no webhook: the 20-minute sync alone reads new activities.
      verifyToken: (env.STRAVA_VERIFY_TOKEN || '').trim(),
      webhookUrl: env.STRAVA_WEBHOOK_URL || (origin ? `${origin}/api/strava/webhook` : ''),
    },
    // WHOOP: one developer app for the site (developer-dashboard.whoop.com), its redirect URL
    // registered there. Unset = WHOOP is not offered. Its webhook URL (<origin>/api/whoop/webhook)
    // is set in the same dashboard; the client secret signs it (whoop.js).
    whoop: {
      clientId: (env.WHOOP_CLIENT_ID || '').trim(),
      clientSecret: (env.WHOOP_CLIENT_SECRET || '').trim(),
      redirectUri: env.WHOOP_REDIRECT_URI || (origin ? `${origin}/auth/whoop/callback` : ''),
    },
    vapidSubject: env.VAPID_SUBJECT || 'mailto:health@ojee.net',
    // The Android app's notifications (fcm.js): a Firebase service-account key file. Unset: the app has none.
    fcmServiceAccount: env.FCM_SERVICE_ACCOUNT || null,
    // Tiles for devices without WebGL drawn here (raster.js): needs @maplibre/maplibre-gl-native and xvfb-run.
    rasterRender: env.RASTER_RENDER === '1',
    // The iPhone app's notifications (apns.js): a .p8 key from the Apple Developer account, its id, the team id.
    apns: { keyFile: env.APNS_KEY_FILE || null, keyId: env.APNS_KEY_ID || null, teamId: env.APNS_TEAM_ID || null, topic: env.APNS_TOPIC || 'net.ojee.health' },
    syncMinutes: Math.min(120, Math.max(10, Number(env.SYNC_MINUTES) || 20)),
    idleSyncHours: 6,
    idleAfterDays: 14,
    maxInFlight: Math.min(10, Math.max(1, Number(env.SYNC_CONCURRENCY) || 3)),
    maxWorlds: Math.max(4, Number(env.WORLD_CACHE) || 40),
    defaultTz: env.DEFAULT_TZ || 'Africa/Cairo',
    scheduler: env.HEALTH_SCHEDULER !== 'off',
    // Behind nginx and cloudflared the socket's address is 127.0.0.1; the
    // visitor's is in these headers. Off when exposed directly.
    trustProxy: env.TRUST_PROXY !== 'false',
    // Uploads go through ffmpeg (media.js, mediaproc.js): videos kept as MP4/WebM without their metadata, photos
    // a browser could not open made JPEG. VIDEO_CLEAN=off uses no ffmpeg: videos kept as sent (tests: fake files).
    videoClean: env.VIDEO_CLEAN !== 'off',
  };
}
