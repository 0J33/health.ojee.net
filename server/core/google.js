/* ============================================================
   health.ojee.net — the Google side, for ONE person: sign-in,
   tokens, API calls. Each person's world holds its own instance,
   pointed at its own token file.

   Sign-in is Google's web-server flow — authorization code, with the
   client secret held here and PKCE on top (Google accepts a code
   challenge from a web client; it costs nothing and closes the
   intercepted-code hole). `access_type=offline` + `prompt=consent`
   is what makes Google hand over a refresh token every time.

   The refresh token is the one real credential. It lives in the data
   volume, mode 0600, and is never sent to the browser, never logged,
   never put in an error message. The browser learns "connected as
   x@gmail.com, refreshed 3 min ago" and nothing more.

   Endpoints and field names are from the API's own discovery
   document (health.googleapis.com/$discovery/rest?version=v4,
   revision 20261002), not from tutorials.
   ============================================================ */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ymd, dateObj } from './util.js';

/** Where Google lives. Overridable per instance so the demo and the tests
    can stand a fake one in. */
export const ENDPOINTS = {
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  api: (process.env.GOOGLE_HEALTH_API || 'https://health.googleapis.com').replace(/\/+$/, ''),
};

const G = 'https://www.googleapis.com/auth/googlehealth.';
/** What each scope opens. Only these are asked for: read for the panels,
    write only for the weight form and the workouts this module saves. */
export const SCOPES = {
  activity: `${G}activity_and_fitness.readonly`,           // steps, AZM, calories, exercise
  metrics: `${G}health_metrics_and_measurements.readonly`,  // HR, RHR, HRV, SpO2, temp, weight, body fat
  sleep: `${G}sleep.readonly`,
  settings: `${G}settings.readonly`,                        // paired devices: battery, last sync
  weightWrite: `${G}health_metrics_and_measurements.writeonly`,
  activityWrite: `${G}activity_and_fitness.writeonly`,        // saving a workout (exercise)
};
const IDENTITY_SCOPES = ['openid', 'email'];
/** What each one is for, in the words the Connections page shows. */
export const SCOPE_LABELS = {
  activity: 'Steps, active minutes, calories, distance, exercise',
  metrics: 'Heart rate, HRV, SpO2, temperature, weight, body fat',
  sleep: 'Sleep and sleep stages',
  settings: 'Paired devices: battery and last sync',
  weightWrite: 'Saving a weigh-in',
  activityWrite: 'Saving workouts',
};
/** What to say when a scope was declined. */
export const SCOPE_MISSING = {
  activity: 'Reconnect to allow reading steps, activity and exercise',
  metrics: 'Reconnect to allow reading heart rate, HRV and weight',
  sleep: 'Reconnect to allow reading sleep',
  settings: 'Reconnect to allow reading your device battery and last sync',
  weightWrite: 'Reconnect to allow saving your weight',
  activityWrite: 'Reconnect to allow saving workouts',
};

/** A fresh PKCE pair and state for one sign-in attempt. The caller keeps the
    verifier (bound to the person's session) until Google sends them back. */
export function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(16)) };
}

/** Refresh tokens of an app left in "Testing" die after 7 days. A refresh
    that fails with invalid_grant somewhere around that age is almost
    certainly that, and the page says so. */
const TESTING_WINDOW = [6.25 * 86_400_000, 8.5 * 86_400_000];

const b64url = (buf) => buf.toString('base64url');

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The email in an ID token, from the token endpoint's own reply (TLS, our
    client) — so the payload is read, not verified. */
function emailFrom(idToken) {
  try {
    const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof p.email === 'string' ? p.email : null;
  } catch { return null; }
}

export class GoogleHealth {
  constructor({
    clientId = '', clientSecret = '', redirectUri = '', tokenFile, fetchImpl = fetch, now = () => Date.now(), endpoints = ENDPOINTS,
  } = {}) {
    this.ep = { ...ENDPOINTS, ...endpoints };
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.tokenFile = tokenFile;
    this.fetch = fetchImpl;
    this.now = now;
    this.pending = new Map();   // state -> { verifier, at }
    this.tok = this.#load();    // see #save for the shape
    this.refreshing = null;
  }

  configured() { return !!(this.clientId && this.clientSecret && this.redirectUri); }
  connected() { return !!this.tok?.refresh; }
  granted(scope) { return !!this.tok?.scopes?.includes(scope); }

  #load() {
    if (!this.tokenFile) return null;
    try { return JSON.parse(readFileSync(this.tokenFile, 'utf8')); } catch { return null; }
  }

  #save() {
    if (!this.tokenFile) return;
    mkdirSync(dirname(this.tokenFile), { recursive: true });
    const tmp = `${this.tokenFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tok), { mode: 0o600 });
    renameSync(tmp, this.tokenFile);
    try { chmodSync(this.tokenFile, 0o600); } catch { /* best effort */ }
  }

  /** What the page may know about the connection. No token ever leaves. */
  status() {
    const t = this.tok || {};
    const state = !this.configured() ? 'unconfigured'
      : t.refresh ? 'ok'
        : t.expiredAt ? 'expired' : 'needs_auth';
    return {
      state,
      email: t.email || null,
      connectedAt: t.obtainedAt || null,
      lastRefreshAt: t.lastRefreshAt || null,
      accessExpiresAt: t.access ? t.expiresAt : null,
      refreshError: t.refreshError || null,
      expiredAt: t.expiredAt || null,
      testingExpiry: !!t.testingExpiry,
      tokenAgeDays: t.obtainedAt ? Math.floor((this.now() - t.obtainedAt) / 86_400_000) : null,
      scopes: Object.entries(SCOPES).map(([k, s]) => ({ scope: s.replace(G, ''), granted: !!t.scopes?.includes(s), label: SCOPE_LABELS[k] })),
      // Only while connected: before that nothing is "missing", it is all unasked.
      missing: t.refresh ? Object.entries(SCOPES).filter(([, s]) => !t.scopes?.includes(s)).map(([k]) => SCOPE_MISSING[k]) : [],
    };
  }

  /* ── sign-in ──────────────────────────────────────────────────────── */

  /** The consent URL for a state and code challenge the caller made (pkce()). */
  authUrl({ state, challenge }) {
    if (!this.configured()) throw new ApiError('GOOGLE_HEALTH_CLIENT_ID / _SECRET or the redirect URI is not set', { code: 'unconfigured' });
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: [...IDENTITY_SCOPES, ...Object.values(SCOPES)].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return `${this.ep.auth}?${q}`;
  }

  /** authUrl() with the pending attempt kept here: for a single-person use
      of this class (and its tests). The server keeps attempts itself, bound
      to the session, and calls authUrl()/exchange(). */
  authorizeUrl() {
    const { verifier, challenge, state } = pkce();
    const url = this.authUrl({ state, challenge });
    const t = this.now();
    for (const [k, v] of this.pending) if (t - v.at > 10 * 60_000) this.pending.delete(k);
    this.pending.set(state, { verifier, at: t });
    return url;
  }

  async finishAuth({ code, state }) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p) throw new ApiError('This sign-in link has expired. Start again.', { code: 'bad_state' });
    return this.exchange({ code, verifier: p.verifier });
  }

  /** Trade the code Google sent back for tokens. */
  async exchange({ code, verifier }) {
    const p = { verifier };
    const t = await this.#token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: p.verifier,
    });
    if (!t.refresh_token) {
      throw new ApiError('Google did not return a refresh token. Remove the app\'s access at myaccount.google.com/permissions and connect again.', { code: 'no_refresh' });
    }
    const at = this.now();
    this.tok = {
      refresh: t.refresh_token,
      access: t.access_token,
      expiresAt: at + (Number(t.expires_in) || 3600) * 1000,
      scopes: String(t.scope || '').split(/\s+/).filter(Boolean),
      email: emailFrom(t.id_token),
      obtainedAt: at,
      lastRefreshAt: at,
      refreshError: null,
    };
    this.#save();
    return this.status();
  }

  async disconnect() {
    const refresh = this.tok?.refresh;
    this.tok = null;
    this.#save();
    if (refresh) {
      // Best effort: tell Google too, so the grant does not linger in the
      // account's third-party list.
      try {
        await this.fetch(this.ep.revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }) });
      } catch { /* the local copy is gone either way */ }
    }
  }

  async #token(form) {
    let res;
    try {
      res = await this.fetch(this.ep.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
    } catch (e) {
      throw new ApiError(`token endpoint unreachable: ${e.cause?.code || e.message}`, { code: 'network' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(body.error_description || body.error || `token HTTP ${res.status}`, { status: res.status, code: body.error || 'token_error' });
    }
    return body;
  }

  /** A live access token, refreshing when it is within a minute of expiry. */
  async access({ force = false } = {}) {
    if (!this.tok?.refresh) throw new ApiError('Not connected to Google Health', { code: 'needs_auth' });
    if (!force && this.tok.access && this.now() < this.tok.expiresAt - 60_000) return this.tok.access;
    // One refresh at a time: two concurrent calls must not both spend it.
    this.refreshing ||= this.#refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async #refresh() {
    try {
      const t = await this.#token({
        grant_type: 'refresh_token',
        refresh_token: this.tok.refresh,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      const at = this.now();
      this.tok = {
        ...this.tok,
        // Google usually keeps the same refresh token; if it ever sends a new
        // one, the new one is the one that works.
        refresh: t.refresh_token || this.tok.refresh,
        access: t.access_token,
        expiresAt: at + (Number(t.expires_in) || 3600) * 1000,
        scopes: t.scope ? String(t.scope).split(/\s+/).filter(Boolean) : this.tok.scopes,
        lastRefreshAt: at,
        refreshError: null,
      };
      this.#save();
      return this.tok.access;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        // Revoked, or expired. Nothing but a person signing in again fixes
        // it — so the token goes, and what is known about why stays.
        const at = this.now();
        const age = at - (this.tok.obtainedAt ?? at);
        this.tok = {
          email: this.tok.email,
          scopes: this.tok.scopes,
          obtainedAt: this.tok.obtainedAt,
          lastRefreshAt: this.tok.lastRefreshAt,
          expiredAt: at,
          refreshError: e.message,
          testingExpiry: age >= TESTING_WINDOW[0] && age <= TESTING_WINDOW[1],
        };
        this.#save();
        throw new ApiError('Google Health access expired or was revoked. Connect again.', { code: 'needs_auth' });
      }
      if (this.tok) { this.tok.refreshError = e.message; this.#save(); }
      throw e;
    }
  }

  /* ── API ──────────────────────────────────────────────────────────── */

  async call(method, path, { query, body } = {}, retried = false) {
    const url = new URL(`${this.ep.api}/v4/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: { authorization: `Bearer ${await this.access()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(`Google Health unreachable: ${e.cause?.code || e.message}`, { code: 'network' });
    }
    if (res.status === 401 && !retried) {
      // The access token died early; refresh once and try again.
      if (this.tok) this.tok.access = null;
      return this.call(method, path, { query, body }, true);
    }
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (res.status === 429) {
      throw new ApiError('Google Health asked us to slow down', { status: 429, code: 'rate_limited', retryAfter: Number(res.headers.get('retry-after')) || 60 });
    }
    if (!res.ok) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      throw new ApiError(msg, { status: res.status, code: json?.error?.status || `http_${res.status}` });
    }
    return json || {};
  }

  /** dataPoints.list, every page. Newest first, per the API. */
  async list(type, { filter, pageSize, maxPages = 40, dataSourceFamily } = {}) {
    const out = [];
    let pageToken;
    for (let i = 0; i < maxPages; i += 1) {
      const r = await this.call('GET', `users/me/dataTypes/${type}/dataPoints`, { query: { filter, pageSize, pageToken, dataSourceFamily } });
      out.push(...(r.dataPoints || []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** dataPoints:dailyRollUp over [start, end) civil dates, one window a day. */
  async dailyRollUp(type, start, end) {
    const out = [];
    let pageToken;
    const civil = (s) => ({ date: dateObj(s) });
    for (let i = 0; i < 20; i += 1) {
      const r = await this.call('POST', `users/me/dataTypes/${type}/dataPoints:dailyRollUp`, {
        body: { range: { start: civil(start), end: civil(end) }, windowSizeDays: 1, ...(pageToken ? { pageToken } : {}) },
      });
      out.push(...(r.rollupDataPoints || []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** dataPoints:rollUp over a physical-time range, in fixed windows. */
  async rollUp(type, startMs, endMs, windowSec = 900) {
    const r = await this.call('POST', `users/me/dataTypes/${type}/dataPoints:rollUp`, {
      body: {
        range: { startTime: new Date(startMs).toISOString(), endTime: new Date(endMs).toISOString() },
        windowSize: `${Math.round(windowSec)}s`,
        pageSize: 500,
      },
    });
    return r.rollupDataPoints || [];
  }

  /** dataPoints:rollUp, every page (minute windows over hours: hundreds of
      them). Heart rate and calories cap the range at 14 days. */
  async rollUpAll(type, startMs, endMs, windowSec = 60, maxPages = 10) {
    const out = [];
    let pageToken;
    for (let i = 0; i < maxPages; i += 1) {
      const r = await this.call('POST', `users/me/dataTypes/${type}/dataPoints:rollUp`, {
        body: {
          range: { startTime: new Date(startMs).toISOString(), endTime: new Date(endMs).toISOString() },
          windowSize: `${Math.max(1, Math.round(windowSec))}s`,
          pageSize: 5000,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      out.push(...(r.rollupDataPoints || []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** Write one exercise data point (a DataPoint with `exercise`). Returns
      the Operation; `response.name` is the point's name when it is done. */
  async createExercise(dataPoint) {
    return this.call('POST', 'users/me/dataTypes/exercise/dataPoints', { body: dataPoint });
  }

  /** Replace an exercise this client wrote, by its name. */
  async patchExercise(name, dataPoint) {
    if (!/^users\/[^/]+\/dataTypes\/exercise\/dataPoints\/[^/]+$/.test(String(name))) throw new ApiError('not an exercise data point name', { code: 'bad_name' });
    return this.call('PATCH', name, { body: { ...dataPoint, name } });
  }

  /** Delete exercise points by name. Google only lets a client delete what
      it wrote itself. There is no single-point delete in v4: batchDelete. */
  async deleteExercises(names) {
    return this.call('POST', 'users/me/dataTypes/exercise/dataPoints:batchDelete', { body: { names } });
  }

  async pairedDevices() {
    const r = await this.call('GET', 'users/me/pairedDevices', { query: { pageSize: 20 } });
    return r.pairedDevices || [];
  }

  /** Write one weight sample. Returns the long-running Operation. */
  async createWeight({ grams, at, offsetSec = 0, notes }) {
    return this.call('POST', 'users/me/dataTypes/weight/dataPoints', {
      body: {
        weight: {
          weightGrams: grams,
          sampleTime: { physicalTime: new Date(at).toISOString(), utcOffset: `${Math.round(offsetSec)}s` },
          ...(notes ? { notes: String(notes).slice(0, 200) } : {}),
        },
        dataSource: { recordingMethod: 'MANUAL' },
      },
    });
  }
}

export { ymd };
