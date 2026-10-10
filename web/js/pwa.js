/* Everything installable: the service worker and its update prompt, the
   Add to Home Screen state, and Web Push for this browser. */

import { api } from './api.js';

/* ── platform ───────────────────────────────────────────────── */

const ua = navigator.userAgent || '';
export const platform = {
  ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  android: /Android/.test(ua),
  get safari() { return this.ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua); },
  get standalone() {
    return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
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
  /** 'installed' | 'prompt' (Android/desktop one-tap) | 'ios' (share-sheet steps) | 'ios-other' | 'manual' */
  state() {
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
   * 'unsupported' | 'needs-install' (iOS outside the Home Screen app) |
   * 'denied' | 'default' | 'granted'
   */
  support() {
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
