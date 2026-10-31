/* Live heart rate: one store, two ways in.

   - This device reads a sensor itself (the standard Bluetooth Heart Rate
     Service) and posts what it reads to /api/live/hr, so the person's
     other devices see it too. In a browser that is Web Bluetooth; in the
     Health app on an iPhone it is the phone's own Bluetooth, reached
     through the app. Both sit behind one small interface (a transport),
     and everything else here is shared.
   - Another of the person's devices (the Ojee Pulse overlay) posts, and
     the reading arrives here as the `live` event on /api/events.

   Either way the screens read the same store: subscribe(), get().

   The Bluetooth side is built to stay connected. It lives here, outside
   any screen, so moving around the app does not touch it. Once a sensor
   has been connected it is remembered, and on every later load the app
   tries to get it back without a tap where the platform allows that
   (getDevices, then watchAdvertisements in a browser). While the app is open it never
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
    /** True in the Health app on a phone, where the phone's own Bluetooth is used. */
    native: false,
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

/* ── two ways to reach a sensor ─────────────────────────────── */

/* Everything from here down to "the connection" is a transport: the thin
   layer that talks to one kind of Bluetooth. There are two, with the same
   shape, and the rest of this file does not know which one it has:

     kind                 'web' | 'native'
     patient              true when open() itself waits for the sensor to
                          come into range, however long that takes
     permitted(saved)     the remembered sensor, if it can be reached
                          without asking the person; otherwise null
     request()            let the person pick a sensor; null when they close
                          the chooser
     open(h, { value, drop })
                          connect and start the heart-rate notifications.
                          value(DataView) for every one; drop() when the
                          connection is lost. Rejects with a NotAllowedError
                          when only a tap can fix it
     close(h)             disconnect, quietly
     connected(h)         whether the connection is up right now
     forget(h)            stop listening to this sensor altogether
     watch(h, seen)       where the platform can: call seen() when the
                          sensor is seen advertising. { stop, ready } or null

   A sensor is a handle: { id, name } plus whatever the transport keeps. */

const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const PATIENT_MS = 6 * 3600_000;     // how long the phone itself is asked to wait for the sensor

const named = (message, name) => Object.assign(new Error(message), { name });

const timeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(named(`${what} timed out`, 'TimeoutError')), ms);
  promise.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
});

/** Web Bluetooth: Chrome and Edge, on Android and on a computer. */
function webTransport(b) {
  const hooks = new WeakMap();   // BluetoothDevice → { drop, value, ch }
  const hook = (dev) => { let k = hooks.get(dev); if (!k) { k = { drop: null, value: null, ch: null }; hooks.set(dev, k); } return k; };
  const wrap = (dev) => ({ id: dev.id, name: dev.name || null, raw: dev });
  const unhook = (dev) => {
    const k = hooks.get(dev);
    if (!k) return;
    if (k.drop) dev.removeEventListener('gattserverdisconnected', k.drop);
    if (k.ch && k.value) k.ch.removeEventListener('characteristicvaluechanged', k.value);
    k.drop = null; k.value = null; k.ch = null;
  };
  return {
    kind: 'web',
    patient: false,
    async permitted(saved) {
      if (typeof b.getDevices !== 'function') return null;
      const dev = (await b.getDevices()).find((d) => d.id === saved.id);
      return dev ? wrap(dev) : null;
    },
    async request() {
      try {
        return wrap(await b.requestDevice({ filters: [{ services: ['heart_rate'] }] }));
      } catch (e) {
        if (e?.name === 'NotFoundError' || e?.name === 'AbortError') return null;   // the chooser was closed
        throw e;
      }
    },
    async open(h, { value, drop }) {
      const dev = h.raw;
      const k = hook(dev);
      if (k.drop) dev.removeEventListener('gattserverdisconnected', k.drop);
      k.drop = () => drop();
      dev.addEventListener('gattserverdisconnected', k.drop);
      const server = await timeout(dev.gatt.connect(), CONNECT_TIMEOUT_MS, 'Connecting');
      const service = await timeout(server.getPrimaryService('heart_rate'), 10_000, 'Reading the sensor');
      const ch = await timeout(service.getCharacteristic('heart_rate_measurement'), 10_000, 'Reading the sensor');
      if (k.ch && k.value) k.ch.removeEventListener('characteristicvaluechanged', k.value);
      k.value = (e) => value(e.target?.value);
      k.ch = ch;
      ch.addEventListener('characteristicvaluechanged', k.value);
      await timeout(ch.startNotifications(), 10_000, 'Reading the sensor');
    },
    close(h) { try { if (h.raw.gatt?.connected) h.raw.gatt.disconnect(); } catch { /* already gone */ } },
    connected: (h) => Boolean(h.raw.gatt?.connected),
    forget(h) { unhook(h.raw); },
    watch(h, seen) {
      // Chrome only connects to a device it has just seen advertising.
      const dev = h.raw;
      if (typeof dev.watchAdvertisements !== 'function') return null;
      const ac = new AbortController();
      dev.addEventListener('advertisementreceived', seen);
      return {
        stop() { dev.removeEventListener('advertisementreceived', seen); ac.abort(); },
        ready: dev.watchAdvertisements({ signal: ac.signal }).catch(() => { /* not allowed here: the retry loop is enough */ }),
      };
    },
  };
}

/** The bytes of a hex string ("16 4a", "164a") as a DataView, or null. */
export function hexToDataView(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.replace(/[^0-9a-f]/gi, '');
  if (!s.length || s.length % 2) return null;
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(s.substr(i * 2, 2), 16);
  return new DataView(bytes.buffer);
}

/**
 * The Health app on a phone: CoreBluetooth, through the Capacitor plugin
 * @capacitor-community/bluetooth-le. The app shows this very site, so the
 * plugin's own JavaScript is not here; `P` is the raw object the app puts
 * at window.Capacitor.Plugins.BluetoothLe. Its shapes, as its source has
 * them: every call takes one options object and returns a promise;
 * addListener(event, fn) hands back { remove() }; a value arrives as a hex
 * string in { value }; events are named "disconnected|<id>" and
 * "notification|<id>|<service>|<characteristic>".
 *
 * `wake` is called when Bluetooth is switched back on.
 */
function nativeTransport(P, { wake } = {}) {
  const hooks = new Map();       // device id → { value, drop, up, subs }
  const known = new Set();       // ids the plugin holds a peripheral for, in this run of the app
  const hook = (id) => { let k = hooks.get(id); if (!k) { k = { value: null, drop: null, up: false, subs: [] }; hooks.set(id, k); } return k; };
  const unsub = async (k) => { for (const sub of k.subs.splice(0)) { try { await sub?.remove?.(); } catch { /* already removed */ } } };
  const denied = (e) => (/permission|unauthori/i.test(e?.message || '') ? named(e.message, 'NotAllowedError') : e);

  function power(on) {
    if (on) { wake?.(); return; }
    for (const k of hooks.values()) if (k.up) { k.up = false; k.drop?.(); }
  }

  let ready = null;
  /** Once per run of the app. The first call ever is what makes iOS ask for Bluetooth. */
  const init = () => {
    if (!ready) {
      ready = (async () => {
        // A reloaded page leaves its listeners behind in the app.
        try { await P.removeAllListeners(); } catch { /* nothing to remove */ }
        // Android: finding a sensor does not need the phone's location (the app's manifest says so too).
        try { await P.initialize({ androidNeverForLocation: true }); } catch (e) { throw denied(e); }
        try {
          await P.addListener('onEnabledChanged', (r) => power(r?.value === true));
          await P.startEnabledNotifications();
        } catch { /* it still works; it only notices Bluetooth coming back a little later */ }
      })();
      ready.catch(() => { ready = null; });
    }
    return ready;
  };
  const powered = async () => {
    const r = await P.isEnabled();
    if (r?.value !== true) throw named('Bluetooth is off', 'BluetoothOffError');
  };

  const self = {
    kind: 'native',
    patient: true,
    async permitted(saved) {
      await init();
      // The phone knows a sensor it has met by its id, connected or not.
      const r = await P.getDevices({ deviceIds: [saved.id] });
      const d = (r?.devices || []).find((x) => x.deviceId === saved.id);
      if (!d) return null;
      known.add(d.deviceId);
      return { id: d.deviceId, name: d.name || saved.name || null };
    },
    async request() {
      await init();
      await powered();
      // A sensor the phone is already connected to (a Fitbit kept connected
      // by the Google Health app) does not advertise, so a scan never finds
      // it; the phone hands it over directly instead.
      try {
        const r = await P.getConnectedDevices({ services: [HR_SERVICE] });
        const c = (r?.devices || [])[0];
        if (c) { known.add(c.deviceId); return { id: c.deviceId, name: c.name || null }; }
      } catch { /* an older app: scan as before */ }
      let d;
      try {
        d = await P.requestDevice({ services: [HR_SERVICE] });
      } catch (e) {
        if (/cancel/i.test(e?.message || '')) return null;   // the chooser was closed
        throw e;
      }
      known.add(d.deviceId);
      return { id: d.deviceId, name: d.name || null };
    },
    async open(h, { value, drop }) {
      await init();
      await powered();
      if (!known.has(h.id) && !(await self.permitted(h))) throw named('The phone no longer knows this sensor', 'NotAllowedError');
      const k = hook(h.id);
      k.value = value; k.drop = drop; k.up = false;
      await unsub(k);
      // Left connected by a page that was reloaded: start clean, or the
      // connect below would wait for a connection that already exists.
      try { await P.disconnect({ deviceId: h.id }); } catch { /* it was not connected */ }
      k.subs.push(await P.addListener(`disconnected|${h.id}`, () => { if (!k.up) return; k.up = false; k.drop?.(); }));
      // The phone waits for the sensor by itself, also while the app is in
      // the background, so one long attempt beats many short ones.
      await P.connect({ deviceId: h.id, timeout: PATIENT_MS });
      const on = (e) => { const dv = hexToDataView(e?.value); if (dv) k.value?.(dv); };
      k.subs.push(await P.addListener(`notification|${h.id}|${HR_SERVICE}|${HR_MEASUREMENT}`, on));
      await P.startNotifications({ deviceId: h.id, service: HR_SERVICE, characteristic: HR_MEASUREMENT, timeout: 10_000 });
      k.up = true;
    },
    close(h) {
      const k = hooks.get(h.id);
      if (k) k.up = false;
      try { Promise.resolve(P.disconnect({ deviceId: h.id })).catch(() => { /* it was not connected */ }); } catch { /* the app is going away */ }
    },
    connected: (h) => hooks.get(h.id)?.up === true,
    forget(h) { const k = hooks.get(h.id); if (k) { k.up = false; hooks.delete(h.id); unsub(k); } },
    watch: () => null,
  };
  return self;
}

function pickTransport() {
  if (typeof window === 'undefined') return null;
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.() === true) {
    const P = cap.Plugins?.BluetoothLe;
    return P ? nativeTransport(P, { wake: () => kick() }) : null;
  }
  const b = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined;
  return b ? webTransport(b) : null;
}

/* ── the connection ─────────────────────────────────────────── */

let transport = null;
let want = false;         // the person's intent to stay connected; only Disconnect clears it
let saved = null;         // { id, name } of the remembered sensor
let device = null;        // the sensor in use: a transport's handle
let linked = false;       // its notifications are flowing
let busy = false;         // a connection attempt is in flight
let busyAt = 0;           // when it started
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

function onValue(dv) {
  if (!active || !want) return;
  const v = parseHeartRate(dv);
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
  linked = false;
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

function adopt(h) {
  if (device && device.id !== h.id) { transport.forget(device); transport.close(device); }
  device = h;
  saved = { id: h.id, name: h.name || 'Heart-rate sensor' };
  store.write(KEY.device, JSON.stringify(saved));
}

function stopWatch() {
  const stop = watchStop;
  watchStop = null;
  if (stop) { try { stop(); } catch { /* not watching */ } }
}

/**
 * Tell the server this device is about to take the sensor, so a relay at
 * home that holds it (relay/hr-relay.py) lets go first. Also teaches the
 * relay the sensor's name, so it only ever takes sensors used here.
 * Resolves true when a relay was holding it (then the caller waits a beat).
 */
let claimedAt = 0;
async function claim(name) {
  if (Date.now() - claimedAt < 8000) return false;
  claimedAt = Date.now();
  try {
    const res = await fetch('/api/live/claim', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ name: name || '' }) });
    return res.ok ? !!(await res.json()).relayHeld : false;
  } catch { return false; }
}

/** One attempt to connect to `device` and start its notifications. */
async function link() {
  if (busy || !device || !want) return;
  busy = true; busyAt = Date.now(); retryAt = 0;
  const mine = epoch += 1;
  const dev = device;
  try {
    if (await claim(dev.name)) await new Promise((r) => setTimeout(r, 1800));   // the relay lets go
    if (mine !== epoch || !want) return;
    await transport.open(dev, { value: onValue, drop: onDrop });
    if (mine !== epoch || !want) { transport.close(dev); return; }
    linked = true;
    attempt = 0; droppedAt = 0; valueAt = Date.now();
    stopWatch();
    setStatus('connected');
  } catch (e) {
    if (mine !== epoch || !want) return;
    transport.close(dev);
    linked = false;
    // Only a tap can reach this sensor again.
    if (e?.name === 'SecurityError' || e?.name === 'NotAllowedError') { stopWatch(); retryAt = 0; setStatus('tap'); return; }
    busy = false;
    schedule();
  } finally { if (mine === epoch) busy = false; }
}

/** The remembered sensor, if it can be reached without asking. */
async function permitted() {
  if (!transport || !saved) return null;
  try { return await transport.permitted(saved); } catch { return null; }
}

/** On load: get the remembered sensor back without a tap, if the platform lets us. */
async function resume() {
  if (!active || !state.ble.supported || !want || !saved || device) return;
  const dev = await permitted();
  if (!active || !want || device) return;
  if (!dev) { setStatus('tap'); return; }
  adopt(dev);
  attempt = 0; droppedAt = Date.now();
  setStatus('reconnecting');
  // Where the sensor can be watched for, connect the moment it shows up.
  // The ordinary retry loop runs beside it.
  const w = transport.watch(dev, () => { if (device !== dev || linked || busy) return; attempt = 0; retryAt = 0; link(); });
  if (w) { watchStop = w.stop; await w.ready; }
  if (!busy && !linked) link();
}

/** Something changed that makes now a good moment to try again. */
function kick() {
  if (!active) return;
  wakeSync();
  flush();
  if (!want || !state.ble.supported) return;
  if (!device) { resume(); return; }
  if (linked && transport.connected(device)) return;
  if (state.ble.status === 'tap') return;
  if (busy) {
    // A patient attempt may be one the phone has quietly let go of (Bluetooth
    // was switched off and on, say): after a few seconds, make it afresh.
    if (!transport.patient || Date.now() - busyAt < 5000) return;
    epoch += 1; busy = false;
  }
  attempt = 0; retryAt = 0;
  link();
}

/**
 * Connect a sensor. Must be called from a tap. Goes straight to the
 * remembered sensor when it can still be reached; otherwise (or with
 * `choose`) the platform's own chooser opens. Resolves to false when the
 * person closed the chooser.
 */
export async function connect({ choose = false } = {}) {
  if (!transport) throw new Error('This browser cannot use Bluetooth.');
  let dev = choose ? null : (device || await permitted());
  if (!dev) {
    dev = await transport.request();
    if (!dev) return false;
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
  linked = false;
  if (device) transport.close(device);
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
    transport.close(device);
    if (linked) onDrop();
  }
  // A patient attempt does not end by itself, so the words must move on.
  if (busy && transport.patient && state.ble.status === 'connecting' && now - busyAt >= CONNECT_TIMEOUT_MS) {
    if (!droppedAt) droppedAt = busyAt;
    setStatus('away');
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
  transport = pickTransport();
  state.ble.supported = Boolean(transport);
  state.ble.native = transport?.kind === 'native';
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
  linked = false;
  const dev = device;
  device = null;
  if (dev && transport) { transport.forget(dev); transport.close(dev); }
  localAt = 0;
  state.bpm = null; state.t = null; state.source = null; state.local = false; state.recent = [];
  state.ble.status = 'off';
  wakeSync();
  notify();
}
