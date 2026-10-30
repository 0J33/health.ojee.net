/* ============================================================
   health.ojee.net — a Xiaomi smart scale, through Xiaomi's cloud.

   The Xiaomi Body Composition Scale S400 (model yunmai.scales.ms104)
   sends each weigh-in to Xiaomi Home on the phone, which keeps it in
   Xiaomi's cloud. Xiaomi offers no API for it; this reads the same
   history the Xiaomi Home app reads, the way the open-source projects
   that read it do (credited below). It can break when Xiaomi changes
   its side, and it says so when it does.

     signing in   a QR code made by Xiaomi's account service, scanned in
                  the Xiaomi Home app (or the login page opened on the
                  phone itself). No Xiaomi password ever reaches this
                  site. What comes back is the account id and a
                  long-lived pass token, sealed like every other secret.
     a session    the pass token buys a service token and a per-session
                  key ("ssecurity") for Xiaomi's device cloud (sid
                  xiaomiio); both are renewed from the pass token when
                  Xiaomi stops taking them.
     history      POST /app/eco/common/scale/getUserDataByPage on the
                  account's region's api.io.mi.com, signed and RC4-
                  encrypted with a key made from ssecurity and a nonce,
                  paging backward 20 records at a time. Each record is a
                  weigh-in: weight, body fat, water, muscle, bone,
                  protein, visceral fat, BMR, metabolic age, heart rate,
                  impedance, and which of the scale's people it was.

   The QR flow and the request signing are adapted from
   xiaomi-s400 (github.com/jonathanmullerr/xiaomi-s400, MIT), whose QR
   flow comes from Xiaomi-cloud-tokens-extractor
   (github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor, MIT).
   ============================================================ */

import { createHash, randomBytes } from 'node:crypto';

export const SCALE_MODEL = 'yunmai.scales.ms104';
export const REGIONS = ['de', 'sg', 'us', 'i2', 'ru', 'in', 'tw', 'cn'];
const HISTORY = '/eco/common/scale/getUserDataByPage';
const PREFIX = '&&&START&&&';
const UA = 'APP/com.xiaomi.mihome APPV/10.5.201';
const REJECTED = new Set([-3, -6, 401, 403]);

export class XiaomiError extends Error {
  constructor(message, code = 'xiaomi') { super(message); this.code = code; }
}

/* ── RC4 (with the first 1,024 bytes of keystream thrown away) ───────── */

export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  let a = 0; let b = 0;
  const next = () => { a = (a + 1) & 255; b = (b + S[a]) & 255; [S[a], S[b]] = [S[b], S[a]]; return S[(S[a] + S[b]) & 255]; };
  for (let k = 0; k < 1024; k += 1) next();
  const out = Buffer.alloc(data.length);
  for (let k = 0; k < data.length; k += 1) out[k] = data[k] ^ next();
  return out;
}

const parse = (text) => {
  try { const j = JSON.parse(String(text).replace(PREFIX, '')); if (j && typeof j === 'object') return j; } catch { /* below */ }
  throw new XiaomiError('Xiaomi answered something this site cannot read.', 'protocol');
};
const xiaomiHost = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)(xiaomi\.com|mi\.com)$/.test(x.hostname); } catch { return false; } };

/* ── signing in with a QR code ──────────────────────────────────────── */

/**
 * Ask Xiaomi for a QR code. Returns { loginUrl, qrUrl, pollUrl, expiresAt }:
 * show the QR (or open loginUrl on the phone), then wait on pollUrl.
 */
export async function qrStart({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const q = new URLSearchParams({
    _qrsize: '480', qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue', callback: 'https://sts.api.io.mi.com/sts',
    _hasLogo: 'false', sid: 'xiaomiio', serviceParam: '', _locale: 'en_GB', _dc: String(now()),
  });
  const res = await fetchImpl(`https://account.xiaomi.com/longPolling/loginUrl?${q}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new XiaomiError(`Xiaomi's sign-in answered ${res.status}.`, 'upstream');
  const j = parse(await res.text());
  if (![j.loginUrl, j.qr, j.lp].every(xiaomiHost)) throw new XiaomiError('Xiaomi gave no sign-in code.', 'protocol');
  const timeout = Number(j.timeout);
  return { loginUrl: j.loginUrl, qrUrl: j.qr, pollUrl: j.lp, expiresAt: now() + (timeout > 0 && timeout <= 3600 ? timeout : 300) * 1000 };
}

/**
 * Wait for the code to be scanned. Resolves { userId, passToken }, or
 * throws 'expired'. Each wait is at most 30 seconds; call again until
 * expiresAt.
 */
export async function qrPoll({ pollUrl, fetchImpl = globalThis.fetch, waitMs = 30_000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), waitMs);
  t.unref?.();
  let res;
  try { res = await fetchImpl(pollUrl, { headers: { 'user-agent': UA }, signal: ctl.signal }); } catch (e) {
    if (e.name === 'AbortError') return null;   // nobody scanned yet: ask again
    throw new XiaomiError('Xiaomi could not be reached.', 'network');
  } finally { clearTimeout(t); }
  if (res.status === 401 || res.status === 403) throw new XiaomiError('Xiaomi refused the sign-in.', 'auth');
  if (!res.ok) return null;
  const j = parse(await res.text());
  if (j.code === 70016 || j.code === 70017) throw new XiaomiError('The code expired. Make a new one.', 'expired');
  const userId = j.userId; const passToken = j.passToken || j.pass_token;
  if (!/^\d+$/.test(String(userId ?? '')) || typeof passToken !== 'string' || !/^[\x21-\x7e]+$/.test(passToken) || passToken.includes(';')) return null;
  return { userId: String(userId), passToken };
}

/* ── a session for the device cloud ─────────────────────────────────── */

const cookieHeader = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
function takeCookies(res, jar) {
  const list = res.headers.getSetCookie?.() || [];
  for (const c of list) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
}

/**
 * Trade the pass token for a service token and ssecurity.
 * @returns {{ userId, ssecurity: Buffer, cookies: object }}
 */
export async function serviceLogin({ userId, passToken }, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl('https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio', {
    headers: { 'user-agent': UA, cookie: cookieHeader({ userId, passToken }) }, redirect: 'manual',
  });
  if (res.status === 401 || res.status === 403) throw new XiaomiError('Xiaomi no longer accepts this connection. Connect the scale again.', 'auth');
  const j = parse(await res.text());
  let ssecurity;
  try { ssecurity = Buffer.from(String(j.ssecurity), 'base64'); } catch { ssecurity = null; }
  if (!j.location || !xiaomiHost(j.location) || !ssecurity || ssecurity.length < 5) {
    throw new XiaomiError('Xiaomi no longer accepts this connection. Connect the scale again.', 'auth');
  }
  // The location hands out the service token as a cookie, perhaps after a redirect or two.
  const jar = {};
  let url = j.location;
  for (let hop = 0; hop < 5 && url; hop += 1) {
    const r = await fetchImpl(url, { headers: { 'user-agent': UA, cookie: cookieHeader(jar) }, redirect: 'manual' });
    takeCookies(r, jar);
    const loc = r.headers.get('location');
    url = r.status >= 300 && r.status < 400 && loc ? new URL(loc, url).href : null;
  }
  if (!jar.serviceToken) throw new XiaomiError('Xiaomi gave no service token. Connect the scale again.', 'auth');
  const uid = String(j.userId || userId);
  return { userId: uid, ssecurity, cookies: { userId: uid, serviceToken: jar.serviceToken, yetAnotherServiceToken: jar.serviceToken } };
}

/** One signed, encrypted call to the device cloud. */
export async function cloudCall(session, path, data, { region, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const nonce = Buffer.concat([randomBytes(8), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(Math.floor(now() / 60_000)); return b; })()]);
  const signed = createHash('sha256').update(Buffer.concat([session.ssecurity, nonce])).digest();
  const sign = (form) => createHash('sha1').update(['POST', path, ...Object.entries(form).map(([k, v]) => `${k}=${v}`), signed.toString('base64')].join('&')).digest('base64');
  let form = { data: JSON.stringify(data) };
  form.rc4_hash__ = sign(form);
  form = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, rc4(signed, Buffer.from(v)).toString('base64')]));
  form.signature = sign(form);
  form._nonce = nonce.toString('base64');
  const host = `https://${region && region !== 'cn' ? `${region}.` : ''}api.io.mi.com/app`;
  let res;
  try {
    res = await fetchImpl(host + path, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', 'MIOT-REQUEST-MODEL': SCALE_MODEL, cookie: cookieHeader(session.cookies) },
      body: new URLSearchParams(form).toString(),
    });
  } catch { throw new XiaomiError('Xiaomi\'s cloud could not be reached.', 'network'); }
  if (res.status === 401 || res.status === 403) throw new XiaomiError('Xiaomi refused the session.', 'session');
  if (!res.ok) throw new XiaomiError(`Xiaomi's cloud answered ${res.status}.`, 'upstream');
  const text = (await res.text()).trim();
  let out;
  if (text.startsWith('{') || text.startsWith(PREFIX)) out = parse(text);   // errors come back in the clear
  else {
    try { out = JSON.parse(rc4(signed, Buffer.from(text, 'base64')).toString('utf8')); } catch { throw new XiaomiError('Xiaomi\'s cloud answered something this site cannot read.', 'protocol'); }
  }
  if (typeof out?.code !== 'number') throw new XiaomiError('Xiaomi\'s cloud answered something this site cannot read.', 'protocol');
  if (REJECTED.has(out.code)) throw new XiaomiError('Xiaomi refused the session.', 'session');
  if (out.code !== 0) throw new XiaomiError(`Xiaomi's cloud said: ${String(out.message || out.code).slice(0, 120)}`, 'upstream');
  return out;
}

/* ── the scale's history ────────────────────────────────────────────── */

const fin = (v) => { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const nz = (v) => { const n = fin(v); return n === null || n === 0 ? null : n; };

/** One weigh-in as this site keeps it, or null when it is not one. */
export function fromRecord(row) {
  if (!row || typeof row !== 'object') return null;
  let t = fin(row.createTime);
  if (!t || t <= 0) return null;
  if (t < 10_000_000_000) t *= 1000;
  let b;
  try { b = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data || {}; } catch { return null; }
  const weight = fin(b.weight);
  if (!weight || weight <= 0 || weight > 400) return null;
  return {
    // Whose it was: the record's accountId, one per person on the scale (the
    // account's owner has the account's own id). userType only says owner (1)
    // or family member (2), and every family member shares 2.
    t: Math.round(t), profile: String(row.accountId ?? b.user?.accountId ?? `type${b.userType ?? 1}`), weightKg: weight,
    name: typeof b.user?.name === 'string' && b.user.name.trim() ? b.user.name.trim().slice(0, 40) : null,
    owner: String(row.accountId ?? b.user?.accountId ?? '') !== '' && String(row.accountId ?? b.user?.accountId) === String(row.uid ?? b.miid ?? ''),
    // pp is protein as a percentage; pm is protein in kilograms.
    fatPct: nz(b.bfp), waterPct: nz(b.bwp), muscleKg: nz(b.slm), boneKg: nz(b.bmc), proteinPct: nz(b.pp),
    visceral: nz(b.vfl), bmr: nz(b.bmr), metabolicAge: nz(b.ma), bmi: fin(b.bmi),
    heartRate: nz(b.heartRate), impedance: nz(b.bodyRes), impedanceLow: nz(b.bodyRes2),
    bodyType: b.bt !== undefined && b.bt !== null && String(b.bt) !== '' && String(b.bt) !== '0' ? String(b.bt) : null,
  };
}

/**
 * Weigh-ins newer than `since` (ms), oldest first, every profile. Pages
 * backward from now, at most `maxPages` pages of 20.
 */
export async function history(session, { region, since = 0, maxPages = 50, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cursor = now();
  const seen = new Set();
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const r = await cloudCall(session, HISTORY, { uid: session.userId, endTime: 1, beginTime: cursor, model: SCALE_MODEL, did: 0, accountId: 0 }, { region, fetchImpl, now });
    const rows = Array.isArray(r.result) ? r.result : [];
    let oldest = Infinity;
    for (const row of rows) {
      const key = `${row?.createTime}|${typeof row?.data === 'string' ? row.data : JSON.stringify(row?.data)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = fromRecord(row);
      if (!m) continue;
      oldest = Math.min(oldest, m.t);
      if (m.t > since) out.push(m);
    }
    if (rows.length < 20 || oldest <= since || !Number.isFinite(oldest) || oldest >= cursor) break;
    cursor = oldest - 1;
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Which region's cloud holds this account's scale: the first with records. */
export async function findRegion(session, { fetchImpl = globalThis.fetch, now = Date.now, regions = REGIONS } = {}) {
  const tried = [];
  for (const region of regions) {
    try {
      const r = await cloudCall(session, HISTORY, { uid: session.userId, endTime: 1, beginTime: now(), model: SCALE_MODEL, did: 0, accountId: 0 }, { region, fetchImpl, now });
      const n = Array.isArray(r.result) ? r.result.length : 0;
      tried.push({ region, n });
      if (n) return { region, tried };
    } catch (e) { tried.push({ region, error: e.code }); if (e.code === 'session') throw e; }
  }
  return { region: null, tried };
}

/** The QR image itself, as a data URL the page can show (its CSP allows
    data: images, not Xiaomi's host). */
export async function qrImage(qrUrl, { fetchImpl = globalThis.fetch } = {}) {
  if (!xiaomiHost(qrUrl)) throw new XiaomiError('Xiaomi gave no sign-in code.', 'protocol');
  let res;
  try { res = await fetchImpl(qrUrl, { headers: { 'user-agent': UA } }); } catch { throw new XiaomiError('Xiaomi could not be reached.', 'network'); }
  if (!res.ok) throw new XiaomiError(`Xiaomi's sign-in answered ${res.status}.`, 'upstream');
  const type = String(res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || !buf.length || buf.length > 512 * 1024) throw new XiaomiError('Xiaomi gave a sign-in code this site cannot show.', 'protocol');
  return `data:${type};base64,${buf.toString('base64')}`;
}

/**
 * One person's way into Xiaomi's cloud: their sealed { userId, passToken },
 * the region their scale lives in, and the session, kept between passes
 * and renewed from the pass token when Xiaomi stops taking it.
 */
export class XiaomiClient {
  constructor({ creds, region = null, session = null, onSession = () => {}, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.creds = creds; this.region = region; this.session = session;
    this.onSession = onSession; this.fetch = fetchImpl; this.now = now;
    this.calls = 0;
  }

  async #session(fresh = false) {
    if (this.session && !fresh) return this.session;
    this.calls += 1;
    this.session = await serviceLogin(this.creds, { fetchImpl: this.fetch });
    this.onSession(this.session);
    return this.session;
  }

  async #with(fn) {
    try { return await fn(await this.#session()); } catch (e) {
      if (e.code !== 'session') throw e;
      return fn(await this.#session(true));   // once, with a new session
    }
  }

  async findRegion() {
    const r = await this.#with((s) => findRegion(s, { fetchImpl: this.fetch, now: this.now }));
    if (r.region) this.region = r.region;
    return r;
  }

  async history({ since = 0, maxPages = 50 } = {}) {
    if (!this.region) {
      const r = await this.findRegion();
      if (!r.region) return [];
    }
    return this.#with((s) => history(s, { region: this.region, since, maxPages, fetchImpl: this.fetch, now: this.now }));
  }
}
