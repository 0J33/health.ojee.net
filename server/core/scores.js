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
     Refitted (v183) to the scores the Google Health app SHOWS, read off
     its 30-day chart for 24 nights (Oct 8 - Nov 3 2026, a Fitbit Air).
     They are not the Takeout's: the same nights scored 94 and 84 there
     and 77 and 58 in the app, so the old fit (to the Takeout's v2) read
     about 13 high. What the app's number follows:
       72 · min(1, asleep / 660)^0.6          time asleep (up to 72)
     + 14 − 0.0373 · minutes awake            restfulness (down to 0)
     where "minutes awake" is every awake stage of the session. Within
     3.1 points on average on nights it was not fitted to, 8.5 at worst.
     REM, deep sleep, long wakes, bedtime, the sleep goal: none of them
     moved it once time asleep and awake were in. The rest is what the
     API does not give (Google's restlessness and sleeping heart rate),
     so the top is 86: an excellent night needs those too.
     A night without stages (Google: "REJECTED_COVERAGE", the band read
     too little) has no score in Google's app; here it gets an estimate
     from its time asleep and the person's usual time awake, kept apart
     as `sleep_score_est` so readiness still treats the night as unstaged.

   Readiness (1-100; 65 high, 30 moderate, below low).
     Mostly HRV against the person's own baseline:
       z  = (HRV − mean of the 30 days before) / their spread
       65 + 16 · min(z, 0) + 26 · ramp(z, 1.06 → 1.69)
          − 1.55 · max(0, resting HR − its 30-day mean)
          − 0.25 · max(0, 65 − last night's sleep score)
     so an ordinary day sits at 61-65, a high-HRV one climbs to about
     90, a low one falls. Refitted (v183) to 19 days of the app's chart:
     1.1 off on average, 4 at worst. After a night without stages HRV is
     left out (z = 0) but a raised resting heart rate still counts: the
     app read 64, 65 and 60 on such days, the 60 with resting HR 3 up.
     Google's first day (7 nights in) read 12; that start is not copied.

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

export const SLEEP = { full: 660, exp: 0.6, dur: 72, rest: 14, perAwake: 0.0373, longWakeMin: 3, usualAwake: 35 };
export const SLEEP_PARTS = [['duration', 'Time asleep'], ['restfulness', 'Restfulness']];

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
  let deep; let rem; let waso; let longMin; let awakenings; let awakeAll;
  if (staged) {
    const sleeping = st.filter((x) => !AWAKE(x.t));
    const first = sleeping[0].s; const last = sleeping.at(-1).e;
    const spells = st.filter((x) => AWAKE(x.t) && x.s >= first && x.e <= last).map(min);
    const long = spells.filter((m) => m >= SLEEP.longWakeMin);
    awakeAll = st.filter((x) => AWAKE(x.t)).reduce((a, x) => a + min(x), 0);
    deep = st.filter((x) => x.t === 'DEEP').reduce((a, x) => a + min(x), 0);
    rem = st.filter((x) => x.t === 'REM').reduce((a, x) => a + min(x), 0);
    waso = spells.reduce((a, m) => a + m, 0);
    longMin = long.reduce((a, m) => a + m, 0);
    awakenings = long.length;
  } else {
    // Only the totals: the awake minutes not before sleep or after waking, all of them counted as long.
    deep = sum.DEEP || 0; rem = sum.REM || 0; awakeAll = sum.AWAKE || sum.WAKE || 0;
    waso = Math.max(0, (sum.AWAKE || sum.WAKE || 0) - (night.summary?.toFallAsleep || 0) - (night.summary?.afterWake || 0));
    longMin = waso; awakenings = null;
  }
  return {
    asleepMin: asleep, deepMin: Math.round(deep), remMin: Math.round(rem),
    remPct: r1((rem / (asleep + waso)) * 100), awakeMin: Math.round(awakeAll), wasoMin: Math.round(waso), longWakeMin: Math.round(longMin), awakenings,
    longWakes: longMin / 3, remShare: (rem / (asleep + waso)) * 100,
  };
}

const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

/** The two parts from time asleep and minutes awake. */
function sleepPoints(asleepMin, awakeMin) {
  return {
    duration: SLEEP.dur * Math.min(1, asleepMin / SLEEP.full) ** SLEEP.exp,
    restfulness: clamp(SLEEP.rest - SLEEP.perAwake * awakeMin, 0, SLEEP.rest),
  };
}
const MAX = { duration: SLEEP.dur, restfulness: SLEEP.rest };
function scored(pts, text, extra = {}) {
  const parts = SLEEP_PARTS.map(([id, label]) => ({ id, label, points: r1(pts[id]), max: MAX[id], text: text[id] }));
  const score = Math.round(clamp(pts.duration + pts.restfulness, 0, 100));
  return { score, band: sleepBand(score), parts, ...extra };
}
const asleepText = (m) => `${hm(m)} asleep; the most is at ${hm(SLEEP.full)}`;

/** One night's sleep score with its parts: { score, band, parts, facts }. The goal is not part of it (Google's is not either). */
export function sleepScoreOf(night) {
  const f = sleepFacts(night);
  if (!f) return { score: null, band: null, parts: [], facts: null };
  return scored(sleepPoints(f.asleepMin, f.awakeMin), {
    duration: asleepText(f.asleepMin),
    restfulness: f.awakeMin ? `${f.awakeMin} min awake in the night` : 'Not awake in the night',
  }, { facts: f });
}
/**
 * A night with no stages (Google sends "classic" sleep when it could not
 * stage the night, and gives it no score): the score from time asleep,
 * with this person's usual minutes awake from their staged nights (35
 * until there are 3 of them) in place of last night's.
 * @param {object} night
 * @param {object[]} prior earlier nights (any order)
 */
export function sleepScoreEstimate(night, prior) {
  if (!night || !fin(night.asleepMin) || night.asleepMin <= 0 || sleepFacts(night)) return null;
  const facts = (prior || []).map(sleepFacts).filter(Boolean).slice(-14);
  const awake = facts.length >= 3 ? mean(facts.map((x) => x.awakeMin)) : SLEEP.usualAwake;
  return scored(sleepPoints(night.asleepMin, awake), {
    duration: asleepText(night.asleepMin),
    restfulness: `No stages last night: your usual ${Math.round(awake)} min awake stands in`,
  }, { estimated: true });
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

export const READY = { base: 65, low: 16, high: 26, from: 1.06, to: 1.69, rhr: 1.55, sleepAt: 65, perSleep: 0.25 };

/** Readiness inputs for `date`, or null before 7 nights of HRV, or before
    that day's night is in (until then the day before stands, as Google's does). */
export function readyX(table, date, addDays) {
  const row = table[date] || {};
  if (!fin(row.sleep_min) && !fin(row.sleep_score)) return null;
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
  // After a night without stages Google leaves HRV out; the resting heart rate still counts.
  const z = x.staged ? x.z : 0;
  const sleepCut = READY.perSleep * Math.max(0, READY.sleepAt - (x.sleepLast ?? READY.sleepAt));
  const s = READY.base + READY.low * Math.min(z, 0) + READY.high * ramp(z, READY.from, READY.to) - READY.rhr * Math.max(0, x.rhrUp) - sleepCut;
  return Math.round(clamp(s, 1, 100));
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
