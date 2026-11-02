/* Workouts, Record a route: a run, walk, hike or ride with the phone's
   GPS, the way a running app does it. Choose what it is, start, and the
   screen shows time, distance, pace (or speed), climb and each
   kilometre's split, with the route on a map that follows you. Pause and
   carry on; finish and it is saved as a workout with its route.

   In the Health app the phone's own location service records, with the
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
import { html, mount, ic, on, head, banner, toast, toastError, busy, confirm, errText, toggle, sheet } from '../ui.js';
import * as f from '../format.js';
import { routeMap } from '../map.js';

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

export default async function record(ctx) {
  const { root } = ctx;
  document.title = 'Record a route · Health';
  // state: idle | recording | paused | done
  let st = { state: 'idle', type: localStorage.getItem('health-rec-type') || 'RUNNING', points: [], pauses: [], start: null, pausedAt: null, autoPause: localStorage.getItem('health-rec-auto') === '1' };
  let watch = null; let lock = null; let fix = null; let gpsErr = null; let map = null; let tick = null; let autoPaused = false; let still = 0;

  const saved = safe(() => JSON.parse(localStorage.getItem(KEY) || 'null'));
  const keep = () => safe(() => localStorage.setItem(KEY, JSON.stringify({ ...st, savedAt: Date.now() })));
  const forget = () => safe(() => localStorage.removeItem(KEY));

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

  /* ── GPS ── */
  function onPos(pos) {
    const c = pos.coords;
    fix = { acc: Math.round(c.accuracy), at: pos.timestamp || Date.now(), lat: c.latitude, lng: c.longitude };
    map?.me(c.latitude, c.longitude, c.accuracy);
    gpsErr = null;
    if (st.state === 'recording' && c.accuracy <= 50) {
      const prevT = st.points.length ? st.points[st.points.length - 1][0] : 0;
      const t = Math.min(Date.now(), Number(pos.timestamp) || Date.now());
      if (t <= prevT) { paintLive(); return; }
      const pt = [t, Math.round(c.latitude * 1e6) / 1e6, Math.round(c.longitude * 1e6) / 1e6, f.isNum(c.altitude) ? Math.round(c.altitude * 10) / 10 : null, Math.round(c.accuracy)];
      const prev = st.points[st.points.length - 1];
      // Standing still: a point every few seconds is enough.
      if (!prev || dist(prev, pt) >= 3 || pt[0] - prev[0] >= 5000) st.points.push(pt);
      if (st.autoPause) autoPauseCheck(c.speed);
      if (st.points.length % 5 === 0) keep();
      if (follow && st.rt && !st.rt.byHandEnd) { rtStep(st.rt, routePts(), pt, RT_V[st.type] || 7); }
      map?.update(st.points.map((x) => [x[1], x[2]]));
    }
    paintLive();
  }
  function autoPauseCheck(speed) {
    const v = f.isNum(speed) ? speed : null;
    if (v === null) return;
    if (v < 0.5) { still += 1; if (still >= 6 && st.state === 'recording') { autoPaused = true; pause(); } } else { still = 0; if (autoPaused && st.state === 'paused') { autoPaused = false; resume(); } }
  }
  function onErr(e) {
    gpsErr = e.code === 1 ? 'Location is not allowed for this site. Allow it in the browser\'s site settings, then try again.' : e.code === 2 ? 'Your position cannot be found. Go outside, away from tall buildings.' : 'Still looking for your position…';
    paintLive();
  }
  /* The Health app's own location service: it carries on with the screen off. Only
     while recording (and asked for then), so opening this page asks for nothing more. */
  const native = () => (window.Capacitor?.isPluginAvailable?.('BackgroundGeolocation') ? window.Capacitor.Plugins.BackgroundGeolocation : null);
  let nativeId = null; let nativeWant = false;
  const startNative = () => {
    const BG = native();
    if (!BG || nativeWant) return !!BG;
    nativeWant = true;
    BG.addWatcher({ backgroundMessage: 'Recording your route.', backgroundTitle: 'Health', requestPermissions: true, stale: false, distanceFilter: 0 }, (loc, e) => {
      if (e) { onErr({ code: e.code === 'NOT_AUTHORIZED' ? 1 : 3 }); return; }
      if (!loc) return;
      onPos({ timestamp: loc.time, coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, altitude: loc.altitude, speed: loc.speed } });
    }).then((id) => { if (nativeWant) nativeId = id; else BG.removeWatcher({ id }).catch(() => {}); }, () => { nativeWant = false; });
    return true;
  };
  const stopNative = () => { nativeWant = false; if (nativeId !== null) native()?.removeWatcher({ id: nativeId }).catch(() => {}); nativeId = null; };
  const startGps = () => {
    // Recording in the app: the phone's location service, not the page's.
    if ((st.state === 'recording' || st.state === 'paused') && startNative()) { if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null; return; }
    if (!('geolocation' in navigator)) { gpsErr = 'This browser cannot give a position.'; return; }
    if (watch === null) watch = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
  };
  const stopGps = () => { if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null; stopNative(); };
  const wake = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; } };
  const onVis = () => { if (document.visibilityState === 'visible' && (st.state === 'recording' || st.state === 'paused')) wake(); };
  document.addEventListener('visibilitychange', onVis);

  /* ── the controls ── */
  function begin() {
    st = { ...st, state: 'recording', points: [], pauses: [], start: Date.now(), pausedAt: null, rt: follow ? { routeId: follow.id, phase: 'to', k: 0, passed: 0, startT: null, endT: null } : null };
    localStorage.setItem('health-rec-type', st.type);
    keep(); wake(); startGps(); paint();
  }
  function pause() { if (st.state !== 'recording') return; st.state = 'paused'; st.pausedAt = Date.now(); keep(); paint(); }
  function resume() { if (st.state !== 'paused') return; st.pauses.push([st.pausedAt, Date.now()]); st.pausedAt = null; st.state = 'recording'; keep(); paint(); }
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
      forget(); stopGps(); lock?.release?.().catch(() => {});
      toast(`${TYPES.find((t) => t[0] === st.type)[1]} saved: ${f.dist(r.stats.distanceM)}`);
      refreshMe().catch(() => {});
      go(`/workouts/${encodeURIComponent(r.id)}`, { replace: true });
    } catch (err) {
      st.state = 'paused'; st.pausedAt = Date.now(); keep(); paint();
      toast(`${errText(err)} The route is kept on this phone; try again.`, { tone: 'bad', ms: 9000 });
    }
  }
  function discard(sure = false) {
    const go1 = () => { forget(); st = { ...st, state: 'idle', points: [], pauses: [], start: null, pausedAt: null }; paint(); };
    if (sure) { go1(); return; }
    confirm({ title: 'Throw this route away?', text: 'Nothing of it is kept.', yes: 'Throw away', danger: true }).then((y) => { if (y) go1(); });
  }

  /* ── the go at the route being followed ── */
  let RP = null;
  const routePts = () => (RP ||= densify(follow.line));
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

  /* ── drawing ── */
  function paint() {
    map?.destroy(); map = null;
    const busy1 = st.state === 'recording' || st.state === 'paused';
    mount(root, html`
      ${head({ title: busy1 ? (st.state === 'paused' ? 'Paused' : 'Recording') : 'Record a route', back: busy1 ? '' : '/workouts' })}
      ${follow ? html`<div class="gps__follow">${ic('route', { size: 's' })}<span>Following <b>${follow.title}</b>, ${f.dist(follow.distanceM)}. It is the dotted line on the map.</span></div>` : ''}
      <div class="gps stack">
        ${!busy1 ? html`
          ${saved && saved.state !== 'idle' && saved.points?.length > 1 && st.state === 'idle' ? banner({ tone: 'warn', title: 'A route was being recorded', text: `Started ${f.dateTime(saved.start)}, ${f.plural(saved.points.length, 'point')}. Carry on with it, or save it as it is.`, actions: html`<button type="button" class="btn btn--s" data-r="resume-old">Carry on</button><button type="button" class="btn btn--tonal btn--s" data-r="save-old">Save it</button><button type="button" class="btn btn--ghost btn--s" data-r="drop-old">Throw away</button>` }) : ''}
          <div class="chips gps__types" role="radiogroup" aria-label="What it is">${TYPES.map(([id, label, icon]) => html`<button type="button" class="chip" role="radio" data-type="${id}" aria-checked="${String(st.type === id)}" aria-pressed="${String(st.type === id)}">${ic(icon, { size: 's' })}${label}</button>`)}</div>
          <div class="gps__gps" data-gps></div>
          <div class="gps__map" data-map></div>
          <button type="button" class="btn gps__go" data-r="start">${ic('play', { size: 's' })}Start</button>
          <div class="me-grp gps__grp">
            <div class="me-srow"><div class="me-srow__b"><p class="me-srow__t">Pause on its own</p><p class="me-srow__d">When you stop, and on when you move</p></div>${toggle('auto', st.autoPause, { label: 'Pause on its own' })}</div>
          </div>
          <div class="xrows">
            <label class="xrow press gps__gpx"><span class="xrow__ic fam fam-active">${ic('upload')}</span><span class="xrow__b"><span class="xrow__t">Import a GPX file</span><span class="xrow__d">A route from another app or device</span></span><span class="xrow__chev">${ic('right', { size: 's' })}</span><input type="file" accept=".gpx,application/gpx+xml" data-gpx hidden></label>
            <button type="button" class="xrow press" data-r="tips"><span class="xrow__ic">${ic('info')}</span><span class="xrow__b"><span class="xrow__t">${native() ? 'Recording with the screen off' : 'Keep the screen on'}</span><span class="xrow__d">${native() ? 'How the app keeps recording' : 'Why the page stays open while recording'}</span></span><span class="xrow__chev">${ic('right', { size: 's' })}</span></button>
          </div>` : html`
          <div class="gps__big" data-live></div>
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
  }
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
      ${rtCard()}`);
    const sp = root.querySelector('[data-splits]');
    if (sp) mount(sp, s.splits.length ? html`<div class="group"><p class="h3 gps__sh">Splits</p>${s.splits.map((t, i) => html`<div class="row"><span class="row__body"><span class="row__t">${f.distUnit() === 'mi' ? 'Mile' : 'Kilometre'} ${i + 1}</span></span><span class="row__v">${mmss(t)}</span></div>`).reverse()}</div>` : '');
  }

  on(root, 'click', '[data-type]', (e, b) => { st.type = b.dataset.type; paint(); });
  on(root, 'change', 'input[name="auto"]', (e, c) => { st.autoPause = c.checked; localStorage.setItem('health-rec-auto', c.checked ? '1' : '0'); });
  on(root, 'click', '[data-r]', (e, b) => {
    const a = b.dataset.r;
    if (a === 'tips') {
      sheet({ title: native() ? 'Recording with the screen off' : 'Keep the screen on', body: native()
        ? html`<p class="prose">In the Health app the route keeps recording with the screen off or another app open. When it asks, allow location while using the app; the location arrow at the top of the screen shows it is recording.</p><p class="prose">Finish it here when you are done.</p>`
        : html`<p class="prose">Keep this page open and the phone unlocked in a pocket or on the bars: a web page only gets your position while it is on screen, so the screen stays on while recording. Time with the screen off still counts, but the route between is a straight line.</p><p class="prose">The Health app records with the screen off. Or use your watch or Strava; it comes here through Google Health or Strava.</p>` });
      return;
    }
    if (a === 'start') { if (gpsErr && !fix) { toast(gpsErr, { tone: 'bad' }); return; } begin(); }
    else if (a === 'pause') { autoPaused = false; pause(); }
    else if (a === 'resume') { autoPaused = false; resume(); }
    else if (a === 'finish') finish(b);
    else if (a === 'discard') discard();
    else if (a === 'resume-old') { st = { ...saved, state: 'paused', pausedAt: saved.pausedAt || saved.savedAt || Date.now() }; wake(); startGps(); paint(); }
    else if (a === 'save-old') { st = { ...saved, state: 'paused', pausedAt: saved.pausedAt || saved.savedAt || Date.now() }; paint(); finish(b); }
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

  tick = setInterval(() => { if (st.state === 'recording' || st.state === 'paused') paintLive(); }, 1000);
  ctx.onLeave(() => {
    clearInterval(tick); stopGps(); map?.destroy(); lock?.release?.().catch(() => {});
    document.removeEventListener('visibilitychange', onVis);
    if (st.state === 'recording' || st.state === 'paused') keep();
  });
  startGps();
  // "Try it" from a route's page: that route under the line, and its sport chosen.
  let follow = null;
  const rid = ctx.query.get('route');
  if (rid && /^r_[0-9a-f]{12}$/.test(rid)) {
    try {
      follow = await api.get(`/api/routes/${rid}`);
      if (st.state === 'idle') st.type = { run: 'RUNNING', walk: 'WALKING', hike: 'HIKING', ride: 'BIKING' }[follow.sport] || st.type;
    } catch { toast('That route could not be opened, so this is a plain recording.'); }
    if (!ctx.alive()) return;
  }
  paint();
}
