/* ============================================================
   health.ojee.net — live heart rate.

   Google's heart rate is minutes old. The only real-time source is
   a device that broadcasts the Bluetooth Heart Rate Service, read
   either by the person's own browser (Web Bluetooth) or by another
   of their devices (the Ojee Pulse overlay) and posted here.

   Everything in this file is IN MEMORY. Nothing is written to a
   database or a file, nothing reaches `daily_public`, and a
   person's readings are only ever handed back to that person:
   every function takes a user id and touches that one entry.

   The state for one person:
     - the latest reading { bpm, t, source };
     - the readings of the last 120 seconds, for a sparkline.
   It ends 10 seconds after the last reading arrived, or at once
   when a sample says bpm 0 (sensor off the skin, or stopped).

   `emit(userId, data)` is the `live` event on that person's own
   SSE streams: each new latest reading, at most about one a
   second, and one { bpm: null } when it ends.
   ============================================================ */

export const LIVE_TTL_MS = 10_000;        // ends this long after the last reading arrived
export const LIVE_KEEP_MS = 120_000;      // how much history is kept for the sparkline
export const LIVE_MAX_AGE_MS = 60_000;    // a sample older than this is ignored
export const LIVE_MAX_AHEAD_MS = 5_000;   // and so is one further in the future than this
export const LIVE_EMIT_GAP_MS = 1_000;    // at most one `live` event per person in this long
export const LIVE_MAX_SAMPLES = 20;
export const BPM_MIN = 25;
export const BPM_MAX = 250;

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request', expose: true });

/** The `source` of a post: "pulse", "browser", or a short name. */
export function cleanSource(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') throw bad('source must be a short string.');
  const s = v.trim().toLowerCase().replace(/[^a-z0-9 ._-]/g, '').slice(0, 24);
  return s || fallback;
}

/**
 * The body of POST /api/live/hr as a list of { t, bpm }, oldest first.
 * Throws a 400 for a body that is not the contract; samples that are too old
 * or too far ahead are not an error (the caller ignores them).
 */
export function parseSamples(body, now) {
  let list;
  if (Array.isArray(body?.samples)) list = body.samples;
  else if (body && body.samples === undefined && body.bpm !== undefined) list = [{ t: body.t ?? now, bpm: body.bpm }];
  else throw bad('Send { "samples": [ { "t": <ms>, "bpm": <number> } ] } or { "bpm": <number> }.');
  if (list.length < 1 || list.length > LIVE_MAX_SAMPLES) throw bad(`samples must hold 1-${LIVE_MAX_SAMPLES} readings.`);
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') throw bad('Each sample is { "t": <ms>, "bpm": <number> }.');
    const t = s.t === undefined || s.t === null ? now : s.t;
    if (typeof t !== 'number' || !Number.isFinite(t)) throw bad('t must be a time in milliseconds.');
    if (typeof s.bpm !== 'number' || !Number.isInteger(s.bpm)) throw bad('bpm must be a whole number.');
    if (s.bpm !== 0 && (s.bpm < BPM_MIN || s.bpm > BPM_MAX)) throw bad(`bpm must be ${BPM_MIN}-${BPM_MAX}, or 0 when the sensor is off the skin.`);
    out.push({ t: Math.round(t), bpm: s.bpm });
  }
  return out.sort((a, b) => a.t - b.t);
}

export class Live {
  /**
   * @param {object} o
   * @param {Function} o.now
   * @param {Function} o.emit   (userId, { bpm, t, source }) => void
   */
  constructor({ now = () => Date.now(), emit = () => {} } = {}) {
    this.now = now;
    this.emit = emit;
    this.people = new Map();   // userId -> { latest, at, recent, sentAt, sentT }
    this.hand = new Map();     // userId -> { sources: Map(source -> at), claim, relays: Map(source -> at) }
    this.timer = null;
  }

  #entry(userId) {
    const id = String(userId);
    let e = this.people.get(id);
    if (!e) { e = { latest: null, at: 0, recent: [], sentAt: 0, sentT: 0 }; this.people.set(id, e); }
    return e;
  }

  /** Clock work for one person: end a reading that went quiet, send a held
      event, drop history that aged out, forget a person with nothing left. */
  #settle(id, e) {
    const now = this.now();
    if (e.latest && now - e.at >= LIVE_TTL_MS) this.#end(id, e, now);
    if (e.latest && e.sentT !== e.latest.t && now - e.sentAt >= LIVE_EMIT_GAP_MS) this.#send(id, e, now);
    while (e.recent.length && now - e.recent[0][0] > LIVE_KEEP_MS) e.recent.shift();
    if (!e.latest && !e.recent.length) this.people.delete(id);
  }

  #send(id, e, now) {
    e.sentAt = now; e.sentT = e.latest.t;
    this.emit(id, { bpm: e.latest.bpm, t: e.latest.t, source: e.latest.source });
  }

  #end(id, e, now) {
    e.latest = null; e.sentT = 0; e.sentAt = 0;
    this.emit(id, { bpm: null, t: now, source: null });
  }

  /** Runs once a second while anybody is live; stops by itself. */
  #watch() {
    if (this.timer || !this.people.size) return;
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref?.();
  }

  /** Everybody's clock work. The timer calls it; so can a test. */
  sweep() {
    for (const [id, e] of this.people) this.#settle(id, e);
    if (!this.people.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Take a person's samples (already validated by parseSamples).
   * Returns how many were used and how many were ignored for their age.
   */
  push(userId, samples, source) {
    const id = String(userId);
    const now = this.now();
    const e = this.#entry(id);
    this.#settle(id, e);
    const cur = this.people.get(id) === e ? e : this.#entry(id);
    let used = 0; let ignored = 0; let moved = false;
    for (const s of samples) {
      if (now - s.t > LIVE_MAX_AGE_MS || s.t - now > LIVE_MAX_AHEAD_MS) { ignored += 1; continue; }
      used += 1;
      if (s.bpm === 0) {
        // Off the skin, or stopped: over at once, and the trace with it.
        // An older zero than the reading being shown changes nothing.
        if (cur.latest && s.t < cur.latest.t) continue;
        cur.recent = [];
        if (cur.latest) this.#end(id, cur, now);
        moved = false;
        continue;
      }
      // The history keeps one reading per instant, in order.
      let i = cur.recent.length;
      while (i > 0 && cur.recent[i - 1][0] > s.t) i -= 1;
      if (i > 0 && cur.recent[i - 1][0] === s.t) cur.recent[i - 1][1] = s.bpm; else cur.recent.splice(i, 0, [s.t, s.bpm]);
      if (!cur.latest || s.t >= cur.latest.t) { cur.latest = { bpm: s.bpm, t: s.t, source }; moved = true; }
      // Any reading, even a late one, says the sensor is still there.
      if (cur.latest) cur.at = now;
    }
    while (cur.recent.length && now - cur.recent[0][0] > LIVE_KEEP_MS) cur.recent.shift();
    if (moved && cur.latest && cur.sentT !== cur.latest.t && now - cur.sentAt >= LIVE_EMIT_GAP_MS) this.#send(id, cur, now);
    if (!cur.latest && !cur.recent.length) this.people.delete(id);
    this.#watch();
    return { used, ignored };
  }

  /** { bpm, t, source } while this person is live, else null. */
  latest(userId) {
    const id = String(userId);
    const e = this.people.get(id);
    if (!e) return null;
    this.#settle(id, e);
    return e.latest ? { ...e.latest } : null;
  }

  /** The GET /api/live payload. */
  view(userId) {
    const l = this.latest(userId);
    const e = this.people.get(String(userId));
    return { bpm: l?.bpm ?? null, t: l?.t ?? null, source: l?.source ?? null, recent: e ? e.recent.map((p) => [p[0], p[1]]) : [] };
  }

  /* ── relays, and handing the sensor over ──────────────────────────────
     A sensor like the Fitbit Air may take one connection besides the
     phone. A relay at home (relay/hr-relay.py) holds it only while nothing
     else of the person's is delivering: a browser or the iPhone app about
     to connect claims the sensor, and every relay post is answered with
     `yield` while a claim or another source is live, so the relay lets go
     within a second. It asks GET /api/live/relay before taking it again. */

  #handover(id) {
    let h = this.hand.get(id);
    if (!h) { h = { sources: new Map(), claim: null, relays: new Map() }; this.hand.set(id, h); }
    return h;
  }

  /** Someone of the person's (a browser, the app) wants the sensor for a while. */
  claim(userId, source = 'browser', ms = 45_000) {
    const h = this.#handover(String(userId));
    const now = this.now();
    const relayHeld = [...h.relays.values()].some((t) => now - t < 5000);
    h.claim = { source, until: now + ms };
    return { relayHeld };
  }

  /** Whether a relay should step aside now, and why. */
  verdict(userId, source) {
    const h = this.hand.get(String(userId));
    if (!h) return { yield: false, why: null };
    const now = this.now();
    if (h.claim && h.claim.until > now && h.claim.source !== source) return { yield: true, why: 'claimed' };
    for (const [s, t] of h.sources) if (s !== source && now - t < 6000) return { yield: true, why: `live from ${s}` };
    return { yield: false, why: null };
  }

  /** Note who delivered (push calls it), and which sources are relays. */
  noteSource(userId, source, { relay = false } = {}) {
    const h = this.#handover(String(userId));
    h.sources.set(source, this.now());
    if (relay) h.relays.set(source, this.now());
  }

  /** Forget a person (their data was deleted). */
  forget(userId) {
    const id = String(userId);
    const e = this.people.get(id);
    if (!e) return;
    if (e.latest) this.#end(id, e, this.now());
    this.people.delete(id);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.people.clear();
  }
}
