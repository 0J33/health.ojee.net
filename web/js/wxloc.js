/* ============================================================
   health.ojee.net — where Today's weather is for (server/weather.js).

   Settings (Me, Today) picks one of:
     here  where this phone is, when location is allowed (the default)
     city  the city in the profile, or the time zone's
     off   no weather on Today
   "here" asks the browser once on its own; after that it only reads the
   position when location is allowed, and falls back to the city when it
   is not. The position goes to the server rounded to two places (about a
   kilometre) and is never stored there.
   ============================================================ */

const MODE = 'health.weather';
const ASKED = 'health.wxasked';
const LAST = 'health.wxpt';
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
const r2 = (x) => Math.round(x * 100) / 100;

/** 'here' | 'city' | 'off'; the old 'on' is 'here'. */
export function weatherMode() {
  const v = get(MODE);
  return v === 'off' || v === 'city' ? v : 'here';
}
export function setWeatherMode(v) { set(MODE, v); if (v !== 'here') set(LAST, null); }

async function permission() {
  try { return (await navigator.permissions?.query?.({ name: 'geolocation' }))?.state || 'unknown'; } catch { return 'unknown'; }
}
const lastPoint = () => { try { const p = JSON.parse(get(LAST) || 'null'); return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null; } catch { return null; } };

/** The phone's position for the weather, rounded, or null for the city.
    `ask`: may show the browser's question (Settings, or Today's first time). */
export async function weatherPoint({ ask = false } = {}) {
  if (weatherMode() !== 'here' || !navigator.geolocation) return null;
  const state = await permission();
  if (state === 'denied') { set(LAST, null); return null; }
  const firstTime = !get(ASKED);
  if (state !== 'granted' && !ask && !firstTime) return lastPoint();
  set(ASKED, '1');
  return new Promise((resolve) => {
    const give = setTimeout(() => resolve(lastPoint()), 10_000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(give);
        const p = { lat: r2(pos.coords.latitude), lon: r2(pos.coords.longitude) };
        set(LAST, JSON.stringify(p));
        resolve(p);
      },
      (err) => { clearTimeout(give); if (err?.code === 1) set(LAST, null); resolve(err?.code === 1 ? null : lastPoint()); },
      { enableHighAccuracy: false, timeout: 9_000, maximumAge: 15 * 60_000 },
    );
  });
}

/** The query for GET /api/weather. */
export const weatherQuery = (p) => (p ? `?lat=${p.lat}&lon=${p.lon}` : '');
