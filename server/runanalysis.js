/* ============================================================
   health.ojee.net — one run, walk or ride read closely, for AI
   assistants (mcp.js get_workout, get_run_trends): what a coach
   would work out from the track and the heart rate, done here so a
   model need not pull every point to count it by eye.

   From a workout as GET /api/workouts/:id gives it: its track
   (tracks.js trackStats: splits, and a series of ~300 samples
   [metres, elevation, km/h over 30 s, seconds from track.t0, hr])
   and its heart-rate trace [[t, bpm, steps], ...].
   ============================================================ */

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r0 = (x) => (fin(x) ? Math.round(x) : null);
const r1 = (x) => (fin(x) ? Math.round(x * 10) / 10 : null);

/** Speeds (km/h): slower than `stop` is standing; under `walk` (or 80 % of the run's own median,
    if lower) is walking when there is no cadence to say; faster than `spike` is a GPS jump. */
const BANDS = {
  run: { stop: 2.5, walk: 6.5, spike: 25 },
  walk: { stop: 1.5, walk: null, spike: 12 },
  ride: { stop: 4, walk: null, spike: 80 },
};
/** Steps a minute: under WALK_SPM is walking, RUN_SPM or more is running; between, the speed says. */
const WALK_SPM = 130; const RUN_SPM = 150;
/** The watch counts steps a minute at a time, so a minute of walking and jogging reads 100-130:
    few steps say walking only below this speed (an uphill jog at 7.1-7.3 km/h is not a walk). */
const WALK_MAX_KMH = 7.0;
/** Shortest walk break, and shortest stop, that count. */
const MIN_WALK_S = 15; const MIN_STOP_S = 10;
/** Samples further apart than this are a gap in the data, not walking. */
const GAP_S = 30;
const sportOf = (type) => (/RUN|TREADMILL/.test(String(type)) && !/WALK/.test(String(type)) ? 'run' : /WALK|HIK/.test(String(type)) ? 'walk' : /BIK|RIDE|CYCL/.test(String(type)) ? 'ride' : null);
const median = (a) => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };

/** Heart rate at each series sample: the track's own, else the trace's nearest minute. */
function hrAlong(series, t0, trace) {
  const tr = (trace || []).filter((m) => fin(m[1]));
  let j = 0;
  return series.map((s) => {
    if (fin(s[4])) return s[4];
    if (!tr.length || !fin(t0)) return null;
    const t = t0 + s[3] * 1000;
    while (j < tr.length - 1 && Math.abs(tr[j + 1][0] - t) <= Math.abs(tr[j][0] - t)) j += 1;
    return Math.abs(tr[j][0] - t) <= 90_000 ? tr[j][1] : null;
  });
}

/** Steps a minute at each series sample, from the trace's minute it falls in; null when not known. */
function cadenceAlong(series, t0, trace, start, end) {
  const tr = (trace || []).filter((m) => fin(m[2]) && m[2] > 0 && m[0] >= start && m[0] + 60_000 <= end);
  if (tr.length < 3 || !fin(t0)) return series.map(() => null);
  let j = 0;
  return series.map((s) => {
    const t = t0 + s[3] * 1000;
    while (j < tr.length - 1 && tr[j + 1][0] <= t) j += 1;
    return tr[j][0] <= t && t < tr[j][0] + 60_000 ? tr[j][2] : null;
  });
}

/** Runs of samples in one state, as stretches: { state, fromS, toS, metres, secs }. */
function stretches(series, states) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const st = states[i];
    const last = out[out.length - 1];
    const dS = series[i][3] - series[i - 1][3]; const dM = series[i][0] - series[i - 1][0];
    if (last && last.state === st) { last.toS = series[i][3]; last.metres += dM; last.secs += dS; } else out.push({ state: st, fromS: series[i - 1][3], toS: series[i][3], metres: dM, secs: dS });
  }
  return out;
}

/**
 * A track's samples with their speed by the clock, and its GPS jumps: faster than the sport goes
 * at all, or a short burst (20 s or less) at twice the run's median speed (1.5 times in the 30 s
 * after a stop, as the fix catches up). Shared by the analysis and best times (medals.js), so a
 * stretch left out of one is left out of the other.
 * @returns {{ series, raw, fast, spikes: Array<{ atS, forS, fromS, toS }>, med }}
 */
export function gpsJumps(t, sport) {
  const B = BANDS[sport] || BANDS.run;
  const raw = Array.isArray(t?.series) ? t.series.filter((s) => fin(s[0]) && fin(s[3])) : [];
  // The series' own speed is over moving time, so a stop never shows in it: speed here is by the
  // clock, over the last ~20 s of samples (or one step when they are further apart).
  const series = raw.map((s, i) => {
    let j = i;
    while (j > 0 && s[3] - raw[j - 1][3] <= 20) j -= 1;
    if (j === i && i > 0) j = i - 1;
    const dt = s[3] - raw[j][3];
    return [s[0], s[1], dt > 0 && dt <= GAP_S * 2 ? ((s[0] - raw[j][0]) / dt) * 3.6 : null, s[3], s[4]];
  });
  if (series.length < 10) return { series, raw, fast: series.map(() => null), spikes: [], med: null };
  const going = series.map((s) => s[2]).filter((v) => fin(v) && v >= B.stop && v <= B.spike);
  const med = median(going);
  const afterStop = series.map((s, i) => { for (let k = i - 1; k >= 0 && s[3] - series[k][3] <= 30; k -= 1) if (fin(series[k][2]) && series[k][2] < B.stop) return true; return false; });
  const fast = series.map((s, i) => {
    const v = Math.max(fin(s[2]) ? s[2] : 0, fin(raw[i][2]) ? raw[i][2] : 0);
    if (v > B.spike) return 'abs';
    if (med && (v > 2 * med || (afterStop[i] && v > 1.5 * med))) return 'rel';
    return null;
  });
  const spikes = [];
  for (let i = 0; i < series.length; i += 1) {
    if (!fast[i]) continue;
    let k = i; while (k + 1 < series.length && fast[k + 1]) k += 1;
    const forS = series[k][3] - series[Math.max(0, i - 1)][3];
    // A relative burst is a jump only when short; held longer it is a real surge.
    if (fast.slice(i, k + 1).includes('abs') || forS <= 20) spikes.push({ atS: r0(series[i][3]), forS: r0(forS), fromS: series[Math.max(0, i - 1)][3], toS: series[k][3] });
    else for (let x = i; x <= k; x += 1) fast[x] = null;
    i = k;
  }
  return { series, raw, fast, spikes, med };
}

/** A track's best efforts ({ distanceM, label, timeS, at }) that do not cross a GPS jump, and those that do. */
export function effortsClear(t, sport) {
  const efforts = Array.isArray(t?.efforts) ? t.efforts : [];
  if (!efforts.length || !fin(t.t0)) return { kept: efforts, left: [] };
  const { spikes } = gpsJumps(t, sport);
  const crosses = (e) => { const a = (e.at - t.t0) / 1000; const b = a + e.timeS; return spikes.some((x) => x.toS >= a && x.fromS <= b); };
  return { kept: efforts.filter((e) => !crosses(e)), left: efforts.filter(crosses) };
}

/**
 * The close reading of one workout. `hrBand` [lo, hi]: also the pace while the heart rate was in it.
 * Moving time is the track's (tracks.js trackStats), the same the workout list and the page use:
 * pace is distance over it, the splits add up to it, and the stops to elapsed less it.
 * @returns {object|null} null when it is not a run, walk or ride with a track or a distance.
 */
export function analyse(w, { hrBand = null } = {}) {
  const sport = sportOf(w?.track?.type || w?.type);
  if (!sport) return null;
  const t = w.track || null;
  const elapsedS = r0(t?.elapsedS ?? (fin(w.end) && fin(w.start) ? (w.end - w.start) / 1000 : null));
  const distanceM = r0(t?.distanceM ?? w.distanceM);
  const trace = (w.trace || []).filter((m) => fin(m[1]) && m[0] >= w.start && m[0] <= (w.end ?? Infinity));
  const hrs = trace.map((m) => m[1]);
  const traceAvg = r0(avg(hrs));
  // One average heart rate: the watch's (the list's), else the trace's; both are given.
  const avgHr = r0(w.avgHr) ?? traceAvg;
  const movingS = r0(t?.movingS ?? null);
  const out = {
    sport,
    distanceM,
    // Where the distance came from: the watch's (Google's) and the GPS track's, when both are known.
    distanceSources: { watchM: r0(w.distanceM), gpsM: r0(t?.distanceM) },
    elapsedS, movingS,
    movingFrom: movingS ? 'track' : 'elapsed',
    paceSPerKm: null, avgHr, maxHr: r0(hrs.length ? Math.max(...hrs) : w.maxHr),
    hrSources: { avgFrom: fin(w.avgHr) ? 'watch' : traceAvg ? 'trace' : null, watchAvg: r0(w.avgHr), traceAvg },
    metresPerBeat: null, cardiacDriftPct: null, firstKm: null, restAfterFirstKm: null,
    stops: null, walkBreaks: null, longestRunning: null, gpsSpikes: 0, flags: [], notes: [],
  };
  const moving = movingS || elapsedS;
  if (distanceM > 0 && moving > 0 && sport !== 'ride') out.paceSPerKm = r0(moving / (distanceM / 1000));
  if (sport === 'ride' && distanceM > 0 && moving > 0) out.avgSpeedKmh = r1((distanceM / moving) * 3.6);
  // Metres for each heartbeat: the efficiency a fitter heart shows at the same effort.
  if (distanceM > 0 && avgHr > 0 && moving > 0) out.metresPerBeat = Math.round((distanceM / (avgHr * (moving / 60))) * 100) / 100;

  // Data that cannot be right.
  if (!(distanceM > 0)) out.flags.push('no_distance');
  if (sport === 'run' && out.paceSPerKm && (out.paceSPerKm < 150 || out.paceSPerKm > 1200)) out.flags.push('impossible_pace');
  if (sport === 'walk' && out.paceSPerKm && out.paceSPerKm < 300) out.flags.push('impossible_pace');
  if (elapsedS > 0 && movingS > 0 && movingS < elapsedS * 0.5) out.flags.push('mostly_stopped');

  // Stops: the track's own, so that with the short ones they make up elapsed less moving exactly.
  if (Array.isArray(t?.stops) && elapsedS && movingS) {
    const long = t.stops.filter((x) => x[1] >= MIN_STOP_S);
    const listed = long.reduce((n, x) => n + x[1], 0);
    const totalS = Math.max(0, elapsedS - movingS);
    out.stops = { count: long.length, totalS, listedS: r0(listed), shortS: Math.max(0, totalS - r0(listed)), list: long.slice(0, 30).map((x) => ({ atS: r0(x[0]), forS: r0(x[1]) })), note: `totalS is elapsed less moving; listed are stops of ${MIN_STOP_S} s or more (with the time before the first GPS fix and after the last), shortS the shorter pauses` };
  }

  const J = gpsJumps(t, sport);
  const { series, fast, spikes, med } = J;
  if (series.length >= 10) {
    const B = BANDS[sport];
    const hr = hrAlong(series, t.t0, w.trace);
    const spm = cadenceAlong(series, t.t0, w.trace, w.start, w.end ?? Infinity);
    const gap = series.map((s, i) => i > 0 && s[3] - series[i - 1][3] > GAP_S);
    out.gpsSpikes = spikes.length;
    out.gpsSpikeList = spikes.slice(0, 20).map(({ atS, forS }) => ({ atS, forS }));
    if (spikes.length && spikes.reduce((n, x) => n + x.forS, 0) > 0.05 * (elapsedS || 1)) out.flags.push('gps_spikes');
    else if (spikes.length) out.notes.push('gps_spikes_left_out_of_best_efforts');
    // Walking: 150 or more steps a minute is running whatever the speed (a slow climb); under 6.5 km/h
    // (or 80 % of the run's median, if lower) is walking; under 130 steps a minute below 7 km/h is
    // walking too. A gap in the data or a missing speed is neither.
    const walkV = B.walk ? Math.min(B.walk, med ? 0.8 * med : B.walk) : null;
    const states = series.map((s, i) => {
      if (gap[i]) return 'gap';
      if (!fin(s[2])) return 'unknown';
      if (s[2] < B.stop) return 'stopped';
      if (fast[i]) return 'moving';
      if (sport !== 'run') return 'moving';
      const c = spm[i];
      if (fin(c) && c >= RUN_SPM) return 'moving';
      if (s[2] < walkV) return 'walking';
      if (fin(c) && c < WALK_SPM && s[2] < WALK_MAX_KMH) return 'walking';
      return 'moving';
    });
    const parts = stretches(series, states);
    if (sport === 'run') {
      const walks = parts.filter((p) => p.state === 'walking' && p.secs >= MIN_WALK_S);
      out.walkBreaks = { count: walks.length, totalS: r0(walks.reduce((a, p) => a + p.secs, 0)), by: spm.some(fin) ? 'speed and cadence' : 'speed', list: walks.slice(0, 20).map((p) => ({ atS: r0(p.fromS), forS: r0(p.secs), metres: r0(p.metres) })) };
      // The longest stretch run without walking or stopping (short dips do not break it; a gap in the data does).
      let best = null; let cur = null;
      for (const p of parts) {
        const breaks = p.state === 'gap' || ((p.state === 'walking' || p.state === 'stopped') && p.secs >= (p.state === 'walking' ? MIN_WALK_S : MIN_STOP_S));
        if (breaks) { cur = null; continue; }
        cur = cur ? { fromS: cur.fromS, toS: p.toS, metres: cur.metres + p.metres } : { fromS: p.fromS, toS: p.toS, metres: p.metres };
        if (!best || cur.toS - cur.fromS > best.toS - best.fromS) best = { ...cur };
      }
      if (best) out.longestRunning = { fromS: r0(best.fromS), forS: r0(best.toS - best.fromS), metres: r0(best.metres) };
    }
    // The samples of steady going: moving (not walking, standing, a gap or a jump), with a heart rate.
    const steps = [];
    for (let i = 1; i < series.length; i += 1) {
      if (states[i] !== 'moving' || fast[i] || !fin(hr[i])) continue;
      const dm = series[i][0] - series[i - 1][0]; const ds = series[i][3] - series[i - 1][3];
      if (ds > 0 && dm >= 0) steps.push({ m: dm, s: ds, h: hr[i], at: series[i][3] });
    }
    const sum = (xs, k) => xs.reduce((n, x) => n + x[k], 0);
    // Cardiac drift (aerobic decoupling): speed per beat in the second half of the steady going
    // against the first. Only for an even effort: the two halves' pace within 10 %; else null, noted.
    if (steps.length >= 20 && sum(steps, 's') >= 20 * 60) {
      const half = sum(steps, 's') / 2;
      let acc = 0; let mid = 0;
      while (mid < steps.length && acc + steps[mid].s <= half) { acc += steps[mid].s; mid += 1; }
      const a1 = steps.slice(0, mid); const a2 = steps.slice(mid);
      const v1 = sum(a1, 'm') / sum(a1, 's'); const v2 = sum(a2, 'm') / sum(a2, 's');
      const h1 = sum(a1.map((x) => ({ w: x.h * x.s })), 'w') / sum(a1, 's'); const h2 = sum(a2.map((x) => ({ w: x.h * x.s })), 'w') / sum(a2, 's');
      if (v1 > 0 && v2 > 0 && h1 > 0 && h2 > 0) {
        const paceGap = Math.abs(v2 - v1) / Math.max(v1, v2);
        const uneven = paceGap > 0.10;
        // Low confidence: a heart rate that rose with a change of pace, or a run broken up by walking
        // (the heart settles in each walk, and the effort after it is not the same steady effort).
        const walkS = out.walkBreaks?.totalS || 0;
        const why = [];
        if (paceGap > 0.05) why.push(`the halves' pace differs by ${Math.round(paceGap * 100)} %`);
        if (moving > 0 && walkS > 0.15 * moving) why.push(`walking is ${Math.round((walkS / moving) * 100)} % of the moving time`);
        const longWalk = (out.walkBreaks?.list || []).find((x) => x.forS >= 180);
        if (longWalk) why.push(`a ${Math.round(longWalk.forS / 60)}-minute walk at ${Math.round(longWalk.atS / 60)} min`);
        if (uneven) out.notes.push('uneven_effort');
        else { const e1 = v1 / h1; const e2 = v2 / h2; out.cardiacDriftPct = r1(((e1 - e2) / e1) * 100); }
        out.driftHalves = {
          paceSPerKm: sport === 'ride' ? null : [r0(1000 / v1), r0(1000 / v2)], hr: [r0(h1), r0(h2)],
          steady: !uneven && !why.length,
          confidence: uneven ? null : why.length ? 'low' : 'normal',
          why: uneven ? [`the halves' pace differs by ${Math.round(paceGap * 100)} % (over 10 %: no drift given)`] : why,
          note: 'Halves of the steady running only (walking, stops and GPS jumps left out). Drift reads fitness only on an even effort: a heart rate that rose because the pace was pushed, or one reset by walks, is not drift.',
        };
        if (!uneven && why.length) out.notes.push('drift_low_confidence');
      }
    }
    // Pace while the heart rate was in a band (easy runs at 140-150, say): distance over time in it.
    if (Array.isArray(hrBand) && hrBand.length === 2) {
      const [lo, hi] = hrBand.map(Number);
      const inB = steps.filter((x) => x.h >= lo && x.h <= hi);
      const metres = r0(sum(inB, 'm')); const secs = r0(sum(inB, 's'));
      out.inHrBand = { band: [lo, hi], samples: inB.length, approxS: secs, metres, paceSPerKm: metres > 0 && sport !== 'ride' ? r0(secs / (metres / 1000)) : null, speedKmh: secs > 0 ? r1((metres / secs) * 3.6) : null,
        excludesWalking: true, excludesStops: true, definition: 'Distance over time while running with the heart rate in the band: walk breaks, stops, gaps in the GPS and GPS jumps are left out.' };
    }
  }
  // The first kilometre against the rest (a start too fast, or a long warm-up).
  const sp = (t?.splits || []).filter((x) => fin(x.paceSPerKm));
  if (sp.length >= 2 && !sp[0].partial) {
    const rest = sp.slice(1);
    const m = rest.reduce((a, x) => a + x.distanceM, 0); const s = rest.reduce((a, x) => a + x.movingS, 0);
    const hrRest = rest.filter((x) => fin(x.hr));
    out.firstKm = { paceSPerKm: sp[0].paceSPerKm, hr: sp[0].hr ?? null };
    out.restAfterFirstKm = { paceSPerKm: m > 0 ? r0((s / m) * 1000) : null, hr: hrRest.length ? r0(hrRest.reduce((a, x) => a + x.hr * x.distanceM, 0) / hrRest.reduce((a, x) => a + x.distanceM, 0)) : null };
  }
  if (t) out.elevation = { gainM: t.elevGainM ?? null, source: 'GPS or phone altitude as Google gives it, not a barometer: treat climb on flat routes with care' };
  // Best efforts that do not cross a GPS jump (best times, medals.js, leave out the same).
  if (Array.isArray(t?.efforts) && fin(t.t0)) {
    const { kept, left } = effortsClear(t, sport);
    out.bestEfforts = kept.map(({ distanceM: d, label, timeS }) => ({ distanceM: d, label, timeS, paceSPerKm: sport === 'ride' ? null : r0(timeS / (d / 1000)) }));
    if (left.length) out.bestEffortsLeftOut = { labels: left.map((e) => e.label), why: 'they cross a GPS jump' };
  }
  return out;
}

/** The ISO week a time falls in, in a time zone: "2026-W46". */
export function isoWeek(ms, tz) {
  const d = new Date(`${localDate(ms, tz)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  // The week's Thursday names its year; count weeks from that year's first day.
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** The civil date of a time in a zone, YYYY-MM-DD. */
export function localDate(ms, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms); } catch { return new Date(ms).toISOString().slice(0, 10); }
}

/** A time as ISO 8601 with the zone's offset: "2026-11-13T14:33:49-08:00". */
export function localIso(ms, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const off = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
    const sign = off < 0 ? '-' : '+'; const a = Math.abs(off);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  } catch { return new Date(ms).toISOString(); }
}
