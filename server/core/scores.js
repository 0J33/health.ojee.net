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
     and 77 and 58 in the app. Google names its factors (time asleep,
     sound sleep, time to sound asleep, restlessness, full awakenings),
     each full while in range. Fitted to two people's charts (43 nights,
     a Fitbit Air and a Pixel Watch):
       66 · min(1, asleep / 600)                  time asleep
     + 0.303 · % of it deep or REM (up to 16)     sound sleep
     + 12 − 0.331 · minutes to the first deep     time to sound asleep
     +  8 − 2.65  · brief awakenings an hour      restlessness
     + 10 − 2.06  · awake spells of 5 min+        full awakenings
     each part kept between 0 and its max, the sum at most 100. About 3
     points off Google's on average (2.4 and 3.8 for the two people),
     11 at worst. Brief awakenings are Google's own count
     (summary.shortAwakenings). The sleep goal is not part of it.
     A night without stages (Google: "REJECTED_COVERAGE", the band read
     too little) has no score in Google's app; here it gets an estimate
     from its time asleep and the person's usual for the rest, kept apart
     as `sleep_score_est` so readiness still treats the night as unstaged.

   Readiness (1-100; 65 high, 30 moderate, below low).
     Mostly HRV against the person's own baseline:
       z  = (HRV − mean of the 30 days before) / their spread
       63.8 + 20.3 · min(z, 0) + 21.5 · ramp(z, 1.06 → 1.69)
            − 1.0 · max(0, resting HR − its 30-day mean)
            − 1.09 · max(0, 65 − last night's sleep score)
     so an ordinary day sits at 60-64, a high-HRV one climbs to about
     85, a low one falls, and a poor night holds a good HRV down (a
     46 sleep kept a z of 1.6 at 65). Refitted (v184) to two people's
     charts, 31 days: 2.6 off on average, 9 at worst. After a night
     without stages HRV is left out (z = 0) but a raised resting heart
     rate still counts. Google's first day of readiness is low (12 and
     37 for the two); that start is not copied.

   Resilience (Optimal, Balanced or Low; 65 and 35 here).
     Google shows only the label, but its chart is a hidden 0-100 scale
     (read off the band lines in both charts: Low under 68, Balanced
     68-83, Optimal 83 and up). Refitted (v214) to two people's charts
     with their Takeouts (Oct 10 - Nov 5 2026: a Fitbit Air each, one of
     them a construction worker burning ~0.5 of his basal a day). What
     holds across both is the week's resting heart rate against usual:
       G = 74.2 − 3.2 · (resting HR, last 7 days − the 30 before)
     3.5 points off Google's hidden score on average (4.0 leaving each
     day out), the right label 3 days in 4. HRV, sleep and the week's
     load, the inputs Google names, did not help on 34 days: a ridge fit
     on them did no better than a constant once tried on the other
     person. G goes onto this app's 35/65 scale piecewise (68 -> 35,
     83 -> 65). Not copied: Google reads every new wearer Low for their
     first 11-20 days (calibration). The one unfitted part: a week far
     over the person's usual (zone-weighted load over 1.5x the 4 weeks
     before; nobody fitted was) takes 20 points per unit over.
     The v183 formula (load-heavy) had been fitted to that calibration
     stretch, so it read Low for everybody busy, and 0 for Cam.
   ============================================================ */

const fin = Number.isFinite;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** 0 at `a`, 1 at `b`, straight in between. */
const ramp = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (v) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : null);

/* ── sleep ─────────────────────────────────────────────────────────── */

export const SLEEP = {
  full: 600, dur: 66,                           // time asleep: straight up to 10 h
  perSound: 0.303, sound: 16,                   // sound sleep: deep + REM, % of time asleep
  settle: 12, perSettle: 0.331,                 // time to sound asleep: minutes to the first deep sleep
  calm: 8, perBrief: 2.65,                      // restlessness: brief awakenings an hour
  whole: 10, perFull: 2.06, fullMin: 5,         // full awakenings: 5 min and more
  longWakeMin: 3,
  usual: { toDeep: 22, briefPerHour: 2.5, full: 1.5, soundPct: 33 },   // stand-ins when a night does not say
};
export const SLEEP_PARTS = [['duration', 'Time asleep'], ['sound', 'Sound sleep'], ['settle', 'Time to sound asleep'], ['restless', 'Restlessness'], ['awakenings', 'Full awakenings']];

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
  let deep; let rem; let waso; let longMin; let awakenings; let awakeAll; let toDeep = null; let full = null;
  const brief = Number.isFinite(night.summary?.shortAwakenings) ? night.summary.shortAwakenings : null;
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
    // Google's "time to sound asleep": from the start of the night to the first deep sleep (REM if none).
    const sound = st.find((x) => x.t === 'DEEP') || st.find((x) => x.t === 'REM');
    toDeep = (sound.s - st[0].s) / 60_000;
    full = spells.filter((m) => m >= SLEEP.fullMin).length;
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
    toDeepMin: toDeep === null ? null : Math.round(toDeep), briefAwakenings: brief, fullAwakenings: full,
    briefPerHour: brief === null ? null : brief / (asleep / 60), soundPct: ((deep + rem) / asleep) * 100,
  };
}

const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

/** The four parts, each full when its factor is in range and less as it strays. */
function sleepPoints(asleepMin, x) {
  const u = SLEEP.usual;
  const v = (k, d) => (fin(x[k]) ? x[k] : d);
  return {
    duration: SLEEP.dur * Math.min(1, asleepMin / SLEEP.full),
    sound: clamp(SLEEP.perSound * v('soundPct', u.soundPct), 0, SLEEP.sound),
    settle: clamp(SLEEP.settle - SLEEP.perSettle * v('toDeep', u.toDeep), 0, SLEEP.settle),
    restless: clamp(SLEEP.calm - SLEEP.perBrief * v('briefPerHour', u.briefPerHour), 0, SLEEP.calm),
    awakenings: clamp(SLEEP.whole - SLEEP.perFull * v('full', u.full), 0, SLEEP.whole),
  };
}
const MAX = { duration: SLEEP.dur, sound: SLEEP.sound, settle: SLEEP.settle, restless: SLEEP.calm, awakenings: SLEEP.whole };
function scored(pts, text, extra = {}) {
  const parts = SLEEP_PARTS.map(([id, label]) => ({ id, label, points: r1(pts[id]), max: MAX[id], text: text[id] }));
  const score = Math.round(clamp(pts.duration + pts.sound + pts.settle + pts.restless + pts.awakenings, 0, 100));
  return { score, band: sleepBand(score), parts, ...extra };
}
const asleepText = (m) => `${hm(m)} asleep; the most is at ${hm(SLEEP.full)}`;
const factsText = (f, usual = false) => ({
  sound: usual ? 'No stages: your usual stands in' : `${Math.round(f.soundPct)}% of the night in deep and REM sleep`,
  settle: usual ? 'No stages: your usual stands in' : `${f.toDeep} min to the first deep sleep`,
  restless: usual ? 'No stages: your usual stands in' : f.briefPerHour === null ? 'Not counted that night' : `${r1(f.briefPerHour)} brief awakenings an hour`,
  awakenings: usual ? 'No stages: your usual stands in' : f.full ? `${f.full} time${f.full === 1 ? '' : 's'} awake for 5 min or more` : 'None of 5 min or more',
});

/** One night's sleep score with its parts: { score, band, parts, facts }. The goal is not part of it (Google's is not either). */
export function sleepScoreOf(night) {
  const f = sleepFacts(night);
  if (!f) return { score: null, band: null, parts: [], facts: null };
  const x = { toDeep: f.toDeepMin, briefPerHour: f.briefPerHour, full: f.fullAwakenings, soundPct: f.soundPct };
  return scored(sleepPoints(f.asleepMin, x), { duration: asleepText(f.asleepMin), ...factsText(x) }, { facts: f });
}
/**
 * A night with no stages (Google sends "classic" sleep when it could not
 * stage the night, and gives it no score): the score from time asleep,
 * with this person's usual settling, restlessness and awakenings from
 * their staged nights (or typical ones until there are 3) in their place.
 * @param {object} night
 * @param {object[]} prior earlier nights (any order)
 */
export function sleepScoreEstimate(night, prior) {
  if (!night || !fin(night.asleepMin) || night.asleepMin <= 0 || sleepFacts(night)) return null;
  const facts = (prior || []).map(sleepFacts).filter(Boolean).slice(-14);
  const avg = (k) => { const v = facts.map((z) => z[k]).filter(fin); return v.length >= 3 ? mean(v) : null; };
  const x = { toDeep: avg('toDeepMin'), briefPerHour: avg('briefPerHour'), full: avg('fullAwakenings'), soundPct: avg('soundPct') };
  return scored(sleepPoints(night.asleepMin, x), { duration: asleepText(night.asleepMin), ...factsText(x, true) }, { estimated: true });
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

export const READY = { base: 63.8, low: 20.3, high: 21.5, from: 1.06, to: 1.69, rhr: 1.0, sleepAt: 65, perSleep: 1.09, deep: -2, past: 0.5 };

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
  // Below usual, each step of HRV counts in full down to `deep` (as far as Google's own scores
  // were fitted), half past it: a night far under usual is a low day, not the floor of the scale.
  const zLow = Math.min(z, 0);
  const low = zLow >= READY.deep ? zLow : READY.deep + (zLow - READY.deep) * READY.past;
  const s = READY.base + READY.low * low + READY.high * ramp(z, READY.from, READY.to) - READY.rhr * Math.max(0, x.rhrUp) - sleepCut;
  return Math.round(clamp(s, 1, 100));
}
export const readyBand = (s) => (!fin(s) ? null : s >= 65 ? 'High' : s >= 30 ? 'Moderate' : 'Low');

/* ── resilience ────────────────────────────────────────────────────── */

export const RESIL = { base: 74.2, rhr: 3.2, over: 1.5, perOver: 20, cuts: [[0, 0], [68, 35], [83, 65], [100, 100]] };

const zoneLoad = (r) => (r && fin(r.zone_light) ? (r.zone_light || 0) + 2 * (r.zone_moderate || 0) + 3 * (r.zone_vigorous || 0) + 4 * (r.zone_peak || 0) : null);

/** Resilience inputs for `date`, or null without enough of the week and month behind it. */
export function resilX(table, date, addDays) {
  const row = table[date] || {};
  const worn = (i) => fin(table[addDays(date, -i)]?.hr_avg);
  let wornWeek = 0; for (let i = 1; i <= 7; i += 1) if (worn(i)) wornWeek += 1;
  const week = back(table, 'rhr', date, addDays, 0, 6);
  const month = back(table, 'rhr', date, addDays, 1, 30);
  if (wornWeek < 3 || week.length < 3 || month.length < 14 || !fin(row.sleep_min)) return null;
  const l7 = []; const l28 = [];
  for (let i = 1; i <= 28; i += 1) { const l = zoneLoad(table[addDays(date, -i)]); if (l !== null) (i <= 7 ? l7 : l28).push(l); }
  const chronic = l28.length + l7.length >= 14 ? mean([...l7, ...l28]) : null;
  return {
    rhrUp: mean(week) - mean(month),
    acwr: chronic > 0 && l7.length >= 3 ? mean(l7) / chronic : null,
  };
}
/** Google's hidden 0-100 onto this app's scale (Low under 35, Optimal from 65). */
function resilScale(g) {
  const c = RESIL.cuts;
  for (let i = 1; i < c.length; i += 1) if (g <= c[i][0]) return c[i - 1][1] + ((g - c[i - 1][0]) / (c[i][0] - c[i - 1][0])) * (c[i][1] - c[i - 1][1]);
  return 100;
}
/** Resilience out of 100 from resilX's inputs. */
export function resilienceOf(x) {
  if (!x) return null;
  const over = fin(x.acwr) ? Math.max(0, x.acwr - RESIL.over) : 0;
  const g = clamp(RESIL.base - RESIL.rhr * x.rhrUp - RESIL.perOver * over, 0, 100);
  return Math.round(clamp(resilScale(g), 0, 100));
}
export const resilLabel = (s, cut = { low: 35, high: 65 }) => (!fin(s) ? null : s >= cut.high ? 'Optimal' : s >= cut.low ? 'Balanced' : 'Low');
