/* "Here": while the app is in view, tell the server about every 45 s,
   with the route being recorded (activity.js), so others can see who is
   online and who is working out (server/presence.js, People's Now strip).
   The running workout the server reads from the log itself.

   Whether anybody sees it is the person's own setting (Me, Privacy:
   "Show when I'm online"); the beats are sent either way and kept only
   in memory. */

import { api } from './api.js';
import { app, hasProfile } from './app.js';
import { recordingNow } from './activity.js';

const EVERY_MS = 45_000;
const MIN_GAP_MS = 11_000;   // the server takes six a minute

let last = 0;
let lastSig = '';
let timer = null;

const routeNow = () => {
  const r = recordingNow();
  return r ? { type: r.type, start: r.start, m: Math.round(r.m), ms: Math.round(r.ms), paused: r.state === 'paused' } : null;
};
/** What would change what others see: a route started, paused or ended; a workout started or ended. */
const sig = () => {
  const r = recordingNow();
  return `${r ? `${r.type}:${r.start}:${r.state}` : ''}|${app.me?.workout?.running?.id || ''}`;
};

function beat(force = false) {
  if (!hasProfile() || document.visibilityState !== 'visible' || !navigator.onLine) return;
  const t = Date.now();
  if (!force && t - last < EVERY_MS) return;
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
