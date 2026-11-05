/* ============================================================
   health.ojee.net — the weather on Today: now, the day's high and low,
   the chance of rain and the UV, for the person's city, and one plain
   line when it matters for training (heat, cold, UV, rain, wind).

   From Open-Meteo (open-meteo.com): free, no key, no account. Only the
   city goes there: the one in the person's profile, or else the one in
   their time zone's name (Africa/Cairo is Cairo). Places are kept a
   month, forecasts half an hour, in memory.
   ============================================================ */

const UA = 'health.ojee.net/1.0 (+https://health.ojee.net)';
export const WEATHER_URLS = { geo: 'https://geocoding-api.open-meteo.com/v1/search', forecast: 'https://api.open-meteo.com/v1/forecast' };
const PLACE_TTL = 30 * 86_400_000;
const FORECAST_TTL = 30 * 60_000;
const fin = Number.isFinite;

/** WMO weather codes as words and an icon. */
export function conditionOf(code, day = true) {
  const c = Number(code);
  if (c === 0) return { text: day ? 'Clear' : 'Clear night', icon: day ? 'sun' : 'moon' };
  if (c === 1) return { text: 'Mostly clear', icon: day ? 'sun' : 'moon' };
  if (c === 2) return { text: 'Partly cloudy', icon: day ? 'cloud_sun' : 'cloud' };
  if (c === 3) return { text: 'Cloudy', icon: 'cloud' };
  if (c === 45 || c === 48) return { text: 'Fog', icon: 'cloud' };
  if (c >= 51 && c <= 57) return { text: 'Drizzle', icon: 'cloud_rain' };
  if (c >= 61 && c <= 67) return { text: c >= 65 ? 'Heavy rain' : 'Rain', icon: 'cloud_rain' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { text: 'Snow', icon: 'cloud_snow' };
  if (c >= 80 && c <= 82) return { text: 'Showers', icon: 'cloud_rain' };
  if (c >= 95) return { text: 'Thunderstorm', icon: 'cloud_storm' };
  return { text: 'Weather', icon: 'cloud' };
}

/** Where to look: the profile's city, else the city in the time zone's name. Null when neither says. */
export function placeOf(profile) {
  if (profile?.city) return { name: String(profile.city).trim().slice(0, 80), country: profile.country || null };
  const tz = String(profile?.tz || '');
  const last = tz.includes('/') ? tz.split('/').pop().replace(/_/g, ' ') : '';
  return last && !/^(GMT|UTC|Etc)/i.test(last) ? { name: last, country: null } : null;
}

/** One line for training, when the weather calls for it; null on an ordinary day. */
export function trainingNote({ feels, hi, uv, rain, wind, code }) {
  if (Number(code) >= 95) return 'Thunderstorms: train indoors today.';
  if (fin(feels) && feels >= 35) return 'Very hot: train early or late, and drink more than usual.';
  if (fin(hi) && hi >= 32) return 'Hot later: train early or late, and drink more than usual.';
  if (fin(feels) && feels <= -5) return 'Very cold: cover up and warm up for longer.';
  if (fin(rain) && rain >= 60) return `Rain is likely (${Math.round(rain)}%): an indoor session, or go before it starts.`;
  if (fin(uv) && uv >= 8) return 'Very high UV around midday: sunscreen, or train outside the middle of the day.';
  if (fin(wind) && wind >= 40) return 'Windy: expect a slower run or ride into it.';
  return null;
}

export class Weather {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 6000, urls = {} } = {}) {
    this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.urls = { ...WEATHER_URLS, ...urls };
    this.places = new Map(); this.forecasts = new Map();
  }
  async #get(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    t.unref?.();
    try {
      const res = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) throw Object.assign(new Error('The weather service answered with an error.'), { status: 502, expose: true, code: 'upstream' });
      return await res.json();
    } catch (e) {
      if (e.status) throw e;
      throw Object.assign(new Error('The weather service could not be reached.'), { status: 502, expose: true, code: 'upstream' });
    } finally { clearTimeout(t); }
  }
  #keep(map, key, value, max = 500) {
    map.set(key, { at: this.now(), value });
    if (map.size > max) for (const [k] of map) { map.delete(k); if (map.size <= max * 0.75) break; }
  }

  /** A place's position, or null when Open-Meteo does not know it. */
  async locate(place) {
    const key = `${place.name.toLowerCase()}|${place.country || ''}`;
    const hit = this.places.get(key);
    if (hit && this.now() - hit.at < PLACE_TTL) return hit.value;
    const j = await this.#get(`${this.urls.geo}?${new URLSearchParams({ name: place.name, count: '5', language: 'en', format: 'json' })}`);
    const all = j?.results || [];
    const r = (place.country && all.find((x) => String(x.country_code).toUpperCase() === String(place.country).toUpperCase())) || all[0] || null;
    const v = r && fin(r.latitude) && fin(r.longitude) ? { lat: Math.round(r.latitude * 100) / 100, lon: Math.round(r.longitude * 100) / 100, name: r.name, country: r.country || null } : null;
    this.#keep(this.places, key, v);
    return v;
  }

  /** Today's weather for a profile: { place, now, today, note }, or null when there is no place to look up. */
  async forProfile(profile) {
    const place = placeOf(profile);
    if (!place) return null;
    const at = await this.locate(place);
    if (!at) return null;
    const key = `${at.lat},${at.lon}`;
    const hit = this.forecasts.get(key);
    let j = hit && this.now() - hit.at < FORECAST_TTL ? hit.value : null;
    if (!j) {
      j = await this.#get(`${this.urls.forecast}?${new URLSearchParams({
        latitude: String(at.lat), longitude: String(at.lon), timezone: 'auto', forecast_days: '1',
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
      })}`);
      this.#keep(this.forecasts, key, j);
    }
    const c = j?.current || {}; const d = j?.daily || {};
    const first = (k) => (Array.isArray(d[k]) ? d[k][0] : null);
    const now = { tempC: c.temperature_2m ?? null, feelsC: c.apparent_temperature ?? null, windKmh: c.wind_speed_10m ?? null, code: c.weather_code ?? null, day: c.is_day !== 0, ...conditionOf(c.weather_code, c.is_day !== 0) };
    const today = { hiC: first('temperature_2m_max'), loC: first('temperature_2m_min'), rainPct: first('precipitation_probability_max'), uv: first('uv_index_max'), sunrise: first('sunrise'), sunset: first('sunset') };
    return {
      place: at.name, now, today,
      note: trainingNote({ feels: now.feelsC, hi: today.hiC, uv: today.uv, rain: today.rainPct, wind: now.windKmh, code: now.code }),
      source: 'Open-Meteo',
    };
  }
}
