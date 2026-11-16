/* ============================================================
   health.ojee.net — a Withings scale (Body, Body+, Body Comp, Body Scan,
   Body Smart, Body Cardio), read through Withings' own public API.

   One Withings developer app for the whole site (WITHINGS_CLIENT_ID and
   WITHINGS_CLIENT_SECRET, made by the owner at developer.withings.com,
   with WITHINGS_REDIRECT_URI, by default <origin>/auth/withings/callback,
   added to the app's callback URLs). Each person signs in on Withings'
   own page and allows reading their measures (scope user.metrics); their
   tokens are sealed in the vault like every other secret. Without the
   app the connection is not offered at all.

     tokens     an access token for 3 hours and a refresh token for a
                year; each refresh gives a new refresh token, kept at once
     weigh-ins  POST /measure action=getmeas, category 1 (real measures),
                everything changed since the last read (lastupdate), page
                by page. Each measure group is one weigh-in: weight, body
                fat, fat-free mass, muscle, water, bone, visceral fat, BMR,
                metabolic age, heart rate, pulse wave velocity, vascular
                age, nerve health, and the water inside and outside cells
     whose      a group Withings itself could not put on one person
                (attrib 1: "may be someone else's") is left out, as the
                Health Mate app leaves it waiting to be claimed
     deletions  getmeas never says what was deleted: once a day the last
                90 days are read whole and what is gone there goes here
     at once    Withings calls POST /api/withings/notify (appli 1, weight
                and body composition) when a weigh-in arrives; a shared
                token in the callback's query says the call is real

   Rows here: a weigh-in (source 'withings'), its body fat (a 'bodyfat'
   sample and the day's body_fat), and one 'bodycomp' row with the rest,
   shown on Body composition like a Xiaomi scale's.
   ============================================================ */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { utcOffsetSec } from './core/util.js';

export const WITHINGS_AUTH = 'https://account.withings.com/oauth2_user/authorize2';
export const WITHINGS_API = 'https://wbsapi.withings.net';
export const WITHINGS_SCOPES = 'user.metrics,user.info';

const MIN = 60_000;
const DAY = 86_400_000;
/** A weigh-in already here from elsewhere within this of Withings' is the same one. */
const SAME = 10 * MIN;
/** How far back the daily check for deletions reads. */
const CHECK_DAYS = 90;
/** The first read: this much history. */
const FIRST_DAYS = 3 * 365;
const MAX_PAGES = 40;

/** Withings' measure types and what each becomes here (value × 10^unit, in the unit named). */
export const MEAS = {
  1: 'weightKg', 5: 'leanKg', 6: 'fatPct', 8: 'fatKg', 11: 'heartRate', 76: 'muscleKg', 77: 'waterKg', 88: 'boneKg',
  91: 'pwv', 155: 'vascularAge', 167: 'nerveHealth', 168: 'ecwKg', 169: 'icwKg', 170: 'visceral', 226: 'bmr', 227: 'metabolicAge',
};
const MEASTYPES = Object.keys(MEAS).join(',');
/** Withings' statuses for a token it no longer takes. */
const AUTH = new Set([100, 101, 102, 200, 401]);
/** attrib 1: a device's measure Withings could not put on one person. */
const AMBIGUOUS = 1;

const fin = Number.isFinite;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const localDate = (t, off) => new Date(t + (off || 0) * 1000).toISOString().slice(0, 10);

export class WithingsError extends Error {
  constructor(message, { status = 0, code = 'upstream', retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Withings' JSON: { status, body, error }. HTTP is 200 even for most failures. */
async function readJson(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { status: res.ok ? -1 : res.status, error: text.slice(0, 120) }; }
}

export class WithingsApi {
  /**
   * @param {object} o
   * @param {object} o.tokens      { access, refresh, expiresAt (ms), userId }
   * @param {Function} o.onTokens  (tokens) => void, as soon as they were refreshed: the old refresh token stops working
   */
  constructor({ clientId, clientSecret, tokens, onTokens = () => {}, fetchImpl = globalThis.fetch, base = WITHINGS_API, timeoutMs = 20_000, now = () => Date.now() }) {
    this.clientId = clientId; this.clientSecret = clientSecret;
    this.tokens = tokens ? { ...tokens } : null;
    this.onTokens = onTokens;
    this.fetch = fetchImpl;
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.calls = 0;
  }

  async #post(path, params, token = null) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])),
        signal: ctl.signal,
      });
      return await readJson(res);
    } catch (e) {
      throw new WithingsError(e.name === 'AbortError' ? 'Withings did not answer in time.' : `Withings could not be reached (${e.message}).`, { code: 'network' });
    } finally { clearTimeout(timer); }
  }

  /** The access token, refreshed when it has under five minutes left (or `force`). */
  async #access(force = false) {
    if (!this.tokens?.refresh) throw new WithingsError('Withings is not connected.', { code: 'withings_auth', status: 401 });
    if (!force && this.tokens.access && Number(this.tokens.expiresAt) - this.now() > 5 * MIN) return this.tokens.access;
    const j = await this.#post('/v2/oauth2', { action: 'requesttoken', grant_type: 'refresh_token', client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.tokens.refresh });
    if (j.status !== 0 || !j.body?.access_token) {
      if (j.status === 601) throw new WithingsError('Withings asked this site to slow down.', { code: 'rate_limited', retryAfter: 60 });
      if (AUTH.has(j.status) || j.status === 503 || j.status === 2555) throw new WithingsError('Withings no longer accepts this connection. Connect it again.', { code: 'withings_auth', status: 401 });
      throw new WithingsError(`Withings answered ${j.status} when the connection was renewed.`, { status: j.status });
    }
    this.tokens = { ...this.tokens, access: j.body.access_token, refresh: j.body.refresh_token || this.tokens.refresh, expiresAt: this.now() + (Number(j.body.expires_in) || 10_800) * 1000 };
    this.onTokens(this.tokens);
    return this.tokens.access;
  }

  async #call(path, params) {
    let token = await this.#access();
    for (let i = 0; ; i += 1) {
      this.calls += 1;
      const j = await this.#post(path, params, token);
      if (j.status === 0) return j.body || {};
      // A token Withings stopped taking before its time: renewed once, then given up.
      if (AUTH.has(j.status) && i === 0) { token = await this.#access(true); continue; }
      if (AUTH.has(j.status)) throw new WithingsError('Withings no longer accepts this connection. Connect it again.', { status: 401, code: 'withings_auth' });
      if (j.status === 601) throw new WithingsError('Withings asked this site to slow down.', { status: 601, code: 'rate_limited', retryAfter: 60 });
      throw new WithingsError(`Withings answered ${j.status}${j.error ? ` (${String(j.error).slice(0, 80)})` : ''}.`, { status: j.status });
    }
  }

  /** Measure groups, page by page: changed since `lastupdate` (seconds), or in [startdate, enddate]. */
  async measures({ lastupdate = null, startdate = null, enddate = null } = {}) {
    const groups = [];
    let offset = null; let updatetime = null; let timezone = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const b = await this.#call('/measure', { action: 'getmeas', meastypes: MEASTYPES, category: 1, lastupdate, startdate, enddate, offset });
      if (Array.isArray(b.measuregrps)) groups.push(...b.measuregrps);
      updatetime = Number(b.updatetime) || updatetime;
      timezone = b.timezone || timezone;
      if (!b.more || !b.offset) return { groups, updatetime, timezone, complete: true };
      offset = b.offset;
    }
    return { groups, updatetime, timezone, complete: false };
  }

  /** Ask Withings to call `callbackurl` when a weigh-in arrives (appli 1). */
  subscribe(callbackurl) { return this.#call('/notify', { action: 'subscribe', callbackurl, appli: 1, comment: 'rep.' }); }
  /** Stop those calls. Best effort. */
  async revoke(callbackurl) { try { await this.#call('/notify', { action: 'revoke', callbackurl, appli: 1 }); } catch { /* already gone */ } }
}

/** Swap an authorisation code for tokens. Returns { tokens, userId, scope }. */
export async function withingsExchange({ clientId, clientSecret, code, redirectUri, fetchImpl = globalThis.fetch, base = WITHINGS_API, now = Date.now() }) {
  let j;
  try {
    const res = await fetchImpl(`${base}/v2/oauth2`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ action: 'requesttoken', grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    j = await readJson(res);
  } catch (e) { throw new WithingsError(`Withings could not be reached (${e.message}).`, { code: 'network' }); }
  const b = j?.body || {};
  if (j?.status !== 0 || !b.access_token || !b.refresh_token) throw new WithingsError(`Withings did not accept the sign-in${j?.error ? `: ${String(j.error).slice(0, 120)}` : ''}.`, { status: j?.status || 0, code: 'withings_auth' });
  return { tokens: { access: b.access_token, refresh: b.refresh_token, expiresAt: now + (Number(b.expires_in) || 10_800) * 1000 }, userId: b.userid ? String(b.userid) : null, scope: String(b.scope || '') };
}

/** The token in a notification callback's address: who made it, only this site can say. */
export const notifyToken = (secret) => createHmac('sha256', String(secret || '')).update('withings-notify').digest('hex').slice(0, 32);
export function notifySigned(secret, token) {
  if (!secret || !token) return false;
  const a = Buffer.from(notifyToken(secret)); const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── a measure group, as a weigh-in ───────────────────────────────── */

/**
 * One of Withings' measure groups as a weigh-in, or null when it is not
 * one (no weight, an objective rather than a measure, or maybe someone else's).
 */
export function readGroup(g) {
  if (!g || Number(g.category) !== 1 || Number(g.attrib) === AMBIGUOUS || !fin(Number(g.date))) return null;
  const v = {};
  for (const m of g.measures || []) {
    const k = MEAS[m.type];
    const x = Number(m.value) * 10 ** Number(m.unit);
    if (k && fin(x)) v[k] = x;
  }
  const kg = v.weightKg;
  if (!fin(kg) || kg < 20 || kg > 400) return null;
  const w = { id: String(g.grpid), t: Number(g.date) * 1000, modified: Number(g.modified) || null, manual: [2, 4].includes(Number(g.attrib)), weightKg: r2(kg) };
  const pct = (x) => (fin(x) && x > 0 && x < kg ? r1((x / kg) * 100) : null);
  const put = (k, x, lo, hi, round = r1) => { if (fin(x) && x >= lo && x <= hi) w[k] = round(x); };
  put('fatPct', fin(v.fatPct) ? v.fatPct : pct(v.fatKg), 1, 80);
  put('fatKg', v.fatKg, 0.5, 300, r2);
  put('leanKg', v.leanKg, 10, 300, r2);
  put('muscleKg', v.muscleKg, 5, 200, r2);
  put('waterPct', pct(v.waterKg), 20, 90);
  put('waterKg', v.waterKg, 5, 200, r2);
  put('boneKg', v.boneKg, 0.5, 10, r2);
  put('visceral', v.visceral, 0.5, 60);
  put('bmr', v.bmr, 500, 5000, Math.round);
  put('metabolicAge', v.metabolicAge, 5, 110, Math.round);
  put('heartRate', v.heartRate, 25, 220, Math.round);
  put('pwv', v.pwv, 2, 25, r2);
  put('vascularAge', v.vascularAge, 5, 120, Math.round);
  put('nerveHealth', v.nerveHealth, 0, 100, Math.round);
  put('ecwKg', v.ecwKg, 1, 100, r2);
  put('icwKg', v.icwKg, 1, 100, r2);
  return w;
}

/** What a composition row keeps of a weigh-in (all but its id and times). */
function compFields(w) {
  const { id, t, modified, manual, ...rest } = w;
  return { ...rest, grp: id };
}

export function withingsMeta(db) { return db.meta('withings', null) || {}; }
export function setWithingsMeta(db, patch) { const next = { ...withingsMeta(db), ...patch }; db.setMeta('withings', next); return next; }

/** The rows one weigh-in made, by its group id. */
const ids = (grp) => ({ bc: `withings-bc-${grp}`, bf: `withings-bf-${grp}` });

/** Take one weigh-in's rows away (it was deleted, or moved in time). Returns the date it was on. */
function dropRows(db, grp) {
  const { bc, bf } = ids(grp);
  const r = db.sampleGet(bc);
  if (!r) return null;
  const w = db.weights(r.t).find((x) => x.t === r.t);
  if (w && w.source === 'withings') db.deleteWeight(r.t);
  db.sampleDrop(bc); db.sampleDrop(bf);
  return r.date;
}

/** The day's body fat worked out again from what is left that day. */
function refat(db, date) {
  const left = db.samples('bodyfat', { limit: 1000 }).filter((x) => x.date === date && !x.deleted);
  db.db.prepare("DELETE FROM daily WHERE date = ? AND metric = 'body_fat'").run(date);
  if (left.length) db.setDaily(date, 'body_fat', left[0].value);
}

/**
 * Bring one weigh-in in, or bring it up to date. Returns 'added' | 'updated' | 'same'.
 */
export function applyWithings({ db, w, tz, now }) {
  const { bc, bf } = ids(w.id);
  const cur = db.sampleGet(bc);
  const data = compFields(w);
  if (cur && cur.t === w.t && JSON.stringify(cur.data) === JSON.stringify(data)) return 'same';
  let changedDate = null;
  if (cur) changedDate = dropRows(db, w.id);
  const off = utcOffsetSec(w.t, tz);
  const date = localDate(w.t, off);
  const grams = Math.round(w.weightKg * 1000);
  // The same weigh-in, already here from elsewhere (Withings shares with Apple Health and
  // Health Connect, and those reach here too), is not written twice.
  const twin = db.weights(w.t - SAME).filter((x) => x.t <= w.t + SAME).find((x) => x.source !== 'withings' && Math.abs(x.grams - grams) <= 150);
  if (!twin) db.upsertWeight({ t: w.t, grams, off, source: 'withings', note: null });
  if (fin(w.fatPct)) {
    const theirs = db.samples('bodyfat', { fromMs: w.t - SAME, toMs: w.t + SAME, limit: 5 }).find((x) => x.source !== 'withings' && !x.deleted);
    if (!theirs) db.sampleAdd({ id: bf, kind: 'bodyfat', t: w.t, off, date, value: w.fatPct, source: 'withings', device: 'Withings', data: {} }, now);
    db.setDaily(date, 'body_fat', w.fatPct);
  }
  // Always one composition row, even for a weight alone: it is how this weigh-in is found again.
  db.sampleAdd({ id: bc, kind: 'bodycomp', t: w.t, off, date, value: fin(w.muscleKg) ? w.muscleKg : null, source: 'withings', device: 'Withings', data }, now);
  if (changedDate && changedDate !== date) refat(db, changedDate);
  return cur ? 'updated' : 'added';
}

/** Every weigh-in Withings brought, by group id, in [fromMs, toMs). */
function heldGroups(db, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER) {
  const out = new Map();
  for (let off = 0; ; off += 1000) {
    const rows = db.samples('bodycomp', { fromMs, toMs, limit: 1000, offset: off });
    for (const r of rows) if (r.source === 'withings' && r.id.startsWith('withings-bc-')) out.set(r.id.slice('withings-bc-'.length), r);
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * One pass: what changed at Withings since the last one; once a day, the
 * last 90 days whole, so what was deleted there goes here too.
 */
export async function syncWithings({ db, api, tz, now = Date.now, full = false, log = () => {} }) {
  const m = withingsMeta(db);
  const startedAt = now();
  const out = { ok: true, added: 0, updated: 0, removed: 0, read: 0, calls: 0 };
  const stamp = {};
  try {
    const first = full || !m.cursor;
    const r = first
      ? await api.measures({ startdate: Math.floor((startedAt - FIRST_DAYS * DAY) / 1000), enddate: Math.floor(startedAt / 1000) + 3600 })
      : await api.measures({ lastupdate: m.cursor - 60 });
    out.read = r.groups.length;
    const list = r.groups.map(readGroup).filter(Boolean);
    let check = null;
    if (!first && (!m.checkedAt || startedAt - m.checkedAt > DAY)) {
      const from = startedAt - CHECK_DAYS * DAY;
      const c = await api.measures({ startdate: Math.floor(from / 1000), enddate: Math.floor(startedAt / 1000) + 3600 });
      if (c.complete) check = { from, ids: new Set(c.groups.map(readGroup).filter(Boolean).map((w) => w.id)) };
    }
    db.tx(() => {
      for (const w of list) {
        const x = applyWithings({ db, w, tz, now: startedAt });
        if (x === 'added') out.added += 1; else if (x === 'updated') out.updated += 1;
      }
      // Gone at Withings (deleted, or given to someone else on the scale): gone here.
      const sweep = first ? { from: startedAt - FIRST_DAYS * DAY, ids: new Set(list.map((w) => w.id)) } : check;
      if (sweep && (first ? r.complete : true)) {
        const days = new Set();
        for (const [grp, row] of heldGroups(db, sweep.from)) {
          if (sweep.ids.has(grp)) continue;
          const d = dropRows(db, grp);
          if (d) days.add(d);
          out.removed += 1;
        }
        for (const d of days) refat(db, d);
      }
    });
    if (r.complete && r.updatetime) stamp.cursor = r.updatetime;
    else if (list.length) stamp.cursor = Math.max(m.cursor || 0, ...list.map((w) => Math.floor((w.modified || w.t / 1000))));
    if (check || first) stamp.checkedAt = startedAt;
    if (out.added || out.updated || out.removed) db.setMeta('hevyMeasureDirty', true);
  } catch (e) {
    out.ok = false; out.code = e.code || 'error'; out.message = e.message;
    if (e.retryAfter) out.retryAfterMs = e.retryAfter * 1000;
    if (e.code !== 'withings_auth') log(`withings pass: ${e.message}`);
  }
  out.calls = api.calls;
  setWithingsMeta(db, {
    ...stamp,
    lastSync: out.ok ? startedAt : (m.lastSync || null),
    lastResult: { at: startedAt, ok: out.ok, added: out.added, updated: out.updated, removed: out.removed },
    lastError: out.ok ? null : { code: out.code, message: String(out.message || '').slice(0, 300), at: startedAt },
  });
  return out;
}

/** What Withings brought, all of it, taken away (the person chose not to keep it). */
export function forgetWithings(db, { keepData = true } = {}) {
  if (!keepData) {
    db.tx(() => {
      const days = new Set();
      for (const grp of heldGroups(db).keys()) { const d = dropRows(db, grp); if (d) days.add(d); }
      for (const w of db.weights(0)) if (w.source === 'withings') db.deleteWeight(w.t);
      for (const d of days) refat(db, d);
    });
  }
  const m = withingsMeta(db);
  db.setMeta('withings', { connectedAt: null, lost: m.lost || null });
}

/** The page's view of it. */
export function withingsView(db, { configured = false, connected = false } = {}) {
  const m = withingsMeta(db);
  let n = 0; let last = null;
  for (let off = 0; ; off += 1000) {
    const rows = db.samples('bodycomp', { limit: 1000, offset: off });
    for (const r of rows) if (r.source === 'withings') { n += 1; if (!last) last = { t: r.t, ...r.data }; }
    if (rows.length < 1000) break;
  }
  return {
    configured, connected,
    connectedAt: m.connectedAt || null,
    lastSync: m.lastSync || null,
    lastResult: m.lastResult || null,
    lastError: m.lastError || null,
    lost: !connected && m.lost ? m.lost : null,
    count: n,
    last,
  };
}
