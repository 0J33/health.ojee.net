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
export const VERSION = '1.0.0';

/** Free OpenCode Zen models, tried in this order: the zero-retention ones
    first. */
export const ZEN_DEFAULT_MODELS = ['space-bunny-free', 'longcat-2.5-preview-free', 'step-5-preview-free', 'big-pickle', 'mimo-v2.6-flash-free'];

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
    dataDir,
    webDir: env.WEB_DIR || join(ROOT, 'web'),
    mongoUri: env.MONGODB_URI || 'mongodb://localhost:27017/mtg',
    cookieDomain: env.COOKIE_DOMAIN || '',
    // The shared cookie is Secure + SameSite=None, exactly as mtg and dnd set
    // it. A browser will not keep a Secure cookie from plain http, so on an
    // http origin (local runs, the demo) it is sent as Lax without Secure.
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : !origin.startsWith('http://'),
    admins: list(env.ADMIN_USERS || 'ojee').map((s) => s.toLowerCase()),
    appSecret: env.APP_SECRET || (demo ? randomBytes(32).toString('hex') : ''),
    google: {
      clientId: (env.GOOGLE_HEALTH_CLIENT_ID || '').trim(),
      clientSecret: (env.GOOGLE_HEALTH_CLIENT_SECRET || '').trim(),
      redirectUri: env.GOOGLE_HEALTH_REDIRECT_URI || (origin ? `${origin}/auth/google/callback` : ''),
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
    vapidSubject: env.VAPID_SUBJECT || 'mailto:health@ojee.net',
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
  };
}
