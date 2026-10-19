/* Shared state and navigation. Views import from here, main.js drives it. */

import { api } from './api.js';
import { setPrefs } from './format.js';

export const app = {
  /** The /api/me payload. `user: null` when signed out. */
  me: { user: null },
  loaded: false,
  online: navigator.onLine,
  syncing: false,
};

const meListeners = new Set();
export function setMe(me) {
  if (!me || typeof me !== 'object') return app.me;
  app.me = me;
  app.loaded = true;
  if (me.profile) setPrefs({ tz: me.profile.tz, units: me.units });
  if (me.sync) app.syncing = Boolean(me.sync.running);
  meListeners.forEach((fn) => fn(me));
  return me;
}
export async function refreshMe() { return setMe(await api.get('/api/me')); }
export const onMe = (fn) => { meListeners.add(fn); return () => meListeners.delete(fn); };

export const signedIn = () => Boolean(app.me?.user);
export const hasProfile = () => Boolean(app.me?.user && app.me?.profile);
export const cap = (name) => Boolean(app.me?.caps?.[name]);
/** "Your device does not report HRV", from the server's own list. */
export function capText(name, fallback) {
  const hit = app.me?.capsMeta?.missing?.find((m) => m.cap === name);
  return hit?.text || fallback || 'Your device does not report this.';
}

/* Navigation is installed by main.js. */
let navigate = (path) => { location.href = path; };
export const setNavigator = (fn) => { navigate = fn; };
/** go('/workouts/12') · go('/ranks?metric=steps', { replace: true }) */
export const go = (path, opts) => navigate(path, opts);

/* Live changes from the server (SSE), fanned out to whichever view is open. */
const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export function listen(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

export const ONBOARDING = ['profile', 'google', 'install', 'notifications', 'privacy'];
