/* ============================================================
   health.ojee.net — sleep score, readiness and resilience, made to
   match the Google Health app's.

   Google does not give these through its API and does not publish the
   formulas. These were worked out against one person's Google Takeout
   (Oct 2026, a Fitbit Air): Google's own scores and the inputs it
   exported for them, next to the same nights and days as our sync
   stores them. What is exact, what is fitted and what is a stand-in is
   said at each one.

   Sleep score (0-100; 90 excellent, 80 good, 60 fair, below poor).
     Google scores each night twice (sleep_session_v1 and _v2); the API,
     and so this app, gets v2, stage for stage the same as the export.
     The exported inputs and how they come from the stages (exact):
       time asleep         the session's minutes asleep
       WASO                minutes of every awake spell between the first
                           and the last sleep stage
       long wakes          the minutes of those spells of 3 min or more,
                           over 3 (Google's "waso_count_long_wakes")
       REM %               REM over (time asleep + WASO)
     The score is
       50 · min(1, asleep / goal)^0.351           duration
     + 9.06 + 0.328 · REM %        (up to 25)     composition
     + 25 − 0.219 · long wakes     (down to 0)    revitalization
     fitted to Google's v2 scores (20 nights): within 1.6 points on
     average on nights it was not fitted to (leave-one-out), 3.7 at
     worst. Deep sleep minutes add nothing on top. Google also uses
     restlessness (from the accelerometer, not in the API) and the
     share of the night's heart rate below the day's resting rate (an
     input we do not sync); both are left in the intercept, which costs
     about 10 points on a night where that share is far off, such as a
     device's first night. A night without stages has no score, as in
     Google's app. v1 does not follow this formula (about 3.5 high).

   Readiness (1-100; 65 high, 30 moderate, below low).
     Mostly HRV against the person's own baseline:
       z  = (HRV − mean of the 30 days before) / their spread
       65.1 + 10.9 · min(z, 0) + 26.0 · ramp(z, 1.06 → 1.69)
            − 1.55 · max(0, resting HR − its 30-day mean)
     so an ordinary day sits at 61-65, a high-HRV one climbs to about
     90, a low one falls. On 13 days it was within 0.9 on average (left
     out), 2.7 at worst. After a night without stages Google gave 65 on
     both such days, whatever the HRV; so does this. It starts with 7
     nights of HRV, as Google's did. Google's own "sleep" part read
     "very high" on every day here, so its weight cannot be seen; a
     small cut for a poor last night or week stands in for it.

   Resilience (Optimal, Balanced or Low; 65 and 35 here).
     Not in the export; matched to what the app showed (Low most days,
     falling over the first week, a small rise on Oct 15, creeping up
     to Oct 24, just Balanced on Oct 27-28, just under on Oct 29) from
     the inputs Google names:
       6.4 + 28 · HRV of the 7 nights before / of the 30 before
           − 99 · active calories a day over the 7 days before / basal
           + 6 · min(1, last night asleep / goal)
     The load term carries most of it: Google's chronic load seems to
     start from a typical day, so a new wearer who is busier than that
     reads low. Needs 3 worn days in the week before, 2 nights of HRV
     and last night's sleep.
   ============================================================ */

const fin = Number.isFinite;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** 0 at `a`, 1 at `b`, straight in between. */
const ramp = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (v) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : null);

/* ── sleep ─────────────────────────────────────────────────────────── */

export const SLEEP = { durExp: 0.351, comp0: 9.06, compRem: 0.328, revitWake: 0.219, longWakeMin: 3 };
export const SLEEP_PARTS = [['duration', 'Duration'], ['composition', 'Composition'], ['revitalization', 'Revitalization']];

const STAGE = (t) => String(t || '').toUpperCase();
const AWAKE = (t) => t === 'AWAKE' || t === 'WAKE';

/**
 * What Google's sleep score reads from one night, worked out from its
 * stages the way Google's export has them. Null when the night has no
 * stages (Google gives no score then either).
 */
export function sleepFacts(night) {
  if (!night || !fin(night.asleepMin) || night.asleepMin <= 0) return null;
  const st = (Array.isArray(night.stages) ? night.stages : []).map((x) => ({ s: Number(x.s ?? x.start ?? x.startMs), e: Number(x.e ?? x.end ?? x.endMs), t: STAGE(x.t ?? x.type ?? x.stage) }))
    .filter((x) => fin(x.s) && fin(x.e) && x.e > x.s).sort((a, b) => a.s - b.s);
  const sum = night.summary?.stages || {};
  const staged = st.some((x) => x.t === 'DEEP' || x.t === 'REM');
  if (!staged && !((sum.DEEP || 0) + (sum.REM || 0) > 0)) return null;
  const asleep = night.asleepMin;
  const min = (x) => (x.e - x.s) / 60_000;
  let deep; let rem; let waso; let longMin; let awakenings;
  if (staged) {
    const sleeping = st.filter((x) => !AWAKE(x.t));
    const first = sleeping[0].s; const last = sleeping.at(-1).e;
    const spells = st.filter((x) => AWAKE(x.t) && x.s >= first && x.e <= last).map(min);
    const long = spells.filter((m) => m >= SLEEP.longWakeMin);
    deep = st.filter((x) => x.t === 'DEEP').reduce((a, x) => a + min(x), 0);
    rem = st.filter((x) => x.t === 'REM').reduce((a, x) => a + min(x), 0);
    waso = spells.reduce((a, m) => a + m, 0);
    longMin = long.reduce((a, m) => a + m, 0);
    awakenings = long.length;
  } else {
    // Only the totals: the awake minutes not before sleep or after waking, all of them counted as long.
    deep = sum.DEEP || 0; rem = sum.REM || 0;
    waso = Math.max(0, (sum.AWAKE || sum.WAKE || 0) - (night.summary?.toFallAsleep || 0) - (night.summary?.afterWake || 0));
    longMin = waso; awakenings = null;
  }
  return {
    asleepMin: asleep, deepMin: Math.round(deep), remMin: Math.round(rem),
    remPct: r1((rem / (asleep + waso)) * 100), wasoMin: Math.round(waso), longWakeMin: Math.round(longMin), awakenings,
    longWakes: longMin / 3, remShare: (rem / (asleep + waso)) * 100,
  };
}

const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
const SLEEP_TEXT = {
  duration: (f, goalMin) => `${hm(f.asleepMin)} asleep of a ${hm(goalMin)} goal`,
  composition: (f) => `REM ${f.remPct}% of the night, deep ${f.deepMin} min`,
  revitalization: (f) => (f.longWakeMin ? `${f.longWakeMin} min awake in spells of 3 min or more` : 'No spells awake of 3 min or more'),
};

/** One night's sleep score with its parts: { score, band, parts, facts }. */
export function sleepScoreOf(night, { goalMin = 450 } = {}) {
  const f = sleepFacts(night);
  if (!f) return { score: null, band: null, parts: [], facts: null };
  const goal = goalMin > 0 ? goalMin : 450;
  const pts = {
    duration: 50 * Math.min(1, f.asleepMin / goal) ** SLEEP.durExp,
    composition: clamp(SLEEP.comp0 + SLEEP.compRem * f.remShare, 0, 25),
    revitalization: clamp(25 - SLEEP.revitWake * f.longWakes, 0, 25),
  };
  const parts = SLEEP_PARTS.map(([id, label]) => ({ id, label, points: r1(pts[id]), max: id === 'duration' ? 50 : 25, text: SLEEP_TEXT[id](f, goal) }));
  const score = Math.round(clamp(pts.duration + pts.composition + pts.revitalization, 0, 100));
  return { score, band: sleepBand(score), parts, facts: f };
}
export const sleepBand = (s) => (!fin(s) ? null : s >= 90 ? 'Excellent' : s >= 80 ? 'Good' : s >= 60 ? 'Fair' : 'Poor');

/* ── the person's own baselines ────────────────────────────────────── */

/** Values of a daily key on the days `from`..`to` before `date` (1 = yesterday). */
function back(table, key, date, addDays, from, to) {
  const v = [];
  for (let i = from; i <= to; i += 1) { const x = table[addDays(date, -i)]?.[key]; if (fin(x)) v.push(x); }
  return v;
}

/* ── readiness ─────────────────────────────────────────────────────── */

export const READY = { base: 65.1, low: 10.9, high: 26.0, from: 1.06, to: 1.69, rhr: 1.55, unstaged: 65 };

/** Readiness inputs for `date`, or null before 7 nights of HRV. */
export function readyX(table, date, addDays) {
  const row = table[date] || {};
  const hv = back(table, 'hrv', date, addDays, 1, 30);
  if (hv.length < 7) return null;
  const hb = mean(hv); const sd = Math.max(Math.sqrt(mean(hv.map((x) => (x - hb) ** 2))), 0.05 * hb);
  const rv = back(table, 'rhr', date, addDays, 1, 30);
  const week = back(table, 'sleep_score', date, addDays, 0, 6);
  return {
    z: fin(row.hrv) ? (row.hrv - hb) / sd : 0,
    rhrUp: fin(row.rhr) && rv.length >= 7 ? row.rhr - mean(rv) : 0,
    staged: fin(row.sleep_score),
    sleepLast: fin(row.sleep_score) ? row.sleep_score : null,
    sleepWeek: week.length ? mean(week) : null,
  };
}
/** Readiness out of 100 from readyX's inputs. */
export function readinessOf(x) {
  if (!x) return null;
  // A poor night or week takes some off (Google's sleep part never moved in the data, so this is a stand-in).
  const sleepCut = 0.5 * Math.max(0, 70 - (x.sleepLast ?? 70)) + 0.5 * Math.max(0, 75 - (x.sleepWeek ?? 75));
  const s = x.staged
    ? READY.base + READY.low * Math.min(x.z, 0) + READY.high * ramp(x.z, READY.from, READY.to) - READY.rhr * Math.max(0, x.rhrUp)
    : READY.unstaged;
  return Math.round(clamp(s - sleepCut, 1, 100));
}
export const readyBand = (s) => (!fin(s) ? null : s >= 65 ? 'High' : s >= 30 ? 'Moderate' : 'Low');

/* ── resilience ────────────────────────────────────────────────────── */

export const RESIL = { b: 6.4, hrv: 28, load: -99, sleep: 6, basal: 1700 };

/** Resilience inputs for `date`, or null without enough of the week behind it. */
export function resilX(table, date, addDays, { goalMin = 450 } = {}) {
  const row = table[date] || {};
  const worn = (i) => fin(table[addDays(date, -i)]?.hr_avg);
  let wornWeek = 0; for (let i = 1; i <= 7; i += 1) if (worn(i)) wornWeek += 1;
  const hv = back(table, 'hrv', date, addDays, 1, 30);
  if (wornWeek < 3 || hv.length < 2 || !fin(row.sleep_min)) return null;
  const hv7 = back(table, 'hrv', date, addDays, 1, 7);
  const basal = []; for (let i = 1; i <= 28; i += 1) { const b = table[addDays(date, -i)]?.kcal_basal; if (fin(b) && worn(i)) basal.push(b); }
  // A day without a number counts as nothing done.
  let active = 0; for (let i = 1; i <= 7; i += 1) { const a = table[addDays(date, -i)]?.kcal_active; if (fin(a)) active += a; }
  return {
    hrv: hv7.length ? mean(hv7) / mean(hv) : 1,
    load: active / 7 / (mean(basal) || RESIL.basal),
    sleep: Math.min(1, row.sleep_min / (goalMin > 0 ? goalMin : 450)),
  };
}
/** Resilience out of 100 from resilX's inputs. */
export function resilienceOf(x) {
  if (!x) return null;
  return Math.round(clamp(RESIL.b + RESIL.hrv * x.hrv + RESIL.load * x.load + RESIL.sleep * x.sleep, 0, 100));
}
export const resilLabel = (s, cut = { low: 35, high: 65 }) => (!fin(s) ? null : s >= cut.high ? 'Optimal' : s >= cut.low ? 'Balanced' : 'Low');
