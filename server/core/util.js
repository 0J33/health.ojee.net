/* ============================================================
   health.ojee.net — small shared helpers: civil dates, durations,
   numbers that arrive as strings.

   The Google Health API speaks two kinds of time. Physical time is
   an RFC 3339 instant. Civil time is a calendar date (and maybe a
   time of day) in whatever zone the wearer was in. Daily metrics —
   resting heart rate, HRV, a day's steps — are civil: "the 6th",
   not an instant. Everything here keeps those apart.
   ============================================================ */

/** int64 fields arrive as JSON strings ("8123"); doubles as numbers. */
export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** { year, month, day } -> 'YYYY-MM-DD'. */
export const ymd = (d) => (d && d.year
  ? `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
  : null);

/** 'YYYY-MM-DD' -> { year, month, day }. */
export const dateObj = (s) => {
  const [year, month, day] = String(s).split('-').map(Number);
  return { year, month, day };
};

/** Add whole days to a civil date string. Pure calendar arithmetic, no zone. */
export const addDays = (s, n) => {
  const { year, month, day } = dateObj(s);
  const t = new Date(Date.UTC(year, month - 1, day + n));
  return t.toISOString().slice(0, 10);
};

/** Days from a to b (b - a), both civil date strings. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Today's civil date in a zone. Every caller passes the person's own zone:
    this server holds many people, so there is no one "process zone". */
export const today = (now = Date.now(), tz = undefined) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(now));
};

/** A google-duration ("10800s", "-3600.5s") in seconds. */
export const durSec = (s) => {
  if (s === null || s === undefined) return 0;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(String(s).trim());
  return m ? Number(m[1]) : 0;
};

/** An RFC 3339 instant in ms, or null. */
export const ms = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** Mean and sample standard deviation of the finite values in a list. */
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, sd: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { n: v.length, mean, sd };
}

export const round = (x, p = 0) => (Number.isFinite(x) ? Math.round(x * 10 ** p) / 10 ** p : null);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const sleepFor = (t) => new Promise((r) => { setTimeout(r, t).unref?.(); });

/** The UTC offset (seconds) a zone has at an instant — what Google wants
    beside every physical time it is sent. */
export function utcOffsetSec(t, tz = undefined) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wallAsUtc - Math.floor(t / 1000) * 1000) / 1000);
}

/** HH:MM of an instant in a zone. */
export const clockIn = (t, tz = undefined) => new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

/** Is this an IANA zone this runtime knows. */
export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The instant of a civil date + minutes after its midnight, in a zone.
    Two passes settle the offset across a DST change. */
export function localToMs(date, minutes = 0, tz = undefined) {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  let t = wall - utcOffsetSec(wall, tz) * 1000;
  t = wall - utcOffsetSec(t, tz) * 1000;
  return t;
}

/** Monday of the week a civil date falls in. */
export const weekOf = (date) => {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
};
/** First day of the month a civil date falls in. */
export const monthOf = (date) => `${date.slice(0, 7)}-01`;
