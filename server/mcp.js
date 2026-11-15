/* ============================================================
   health.ojee.net — the MCP server: the person's health data for AI
   assistants (Claude, ChatGPT, Cursor, anything that speaks the Model
   Context Protocol). docs/DEVELOPERS.md says how to connect one.

   POST /mcp, Streamable HTTP, stateless: each POST is one JSON-RPC
   message (or a batch) and the answer is plain JSON (no event stream,
   no session). Authorization: Bearer <personal API key> (apikeys.js).

   Every tool is a call to the site's own API, made in-process with the
   caller's key: the same answers, the same checks, the same limits as
   REST. A read key sees the reading tools; a write key the logging ones
   too.
   ============================================================ */

import { Readable, Writable } from 'node:stream';
import { analyse, isoWeek, localDate, localIso } from './runanalysis.js';

export const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 200_000;   // characters of one tool answer; more is cut, with a note

const RANGE = { type: 'string', enum: ['day', 'week', 'month', '6m', 'year'], description: 'The period: day, week (7 days), month (30 days), 6m (26 weeks, by week) or year (12 months, by month). Default week.' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'A civil date, YYYY-MM-DD, in the person\'s time zone.' };

const INSTRUCTIONS = `This server is one person's health data from health.ojee.net: what their watch or ring, scale and phone sent to Google Health (and Garmin, Strava, Hevy, a Xiaomi scale), plus what they log here.
Start with list_metrics to see which metrics they have, with the latest value of each; then get_metric for one metric over a period (day, week, month, 6m, year) with its stats, chart points, reference range and entries. get_day is one day in full, get_overview the last days at a glance, get_trends averages and patterns, list_workouts and get_workout training (get_workout analyses a run on the server), get_run_trends runs week by week (with hr_band, the pace at a heart rate).
Pace is distance over moving time, and there is one moving time per run: the GPS track's, the same in list_workouts (paceFrom "track"), get_workout's analysis and get_run_trends; stops add up to elapsed less moving. A run without a track has the watch's pace (paceFrom "watch"). Strava's data is never given here (its terms keep it away from AI tools): a run that is on Strava and the watch's too is given as the watch's own record from Google Health.
Numbers are in metric units (kg, metres or km, seconds or minutes as each field names, °C); sleep is in minutes. Dates are in the person's time zone; times are ms since 1970, with localDate and startLocal (ISO with the zone's offset) beside them: use those for the day a workout was on. Scores marked "own" are worked out by this app, not by Google.
This is health data, not medical advice: say so when it matters, and never diagnose.`;

/** A response the in-process call collects. */
class Collect extends Writable {
  constructor() { super(); this.statusCode = 200; this.head = {}; this.chunks = []; this.headersSent = false; }
  setHeader(k, v) { this.head[String(k).toLowerCase()] = v; }
  getHeader(k) { return this.head[String(k).toLowerCase()]; }
  removeHeader(k) { delete this.head[String(k).toLowerCase()]; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); this.headersSent = true; return this; }
  flushHeaders() { this.headersSent = true; }
  _write(c, _e, cb) { this.chunks.push(Buffer.from(c)); cb(); }
}

/* What an AI has no use for and pays for in context: a night's minute-by-minute stages
   (get_day has one night's), sparklines, map tracks, the app's own lists of types. */
const nights = (sl) => (sl && Array.isArray(sl.nights) ? { ...sl, nights: sl.nights.map(({ stages: _s, ...n }) => n) } : sl);
const leanWorkout = ({ spark: _s, gps: _g, google: _go, ...w }) => w;
// Days with nothing dropped, and nothing written as null.
const noNulls = (rows) => (rows || []).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null))).filter((r) => Object.keys(r).length > 1);
/** Trends for a model: past 90 days, the weeks and months say it; the days are get_metric's. */
function leanTrends(d, days) {
  const out = { ...d, sleep: nights(d.sleep), series: noNulls(d.series) };
  if (days > 90) {
    out.series = `Day by day is left out over ${days} days: see weeks and months here, or get_metric for one metric by day.`;
    if (d.weight?.trend) out.weight = { ...d.weight, trend: undefined };
  }
  return out;
}

/** The person's time zone, read once per call. */
const meOf = async (api) => { try { const m = await api('GET', '/api/me'); return { tz: m.tz || m.profile?.tz || 'UTC' }; } catch { return { tz: 'UTC' }; } };
const SPORT_KINDS = ['run', 'walk', 'ride', 'strength'];
/** A workout of a list, with its times where the person lives and its length in seconds. */
const withLocal = (w, tz) => ({ ...w, localDate: localDate(w.start, tz), startLocal: localIso(w.start, tz), ...(w.end ? { endLocal: localIso(w.end, tz), durationS: Math.round((w.end - w.start) / 1000) } : {}) });
/** Midnight starting a civil date in a zone, in ms (the zone's offset that day). */
function dayStart(date, tz) {
  const off = localIso(Date.parse(`${date}T12:00:00Z`), tz).slice(19);
  return Date.parse(`${date}T00:00:00${off}`);
}

async function listWorkouts(a, api, q) {
  const { tz } = await meOf(api);
  const limit = Math.min(200, a.limit || 20);
  const type = a.type ? String(a.type) : null;
  const kind = type && SPORT_KINDS.includes(type.toLowerCase()) ? type.toLowerCase() : null;
  const exact = type && !kind ? type.toUpperCase() : null;
  const fromMs = a.from ? dayStart(a.from, tz) : null;
  const toMs = a.to ? dayStart(a.to, tz) + 86_400_000 : null;
  let before = Math.min(a.before ?? Infinity, toMs ?? Infinity);
  const got = []; let first = null; let more = false;
  // Page through the API until enough are found, or the period is passed.
  for (let page = 0; page < 20; page += 1) {
    const d = await api('GET', `/api/workouts${q({ limit: 100, before: Number.isFinite(before) ? before : undefined, kind: kind || undefined })}`);
    first ||= d;
    const h = d.history || [];
    let done = false;
    for (const w of h) {
      if (fromMs !== null && w.start < fromMs) { done = true; more = false; break; }
      if (exact && String(w.type).toUpperCase() !== exact) continue;
      if (got.length >= limit) { done = true; more = true; break; }
      got.push(w);
    }
    if (done || !d.more || !h.length) break;
    before = h.at(-1).start;
  }
  const { allTypes: _t, exerciseTypes: _e, detection: _d, canWrite: _c, routesAsk: _r, history: _h, pending, training, strength, kinds, kind: _k, more: _m, ...rest } = first || {};
  const want = (a.include || []).includes('strength');
  return {
    ...rest, tz,
    history: got.map((w) => withLocal(leanWorkout(w), tz)),
    more,
    pending: (pending || []).map((w) => withLocal(leanWorkout(w), tz)),
    kinds,
    ...(want ? { training, strength } : { strength: 'Left out: ask with include ["strength"] for exercises, records and muscle balance.' }),
  };
}

/** One workout for a model: the analysis in, the bulk out unless asked. */
function leanDetail(w, a, tz) {
  const inc = new Set(a.include || []);
  const out = withLocal({ ...w }, tz);
  const an = analyse(w, { hrBand: a.hr_band });
  if (an) out.analysis = an;
  if (out.track) {
    const { series, line, bounds, stops: _st, ...t } = out.track;
    out.track = { ...t, ...(inc.has('series') ? { series, seriesColumns: ['metres', 'elevationM', 'kmh', 'secondsFromT0', 'bpm'] } : {}), ...(inc.has('route') ? { line, bounds } : {}) };
  }
  if (!inc.has('trace') && Array.isArray(out.trace)) out.trace = `${out.trace.length} minutes of heart rate left out: ask with include ["trace"] for them ([ms, bpm, steps]).`;
  delete out.google; delete out.spark; delete out.gps;
  return out;
}

async function runTrends(a, api, q) {
  const { tz } = await meOf(api);
  const sport = a.sport || 'run';
  const to = a.to || localDate(Date.now(), tz);
  const from = a.from || localDate(Date.now() - 84 * 86_400_000, tz);
  const list = await listWorkouts({ type: sport, from, to, limit: 80 }, api, q);
  const runs = [];
  for (const w of list.history) {
    let d;
    try { d = await api('GET', `/api/workouts/${encodeURIComponent(w.id)}`); } catch { continue; }
    const an = analyse(d, { hrBand: a.hr_band });
    if (!an) continue;
    const { gpsSpikeList: _g, bestEfforts: _b, ...brief } = an;
    runs.push({ id: w.id, title: w.title, localDate: localDate(w.start, tz), week: isoWeek(w.start, tz), source: w.source, ...brief, stops: an.stops ? { count: an.stops.count, totalS: an.stops.totalS } : null, walkBreaks: an.walkBreaks ? { count: an.walkBreaks.count, totalS: an.walkBreaks.totalS } : null });
  }
  // Weeks: totals and averages of the runs with nothing wrong in their data.
  const weeks = new Map();
  for (const r of runs) {
    if (r.flags.length) continue;
    const secs = r.movingS || r.elapsedS || 0;
    const k = weeks.get(r.week) || { week: r.week, runs: 0, distanceM: 0, movingS: 0, hrS: 0, hrW: 0, bandM: 0, bandS: 0, drift: [] };
    k.runs += 1; k.distanceM += r.distanceM || 0; k.movingS += secs;
    if (r.avgHr) { k.hrS += r.avgHr * secs; k.hrW += secs; }
    // Distance over time in the band, summed from the runs (not an average of their paces).
    if (r.inHrBand?.metres > 0 && r.inHrBand.approxS > 0) { k.bandM += r.inHrBand.metres; k.bandS += r.inHrBand.approxS; }
    if (Number.isFinite(r.cardiacDriftPct)) k.drift.push([r.cardiacDriftPct, secs]);
    weeks.set(r.week, k);
  }
  return {
    tz, sport, from, to, hrBand: a.hr_band || null,
    runs,
    weeks: [...weeks.values()].sort((x, y) => (x.week < y.week ? -1 : 1)).map((k) => ({
      week: k.week, runs: k.runs, distanceM: Math.round(k.distanceM), movingS: Math.round(k.movingS),
      paceSPerKm: k.distanceM > 0 && sport !== 'ride' ? Math.round(k.movingS / (k.distanceM / 1000)) : null,
      avgHr: k.hrW ? Math.round(k.hrS / k.hrW) : null,
      // Weighted by each run's moving time; only runs steady enough to have one.
      cardiacDriftPct: k.drift.length ? Math.round((k.drift.reduce((x, [d, s]) => x + d * s, 0) / k.drift.reduce((x, [, s]) => x + s, 0)) * 10) / 10 : null,
      ...(a.hr_band ? { inHrBand: { approxS: Math.round(k.bandS), metres: Math.round(k.bandM), paceSPerKm: k.bandM > 0 && sport !== 'ride' ? Math.round(k.bandS / (k.bandM / 1000)) : null } } : {}),
    })),
    flagged: runs.filter((r) => r.flags.length).map((r) => ({ id: r.id, localDate: r.localDate, flags: r.flags })),
  };
}

/** The tools: each a call to the API. `scope` write ones are listed for write keys only. */
function tools() {
  const q = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v)); const s = u.toString(); return s ? `?${s}` : ''; };
  return [
    {
      name: 'get_profile', scope: 'read', title: 'Profile and settings',
      description: 'Who the person is here: username, time zone, units, goals (steps, sleep, weekly cardio), which sources are connected and when they last synced.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async (_a, api) => api('GET', '/api/me'),
    },
    {
      name: 'list_metrics', scope: 'read', title: 'Every metric with data',
      description: 'Every metric the person has data for (steps, sleep, resting heart rate, HRV, weight, VO2 max...), by category, each with its id, unit, latest value and date, and where that value sits in its reference range. Use the ids with get_metric.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async (_a, api) => {
        const b = await api('GET', '/api/browse');
        return {
          today: b.today, tz: b.tz,
          metrics: (b.categories || []).flatMap((c) => c.metrics.map((m) => ({ id: m.id, label: m.label, category: c.id, unit: m.unit, kind: m.kind, own: m.own || false, latest: m.latest, band: m.band || null }))),
          noDataYet: (b.empty || []).map((m) => m.id),
        };
      },
    },
    {
      name: 'get_metric', scope: 'read', title: 'One metric over a period',
      description: 'One metric over a period: the stats (average, total, lowest, highest), the period before for comparison, a sentence reading it, the points of its chart, its reference range (with the source) and its entries, newest first. For a day it is that day\'s readings.',
      inputSchema: { type: 'object', properties: { metric: { type: 'string', description: 'A metric id from list_metrics, such as steps, sleep, resting_hr, hrv, weight, active, cardio_week, vo2max, sleep_score, readiness.' }, range: RANGE, end: { ...DATE, description: 'The last day of the period (default today).' } }, required: ['metric'], additionalProperties: false },
      call: async (a, api) => {
        const d = await api('GET', `/api/metric/${encodeURIComponent(a.metric)}${q({ range: a.range || 'week', end: a.end })}`);
        const { more: _m, add: _add, ...rest } = d;
        return { ...rest, entries: (d.entries || []).slice(0, 60).map(({ editable: _e, deletable: _x, fields: _f, ...e }) => e) };
      },
    },
    {
      name: 'get_day', scope: 'read', title: 'One day in full',
      description: 'One day in full: activity totals, sleep of the night before with its stages, heart rate through the day, workouts, scores and what was logged.',
      inputSchema: { type: 'object', properties: { date: { ...DATE, description: 'The day (default today).' } }, additionalProperties: false },
      call: async (a, api) => api('GET', `/api/day${q({ date: a.date })}`),
    },
    {
      name: 'get_overview', scope: 'read', title: 'The last days at a glance',
      description: 'The person\'s dashboard: day by day for the last 7 to 90 days (steps, sleep, resting heart rate, HRV, active minutes, calories, scores) with their usual ranges, and today so far.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 90, description: 'How many days back (default 14).' } }, additionalProperties: false },
      call: async (a, api) => { const d = await api('GET', `/api/data${q({ days: a.days || 14 })}`); return { ...d, sleep: nights(d.sleep), series: noNulls(d.series) }; },
    },
    {
      name: 'get_trends', scope: 'read', title: 'Averages and patterns',
      description: 'Averages and patterns over 7, 30, 90, 180 or 365 days: sleep regularity, weekday patterns, best days, weight trend and rate, activity against goals.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', enum: [7, 30, 90, 180, 365], description: 'Default 30.' }, include: { type: 'array', items: { type: 'string', enum: ['nights'] }, description: 'Large parts left out unless asked: nights (every night of sleep in the period).' } }, additionalProperties: false },
      call: async (a, api) => {
        const out = leanTrends(await api('GET', `/api/trends${q({ days: a.days || 30 })}`), a.days || 30);
        if (Array.isArray(out.sleep?.nights) && !(a.include || []).includes('nights')) out.sleep = { ...out.sleep, nights: `${out.sleep.nights.length} nights left out: ask with include ["nights"] for them.` };
        return out;
      },
    },
    {
      name: 'list_workouts', scope: 'read', title: 'Workouts, newest first',
      description: 'Workouts, newest first: type, start and end (ms, plus localDate and startLocal in the person\'s time zone), duration in seconds, distance, pace, calories, heart rate. Filter by `from`/`to` (dates, inclusive) and `type` (run, walk, ride, strength, or a type such as RUNNING or YOGA). Page back with `before` (the `start` of the oldest one you have). The strength summary (exercises, records, muscle balance) is left out unless include has "strength".',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 20.' },
        before: { type: 'integer', description: 'Only workouts that started before this time (ms since 1970).' },
        from: { ...DATE, description: 'The first day, YYYY-MM-DD, in the person\'s time zone.' },
        to: { ...DATE, description: 'The last day, YYYY-MM-DD, in the person\'s time zone.' },
        type: { type: 'string', description: 'run, walk, ride, strength, or one exercise type (RUNNING, TRAIL_RUN, YOGA...).' },
        include: { type: 'array', items: { type: 'string', enum: ['strength'] } },
      }, additionalProperties: false },
      call: async (a, api) => listWorkouts(a, api, q),
    },
    {
      name: 'get_run_trends', scope: 'read', title: 'Runs analysed, week by week',
      description: 'Every run (or walk or ride) in a period, each read closely as get_workout\'s analysis does (pace, moving and elapsed time, heart rate, metres per beat, cardiac drift, stops, walk breaks, flags), and the weeks they add up to. With `hr_band` [low, high], also the pace while the heart rate was in that band, per run and per week: how easy-run fitness moves. Flagged runs (no distance, impossible pace, GPS jumps) are listed but left out of the week figures.',
      inputSchema: { type: 'object', properties: {
        sport: { type: 'string', enum: ['run', 'walk', 'ride'], description: 'Default run.' },
        from: { ...DATE, description: 'The first day (default 12 weeks back).' }, to: { ...DATE, description: 'The last day (default today).' },
        hr_band: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Heart rate low and high, bpm, such as [140, 150].' },
      }, additionalProperties: false },
      call: async (a, api) => runTrends(a, api, q),
    },
    {
      name: 'get_workout', scope: 'read', title: 'One workout in full',
      description: 'One workout in full: every exercise and set (weight, reps), heart rate and zones, splits, best efforts, records, and for a run, walk or ride an `analysis` worked out on the server (moving and elapsed time, pace, average and highest heart rate, metres per beat, cardiac drift, first km against the rest, stops, walk breaks, the longest stretch run without a break, GPS jumps, data flags, both distances). The bulky parts are left out unless asked with include: series (~300 samples along the route: metres, elevation, km/h, seconds, bpm), route (the line to draw), trace (heart rate minute by minute).',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string', description: 'A workout id from list_workouts.' },
        include: { type: 'array', items: { type: 'string', enum: ['series', 'route', 'trace'] } },
        hr_band: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Also the pace while the heart rate was in this band, bpm [low, high].' },
      }, required: ['id'], additionalProperties: false },
      call: async (a, api) => {
        const [w, me] = await Promise.all([api('GET', `/api/workouts/${encodeURIComponent(a.id)}`), meOf(api)]);
        return leanDetail(w, a, me.tz);
      },
    },
    {
      name: 'list_routines', scope: 'read', title: 'Training routines',
      description: 'The person\'s strength routines and programmes, with their exercises and target sets.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async (_a, api) => api('GET', '/api/routines'),
    },
    {
      name: 'get_best_times', scope: 'read', title: 'Best times',
      description: 'Best times for running, walking and cycling distances (1 km, 5 km, 10 km, half marathon...), with the workout each came from: its id is the one list_workouts and get_workout use, and an effort across a GPS jump is left out, as get_workout\'s analysis leaves it out.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async (_a, api) => api('GET', '/api/best-times'),
    },
    {
      name: 'api_get', scope: 'read', title: 'Any read of the API',
      description: 'Any GET of the health.ojee.net API that the other tools do not cover, such as /api/achievements, /api/leaderboard?metric=steps&period=week, /api/log, /api/compare?with=<username>. The reference is https://health.ojee.net/developers/api.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', pattern: '^/api/', description: 'The path with its query, starting /api/.' } }, required: ['path'], additionalProperties: false },
      call: async (a, api) => api('GET', a.path),
    },
    {
      name: 'log_entry', scope: 'write', title: 'Log an entry',
      description: 'Log one entry, as the site\'s Log sheet does. `kind` and its fields: water {ml}; food {kcal, protein?, carbs?, fat?, name?}; mood {moods: [1-10 ids], note?}; stress {level 1-5, note?}; symptom {symptoms, note?}; glucose {mgdl}; bodytemp {celsius}; height {cm}; bodyfat {pct}; sleep {minutes, awake?}; measure {cm or kg fields}; period {days}. `at` is the time in ms (default now). Optional groups (nutrition, mindfulness, symptoms, cycle) must be switched on in the app first.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['water', 'food', 'mood', 'stress', 'symptom', 'glucose', 'bodytemp', 'height', 'bodyfat', 'sleep', 'measure', 'period', 'ovulation'] }, at: { type: 'integer', description: 'When, in ms since 1970 (default now).' } }, required: ['kind'], additionalProperties: true },
      call: async (a, api) => api('POST', '/api/entries', a),
    },
    {
      name: 'log_weight', scope: 'write', title: 'Log a weigh-in',
      description: 'Log a weigh-in in kg (also sent to Google Health when it is connected with the weight permission).',
      inputSchema: { type: 'object', properties: { kg: { type: 'number', minimum: 20, maximum: 400 }, at: { type: 'integer', description: 'When, in ms (default now; at most 30 days back).' }, note: { type: 'string', maxLength: 200 } }, required: ['kg'], additionalProperties: false },
      call: async (a, api) => api('POST', '/api/weight', a),
    },
    {
      name: 'sync_now', scope: 'write', title: 'Sync now',
      description: 'Fetch the newest data from Google Health now instead of waiting for the next automatic sync (at most once a minute).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async (_a, api) => api('POST', '/api/sync', {}),
    },
    {
      name: 'api_request', scope: 'write', title: 'Any change the API allows',
      description: 'A write the other tools do not cover, as the API allows a write key: PATCH or DELETE /api/entries/<id>, POST /api/workouts/log, PATCH /api/workouts/<id>, routines. The reference is https://health.ojee.net/developers/api.',
      inputSchema: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/api/' }, body: { type: 'object', additionalProperties: true } }, required: ['method', 'path'], additionalProperties: false },
      call: async (a, api) => api(a.method, a.path, a.body),
    },
  ];
}

/**
 * The /mcp route.
 *   handler   the app's own request handler (app.js), called in-process
 *   keyFor    bearer -> { id, userId, scope } | null
 */
export function createMcp({ handler, keyFor, version, origin, readRaw, send, log = () => {} }) {
  const all = tools();

  /** One API call as the key's owner; the JSON answer, or an Error with the API's message. */
  const callWith = (auth, ip) => async (method, path, body) => {
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(raw);
    Object.assign(req, { method, url: path, headers: { authorization: auth, host: 'mcp', 'content-type': 'application/json', 'x-forwarded-for': ip }, socket: { remoteAddress: ip } });
    const res = new Collect();
    const done = new Promise((resolve) => res.on('finish', resolve));
    await handler(req, res);
    await done;
    const text = Buffer.concat(res.chunks).toString('utf8');
    const type = String(res.head['content-type'] || '');
    const out = type.includes('json') ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text;
    if (res.statusCode >= 400) throw Object.assign(new Error(out?.error || `HTTP ${res.statusCode}`), { api: true, status: res.statusCode, code: out?.code });
    return out;
  };

  async function one(msg, key, api) {
    const id = msg?.id;
    const notify = id === undefined || id === null;
    const reply = (result) => (notify ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message, data) => (notify ? null : { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Not a JSON-RPC 2.0 request.');
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize': {
        const want = String(p.protocolVersion || '');
        return reply({
          protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'health.ojee.net', title: 'health.ojee.net', version: String(version) },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({
        tools: all.filter((t) => t.scope === 'read' || key.scope === 'write').map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.scope === 'read', destructiveHint: t.name === 'api_request', openWorldHint: false },
        })),
      });
      case 'tools/call': {
        const t = all.find((x) => x.name === p.name);
        if (!t) return fail(-32602, `There is no tool called ${p.name}.`);
        if (t.scope === 'write' && key.scope !== 'write') return fail(-32602, 'This key can only read. Make a key with write access in Settings, API and AI.');
        const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
        for (const r of t.inputSchema.required || []) if (args[r] === undefined) return fail(-32602, `${r} is required.`);
        try {
          const out = await t.call(args, api);
          let text = typeof out === 'string' ? out : JSON.stringify(out);
          if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters: ask for a shorter period]`;
          return reply({ content: [{ type: 'text', text }], ...(out && typeof out === 'object' && text.length <= MAX_TEXT ? { structuredContent: Array.isArray(out) ? { items: out } : out } : {}), isError: false });
        } catch (e) {
          // The API's own sentence goes back to the model, which can act on it.
          if (e.api) return reply({ content: [{ type: 'text', text: `${e.message}${e.code ? ` (${e.code}, HTTP ${e.status})` : ''}` }], isError: true });
          throw e;
        }
      }
      case 'resources/list': return reply({ resources: [] });
      case 'resources/templates/list': return reply({ resourceTemplates: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default:
        if (msg.method.startsWith('notifications/')) return null;
        return fail(-32601, `${msg.method} is not supported here.`);
    }
  }

  return async function mcp(req, res) {
    const authHeader = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(authHeader)?.[1] || null;
    const base = origin();
    const deny = (why) => send(res, 401, { error: why, code: 'bad_key' }, { 'www-authenticate': `Bearer realm="health.ojee.net", error="invalid_token", error_description="${why}"` });
    if (req.method === 'GET' || req.method === 'DELETE') {
      // No stream to open and no session to end: this server answers each POST in full.
      return send(res, 405, { error: `POST JSON-RPC to this address. How to connect: ${base}/developers`, code: 'bad_request' }, { allow: 'POST, OPTIONS' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.', code: 'bad_request' }, { allow: 'POST, OPTIONS' });
    if (!bearer) return deny(`An API key is needed: Authorization: Bearer hak_... Make one in Settings, API and AI (${base}/settings/api).`);
    const key = keyFor(bearer);
    if (!key) return deny('This API key is not valid. Make a new one in Settings, API and AI.');
    let body;
    try { body = JSON.parse((await readRaw(req, 256 * 1024)).toString('utf8')); } catch (e) {
      return send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Could not read the request as JSON: ${e.message}` } });
    }
    const ip = String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'mcp');
    const api = callWith(`Bearer ${bearer}`, ip);
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    if (!msgs.length || msgs.length > 20) return send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one message, or a batch of at most 20.' } });
    const out = [];
    for (const msg of msgs) {
      try { const r = await one(msg, key, api); if (r) out.push(r); } catch (e) {
        log(`mcp ${msg?.method} ${msg?.params?.name || ''}: ${e.stack || e.message}`);
        if (msg?.id !== undefined && msg?.id !== null) out.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Something went wrong on the server. Try again.' } });
      }
    }
    if (!out.length) { res.writeHead(202, { 'cache-control': 'no-store' }); return res.end(); }
    return send(res, 200, batch ? out : out[0]);
  };
}

export const TOOL_NAMES = tools().map((t) => ({ name: t.name, scope: t.scope, title: t.title, description: t.description }));
