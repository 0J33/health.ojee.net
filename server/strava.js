/* ============================================================
   health.ojee.net — Strava.

   One Strava API application for the whole site (STRAVA_CLIENT_ID and
   STRAVA_CLIENT_SECRET, made by the owner at strava.com/settings/api,
   with this site's host as the callback domain). Each person connects
   their own Strava account with OAuth; their tokens are sealed in the
   secret table like any other key.

     activities, in    every activity since 90 days before connecting,
                       then whatever changed: a webhook tells this site
                       the moment an activity is made, edited or deleted
                       (POST /api/strava/webhook), and the 20-minute sync
                       is the backstop. An activity that overlaps a
                       workout already here (the watch's own session in
                       Google, a detected one) is the same session: the
                       Strava details (distance, pace, route, heart
                       rate) attach to it. A new one is a workout here
                       with its own type (RUNNING, BIKING, ...).
     to Google         an activity Google has no session for is saved
                       to Google Health after a wait (Strava often sends
                       it there itself through Health Connect), unless
                       switched off.
     to Strava         off by default: a workout finished here (logged,
                       detected and confirmed, from Hevy) is created on
                       Strava as a manual activity. Never one that came
                       from Strava.

   Limits (developers.strava.com/docs/rate-limits): 200 requests per 15
   minutes and 2,000 a day for the whole app, and fewer for reads. The
   usage Strava reports in its headers is kept, and syncs stand aside
   when it gets close; a person's sync is one list call most of the time.
   New apps can serve one athlete until the owner raises it (up to 10
   without review) in the Strava API settings.
   ============================================================ */

import { localToMs, utcOffsetSec } from './core/util.js';
import { toGpx, cleanPoints, trackStats, routeType } from './tracks.js';

export const STRAVA_AUTH = 'https://www.strava.com/oauth/authorize';
export const STRAVA_TOKEN = 'https://www.strava.com/oauth/token';
export const STRAVA_DEAUTH = 'https://www.strava.com/oauth/deauthorize';
export const STRAVA_API = 'https://www.strava.com/api/v3';
export const STRAVA_SCOPES = 'read,activity:read_all,activity:write';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const STRAVA_DEFAULTS = { toGoogle: true, toStrava: false, routesToStrava: true, streams: true };
const GOOGLE_WAIT = 30 * MIN;
/** How long a route recorded here waits before going to Strava, for a watch's own copy to arrive first. */
const ROUTE_WAIT = 30 * MIN;
const BACKFILL_DAYS = 90;

export class StravaError extends Error {
  constructor(message, { status = 0, code = 'upstream', retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** What Strava said about the app's usage, shared by every person. Two
    budgets: overall (200 / 15 min, 2,000 a day) and reads (100 / 15 min,
    1,000 a day). Nearly every call here is a read, so the read budget is
    the one that binds. */
export class StravaBudget {
  constructor() { this.usage = null; this.reads = null; this.at = 0; this.pauseUntil = 0; }
  static #pair(headers, kind) {
    const lim = String(headers?.get?.(`x-${kind}-limit`) || '').split(',').map(Number);
    const use = String(headers?.get?.(`x-${kind}-usage`) || '').split(',').map(Number);
    if (lim.length === 2 && use.length === 2 && lim.every(Number.isFinite) && use.every(Number.isFinite)) return { shortUsed: use[0], shortLimit: lim[0], dayUsed: use[1], dayLimit: lim[1] };
    return null;
  }
  read(headers) {
    const all = StravaBudget.#pair(headers, 'ratelimit');
    const reads = StravaBudget.#pair(headers, 'readratelimit');
    if (all) this.usage = all;
    if (reads) this.reads = reads;
    if (all || reads) this.at = Date.now();
  }
  /** Room for `n` more calls now? Keeps a margin for webhooks and logins. */
  room(n = 1) {
    if (Date.now() < this.pauseUntil) return false;
    if (Date.now() - this.at > 15 * MIN) return true;
    const ok = (u) => !u || (u.shortUsed + n <= u.shortLimit * 0.85 && u.dayUsed + n <= u.dayLimit * 0.9);
    return ok(this.usage) && ok(this.reads);
  }
  view() { return this.usage || this.reads ? { ...(this.usage || {}), reads: this.reads, at: this.at, paused: Date.now() < this.pauseUntil } : null; }
}

export class StravaApi {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {string} o.clientSecret
   * @param {object} o.tokens        { access, refresh, expiresAt (s) }
   * @param {Function} o.onTokens     (tokens) => void, when they were refreshed
   * @param {StravaBudget} [o.budget]
   * @param {Function} [o.fetchImpl]
   * @param {object} [o.urls]         { api, token, deauth }
   */
  constructor({ clientId, clientSecret, tokens, onTokens = () => {}, budget = new StravaBudget(), fetchImpl = globalThis.fetch, urls = {}, timeoutMs = 20_000 }) {
    this.clientId = clientId; this.clientSecret = clientSecret;
    this.tokens = tokens ? { ...tokens } : null;
    this.onTokens = onTokens;
    this.budget = budget;
    this.fetch = fetchImpl;
    this.urls = { api: STRAVA_API, token: STRAVA_TOKEN, deauth: STRAVA_DEAUTH, ...urls };
    this.timeoutMs = timeoutMs;
    this.calls = 0;
  }

  async #http(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    timer.unref?.();
    try { return await this.fetch(url, { ...init, signal: ctl.signal }); } catch (e) {
      throw new StravaError(e.name === 'AbortError' ? 'Strava did not answer in time.' : `Strava could not be reached (${e.message}).`, { code: 'network' });
    } finally { clearTimeout(timer); }
  }

  /** The access token, refreshed when it has under five minutes left. */
  async #access() {
    if (!this.tokens?.refresh) throw new StravaError('Strava is not connected.', { code: 'strava_auth', status: 401 });
    if (this.tokens.access && this.tokens.expiresAt * 1000 - Date.now() > 5 * MIN) return this.tokens.access;
    const res = await this.#http(this.urls.token, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'refresh_token', refresh_token: this.tokens.refresh }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) throw new StravaError('Strava no longer accepts this connection. Connect it again.', { code: 'strava_auth', status: 401 });
      throw new StravaError(`Strava answered ${res.status} when the connection was renewed.`, { status: res.status });
    }
    this.tokens = { ...this.tokens, access: j.access_token, refresh: j.refresh_token || this.tokens.refresh, expiresAt: j.expires_at };
    this.onTokens(this.tokens);
    return this.tokens.access;
  }

  async #call(method, path, { query = null, body = undefined } = {}) {
    if (!this.budget.room()) throw new StravaError('Strava\'s limit for this site is nearly used up. It is tried again later.', { code: 'rate_limited', retryAfter: 15 * 60 });
    const token = await this.#access();
    this.calls += 1;
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}` : '';
    const res = await this.#http(`${this.urls.api}${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.budget.read(res.headers);
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (res.ok) return json;
    const said = json?.message ? String(json.message).slice(0, 200) : '';
    if (res.status === 401) throw new StravaError('Strava no longer accepts this connection. Connect it again.', { status: 401, code: 'strava_auth' });
    if (res.status === 403) throw new StravaError('Strava refused: this connection was not given that permission. Connect it again and allow it.', { status: 403, code: 'strava_scope' });
    if (res.status === 404) throw new StravaError('Strava has no such activity.', { status: 404, code: 'not_found' });
    if (res.status === 429) { this.budget.pauseUntil = Date.now() + 15 * MIN; throw new StravaError('Strava asked this site to slow down.', { status: 429, code: 'rate_limited', retryAfter: 15 * 60 }); }
    throw new StravaError(`Strava answered ${res.status}${said ? `: ${said}` : ''}.`, { status: res.status, code: res.status === 400 ? 'strava_bad' : 'upstream' });
  }

  athlete() { return this.#call('GET', '/athlete'); }

  /** The whole recording of an activity: position, height, time, heart rate, every second or so. */
  streams(id) { return this.#call('GET', `/activities/${encodeURIComponent(id)}/streams`, { query: { keys: 'latlng,altitude,time,heartrate', key_by_type: 'true' } }); }
  uploadStatus(id) { return this.#call('GET', `/uploads/${encodeURIComponent(id)}`); }

  /** A route as a GPX file: Strava makes the activity from it (POST /uploads). */
  async uploadGpx({ gpx, name, description, externalId, activityType }) {
    if (!this.budget.room()) throw new StravaError('Strava\'s limit for this site is nearly used up. It is tried again later.', { code: 'rate_limited', retryAfter: 15 * 60 });
    const token = await this.#access();
    this.calls += 1;
    const form = new FormData();
    form.append('file', new Blob([gpx], { type: 'application/gpx+xml' }), 'route.gpx');
    form.append('data_type', 'gpx');
    if (name) form.append('name', String(name).slice(0, 80));
    if (description) form.append('description', String(description).slice(0, 2000));
    if (externalId) form.append('external_id', externalId);
    if (activityType) form.append('activity_type', activityType);
    const res = await this.#http(`${this.urls.api}/uploads`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, body: form });
    this.budget.read(res.headers);
    const j = await res.json().catch(() => null);
    if (res.ok || res.status === 201) return j;
    if (res.status === 401) throw new StravaError('Strava no longer accepts this connection. Connect it again.', { status: 401, code: 'strava_auth' });
    if (res.status === 403) throw new StravaError('Strava refused: this connection was not given permission to write activities. Connect it again and allow it.', { status: 403, code: 'strava_scope' });
    if (res.status === 429) { this.budget.pauseUntil = Date.now() + 15 * MIN; throw new StravaError('Strava asked this site to slow down.', { status: 429, code: 'rate_limited', retryAfter: 15 * 60 }); }
    throw new StravaError(`Strava did not take the file${j?.error ? `: ${String(j.error).slice(0, 200)}` : ` (${res.status})`}.`, { status: res.status, code: 'strava_bad' });
  }
  activities({ after, before, page = 1, perPage = 50 } = {}) { return this.#call('GET', '/athlete/activities', { query: { after, before, page, per_page: perPage } }); }
  activity(id) { return this.#call('GET', `/activities/${encodeURIComponent(id)}`); }
  /** An activity's photos, each with its picture at about `size` pixels. */
  photos(id, size = 1200) { return this.#call('GET', `/activities/${encodeURIComponent(id)}/photos`, { query: { size, photo_sources: true } }); }
  createActivity(a) { return this.#call('POST', '/activities', { body: a }); }

  /** Give the person's grant back to Strava. Best effort. */
  async deauthorize() {
    if (!this.tokens?.refresh) return;
    try {
      const token = await this.#access();
      await this.#http(this.urls.deauth, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token: token }) });
    } catch { /* already gone */ }
  }
}

/** Swap an authorisation code for tokens. Returns { tokens, athlete, scope }. */
export async function stravaExchange({ clientId, clientSecret, code, fetchImpl = globalThis.fetch, tokenUrl = STRAVA_TOKEN }) {
  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' }),
    });
  } catch (e) { throw new StravaError(`Strava could not be reached (${e.message}).`, { code: 'network' }); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.refresh_token) throw new StravaError(`Strava did not accept the sign-in${j.message ? `: ${String(j.message).slice(0, 120)}` : ''}.`, { status: res.status, code: 'strava_auth' });
  return {
    tokens: { access: j.access_token, refresh: j.refresh_token, expiresAt: j.expires_at },
    athlete: j.athlete ? { id: String(j.athlete.id), name: [j.athlete.firstname, j.athlete.lastname].filter(Boolean).join(' ').slice(0, 80), city: j.athlete.city || null } : null,
  };
}

/* ── Strava's words and Google's ──────────────────────────────────────── */

/** Strava sport_type → Google exercise type. Anything else is WORKOUT. */
const SPORT = {
  Run: 'RUNNING', TrailRun: 'TRAIL_RUN', VirtualRun: 'TREADMILL', Walk: 'WALKING', Hike: 'HIKING',
  Ride: 'BIKING', MountainBikeRide: 'MOUNTAIN_BIKE', GravelRide: 'OUTDOOR_BIKE', EBikeRide: 'ELECTRIC_BIKE', EMountainBikeRide: 'ELECTRIC_BIKE',
  VirtualRide: 'STATIONARY_BIKE', Velomobile: 'BIKING', Handcycle: 'HAND_CYCLING',
  Swim: 'SWIMMING', Rowing: 'ROWING', VirtualRow: 'ROWING_MACHINE', Canoeing: 'CANOEING', Kayaking: 'KAYAKING',
  StandUpPaddling: 'PADDLEBOARDING', Surfing: 'SURFING', Kitesurf: 'KITESURFING', Windsurf: 'WINDSURFING', Sail: 'SAILING',
  AlpineSki: 'SKIING', BackcountrySki: 'SKIING', NordicSki: 'CROSS_COUNTRY_SKI', Snowboard: 'SNOWBOARDING', Snowshoe: 'SNOWSHOEING',
  IceSkate: 'ICE_SKATING', InlineSkate: 'ROLLERBLADING', RollerSki: 'SKIING', Skateboard: 'SKATEBOARDING',
  WeightTraining: 'WEIGHTLIFTING', Crossfit: 'CROSSFIT', Elliptical: 'ELLIPTICAL', StairStepper: 'STAIRCLIMBER',
  HighIntensityIntervalTraining: 'HIIT', Yoga: 'YOGA', Pilates: 'PILATES', Workout: 'WORKOUT',
  RockClimbing: 'ROCK_CLIMBING', Golf: 'GOLF', Soccer: 'SOCCER', Tennis: 'TENNIS', Badminton: 'BADMINTON',
  Pickleball: 'PICKELBALL', Padel: 'PADEL', Racquetball: 'RACQUETBALL', Squash: 'SQUASH', TableTennis: 'TABLE_TENNIS',
  Wheelchair: 'WHEELCHAIR', Dance: 'DANCING', Basketball: 'BASKETBALL', Volleyball: 'VOLLEYBALL', Cricket: 'CRICKET',
};
/** Google type → the Strava sport_type a workout here is sent as. */
const SPORT_OUT = {
  RUNNING: 'Run', TRAIL_RUN: 'TrailRun', TREADMILL: 'Run', INCLINE_RUN: 'Run', WALKING: 'Walk', POWER_WALKING: 'Walk', HIKING: 'Hike',
  BIKING: 'Ride', OUTDOOR_BIKE: 'Ride', MOUNTAIN_BIKE: 'MountainBikeRide', ELECTRIC_BIKE: 'EBikeRide', STATIONARY_BIKE: 'VirtualRide', SPINNING: 'VirtualRide',
  SWIMMING: 'Swim', SWIMMING_POOL: 'Swim', SWIMMING_OPEN_WATER: 'Swim', ROWING: 'Rowing', ROWING_MACHINE: 'Rowing',
  YOGA: 'Yoga', PILATES: 'Pilates', HIIT: 'HighIntensityIntervalTraining', CROSSFIT: 'Crossfit', ELLIPTICAL: 'Elliptical',
  STAIRCLIMBER: 'StairStepper', ROCK_CLIMBING: 'RockClimbing', INDOOR_CLIMBING: 'RockClimbing',
};
export const googleTypeOf = (sport) => SPORT[sport] || 'WORKOUT';
export const stravaSportOf = (type) => SPORT_OUT[type] || (/STRENGTH|WEIGHT|FREE_WEIGHTS|BODY_WEIGHT|CIRCUIT|FUNCTIONAL|POWERLIFT|CALISTHENICS/.test(String(type || '')) ? 'WeightTraining' : 'Workout');

const fin = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A Strava activity summary as the app keeps it on a workout. */
export function fromActivity(a) {
  const start = Date.parse(a.start_date);
  if (!Number.isFinite(start)) return null;
  const elapsed = fin(a.elapsed_time) || fin(a.moving_time) || 60;
  return {
    id: String(a.id), name: String(a.name || 'Activity').slice(0, 80), sport: a.sport_type || a.type || 'Workout',
    type: googleTypeOf(a.sport_type || a.type), start, end: start + elapsed * 1000,
    movingS: fin(a.moving_time), elapsedS: elapsed, distanceM: fin(a.distance), elevationM: fin(a.total_elevation_gain),
    avgHr: fin(a.average_heartrate), maxHr: fin(a.max_heartrate), avgSpeed: fin(a.average_speed), maxSpeed: fin(a.max_speed),
    avgWatts: fin(a.average_watts), kj: fin(a.kilojoules), kcal: fin(a.calories), sufferScore: fin(a.suffer_score),
    polyline: a.map?.summary_polyline || null, manual: !!a.manual, trainer: !!a.trainer, commute: !!a.commute,
    device: a.device_name || null, private: !!a.private, updatedAt: a.updated_at || null,
    photoCount: fin(a.total_photo_count) || 0,
  };
}

/* ── per person ────────────────────────────────────────────────────── */

export function stravaMeta(db) {
  const m = db.meta('strava', null) || {};
  return { ...m, settings: { ...STRAVA_DEFAULTS, ...(m.settings || {}) } };
}
export function setStravaMeta(db, patch) {
  const next = { ...stravaMeta(db), ...patch };
  db.setMeta('strava', next);
  return next;
}
export function stravaView(db, { configured = false, connected = false, budget = null } = {}) {
  const m = stravaMeta(db);
  return {
    configured, connected,
    athlete: connected ? m.athlete || null : null,
    connectedAt: m.connectedAt || null,
    lastSync: m.lastSync || null,
    lastError: m.lastError || null,
    count: db.stravaLinkCount(),
    settings: m.settings,
    scope: m.scope || null,
    usage: budget,
  };
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const sameSession = (a0, a1, b0, b1) => overlap(a0, a1, b0, b1) >= 0.5 * Math.max(MIN, Math.min(a1 - a0, b1 - b0));

/**
 * Bring one activity in. Returns 'added' | 'merged' | 'updated' | 'same'.
 */
export function applyActivity({ db, a, now, settings = STRAVA_DEFAULTS }) {
  if (!a) return 'same';
  const strava = { id: a.id, name: a.name, sport: a.sport, distanceM: a.distanceM, movingS: a.movingS, elevationM: a.elevationM, avgHr: a.avgHr, maxHr: a.maxHr, avgSpeed: a.avgSpeed, avgWatts: a.avgWatts, kcal: a.kcal, polyline: a.polyline, device: a.device, updatedAt: a.updatedAt, at: now, photoCount: a.photoCount || 0 };
  const link = db.stravaLink(a.id);
  if (link?.workoutId) {
    const r = db.workoutGet(link.workoutId);
    if (!r) { db.stravaLinkDel(a.id); } else {
      if (r.status === 'deleted') return 'same';
      // A second copy of a session already here with its own Strava activity (a watch's, beside
      // the route recorded here and sent there): linked, so it is not added again, and nothing more.
      if (r.strava?.id && String(r.strava.id) !== String(a.id)) return 'same';
      // The photos' addresses, once read, stay (a list's summary only counts them).
      if (Array.isArray(r.strava?.photos)) { strava.photos = r.strava.photos; strava.photosAt = r.strava.photosAt; }
      // A list's summary has no calories or description: what the details
      // gave is kept, not wiped by the next list.
      if (strava.kcal === null && Number.isFinite(r.strava?.kcal)) strava.kcal = r.strava.kcal;
      if (r.strava?.updatedAt && r.strava.updatedAt === a.updatedAt) return 'same';
      if (r.source === 'strava') {
        const moved = r.start !== a.start || r.end !== a.end;
        r.start = a.start; r.end = a.end; r.title = a.name; r.type = a.type;
        if (moved && r.google?.state === 'saved') r.google = { ...r.google, dirty: true };
        if (Number.isFinite(a.avgHr)) r.avgHr = a.avgHr;
        if (Number.isFinite(a.maxHr)) r.maxHr = a.maxHr;
        if (Number.isFinite(strava.kcal)) r.kcal = strava.kcal;
      }
      r.strava = { ...(r.strava || {}), ...strava };
      r.updated = now;
      db.workoutPut(r);
      return 'updated';
    }
  }
  // The same session already here: the watch's own, a detected one, a Hevy one.
  const held = db.workoutsSince(a.start - 12 * HOUR)
    .filter((r) => ['done', 'running', 'review', 'ongoing'].includes(r.status));
  const same = held.filter((r) => sameSession(a.start, a.end, r.start, r.end ?? r.lastEnd ?? r.start + MIN));
  // One with no Strava activity yet takes this one; one that has its own already (a route
  // recorded here and sent there, and the watch's copy of the same walk) only links it.
  const mine = same.find((r) => !db.stravaLinkOf(r.id) && !r.strava);
  const twin = !mine && same.find((r) => r.source !== 'strava') || null;
  if (twin) { db.stravaLinkSet(a.id, twin.id, { at: now }); return 'merged'; }
  if (mine) {
    mine.strava = strava;
    if (!mine.title) mine.title = a.name;
    mine.updated = now;
    db.workoutPut(mine);
    db.stravaLinkSet(a.id, mine.id, { at: now });
    return 'merged';
  }
  const from = new Date(a.start - 2 * DAY).toISOString().slice(0, 10);
  const theirs = db.exercises(from).find((x) => sameSession(a.start, a.end, x.startMs, x.endMs));
  const google = theirs ? { state: 'foreign', name: theirs.id }
    : settings.toGoogle ? { state: 'pending', notBefore: Math.max(now, a.end) + GOOGLE_WAIT } : { state: 'local' };
  const rec = {
    status: 'done', source: 'strava', start: a.start, end: a.end, created: now, updated: now,
    title: a.name, type: a.type, prompts: {}, google, confirmedAt: now, strava,
    ...(Number.isFinite(a.avgHr) ? { avgHr: a.avgHr } : {}), ...(Number.isFinite(a.maxHr) ? { maxHr: a.maxHr } : {}), ...(Number.isFinite(a.kcal) ? { kcal: a.kcal } : {}),
  };
  rec.id = db.workoutAdd(rec);
  db.stravaLinkSet(a.id, rec.id, { at: now });
  return 'added';
}

/** Deleted on Strava: a workout that came from Strava goes, another one
    only loses the Strava details. */
export async function deleteActivity({ db, id, remove, now }) {
  const link = db.stravaLink(id);
  if (!link?.workoutId) { db.stravaLinkDel(id); return false; }
  const r = db.workoutGet(link.workoutId);
  db.stravaLinkDel(id);
  if (!r || r.status === 'deleted') return false;
  if (r.strava?.id && String(r.strava.id) !== String(id)) return false;   // a second copy, only linked
  if (link.own) { delete r.strava; db.workoutPut(r); return true; }   // ours, sent there: it stays here
  if (r.source === 'strava') { await remove(r.id); return true; }
  delete r.strava;
  r.updated = now;
  db.workoutPut(r);
  return true;
}

/**
 * One pass: new and changed activities since the last one (a week of
 * overlap), the details (calories) of up to a few new ones, and, when
 * switched on, workouts out to Strava.
 */
/**
 * Sessions here twice: one brought from Strava (a watch's, through its app) beside one
 * recorded or logged here for the same time, from before such copies were only linked.
 * The Strava one goes; its activity is linked to the other. Only while it is not in
 * Google from this app (it never is: it waits for Google's own copy). Returns how many.
 */
export function foldTwins(db, { now = Date.now(), days = 14 } = {}) {
  let n = 0;
  const rows = db.workoutsSince(now - days * DAY).filter((r) => r.status === 'done');
  for (const s of rows) {
    if (s.source !== 'strava' || s.google?.state === 'saved') continue;
    const other = rows.find((r) => r.id !== s.id && r.source !== 'strava' && r.status === 'done' && sameSession(s.start, s.end ?? s.start + MIN, r.start, r.end ?? r.start + MIN));
    if (!other) continue;
    if (s.strava?.id) db.stravaLinkSet(s.strava.id, other.id, { at: now });
    s.status = 'deleted'; s.updated = now;
    db.workoutPut(s);
    n += 1;
  }
  return n;
}

export async function syncStrava({ db, api, tz, now = Date.now, remove, force = false, only = null, log = () => {} }) {
  const m = stravaMeta(db);
  const startedAt = now();
  try { foldTwins(db, { now: startedAt }); } catch (e) { log(`strava twins: ${e.message}`); }
  const out = { ok: true, added: 0, merged: 0, updated: 0, deleted: 0, pushed: 0, details: 0, calls: 0 };
  const stamp = {};
  try {
    if (only?.deleted) {
      if (await deleteActivity({ db, id: String(only.id), remove, now: startedAt })) out.deleted += 1;
    } else if (only?.id) {
      const a = fromActivity(await api.activity(only.id));
      tally(out, applyActivity({ db, a, now: startedAt, settings: m.settings }));
    } else {
      const after = Math.floor((m.cursor ? m.cursor - 7 * DAY : (m.connectedAt || startedAt) - BACKFILL_DAYS * DAY) / 1000);
      for (let page = 1; page <= 20; page += 1) {
        const list = await api.activities({ after, page, perPage: 50 });
        if (!Array.isArray(list) || !list.length) break;
        db.tx(() => { for (const raw of list) tally(out, applyActivity({ db, a: fromActivity(raw), now: startedAt, settings: m.settings })); });
        if (list.length < 50) break;
      }
      stamp.cursor = startedAt;
      // The whole history, a few pages a pass, walking back from before the first import.
      if (!m.backDone) {
        let before = m.backBefore || Math.floor(((m.connectedAt || startedAt) - BACKFILL_DAYS * DAY) / 1000);
        let done = false;
        for (let i = 0; i < (force ? 6 : 3); i += 1) {
          if (!api.budget.room(10)) break;
          const list = await api.activities({ before, page: 1, perPage: 50 });
          if (!Array.isArray(list) || !list.length) { done = true; break; }
          db.tx(() => { for (const raw of list) tally(out, applyActivity({ db, a: fromActivity(raw), now: startedAt, settings: m.settings })); });
          const oldest = Math.min(...list.map((x) => Math.floor(Date.parse(x.start_date) / 1000)).filter(Number.isFinite));
          if (!Number.isFinite(oldest) || oldest >= before) { done = true; break; }
          before = oldest;
          if (list.length < 50) { done = true; break; }
        }
        stamp.backBefore = before; stamp.backDone = done;
      }
      // Photos on the activity: their addresses, for the post of it (app.js brings the pictures in).
      const withPhotos = db.workoutsSince(startedAt - 30 * DAY).filter((r) => r.strava?.photoCount > 0 && !r.strava.photosAt).slice(0, force ? 6 : 3);
      for (const r of withPhotos) {
        if (!api.budget.room(5)) break;
        try {
          const list = await api.photos(r.strava.id);
          const urls = (Array.isArray(list) ? list : []).map((x) => { const u = x?.urls || {}; return u['1200'] || u[Object.keys(u).sort((a, b) => Number(b) - Number(a))[0]] || null; })
            .filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 6);
          r.strava = { ...r.strava, photos: urls, photosAt: startedAt };
          db.workoutCache(r.id, { strava: r.strava });
        } catch (e) { if (e.code === 'not_found') { r.strava = { ...r.strava, photos: [], photosAt: startedAt }; db.workoutCache(r.id, { strava: r.strava }); } else throw e; }
      }
      // Calories are only in an activity's details: fetch a few new ones a pass.
      const want = db.workoutsSince(startedAt - 30 * DAY).filter((r) => r.strava && r.strava.kcal === null && !r.strava.detailed).slice(0, force ? 10 : 3);
      for (const r of want) {
        if (!api.budget.room(5)) break;
        try {
          const d = await api.activity(r.strava.id);
          r.strava = { ...r.strava, kcal: Number.isFinite(d?.calories) ? d.calories : null, detailed: true, description: d?.description ? String(d.description).slice(0, 500) : null };
          if (r.source === 'strava' && Number.isFinite(d?.calories)) r.kcal = d.calories;
          db.workoutCache(r.id, { strava: r.strava, ...(r.source === 'strava' && Number.isFinite(d?.calories) ? { kcal: d.calories } : {}) });
          out.details += 1;
        } catch (e) { if (e.code === 'not_found') db.workoutCache(r.id, { strava: { ...r.strava, detailed: true } }); else throw e; }
      }
    }
    if (m.settings.toStrava && !only) out.pushed = await pushActivities({ db, api, tz, since: m.connectedAt || startedAt, now: startedAt, log });
    if (!only) {
      // Routes recorded here go up as GPX, and their uploads are followed to the activity.
      out.uploads = await resolveUploads({ db, api, now: startedAt, log });
      if (m.settings.routesToStrava) out.routesOut = await pushRoutes({ db, api, since: m.connectedAt || startedAt, now: startedAt, log });
      // Full routes of activities that have one, newest first, a few a pass.
      if (m.settings.streams) out.streams = await fetchStreams({ db, api, now: startedAt, limit: force ? 6 : 2, log });
    }
  } catch (e) {
    out.ok = false; out.code = e.code || 'error'; out.message = e.message; out.retryAfter = e.retryAfter || null;
  }
  out.calls = api.calls;
  setStravaMeta(db, {
    ...stamp, lastSync: out.ok ? startedAt : (m.lastSync || null),
    lastError: out.ok ? null : { code: out.code, message: String(out.message || '').slice(0, 300), at: startedAt },
  });
  return out;
}

function tally(out, r) {
  if (r === 'added') out.added += 1;
  else if (r === 'merged') out.merged += 1;
  else if (r === 'updated') out.updated += 1;
}

/** Workouts finished here since connecting, created on Strava. */
export async function pushActivities({ db, api, tz, since, now, log = () => {}, limit = 3 }) {
  let n = 0;
  for (const r of db.workoutsDoneFrom(since - 6 * HOUR)) {
    if (n >= limit) break;
    if (r.source === 'strava' || r.strava || db.stravaLinkOf(r.id) || r.created < since || r.stravaFailed) continue;
    if (r.route || r.stravaUpload || db.trackGet(r.id)) continue;   // a route goes as its GPX (pushRoutes)
    if (!(r.end > r.start)) continue;
    const sets = db.setsOf(r.id);
    const lines = sets.slice(0, 12).map((x) => `${x.name}: ${x.sets.length} ${x.sets.length === 1 ? 'set' : 'sets'}`);
    const body = {
      name: String(r.title || 'Workout').slice(0, 80),
      // No type of its own: a workout with sets is weight training.
      sport_type: r.type ? stravaSportOf(r.type) : sets.length ? 'WeightTraining' : 'Workout',
      start_date_local: localIso(r.start, utcOffsetSec(r.start, tz)),
      elapsed_time: Math.round((r.end - r.start) / 1000),
      description: [r.notes || '', lines.join('\n'), 'Logged on health.ojee.net'].filter(Boolean).join('\n\n').slice(0, 2000),
    };
    try {
      const made = await api.createActivity(body);
      if (made?.id) { db.stravaLinkSet(String(made.id), r.id, { own: true, at: now }); db.workoutCache(r.id, { strava: { id: String(made.id), name: body.name, sport: body.sport_type, own: true, at: now } }); n += 1; }
    } catch (e) {
      if (['strava_auth', 'strava_scope', 'rate_limited', 'network'].includes(e.code)) throw e;
      log(`strava push ${r.id}: ${e.message}`);
      db.workoutCache(r.id, { stravaFailed: { at: now, message: String(e.message).slice(0, 200) } });
    }
  }
  return n;
}

/** Strava's start_date_local: the wall clock, written as if it were UTC. */
function localIso(t, offSec) {
  const off = Number.isFinite(offSec) ? offSec : 0;
  return new Date(t + off * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Google's encoded polyline → [[lat, lng], ...]. */
export function decodePolyline(str) {
  const out = [];
  let i = 0; let lat = 0; let lng = 0;
  const s = String(str || '');
  while (i < s.length) {
    let shift = 0; let result = 0; let b;
    do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < s.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < s.length);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/** A route as a few hundred points in a unit box (x right, y down), kept
    aspect-true, for drawing without any map tiles. */
export function routeShape(polyline, max = 300) {
  const pts = decodePolyline(polyline);
  if (pts.length < 2) return null;
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map(([la, ln]) => [ln * k, -la]);
  const xs = xy.map((p) => p[0]); const ys = xy.map((p) => p[1]);
  const x0 = Math.min(...xs); const y0 = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) || 1;
  const step = Math.max(1, Math.ceil(xy.length / max));
  const keep = xy.filter((_, i) => i % step === 0 || i === xy.length - 1);
  return { w: (Math.max(...xs) - x0) / span, h: (Math.max(...ys) - y0) / span, points: keep.map(([x, y]) => [Math.round(((x - x0) / span) * 1000) / 1000, Math.round(((y - y0) / span) * 1000) / 1000]) };
}

export { localToMs };

/* ── routes, both ways ─────────────────────────────────────────────── */

const ACTIVITY_TYPE = { RUNNING: 'run', WALKING: 'walk', HIKING: 'hike', BIKING: 'ride', MOUNTAIN_BIKE: 'ride', ROLLERBLADING: 'inlineskate', SKIING: 'alpineski', ROWING: 'rowing', SWIMMING_OPEN_WATER: 'swim' };

/**
 * Routes recorded here since connecting, not on Strava yet, uploaded as
 * GPX. The external id is the workout's own, so Strava refuses a second
 * copy of the same route (and says which activity has it).
 */
export async function pushRoutes({ db, api, since, now, log = () => {}, limit = 2 }) {
  let n = 0;
  for (const r of db.workoutsDoneFrom(since - 6 * HOUR)) {
    if (n >= limit) break;
    if (r.source !== 'recorded' || r.created < since || r.strava || r.stravaUpload || r.stravaFailed || db.stravaLinkOf(r.id)) continue;
    // A watch worn on the same walk may send its own copy to Strava: given time to, and then not sent twice.
    if (now - (r.end ?? r.start) < ROUTE_WAIT) continue;
    const t = db.trackGet(r.id);
    if (!t) continue;
    const gpx = toGpx({ title: r.title, type: t.type, points: t.points, pauses: t.pauses });
    try {
      const up = await api.uploadGpx({ gpx, name: r.title, description: [r.notes || '', 'Recorded on health.ojee.net'].filter(Boolean).join('\n\n'), externalId: `ojee-${r.uid}`, activityType: ACTIVITY_TYPE[t.type] || 'run' });
      db.workoutCache(r.id, { stravaUpload: { id: String(up?.id_str || up?.id || ''), at: now, status: up?.status || null } });
      n += 1;
    } catch (e) {
      if (['strava_auth', 'strava_scope', 'rate_limited', 'network'].includes(e.code)) throw e;
      log(`strava upload ${r.id}: ${e.message}`);
      db.workoutCache(r.id, { stravaFailed: { at: now, message: String(e.message).slice(0, 200) } });
    }
  }
  return n;
}

/** Uploads still being processed by Strava: the activity they became, or why not. */
export async function resolveUploads({ db, api, now, log = () => {} }) {
  let n = 0;
  for (const r of db.workoutsDoneFrom(now - 14 * DAY)) {
    const up = r.stravaUpload;
    if (!up?.id || up.done) continue;
    if (db.stravaLinkOf(r.id)) { db.workoutCache(r.id, { stravaUpload: { ...up, done: true } }); continue; }   // the activity came in first
    let st;
    try { st = await api.uploadStatus(up.id); } catch (e) { if (e.code === 'not_found') { db.workoutCache(r.id, { stravaUpload: { ...up, done: true, error: 'gone' } }); continue; } throw e; }
    const dup = /duplicate of .*?(\d{5,})/i.exec(String(st?.error || ''));
    const activityId = st?.activity_id ? String(st.activity_id) : dup ? dup[1] : null;
    if (activityId) {
      db.stravaLinkSet(activityId, r.id, { own: true, at: now });
      db.workoutCache(r.id, { stravaUpload: { ...up, done: true }, strava: { id: activityId, name: r.title, own: true, at: now } });
      n += 1;
    } else if (st?.error) {
      log(`strava upload ${r.id}: ${st.error}`);
      db.workoutCache(r.id, { stravaUpload: { ...up, done: true, error: String(st.error).slice(0, 200) }, stravaFailed: { at: now, message: String(st.error).slice(0, 200) } });
    } else if (now - up.at > 2 * HOUR) db.workoutCache(r.id, { stravaUpload: { ...up, done: true, error: 'never processed' } });
  }
  return n;
}

/** Strava's streams as this site's track points [t, lat, lng, alt, null, hr]. */
export function streamsToTrack(s, startMs) {
  const ll = s?.latlng?.data; const tm = s?.time?.data;
  if (!Array.isArray(ll) || !Array.isArray(tm) || ll.length < 2 || ll.length !== tm.length) return null;
  const alt = s.altitude?.data || []; const hr = s.heartrate?.data || [];
  return ll.map(([lat, lng], i) => [startMs + tm[i] * 1000, lat, lng, Number.isFinite(alt[i]) ? alt[i] : null, null, Number.isFinite(hr[i]) ? hr[i] : null]);
}

/** One activity's whole route, kept as its workout's track. Returns true when it was kept. */
export async function fetchStream({ db, api, r }) {
  if (!r?.strava?.id || db.trackGet(r.id)) return false;
  let s;
  try { s = await api.streams(r.strava.id); } catch (e) {
    if (e.code === 'not_found') { db.workoutCache(r.id, { strava: { ...r.strava, noStream: true } }); return false; }
    throw e;
  }
  const points = cleanPoints(streamsToTrack(s, r.start) || [], { type: routeType(r.type) });
  if (points.length < 2) { db.workoutCache(r.id, { strava: { ...r.strava, noStream: true } }); return false; }
  db.trackPut(r.id, { type: routeType(r.type), points, pauses: [], start: r.start, end: r.end, from: 'strava' });
  const st = trackStats({ type: routeType(r.type), points, start: r.start, end: r.end });
  if (!r.route) db.workoutCache(r.id, { route: { type: routeType(r.type), distanceM: r.strava.distanceM ?? st.distanceM, movingS: r.strava.movingS ?? st.movingS, paceSPerKm: st.paceSPerKm, avgSpeedKmh: st.avgSpeedKmh, from: 'strava' } });
  return true;
}

/** A few Strava activities with a map and no route here yet, newest first. */
export async function fetchStreams({ db, api, now, limit = 2, log = () => {} }) {
  let n = 0;
  const want = db.workoutsSince(now - 30 * DAY).filter((r) => r.status === 'done' && r.strava?.polyline && !r.strava.noStream && !r.strava.own).reverse();
  for (const r of want) {
    if (n >= limit || !api.budget.room(10)) break;
    if (db.trackGet(r.id)) continue;
    try { if (await fetchStream({ db, api, r })) n += 1; } catch (e) {
      if (['strava_auth', 'strava_scope', 'rate_limited', 'network'].includes(e.code)) throw e;
      log(`strava streams ${r.id}: ${e.message}`);
    }
  }
  return n;
}
