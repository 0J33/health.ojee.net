/* ============================================================
   health.ojee.net — WHOOP.

   One WHOOP developer app for the whole site (WHOOP_CLIENT_ID and
   WHOOP_CLIENT_SECRET, made by the owner at developer-dashboard.whoop.com,
   with WHOOP_REDIRECT_URI, by default <origin>/auth/whoop/callback,
   registered as its redirect URL). Each person connects their own WHOOP
   account with OAuth 2.0; their tokens are sealed in the secret table
   like any other key. Unset = WHOOP is not offered.

   WHOOP is read the way Garmin is (garminsync.js): into the person's
   WHOOP store (data/users/<id>/src/whoop.sqlite), in the shapes Google's
   sync writes, and the fold (core/merge.js) puts it together with the
   rest. What lands where (the v2 API, developer.whoop.com/api):

     recovery   the morning after a sleep: WHOOP's recovery score
                (whoop_recovery, beside this app's own Recovery), resting
                heart rate (rhr), HRV as RMSSD (hrv), blood oxygen (spo2),
                skin temperature asleep (temp; temp_base and temp_dev
                once a week of nights gives a baseline of the person's own)
     sleep      each sleep with its stage totals (deep is WHOOP's slow
                wave sleep), naps as naps; breathing rate (resp) and
                WHOOP's sleep performance (whoop_sleep_score) for the night
     cycle      WHOOP's day: day strain (whoop_strain), the day's energy
                (kcal, from kilojoules), average and highest heart rate
                (hr_avg, hr_max) and steps, dated by the day it starts
     workout    each one: its sport as a Google exercise type, times,
                calories, average heart rate, distance, time in the five
                zones (as light, moderate, vigorous, peak, as Garmin's are)
     body       height (height_mm) and weight (a weigh-in, only when it
                changes on WHOOP); max heart rate is kept for the page

   How much is read: every pass the last week of each (one page each,
   most of the time: about five calls), then 30 days further back, until
   90 days before connecting are in. A sleep or workout gone from WHOOP
   within the week read goes here too; a webhook (POST /api/whoop/webhook,
   signed with the client secret) brings one record in or out at once.

   Limits (developer.whoop.com/docs/developing/rate-limiting): 100
   requests a minute and 10,000 a day for the whole app. The remaining
   count WHOOP reports is kept and passes stand aside when it gets low; a
   429 pauses everyone until WHOOP's reset.

   Disconnecting gives the grant back (DELETE /v2/user/access) and
   removes everything WHOOP brought, as Strava's disconnect does.
   ============================================================ */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { addDays, today as todayIn, utcOffsetSec } from './core/util.js';
import { GOOGLE_EXERCISE_TYPES } from './core/workouts.js';

export const WHOOP_AUTH = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const WHOOP_TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const WHOOP_API = 'https://api.prod.whoop.com/developer';
/** offline: a refresh token, without which the connection would end within the hour. */
export const WHOOP_SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The days read on every pass. */
export const RECENT_DAYS = 7;
/** How far one pass walks back into the history, and how far back it goes. */
export const BACK_STEP = 30;
export const BACKFILL_DAYS = 90;
/** WHOOP's page size cap on every collection. */
const PAGE = 25;
const MAX_PAGES = 20;
export const WHOOP_DEFAULTS = { prefer: 'whoop' };
/** The daily metrics this store writes, every one of them a catalogue key. */
export const WHOOP_DAILY = ['whoop_recovery', 'rhr', 'hrv', 'spo2', 'temp', 'temp_base', 'temp_dev', 'resp', 'whoop_sleep_score',
  'whoop_strain', 'kcal', 'hr_avg', 'hr_max', 'steps', 'height_mm'];
/** What a recovery writes: taken out again when it is deleted on WHOOP. */
const RECOVERY_KEYS = ['whoop_recovery', 'rhr', 'hrv', 'spo2', 'temp', 'temp_base', 'temp_dev'];
/** The night's numbers a sleep writes. */
const NIGHT_KEYS = ['resp', 'whoop_sleep_score'];
/** The day's numbers merge.js works out from the nights (deleted with a night). */
const SLEEP_DAILY = ['sleep_min', 'sleep_period', 'sleep_awake', 'sleep_efficiency', 'sleep_deep', 'sleep_rem', 'sleep_light'];

export class WhoopError extends Error {
  constructor(message, { status = 0, code = 'upstream', retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** What WHOOP said about the app's usage, shared by every person: the
    requests left in the window closest to its limit, and when it resets. */
export class WhoopBudget {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.remaining = null; this.limit = null; this.resetAt = 0; this.at = 0; this.pauseUntil = 0; }
  read(headers) {
    const rem = Number(headers?.get?.('x-ratelimit-remaining'));
    const reset = Number(headers?.get?.('x-ratelimit-reset'));
    const lim = Number(String(headers?.get?.('x-ratelimit-limit') || '').split(',')[0]);
    if (!Number.isFinite(rem)) return;
    this.remaining = rem;
    this.limit = Number.isFinite(lim) ? lim : this.limit;
    this.resetAt = this.now() + (Number.isFinite(reset) ? reset : 60) * 1000;
    this.at = this.now();
  }
  /** Room for `n` more calls now? Keeps a margin for webhooks and sign-ins. */
  room(n = 1) {
    const t = this.now();
    if (t < this.pauseUntil) return false;
    if (this.remaining === null || t >= this.resetAt) return true;
    return this.remaining - n >= Math.max(5, Math.round((this.limit || 100) * 0.1));
  }
  pause(sec) { this.pauseUntil = this.now() + Math.max(5, Number(sec) || 60) * 1000; }
  view() { return this.remaining === null ? null : { remaining: this.remaining, limit: this.limit, resetAt: this.resetAt, at: this.at, paused: this.now() < this.pauseUntil }; }
}

export class WhoopApi {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {string} o.clientSecret
   * @param {object} o.tokens        { access, refresh, expiresAt (ms) }
   * @param {Function} o.onTokens     (tokens) => void, the moment they were refreshed (WHOOP's
   *                                  old refresh token stops working then: keep the new one at once)
   * @param {WhoopBudget} [o.budget]
   * @param {Function} [o.fetchImpl]
   * @param {object} [o.urls]         { api, token }
   */
  constructor({ clientId, clientSecret, tokens, onTokens = () => {}, budget = new WhoopBudget(), fetchImpl = globalThis.fetch, urls = {}, timeoutMs = 20_000, now = () => Date.now() }) {
    this.clientId = clientId; this.clientSecret = clientSecret;
    this.tokens = tokens ? { ...tokens } : null;
    this.onTokens = onTokens;
    this.budget = budget;
    this.fetch = fetchImpl;
    this.urls = { api: WHOOP_API, token: WHOOP_TOKEN, ...urls };
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.calls = 0;
  }

  async #http(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    timer.unref?.();
    try { return await this.fetch(url, { ...init, signal: ctl.signal }); } catch (e) {
      throw new WhoopError(e.name === 'AbortError' ? 'WHOOP did not answer in time.' : `WHOOP could not be reached (${e.message}).`, { code: 'network' });
    } finally { clearTimeout(timer); }
  }

  /** The access token, refreshed when it has under five minutes left. */
  async #access() {
    if (!this.tokens?.refresh) throw new WhoopError('WHOOP is not connected.', { code: 'whoop_auth', status: 401 });
    if (this.tokens.access && Number(this.tokens.expiresAt) - this.now() > 5 * MIN) return this.tokens.access;
    const res = await this.#http(this.urls.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh, client_id: this.clientId, client_secret: this.clientSecret, scope: 'offline' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      if (res.status === 400 || res.status === 401 || res.ok) throw new WhoopError('WHOOP no longer accepts this connection. Connect it again.', { code: 'whoop_auth', status: 401 });
      throw new WhoopError(`WHOOP answered ${res.status} when the connection was renewed.`, { status: res.status });
    }
    this.tokens = { ...this.tokens, access: j.access_token, refresh: j.refresh_token || this.tokens.refresh, expiresAt: this.now() + (Number(j.expires_in) || 3600) * 1000 };
    this.onTokens(this.tokens);
    return this.tokens.access;
  }

  async #call(method, path, { query = null } = {}) {
    if (!this.budget.room()) throw new WhoopError('WHOOP\'s limit for this site is nearly used up. It is tried again shortly.', { code: 'rate_limited', retryAfter: 60 });
    const token = await this.#access();
    this.calls += 1;
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
    const res = await this.#http(`${this.urls.api}${path}${qs}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    this.budget.read(res.headers);
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (res.ok) return json;
    if (res.status === 401) throw new WhoopError('WHOOP no longer accepts this connection. Connect it again.', { status: 401, code: 'whoop_auth' });
    if (res.status === 403) throw new WhoopError('WHOOP refused: this connection was not given that permission. Connect it again and allow it.', { status: 403, code: 'whoop_scope' });
    if (res.status === 404) throw new WhoopError('WHOOP has no such record.', { status: 404, code: 'not_found' });
    if (res.status === 429) {
      const wait = Number(res.headers?.get?.('x-ratelimit-reset')) || 60;
      this.budget.pause(wait);
      throw new WhoopError('WHOOP asked this site to slow down.', { status: 429, code: 'rate_limited', retryAfter: wait });
    }
    throw new WhoopError(`WHOOP answered ${res.status}.`, { status: res.status, code: 'upstream' });
  }

  profile() { return this.#call('GET', '/v2/user/profile/basic'); }
  body() { return this.#call('GET', '/v2/user/measurement/body'); }
  sleep(id) { return this.#call('GET', `/v2/activity/sleep/${encodeURIComponent(id)}`); }
  workout(id) { return this.#call('GET', `/v2/activity/workout/${encodeURIComponent(id)}`); }
  recoveryOfCycle(cycleId) { return this.#call('GET', `/v2/cycle/${encodeURIComponent(cycleId)}/recovery`); }

  /** Every record of a collection between two instants, page by page.
      { records, complete }: complete is false when it stopped at MAX_PAGES. */
  async list(kind, { start, end }) {
    const path = { cycle: '/v2/cycle', recovery: '/v2/recovery', sleep: '/v2/activity/sleep', workout: '/v2/activity/workout' }[kind];
    const records = [];
    let nextToken = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const j = await this.#call('GET', path, { query: { limit: PAGE, start: new Date(start).toISOString(), end: end ? new Date(end).toISOString() : null, nextToken } });
      if (Array.isArray(j?.records)) records.push(...j.records);
      nextToken = j?.next_token || null;
      if (!nextToken) return { records, complete: true };
    }
    return { records, complete: false };
  }

  /** Give the person's grant back to WHOOP. Best effort. */
  async revoke() {
    if (!this.tokens?.refresh) return;
    try {
      const token = await this.#access();
      await this.#http(`${this.urls.api}/v2/user/access`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    } catch { /* already gone */ }
  }
}

/** Swap an authorisation code for tokens. Returns { tokens, scope }. */
export async function whoopExchange({ clientId, clientSecret, code, redirectUri, fetchImpl = globalThis.fetch, tokenUrl = WHOOP_TOKEN, now = Date.now() }) {
  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
    });
  } catch (e) { throw new WhoopError(`WHOOP could not be reached (${e.message}).`, { code: 'network' }); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new WhoopError(`WHOOP did not accept the sign-in${j.error_description || j.error ? `: ${String(j.error_description || j.error).slice(0, 120)}` : ''}.`, { status: res.status, code: 'whoop_auth' });
  if (!j.refresh_token) throw new WhoopError('WHOOP gave no lasting access (the offline permission). Connect it again and allow it.', { status: res.status, code: 'whoop_scope' });
  return { tokens: { access: j.access_token, refresh: j.refresh_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 }, scope: String(j.scope || '') };
}

/** A webhook is WHOOP's: base64(HMAC-SHA256(timestamp + raw body, client secret)), within 15 minutes. */
export function whoopSigned({ secret, signature, timestamp, body, now = Date.now() }) {
  if (!secret || !signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 15 * MIN) return false;
  const want = createHmac('sha256', secret).update(String(timestamp)).update(body).digest('base64');
  const a = Buffer.from(want); const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── WHOOP's words and this site's ──────────────────────────────────── */

/** WHOOP sport (its v2 sport_name, lowered, runs of anything else as _) → Google exercise type. */
const SPORT = {
  activity: 'WORKOUT', running: 'RUNNING', cycling: 'BIKING', baseball: 'BASEBALL', basketball: 'BASKETBALL', rowing: 'ROWING',
  fencing: 'FENCING', field_hockey: 'FIELD_HOCKEY', football: 'FOOTBALL_AMERICAN', golf: 'GOLF', ice_hockey: 'HOCKEY', lacrosse: 'LACROSSE',
  rugby: 'RUGBY', sailing: 'SAILING', skiing: 'SKIING', soccer: 'SOCCER', softball: 'SOFTBALL', squash: 'SQUASH', swimming: 'SWIMMING',
  tennis: 'TENNIS', track_field: 'TRACK_AND_FIELD', volleyball: 'VOLLEYBALL', water_polo: 'WATER_POLO', wrestling: 'WRESTLING',
  boxing: 'BOXING', dance: 'DANCING', pilates: 'PILATES', yoga: 'YOGA', hot_yoga: 'YOGA', weightlifting: 'WEIGHTLIFTING',
  cross_country_skiing: 'CROSS_COUNTRY_SKI', functional_fitness: 'FUNCTIONAL_STRENGTH_TRAINING', duathlon: 'MULTISPORT', triathlon: 'MULTISPORT',
  gymnastics: 'GYMNASTICS', hiking_rucking: 'HIKING', horseback_riding: 'EQUESTRIAN_SPORTS', kayaking: 'KAYAKING', martial_arts: 'MARTIAL_ARTS',
  mountain_biking: 'MOUNTAIN_BIKE', powerlifting: 'POWERLIFTING', rock_climbing: 'ROCK_CLIMBING', paddleboarding: 'PADDLEBOARDING',
  walking: 'WALKING', dog_walking: 'WALKING', stroller_walking: 'STROLLER_WALK', stroller_jogging: 'RUNNING', surfing: 'SURFING',
  elliptical: 'ELLIPTICAL', stairmaster: 'STAIRCLIMBER', stadium_steps: 'STAIRCLIMBER', meditation: 'MEDITATE', diving: 'DIVING',
  ultimate: 'ULTIMATE_FRISBEE', climber: 'CARDIO_WORKOUT', jumping_rope: 'JUMPING_ROPE', australian_football: 'FOOTBALL_AUSTRALIAN',
  skateboarding: 'SKATEBOARDING', snowboarding: 'SNOWBOARDING', motocross: 'MOTOCROSS', obstacle_course_racing: 'OUTDOOR_WORKOUT',
  hiit: 'HIIT', spin: 'SPINNING', jiu_jitsu: 'JIU_JITSU', cricket: 'CRICKET', pickleball: 'PICKELBALL', inline_skating: 'ROLLERBLADING',
  box_fitness: 'BOXING', wheelchair_pushing: 'WHEELCHAIR', paddle_tennis: 'RACKET_SPORTS', barre: 'BARRE_CLASS', barre3: 'BARRE_CLASS',
  parkour: 'PARKOUR', strength_trainer: 'STRENGTH_TRAINING', assault_bike: 'ASSAULT_BIKE', kickboxing: 'KICKBOXING', stretching: 'STRETCHING',
  table_tennis: 'TABLE_TENNIS', badminton: 'BADMINTON', ice_skating: 'ICE_SKATING', handball: 'HANDBALL', f45_training: 'CIRCUIT_TRAINING',
  barry_s: 'CIRCUIT_TRAINING', padel: 'PADEL', polo: 'POLO', kite_boarding: 'KITESURFING', water_skiing: 'WATER_SKIING',
  wakeboarding: 'WAKEBOARDING', musical_performance: 'MUSICAL_PERFORMANCE', cleaning: 'CLEANING', yard_work: 'GARDENING',
  netball: 'SPORT', spikeball: 'SPORT', disc_golf: 'FRISBEE_PLAYING_GENERAL', paintball: 'SPORT', gaelic_football: 'SPORT',
  hurling_camogie: 'SPORT', circus_arts: 'GYMNASTICS', other: 'WORKOUT', manual_labor: 'WORKOUT',
};
/** WHOOP activities that are not exercise (recovery, work, life): never a workout here. */
const NOT_EXERCISE = new Set(['sauna', 'ice_bath', 'massage_therapy', 'air_compression', 'percussive_massage', 'watching_sports', 'high_stress_work',
  'public_speaking', 'cooking', 'dedicated_parenting', 'toddlerwearing', 'babywearing', 'gaming', 'caddying', 'coaching', 'commuting',
  'stage_performance', 'motor_racing', 'operations_tactical', 'operations_medical', 'operations_flying', 'operations_water']);
const sportKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const whoopTypeOf = (name, known = GOOGLE_EXERCISE_TYPES) => { const t = SPORT[sportKey(name)]; return t && (!known || known.has(t)) ? t : 'WORKOUT'; };
export const isExercise = (name) => !NOT_EXERCISE.has(sportKey(name));
const PACED = new Set(['RUNNING', 'WALKING', 'HIKING', 'STROLLER_WALK']);
const title = (name) => String(name || '').replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim().slice(0, 80) || null;

const fin = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v) => { const n = fin(v); return n !== null && n > 0 ? n : null; };
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const kcalOf = (kj) => { const k = pos(kj); return k === null ? null : Math.round(k / 4.184); };
const minOf = (msv) => { const m = fin(msv); return m === null ? null : Math.round((m / 60_000) * 10) / 10; };

/** '+hh:mm' | '-hh:mm' | 'Z' → seconds east of UTC; null when unreadable. */
export function offsetSec(tzd) {
  if (tzd === 'Z' || tzd === '+00:00' || tzd === '-00:00') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(tzd || ''));
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) : null;
}
const localDate = (t, off) => new Date(t + off * 1000).toISOString().slice(0, 10);

/**
 * One WHOOP sleep as this site keeps a night (the `sleep` table's row),
 * plus the night's numbers. null when it is not scored yet (it is read
 * again when it is) or makes no sense.
 */
export function fromSleep(s, { offOf = () => 0 } = {}) {
  const startMs = Date.parse(s?.start); const endMs = Date.parse(s?.end);
  if (!s?.id || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (s.score_state !== 'SCORED' || !s.score?.stage_summary) return null;
  const off = offsetSec(s.timezone_offset) ?? offOf(endMs);
  const st = s.score.stage_summary;
  const byStage = {};
  for (const [k, v] of [['DEEP', st.total_slow_wave_sleep_time_milli], ['LIGHT', st.total_light_sleep_time_milli], ['REM', st.total_rem_sleep_time_milli], ['AWAKE', st.total_awake_time_milli]]) { const m = minOf(v); if (m !== null) byStage[k] = m; }
  const periodMin = minOf(st.total_in_bed_time_milli) ?? Math.round((endMs - startMs) / 60_000);
  const asleepMin = Math.round(((byStage.DEEP || 0) + (byStage.LIGHT || 0) + (byStage.REM || 0)) * 10) / 10;
  const nap = !!s.nap;
  const perf = fin(s.score.sleep_performance_percentage);
  const date = localDate(endMs, off);
  const row = {
    id: `whoop-${s.id}`, date, startMs, endMs, startOff: off, endOff: off,
    main: !nap,
    asleepMin, awakeMin: byStage.AWAKE ?? Math.max(0, Math.round((periodMin - asleepMin) * 10) / 10), periodMin,
    // WHOOP gives each stage's total, not when each one was.
    stages: [],
    summary: {
      stages: byStage, toFallAsleep: null, afterWake: null,
      shortAwakenings: fin(st.disturbance_count), stagesStatus: byStage.DEEP !== undefined ? 'SUCCEEDED' : null,
      type: 'CLASSIC', processed: true, nap, source: 'whoop', ...(perf !== null ? { deviceScore: Math.round(perf) } : {}),
    },
  };
  const night = {};
  if (!nap) {
    const resp = pos(s.score.respiratory_rate);
    if (resp !== null) night.resp = r1(resp);
    if (perf !== null) night.whoop_sleep_score = Math.round(perf);
  }
  return { row, night, date, cycleId: s.cycle_id ?? null };
}

/** A recovery's numbers: { sleepId, cycleId, metrics } (no date: it is the date of its sleep). */
export function fromRecovery(r) {
  if (!r || r.score_state !== 'SCORED' || !r.score) return null;
  const x = r.score;
  const metrics = {};
  const put = (k, v) => { if (v !== null) metrics[k] = v; };
  put('whoop_recovery', fin(x.recovery_score) === null ? null : Math.round(fin(x.recovery_score)));
  put('rhr', pos(x.resting_heart_rate) === null ? null : Math.round(pos(x.resting_heart_rate)));
  put('hrv', r1(pos(x.hrv_rmssd_milli)));
  const sp = pos(x.spo2_percentage);
  put('spo2', sp !== null && sp <= 100 ? r1(sp) : null);
  const tc = pos(x.skin_temp_celsius);
  put('temp', tc !== null && tc > 20 && tc < 45 ? r2(tc) : null);
  return { sleepId: r.sleep_id ? String(r.sleep_id) : null, cycleId: r.cycle_id ?? null, metrics, at: Date.parse(r.created_at) || null };
}

/** A cycle (WHOOP's day, from waking to waking): { id, date, metrics }, dated by its start. */
export function fromCycle(c, { offOf = () => 0 } = {}) {
  const startMs = Date.parse(c?.start);
  if (!Number.isFinite(startMs)) return null;
  const off = offsetSec(c.timezone_offset) ?? offOf(startMs);
  const metrics = {};
  const steps = pos(c.step_count);
  if (steps !== null) metrics.steps = Math.round(steps);
  if (c.score_state === 'SCORED' && c.score) {
    const strain = fin(c.score.strain);
    if (strain !== null) metrics.whoop_strain = r1(strain);
    const kcal = kcalOf(c.score.kilojoule);
    if (kcal !== null) metrics.kcal = kcal;
    const avg = pos(c.score.average_heart_rate); const max = pos(c.score.max_heart_rate);
    if (avg !== null) metrics.hr_avg = Math.round(avg);
    if (max !== null) metrics.hr_max = Math.round(max);
  }
  return { id: c.id, date: localDate(startMs, off), metrics };
}

/** A WHOOP workout as a row of the `exercise` table (what Google's sessions become too). null for a sauna and the like. */
export function fromWorkout(w, { offOf = () => 0, known = GOOGLE_EXERCISE_TYPES } = {}) {
  const startMs = Date.parse(w?.start); const endMs = Date.parse(w?.end);
  if (!w?.id || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (!isExercise(w.sport_name)) return null;
  const off = offsetSec(w.timezone_offset) ?? offOf(startMs);
  const type = whoopTypeOf(w.sport_name, known);
  const sc = w.score_state === 'SCORED' && w.score ? w.score : {};
  const zd = sc.zone_durations || null;
  const mins = (v) => Math.round(((fin(v) || 0) / 60_000) * 10) / 10;
  const zones = zd && ['zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'].some((k) => fin(zd[k]) > 0)
    ? { light: Math.round((mins(zd.zone_one_milli) + mins(zd.zone_two_milli)) * 10) / 10, moderate: mins(zd.zone_three_milli), vigorous: mins(zd.zone_four_milli), peak: mins(zd.zone_five_milli) } : null;
  const dist = pos(sc.distance_meter);
  return {
    id: `whoop-${w.id}`, date: localDate(startMs, off), startMs, endMs,
    type, name: type === 'WORKOUT' && sportKey(w.sport_name) !== 'activity' ? title(w.sport_name) : null,
    kcal: kcalOf(sc.kilojoule), azm: null, avgHr: pos(sc.average_heart_rate) ? Math.round(sc.average_heart_rate) : null, steps: null,
    distanceM: dist !== null ? Math.round(dist) : null, zones, activeSec: null,
    paceSecPerKm: PACED.has(type) && dist && dist > 100 ? Math.round((endMs - startMs) / 1000 / (dist / 1000)) : null,
    device: 'WHOOP',
  };
}

/* ── the person's WHOOP state (kept in their own store, meta 'whoop') ── */

export function whoopMeta(db) {
  const m = db.meta('whoop', null) || {};
  const s = { ...WHOOP_DEFAULTS, ...(m.settings || {}) };
  if (!['whoop', 'google'].includes(s.prefer)) s.prefer = WHOOP_DEFAULTS.prefer;
  return { ...m, settings: s };
}
export function setWhoopMeta(db, patch) {
  const next = { ...whoopMeta(db), ...patch };
  db.setMeta('whoop', next);
  return next;
}

/** What the Connections page is told. Never a token. */
export function whoopView(main, src, { configured = false, connected = false, now = Date.now(), budget = null } = {}) {
  const m = whoopMeta(main);
  const counts = src ? {
    days: src.db.prepare("SELECT COUNT(DISTINCT date) AS n FROM daily WHERE metric IN ('whoop_recovery', 'whoop_strain')").get()?.n || 0,
    nights: src.sleeps('0000-00-00').filter((s) => s.main).length,
    workouts: src.exercises('0000-00-00').length,
  } : { days: 0, nights: 0, workouts: 0 };
  const target = m.connectedAt ? m.connectedAt - BACKFILL_DAYS * DAY : null;
  return {
    configured, connected,
    user: connected ? m.user || null : null,
    connectedAt: m.connectedAt || null,
    lastSync: m.lastSync || null,
    lastResult: m.lastResult || null,
    lastError: m.lastError || null,
    retryAt: m.retryAt && m.retryAt > now ? m.retryAt : null,
    lost: !connected && m.lost ? m.lost : null,
    body: connected ? m.body || null : null,
    settings: m.settings,
    backfill: { days: BACKFILL_DAYS, backTo: m.backTo || null, done: !!m.backDone || (!!m.backTo && !!target && m.backTo <= target) },
    counts,
    usage: budget,
  };
}

/* ── one pass ─────────────────────────────────────────────────────── */

const STOP = new Set(['rate_limited', 'network', 'whoop_auth', 'whoop_scope', 'upstream']);

/** Rows WHOOP no longer has, taken out of the person's own store too: the fold (merge.js) only
    adds what a source has, so a night or numbers gone from WHOOP are let go of here. */
export function forgetInMain(main, { sleeps = [], exercises = [], daily = [] } = {}) {
  for (const s of sleeps) {
    main.deleteSleep(s.id);
    // The night's sums go unless another night of that date is still there (the fold writes them again).
    if (!main.sleeps(addDays(s.date, -1)).some((x) => x.date === s.date && x.main)) for (const k of SLEEP_DAILY) main.deleteDaily(s.date, k);
  }
  for (const id of exercises) main.deleteExercise(id);
  for (const [date, k] of daily) main.deleteDaily(date, k);
}

/**
 * One pass into the WHOOP store `src`. `main` is the person's own store
 * (where the state is kept). Never throws: { ok, code, message, wrote,
 * days, nights, workouts, removed, calls }.
 * `only`: a webhook's event { type, id }: that record alone, in or out.
 */
export async function syncWhoop({ main, src, api, tz, now = Date.now, force = false, only = null, log = () => {} }) {
  const startedAt = now();
  const m = whoopMeta(main);
  const out = { ok: true, wrote: 0, days: 0, nights: 0, workouts: 0, removed: 0, calls: 0 };
  if (!force && !only && m.retryAt && m.retryAt > startedAt) return { ...out, ok: false, skipped: true, code: 'rate_limited', message: 'Waiting for WHOOP to allow more reads.' };
  const offOf = (t) => utcOffsetSec(t, tz);
  const today = todayIn(startedAt, tz);

  const days = {};   // date -> metric -> value
  const put = (date, metrics) => { if (!date || date > addDays(today, 1)) return; const row = (days[date] ||= {}); for (const [k, v] of Object.entries(metrics || {})) if (WHOOP_DAILY.includes(k) && Number.isFinite(v)) row[k] = v; };
  const sleeps = new Map(); const workouts = new Map(); const recoveries = []; const cycleDate = new Map();
  const gone = { sleeps: [], exercises: [], daily: [] };
  let body = null; let user = null;
  const stamp = {};

  const take = ({ sl = [], wo = [], rc = [], cy = [] }) => {
    for (const x of sl) { const r = fromSleep(x, { offOf }); if (r) { sleeps.set(r.row.id, r); put(r.date, r.night); } }
    for (const x of wo) { const e = fromWorkout(x, { offOf }); if (e) workouts.set(e.id, e); }
    for (const x of cy) { const c = fromCycle(x, { offOf }); if (c) { cycleDate.set(String(c.id), c.date); put(c.date, c.metrics); } }
    for (const x of rc) { const r = fromRecovery(x); if (r) recoveries.push(r); }
  };
  /** One window of all four, every page. Returns whether sleeps and workouts were read whole. */
  const windowOf = async (start, end) => {
    const sl = await api.list('sleep', { start, end });
    const cy = await api.list('cycle', { start, end });
    const rc = await api.list('recovery', { start, end });
    const wo = await api.list('workout', { start, end });
    take({ sl: sl.records, wo: wo.records, rc: rc.records, cy: cy.records });
    return { sleeps: sl.complete ? new Set(sl.records.map((x) => `whoop-${x.id}`)) : null, workouts: wo.complete ? new Set(wo.records.map((x) => `whoop-${x.id}`)) : null };
  };

  try {
    if (only?.type) {
      const [kind, what] = String(only.type).split('.');
      const id = String(only.id || '');
      if (what === 'deleted') {
        if (kind === 'sleep' || kind === 'recovery') {
          const s = src.sleeps('0000-00-00').find((x) => x.id === `whoop-${id}`);
          if (s) {
            const keys = kind === 'sleep' ? [...RECOVERY_KEYS, ...NIGHT_KEYS] : RECOVERY_KEYS;
            for (const k of keys) if (src.dailyValue(s.date, k) !== null) { src.deleteDaily(s.date, k); gone.daily.push([s.date, k]); }
            if (kind === 'sleep') { src.deleteSleep(s.id); gone.sleeps.push(s); }
          }
        } else if (kind === 'workout') {
          if (src.deleteExercise(`whoop-${id}`)) gone.exercises.push(`whoop-${id}`);
        }
      } else if (kind === 'workout') take({ wo: [await api.workout(id)] });
      else if (kind === 'sleep') take({ sl: [await api.sleep(id)] });
      else if (kind === 'recovery') {
        // The id is the recovery's sleep: the sleep gives the cycle, the cycle the recovery.
        const s = await api.sleep(id);
        take({ sl: [s] });
        if (s?.cycle_id !== undefined && s?.cycle_id !== null) take({ rc: [await api.recoveryOfCycle(s.cycle_id)] });
      }
    } else {
      if (!m.user) {
        const p = await api.profile();
        if (p?.user_id) user = { id: String(p.user_id), name: [p.first_name, p.last_name].filter(Boolean).join(' ').slice(0, 80) || null };
      }
      // The recent week, every pass; what WHOOP no longer has in it goes here too.
      const from = startedAt - RECENT_DAYS * DAY;
      const seen = await windowOf(from, startedAt + HOUR);
      if (seen.sleeps) for (const s of src.sleeps(addDays(today, -RECENT_DAYS - 1))) if (s.id.startsWith('whoop-') && s.startMs >= from && !seen.sleeps.has(s.id)) gone.sleeps.push(s);
      if (seen.workouts) for (const e of src.exercises(addDays(today, -RECENT_DAYS - 1))) if (e.id.startsWith('whoop-') && e.startMs >= from && !seen.workouts.has(e.id)) gone.exercises.push(e.id);
      // Height, weight and max heart rate: once a day.
      if (force || !m.bodyAt || startedAt - m.bodyAt > 20 * HOUR) {
        try { body = await api.body(); } catch (e) { if (e.code !== 'whoop_scope' && e.code !== 'not_found') throw e; }
        stamp.bodyAt = startedAt;
      }
      // One step further into the history.
      const target = (m.connectedAt || startedAt) - BACKFILL_DAYS * DAY;
      let backTo = m.backTo || from;
      if (!m.backDone && backTo > target && api.budget.room(10)) {
        const stepFrom = Math.max(target, backTo - BACK_STEP * DAY);
        await windowOf(stepFrom, backTo);
        backTo = stepFrom;
      }
      stamp.backTo = backTo; stamp.backDone = backTo <= target;
    }
  } catch (e) {
    out.ok = false; out.code = e.code || 'error'; out.message = e.message;
    if (e.retryAfter) out.retryAfter = e.retryAfter;
    if (!STOP.has(out.code) && out.code !== 'not_found') log(`whoop pass: ${e.message}`);
    if (out.code === 'not_found') { out.ok = true; delete out.code; delete out.message; }
  }

  // Whatever was read is kept, even from a pass that stopped half-way.
  const touched = new Set();
  let newest = 0;
  src.tx(() => {
    for (const { row } of sleeps.values()) {
      const cur = src.sleeps(addDays(row.date, -1)).find((x) => x.id === row.id);
      if (!cur || JSON.stringify(cur) !== JSON.stringify(row)) { src.upsertSleep(row); out.wrote += 1; }
      if (row.main) out.nights += 1;
      newest = Math.max(newest, row.endMs);
    }
    // A recovery is dated by its sleep (the morning it follows), else by its cycle's day.
    const sleepDate = new Map(src.sleeps('0000-00-00').map((s) => [s.id, s.date]));
    for (const r of recoveries) {
      const date = (r.sleepId && sleepDate.get(`whoop-${r.sleepId}`)) || (r.cycleId !== null && cycleDate.get(String(r.cycleId))) || (r.at ? localDate(r.at, offOf(r.at)) : null);
      put(date, r.metrics);
    }
    for (const g of gone.sleeps) {
      if (src.deleteSleep(g.id)) out.removed += 1;
      for (const k of [...RECOVERY_KEYS, ...NIGHT_KEYS]) if (!days[g.date]?.[k] && src.dailyValue(g.date, k) !== null) { src.deleteDaily(g.date, k); gone.daily.push([g.date, k]); }
    }
    for (const id of gone.exercises) if (src.deleteExercise(id)) out.removed += 1;
    for (const e of workouts.values()) {
      const cur = src.exercises(e.date).find((x) => x.id === e.id);
      src.upsertExercise(e);
      if (!cur || JSON.stringify(cur) !== JSON.stringify(src.exercises(e.date).find((x) => x.id === e.id))) out.wrote += 1;
      out.workouts += 1; newest = Math.max(newest, e.endMs);
    }
    if (body) {
      const h = pos(body.height_meter); const kg = pos(body.weight_kilogram); const max = pos(body.max_heart_rate);
      if (h !== null && h > 0.5 && h < 2.6) { const mm = Math.round(h * 1000); if (src.latest('height_mm')?.value !== mm) { src.setDaily(today, 'height_mm', mm); out.wrote += 1; } }
      // WHOOP's weight is what the person set in its app: a weigh-in only when it changes there.
      if (kg !== null && kg > 20 && kg < 400 && Math.abs((m.body?.weightKg ?? 0) - kg) >= 0.05) {
        src.upsertWeight({ t: startedAt, grams: Math.round(kg * 1000), off: offOf(startedAt), source: 'whoop', note: null });
        out.wrote += 1;
      }
      stamp.body = { heightM: h, weightKg: kg, maxHr: max ? Math.round(max) : null, at: startedAt };
    }
    for (const [date, row] of Object.entries(days)) {
      for (const [k, v] of Object.entries(row)) if (src.dailyValue(date, k) !== v) { src.setDaily(date, k, v); out.wrote += 1; }
      touched.add(date);
    }
    // The skin temperature against the person's own: the mean of up to 30 nights before, once there are 7.
    const temps = [...touched].filter((d) => Number.isFinite(days[d]?.temp)).sort();
    if (temps.length) {
      const table = src.dailyTable(addDays(temps[0], -30));
      for (const d of temps) {
        const prior = Object.entries(table).filter(([x, r]) => x < d && x >= addDays(d, -30) && Number.isFinite(r.temp)).map(([, r]) => r.temp);
        if (prior.length < 7) continue;
        const base = r2(prior.reduce((a, b) => a + b, 0) / prior.length);
        src.setDaily(d, 'temp_base', base);
        src.setDaily(d, 'temp_dev', r2(days[d].temp - base));
      }
    }
    if (out.wrote || newest) {
      const dev = src.meta('device');
      src.setMeta('device', { name: 'WHOOP', type: 'TRACKER', battery: null, batteryStatus: null, lastSync: Math.max(dev?.lastSync || 0, newest || 0) || null });
    }
  });
  if (gone.sleeps.length || gone.exercises.length || gone.daily.length) {
    out.removed = Math.max(out.removed, gone.sleeps.length + gone.exercises.length);
    main.tx(() => forgetInMain(main, gone));
  }
  out.days = touched.size;
  out.calls = api.calls;
  out.touched = [...touched];

  const failures = out.ok ? 0 : (m.failures || 0) + 1;
  const wait = out.ok || only ? null : out.code === 'rate_limited' ? (out.retryAfter ? out.retryAfter * 1000 : 15 * MIN)
    : out.code === 'network' || out.code === 'upstream' ? Math.min(2 * HOUR, 5 * MIN * 2 ** Math.min(5, failures - 1)) : null;
  setWhoopMeta(main, {
    ...stamp, ...(user ? { user } : {}),
    failures: only ? m.failures || 0 : failures,
    retryAt: only ? m.retryAt || null : wait ? startedAt + wait : null,
    lastSync: out.ok ? startedAt : (m.lastSync || null),
    ...(only ? {} : { lastResult: { at: startedAt, ok: out.ok, days: out.days, nights: out.nights, workouts: out.workouts, calls: out.calls } }),
    lastError: out.ok ? null : { code: out.code, message: String(out.message || '').slice(0, 300), at: startedAt },
  });
  return out;
}

export { DAY };
