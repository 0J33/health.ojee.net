/* ============================================================
   health.ojee.net — sleep score, readiness and resilience, made to
   match the Google Health app's.

   Google does not give these through its API, and does not publish the
   weights. It does publish what goes into each, and the bands:

     Sleep score (0-100; 90 excellent, 80 good, 60 fair, below poor),
       from six things about the main night, each against a target:
       time asleep, time to sound sleep, sound sleep, restlessness
       (stirrings under 5 min), full awakenings (over 5 min) and
       interruptions (minutes of those). A night without stages has none.
     Readiness (0-100; 65 high, 30 moderate, below low), from HRV and
       resting heart rate against the person's own baseline and the
       week's sleep. Needs 7 nights first.
     Resilience (Optimal, Balanced, Low), from how the body responded
       yesterday (heart rate, HRV), exertion this week against the
       longer run, and sleep last night and over the week.

   So each is a weighted sum of those inputs, with starting weights that
   land where Google's typical scores do. Then it is fitted to the
   person's own Google numbers: they type in what the Google Health app
   showed for a few days (Match Google Health), and the weights move to
   the ones that reproduce those, held near the starting ones by a ridge
   penalty so a handful of days cannot send them anywhere strange. Every
   new pair fits again.
   ============================================================ */

const fin = Number.isFinite;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** 0 at `bad`, 1 at `good`, straight in between (either direction). */
const ramp = (x, bad, good) => (good === bad ? (x >= good ? 1 : 0) : clamp((x - bad) / (good - bad), 0, 1));
const r1 = (x) => Math.round(x * 10) / 10;

/* ── sleep ─────────────────────────────────────────────────────────── */

export const SLEEP_PARTS = [
  ['duration', 'Time asleep'], ['sound', 'Sound sleep'], ['settle', 'Time to sound sleep'],
  ['restless', 'Restlessness'], ['awakenings', 'Full awakenings'], ['interruptions', 'Interruptions'],
];
export const SLEEP_DEFAULT = { b: 0, w: { duration: 50, sound: 18, settle: 6, restless: 8, awakenings: 8, interruptions: 10 } };

const STAGE = (t) => String(t || '').toUpperCase();
/**
 * The six things about one night. Null when the night has no stages
 * (Google gives no score then either).
 */
export function sleepFacts(night) {
  if (!night || !fin(night.asleepMin) || night.asleepMin <= 0) return null;
  const st = (Array.isArray(night.stages) ? night.stages : []).map((x) => ({ s: Number(x.s ?? x.start ?? x.startMs), e: Number(x.e ?? x.end ?? x.endMs), t: STAGE(x.t ?? x.type ?? x.stage) }))
    .filter((x) => fin(x.s) && fin(x.e) && x.e > x.s).sort((a, b) => a.s - b.s);
  const staged = st.some((x) => x.t === 'DEEP' || x.t === 'REM');
  const sum = night.summary?.stages || {};
  if (!staged && !((sum.DEEP || 0) + (sum.REM || 0) > 0)) return null;
  const min = (x) => (x.e - x.s) / 60_000;
  const asleep = night.asleepMin;
  // Sound sleep: deep and REM, and light sleep in steady runs of 15 minutes or more.
  let sound = 0;
  if (st.length) for (const x of st) { if (x.t === 'DEEP' || x.t === 'REM') sound += min(x); else if (x.t === 'LIGHT' && min(x) >= 15) sound += min(x); }
  else sound = (sum.DEEP || 0) + (sum.REM || 0) + 0.5 * (sum.LIGHT || 0);
  // Time to sound sleep: from the start of the night to the first deep or REM, or steady light.
  const start = fin(night.startMs) ? night.startMs : st[0]?.s;
  const firstSound = st.find((x) => x.t === 'DEEP' || x.t === 'REM' || (x.t === 'LIGHT' && min(x) >= 15));
  const settle = firstSound && fin(start) ? Math.max(0, (firstSound.s - start) / 60_000) : fin(night.summary?.toFallAsleep) ? night.summary.toFallAsleep + 10 : 30;
  // Awake spells inside the night (not before the first sleep or after the last).
  const sleeping = st.filter((x) => x.t !== 'AWAKE' && x.t !== 'WAKE');
  const first = sleeping[0]?.s ?? start; const last = sleeping.at(-1)?.e ?? night.endMs;
  const inside = st.filter((x) => (x.t === 'AWAKE' || x.t === 'WAKE') && x.s >= first && x.e <= last);
  const long = inside.filter((x) => min(x) >= 5);
  const short = (fin(night.summary?.shortAwakenings) ? night.summary.shortAwakenings : 0) + inside.filter((x) => min(x) < 5).length;
  return {
    asleepMin: asleep, soundMin: Math.round(sound), settleMin: Math.round(settle),
    restlessPerHour: r1(short / Math.max(1, asleep / 60)), awakenings: long.length, interruptMin: Math.round(long.reduce((a, x) => a + min(x), 0)),
  };
}

/** The facts as 0..1 "how good", the inputs the model weighs. */
export function sleepX(f, { goalMin = 450 } = {}) {
  return {
    duration: f.asleepMin > goalMin + 90 ? clamp(1 - (f.asleepMin - goalMin - 90) / 300, 0.7, 1) : ramp(f.asleepMin, 180, goalMin),
    sound: ramp(f.soundMin, 90, 0.62 * goalMin),
    settle: ramp(f.settleMin, 75, 10),
    restless: ramp(f.restlessPerHour, 6, 0.8),
    awakenings: ramp(f.awakenings, 5, 0),
    interruptions: ramp(f.interruptMin, 75, 0),
  };
}

const SLEEP_TEXT = {
  duration: (f) => `${Math.floor(f.asleepMin / 60)}h ${String(Math.round(f.asleepMin % 60)).padStart(2, '0')}m asleep`,
  sound: (f) => `${Math.floor(f.soundMin / 60)}h ${String(f.soundMin % 60).padStart(2, '0')}m of sound sleep`,
  settle: (f) => `${f.settleMin} min to sound sleep`,
  restless: (f) => `${f.restlessPerHour} brief stirrings an hour`,
  awakenings: (f) => (f.awakenings ? `${f.awakenings} full ${f.awakenings === 1 ? 'awakening' : 'awakenings'}` : 'No full awakenings'),
  interruptions: (f) => (f.interruptMin ? `${f.interruptMin} min awake in the night` : 'No time awake in the night'),
};

/** One night's sleep score with its parts: { score, band, parts, facts }. */
export function sleepScoreOf(night, { goalMin = 450, model = SLEEP_DEFAULT } = {}) {
  const f = sleepFacts(night);
  if (!f) return { score: null, band: null, parts: [], facts: null };
  const x = sleepX(f, { goalMin });
  const w = { ...SLEEP_DEFAULT.w, ...(model?.w || {}) };
  const parts = SLEEP_PARTS.map(([id, label]) => ({ id, label, points: r1(w[id] * x[id]), max: r1(w[id]), text: SLEEP_TEXT[id](f) }));
  const score = Math.round(clamp((model?.b || 0) + parts.reduce((a, p) => a + w[p.id] * x[p.id], 0), 0, 100));
  return { score, band: sleepBand(score), parts, facts: f, x };
}
export const sleepBand = (s) => (!fin(s) ? null : s >= 90 ? 'Excellent' : s >= 80 ? 'Good' : s >= 60 ? 'Fair' : 'Poor');

/* ── readiness ─────────────────────────────────────────────────────── */

export const READY_KEYS = ['hrv', 'rhr', 'sleepWeek', 'sleepLast'];
export const READY_DEFAULT = { b: 68, w: { hrv: 90, rhr: -2.6, sleepWeek: 70, sleepLast: 25 } };

/** The person's own baseline of a daily key: the 30 days before `date`, with at least 7. */
function base(table, key, date, addDays) {
  const v = [];
  for (let i = 1; i <= 30; i += 1) { const x = table[addDays(date, -i)]?.[key]; if (fin(x)) v.push(x); }
  if (v.length < 7) return null;
  return v.reduce((a, x) => a + x, 0) / v.length;
}
function sleepWeek(table, date, addDays) {
  const v = [];
  for (let i = 0; i < 7; i += 1) { const x = table[addDays(date, -i)]?.sleep_score; if (fin(x)) v.push(x); }
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
}

/** Readiness inputs for `date` (centred: 0 means "as usual"), or null without enough history. */
export function readyX(table, date, addDays) {
  const row = table[date] || {};
  const hb = base(table, 'hrv', date, addDays); const rb = base(table, 'rhr', date, addDays);
  if (hb === null && rb === null) return null;
  const sw = sleepWeek(table, date, addDays);
  const last = row.sleep_score;
  const nights = Object.keys(table).filter((d) => d <= date && fin(table[d]?.sleep_min)).length;
  if (nights < 7) return null;
  return {
    hrv: fin(row.hrv) && hb ? clamp((row.hrv - hb) / hb, -0.6, 0.6) : 0,
    rhr: fin(row.rhr) && rb ? clamp(row.rhr - rb, -12, 12) : 0,
    sleepWeek: fin(sw) ? (sw - 75) / 100 : 0,
    sleepLast: fin(last) ? (last - 75) / 100 : 0,
  };
}
export const readyBand = (s) => (!fin(s) ? null : s >= 65 ? 'High' : s >= 30 ? 'Moderate' : 'Low');

/* ── resilience ────────────────────────────────────────────────────── */

export const RESIL_KEYS = ['hr', 'hrv', 'exertion', 'sleepWeek', 'sleepLast'];
export const RESIL_DEFAULT = { b: 58, w: { hr: -140, hrv: 70, exertion: -30, sleepWeek: 60, sleepLast: 30 } };
export const RESIL_TARGET = { Low: 20, Balanced: 50, Optimal: 80 };

/** Resilience inputs for `date`: yesterday's response, the week's exertion against the month, sleep. */
export function resilX(table, date, addDays) {
  const y = addDays(date, -1);
  const row = table[date] || {}; const yr = table[y] || {};
  const hb = base(table, 'hr_avg', y, addDays); const vb = base(table, 'hrv', date, addDays);
  const load = (d) => { const r = table[d] || {}; return fin(r.cardio_min) ? r.cardio_min : fin(r.azm) ? r.azm : fin(r.active_min) ? r.active_min : null; };
  let week = 0; let weekN = 0; let month = 0; let monthN = 0;
  for (let i = 1; i <= 28; i += 1) { const v = load(addDays(date, -i)); if (v === null) continue; if (i <= 7) { week += v; weekN += 1; } month += v; monthN += 1; }
  if (hb === null && vb === null && monthN < 14) return null;
  const ratio = weekN && monthN >= 14 && month > 0 ? (week / weekN) / (month / monthN) : 1;
  const sw = sleepWeek(table, date, addDays);
  return {
    hr: fin(yr.hr_avg) && hb ? clamp((yr.hr_avg - hb) / hb, -0.3, 0.3) : 0,
    hrv: fin(row.hrv) && vb ? clamp((row.hrv - vb) / vb, -0.6, 0.6) : 0,
    exertion: clamp(ratio - 1, -1, 2),
    sleepWeek: fin(sw) ? (sw - 75) / 100 : 0,
    sleepLast: fin(row.sleep_score) ? (row.sleep_score - 75) / 100 : 0,
  };
}
export const resilLabel = (s, cut = { low: 35, high: 65 }) => (!fin(s) ? null : s >= cut.high ? 'Optimal' : s >= cut.low ? 'Balanced' : 'Low');

/* ── the models ────────────────────────────────────────────────────── */

export const DEFAULTS = { sleep: SLEEP_DEFAULT, ready: READY_DEFAULT, resil: RESIL_DEFAULT };
export const KEYS = { sleep: SLEEP_PARTS.map(([k]) => k), ready: READY_KEYS, resil: RESIL_KEYS };

/** A model applied: b + Σ w·x, clamped to 0..100. */
export function apply(kind, x, model) {
  if (!x) return null;
  const m = model || DEFAULTS[kind];
  const w = { ...DEFAULTS[kind].w, ...(m.w || {}) };
  let s = m.b ?? DEFAULTS[kind].b;
  for (const k of KEYS[kind]) s += (w[k] || 0) * (x[k] || 0);
  return Math.round(clamp(s, kind === 'ready' ? 1 : 0, 100));
}

/** Solve A θ = y (small, dense, Gaussian elimination with pivoting). */
function solve(A, y) {
  const n = y.length; const M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r += 1) { if (r === c) continue; const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j += 1) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Fit a model to the person's own Google numbers: ridge regression held
 * near the starting weights. `pairs` is [{ x, y }]. Each weight's pull
 * back is scaled to how much its input moves, so all of them are held
 * alike. Returns { b, w, n, mae } (mae in points, on the pairs).
 */
export function fit(kind, pairs, { lambda = 1.5 } = {}) {
  const keys = KEYS[kind]; const d0 = DEFAULTS[kind];
  const rows = pairs.filter((p) => p.x && fin(p.y));
  if (rows.length < 3) return { ...d0, n: rows.length, mae: null, fitted: false };
  const n = keys.length + 1;
  // The spread of each input over the pairs (so the penalty is fair to every unit).
  const spread = keys.map((k) => { const v = rows.map((r) => r.x[k] || 0); const m = v.reduce((a, x) => a + x, 0) / v.length; return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) || 0.05; });
  const A = Array.from({ length: n }, () => new Array(n).fill(0)); const y = new Array(n).fill(0);
  for (const r of rows) {
    const v = [1, ...keys.map((k) => r.x[k] || 0)];
    for (let i = 0; i < n; i += 1) { y[i] += v[i] * r.y; for (let j = 0; j < n; j += 1) A[i][j] += v[i] * v[j]; }
  }
  const prior = [d0.b, ...keys.map((k) => d0.w[k])];
  // The intercept is held too, more loosely; each weight by its input's spread.
  const pen = [lambda * 0.05, ...spread.map((s) => lambda * s * s * rows.length / 4)];
  for (let i = 0; i < n; i += 1) { A[i][i] += pen[i]; y[i] += pen[i] * prior[i]; }
  const th = solve(A, y);
  if (!th || th.some((t) => !fin(t))) return { ...d0, n: rows.length, mae: null, fitted: false };
  const model = { b: th[0], w: Object.fromEntries(keys.map((k, i) => [k, th[i + 1]])) };
  // A weight that turned the wrong way (more sleep making it worse) goes back to the starting one.
  for (const k of keys) if (Math.sign(model.w[k]) !== Math.sign(d0.w[k]) && d0.w[k] !== 0) model.w[k] = d0.w[k] * 0.25;
  const errs = rows.map((r) => Math.abs(apply(kind, r.x, model) - r.y));
  return { ...model, n: rows.length, mae: r1(errs.reduce((a, e) => a + e, 0) / errs.length), fitted: true };
}
