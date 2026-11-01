/* Everything installable: the service worker and its update prompt, the
   Add to Home Screen state, and Web Push for this browser.

   The same site also runs inside the Health app on an iPhone (a native
   shell around this page, see `platform.native`). There the phone's own
   Bluetooth is available, and three things a browser has are not: a
   service worker, Web Push, and a way to sign in to Google. */

import { api } from './api.js';

/* ── platform ───────────────────────────────────────────────── */

const ua = navigator.userAgent || '';
const cap = () => window.Capacitor;
export const platform = {
  /** True inside the Health app, false in every browser and Home Screen web app. */
  get native() { return cap()?.isNativePlatform?.() === true; },
  ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  android: /Android/.test(ua),
  get safari() { return this.ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua); },
  get standalone() {
    return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  },
};

/* ── handing notifications to the Health iPhone app ─────────── */

/* Notifications can only come from the Home Screen web app on an iPhone,
   but live heart rate needs the Health iPhone app. With this switched on,
   a tapped notification opens its page in the app (ojeehealth://open/<path>,
   registered by the app), and the app opens that page itself. Per device. */
const SCHEME = 'ojeehealth://open';
const HANDOFF_KEY = 'health.handoff';
const safePath = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : null);
export const handoff = {
  /** Only where it can work: the Home Screen web app on an iPhone or iPad. */
  get possible() { return platform.ios && platform.standalone && !platform.native; },
  get on() { try { return localStorage.getItem(HANDOFF_KEY) === '1'; } catch { return false; } },
  set(on) { try { if (on) localStorage.setItem(HANDOFF_KEY, '1'); else localStorage.removeItem(HANDOFF_KEY); } catch { /* storage off: stays off */ } },
  /** A tapped notification's page: true when it went to the app instead. */
  open(path) {
    const p = safePath(path);
    if (!p || !this.possible || !this.on) return false;
    location.href = SCHEME + p;
    return true;
  },
  /** In the app: the page an incoming ojeehealth:// link asks for, or null. */
  pathOf(url) {
    if (typeof url !== 'string' || !url.startsWith(SCHEME)) return null;
    return safePath(url.slice(SCHEME.length) || '/');
  },
};

export function deviceLabel() {
  if (platform.ios) return /iPad/.test(ua) || navigator.platform === 'MacIntel' ? 'iPad' : 'iPhone';
  if (platform.android) return 'Android phone';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'This browser';
}

/* ── install ────────────────────────────────────────────────── */

let deferredPrompt = null;
const installListeners = new Set();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installListeners.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  installListeners.forEach((fn) => fn());
});

export const install = {
  /** 'native' (the Health app) | 'installed' | 'prompt' (Android/desktop one-tap) | 'ios' (share-sheet steps) | 'ios-other' | 'manual' */
  state() {
    if (platform.native) return 'native';
    if (platform.standalone) return 'installed';
    if (deferredPrompt) return 'prompt';
    if (platform.ios) return platform.safari ? 'ios' : 'ios-other';
    return 'manual';
  },
  async prompt() {
    if (!deferredPrompt) return 'unavailable';
    const p = deferredPrompt;
    deferredPrompt = null;
    p.prompt();
    const { outcome } = await p.userChoice;
    installListeners.forEach((fn) => fn());
    return outcome;   // 'accepted' | 'dismissed'
  },
  onChange(fn) { installListeners.add(fn); return () => installListeners.delete(fn); },
};

/* ── service worker and updates ─────────────────────────────── */

let registration = null;
let onUpdate = null;
let reloading = false;

export async function registerWorker({ updateReady } = {}) {
  onUpdate = updateReady;
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
  const watch = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // "installed" with a controller already in charge means a newer version is waiting.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onUpdate?.();
    });
  };
  if (registration.waiting && navigator.serviceWorker.controller) onUpdate?.();
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  // Look for a new version when the app comes back to the front.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration?.update().catch(() => {});
  });
  return registration;
}

/**
 * Open an address in the system browser. In the Health app a new window is
 * handed to Safari by the app; in a browser it is simply a new tab.
 */
export function openOutside(url) {
  const href = new URL(url, location.origin).href;
  // The Health app on a phone: the phone's own browser (the Browser plugin), when the app has it.
  const B = platform.native ? window.Capacitor?.Plugins?.Browser : null;
  if (B?.open) { B.open({ url: href }).catch(() => window.open(href, '_blank')); return true; }
  const w = window.open(href, '_blank');
  return w !== null || platform.native;
}

/** The phone's browser, by name where it is known: Safari on an iPhone, "your browser" on Android. */
export const browserName = () => (platform.android ? 'your browser' : 'Safari');
export const BrowserName = () => (platform.android ? 'Your browser' : 'Safari');

/** The build this page was loaded as (the first /api/me says it). */

/**
 * "Check for updates": asks the server which build it serves now and the
 * service worker to look for a new version. Resolves { state: 'ready' |
 * 'latest' | 'offline', build }.
 */
export async function checkForUpdate(loadedBuild = null) {
  let latest = null;
  try { latest = (await (await fetch('/api/health', { cache: 'no-store' })).json()).build || null; } catch { return { state: 'offline', build: loadedBuild }; }
  if (registration) {
    try { await registration.update(); } catch { /* the page still knows from the build */ }
    const w = registration.installing;
    if (w) {
      await new Promise((done) => {
        const t = setTimeout(done, 10_000);
        w.addEventListener('statechange', () => { if (['installed', 'activated', 'redundant'].includes(w.state)) { clearTimeout(t); done(); } });
      });
    }
  }
  const ready = !!(registration?.waiting && navigator.serviceWorker.controller) || (latest && loadedBuild && latest !== loadedBuild);
  return { state: ready ? 'ready' : 'latest', build: loadedBuild, latest };
}

/** Called by the "Update available" prompt. */
export function applyUpdate() {
  reloading = true;
  if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  else location.reload();
}

/* ── push ───────────────────────────────────────────────────── */

function b64ToBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const DEVICE_KEY = 'health.push.device';
const store = {
  get() { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } },
  set(id) { try { if (id) localStorage.setItem(DEVICE_KEY, id); else localStorage.removeItem(DEVICE_KEY); } catch { /* private mode */ } },
};

export const push = {
  /**
   * 'native' (the Health app: no Web Push there) | 'unsupported' |
   * 'needs-install' (iOS outside the Home Screen app) |
   * 'denied' | 'default' | 'granted'
   */
  support() {
    if (platform.native) return 'native';
    const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (platform.ios && !platform.standalone) return 'needs-install';
    if (!has) return 'unsupported';
    return Notification.permission;
  },
  deviceId: () => store.get(),

  async subscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    try {
      const reg = registration || await navigator.serviceWorker.getRegistration('/');
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch { return null; }
  },

  /** Ask permission, subscribe this browser, and register it. Returns the /api/push payload. */
  async enable(publicKey) {
    const state = this.support();
    if (state === 'native') throw new Error('Notifications come from the Home Screen web app for now, not from this app.');
    if (state === 'needs-install') throw new Error('On iPhone and iPad, notifications only work from the Home Screen app. Add Health to your Home Screen, open it from there, then turn this on.');
    if (state === 'unsupported') throw new Error('This browser cannot receive notifications.');
    if (state === 'denied') throw new Error('Notifications are blocked for this site. Allow them in your browser or system settings, then try again.');
    if (!publicKey) throw new Error('Notifications are not set up on the server yet.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications were blocked. You can allow them later in your browser settings.' : 'No permission was given, so nothing changed.');
    const reg = registration || await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      } catch {
        throw new Error('The browser could not set up notifications. Check that you are online, then try again.');
      }
    }
    const reply = await api.post('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    store.set(reply.deviceId || null);
    return reply;
  },

  /** Stop notifications on this browser. Returns the /api/push payload (or null). */
  async disable() {
    const sub = await this.subscription();
    const id = store.get();
    let reply = null;
    try {
      if (id) reply = await api.del(`/api/push/devices/${encodeURIComponent(id)}`);
      else if (sub) reply = await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    } finally {
      store.set(null);
      try { await sub?.unsubscribe(); } catch { /* already gone */ }
    }
    return reply;
  },

  /** The browser rotated its subscription, or we lost the device id: register again quietly. */
  async resync(publicKey) {
    if (this.support() !== 'granted' || !publicKey) return;
    const reg = registration || await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub && store.get()) {
      try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }); } catch { return; }
    }
    if (!sub) return;
    try {
      const reply = await api.post('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
      store.set(reply.deviceId || null);
    } catch { /* next time */ }
  },
};
