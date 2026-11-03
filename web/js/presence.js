/* "Here": while the app is in view, tell the server about every 45 s,
   with the route being recorded (activity.js), so others can see who is
   online and who is working out (server/presence.js, People's Now strip).
   The running workout the server reads from the log itself.

   Whether anybody sees it is the person's own setting (Me, Privacy:
   "Show when I'm online"); the beats are sent either way and kept only
   in memory. */

import { api } from './api.js';
import { app, hasProfile } from './app.js';
import { recordingNow, RECORDING_KEY } from './activity.js';

const EVERY_MS = 45_000;
const ROUTE_EVERY_MS = 20_000;   // while recording: friends watching the map see it move
const MIN_GAP_MS = 11_000;   // the server takes six a minute

let last = 0;
let lastSig = '';
let timer = null;

/** The track so far as [[lat, lng], ...]: a point every 15 m or so, at most 800 (the newest kept). */
function lineNow() {
  let pts = [];
  try { pts = JSON.parse(localStorage.getItem(RECORDING_KEY) || 'null')?.points || []; } catch { return null; }
  const out = [];
  let last = null;
  for (const p of pts) {
    const q = [Math.round(p[1] * 1e5) / 1e5, Math.round(p[2] * 1e5) / 1e5];
    if (!last || Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) * Math.cos((q[0] * Math.PI) / 180) > 0.000135) { out.push(q); last = q; }
  }
  const lp = pts[pts.length - 1];
  if (lp) { const q = [Math.round(lp[1] * 1e5) / 1e5, Math.round(lp[2] * 1e5) / 1e5]; if (q[0] !== last?.[0] || q[1] !== last?.[1]) out.push(q); }
  return out.length > 1 ? out.slice(-800) : null;
}

const routeNow = () => {
  const r = recordingNow();
  return r ? { type: r.type, start: r.start, m: Math.round(r.m), ms: Math.round(r.ms), paused: r.state === 'paused', line: lineNow() } : null;
};
/** What would change what others see: a route started, paused or ended; a workout started or ended. */
const sig = () => {
  const r = recordingNow();
  return `${r ? `${r.type}:${r.start}:${r.state}` : ''}|${app.me?.workout?.running?.id || ''}`;
};

function beat(force = false) {
  if (!hasProfile() || document.visibilityState !== 'visible' || !navigator.onLine) return;
  const t = Date.now();
  if (!force && t - last < (recordingNow() ? ROUTE_EVERY_MS : EVERY_MS)) return;
  if (t - last < MIN_GAP_MS) return;
  last = t;
  lastSig = sig();
  api.post('/api/presence', { route: routeNow() }).catch(() => {});
}

export function startPresence() {
  if (timer) return;
  beat(true);
  // Every 5 s: a beat when it is due, or at once when what is going on changed.
  timer = setInterval(() => beat(sig() !== lastSig), 5_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(true); });
  window.addEventListener('health:activity', () => beat(true));
}
