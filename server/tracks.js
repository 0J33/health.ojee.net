/* ============================================================
   health.ojee.net — routes: a run, a ride, a walk or a hike recorded
   with the phone's GPS, or brought in as a GPX file.

   A track is points [t (ms), lat, lng, altitude m | null, accuracy m |
   null] and the pauses in it. From them come what a running or riding app
   shows: distance, moving time, pace or speed, elevation gained and lost,
   a split for each kilometre, the fastest stretches (1 km, 5 km, 10 km,
   half and full marathon for runs; 10, 20, 40 km for rides), and series
   to draw (pace or speed and elevation against distance). The route is
   drawn on a map of OpenStreetMap tiles (server/tiles.js).
   ============================================================ */

const R = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;
/** Metres between two points. */
export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]); const dLng = rad(b[2] - a[2]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request', expose: true });
const fin = Number.isFinite;

/** What each kind of route is, for the numbers it shows and how it is saved. */
export const ROUTE_TYPES = {
  RUNNING: { label: 'Run', pace: true, maxSpeed: 12, efforts: [[1000, '1 km'], [1609, '1 mile'], [5000, '5 km'], [10000, '10 km'], [21097, 'Half marathon'], [42195, 'Marathon']] },
  WALKING: { label: 'Walk', pace: true, maxSpeed: 4, efforts: [[1000, '1 km'], [5000, '5 km']] },
  HIKING: { label: 'Hike', pace: true, maxSpeed: 4, efforts: [[1000, '1 km'], [5000, '5 km'], [10000, '10 km']] },
  BIKING: { label: 'Ride', pace: false, maxSpeed: 30, efforts: [[10000, '10 km'], [20000, '20 km'], [40000, '40 km'], [100000, '100 km']] },
  MOUNTAIN_BIKE: { label: 'Mountain bike ride', pace: false, maxSpeed: 25, efforts: [[5000, '5 km'], [10000, '10 km']] },
  ROLLERBLADING: { label: 'Skate', pace: false, maxSpeed: 15, efforts: [[5000, '5 km'], [10000, '10 km']] },
  SKIING: { label: 'Ski', pace: false, maxSpeed: 35, efforts: [] },
  ROWING: { label: 'Row', pace: true, maxSpeed: 7, efforts: [[500, '500 m'], [2000, '2 km'], [5000, '5 km']] },
  SWIMMING_OPEN_WATER: { label: 'Open-water swim', pace: true, maxSpeed: 3, efforts: [[400, '400 m'], [1000, '1 km']] },
};
export const routeType = (t) => (ROUTE_TYPES[t] ? t : 'RUNNING');

/** Points as sent, checked and sorted; the clearly wrong ones dropped. */
export function cleanPoints(raw, { type = 'RUNNING' } = {}) {
  if (!Array.isArray(raw)) throw bad('points must be a list.');
  if (raw.length > 60_000) throw bad('At most 60,000 points in one route.');
  const pts = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const [t, lat, lng, alt = null, acc = null, hr = null] = p.map((v) => (v === null || v === undefined ? null : Number(v)));
    if (!fin(t) || !fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (fin(acc) && acc > 60) continue;   // a fix worse than 60 m is noise
    const pt = [Math.round(t), Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, fin(alt) ? Math.round(alt * 10) / 10 : null, fin(acc) ? Math.round(acc) : null];
    if (fin(hr) && hr > 20 && hr < 250) pt.push(Math.round(hr));   // heart rate, when the recording has it
    pts.push(pt);
  }
  pts.sort((a, b) => a[0] - b[0]);
  // Jumps faster than the activity could go are glitches.
  const max = (ROUTE_TYPES[routeType(type)].maxSpeed || 30) * 2;
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && p[0] === prev[0]) continue;
    if (prev && haversine(prev, p) / Math.max(1, (p[0] - prev[0]) / 1000) > max) continue;
    out.push(p);
  }
  return out;
}

export function cleanPauses(raw, start, end) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => Array.isArray(x) && fin(Number(x[0])) && fin(Number(x[1])) && Number(x[1]) > Number(x[0]))
    .map(([a, b]) => [Math.max(start, Math.round(Number(a))), Math.min(end, Math.round(Number(b)))])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]).slice(0, 500);
}

const inPause = (t, pauses) => pauses.some(([a, b]) => t > a && t <= b);

/** Altitude averaged over a minute (30 s each side), then counted only past a 5 m change:
    a watch's GPS altitude wanders by metres a second, and every wobble is not a climb. */
function climb(points) {
  const idx = points.map((p, i) => (fin(p[3]) ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return { gain: null, loss: null, min: null, max: null };
  const sm = timeAverage(idx.map((i) => [points[i][0], points[i][3]]), 30_000).map((x) => x[1]);
  let gain = 0; let loss = 0; let ref = sm[0];
  for (const a of sm) {
    if (a - ref >= 5) { gain += a - ref; ref = a; } else if (ref - a >= 5) { loss += ref - a; ref = a; }
  }
  return { gain: Math.round(gain), loss: Math.round(loss), min: Math.round(Math.min(...sm)), max: Math.round(Math.max(...sm)) };
}

/** Each [t, ...values] averaged with its neighbours within `win` ms either side (two pointers, one pass). */
function timeAverage(rows, win) {
  const n = rows.length; const k = rows[0].length - 1;
  const sum = new Array(k).fill(0); const out = [];
  let lo = 0; let hi = 0;
  for (let i = 0; i < n; i += 1) {
    const t = rows[i][0];
    while (hi < n && rows[hi][0] <= t + win) { for (let c = 0; c < k; c += 1) sum[c] += rows[hi][c + 1]; hi += 1; }
    while (rows[lo][0] < t - win) { for (let c = 0; c < k; c += 1) sum[c] -= rows[lo][c + 1]; lo += 1; }
    out.push([t, ...sum.map((v) => v / (hi - lo))]);
  }
  return out;
}

/* Moving: faster than this (m/s) over the last 10 seconds. A runner waiting at a light, or
   a phone on a bench, is stopped; a slow walk up a hill is not. */
const MOVING = { WALKING: 0.5, HIKING: 0.4, RUNNING: 0.9, BIKING: 1.5, MOUNTAIN_BIKE: 1.2, ROLLERBLADING: 1.2, SKIING: 1, ROWING: 0.5, SWIMMING_OPEN_WATER: 0.2 };

/**
 * Everything a route adds up to.
 * @param {object} track { type, points, pauses, start, end }
 */
export function trackStats({ type, points, pauses = [], start, end, distanceM: known = null }) {
  const T = ROUTE_TYPES[routeType(type)];
  const minV = MOVING[routeType(type)] ?? 0.5;
  const elapsedS = Math.round(((end ?? points.at(-1)?.[0] ?? 0) - (start ?? points[0]?.[0] ?? 0)) / 1000);
  // Positions averaged over 10 s (5 s each side) before measuring: a watch's fix wobbles a few
  // metres every second, and summed second by second that wobble adds 2–3 % to a run.
  // Sparse tracks (a fix every 10 s or more) are left as they are.
  const sm = points.length > 2 ? timeAverage(points.map((p) => [p[0], p[1], p[2]]), 5_000) : points.map((p) => [p[0], p[1], p[2]]);
  // Cumulative distance and moving time along the route.
  const cum = [0]; const mov = [0];
  let distance = 0; let moving = 0; let maxSpeed = 0;
  for (let i = 1, j = 0; i < points.length; i += 1) {
    const a = sm[i - 1]; const b = sm[i];
    const dt = (b[0] - a[0]) / 1000;
    let d = haversine(a, b);
    // A pause is not part of the route.
    const paused = inPause(b[0], pauses);
    if (paused) d = 0;
    distance += d;
    cum.push(distance);
    // Moving: the speed over the last 10 seconds (one step when the fixes are further apart),
    // never reaching back over a pause or a gap in the signal.
    let v;
    if (paused || dt >= 10) { v = dt > 0 ? d / dt : 0; j = i; } else {
      while (j < i - 1 && sm[i][0] - sm[j + 1][0] >= 10_000) j += 1;
      const span = (sm[i][0] - sm[j][0]) / 1000;
      v = span > 0 ? (cum[i] - cum[j]) / span : 0;
    }
    if (dt > 0 && dt <= 60 && v >= minV) moving += dt;
    else if (dt > 60 && d / dt >= minV) moving += d / Math.max(d / dt, minV);   // a gap: only the time the distance took
    mov.push(moving);
  }
  // The watch's own distance, when there is one and it is near the track's: the watch measured it
  // with more than the points it shares, and it is the number the person sees on the watch.
  if (fin(known) && known > 0 && distance > 0 && Math.abs(known / distance - 1) <= 0.15) {
    const f = known / distance;
    for (let i = 0; i < cum.length; i += 1) cum[i] *= f;
    distance = known;
  }
  // Top speed over at least 10 seconds, so one bad fix is not it.
  for (let i = 0, j = 0; i < points.length; i += 1) {
    while (j < i && points[i][0] - points[j][0] > 10_000) j += 1;
    const dt = (points[i][0] - points[j][0]) / 1000;
    if (dt >= 10) maxSpeed = Math.max(maxSpeed, (cum[i] - cum[j]) / dt);
  }
  // Splits: each whole kilometre, and what is left.
  const splits = [];
  let next = 1000; let i0 = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (cum[i] >= next || i === points.length - 1) {
      const last = cum[i] < next;
      const dist = cum[i] - cum[i0];
      if (dist < 50 && last) break;
      const s = mov[i] - mov[i0];
      const a0 = points[i0][3]; const a1 = points[i][3];
      const hrs = points.slice(i0 + 1, i + 1).map((p) => p[5]).filter(fin);
      splits.push({ hr: hrs.length ? Math.round(hrs.reduce((a, v) => a + v, 0) / hrs.length) : null, n: splits.length + 1, distanceM: Math.round(dist), movingS: Math.round(s), paceSPerKm: dist > 0 ? Math.round((s / dist) * 1000) : null, speedKmh: s > 0 ? Math.round((dist / s) * 36) / 10 : null, elevM: fin(a0) && fin(a1) ? Math.round(a1 - a0) : null, partial: last });
      i0 = i; next += 1000;
    }
  }
  // Fastest stretch of each standard distance (two pointers on time).
  const efforts = [];
  for (const [d, label] of T.efforts) {
    if (distance < d) continue;
    let bestT = Infinity; let at = null;
    for (let i = 0, j = 0; i < points.length; i += 1) {
      while (j < i && cum[i] - cum[j + 1] >= d) j += 1;
      if (cum[i] - cum[j] >= d) {
        const t = ((points[i][0] - points[j][0]) / 1000) * (d / (cum[i] - cum[j]));
        if (t < bestT) { bestT = t; at = points[j][0]; }
      }
    }
    if (fin(bestT)) efforts.push({ distanceM: d, label, timeS: Math.round(bestT), at });
  }
  const c = climb(points);
  const avgSpeed = moving > 0 ? distance / moving : null;
  return {
    type: routeType(type), label: T.label, pace: T.pace,
    distanceM: Math.round(distance), movingS: Math.round(moving), elapsedS,
    avgSpeedKmh: avgSpeed ? Math.round(avgSpeed * 36) / 10 : null, maxSpeedKmh: maxSpeed ? Math.round(maxSpeed * 36) / 10 : null,
    paceSPerKm: avgSpeed ? Math.round(1000 / avgSpeed) : null,
    elevGainM: c.gain, elevLossM: c.loss, elevMinM: c.min, elevMaxM: c.max,
    splits, efforts, points: points.length,
    series: seriesOf(points, cum, mov),
  };
}

/** About 300 samples along the route: distance, elevation, speed (smoothed over 30 s). */
function seriesOf(points, cum, mov) {
  if (points.length < 2) return [];
  const step = Math.max(1, Math.floor(points.length / 300));
  const out = [];
  for (let i = 0, j = 0; i < points.length; i += step) {
    while (j < i && points[i][0] - points[j][0] > 30_000) j += 1;
    const dt = mov[i] - mov[j];
    const v = dt > 5 ? (cum[i] - cum[j]) / dt : null;
    out.push([Math.round(cum[i]), points[i][3] ?? null, v === null ? null : Math.round(v * 36) / 10, Math.round((points[i][0] - points[0][0]) / 1000), points[i][5] ?? null]);
  }
  return out;
}

/** At most `max` points of the route, for drawing: [[lat, lng], ...]. */
export function routeLine(points, max = 600) {
  const step = Math.max(1, Math.ceil(points.length / max));
  const out = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => [p[1], p[2]]);
  return out;
}

export function boundsOf(points) {
  if (!points.length) return null;
  let s = 90; let w = 180; let n = -90; let e = -180;
  for (const p of points) { s = Math.min(s, p[1]); n = Math.max(n, p[1]); w = Math.min(w, p[2]); e = Math.max(e, p[2]); }
  return { s, w, n, e };
}

/* ── GPX ──────────────────────────────────────────────────────────── */

const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const GPX_TYPE = { RUNNING: 'running', WALKING: 'walking', HIKING: 'hiking', BIKING: 'cycling', MOUNTAIN_BIKE: 'cycling', ROWING: 'rowing', SKIING: 'skiing', ROLLERBLADING: 'inline_skating', SWIMMING_OPEN_WATER: 'swimming' };

export function toGpx({ title, type, points, pauses = [] }) {
  // A pause ends a track segment.
  const segs = [[]];
  for (const p of points) {
    if (segs.at(-1).length && pauses.some(([a, b]) => segs.at(-1).at(-1)[0] <= a && p[0] >= b)) segs.push([]);
    segs.at(-1).push(p);
  }
  const pt = (p) => `<trkpt lat="${p[1]}" lon="${p[2]}">${fin(p[3]) ? `<ele>${p[3]}</ele>` : ''}<time>${new Date(p[0]).toISOString()}</time></trkpt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="health.ojee.net" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xmlEsc(title || 'Route')}</name><time>${new Date(points[0]?.[0] || Date.now()).toISOString()}</time></metadata>
<trk><name>${xmlEsc(title || 'Route')}</name><type>${GPX_TYPE[type] || 'running'}</type>
${segs.filter((s) => s.length).map((s) => `<trkseg>\n${s.map(pt).join('\n')}\n</trkseg>`).join('\n')}
</trk>
</gpx>
`;
}

/** A TCX file's track points (Google's exportExerciseTcx, Garmin's TCX): [[t, lat, lng, alt, null, hr?]]. Laps run on; points without a position are skipped. */
export function fromTcx(text) {
  const s = String(text || '');
  if (!/<TrainingCenterDatabase[\s>]/i.test(s)) throw bad('That is not a TCX file.');
  const points = [];
  for (const m of s.matchAll(/<Trackpoint>([\s\S]*?)<\/Trackpoint>/gi)) {
    const b = m[1];
    const t = Date.parse(/<Time>([^<]+)<\/Time>/i.exec(b)?.[1] || '');
    const lat = Number(/<LatitudeDegrees>([^<]+)<\/LatitudeDegrees>/i.exec(b)?.[1]);
    const lng = Number(/<LongitudeDegrees>([^<]+)<\/LongitudeDegrees>/i.exec(b)?.[1]);
    const alt = /<AltitudeMeters>([^<]+)<\/AltitudeMeters>/i.exec(b)?.[1];
    const hr = /<HeartRateBpm>\s*<Value>([^<]+)<\/Value>/i.exec(b)?.[1];
    if (!fin(t) || !fin(lat) || !fin(lng)) continue;
    const p = [t, lat, lng, alt === undefined ? null : Number(alt), null];
    if (hr !== undefined) p.push(Number(hr));
    points.push(p);
  }
  return points.sort((a, b) => a[0] - b[0]);
}

/** A GPX file's track: { title, type, points, pauses }. Gaps between segments are pauses. */
export function fromGpx(text) {
  const s = String(text || '');
  if (!/<gpx[\s>]/i.test(s)) throw bad('That is not a GPX file.');
  const name = /<trk>[\s\S]*?<name>([^<]{1,120})<\/name>/i.exec(s)?.[1] || /<metadata>[\s\S]*?<name>([^<]{1,120})<\/name>/i.exec(s)?.[1] || null;
  const kind = (/<trk>[\s\S]*?<type>([^<]{1,40})<\/type>/i.exec(s)?.[1] || '').toLowerCase();
  const type = /cycl|bik|ride/.test(kind) ? 'BIKING' : /hik/.test(kind) ? 'HIKING' : /walk/.test(kind) ? 'WALKING' : /row/.test(kind) ? 'ROWING' : /swim/.test(kind) ? 'SWIMMING_OPEN_WATER' : /ski/.test(kind) ? 'SKIING' : 'RUNNING';
  const points = []; const pauses = [];
  const segs = s.split(/<trkseg[\s>]/i).slice(1);
  for (const seg of segs) {
    const first = points.length;
    for (const m of seg.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>|<trkpt\b([^>]*)\/>/gi)) {
      const attrs = m[1] || m[3] || '';
      const lat = Number(/lat\s*=\s*["']([^"']+)/i.exec(attrs)?.[1]);
      const lng = Number(/lon\s*=\s*["']([^"']+)/i.exec(attrs)?.[1]);
      const body = m[2] || '';
      const t = Date.parse(/<time>([^<]+)<\/time>/i.exec(body)?.[1] || '');
      const ele = /<ele>([^<]+)<\/ele>/i.exec(body)?.[1];
      if (fin(lat) && fin(lng) && fin(t)) points.push([t, lat, lng, ele === undefined ? null : Number(ele), null]);
    }
    if (first > 0 && points.length > first) pauses.push([points[first - 1][0], points[first][0]]);
  }
  if (points.length < 2) throw bad('The GPX file has no timed track points.');
  return { title: name ? name.replace(/&amp;/g, '&').trim() : null, type, points, pauses };
}
