/* Numbers, units and dates, following the person's settings as the API
   gives them: a time zone and a unit system. Civil dates ("2026-10-09") are
   never run through the browser's own zone. */

const LOCALE = 'en-GB';

const prefs = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  distance: 'km',
  weight: 'kg',
  temp: 'c',
  volume: 't',    // training volume: tonnes, kg or lb
  water: 'ml',    // ml or US fl oz
  clock: '24',    // '24' (23:34) or '12' (11:34 pm)
  weekStart: 1,   // the day the person's week starts on: 0 Sunday to 6 Saturday
};

/** Accepts 'metric' | 'imperial' or { distance, weight, temp }. */
export function setPrefs({ tz, units, weekStart } = {}) {
  if (Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6) prefs.weekStart = weekStart;
  if (tz) {
    try { new Intl.DateTimeFormat(LOCALE, { timeZone: tz }); prefs.tz = tz; } catch { /* keep the browser's zone */ }
  }
  if (units === 'imperial') Object.assign(prefs, { distance: 'mi', weight: 'lb', temp: 'f' });
  else if (units === 'metric') Object.assign(prefs, { distance: 'km', weight: 'kg', temp: 'c' });
  else if (units && typeof units === 'object') {
    if (units.distance) prefs.distance = units.distance === 'mi' ? 'mi' : 'km';
    if (units.weight) prefs.weight = units.weight === 'lb' ? 'lb' : 'kg';
    const t = units.temp || units.temperature;
    if (t) prefs.temp = String(t).toLowerCase().startsWith('f') ? 'f' : 'c';
    if (units.volume) prefs.volume = ['t', 'kg', 'lb'].includes(units.volume) ? units.volume : 't';
    if (units.water) prefs.water = units.water === 'oz' ? 'oz' : 'ml';
    if (units.clock) prefs.clock = String(units.clock) === '12' ? '12' : '24';
  }
}
export const getPrefs = () => ({ ...prefs });
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

export const DASH = '–';
export const int = (v) => (isNum(v) ? nf0.format(Math.round(v)) : DASH);
export const dec1 = (v) => (isNum(v) ? nf1.format(v) : DASH);
export const dec = (v, max = 2) => (isNum(v) ? (max === 1 ? nf1 : nf2).format(v) : DASH);

/** 8412 → "8.4k", 12 → "12". For axis ticks only. */
export function compact(v) {
  if (!isNum(v)) return '';
  const a = Math.abs(v);
  if (a >= 10000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

/* ── durations ──────────────────────────────────────────────── */

/** Minutes → "7 h 12 min" (or "45 min"). */
export function dur(min) {
  if (!isNum(min)) return DASH;
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  // Non-breaking spaces: "6 h 59 min" never splits across two lines.
  if (!h) return `${r}\u00a0min`;
  return r ? `${h}\u00a0h\u00a0${r}\u00a0min` : `${h}\u00a0h`;
}
/** Minutes → "7:12" for tight places and axis ticks. */
export function durShort(min) {
  if (!isNum(min)) return DASH;
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
export function durParts(min) {
  if (!isNum(min)) return null;
  const m = Math.max(0, Math.round(min));
  return { h: Math.floor(m / 60), m: m % 60 };
}
/** Milliseconds → "1:02:07" / "12:07", for the running timer. */
export function stopwatch(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/* ── units ──────────────────────────────────────────────────── */

const KM_PER_MI = 1.609344;
const LB_PER_KG = 2.2046226218;

export const distUnit = () => prefs.distance;
export const weightUnit = () => prefs.weight;
export const tempUnit = () => (prefs.temp === 'f' ? '°F' : '°C');

/** Training volume from kilograms lifted: "14.2 t", "14,200 kg" or "31,306 lb". */
export function volume(kg, { unit = true } = {}) {
  if (!isNum(kg)) return DASH;
  if (prefs.volume === 'kg') return `${nf0.format(Math.round(kg))}${unit ? ' kg' : ''}`;
  if (prefs.volume === 'lb') return `${nf0.format(Math.round(kg * LB_PER_KG))}${unit ? ' lb' : ''}`;
  return `${nf1.format(kg / 1000)}${unit ? ' t' : ''}`;
}
export const volumeUnit = () => prefs.volume;
/** Water from millilitres: "1,600 ml" or "54 fl oz". */
export const waterVal = (ml) => (isNum(ml) ? (prefs.water === 'oz' ? ml / 29.5735 : ml) : null);
export const waterUnit = () => (prefs.water === 'oz' ? 'fl oz' : 'ml');
export const water = (ml) => (isNum(ml) ? `${nf0.format(Math.round(waterVal(ml)))} ${waterUnit()}` : DASH);

/** Metres → number in the person's unit. */
export const distVal = (m) => (isNum(m) ? (m / 1000) / (prefs.distance === 'mi' ? KM_PER_MI : 1) : null);
export const dist = (m) => (isNum(m) ? `${dec(distVal(m), distVal(m) >= 100 ? 1 : 2)} ${prefs.distance}` : DASH);
export const distNum = (m) => (isNum(m) ? dec(distVal(m), distVal(m) >= 100 ? 1 : 2) : DASH);

/** Kilograms → number in the person's unit, and back for input. */
export const weightVal = (kg) => (isNum(kg) ? kg * (prefs.weight === 'lb' ? LB_PER_KG : 1) : null);
export const weight = (kg) => (isNum(kg) ? `${dec1(weightVal(kg))} ${prefs.weight}` : DASH);
export const weightNum = (kg) => (isNum(kg) ? dec1(weightVal(kg)) : DASH);
export const toKg = (v) => (isNum(v) ? v / (prefs.weight === 'lb' ? LB_PER_KG : 1) : null);

/** A temperature difference in °C → the person's unit, signed. */
export function tempDelta(c) {
  if (!isNum(c)) return DASH;
  const v = Math.round((prefs.temp === 'f' ? c * 1.8 : c) * 10) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf1.format(Math.abs(v))} ${tempUnit()}`;
}

export const pct = (v) => (isNum(v) ? `${Math.round(v)}%` : DASH);
export const signed = (v, digits = 0) => {
  if (!isNum(v)) return DASH;
  const a = digits ? nf1.format(Math.abs(v)) : nf0.format(Math.abs(Math.round(v)));
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${a}`;
};

/* ── dates ──────────────────────────────────────────────────── */

const dtf = (opts) => new Intl.DateTimeFormat(LOCALE, { timeZone: prefs.tz, ...opts });
const utc = (opts) => new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', ...opts });
const civil = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`);

/** Today's civil date in the person's zone, "YYYY-MM-DD". */
export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: prefs.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDays(date, n) {
  const d = civil(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The civil date an instant falls on, in the person's zone. */
export function dateOf(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: prefs.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/* Civil-date formatters */
export const dayShort = (d) => utc({ day: 'numeric', month: 'short' }).format(civil(d));                    // 9 Oct
export const dayLong = (d) => utc({ weekday: 'long', day: 'numeric', month: 'long' }).format(civil(d));      // Friday 9 October
export const dayMed = (d) => utc({ weekday: 'short', day: 'numeric', month: 'short' }).format(civil(d));     // Fri 9 Oct
export const dow = (d) => utc({ weekday: 'short' }).format(civil(d));                                        // Fri
export const dowLetter = (d) => utc({ weekday: 'narrow' }).format(civil(d));
export const dom = (d) => civil(d).getUTCDate();
export const monthShort = (d) => utc({ month: 'short' }).format(civil(d));
export const monthYear = (d) => utc({ month: 'long', year: 'numeric' }).format(civil(d));
export const dateFull = (d) => utc({ day: 'numeric', month: 'long', year: 'numeric' }).format(civil(d));

/** "Today", "Yesterday", or "Fri 9 Oct". */
export function dayRel(d) {
  const t = today();
  const s = String(d).slice(0, 10);
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  return dayMed(s);
}

/* Instant formatters (epoch ms or ISO), in the person's zone */
const inst = (t) => (t instanceof Date ? t : new Date(t));
/** 23:34, or 11:34 pm when the person chose a 12-hour clock. */
export const clock = (t) => (t === null || t === undefined ? DASH
  : prefs.clock === '12' ? dtf({ hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(inst(t)).replace(/\u202f|\s/g, ' ')
    : dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(inst(t)));
export const is12h = () => prefs.clock === '12';
/** A wall time the server wrote as "23:34", in the chosen clock. */
export function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m || prefs.clock !== '12') return s ?? DASH;
  const h = Number(m[1]) % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}
/** An hour of the day for an axis: "06:00", or "6 am". */
export const hourLabel = (h) => (prefs.clock === '12' ? `${(h % 24) % 12 || 12} ${(h % 24) < 12 ? 'am' : 'pm'}` : `${String(h % 24).padStart(2, '0')}:00`);
export const dateTime = (t) => (t === null || t === undefined ? DASH : `${dayRel(dateOf(inst(t).getTime()))}, ${clock(t)}`);
export const instDay = (t) => dateOf(inst(t).getTime());

/** "just now", "4 min ago", "2 h ago", "yesterday", "9 Oct". */
export function ago(t) {
  if (t === null || t === undefined) return 'never';
  const ms = Date.now() - inst(t).getTime();
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  // Days are calendar days in the person's zone, not 24-hour stretches:
  // Thursday evening is "2 days ago" on Saturday afternoon, not "yesterday".
  const d = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${instDay(t)}T00:00:00Z`)) / 86_400_000);
  if (h < 24 && d <= 1) return d === 1 && h >= 12 ? 'yesterday' : `${h} h ago`;
  if (d <= 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return dayShort(instDay(t));
}

/**
 * Wall-clock parts of an instant in the person's zone, for <input
 * type="datetime-local"> ("2026-10-09T15:02"), and the way back.
 */
export function toLocalInput(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: prefs.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function fromLocalInput(str) {
  if (!str) return null;
  // Treat the wall time as UTC, then correct by the zone's offset at that moment.
  const guess = Date.parse(`${str}:00Z`);
  if (!Number.isFinite(guess)) return null;
  const off = (ms) => Date.parse(`${toLocalInput(ms)}:00Z`) - Math.floor(ms / 60000) * 60000;
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}

/** The first day of the week a civil date is in (the person's own week start). */
export const weekStartDay = () => prefs.weekStart;
export function weekStart(d) {
  const c = civil(d);
  const wd = (c.getUTCDay() - prefs.weekStart + 7) % 7;
  c.setUTCDate(c.getUTCDate() - wd);
  return c.toISOString().slice(0, 10);
}
export function weekLabel(startDate) {
  const t = weekStart(today());
  if (startDate === t) return 'This week';
  if (startDate === addDays(t, -7)) return 'Last week';
  const end = addDays(startDate, 6);
  return monthShort(startDate) === monthShort(end)
    ? `${dom(startDate)}–${dom(end)} ${monthShort(end)}`
    : `${dayShort(startDate)} – ${dayShort(end)}`;
}

export const plural = (n, one, many) => `${int(n)} ${Math.round(n) === 1 ? one : (many || `${one}s`)}`;
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('') || '?';

/** The days of the week, 0 Sunday to 6 Saturday (a person's week starts on one of them). */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Every country as [code, name], by name, in the browser's language. */
export function listCountries() {
  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }); } catch { return []; }
  const out = [];
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) for (const b of A) {
    const code = a + b;
    if (['EU', 'EZ', 'UN', 'QO', 'ZZ', 'AA', 'XA', 'XB', 'XK'].includes(code) || code.startsWith('Q') || code.startsWith('X')) continue;
    let name; try { name = dn.of(code); } catch { continue; }
    if (name && name !== code) out.push([code, name]);
  }
  return out.sort((x, y) => x[1].localeCompare(y[1]));
}
/** A country's name from its code. */
export function countryName(code) { try { return code ? new Intl.DisplayNames(['en'], { type: 'region' }).of(code) : ''; } catch { return code || ''; } }
/** The city a time zone is named after: "America/Argentina/Buenos_Aires" → "Buenos Aires". */
/** The person's time zone. */
export const tzName = () => prefs.tz;
/** The next turn of the boards' shared week, Friday 12:00 UTC (server/social.js sharedWeek), as ms. */
export function boardReset(now = Date.now()) {
  const d = new Date(now); const day = d.getUTCDay();
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((5 - day + 7) % 7), 12);
  if (t <= now) t += 7 * 86_400_000;
  return t;
}
/** "Friday 14:00" in the person's zone, for a moment. */
export const weekdayClock = (t) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: prefs.tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  const part = (k) => parts.find((x) => x.type === k)?.value || '';
  return `${part('weekday')} ${part('hour')}:${part('minute')}`;
};
export const tzCity = (z) => String(z || '').split('/').pop().replace(/_/g, ' ');

export function listTimeZones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return [browserTz(), 'UTC', 'Europe/London', 'Europe/Berlin', 'Africa/Cairo', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Tokyo']; }
}
