/* Live heart rate: one store, two ways in.

   - This browser reads a sensor itself over Web Bluetooth (the standard
     Heart Rate Service) and posts what it reads to /api/live/hr, so the
     person's other devices see it too.
   - Another of the person's devices (the Ojee Pulse overlay) posts, and
     the reading arrives here as the `live` event on /api/events.

   Either way the screens read the same store: subscribe(), get().

   The Bluetooth side is built to stay connected. It lives here, outside
   any screen, so moving around the app does not touch it. Once a sensor
   has been connected it is remembered, and on every later load the app
   tries to get it back without a tap where the browser allows that
   (getDevices, then watchAdvertisements). While the app is open it never
   gives up: a dropped sensor is retried after 1 s, 2 s, 5 s, then every
   10 to 15 s for as long as it takes; coming back to the tab, coming back
   online and a page restored from the back/forward cache each retry at
   once; a connection that says it is up but has delivered nothing for
   15 s is torn down and made again. Only "Disconnect" stops it.

   Nothing here touches the document: views/liveui.js draws it. That also
   keeps this file importable by the tests, which check the parser. */

const TTL_MS = 12_000;               // the server ends it after 10 s; this is the fallback if that event is lost
const KEEP_MS = 120_000;             // history kept for the sparkline
const STALL_MS = 15_000;             // "connected" with no reading for this long is not connected
const AWAY_MS = 20_000;              // reconnecting for this long reads as "out of range"
const CONNECT_TIMEOUT_MS = 20_000;
const LOCAL_FRESH_MS = 3_000;        // while this browser's own sensor is delivering, it is the source
const POST_GAP_MS = 900;
const QUEUE_MAX = 20;                // also the server's limit for one request
const QUEUE_AGE_MS = 55_000;         // the server ignores samples older than 60 s
const KEY = { device: 'health.live.device', want: 'health.live.want', awake: 'health.live.awake' };

/* ── pure parts (tested in tests/live.test.js) ──────────────── */

/**
 * The bpm in a Heart Rate Measurement (0x2A37) value, or null when the
 * value is malformed. Flags byte: bit 0 says the value is uint16 rather
 * than uint8; bit 2 says the sensor can tell whether it touches skin and
 * bit 1 whether it does. Supported and not touching is reported as 0.
 */
export function parseHeartRate(dv) {
  if (!dv || typeof dv.getUint8 !== 'function' || dv.byteLength < 2) return null;
  const flags = dv.getUint8(0);
  const wide = (flags & 0x01) !== 0;
  if (wide && dv.byteLength < 3) return null;
  const contactKnown = (flags & 0x04) !== 0;
  const contact = (flags & 0x02) !== 0;
  if (contactKnown && !contact) return 0;
  return wide ? dv.getUint16(1, true) : dv.getUint8(1);
}

/** How long to wait before reconnect attempt number `attempt` (from 0). */
export function retryDelay(attempt, rand = Math.random) {
  return [1000, 2000, 5000][attempt] ?? 10_000 + Math.round(rand() * 5000);
}

/* ── the store ──────────────────────────────────────────────── */

const state = {
  /** The live reading, or bpm null when there is none. */
  bpm: null, t: null, source: null,
  /** True when the reading came from this browser's own sensor. */
  local: false,
  /** [[t, bpm], …] of the last two minutes, oldest first. */
  recent: [],
  ble: {
    supported: false,
    /** off | connecting | connected | reconnecting | away | tap */
    status: 'off',
    /** The sensor in use, or the one remembered from last time. */
    name: null,
    remembered: false,
  },
  wake: { supported: false, on: false, held: false },
};

const subs = new Set();
const notify = () => { for (const fn of [...subs]) { try { fn(state); } catch (e) { console.error(e); } } };
/** Call `fn(state)` on every change. Returns the function that stops it. */
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export const get = () => state;

let active = false;
let beatTimer = null;
let takenAt = 0;        // when the shown reading arrived here (this clock)
let localAt = 0;        // when this browser's sensor last delivered a real reading

const store = {
  read(k) { try { return localStorage.getItem(k); } catch { return null; } },
  write(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function remember(t, bpm) {
  const r = state.recent;
  let i = r.length;
  while (i > 0 && r[i - 1][0] > t) i -= 1;
  if (i > 0 && r[i - 1][0] === t) r[i - 1][1] = bpm; else r.splice(i, 0, [t, bpm]);
  const newest = r[r.length - 1][0];
  while (r.length && newest - r[0][0] > KEEP_MS) r.shift();
}

function take(bpm, t, source, local) {
  state.bpm = bpm; state.t = t; state.source = source; state.local = local;
  takenAt = Date.now();
  remember(t, bpm);
  wakeSync();
  notify();
}

function clear({ trace = false } = {}) {
  const had = state.bpm !== null;
  state.bpm = null; state.t = null; state.source = null; state.local = false;
  if (trace) state.recent = [];
  if (had || trace) { wakeSync(); notify(); }
}

const localFresh = () => Date.now() - localAt < LOCAL_FRESH_MS;

/** A `live` event from the server: { bpm, t, source }, or bpm null at the end. */
export function ingest(d) {
  if (!active || !d || typeof d !== 'object') return;
  // While this browser's own sensor is delivering, it is the truth here;
  // the server's copy of the same readings (and its end) would only lag.
  if (localFresh()) return;
  if (d.bpm === null || d.bpm === undefined) { clear(); return; }
  if (typeof d.bpm !== 'number' || typeof d.t !== 'number') return;
  if (state.t !== null && d.t < state.t && !state.local) return;
  take(d.bpm, d.t, d.source || 'pulse', false);
}

/** Ask the server what is live right now (on load, and when the stream reconnects). */
export async function refresh() {
  if (!active) return;
  try {
    const res = await fetch('/api/live', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const d = await res.json();
    if (!active || localFresh()) return;
    if (Array.isArray(d.recent)) for (const p of d.recent) if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') remember(p[0], p[1]);
    if (typeof d.bpm === 'number' && typeof d.t === 'number') take(d.bpm, d.t, d.source || 'pulse', false);
    else if (state.bpm !== null) clear();
    else notify();
  } catch { /* offline: the stream will say when there is something */ }
}

/* ── posting this browser's readings ────────────────────────── */

let queue = [];
let posting = false;
let postedAt = 0;
let holdUntil = 0;
let lastQueued = null;

function enqueue(t, bpm) {
  // One zero is the whole message; a run of them says nothing more.
  if (bpm === 0 && lastQueued === 0) return;
  lastQueued = bpm;
  queue.push({ t, bpm });
  // Across a network drop the newest twenty wait; older ones are let go.
  while (queue.length > QUEUE_MAX) queue.shift();
  if (Date.now() - postedAt >= POST_GAP_MS) flush();
}

async function flush() {
  const now = Date.now();
  if (posting || !active || !queue.length || now < holdUntil) return;
  queue = queue.filter((s) => now - s.t < QUEUE_AGE_MS);
  if (!queue.length) return;
  const batch = queue.slice(0, QUEUE_MAX);
  posting = true; postedAt = now;
  try {
    const res = await fetch('/api/live/hr', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ samples: batch, source: 'browser' }),
    });
    if (res.ok || res.status === 400 || res.status === 413) queue = queue.filter((s) => !batch.includes(s));   // sent, or never going to be accepted
    else if (res.status === 401 || res.status === 403) { queue = []; holdUntil = Date.now() + 15_000; }        // signed out: main.js will notice
    else holdUntil = Date.now() + (res.status === 429 ? 1100 : 3000);
  } catch {
    // No network: keep them and try again shortly, and at once when online.
    holdUntil = Date.now() + 2000;
  } finally { posting = false; }
}

/* ── Web Bluetooth ──────────────────────────────────────────── */

const bt = () => (typeof navigator !== 'undefined' ? navigator.bluetooth : undefined);

let want = false;         // the person's intent to stay connected; only Disconnect clears it
let saved = null;         // { id, name } of the remembered sensor
let device = null;
let characteristic = null;
let busy = false;         // a connection attempt is in flight
let epoch = 0;            // bumped to cancel an attempt in flight
let attempt = 0;
let retryAt = 0;
let droppedAt = 0;
let valueAt = 0;          // when the sensor last notified, whatever it said
let watchStop = null;

function setStatus(status) {
  const b = state.ble;
  const name = device?.name || saved?.name || null;
  if (b.status === status && b.name === name && b.remembered === Boolean(saved)) return;
  b.status = status; b.name = name; b.remembered = Boolean(saved);
  wakeSync();
  notify();
}

const timeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { name: 'TimeoutError' })), ms);
  promise.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
});

function onValue(e) {
  const v = parseHeartRate(e.target?.value);
  if (v === null) return;
  const now = Date.now();
  valueAt = now;
  if (v >= 25 && v <= 250) {
    localAt = now;
    take(v, now, 'browser', true);
    enqueue(now, v);
    return;
  }
  // Off the skin (or a value no heart makes): nothing is live from here.
  localAt = 0;
  if (state.local) clear({ trace: true });
  enqueue(now, 0);
}

function onDrop() {
  characteristic = null;
  localAt = 0;
  if (state.local) clear();
  if (!want) { setStatus('off'); return; }
  if (busy || retryAt) return;   // the attempt in flight, or the one scheduled, carries on
  schedule();
}

function schedule() {
  if (!want || !device) return;
  if (!droppedAt) droppedAt = Date.now();
  retryAt = Date.now() + retryDelay(attempt);
  attempt += 1;
  setStatus(Date.now() - droppedAt >= AWAY_MS ? 'away' : 'reconnecting');
}

function adopt(dev) {
  if (device && device !== dev) {
    device.removeEventListener('gattserverdisconnected', onDrop);
    try { if (device.gatt?.connected) device.gatt.disconnect(); } catch { /* already gone */ }
  }
  if (device !== dev) dev.addEventListener('gattserverdisconnected', onDrop);
  device = dev;
  saved = { id: dev.id, name: dev.name || 'Heart-rate sensor' };
  store.write(KEY.device, JSON.stringify(saved));
}

function stopWatch() {
  const stop = watchStop;
  watchStop = null;
  if (stop) { try { stop(); } catch { /* not watching */ } }
}

/** One attempt to connect to `device` and start its notifications. */
async function link() {
  if (busy || !device || !want) return;
  busy = true; retryAt = 0;
  const mine = epoch += 1;
  const dev = device;
  try {
    const server = await timeout(dev.gatt.connect(), CONNECT_TIMEOUT_MS, 'Connecting');
    if (mine !== epoch || !want) { try { dev.gatt.disconnect(); } catch { /* gone */ } return; }
    const service = await timeout(server.getPrimaryService('heart_rate'), 10_000, 'Reading the sensor');
    const ch = await timeout(service.getCharacteristic('heart_rate_measurement'), 10_000, 'Reading the sensor');
    if (characteristic && characteristic !== ch) characteristic.removeEventListener('characteristicvaluechanged', onValue);
    ch.removeEventListener('characteristicvaluechanged', onValue);
    ch.addEventListener('characteristicvaluechanged', onValue);
    await timeout(ch.startNotifications(), 10_000, 'Reading the sensor');
    if (mine !== epoch || !want) { try { dev.gatt.disconnect(); } catch { /* gone */ } return; }
    characteristic = ch;
    attempt = 0; droppedAt = 0; valueAt = Date.now();
    stopWatch();
    setStatus('connected');
  } catch (e) {
    if (mine !== epoch || !want) return;
    try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch { /* gone */ }
    characteristic = null;
    // The browser wants a tap before it will reach this sensor again.
    if (e?.name === 'SecurityError' || e?.name === 'NotAllowedError') { stopWatch(); retryAt = 0; setStatus('tap'); return; }
    busy = false;
    schedule();
  } finally { if (mine === epoch) busy = false; }
}

/** The remembered sensor among the ones this browser may reach without asking. */
async function permitted() {
  const b = bt();
  if (!b || typeof b.getDevices !== 'function' || !saved) return null;
  try {
    const list = await b.getDevices();
    return list.find((d) => d.id === saved.id) || null;
  } catch { return null; }
}

/** On load: get the remembered sensor back without a tap, if the browser lets us. */
async function resume() {
  if (!active || !state.ble.supported || !want || !saved || device) return;
  const dev = await permitted();
  if (!active || !want || device) return;
  if (!dev) { setStatus('tap'); return; }
  adopt(dev);
  attempt = 0; droppedAt = Date.now();
  setStatus('reconnecting');
  // Chrome only connects to a device it has just seen advertising: watch
  // for it, and connect the moment it shows up. The ordinary retry loop
  // runs beside it for browsers that connect directly.
  if (typeof dev.watchAdvertisements === 'function') {
    const ac = new AbortController();
    const seen = () => { if (device !== dev || characteristic || busy) return; attempt = 0; retryAt = 0; link(); };
    dev.addEventListener('advertisementreceived', seen);
    watchStop = () => { dev.removeEventListener('advertisementreceived', seen); ac.abort(); };
    try { await dev.watchAdvertisements({ signal: ac.signal }); } catch { /* not allowed here: the retry loop is enough */ }
  }
  if (!busy && !characteristic) link();
}

/** Something changed that makes now a good moment to try again. */
function kick() {
  if (!active) return;
  wakeSync();
  flush();
  if (!want || !state.ble.supported) return;
  if (!device) { resume(); return; }
  if (characteristic && device.gatt?.connected) return;
  if (state.ble.status === 'tap' || busy) return;
  attempt = 0; retryAt = 0;
  link();
}

/**
 * Connect a sensor. Must be called from a tap. Goes straight to the
 * remembered sensor when the browser still allows it; otherwise (or with
 * `choose`) the browser's own chooser opens. Resolves to false when the
 * person closed the chooser.
 */
export async function connect({ choose = false } = {}) {
  const b = bt();
  if (!b) throw new Error('This browser cannot use Bluetooth.');
  let dev = choose ? null : (device || await permitted());
  if (!dev) {
    try {
      dev = await b.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    } catch (e) {
      if (e?.name === 'NotFoundError' || e?.name === 'AbortError') return false;   // the chooser was closed
      throw e;
    }
  }
  epoch += 1; busy = false;
  stopWatch();
  want = true; store.write(KEY.want, '1');
  adopt(dev);
  attempt = 0; retryAt = 0; droppedAt = 0;
  setStatus('connecting');
  await link();
  return true;
}

/** Stop, and stop trying. The sensor stays remembered, so Connect is one tap. */
export function disconnect() {
  want = false; store.write(KEY.want, null);
  epoch += 1; busy = false; retryAt = 0; attempt = 0; droppedAt = 0;
  stopWatch();
  if (state.local || localFresh()) { lastQueued = null; enqueue(Date.now(), 0); flush(); }
  localAt = 0;
  if (state.local) clear({ trace: true });
  if (characteristic) characteristic.removeEventListener('characteristicvaluechanged', onValue);
  characteristic = null;
  try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch { /* already gone */ }
  setStatus('off');
}

/* ── keeping the screen awake ───────────────────────────────── */

let sentinel = null;
let locking = false;

async function wakeSync() {
  const w = state.wake;
  if (!w.supported || typeof document === 'undefined') return;
  const should = active && w.on && document.visibilityState === 'visible' && (state.bpm !== null || (want && state.ble.status !== 'off'));
  if (should && !sentinel && !locking) {
    locking = true;
    try {
      const s = await navigator.wakeLock.request('screen');
      sentinel = s;
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null; if (w.held) { w.held = false; notify(); } });
      if (!w.held) { w.held = true; notify(); }
    } catch { /* battery saver, or the tab is not visible */ } finally { locking = false; }
  } else if (!should && sentinel) {
    const s = sentinel; sentinel = null;
    try { await s.release(); } catch { /* already released */ }
  }
}

/** The "Keep screen awake while live" switch. */
export function setAwake(on) {
  state.wake.on = Boolean(on);
  store.write(KEY.awake, on ? '1' : null);
  notify();
  wakeSync();
}

/* ── the clock ──────────────────────────────────────────────── */

function beat() {
  const now = Date.now();
  // The end of a reading whose "it ended" never arrived.
  if (state.bpm !== null && now - takenAt > TTL_MS) clear();
  if (queue.length && now - postedAt >= POST_GAP_MS) flush();
  if (!want || !device) return;
  if (state.ble.status === 'connected' && now - valueAt > STALL_MS) {
    // It says connected and delivers nothing: make the connection again.
    try { device.gatt.disconnect(); } catch { /* gone */ }
    if (characteristic) onDrop();
  }
  if (state.ble.status === 'reconnecting' && droppedAt && now - droppedAt >= AWAY_MS) setStatus('away');
  if (retryAt && now >= retryAt && !busy) link();
}

/* ── start and stop (main.js) ───────────────────────────────── */

let wired = false;

/** Called once somebody is signed in. Safe to call again. */
export function start() {
  if (active) return;
  active = true;
  state.ble.supported = Boolean(bt());
  state.wake.supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  state.wake.on = store.read(KEY.awake) === '1';
  try { saved = JSON.parse(store.read(KEY.device) || 'null'); } catch { saved = null; }
  if (!saved || typeof saved.id !== 'string') saved = null;
  want = state.ble.supported && Boolean(saved) && store.read(KEY.want) === '1';
  state.ble.name = saved?.name || null;
  state.ble.remembered = Boolean(saved);
  if (!wired) {
    wired = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); else wakeSync(); });
    window.addEventListener('online', kick);
    window.addEventListener('pageshow', (e) => { if (e.persisted) { kick(); refresh(); } });
  }
  beatTimer = setInterval(beat, 1000);
  notify();
  refresh();
  resume();
}

/** Signed out: drop the connection and the readings; the choices stay for next time. */
export function stop() {
  if (!active) return;
  active = false;
  clearInterval(beatTimer); beatTimer = null;
  epoch += 1; busy = false; retryAt = 0;
  stopWatch();
  queue = []; lastQueued = null;
  if (characteristic) characteristic.removeEventListener('characteristicvaluechanged', onValue);
  characteristic = null;
  const dev = device;
  if (dev) dev.removeEventListener('gattserverdisconnected', onDrop);
  device = null;
  try { if (dev?.gatt?.connected) dev.gatt.disconnect(); } catch { /* gone */ }
  localAt = 0;
  state.bpm = null; state.t = null; state.source = null; state.local = false; state.recent = [];
  state.ble.status = 'off';
  wakeSync();
  notify();
}
