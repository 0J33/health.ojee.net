/* What is going on right now, for the floating pill (views/liveui.js) and Train:
   a running workout (app.me.workout.running) and a route being recorded
   (views/record.js keeps it in localStorage as it goes).

   Each floats over every screen by default: pinned, in the live pill, in place of
   a card. Me can send either to Train instead, where it shows as a card. Today
   no longer shows either: the pill does it everywhere. */

const WHERE = { workout: 'health.wcard', route: 'health.rcard' };
const REC = 'health-recording';
const STALE_MS = 12 * 3600_000;   // a recording left this long is not "now": the record page offers it back instead

/** 'float' (the pill, the default) or 'train' (a card on Train). An old 'today' reads as float. */
export function whereOf(kind) {
  try { return localStorage.getItem(WHERE[kind]) === 'train' ? 'train' : 'float'; } catch { return 'float'; }
}
export function setWhere(kind, v) {
  try { localStorage.setItem(WHERE[kind], v === 'train' ? 'train' : 'float'); } catch { /* private mode */ }
}

const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;
/** Metres between two points [t, lat, lng, …]. */
function metres(a, b) {
  const dLat = rad(b[1] - a[1]); const dLng = rad(b[2] - a[2]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The route being recorded, as it was last kept: { type, state, start, ms (time
 * moving the clock, pauses left out), m (metres) }, or null.
 */
export function recordingNow(now = Date.now()) {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(REC) || 'null'); } catch { s = null; }
  if (!s || !['recording', 'paused'].includes(s.state) || !s.start || now - (s.savedAt || s.start) > STALE_MS) return null;
  const paused = (s.pauses || []).reduce((t, [a, b]) => t + (b - a), 0) + (s.state === 'paused' && s.pausedAt ? now - s.pausedAt : 0);
  let m = 0;
  const p = s.points || [];
  for (let i = 1; i < p.length; i += 1) m += metres(p[i - 1], p[i]);
  return { type: s.type, state: s.state, start: s.start, ms: Math.max(0, now - s.start - paused), m };
}
export const RECORDING_KEY = REC;
