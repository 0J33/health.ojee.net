/* Intervals while recording a route (views/record.js): push, then rest, again and again.
   Three ways to say when each part ends:

     time       push for a duration, rest for a duration
     distance   push for a distance, rest for a distance
     hr         push until the heart reaches one rate, rest until it is back down to another

   Each change is a cue: a vibration on the heart-rate sensor or the phone (buzz.js), and the card
   on the recording's screen. Nothing here touches the document, so the tests can run it. */

export const MODES = [['hr', 'Heart rate'], ['time', 'Time'], ['distance', 'Distance']];

export const IV_DEFAULTS = {
  on: false, mode: 'time',
  pushS: 120, restS: 60,
  pushM: 400, restM: 200,
  // Heart rate: null until set; the screen offers the person's own zones (record.js).
  hrUp: null, hrDown: null,
  // How many pushes; 0 is until you stop.
  reps: 6,
  // Where the vibrations go ('sensor' | 'phone' | 'both') and what each feels like (buzz.js PATTERNS).
  target: 'sensor', pushPat: 'long3', restPat: 'short2',
};

/** A kept setting made whole and sane (an old or edited one cannot break the recording). */
export function ivConfig(c = {}) {
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  const x = { ...IV_DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
  const out = {
    on: x.on === true,
    mode: MODES.some(([m]) => m === x.mode) ? x.mode : 'time',
    pushS: n(x.pushS, 5, 3600, IV_DEFAULTS.pushS), restS: n(x.restS, 5, 3600, IV_DEFAULTS.restS),
    pushM: n(x.pushM, 50, 20000, IV_DEFAULTS.pushM), restM: n(x.restM, 25, 20000, IV_DEFAULTS.restM),
    hrUp: n(x.hrUp, 60, 230, null), hrDown: n(x.hrDown, 50, 220, null),
    reps: n(x.reps, 0, 50, IV_DEFAULTS.reps),
    target: ['sensor', 'phone', 'both'].includes(x.target) ? x.target : 'sensor',
    pushPat: typeof x.pushPat === 'string' ? x.pushPat : IV_DEFAULTS.pushPat,
    restPat: typeof x.restPat === 'string' ? x.restPat : IV_DEFAULTS.restPat,
  };
  // Resting down to a rate at or over the one pushed to would never change.
  if (out.hrUp !== null && out.hrDown !== null && out.hrDown >= out.hrUp) out.hrDown = Math.max(50, out.hrUp - 5);
  return out;
}

/** Push and rest from the zones (server/training.js zoneModel): push into the top zone, rest to the second. */
export function hrDefaults(zones) {
  const b = Array.isArray(zones?.bounds) && zones.bounds.length === 4 ? zones.bounds : null;
  return b ? { hrUp: b[3], hrDown: b[1] } : { hrUp: 165, hrDown: 130 };
}

/**
 * Time and distance: where the intervals are after `x` seconds or metres of them (pauses not
 * counted). { phase: 'push' | 'rest' | 'done', rep (1-based), left (seconds or metres to the
 * next change) }. After the last push there is no rest: it is done.
 */
export function planAt(cfg, x) {
  const P = cfg.mode === 'distance' ? cfg.pushM : cfg.pushS;
  const R = cfg.mode === 'distance' ? cfg.restM : cfg.restS;
  const v = Math.max(0, x || 0);
  const n = Math.floor(v / (P + R));
  const within = v - n * (P + R);
  if (cfg.reps && n >= cfg.reps) return { phase: 'done', rep: cfg.reps, left: 0 };
  if (within < P) return { phase: 'push', rep: n + 1, left: P - within };
  if (cfg.reps && n === cfg.reps - 1) return { phase: 'done', rep: cfg.reps, left: 0 };
  return { phase: 'rest', rep: n + 1, left: P + R - within };
}

/** Heart rate: how long it must hold past the rate (a single beat over is not there yet), and the
    shortest a push or rest lasts (a heart rate on the line does not flick between them). */
export const HOLD_MS = 5_000;
export const MIN_PHASE_MS = 20_000;

/** The heart-rate intervals' start: pushing, the first. */
export const hrStart = (now) => ({ phase: 'push', rep: 1, since: now, holdAt: null });

/**
 * One heart-rate reading (or null when there is none) against the intervals: `iv` moves on in
 * place. Returns the phase it changed to, or null. Push ends once the heart has held at or over
 * hrUp; rest ends once it has held at or under hrDown, and the next push starts (or, after the
 * last, it is done).
 */
export function hrStep(iv, cfg, bpm, now) {
  if (!iv || iv.phase === 'done' || cfg.hrUp === null || cfg.hrDown === null) return null;
  const past = Number.isFinite(bpm) && bpm > 0 && (iv.phase === 'push' ? bpm >= cfg.hrUp : bpm <= cfg.hrDown);
  if (!past) { iv.holdAt = null; return null; }
  iv.holdAt ??= now;
  if (now - iv.holdAt < HOLD_MS || now - iv.since < MIN_PHASE_MS) return null;
  iv.holdAt = null; iv.since = now;
  if (iv.phase === 'push') { iv.phase = 'rest'; return 'rest'; }
  if (cfg.reps && iv.rep >= cfg.reps) { iv.phase = 'done'; return 'done'; }
  iv.phase = 'push'; iv.rep += 1;
  return 'push';
}

/** A skip by hand: on to the next part. */
export function skip(iv, cfg, now) {
  if (!iv || iv.phase === 'done') return null;
  iv.holdAt = null; iv.since = now;
  if (iv.phase === 'push') { iv.phase = 'rest'; return 'rest'; }
  if (cfg.reps && iv.rep >= cfg.reps) { iv.phase = 'done'; return 'done'; }
  iv.phase = 'push'; iv.rep += 1;
  return 'push';
}

/** The intervals in a few words, for the screen: "6 × 2:00 push, 1:00 rest". */
export function ivSummary(cfg, { dist = (m) => `${m} m` } = {}) {
  const t = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const reps = cfg.reps ? `${cfg.reps} × ` : '';
  if (cfg.mode === 'time') return `${reps}${t(cfg.pushS)} push, ${t(cfg.restS)} rest`;
  if (cfg.mode === 'distance') return `${reps}${dist(cfg.pushM)} push, ${dist(cfg.restM)} rest`;
  return `${reps}push to ${cfg.hrUp ?? '–'} bpm, rest to ${cfg.hrDown ?? '–'} bpm`;
}
