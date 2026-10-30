/* ============================================================
   health.ojee.net — a Xiaomi scale's weigh-ins, kept here.

   The cloud side is server/xiaomi.js. This is what a weigh-in becomes:

     weight         a weigh-in (source 'scale'), like one from Google or
                    logged here: on the weight page, in BMI, published
                    like any other weight.
     body fat       a body-fat reading (source 'scale') and the day's
                    body fat.
     composition    one 'bodycomp' row per weigh-in with the rest the
                    scale works out: muscle, water, bone, protein,
                    visceral fat, BMR, metabolic age, heart rate,
                    impedance. Shown on Body composition, never published.
     to Google      on by default: a weigh-in Google has nothing for
                    within ten minutes is saved there, weight and body fat
                    (Xiaomi itself only sends them to Apple Health).

   A scale has up to a handful of people on it (Xiaomi's "userType").
   Each weigh-in says whose it was; the person picks which one is them
   and only those come here. Until they pick, nothing is written.
   ============================================================ */

import { utcOffsetSec } from './core/util.js';

const MIN = 60_000;
const DAY = 86_400_000;
export const XIAOMI_DEFAULTS = { toGoogle: true };
/** A weigh-in already in Google within this of a scale's is the same one. */
const SAME = 10 * MIN;
/** How far back each pass reads again: records do not change, but a phone
    that was offline sends late. */
const OVERLAP = 2 * DAY;

const localDate = (t, off) => new Date(t + (off || 0) * 1000).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;
const fin = Number.isFinite;

export function xiaomiMeta(db) {
  const m = db.meta('xiaomi', null) || {};
  return { ...m, settings: { ...XIAOMI_DEFAULTS, ...(m.settings || {}) } };
}
export function setXiaomiMeta(db, patch) {
  const next = { ...xiaomiMeta(db), ...patch };
  db.setMeta('xiaomi', next);
  return next;
}

/** The scale's people as the page lists them, newest weigh-in first. */
export function profilesOf(m) {
  return Object.entries(m.profiles || {})
    .map(([id, p]) => ({ id, n: p.n || 0, lastAt: p.lastAt || null, lastKg: fin(p.lastKg) ? p.lastKg : null }))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

export function xiaomiView(db, { connected = false, pending = null } = {}) {
  const m = xiaomiMeta(db);
  return {
    connected,
    account: connected ? m.account || null : null,
    region: connected ? m.region || null : null,
    profile: connected ? m.profile || null : null,
    profiles: connected ? profilesOf(m) : [],
    connectedAt: m.connectedAt || null,
    lastSync: m.lastSync || null,
    lastError: m.lastError || null,
    lost: !connected && !!m.lost,
    count: db.sampleStats().bodycomp?.n || 0,
    last: lastOf(db),
    settings: m.settings,
    pending,
  };
}

function lastOf(db) {
  const r = db.samples('bodycomp', { limit: 1 })[0];
  return r ? { t: r.t, ...r.data } : null;
}

/** What the person's scale holds, counted by whose it was. */
function countProfiles(prev, list) {
  const out = { ...(prev || {}) };
  for (const w of list) {
    const p = out[w.profile] ? { ...out[w.profile] } : { n: 0, lastAt: 0, lastKg: null, seen: [] };
    const seen = new Set(p.seen || []);
    if (!seen.has(w.t)) { seen.add(w.t); p.n += 1; }
    p.seen = [...seen].sort((a, b) => b - a).slice(0, 200);   // enough to count a pass's overlap once
    if (w.t >= (p.lastAt || 0)) { p.lastAt = w.t; p.lastKg = w.weightKg; }
    out[w.profile] = p;
  }
  return out;
}

/**
 * Bring one weigh-in in. Returns 'added' | 'same'.
 */
export function applyWeighIn({ db, w, tz, now, settings = XIAOMI_DEFAULTS }) {
  const id = `scale-bc-${w.t}`;
  if (db.sampleGet(id)) return 'same';
  const off = utcOffsetSec(w.t, tz);
  const date = localDate(w.t, off);
  const grams = Math.round(w.weightKg * 1000);
  // The same weigh-in, already here from Google (an Apple Health to Google
  // bridge, say), is not written twice.
  const near = db.weights(w.t - SAME).filter((x) => x.t <= w.t + SAME);
  const twin = near.find((x) => x.source !== 'scale' && Math.abs(x.grams - grams) <= 150);
  if (!twin) db.upsertWeight({ t: w.t, grams, off, source: 'scale', note: null });
  if (fin(w.fatPct)) {
    const bf = `scale-bf-${w.t}`;
    const theirs = db.samples('bodyfat', { fromMs: w.t - SAME, toMs: w.t + SAME, limit: 5 }).find((x) => x.source !== 'scale' && !x.deleted);
    if (!theirs && !db.sampleGet(bf)) db.sampleAdd({ id: bf, kind: 'bodyfat', t: w.t, off, date, value: w.fatPct, source: 'scale', data: {} }, now);
    db.setDaily(date, 'body_fat', w.fatPct);
  }
  const data = {
    weightKg: w.weightKg, fatPct: w.fatPct, waterPct: w.waterPct, muscleKg: w.muscleKg, boneKg: w.boneKg, proteinPct: w.proteinPct,
    visceral: w.visceral, bmr: w.bmr, metabolicAge: w.metabolicAge, heartRate: w.heartRate, impedance: w.impedance, impedanceLow: w.impedanceLow,
    google: twin ? 'foreign' : settings.toGoogle ? 'pending' : 'local',
  };
  for (const k of Object.keys(data)) if (data[k] === null || data[k] === undefined) delete data[k];
  db.sampleAdd({ id, kind: 'bodycomp', t: w.t, off, date, value: fin(w.muscleKg) ? w.muscleKg : null, source: 'scale', data }, now);
  return 'added';
}

/**
 * One pass: the scale's weigh-ins since the last one, the person's own
 * ones kept, and those Google has not got saved there.
 * @param {object} o
 * @param {object} o.db
 * @param {XiaomiClient} o.client
 * @param {Function} [o.toGoogle]  async ({ grams, pct, at, off }) => true when it was saved; null when Google is not there
 */
export async function syncXiaomi({ db, client, tz, now = Date.now, toGoogle = null, full = false, log = () => {} }) {
  const m = xiaomiMeta(db);
  const startedAt = now();
  const out = { ok: true, added: 0, read: 0, sent: 0, calls: 0, needsProfile: false };
  const stamp = {};
  try {
    const since = !full && m.cursor ? m.cursor - OVERLAP : 0;
    const list = await client.history({ since, maxPages: since ? 5 : 50 });
    out.read = list.length;
    const profiles = countProfiles(since ? m.profiles : {}, list);
    stamp.profiles = profiles;
    if (client.region && client.region !== m.region) stamp.region = client.region;
    let profile = m.profile;
    // One person on the scale: that is them.
    if (!profile && Object.keys(profiles).length === 1) profile = stamp.profile = Object.keys(profiles)[0];
    if (!profile) out.needsProfile = Object.keys(profiles).length > 1;
    else {
      const mine = list.filter((w) => w.profile === profile);
      db.tx(() => { for (const w of mine) if (applyWeighIn({ db, w, tz, now: startedAt, settings: m.settings }) === 'added') out.added += 1; });
      stamp.cursor = Math.max(m.cursor || 0, ...list.map((w) => w.t));
      if (out.added) db.setMeta('hevyMeasureDirty', true);
    }
    if (profile && m.settings.toGoogle && toGoogle) out.sent = await sendToGoogle({ db, toGoogle, log });
  } catch (e) {
    out.ok = false; out.code = e.code || 'error'; out.message = e.message;
  }
  out.calls = client.calls;
  setXiaomiMeta(db, {
    ...stamp, region: stamp.region || client.region || m.region || null,
    lastSync: out.ok ? startedAt : (m.lastSync || null),
    lastError: out.ok ? null : { code: out.code, message: String(out.message || '').slice(0, 300), at: startedAt },
  });
  return out;
}

/** Weigh-ins from the scale still owed to Google, a few a pass. */
export async function sendToGoogle({ db, toGoogle, log = () => {}, limit = 10 }) {
  let n = 0;
  const owed = db.samples('bodycomp', { fromMs: Date.now() - 90 * DAY, limit: 500 }).filter((r) => r.source === 'scale' && r.data?.google === 'pending').reverse();
  for (const r of owed) {
    if (n >= limit) break;
    const grams = Math.round(r.data.weightKg * 1000);
    // Google may have it by now (a sync since): then it is not sent.
    const twin = db.weights(r.t - SAME).find((x) => x.t <= r.t + SAME && x.source === 'google' && x.t !== r.t);
    let state = 'foreign';
    if (!twin) {
      try {
        const went = await toGoogle({ grams, pct: fin(r.data.fatPct) ? r.data.fatPct : null, at: r.t, off: r.off });
        if (!went) break;   // not allowed now: tried again later
        state = 'saved'; n += 1;
      } catch (e) {
        log(`scale to google ${r.id}: ${e.message}`);
        if (e.status === 401 || e.status === 403 || e.code === 'network' || e.status === 429) break;
        state = 'failed';
      }
    }
    db.samplePatch(r.id, { data: { ...r.data, google: state } });
  }
  return n;
}

/** Let go of the scale. With keepData false, what it brought goes too. */
export function forgetXiaomi(db, { keepData = true } = {}) {
  if (!keepData) {
    db.tx(() => {
      for (let rows = db.samples('bodycomp', { limit: 1000 }); rows.length; rows = db.samples('bodycomp', { limit: 1000 })) {
        for (const r of rows) { db.sampleDrop(r.id); db.sampleDrop(`scale-bf-${r.t}`); }
      }
      for (const w of db.weights(0)) if (w.source === 'scale') db.deleteWeight(w.t);
    });
  }
  const m = xiaomiMeta(db);
  db.setMeta('xiaomi', { settings: m.settings });
}

/** A composition row in words, for the entries list. */
export function compText(d) {
  const parts = [];
  if (fin(d.weightKg)) parts.push(`${r1(d.weightKg)} kg`);
  if (fin(d.fatPct)) parts.push(`fat ${r1(d.fatPct)}%`);
  if (fin(d.muscleKg)) parts.push(`muscle ${r1(d.muscleKg)} kg`);
  if (fin(d.waterPct)) parts.push(`water ${r1(d.waterPct)}%`);
  return parts.join(', ') || 'Weigh-in';
}
