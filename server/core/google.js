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
   revision 20261007), not from tutorials, and corrected by a
   read-only probe of the real API (docs/DATA-TYPES.md says which
   call each data type really answers).

   Permissions come in two layers. The CORE scopes are asked for at
   connect, as they always were. Five optional GROUPS (nutrition,
   mindfulness, symptoms, cycle, ECG) are asked for only when the
   person switches one on: Google's incremental authorization
   (`include_granted_scopes=true`) adds them to the grant already
   held, and the token reply then lists the combined scopes.
   ============================================================ */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ymd, dateObj, addDays } from './util.js';

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

/** Scopes outside the core set. Asked for only with their group. */
export const GROUP_SCOPES = {
  nutritionWrite: `${G}nutrition.writeonly`,
  mindfulnessWrite: `${G}mindfulness.writeonly`,
  symptomsWrite: `${G}logged_symptoms.writeonly`,
  cycleWrite: `${G}reproductive_health.writeonly`,
  sleepWrite: `${G}sleep.writeonly`,
  ecg: `${G}ecg.readonly`,
  irn: `${G}irn.readonly`,
};
/** Route maps: the GPS route of a run, walk or ride (exportExerciseTcx). Not a group and never asked
    with the rest: only when the person taps "Allow route maps" on a workout (authUrl, routes: true). */
export const LOCATION_SCOPE = `${G}location.readonly`;

/**
 * The optional groups. `id` is a stable API string. Four of them hold only
 * a WRITE scope: Google has no nutrition.readonly at all, and moods,
 * symptoms and cycle data cannot be listed through the API whatever the
 * scope (the real API answers "List is not supported"). So what is logged
 * here is saved to Google Health too, and what is logged in Google's own
 * app cannot be read by this or any other app. ECG is the reverse: read
 * only, there is no write scope.
 */
export const GROUPS = [
  {
    id: 'nutrition', label: 'Nutrition and water', scopeKeys: ['nutritionWrite'], readOnly: false, writeOnly: true,
    about: 'Log water and food here. Each entry is saved to Google Health too.',
    note: 'What you log here is saved to Google Health too. What you log in Google\'s own app cannot be read by other apps.',
    types: ['hydration-log', 'nutrition-log'], kinds: ['water', 'food'],
  },
  {
    id: 'mindfulness', label: 'Mood and mindfulness', scopeKeys: ['mindfulnessWrite'], readOnly: false, writeOnly: true,
    about: 'Log how you feel. Each entry is saved to Google Health too.',
    note: 'What you log here is saved to Google Health too. What you log in Google\'s own app cannot be read by other apps.',
    types: ['moods'], kinds: ['mood'],
  },
  {
    id: 'symptoms', label: 'Symptoms', scopeKeys: ['symptomsWrite'], readOnly: false, writeOnly: true,
    about: 'Log symptoms as they happen. Each entry is saved to Google Health too.',
    note: 'What you log here is saved to Google Health too. What you log in Google\'s own app cannot be read by other apps.',
    types: ['symptoms'], kinds: ['symptom'],
  },
  {
    id: 'cycle', label: 'Cycle tracking', scopeKeys: ['cycleWrite'], readOnly: false, writeOnly: true,
    about: 'Log periods and ovulation tests. Each entry is saved to Google Health too.',
    note: 'What you log here is saved to Google Health too. What you log in Google\'s own app cannot be read by other apps.',
    types: ['menstrual-period', 'ovulation-test'], kinds: ['period', 'ovulation'],
  },
  {
    id: 'sleeplog', label: 'Logging sleep', scopeKeys: ['sleepWrite'], readOnly: false, writeOnly: true,
    about: 'Log a night or a nap by hand, for nights your device missed or when you do not wear one. Each one is saved to Google Health too.',
    note: 'A night logged here is saved to Google Health too, and comes back with the next sync like any other night.',
    types: ['sleep'], kinds: ['sleep'],
  },
  {
    id: 'ecg', label: 'ECG and rhythm notices', scopeKeys: ['ecg', 'irn'], readOnly: true, writeOnly: false,
    about: 'Shows the ECG readings and irregular rhythm notices your watch recorded.',
    note: 'Read only: readings are taken on the watch. The waveform itself is not kept here.',
    types: ['electrocardiogram', 'irregular-rhythm-notification'], kinds: ['ecg', 'irn'],
  },
].map((g) => Object.freeze({ ...g, scopes: g.scopeKeys.map((k) => GROUP_SCOPES[k]) }));
export const GROUP_IDS = GROUPS.map((g) => g.id);
export const groupById = (id) => GROUPS.find((g) => g.id === id) || null;
/** The valid group ids in a list (or a comma-separated string), in order. */
export const cleanGroups = (v) => {
  const want = new Set(Array.isArray(v) ? v.map(String) : String(v || '').split(','));
  return GROUP_IDS.filter((id) => want.has(id));
};
/** A scope without the long prefix, as the page shows it. */
export const shortScope = (s) => String(s).replace(G, '');

/** dailyRollUp refuses a range over 14 days for these; 90 for the rest. */
export const ROLLUP_CAP_14 = new Set(['heart-rate', 'active-minutes', 'total-calories', 'calories-in-heart-rate-zone']);
export const ROLLUP_MAX_DAYS = 90;

/** The data types this app writes, and the scope each write needs. */
export const WRITABLE = {
  exercise: SCOPES.activityWrite,
  weight: SCOPES.weightWrite,
  'body-fat': SCOPES.weightWrite,
  height: SCOPES.weightWrite,
  'blood-glucose': SCOPES.weightWrite,
  'core-body-temperature': SCOPES.weightWrite,
  'hydration-log': GROUP_SCOPES.nutritionWrite,
  'nutrition-log': GROUP_SCOPES.nutritionWrite,
  moods: GROUP_SCOPES.mindfulnessWrite,
  symptoms: GROUP_SCOPES.symptomsWrite,
  'menstrual-period': GROUP_SCOPES.cycleWrite,
  'ovulation-test': GROUP_SCOPES.cycleWrite,
  sleep: GROUP_SCOPES.sleepWrite,
};

const POINT_NAME = /^users\/[^/]+\/dataTypes\/([a-z0-9-]+)\/dataPoints\/[^/]+$/;
/** The data type in a point name, or null when it is not one. */
export const typeOfName = (name) => POINT_NAME.exec(String(name))?.[1] || null;
/** A name this client may propose on create: 4-63 lowercase letters,
    digits and hyphens after the collection. */
export const pointNameFor = (type, id) => {
  const tail = String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
  if (!WRITABLE[type] || tail.length < 4) throw new ApiError('not a data point id', { code: 'bad_name' });
  return `users/me/dataTypes/${type}/dataPoints/${tail}`;
};

/* ── request bodies for the points this app writes ───────────────────
   Pure: each returns a DataPoint exactly as the discovery schemas name
   the fields. int64 fields go as strings, durations as "123s". Every
   one is marked MANUAL, as the weight form always was. */

const rfc = (t) => new Date(t).toISOString();
const off = (sec = 0) => `${Math.round(sec)}s`;
const MANUAL = { recordingMethod: 'MANUAL' };
const sampleTime = (at, offsetSec) => ({ physicalTime: rfc(at), utcOffset: off(offsetSec) });
/** Observation and session intervals take the same four writable fields. */
const interval = (start, end, offsetSec, endOffsetSec = offsetSec) => ({
  startTime: rfc(start), startUtcOffset: off(offsetSec), endTime: rfc(end), endUtcOffset: off(endOffsetSec),
});
const named = (name, body) => ({ ...(name ? { name } : {}), ...body, dataSource: MANUAL });
const text = (v, max = 200) => String(v).slice(0, max);

export const build = {
  weight: ({ grams, at, offsetSec = 0, notes, name }) => named(name, {
    weight: { weightGrams: grams, sampleTime: sampleTime(at, offsetSec), ...(notes ? { notes: text(notes) } : {}) },
  }),
  'body-fat': ({ pct, at, offsetSec = 0, name }) => named(name, { bodyFat: { percentage: pct, sampleTime: sampleTime(at, offsetSec) } }),
  height: ({ mm, at, offsetSec = 0, name }) => named(name, { height: { heightMillimeters: String(Math.round(mm)), sampleTime: sampleTime(at, offsetSec) } }),
  'blood-glucose': ({ mgdl, timing, meal, notes, at, offsetSec = 0, name }) => named(name, {
    bloodGlucose: {
      bloodGlucoseMilligramsPerDeciliter: mgdl, sampleTime: sampleTime(at, offsetSec),
      ...(timing ? { measurementTiming: timing } : {}), ...(meal ? { mealType: meal } : {}), ...(notes ? { notes: text(notes) } : {}),
    },
  }),
  'core-body-temperature': ({ celsius, location, at, offsetSec = 0, name }) => named(name, {
    coreBodyTemperature: { temperatureCelsius: celsius, sampleTime: sampleTime(at, offsetSec), ...(location ? { measurementLocation: location } : {}) },
  }),
  /** A drink is an instant to the person and a session to Google: a
      one-minute interval starting when it was logged. */
  'hydration-log': ({ ml, at, end = at + 60_000, offsetSec = 0, name }) => named(name, {
    hydrationLog: { amountConsumed: { milliliters: ml }, interval: interval(at, end, offsetSec) },
  }),
  /** An anonymous food: a display name and its numbers, no Food resource. */
  'nutrition-log': ({ food, meal, kcal, protein, carbs, fat, at, end = at + 60_000, offsetSec = 0, name }) => named(name, {
    nutritionLog: {
      foodDisplayName: text(food, 120),
      ...(meal ? { mealType: meal } : {}),
      ...(Number.isFinite(kcal) ? { energy: { kcal } } : {}),
      ...(Number.isFinite(fat) ? { totalFat: { grams: fat } } : {}),
      ...(Number.isFinite(carbs) ? { totalCarbohydrate: { grams: carbs } } : {}),
      ...(Number.isFinite(protein) ? { nutrients: [{ nutrient: 'PROTEIN', quantity: { grams: protein } }] } : {}),
      interval: interval(at, end, offsetSec),
    },
  }),
  moods: ({ moods, valence, at, offsetSec = 0, name }) => named(name, {
    moods: { moods: [...moods], ...(valence ? { valences: [valence] } : {}), sampleTime: sampleTime(at, offsetSec) },
  }),
  symptoms: ({ symptoms, at, offsetSec = 0, name }) => named(name, { symptoms: { symptoms: [...symptoms], sampleTime: sampleTime(at, offsetSec) } }),
  'menstrual-period': ({ at, end, offsetSec = 0, endOffsetSec = offsetSec, notes, name }) => named(name, {
    menstrualPeriod: { interval: interval(at, end, offsetSec, endOffsetSec), ...(notes ? { notes: text(notes) } : {}) },
  }),
  'ovulation-test': ({ result, at, offsetSec = 0, name }) => named(name, { ovulationTest: { result, sampleTime: sampleTime(at, offsetSec) } }),
  // A night logged by hand: its interval, nothing more. Stages, the
  // summary and the metadata are Google's own (output only).
  sleep: ({ at, end, offsetSec = 0, endOffsetSec = offsetSec, name }) => named(name, { sleep: { interval: interval(at, end, offsetSec, endOffsetSec) } }),
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
  /** Does the grant hold every scope of an optional group. */
  groupGranted(id) { const g = groupById(id); return !!g && g.scopes.every((s) => this.granted(s)); }
  /** Connected, and holding the scope a write of this data type needs. */
  canWrite(type) { return this.connected() && !!WRITABLE[type] && this.granted(WRITABLE[type]); }

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
      // The optional groups: only whether Google granted them. Whether the
      // person CHOSE one is theirs to say (world.groups()), not the token's.
      groups: GROUPS.map((g) => ({ id: g.id, granted: !!t.refresh && g.scopes.every((x) => t.scopes?.includes(x)) })),
      // Only while connected: before that nothing is "missing", it is all
      // unasked. An optional group is never "missing": it was never owed.
      missing: t.refresh ? Object.entries(SCOPES).filter(([, s]) => !t.scopes?.includes(s)).map(([k]) => SCOPE_MISSING[k]) : [],
    };
  }

  /* ── sign-in ──────────────────────────────────────────────────────── */

  /** The consent URL for a state and code challenge the caller made (pkce()).
      `groups` adds the scopes of those optional groups; with none it asks
      for exactly the core set. */
  authUrl({ state, challenge, groups = [], routes = false, chooser = false, loginHint = null }) {
    if (!this.configured()) throw new ApiError('GOOGLE_HEALTH_CLIENT_ID / _SECRET or the redirect URI is not set', { code: 'unconfigured' });
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: [...IDENTITY_SCOPES, ...Object.values(SCOPES), ...cleanGroups(groups).flatMap((id) => groupById(id).scopes), ...(routes ? [LOCATION_SCOPE] : [])].join(' '),
      access_type: 'offline',
      // Adding another account: Google's account chooser, not the browser's
      // signed-in account picked silently. Reconnecting one: that account
      // suggested, so the right one is a single tap.
      prompt: chooser ? 'select_account consent' : 'consent',
      ...(loginHint && !chooser ? { login_hint: loginHint } : {}),
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
  authorizeUrl({ groups = [] } = {}) {
    const { verifier, challenge, state } = pkce();
    const url = this.authUrl({ state, challenge, groups });
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

  /** Take over tokens another instance obtained (a sign-in finished on a
      fresh client, then given to the account it turned out to be). */
  adopt(tok) {
    this.tok = tok ? { ...tok } : null;
    this.#save();
    return this.status();
  }

  /** Forget the tokens. `revoke: false` leaves the grant at Google alone:
      for tokens of an account that is connected here another way, where
      revoking would cut that connection too. */
  async disconnect({ revoke = true } = {}) {
    const refresh = this.tok?.refresh;
    this.tok = null;
    this.#save();
    if (refresh && revoke) {
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
        // A refresh reply may leave `scope` out: the grant is unchanged, so
        // the list from the last exchange (core plus any groups) stands.
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

  /** A workout's GPS route as TCX text (exportExerciseTcx; needs the location scope). `name` is the data point's name. */
  async exerciseTcx(name, retried = false) {
    const url = new URL(`${this.ep.api}/v4/${String(name).replace(/^\/+/, '')}:exportExerciseTcx`);
    url.searchParams.set('alt', 'media');
    let res;
    try { res = await this.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${await this.access()}` } }); } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(`Google Health unreachable: ${e.cause?.code || e.message}`, { code: 'network' });
    }
    if (res.status === 401 && !retried) { if (this.tok) this.tok.access = null; return this.exerciseTcx(name, true); }
    const text = await res.text();
    if (res.status === 429) throw new ApiError('Google Health asked us to slow down', { status: 429, code: 'rate_limited' });
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* not JSON */ } throw new ApiError(msg, { status: res.status, code: `http_${res.status}` }); }
    return text;
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

  /** dataPoints:dailyRollUp over [start, end) civil dates, one window a day.
      A range longer than the type allows (14 days for four types, 90 for
      the rest) is asked in as many calls as it takes. */
  async dailyRollUp(type, start, end) {
    const out = [];
    const max = ROLLUP_CAP_14.has(type) ? 14 : ROLLUP_MAX_DAYS;
    const civil = (s) => ({ date: dateObj(s) });
    for (let a = start; a < end; a = addDays(a, max)) {
      const b = addDays(a, max) < end ? addDays(a, max) : end;
      let pageToken;
      for (let i = 0; i < 20; i += 1) {
        const r = await this.call('POST', `users/me/dataTypes/${type}/dataPoints:dailyRollUp`, {
          body: { range: { start: civil(a), end: civil(b) }, windowSizeDays: 1, ...(pageToken ? { pageToken } : {}) },
        });
        out.push(...(r.rollupDataPoints || []));
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
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
    return this.createPoint('weight', build.weight({ grams, at, offsetSec, notes }));
  }

  /* ── any writable point ───────────────────────────────────────────── */

  /** Create one data point of a writable type (a body from `build`).
      Returns the Operation; `response.name` is the point's name when
      Google gives it one. */
  async createPoint(type, body) {
    if (!WRITABLE[type]) throw new ApiError(`${type} is not a data type this app writes`, { code: 'bad_type' });
    if (body?.name !== undefined && typeOfName(body.name) !== type) throw new ApiError(`not a ${type} data point name`, { code: 'bad_name' });
    return this.call('POST', `users/me/dataTypes/${type}/dataPoints`, { body });
  }

  /** Replace a point this client wrote, by its name. */
  async patchPoint(name, body) {
    const type = typeOfName(name);
    if (!type || !WRITABLE[type]) throw new ApiError('not a data point name this app can write', { code: 'bad_name' });
    return this.call('PATCH', name, { body: { ...body, name } });
  }

  /** Delete points of one type by name. Google only lets a client delete
      what it wrote itself, and only through batchDelete. */
  async deletePoints(type, names) {
    const list = [...(names || [])].map(String);
    if (!WRITABLE[type]) throw new ApiError(`${type} is not a data type this app writes`, { code: 'bad_type' });
    if (!list.length || list.some((n) => typeOfName(n) !== type)) throw new ApiError(`not ${type} data point names`, { code: 'bad_name' });
    return this.call('POST', `users/me/dataTypes/${type}/dataPoints:batchDelete`, { body: { names: list } });
  }
}

export { ymd };
