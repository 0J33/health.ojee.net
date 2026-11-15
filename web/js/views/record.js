/* Workouts, Record a route: a run, walk, hike or ride with the phone's
   GPS, the way a running app does it. Choose what it is, start, and the
   screen shows time, distance, pace (or speed), climb and each
   kilometre's split, with the route on a map that follows you. Pause and
   carry on; finish and it is saved as a workout with its route.

   In the rep. app the phone's own location service records, with the
   screen off and the app in the background (BackgroundGeolocation). A web
   page only gets the position while it is open and on screen, so there
   the screen is kept on (Wake Lock). Either way the route is kept on the
   phone as it grows: a page closed by mistake offers to carry on, or to
   save what was recorded.

   Where the position stopped for a while (a screen turned off in a
   browser), the time and distance across the gap still count, as they do
   on the saved workout (server/tracks.js), so pace and splits stay true. */

import { api } from '../api.js';
import { go, refreshMe } from '../app.js';
import { html, mount, ic, on, head, banner, toast, toastError, busy, confirm, errText, toggle, sheet, info, segx, segxTo, pageTitle } from '../ui.js';
import * as f from '../format.js';
import { routeMap } from '../map.js';
import * as live from '../live.js';
import { liveHistory, bindLive, paintLive as paintHr } from './liveui.js';
import { hcSaveRoute } from '../hc.js';
import * as buzz from '../buzz.js';
import { ivConfig, planAt, hrStart, hrStep, skip as ivSkip, hrDefaults, MODES as IV_MODES, ivSummary } from '../intervals.js';

const KEY = 'health-recording';
const TYPES = [
  ['RUNNING', 'Run', 'run', true], ['WALKING', 'Walk', 'walk', true], ['HIKING', 'Hike', 'hike', true],
  ['BIKING', 'Ride', 'bike', false], ['MOUNTAIN_BIKE', 'Mountain bike', 'bike', false], ['ROLLERBLADING', 'Skate', 'sport', false],
];
const R = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => { const dLat = rad(b[1] - a[1]); const dLng = rad(b[2] - a[2]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
const safe = (fn) => { try { return fn(); } catch { return null; } };
const mmss = (s) => { if (!f.isNum(s) || s <= 0 || s > 5999) return '–:–'; const v = Math.round(s); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };
/* A go at a route inside the recording (server/routetry.js does the same on the saved
   track): the route as points every 25 m; off to its start first, then on it while the
   points come in order, done at its end with 90 % of them passed. The walk there and the
   walk on are part of the recording, not of the go. */
const TOL = 35;
/** Fastest a person could go along the route between two fixes (m/s), by sport: how far ahead to look after a gap. */
const RT_V = { RUNNING: 7, WALKING: 3, HIKING: 3, BIKING: 18, MOUNTAIN_BIKE: 15, ROLLERBLADING: 10 };
/** Moving: faster than this (m/s), as on the saved workout. */
const MOVING = { RUNNING: 0.9, WALKING: 0.5, HIKING: 0.4, BIKING: 1.5, MOUNTAIN_BIKE: 1.2, ROLLERBLADING: 1.2 };
function densify(line) {
  const out = [];
  for (const q of line) {
    const p = [0, q[0], q[1]];
    if (!out.length) { out.push(p); continue; }
    const a = out[out.length - 1]; const len = dist(a, p);
    for (let x = 25; x < len; x += 25) out.push([0, a[1] + ((p[1] - a[1]) * x) / len, a[2] + ((p[2] - a[2]) * x) / len]);
    out.push(p);
  }
  return out;
}
/** One new point against the route: the go's phase moves on ('to' the start, 'on' it, 'done').
    After a gap in the position (the phone gave none for a while) it looks as far ahead as
    could have been gone in that time, and what lies between counts as passed. */
function rtStep(rt, R, pt, vmax = 7) {
  if (rt.phase === 'done') return rt;
  if (rt.phase === 'to') {
    if (dist(pt, R[0]) <= TOL) { rt.phase = 'on'; rt.k = 0; rt.startT = pt[0]; rt.lastT = pt[0]; }
    return rt;
  }
  // Still at the start: the go starts on leaving it.
  if (rt.k === 0 && dist(pt, R[0]) <= TOL) { rt.startT = pt[0]; rt.lastT = pt[0]; return rt; }
  const since = rt.lastT ? Math.max(0, (pt[0] - rt.lastT) / 1000) : 0;
  const ahead = Math.max(16, Math.ceil((since * vmax + 60) / 25));
  for (let k = rt.k + 1; k < Math.min(R.length, rt.k + ahead); k += 1) {
    if (dist(pt, R[k]) <= TOL) { rt.passed = (rt.passed || 0) + (since > 20 ? k - rt.k : 1); rt.k = k; rt.lastT = pt[0]; break; }
  }
  if (rt.k >= R.length - 2 && (rt.passed || 0) >= (R.length - 1) * 0.9 && dist(pt, R[R.length - 1]) <= TOL) { rt.phase = 'done'; rt.endT = pt[0]; }
  return rt;
}
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };
const perKm = () => (f.distUnit() === 'mi' ? 1609.344 : 1000);
/** An interval's distance: "400 m", "1.5 km", "0.25 mi". */
const ivDist = (m) => (f.distUnit() === 'km' && m < 1000 ? `${m} m` : f.dist(m));

/* The recording itself, apart from its screen: one at a time, kept here while the screens
   around it change. Leave the page and the position goes on being taken and kept, the pill
   (activity.js) leads back, and the page draws whatever is running when it opens again. */
const fresh = () => ({ state: 'idle', type: localStorage.getItem('health-rec-type') || 'RUNNING', points: [], pauses: [], start: null, pausedAt: null, autoPause: localStorage.getItem('health-rec-auto') === '1' });
// state: idle | recording | paused | done
let st = fresh();
let watch = null; let lock = null; let fix = null; let gpsErr = null; let autoPaused = false; let still = 0;
/** Faster than this between two points is a bad fix, not movement: 360 km/h. */
const MAX_MS = 100; let jumps = 0;
// The route being followed. It is kept with the recording, so a reload draws it again even without a connection.
let follow = null; let RP = null;
// What the open page wants told: paint, live, me, update. Null while on another screen.
let view = null;
const going = () => st.state === 'recording' || st.state === 'paused';
const readKept = () => safe(() => JSON.parse(localStorage.getItem(KEY) || 'null'));
const keep = () => safe(() => localStorage.setItem(KEY, JSON.stringify({ ...st, savedAt: Date.now() })));
const forget = () => safe(() => localStorage.removeItem(KEY));
const slim = (r) => (r ? { id: r.id, title: r.title, distanceM: r.distanceM, bothWays: r.bothWays, line: r.line } : null);
const validRoute = (id) => /^r_[0-9a-f]{12}$/.test(id || '');
/** Kept and left less than 12 hours ago: it carries on. One left for longer is offered back on the page. */
const isRecent = (s) => s && ['recording', 'paused'].includes(s.state) && s.start && Date.now() - (s.savedAt || s.start) < 12 * 3600_000;
function adopt(s) { st = { ...fresh(), ...s }; follow = s.follow || null; RP = null; if (st.iv) ivRun(); }

/* ── intervals (intervals.js): push, rest, again; each change a cue (buzz.js) ── */
const IV_KEY = 'health-rec-iv';
let ivCfg = ivConfig(safe(() => JSON.parse(localStorage.getItem(IV_KEY) || 'null')) || {});
const ivKeep = () => safe(() => localStorage.setItem(IV_KEY, JSON.stringify(ivCfg)));
/** The person's heart-rate zones (GET /api/workouts training.zones), for heart-rate intervals' defaults. */
let ivZones = null; let ivZonesAsked = false;
let ivTimer = null;
const pausedMs = () => st.pauses.reduce((a, [x, y]) => a + (y - x), 0) + (st.pausedAt ? Date.now() - st.pausedAt : 0);
const isPaused = (t) => st.pauses.some(([a, b]) => t > a && t <= b) || (st.pausedAt && t > st.pausedAt);
/** Metres recorded, pauses left out: what distance intervals count. */
function trackM() {
  const p = st.points; let d = 0;
  for (let i = 1; i < p.length; i += 1) if (!isPaused(p[i][0])) d += dist(p[i - 1], p[i]);
  return d;
}
function ivStart() {
  if (!ivCfg.on) return null;
  const cfg = { ...ivCfg };
  if (cfg.mode === 'hr' && (cfg.hrUp === null || cfg.hrDown === null)) Object.assign(cfg, hrDefaults(ivZones));
  return { cfg, ...hrStart(Date.now()), offset: 0, left: null, last: null };
}
function ivCue(kind) {
  const iv = st.iv; if (!iv) return;
  const pat = kind === 'push' ? iv.cfg.pushPat : iv.cfg.restPat;
  iv.last = { kind, at: Date.now(), felt: null };
  keep(); view?.live();
  buzz.play(pat, iv.cfg.target, { high: kind === 'push' }).then((r) => { if (st.iv === iv) { iv.last.felt = r; view?.live(); } }).catch(() => {});
}
function ivTick() {
  const iv = st.iv;
  if (!iv || st.state !== 'recording' || iv.phase === 'done') return;
  const now = Date.now(); const cfg = iv.cfg;
  let changed = null;
  if (cfg.mode === 'hr') {
    const s = live.get();
    changed = hrStep(iv, cfg, s.bpm > 0 && s.t && now - s.t < 10_000 ? s.bpm : null, now);
  } else {
    const x = (cfg.mode === 'time' ? (now - st.start - pausedMs()) / 1000 : trackM()) + (iv.offset || 0);
    const p = planAt(cfg, x);
    if (p.phase !== iv.phase || p.rep !== iv.rep) { changed = p.phase; iv.phase = p.phase; iv.rep = p.rep; }
    iv.left = p.left;
  }
  if (changed) ivCue(changed);
}
function ivRun() {
  if (ivTimer) return;
  ivTimer = setInterval(() => { if (!going() || !st.iv) { clearInterval(ivTimer); ivTimer = null; return; } ivTick(); }, 1000);
}

// A route there and back is gone out along its line and back to the start.
const routePts = () => (RP ||= densify(follow.bothWays ? [...follow.line, ...follow.line.slice(0, -1).reverse()] : follow.line));

/* ── GPS ── */
function onPos(pos) {
  const c = pos.coords;
  fix = { acc: Math.round(c.accuracy), at: pos.timestamp || Date.now(), lat: c.latitude, lng: c.longitude };
  view?.me(c.latitude, c.longitude, c.accuracy);
  gpsErr = null;
  if (st.state === 'recording' && c.accuracy <= 50) {
    const prevT = st.points.length ? st.points[st.points.length - 1][0] : 0;
    const t = Math.min(Date.now(), Number(pos.timestamp) || Date.now());
    if (t <= prevT) { view?.live(); return; }
    const pt = [t, Math.round(c.latitude * 1e6) / 1e6, Math.round(c.longitude * 1e6) / 1e6, f.isNum(c.altitude) ? Math.round(c.altitude * 10) / 10 : null, Math.round(c.accuracy)];
    const prev = st.points[st.points.length - 1];
    // A jump faster than anyone moves (a stale first fix from far away, a stray one) is not
    // distance. Three in a row mean that is where you are: then, if only a few points came
    // before, those were the wrong ones.
    if (prev && dist(prev, pt) / Math.max(1, (pt[0] - prev[0]) / 1000) > MAX_MS) {
      jumps += 1;
      if (jumps < 3) { view?.live(); return; }
      if (st.points.length <= 5) st.points.length = 0;
    }
    jumps = 0;
    // Standing still: a point every few seconds is enough.
    if (!prev || dist(prev, pt) >= 3 || pt[0] - prev[0] >= 5000) st.points.push(pt);
    if (st.autoPause) autoPauseCheck(c.speed);
    // With the screen off the page's own timer may wait; a new position moves the intervals on too.
    if (st.iv) ivTick();
    const phase = st.rt?.phase;
    if (follow && st.rt && !st.rt.byHandEnd) { rtStep(st.rt, routePts(), pt, RT_V[st.type] || 7); }
    if (st.points.length % 5 === 0 || st.rt?.phase !== phase) keep();
    view?.update(st.points.map((x) => [x[1], x[2]]));
  }
  view?.live();
}
function autoPauseCheck(speed) {
  const v = f.isNum(speed) ? speed : null;
  if (v === null) return;
  if (v < 0.5) { still += 1; if (still >= 6 && st.state === 'recording') { autoPaused = true; pause(); } } else { still = 0; if (autoPaused && st.state === 'paused') { autoPaused = false; resume(); } }
}
function onErr(e) {
  gpsErr = e.code === 1 ? 'Location is not allowed for this site. Allow it in the browser\'s site settings, then try again.' : e.code === 2 ? 'Your position cannot be found. Go outside, away from tall buildings.' : 'Still looking for your position…';
  view?.live();
}
/* The Health app's own location service: it carries on with the screen off. Only
   while recording (and asked for then), so opening this page asks for nothing more. */
const native = () => (window.Capacitor?.isPluginAvailable?.('BackgroundGeolocation') ? window.Capacitor.Plugins.BackgroundGeolocation : null);
let nativeId = null; let nativeWant = false; let nativeBroken = false;
const startNative = () => {
  const BG = native();
  if (!BG) return false;
  if (nativeWant) return true;
  nativeWant = true;
  // Asked one after the other: Android shows one permission question at a time.
  askNotify().then(() => {
    if (!nativeWant) return;
    // Some builds of the app answer this without a promise, or throw: then the page's own
    // location carries the recording (with the screen on) instead of the recording failing.
    let r;
    try {
      r = BG.addWatcher({ backgroundMessage: 'Recording your route.', backgroundTitle: 'rep.', requestPermissions: true, stale: false, distanceFilter: 0 }, (loc, e) => {
        if (e) { onErr({ code: e.code === 'NOT_AUTHORIZED' ? 1 : 3 }); return; }
        if (!loc) return;
        onPos({ timestamp: loc.time, coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, altitude: loc.altitude, speed: loc.speed } });
      });
    } catch { r = null; }
    const broke = () => { nativeWant = false; nativeBroken = true; startGps(); };
    if (!r || typeof r.then !== 'function') { broke(); return; }
    r.then((id) => { if (nativeWant) nativeId = id; else Promise.resolve(BG.removeWatcher?.({ id })).catch(() => {}); }, broke);
  });
  return true;
};
/* Android 13+ hides an app's notifications until it may post them, and that includes the
   "Recording your route" one the location service must show. Asked once, at Start; a no
   leaves the recording working, only without the notification. Push is not turned on by this. */
const askNotify = async () => {
  const P = window.Capacitor?.Plugins?.PushNotifications;
  if (window.Capacitor?.getPlatform?.() !== 'android' || !P?.checkPermissions) return;
  try {
    const s = await P.checkPermissions();
    if (s?.receive === 'prompt' || s?.receive === 'prompt-with-rationale') await P.requestPermissions();
  } catch { /* the recording goes on without it */ }
};
const stopNative = () => { nativeWant = false; if (nativeId !== null) { try { Promise.resolve(native()?.removeWatcher?.({ id: nativeId })).catch(() => {}); } catch { /* gone */ } } nativeId = null; };
const startGps = () => {
  // Recording in the app: the phone's location service, not the page's.
  if (going() && !nativeBroken && startNative()) { if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null; return; }
  if (!('geolocation' in navigator)) { gpsErr = 'This browser cannot give a position.'; return; }
  if (watch === null) watch = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
};
const stopGps = () => { if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null; stopNative(); };
const wake = async () => { if (lock && !lock.released) return; try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; } };
const sleepOk = () => { lock?.release?.().catch(() => {}); lock = null; };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && going()) wake(); });
// A reload or a closed page: the last few points and the go's progress are not left behind.
addEventListener('pagehide', () => { if (going()) keep(); });

function pause() { if (st.state !== 'recording') return; st.state = 'paused'; st.pausedAt = Date.now(); keep(); view?.paint(); }
function resume() { if (st.state !== 'paused') return; st.pauses.push([st.pausedAt, Date.now()]); st.pausedAt = null; st.state = 'recording'; keep(); view?.paint(); }

/** The page was loaded on another screen with a recording under way: take it up again, without its page. */
export async function carryOn() {
  if (going()) return;
  const s = readKept();
  if (!isRecent(s)) return;
  adopt(s); startGps(); wake();
  if (!follow && validRoute(st.rt?.routeId)) {
    try { const r = await api.get(`/api/routes/${st.rt.routeId}`); if (going() && st.rt?.routeId === r.id) { follow = r; st.follow = slim(r); RP = null; } } catch { /* the line waits; the recording does not */ }
  }
}

/** Signing out: no more positions taken. What was recorded stays on the phone and is offered back. */
export function letGo() { if (going()) keep(); stopGps(); sleepOk(); st = fresh(); follow = null; RP = null; }

export default async function record(ctx) {
  const { root } = ctx;
  pageTitle(ctx.root, 'Record a route · rep.');
  let map = null; let tick = null;

  let saved = readKept();
  // Running already: left to another screen and come back. Otherwise a new page, or a reload.
  if (!going()) {
    st = fresh(); fix = null; gpsErr = null; autoPaused = false; still = 0; follow = null; RP = null;
    if (isRecent(saved)) adopt(saved);
  }

  /* ── the numbers ── */
  const inPause = (t) => st.pauses.some(([a, b]) => t > a && t <= b) || (st.pausedAt && t > st.pausedAt);
  function stats() {
    const p = st.points;
    let d = 0; let moving = 0; let gain = 0; let ref = null;
    const splits = []; let next = perKm(); let splitStartS = 0;
    const minV = MOVING[st.type] ?? 0.5;
    for (let i = 1; i < p.length; i += 1) {
      if (inPause(p[i][0])) continue;
      const dd = dist(p[i - 1], p[i]); const dt = (p[i][0] - p[i - 1][0]) / 1000;
      // Moving: going faster than a stop, over a step or across a gap in the position alike.
      const add = dt > 0 && dd / dt >= minV ? dt : 0;
      // A kilometre passed inside this step: its time is the share of the step up to it.
      while (d + dd >= next && dd > 0) { const at = moving + add * ((next - d) / dd); splits.push(at - splitStartS); splitStartS = at; next += perKm(); }
      d += dd; moving += add;
      const a = p[i][3];
      if (f.isNum(a)) { if (ref === null) ref = a; else if (a - ref >= 3) { gain += a - ref; ref = a; } else if (ref - a >= 3) ref = a; }
    }
    // Pace now: the last 30 seconds.
    let cur = null;
    const last = p[p.length - 1];
    if (last && st.state === 'recording') {
      let k = p.length - 1; let dd = 0;
      while (k > 0 && last[0] - p[k - 1][0] <= 30_000) { dd += dist(p[k - 1], p[k]); k -= 1; }
      // Just after a gap: the step across it, when it is not too old.
      if (last[0] - p[k][0] < 8_000 && k > 0 && last[0] - p[k - 1][0] <= 180_000) { dd += dist(p[k - 1], p[k]); k -= 1; }
      const dt = (last[0] - p[k][0]) / 1000;
      if (dt >= 8) cur = dd / dt;
    }
    const paused = st.pauses.reduce((a, [x, y]) => a + (y - x), 0) + (st.pausedAt ? Date.now() - st.pausedAt : 0);
    return { d, moving, gain: Math.round(gain), splits, cur, elapsed: st.start ? Date.now() - st.start - paused : 0 };
  }
  const isPace = () => TYPES.find((t) => t[0] === st.type)?.[3] !== false;
  const speedText = (mps) => (isPace() ? mmss(mps > 0.3 ? perKm() / mps : null) : f.isNum(mps) ? ((mps * 3600) / perKm()).toFixed(1) : '–');
  const speedUnit = () => (isPace() ? `/${f.distUnit()}` : `${f.distUnit()}/h`);


  /* ── the controls ── */
  function begin() {
    st = { ...st, state: 'recording', points: [], pauses: [], start: Date.now(), pausedAt: null, follow: slim(follow), rt: follow ? { routeId: follow.id, phase: 'to', k: 0, passed: 0, startT: null, endT: null } : null, iv: ivStart() };
    localStorage.setItem('health-rec-type', st.type);
    keep(); wake(); startGps(); paint();
    // The first push, felt at once: it also shows where the cues come from.
    if (st.iv) { ivCue('push'); ivRun(); }
  }
  async function finish(btn) {
    // The name is read before anything is drawn again.
    const title = root.querySelector('[data-title]')?.value.trim() || '';
    if (st.state === 'paused') resume();
    const s = stats();
    if (st.points.length < 2 || s.d < 20) {
      if (await confirm({ title: 'Nothing to save yet', text: 'The route is too short to keep. Throw it away?', yes: 'Throw it away', no: 'Keep recording', danger: true })) discard(true);
      return;
    }
    st.state = 'done'; st.end = Date.now(); keep();
    try {
      // The route followed, and the go's start and end where they were marked by hand.
      const fol = st.rt ? { routeId: st.rt.routeId, startT: st.rt.byHandStart ? st.rt.startT : null, endT: st.rt.byHandEnd ? st.rt.endT : null } : null;
      const r = await busy(btn, () => api.post('/api/workouts/record', { type: st.type, points: st.points, pauses: st.pauses, start: st.start, end: st.end, title: title || undefined, follow: fol }));
      if (r === undefined) { st.state = 'paused'; st.pausedAt = Date.now(); paint(); return; }
      // To Health Connect too, when that is switched on (Android app): never in the way of the save.
      hcSaveRoute({ id: r.id, type: st.type, title, start: st.start, end: st.end, distanceM: r.stats?.distanceM, points: st.points.slice() }).catch(() => {});
      forget(); stopGps(); sleepOk();
      toast(`${TYPES.find((t) => t[0] === st.type)[1]} saved: ${f.dist(r.stats.distanceM)}`);
      refreshMe().catch(() => {});
      go(`/workouts/${encodeURIComponent(r.id)}`, { replace: true });
    } catch (err) {
      st.state = 'paused'; st.pausedAt = Date.now(); keep(); paint();
      toast(`${errText(err)} The route is kept on this phone; try again.`, { tone: 'bad', ms: 9000 });
    }
  }
  function discard(sure = false) {
    const go1 = () => {
      forget(); saved = null;
      st = { ...st, state: 'idle', points: [], pauses: [], start: null, pausedAt: null, rt: null, follow: null, iv: null };
      // The line stays only if this page was opened to try that route.
      if (ctx.query.get('route') !== follow?.id) { follow = null; RP = null; }
      paint();
    };
    if (sure) { go1(); return; }
    confirm({ title: 'Throw this route away?', text: 'Nothing of it is kept.', yes: 'Throw away', danger: true }).then((y) => { if (y) go1(); });
  }

  /* ── the go at the route being followed ── */
  /** Where the go is: heading to the start (how far), on the route (how much, how long), done (in what time). */
  function rtCard() {
    const rt = st.rt;
    if (!follow || !rt) return '';
    const last = st.points[st.points.length - 1];
    const toStart = last ? dist(last, routePts()[0]) : null;
    const now = Date.now();
    const pct = Math.min(100, Math.round((rt.k / Math.max(1, routePts().length - 1)) * 100));
    const body = rt.phase === 'to'
      ? html`<b>Head to the start</b><span>${f.isNum(toStart) ? `${toStart < 1000 && f.distUnit() === 'km' ? `${Math.max(10, Math.round(toStart / 10) * 10)} m` : f.dist(toStart)} away. ` : ''}It starts by itself when you get there; this walk is part of the recording, not of the route.</span>`
      : rt.phase === 'on'
        ? html`<b>On ${follow.title} · ${pct}%</b><span>${hms(now - rt.startT)} so far. It ends by itself at the finish; carry on afterwards as you like.</span>`
        : html`<b>${follow.title} done in ${hms(rt.endT - rt.startT)}</b><span>Keep going: the rest is part of the recording, not of the route.</span>`;
    const btn = rt.phase === 'to' ? html`<button type="button" class="btn btn--tonal btn--s" data-rt="start">Start the route here</button>`
      : rt.phase === 'on' ? html`<button type="button" class="btn btn--tonal btn--s" data-rt="end">Route done</button>`
        : html`<button type="button" class="btn btn--ghost btn--s" data-rt="again">Not done yet</button>`;
    return html`<div class="gps__rt gps__rt--${rt.phase}">${ic(rt.phase === 'done' ? 'check' : 'route', { size: 's' })}<span class="gps__rtb">${body}</span>${btn}</div>`;
  }
  on(root, 'click', '[data-rt]', (e, b) => {
    const rt = st.rt; if (!rt) return;
    const t = Date.now();
    if (b.dataset.rt === 'start') Object.assign(rt, { phase: 'on', k: 0, passed: 0, startT: t, byHandStart: true, endT: null, byHandEnd: false });
    else if (b.dataset.rt === 'end') Object.assign(rt, { phase: 'done', endT: t, byHandEnd: true });
    else Object.assign(rt, { phase: 'on', endT: null, byHandEnd: false });
    keep(); paintLive();
  });

  /* ── intervals: the settings before Start, the card while recording ── */
  const IV_TIMES = [15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 900, 1200];
  const ivMetres = () => (f.distUnit() === 'mi' ? [0.1, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3].map((x) => Math.round(x * 1609.344)) : [50, 100, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 3000, 5000]);
  const withNow = (list, v) => (list.includes(v) ? list : [...list, v].sort((a, b) => a - b));
  const sensorName = () => buzz.sensorCan().name || 'your sensor';
  /** What can vibrate, said plainly, and where the cues will go. */
  function ivWhere() {
    const sc = buzz.sensorCan(); const pc = buzz.phoneCan();
    const sOk = sc.state === 'yes'; const pOk = pc.can;
    const line = (ok, t, d) => html`<li class="gps__ivdev ${ok ? 'is-ok' : 'is-no'}">${ic(ok ? 'check' : 'x', { size: 's' })}<span><b>${t}</b>${d ? html`<small>${d}</small>` : ''}</span></li>`;
    const sensorLine = sOk ? line(true, `${sc.name} can vibrate`, sc.late ? 'A few seconds after each change, one pulse for each buzz of the pattern (up to three).' : '')
      : sc.state === 'no' ? line(false, `${sc.name} can't vibrate`, 'It has no way for apps to make it buzz.')
        : line(false, sc.name ? `${sc.name}: not connected` : 'No watch or band connected', sc.state === 'none' ? sc.why : 'Connect one for live heart rate and rep. checks whether it can vibrate.');
    const phoneLine = pOk ? line(true, 'This phone can vibrate', pc.screen ? 'Only while this page is on screen: the rep. app also vibrates with the screen off.' : '') : line(false, "This phone can't vibrate", pc.why);
    const watches = info('A band or watch that connects for live heart rate and has Bluetooth\'s alert service (many bands do) vibrates itself, and so does a Fitbit Air, a few seconds late. Other Fitbit and Pixel watches cannot be made to vibrate by other apps, and a chest strap has nothing to vibrate, so for those the phone does it.', { label: 'Which watches can vibrate' });
    const decision = sOk && pOk
      ? html`<div class="gps__ivto"><p class="field__label">Vibrate on</p>${segx('ivtarget', [['sensor', sc.name], ['phone', 'Phone'], ['both', 'Both']], ivCfg.target, 'Vibrate on')}</div>`
      : sOk ? html`<p class="gps__ivnote is-ok">${ic('check', { size: 's' })}<span>Cues vibrate on <b>${sc.name}</b>.</span></p>`
        : pOk ? html`<p class="gps__ivnote is-warn">${ic('phone', { size: 's' })}<span><b>Cues vibrate on this phone</b>, because ${sc.state === 'no' ? `${sc.name} can't` : 'no watch or band that can is connected'}. Keep the phone where you will feel it.</span></p>`
          : html`<p class="gps__ivnote is-bad">${ic('info', { size: 's' })}<span><b>Nothing here can vibrate.</b> Each change plays a tone and shows on screen instead.</span></p>`;
    return html`<div class="gps__ivsec"><p class="h3 gps__ivh3">Vibrations${watches}</p><ul class="gps__ivdevs">${sensorLine}${phoneLine}</ul>${decision}
      <div class="gps__ivpats">
        ${['push', 'rest'].map((k) => html`<div class="gps__ivpat"><div class="field"><label class="field__label" for="f-iv-${k}">${k === 'push' ? 'Push' : 'Rest'} feels like</label>
          <select class="select" id="f-iv-${k}" data-ivf="${k}Pat">${buzz.PATTERNS.map(([id, label]) => html`<option value="${id}" ${ivCfg[`${k}Pat`] === id ? 'selected' : ''}>${label}</option>`)}</select></div>
          <button type="button" class="btn btn--tonal btn--s" data-iv-try="${k}">${ic('play', { size: 's' })}Try</button></div>`)}
      </div></div>`;
  }
  function ivSet() {
    const el = root.querySelector('[data-ivset]');
    const sum = root.querySelector('[data-iv-sum]');
    if (sum) sum.textContent = ivCfg.on ? ivSummary(ivCfg.mode === 'hr' && ivCfg.hrUp === null ? { ...ivCfg, ...hrDefaults(ivZones) } : ivCfg, { dist: ivDist }) : 'Push and rest, with a vibration at each change';
    if (!el) return;
    el.hidden = !ivCfg.on;
    if (!ivCfg.on) { mount(el, ''); return; }
    const c = ivCfg;
    const sel = (key, label, list, text) => html`<div class="field"><label class="field__label" for="f-iv-${key}">${label}</label><select class="select" id="f-iv-${key}" data-ivf="${key}">${list.map((v) => html`<option value="${v}" ${c[key] === v ? 'selected' : ''}>${text(v)}</option>`)}</select></div>`;
    const reps = sel('reps', 'Repeats', [0, ...Array.from({ length: 20 }, (_, i) => i + 1)], (v) => (v ? `${v} ${v === 1 ? 'push' : 'pushes'}` : 'Until I stop'));
    let body;
    if (c.mode === 'time') {
      body = html`<div class="gps__ivgrid">${sel('pushS', 'Push for', withNow(IV_TIMES, c.pushS), mmss)}${sel('restS', 'Then rest for', withNow(IV_TIMES, c.restS), mmss)}</div>${reps}`;
    } else if (c.mode === 'distance') {
      body = html`<div class="gps__ivgrid">${sel('pushM', 'Push for', withNow(ivMetres(), c.pushM), ivDist)}${sel('restM', 'Then rest for', withNow(ivMetres(), c.restM), ivDist)}</div>${reps}`;
    } else {
      const d = hrDefaults(ivZones);
      const up = c.hrUp ?? d.hrUp; const down = c.hrDown ?? d.hrDown;
      const s0 = live.get();
      const hasHr = s0.bpm > 0 || s0.ble.status === 'connected';
      body = html`<div class="gps__ivhr">
          <div class="gps__ivstep"><span class="gps__ivdot gps__ivdot--push"></span><div class="field"><label class="field__label" for="f-iv-hrUp">Push until your heart rate reaches</label><span class="gps__ivbpm"><input class="input" id="f-iv-hrUp" type="number" inputmode="numeric" min="60" max="230" value="${up}" data-ivf="hrUp"><span>bpm</span></span></div></div>
          <div class="gps__ivstep"><span class="gps__ivdot gps__ivdot--rest"></span><div class="field"><label class="field__label" for="f-iv-hrDown">Then rest until it is back down to</label><span class="gps__ivbpm"><input class="input" id="f-iv-hrDown" type="number" inputmode="numeric" min="50" max="220" value="${down}" data-ivf="hrDown"><span>bpm</span></span></div></div>
          <p class="field__hint">${ivZones ? `From your zones: your top zone starts at ${ivZones.bounds[3]} bpm and easy ends at ${ivZones.bounds[1]} bpm.` : 'Start with these, then set your own.'} The heart has to stay there 5 seconds; each part lasts at least 20.</p>
        </div>${reps}
        ${hasHr ? '' : html`<div class="gps__ivneed">${ic('heart', { size: 's' })}<span>Heart-rate intervals need live heart rate while you record.</span>${live.get().ble.supported ? html`<button type="button" class="btn btn--tonal btn--s" data-live-act="connect">Connect</button>` : ''}</div>`}`;
      if (!ivZones && !ivZonesAsked) {
        ivZonesAsked = true;
        api.get('/api/workouts').then((r) => { if (r?.training?.zones?.bounds) { ivZones = r.training.zones; if (st.state === 'idle') ivSet(); } }).catch(() => {});
      }
    }
    mount(el, html`${segx('ivmode', IV_MODES, c.mode, 'Intervals by')}<div class="gps__ivbody">${body}</div>${ivWhere()}`);
  }
  /** The intervals while recording: push or rest, how far to the next change, where it was felt. */
  function ivCard() {
    const iv = st.iv;
    if (!iv) return '';
    const c = iv.cfg;
    if (iv.phase === 'done') return html`<div class="gps__iv gps__iv--done">${ic('check', { size: 's' })}<span class="gps__ivt"><b>Intervals done</b><span>${f.plural(c.reps || iv.rep, 'push', 'pushes')}. Keep going as you like.</span></span></div>`;
    const push = iv.phase === 'push';
    const s0 = live.get(); const bpm = s0.bpm > 0 ? s0.bpm : null;
    const what = c.mode === 'hr'
      ? html`<span class="gps__ivn">${push ? `to ${c.hrUp}` : `down to ${c.hrDown}`}<small> bpm</small></span><span class="gps__ivnow">${bpm ? `now ${bpm}` : 'waiting for heart rate'}</span>`
      : html`<span class="gps__ivn">${c.mode === 'time' ? mmss(Math.ceil(iv.left ?? (push ? c.pushS : c.restS))) : ivDist(Math.max(0, Math.round(iv.left ?? (push ? c.pushM : c.restM))))}</span><span class="gps__ivnow">left</span>`;
    const felt = iv.last?.felt ? `${iv.last.kind === 'push' ? 'Push' : 'Rest'} cue felt ${buzz.feltOn(iv.last.felt, sensorName())}` : '';
    return html`<div class="gps__iv gps__iv--${push ? 'push' : 'rest'}" aria-live="polite">
      <div class="gps__ivtop"><span class="gps__ivp">${push ? 'Push' : 'Rest'}</span><span class="gps__ivr">${c.reps ? `${iv.rep} of ${c.reps}` : `${iv.rep}`}</span></div>
      <div class="gps__ivmid">${what}</div>
      ${felt ? html`<p class="gps__ivf">${felt}</p>` : ''}
      <div class="gps__ivb"><button type="button" class="btn btn--tonal btn--s" data-iv-act="skip">${push ? 'Skip to rest' : 'Skip to push'}</button><button type="button" class="btn btn--ghost btn--s" data-iv-act="end">End intervals</button></div>
    </div>`;
  }
  on(root, 'change', 'input[name="iv"]', (e, c) => { ivCfg = ivConfig({ ...ivCfg, on: c.checked }); ivKeep(); ivSet(); });
  on(root, 'click', '[data-seg="ivmode"]', (e, b) => { ivCfg = ivConfig({ ...ivCfg, mode: b.dataset.value }); ivKeep(); segxTo(root, 'ivmode', b.dataset.value); ivSet(); });
  on(root, 'click', '[data-seg="ivtarget"]', (e, b) => { ivCfg = ivConfig({ ...ivCfg, target: b.dataset.value }); ivKeep(); segxTo(root, 'ivtarget', b.dataset.value); });
  on(root, 'change', '[data-ivf]', (e, el) => {
    const k = el.dataset.ivf;
    const v = /Pat$/.test(k) ? el.value : Number(el.value);
    const next = { ...ivCfg, [k]: v };
    // The other heart rate keeps the shown default when only one was set.
    if (k === 'hrUp' || k === 'hrDown') { const d = hrDefaults(ivZones); next.hrUp ??= d.hrUp; next.hrDown ??= d.hrDown; }
    ivCfg = ivConfig(next); ivKeep();
    if (k === 'hrUp' || k === 'hrDown') { const o = root.querySelector(`[data-ivf="${k === 'hrUp' ? 'hrDown' : 'hrUp'}"]`); if (o) o.value = ivCfg[k === 'hrUp' ? 'hrDown' : 'hrUp']; el.value = ivCfg[k]; }
    const sum = root.querySelector('[data-iv-sum]'); if (sum) sum.textContent = ivSummary(ivCfg, { dist: ivDist });
  });
  on(root, 'click', '[data-iv-try]', async (e, b) => {
    const k = b.dataset.ivTry;
    const r = await buzz.play(ivCfg[`${k}Pat`], ivCfg.target, { high: k === 'push' });
    toast(`${k === 'push' ? 'Push' : 'Rest'}: felt ${buzz.feltOn(r, sensorName())}`);
  });
  on(root, 'click', '[data-iv-act]', (e, b) => {
    const iv = st.iv; if (!iv || iv.phase === 'done') return;
    if (b.dataset.ivAct === 'end') { iv.phase = 'done'; keep(); paintLive(); return; }
    // Heart rate: on to the next part. Time and distance: as if this part were over (ivTick cues it).
    if (iv.cfg.mode === 'hr') { const to = ivSkip(iv, iv.cfg, Date.now()); if (to) ivCue(to); } else { iv.offset = (iv.offset || 0) + (iv.left ?? 0) + 0.01; ivTick(); }
    paintLive();
  });
  // A sensor connecting or dropping changes what can vibrate: the settings say so at once.
  let ivSig = '';
  const unIv = live.subscribe((s) => {
    if (st.state !== 'idle' || !ivCfg.on) return;
    const sig = `${s.ble.status}|${s.ble.alert}|${s.ble.name}|${s.bpm > 0}`;
    if (sig !== ivSig) { ivSig = sig; ivSet(); }
  });

  /* ── drawing ── */
  function paint() {
    map?.destroy(); map = null;
    const busy1 = st.state === 'recording' || st.state === 'paused';
    mount(root, html`
      ${head({ title: busy1 ? (st.state === 'paused' ? 'Paused' : 'Recording') : 'Record a route', back: '/workouts' })}
      ${follow ? html`<div class="gps__follow">${ic('route', { size: 's' })}<span>Following <b>${follow.title}</b>, ${f.dist(follow.distanceM)}${follow.bothWays ? ' there and back' : ''}. It is the dotted line on the map.</span></div>` : ''}
      <div class="gps stack">
        ${!busy1 ? html`
          ${saved && saved.state !== 'idle' && saved.points?.length > 1 && st.state === 'idle' ? banner({ tone: 'warn', title: 'A route was being recorded', text: `Started ${f.dateTime(saved.start)}, ${f.plural(saved.points.length, 'point')}. Carry on with it, or save it as it is.`, actions: html`<button type="button" class="btn btn--s" data-r="resume-old">Carry on</button><button type="button" class="btn btn--tonal btn--s" data-r="save-old">Save it</button><button type="button" class="btn btn--ghost btn--s" data-r="drop-old">Throw away</button>` }) : ''}
          <div class="chips gps__types" role="radiogroup" aria-label="What it is">${TYPES.map(([id, label, icon]) => html`<button type="button" class="chip" role="radio" data-type="${id}" aria-checked="${String(st.type === id)}" aria-pressed="${String(st.type === id)}">${ic(icon, { size: 's' })}${label}</button>`)}</div>
          <div class="gps__gps" data-gps></div>
          <div class="gps__map" data-map></div>
          <button type="button" class="btn gps__go" data-r="start">${ic('play', { size: 's' })}Start</button>
          <div class="me-grp gps__grp">
            <div class="me-srow"><div class="me-srow__b"><p class="me-srow__t">Pause on its own${info('When you stop, and on when you move.', { label: 'About pausing on its own' })}</p></div>${toggle('auto', st.autoPause, { label: 'Pause on its own' })}</div>
            <div class="me-srow"><div class="me-srow__b"><p class="me-srow__t">Intervals${info('Push, then rest, again and again: by heart rate, time or distance. Each change is a vibration, one kind for push and another for rest.', { label: 'About intervals' })}</p><p class="me-srow__d" data-iv-sum>${ivCfg.on ? ivSummary(ivCfg, { dist: ivDist }) : 'Push and rest, with a vibration at each change'}</p></div>${toggle('iv', ivCfg.on, { label: 'Intervals' })}</div>
          </div>
          <div class="gps__ivset" data-ivset ${ivCfg.on ? '' : 'hidden'}></div>
          <div class="xrows">
            <label class="xrow press gps__gpx"><span class="xrow__ic fam fam-active">${ic('upload')}</span><span class="xrow__b"><span class="xrow__t">Import a GPX file</span><span class="xrow__d">A route from another app or device</span></span><span class="xrow__chev">${ic('right', { size: 's' })}</span><input type="file" accept=".gpx,application/gpx+xml" data-gpx hidden></label>
            <button type="button" class="xrow press" data-r="tips"><span class="xrow__ic">${ic('info')}</span><span class="xrow__b"><span class="xrow__t">${native() ? 'Recording with the screen off' : 'Keep the screen on'}</span><span class="xrow__d">${native() ? 'How the app keeps recording' : 'Why the page stays open while recording'}</span></span><span class="xrow__chev">${ic('right', { size: 's' })}</span></button>
          </div>` : html`
          <div class="gps__big" data-live></div>
          <div class="gps__hr" data-live-rec>${liveHistory()}<div data-hrc></div></div>
          <div class="gps__map gps__map--live" data-map></div>
          <div class="gps__ctl">
            ${st.state === 'recording' ? html`<button type="button" class="btn btn--tonal gps__b" data-r="pause">${ic('pause', { size: 's' })}Pause</button>` : html`<button type="button" class="btn gps__b" data-r="resume">${ic('play', { size: 's' })}Resume</button>`}
            <button type="button" class="btn gps__b ${st.state === 'paused' ? '' : 'btn--tonal'}" data-r="finish">${ic('stop', { size: 's' })}Finish</button>
          </div>
          ${st.state === 'paused' ? html`<div class="field"><label class="field__label" for="rec-title">Name (optional)</label><input class="input" id="rec-title" data-title maxlength="80" placeholder="${TYPES.find((t) => t[0] === st.type)[1]}" autocomplete="off"></div>
            <button type="button" class="btn btn--ghost btn--s" data-r="discard">${ic('trash', { size: 's' })}Throw it away</button>` : ''}
          <div data-splits></div>`}
      </div>`);
    const mapEl = root.querySelector('[data-map]');
    if (mapEl && (busy1 || fix || follow)) map = routeMap(mapEl, { line: st.points.map((x) => [x[1], x[2]]), follow: busy1 || !!fix, height: busy1 ? 260 : 200, guide: follow?.line || null, center: fix ? [fix.lat, fix.lng] : null, onLocate: () => { gpsErr = null; stopGps(); startGps(); paintLive(); }, label: follow ? `Map of your route so far, over ${follow.title}` : 'Map of your route so far' });
    if (map && fix) map.me(fix.lat, fix.lng, fix.acc);
    paintLive();
    paintHr(root); hrConnect(live.get());
    ivSet();
  }
  /* Heart rate while recording: the live chart (liveui.js) under the numbers, or one tap to connect a sensor. */
  function hrConnect(s) {
    const el = root.querySelector('[data-hrc]');
    if (!el) return;
    const b = s.ble;
    const want = (s.bpm !== null && s.bpm > 0) || (b.supported && b.status !== 'off');
    const html1 = want ? '' : b.supported
      ? `<button type="button" class="btn btn--tonal btn--s gps__hrc" data-live-act="connect">${b.remembered ? `Connect ${(b.name || 'heart rate').replace(/[<>&"]/g, '')}` : 'Connect heart rate'}</button>`
      : '';
    if (el.innerHTML !== html1) el.innerHTML = html1;
  }
  const unHr = live.subscribe(hrConnect);
  const stopLive = bindLive(root);
  let lastFixCentre = false;
  function paintLive() {
    const g = root.querySelector('[data-gps]');
    if (g) {
      mount(g, gpsErr ? banner({ tone: 'warn', iconName: 'locate', title: 'Location', text: gpsErr })
        : fix ? html`<p class="gps__fix ${fix.acc <= 20 ? 'is-good' : fix.acc <= 50 ? 'is-ok' : 'is-bad'}">${ic('locate', { size: 's' })}<span>${fix.acc <= 20 ? 'GPS ready' : fix.acc <= 50 ? 'GPS fair' : 'GPS weak: wait a moment'} (to ${fix.acc} m)</span></p>`
          : html`<p class="gps__fix">${ic('locate', { size: 's' })}<span>Finding your position…</span></p>`);
      // Show where you are before starting.
      if (fix && !lastFixCentre && !map) { lastFixCentre = true; paint(); return; }
    }
    const l = root.querySelector('[data-live]');
    if (!l) return;
    const s = stats();
    const avg = s.moving > 0 ? s.d / s.moving : null;
    mount(l, html`
      <div class="gps__main"><span class="gps__v">${(s.d / perKm()).toFixed(2)}</span><span class="gps__u">${f.distUnit()}</span></div>
      <div class="gps__row">
        <div><span class="gps__k">Time</span><span class="gps__n">${hms(s.elapsed)}</span></div>
        <div><span class="gps__k">${isPace() ? 'Pace now' : 'Speed now'}</span><span class="gps__n">${speedText(s.cur)}<small> ${speedUnit()}</small></span></div>
        <div><span class="gps__k">${isPace() ? 'Average pace' : 'Average speed'}</span><span class="gps__n">${speedText(avg)}<small> ${speedUnit()}</small></span></div>
        <div><span class="gps__k">Climb</span><span class="gps__n">${f.int(s.gain)}<small> m</small></span></div>
      </div>
      ${st.state === 'paused' ? html`<p class="gps__paused">${ic('pause', { size: 's' })}Paused${autoPaused ? ' on its own: it carries on when you move' : ''}</p>` : ''}
      ${gpsErr ? html`<p class="gps__warn small">${gpsErr}</p>` : fix && fix.acc > 50 ? html`<p class="gps__warn small">Weak GPS (to ${fix.acc} m): points are skipped until it improves.</p>` : ''}
      ${rtCard()}
      ${ivCard()}`);
    const sp = root.querySelector('[data-splits]');
    if (sp) mount(sp, s.splits.length ? html`<div class="group"><p class="h3 gps__sh">Splits</p>${s.splits.map((t, i) => html`<div class="row"><span class="row__body"><span class="row__t">${f.distUnit() === 'mi' ? 'Mile' : 'Kilometre'} ${i + 1}</span></span><span class="row__v">${mmss(t)}</span></div>`).reverse()}</div>` : '');
  }

  on(root, 'click', '[data-type]', (e, b) => { st.type = b.dataset.type; paint(); });
  on(root, 'change', 'input[name="auto"]', (e, c) => { st.autoPause = c.checked; localStorage.setItem('health-rec-auto', c.checked ? '1' : '0'); });
  on(root, 'click', '[data-r]', (e, b) => {
    const a = b.dataset.r;
    if (a === 'tips') {
      sheet({ title: native() ? 'Recording with the screen off' : 'Keep the screen on', body: native()
        ? html`<p class="prose">In the rep. app the route keeps recording with the screen off or another app open. When it asks, allow location while using the app; the location arrow at the top of the screen shows it is recording.</p><p class="prose">Finish it here when you are done.</p>`
        : html`<p class="prose">Keep rep. open and the phone unlocked in a pocket or on the bars: a web page only gets your position while it is on screen, so the screen stays on while recording. Other screens in rep. are fine. Time with the screen off still counts, but the route between is a straight line.</p><p class="prose">The rep. app records with the screen off. Or use your watch or Strava; it comes here through Google Health or Strava.</p>` });
      return;
    }
    if (a === 'start') { if (gpsErr && !fix) { toast(gpsErr, { tone: 'bad' }); return; } begin(); }
    else if (a === 'pause') { autoPaused = false; pause(); }
    else if (a === 'resume') { autoPaused = false; resume(); }
    else if (a === 'finish') finish(b);
    else if (a === 'discard') discard();
    else if (a === 'resume-old') { adopt({ ...saved, state: 'paused', pausedAt: saved.pausedAt || saved.savedAt || Date.now() }); wake(); startGps(); paint(); }
    else if (a === 'save-old') { adopt({ ...saved, state: 'paused', pausedAt: saved.pausedAt || saved.savedAt || Date.now() }); paint(); finish(b); }
    else if (a === 'drop-old') { forget(); location.reload(); }
  });
  on(root, 'change', '[data-gpx]', async (e, input) => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('That file is over 8 MB.', { tone: 'bad' }); return; }
    try {
      const r = await api.upload('/api/workouts/import/gpx', await file.text(), 'application/gpx+xml');
      toast(`Imported: ${f.dist(r.stats.distanceM)}`);
      go(`/workouts/${encodeURIComponent(r.id)}`);
    } catch (err) { toastError(err); }
  });

  tick = setInterval(() => { if (going()) paintLive(); }, 1000);
  const me = { paint, live: paintLive, me: (lat, lng, acc) => map?.me(lat, lng, acc), update: (line) => map?.update(line) };
  view = me;
  ctx.onLeave(() => {
    unHr(); stopLive(); unIv();
    clearInterval(tick); map?.destroy(); map = null;
    if (view === me) view = null;
    // A recording goes on without its page: only a page with nothing running lets go of the GPS.
    if (going()) keep(); else { stopGps(); sleepOk(); }
  });
  startGps();
  if (going()) wake();
  // "Try it" from a route's page: that route under the line, and its sport chosen. A recording
  // under way keeps its own route, whatever the address says.
  const rid = going() ? st.rt?.routeId : ctx.query.get('route');
  if (validRoute(rid) && follow?.id !== rid) {
    try {
      const r = await api.get(`/api/routes/${rid}`);
      follow = r; RP = null;
      if (going()) { st.follow = slim(r); keep(); }
      if (st.state === 'idle') st.type = { run: 'RUNNING', walk: 'WALKING', hike: 'HIKING', ride: 'BIKING' }[r.sport] || st.type;
    } catch { toast(going() ? 'The route could not be opened, so its line is not on the map for now.' : 'That route could not be opened, so this is a plain recording.'); }
    if (!ctx.alive()) return;
  }
  paint();
}
