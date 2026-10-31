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

   A scale has several people on it: the Xiaomi account's owner and the
   family members they added, each with their own id (the record's
   accountId) and name. Each weigh-in says whose it was; the person picks
   which one is them and only those come here. Until they pick, nothing
   is written. Picking someone else takes away what the last pick brought,
   here and in Google.
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
/** How people on the scale are told apart. 1 was Xiaomi's userType, which
    puts every family member together; 2 is each person's own id. */
const SCHEME = 2;
/** What a composition row keeps. 2 added protein mass, BMI and the body
    type: a store from before reads its whole history once more and the
    rows already here gain them. */
const FIELDS = 2;

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
    .map(([id, p]) => ({ id, name: p.name || null, owner: !!p.owner, n: p.n || 0, lastAt: p.lastAt || null, lastKg: fin(p.lastKg) ? p.lastKg : null }))
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
    if (w.t >= (p.lastAt || 0)) { p.lastAt = w.t; p.lastKg = w.weightKg; if (w.name) p.name = w.name; if (w.person) p.person = w.person; }
    if (w.owner) p.owner = true;
    out[w.profile] = p;
  }
  return out;
}

/** What a composition row keeps of a weigh-in. */
function compFields(w) {
  const data = {
    weightKg: w.weightKg, fatPct: w.fatPct, waterPct: w.waterPct, muscleKg: w.muscleKg, boneKg: w.boneKg, proteinPct: w.proteinPct, proteinKg: w.proteinKg,
    visceral: w.visceral, bmr: w.bmr, metabolicAge: w.metabolicAge, bmi: w.bmi, bodyType: w.bodyType,
    heartRate: w.heartRate, impedance: w.impedance, impedanceLow: w.impedanceLow,
    who: w.profile,
  };
  for (const k of Object.keys(data)) if (data[k] === null || data[k] === undefined) delete data[k];
  return data;
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
  const data = { ...compFields(w), google: twin ? 'foreign' : settings.toGoogle ? 'pending' : 'local' };
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
  const dropped = [];
  try {
    const migrating = (m.scheme || 1) < SCHEME;
    if (migrating) {
      // People were told apart by userType, which lumps family members
      // together: read the whole history again and keep the owner if the
      // owner was the pick (their userType was 1); anyone else picks again.
      Object.assign(m, { profile: m.profile === '1' ? 'owner' : null, profiles: {}, cursor: null });
      Object.assign(stamp, { scheme: SCHEME, profile: m.profile, profiles: {}, cursor: null });
    }
    const refill = (m.fields || 1) < FIELDS;
    const since = !full && !refill && m.cursor ? m.cursor - OVERLAP : 0;
    const list = await client.history({ since, maxPages: since ? 5 : 50 });
    out.read = list.length;
    const profiles = countProfiles(since ? m.profiles : {}, list);
    stamp.profiles = profiles;
    if (client.region && client.region !== m.region) stamp.region = client.region;
    let profile = m.profile;
    if (profile === 'owner') profile = stamp.profile = Object.entries(profiles).find(([, p]) => p.owner)?.[0] || null;
    if (migrating) {
      // Rows already here learn whose they were; anyone else's go.
      // (Their numbers are read again too: the first version took protein in kg for a percentage.)
      const byT = new Map(list.map((w) => [w.t, w]));
      for (const r of db.samples('bodycomp', { limit: 1000 })) {
        const w = byT.get(r.t);
        if (!r.data?.who && w) { const { proteinPct, ...rest } = r.data; db.samplePatch(r.id, { data: { ...rest, ...compFields(w) } }); }
      }
      dropped.push(...dropOthers(db, profile));
    }
    // One person on the scale: that is them.
    if (!profile && Object.keys(profiles).length === 1) profile = stamp.profile = Object.keys(profiles)[0];
    if (!profile) out.needsProfile = Object.keys(profiles).length > 1;
    else {
      const mine = list.filter((w) => w.profile === profile);
      db.tx(() => {
        for (const w of mine) {
          if (applyWeighIn({ db, w, tz, now: startedAt, settings: m.settings }) === 'added') { out.added += 1; continue; }
          // A row from before a field was kept gains it (and keeps everything it had).
          const r = db.sampleGet(`scale-bc-${w.t}`);
          const fresh = compFields(w);
          if (r && Object.keys(fresh).some((k) => r.data?.[k] === undefined)) db.samplePatch(r.id, { data: { ...fresh, ...r.data } });
        }
      });
      stamp.fields = FIELDS;
      stamp.cursor = Math.max(m.cursor || 0, ...list.map((w) => w.t));
      if (out.added) db.setMeta('hevyMeasureDirty', true);
    }
    if (profile && m.settings.toGoogle && toGoogle) out.sent = await sendToGoogle({ db, toGoogle, log });
  } catch (e) {
    out.ok = false; out.code = e.code || 'error'; out.message = e.message;
  }
  out.calls = client.calls;
  out.dropped = dropped;
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
    const twin = db.weights(r.t - SAME).find((x) => x.t <= r.t + SAME && x.source === 'google');
    let state = 'foreign';
    if (!twin) {
      try {
        const went = await toGoogle({ grams, pct: fin(r.data.fatPct) ? r.data.fatPct : null, at: r.t, off: r.off });
        if (!went) break;   // not allowed now: tried again later
        state = 'saved'; n += 1;
        // Their names, so a weigh-in that turns out to be someone else's can be taken back.
        if (typeof went === 'object') { r.data = { ...r.data, ...(went.weight ? { gWeight: went.weight } : {}), ...(went.fat ? { gFat: went.fat } : {}) }; }
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

/**
 * Take away every weigh-in from the scale that is not `keep`'s (all of
 * them when keep is null): the composition row, its body fat, its weight,
 * and the day's body fat worked out again. Returns what Google holds of
 * them, [{ type, name }], for the caller to delete there.
 */
export function dropOthers(db, keep) {
  const google = [];
  google.times = [];   // weigh-ins Google held: a sync's own copies of them go too
  const days = new Set();
  db.tx(() => {
    for (let off = 0; ;) {
      const rows = db.samples('bodycomp', { limit: 1000, offset: off });
      if (!rows.length) break;
      let n = 0;
      for (const r of rows) {
        if (keep !== null && r.data?.who === keep) continue;
        const bf = db.sampleGet(`scale-bf-${r.t}`);
        if (r.data?.gWeight) google.push({ type: 'weight', name: r.data.gWeight });
        if (r.data?.gFat) google.push({ type: 'body-fat', name: r.data.gFat });
        else if (bf?.gname) google.push({ type: 'body-fat', name: bf.gname });
        db.sampleDrop(r.id);
        db.sampleDrop(`scale-bf-${r.t}`);
        const w = db.weights(r.t).find((x) => x.t === r.t);
        // The scale's own, or Google's copy of one this site sent there.
        if (w && (w.source === 'scale' || (w.source === 'google' && r.data?.google === 'saved'))) db.deleteWeight(r.t);
        // Google's copy of a body fat this site sent there, read back by a sync.
        if (r.data?.google === 'saved') for (const x of db.samples('bodyfat', { fromMs: r.t, toMs: r.t + 1, limit: 5 })) if (x.source === 'google') db.sampleDrop(x.id);
        if (r.data?.google === 'saved') google.times.push(r.t);
        days.add(r.date);
        n += 1;
      }
      off += rows.length - n;
    }
    for (const date of days) {
      const left = db.samples('bodyfat', { limit: 1000 }).filter((x) => x.date === date && !x.deleted);
      db.db.prepare("DELETE FROM daily WHERE date = ? AND metric = 'body_fat'").run(date);
      if (left.length) db.setDaily(date, 'body_fat', left[0].value);
    }
  });
  return google;
}

/** Let go of the scale. With keepData false, what it brought goes too
    (returned as dropOthers does, for Google). */
export function forgetXiaomi(db, { keepData = true } = {}) {
  const google = keepData ? [] : dropOthers(db, null);
  const m = xiaomiMeta(db);
  db.setMeta('xiaomi', { settings: m.settings, scheme: SCHEME });
  return google;
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
