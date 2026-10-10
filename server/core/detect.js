/* ============================================================
   ojee-health — workout detection. Pure functions, no I/O.

   Input is a minute-by-minute series from Google's physical-time
   roll-ups (heart-rate and steps, 60 s windows):

     [{ t: minute start (ms), hr: average bpm | null, steps }]

   A minute is ACTIVE when the heart rate is at least the resting
   baseline + N bpm and the wearer is not walking (fewer steps than
   `walkSteps` that minute) — lifting, not a stroll. Active minutes
   less than `calmMin` apart belong to one stretch, so the dips
   between sets, a minute walking to the next machine or a short gap
   in the data never split a session. A stretch is over once the data
   shows `calmMin` minutes with no active minute after it; until then
   it is ONGOING.

   Intervals that are already accounted for (an exercise from the Air
   or anything else in Google, sleep, a workout this module holds, a
   period the person said was "not a workout") are hard edges: their
   minutes never count, and a stretch on either side is judged alone.

   It answers one question — where the stretches are. When to ask,
   and what to remember, is the state machine in workouts.js.
   ============================================================ */

export const MIN = 60_000;

/** Detection settings and their bounds. Defaults are tuned on the wearer's
    own first gym day (desk 78–90 bpm on a resting 72; machines 103–146). */
export const DETECT_DEFAULTS = {
  enabled: true,
  plusBpm: 35,       // over the resting baseline (72 + 35 = 107 bpm)
  minStartMin: 10,   // active minutes before "started?" is asked
  minTotalMin: 20,   // a stretch shorter than this is not a workout
  calmMin: 10,       // this long without an active minute = ended
  walkSteps: 60,     // steps in a minute at or above this = walking, not lifting
  autoCloseMin: 60,  // a hand-started workout calm this long is closed for review
};
export const DETECT_BOUNDS = {
  plusBpm: [10, 60], minStartMin: [5, 30], minTotalMin: [10, 90], calmMin: [5, 30], walkSteps: [30, 140], autoCloseMin: [30, 240],
};

/** Settings from storage or a request, every number clamped to its bounds. */
export function detectSettings(raw = {}) {
  const out = { ...DETECT_DEFAULTS };
  if (raw.enabled !== undefined) out.enabled = raw.enabled === true || raw.enabled === 'true' || raw.enabled === 'on' || raw.enabled === 1;
  for (const [k, [lo, hi]] of Object.entries(DETECT_BOUNDS)) {
    if (raw[k] === undefined || raw[k] === '' || raw[k] === null) continue;
    const n = Math.round(Number(raw[k]));
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, n));
  }
  return out;
}

/** Merge HR and step roll-up windows into one sorted minute series. */
export function minuteSeries(hrWindows, stepWindows) {
  const m = new Map();
  const at = (t) => { const k = Math.floor(t / MIN) * MIN; if (!m.has(k)) m.set(k, { t: k, hr: null, hrMax: null, steps: 0 }); return m.get(k); };
  for (const w of hrWindows || []) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.avg)) continue;
    const x = at(w.start); x.hr = w.avg; x.hrMax = Number.isFinite(w.max) ? w.max : w.avg;
  }
  for (const w of stepWindows || []) {
    if (!Number.isFinite(w.start)) continue;
    at(w.start).steps += Number(w.steps) || 0;
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** The last minute the data reaches (end of the last minute with a heart rate). */
export function dataEnd(series) {
  for (let i = series.length - 1; i >= 0; i -= 1) if (series[i].hr !== null) return series[i].t + MIN;
  return null;
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

/**
 * The stretches of lifting-like effort in a series.
 * @param {Array<{t,hr,steps}>} series   sorted minutes
 * @param {object} o
 * @param {number} o.rest                 resting heart rate (bpm)
 * @param {Array<{start,end}>} [o.exclusions]
 * @param {number} [o.asOf]               the data's end; default: the last HR minute
 * @returns {Array<{start,end,activeMin,ongoing,avgHr,maxHr,steps,lastActive,cut}>}
 */
export function detect(series, o) {
  const s = { ...DETECT_DEFAULTS, ...o };
  const thr = s.rest + s.plusBpm;
  const ex = (o.exclusions || []).filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start);
  const asOf = o.asOf ?? dataEnd(series);
  const gap = s.calmMin * MIN;
  const out = [];
  let cur = null;
  const close = (cut) => { if (cur) { cur.cut = cut; out.push(cur); cur = null; } };
  for (const m of series) {
    if (ex.some((x) => overlaps(m.t, m.t + MIN, x.start, x.end))) { close(true); continue; }
    const active = m.hr !== null && m.hr >= thr && (m.steps || 0) < s.walkSteps;
    if (!active) continue;
    if (cur && m.t - cur.lastActive <= gap) {
      cur.lastActive = m.t; cur.activeMin += 1;
    } else {
      close(false);
      cur = { start: m.t, lastActive: m.t, activeMin: 1 };
    }
  }
  close(false);
  for (const g of out) {
    g.end = g.lastActive + MIN;
    // Over when an edge cut it, or when the data runs calmMin past it.
    g.ongoing = !g.cut && !(asOf !== null && asOf - g.end >= gap);
    let n = 0; let sum = 0; let mx = null; let steps = 0;
    for (const m of series) {
      if (m.t < g.start || m.t >= g.end) continue;
      steps += m.steps || 0;
      if (m.hr === null) continue;
      n += 1; sum += m.hr;
      const top = m.hrMax ?? m.hr;
      mx = mx === null ? top : Math.max(mx, top);
    }
    g.avgHr = n ? Math.round(sum / n) : null;
    g.maxHr = mx === null ? null : Math.round(mx);
    g.steps = Math.round(steps);
  }
  // A stretch only counts when most of it is effort: isolated spikes strung
  // together by the calm tolerance are a day at the desk, not a session.
  return out.filter((g) => g.activeMin / Math.max(1, (g.end - g.start) / MIN) >= 0.5);
}

/** Is a stretch long and dense enough to ask "started?" about. */
export const startWorthy = (g, s) => g.activeMin >= s.minStartMin;
/** Is a finished stretch a workout. */
export const workoutWorthy = (g, s) => g.activeMin >= s.minStartMin && (g.end - g.start) >= s.minTotalMin * MIN;

/**
 * Where a hand-started workout's effort stopped: the last active minute
 * after `from` (ignoring steps — the person said they are working out),
 * and whether the data shows them calm for `autoCloseMin` since.
 */
export function calmSince(series, { from, rest, plusBpm, autoCloseMin, asOf }) {
  const thr = rest + plusBpm;
  let last = null;
  for (const m of series) if (m.t >= from && m.hr !== null && m.hr >= thr) last = m.t + MIN;
  const end = asOf ?? dataEnd(series);
  const since = last ?? from;
  return { since, lastActive: last, calm: end !== null && end - since >= autoCloseMin * MIN };
}
