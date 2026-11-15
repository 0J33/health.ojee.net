/* Vibrations for cues while recording (intervals.js: push, rest): felt on the heart-rate sensor
   when it can vibrate, otherwise on this phone, otherwise heard as a tone. What can vibrate is
   found out, not assumed:

   - The sensor: a band or watch connected for live heart rate (live.js) vibrates when it has
     Bluetooth's Immediate Alert service; its level is set high for each buzz, then off. A chest
     strap has nothing to vibrate, and Fitbit and Pixel watches do not let other apps make them
     vibrate, so for those it is the phone.
   - The phone: the rep. app's Haptics (the phone's own vibration, also with the screen off), or a
     browser's navigator.vibrate on an Android phone (while the page is on screen). Safari on an
     iPhone and computers have none.

   A pattern is on and off times in milliseconds, as navigator.vibrate takes them. */

import * as live from './live.js';

export const PATTERNS = [
  ['long3', 'Three long', [500, 220, 500, 220, 500]],
  ['long1', 'One long', [1100]],
  ['short2', 'Two short', [160, 140, 160]],
  ['quick4', 'Four quick', [90, 90, 90, 90, 90, 90, 90]],
  ['heart', 'Heartbeat', [130, 110, 380]],
  ['rise', 'Rising', [100, 180, 260, 180, 600]],
];
export const patternOf = (id) => (PATTERNS.find((p) => p[0] === id) || PATTERNS[0])[2];

const cap = () => (typeof window !== 'undefined' ? window.Capacitor : null);
const haptics = () => (cap()?.isNativePlatform?.() === true && cap()?.isPluginAvailable?.('Haptics') ? cap().Plugins.Haptics : null);
const iOSWeb = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent || '') && !cap()?.isNativePlatform?.();

/** Can this phone vibrate? { can, why (when not), screen (true when only while on screen) }. */
export function phoneCan() {
  if (typeof window === 'undefined') return { can: false, why: 'Nothing here can vibrate.' };
  if (haptics()) return { can: true };
  if (cap()?.isNativePlatform?.() === true) return { can: false, why: 'This version of the rep. app cannot vibrate the phone. Update the app to get it.' };
  if (iOSWeb()) return { can: false, why: 'Safari on an iPhone cannot vibrate. The rep. app can.' };
  if (typeof navigator.vibrate !== 'function') return { can: false, why: 'This browser cannot vibrate.' };
  if (!window.matchMedia?.('(pointer: coarse)').matches) return { can: false, why: 'A computer has nothing to vibrate.' };
  return { can: true, screen: true };
}

/** Can the connected sensor vibrate? { state: 'yes' | 'no' | 'off' | 'none', name, why }. */
export function sensorCan(s = live.get()) {
  const b = s.ble;
  const name = b.name || 'Your heart-rate sensor';
  if (!b.supported) return { state: 'none', name: null, why: 'No Bluetooth here to connect a sensor.' };
  if (b.status !== 'connected') return { state: 'off', name: b.remembered ? name : null, why: b.remembered ? `${name} is not connected.` : 'No heart-rate sensor connected.' };
  if (b.alert) return { state: 'yes', name };
  return { state: 'no', name, why: `${name} cannot be made to vibrate by an app.` };
}

/** Where a cue goes for `want` ('sensor' | 'phone' | 'both'), from what can vibrate now:
    { sensor, phone } booleans, and tone when neither can. */
export function route(want, sOk = sensorCan().state === 'yes', pOk = phoneCan().can) {
  let sensor = false; let phone = false;
  if (want === 'both') { sensor = sOk; phone = pOk; } else if (want === 'phone') { phone = pOk; sensor = !pOk && sOk; } else { sensor = sOk; phone = !sOk && pOk; }
  return { sensor, phone, tone: !sensor && !phone };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function onSensor(ms) {
  for (let i = 0; i < ms.length; i += 2) {
    if (!(await live.sensorAlert(2))) return false;
    await wait(ms[i]);
    await live.sensorAlert(0);
    if (ms[i + 1]) await wait(ms[i + 1]);
  }
  return true;
}

/* An iPhone has one length of vibration (about 0.4 s) whatever is asked: there a long buzz is that
   vibration and a short one a strong tap, each given room to be felt apart, so "Three long" and
   "Two short" still feel different. Android vibrates for the time asked. */
const ios = () => cap()?.getPlatform?.() === 'ios';
async function onPhone(ms) {
  const H = haptics();
  if (!H) { try { return navigator.vibrate(ms) !== false; } catch { return false; } }
  for (let i = 0; i < ms.length; i += 2) {
    const on = ms[i]; const off = ms[i + 1] || 0;
    try {
      if (!ios()) await H.vibrate({ duration: on });
      else if (on >= 350) await H.vibrate();
      else await H.impact({ style: 'HEAVY' });
    } catch { return false; }
    await wait(ios() ? Math.max(on >= 350 ? 450 : 90, on) + Math.max(off, on >= 350 ? 200 : 140) : on + off);
  }
  return true;
}

let audio = null;
function onTone(ms, high) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
    let t = audio.currentTime + 0.02;
    for (let i = 0; i < ms.length; i += 2) {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.frequency.value = high ? 880 : 587;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
      const end = t + Math.min(ms[i], 600) / 1000;
      g.gain.setValueAtTime(0.25, end - 0.03); g.gain.exponentialRampToValueAtTime(0.0001, end);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(end + 0.02);
      t = end + (ms[i + 1] || 0) / 1000;
    }
    return true;
  } catch { return false; }
}

/**
 * Play pattern `id` where `want` says, falling back as route() does. `high` picks the tone's
 * pitch when it comes to a tone (push high, rest low). Resolves to what it was felt or heard on:
 * { sensor, phone, tone } booleans.
 */
export async function play(id, want = 'sensor', { high = true } = {}) {
  const ms = patternOf(id);
  const r = route(want);
  const [s, p] = await Promise.all([r.sensor ? onSensor(ms) : false, r.phone ? onPhone(ms) : false]);
  // The sensor dropped mid-way, or the phone said no: the phone then, or a tone.
  let phone = p;
  if (r.sensor && !s && !r.phone && phoneCan().can) phone = await onPhone(ms);
  const tone = !s && !phone ? onTone(ms, high) : false;
  return { sensor: s, phone, tone };
}

/** What a cue was felt on, in words: "on Polar H10", "on this phone", "as a tone". */
export function feltOn(r, name = 'the sensor') {
  if (!r) return '';
  if (r.sensor && r.phone) return `on ${name} and this phone`;
  if (r.sensor) return `on ${name}`;
  if (r.phone) return 'on this phone';
  if (r.tone) return 'as a tone (nothing here can vibrate)';
  return 'nowhere: nothing could vibrate or play a tone';
}
