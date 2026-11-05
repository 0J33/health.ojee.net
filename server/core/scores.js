/* ============================================================
   health.ojee.net — Sleep quality, Recovery and Load balance: this
   app's own three scores, each from a published rule of thumb, each
   over the person's own data. They do not copy anybody's (v216; until
   v215 these were fitted to the Google Health app's sleep score,
   readiness and resilience). The ids stay sleep_score, readiness and
   resilience so the API and the history keep working.

   ── Sleep quality (0-100) ───────────────────────────────────────────
   Five parts, after the National Sleep Foundation's sleep quality
   recommendations (Ohayon et al., Sleep Health 2017) and the AASM /
   Sleep Research Society consensus on duration (Watson et al., Sleep
   2015: adults need 7 hours or more):
     40  Time asleep     0 at 4 h, full at 7 h 30 (the middle of 7-9 h).
                         No penalty above: long sleep is a symptom, not
                         a cause, in the studies that find it.
     20  Efficiency      asleep / in bed. 85% and up is "good" in
                         Ohayon; 0 at 65%, full at 90%.
     20  Deep + REM      their share of the time asleep. Ohayon's
                         "appropriate" ranges (REM 21-30%, deep 16-20%)
                         add to about 40%; wearables stage roughly, so
                         0 at 20%, full at 40%.
     10  Time awake      awake after first falling asleep (WASO). Ohayon:
                         20 min or less good, 51 or more poor; full at
                         20, 0 at 60.
     10  Regularity      bedtime against the person's own median of the
                         14 nights before (5 at least): full within 30
                         min, 0 at 2 h off. Irregular sleep predicts
                         poor health beyond its length (Phillips 2017,
                         Windred 2024).
   A night under an hour asleep is not scored (a device's slip). A
   part that cannot be worked out (no stages, too few earlier nights)
   is left out and the score is the points earned over the points
   possible. Bands: 85 excellent, 70 good, 55 fair, below poor.

   ── Recovery (1-100) ────────────────────────────────────────────────
   How this morning compares with the person's own 30 days before, as
   HRV-guided training reads it (Kiviniemi 2007, Plews 2013, Buchheit
   2014): HRV on a log scale (it is skewed), resting heart rate, last
   night's sleep, and a raised skin temperature (illness often shows
   there first).
     c = 0.50 · z(ln HRV) − 0.30 · z(resting HR) + 0.20 · sleep
         − temperature
     z: against the 30 days before (10 nights at least), the SD at
        least 3% of the mean so a very steady person is not jumpy,
        each z kept within ±3
     sleep: (last night's sleep quality − 75) / 15, within −2..+1.5
     temperature: 1 per °C above +0.5 °C of the person's usual, at
        most 1 (wrist skin temperature moves with the room as well)
     Recovery = 62 + 18 · c, within 1..100
   An ordinary morning is about 62 (moderate); a full SD of HRV above
   usual reads about 71, with a good night as well past 72 (high). Bands:
   72 high, 42 moderate, below low: on everyone's data from Aug to Nov
   2026 that made about 1 morning in 4 high and 1 in 10 low. Without HRV (some watches) the HRV
   weight goes to the resting heart rate.

   ── Load balance (0-100: Low, Balanced, Optimal) ────────────────────
   Is the body keeping up with the training it is given:
     load   the acute:chronic workload ratio (Gabbett, BJSM 2016), as
            exponentially weighted averages (Williams et al., BJSM
            2017: 7-day and 28-day) of a daily load: minutes in heart-
            rate zones, weighted 1 light, 2 moderate, 3 vigorous, 5
            peak (after Edwards' TRIMP). 0.8-1.3 is the "sweet spot"
            (full), falling to 0 at 1.8 (a spike) and to half at 0.4
            (detraining is the smaller risk).
     trend  the last 7 days' ln HRV and resting heart rate against the
            30 days before (Plews 2013 reads the weekly mean, not one
            morning): 0.6 · z(HRV) − 0.4 · z(resting HR), from the
            daily SD; 0.45 + 0.4 · trend, within 0..1.
     Load balance = 100 · (load + trend) / 2
   A steady week with recovery as usual is about 72: balanced. Optimal
   (80 and up) takes training in the sweet spot and recovery on the way
   up; low (under 55), a spike in load or recovery falling behind. On
   everyone's data from Aug to Nov 2026: about 1 day in 3 optimal and 1
   in 7 low. Needs 14 worn days of the
   28 and 10 mornings of HRV or resting heart rate.
   ============================================================ */

const fin = Number.isFinite;

/** The bands of the three scores, in one place: the scores, the catalogue's zones and the
    metric page's reference ranges (core/ranges.js) all read these. */
export const SCORE_CUTS = { sleep: [55, 70, 85], ready: [42, 72], resil: [55, 80] };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** 0 at `zero`, 1 at `full`, straight in between (either direction). */
const ramp = (x, zero, full) => clamp((x - zero) / (full - zero), 0, 1);
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (v) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : null);
const sdOf = (v) => { const m = mean(v); return v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)) : null; };
const median = (vals) => { const v = vals.filter(fin).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const hm = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;

/* ── sleep quality ─────────────────────────────────────────────────── */

export const SLEEP = {
  dur: 40, durZero: 240, durFull: 450,
  eff: 20, effZero: 0.65, effFull: 0.90,
  stages: 20, stagesZero: 20, stagesFull: 40,
  awake: 10, awakeFull: 20, awakeZero: 60,
  regular: 10, regularFull: 30, regularZero: 120, regularNights: 5, regularDays: 14,
  minAsleep: 60,   // a shorter "night" is a device's slip, not a night
};
export const SLEEP_PARTS = [['duration', 'Time asleep'], ['efficiency', 'Efficiency'], ['stages', 'Deep and REM'], ['awake', 'Time awake'], ['regularity', 'Regularity']];
const MAX = { duration: SLEEP.dur, efficiency: SLEEP.eff, stages: SLEEP.stages, awake: SLEEP.awake, regularity: SLEEP.regular };

const STAGE = (t) => String(t || '').toUpperCase();
const AWAKE = (t) => t === 'AWAKE' || t === 'WAKE';
const localMin = (t, off) => { const d = new Date(t + (off || 0) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
/** Bedtime as minutes after 18:00 local the evening before (23:30 and 00:30 are an hour apart). */
const bedMin = (n) => (fin(n?.startMs) ? (localMin(n.startMs, n.startOff) - 1080 + 1440) % 1440 : null);

/**
 * What a night says, stages or not: time asleep and in bed, deep and REM,
 * time awake after first falling asleep. Null without a time asleep.
 */
export function sleepFacts(night) {
  if (!night || !fin(night.asleepMin) || night.asleepMin < SLEEP.minAsleep) return null;
  const asleep = night.asleepMin;
  const st = (Array.isArray(night.stages) ? night.stages : []).map((x) => ({ s: Number(x.s ?? x.start ?? x.startMs), e: Number(x.e ?? x.end ?? x.endMs), t: STAGE(x.t ?? x.type ?? x.stage) }))
    .filter((x) => fin(x.s) && fin(x.e) && x.e > x.s).sort((a, b) => a.s - b.s);
  const sum = night.summary?.stages || {};
  const min = (x) => (x.e - x.s) / 60_000;
  const listed = st.some((x) => x.t === 'DEEP' || x.t === 'REM');
  const deep = listed ? st.filter((x) => x.t === 'DEEP').reduce((a, x) => a + min(x), 0) : (sum.DEEP || 0);
  const rem = listed ? st.filter((x) => x.t === 'REM').reduce((a, x) => a + min(x), 0) : (sum.REM || 0);
  const staged = deep + rem > 0;
  let waso = null;
  if (st.length) {
    const sleeping = st.filter((x) => !AWAKE(x.t));
    if (sleeping.length) { const first = sleeping[0].s; const last = sleeping.at(-1).e; waso = st.filter((x) => AWAKE(x.t) && x.s >= first && x.e <= last).reduce((a, x) => a + min(x), 0); }
  } else if (fin(sum.AWAKE ?? sum.WAKE)) {
    waso = Math.max(0, (sum.AWAKE ?? sum.WAKE) - (night.summary?.toFallAsleep || 0) - (night.summary?.afterWake || 0));
  }
  const inBed = fin(night.periodMin) && night.periodMin >= asleep ? night.periodMin
    : fin(night.awakeMin) ? asleep + night.awakeMin
      : fin(night.startMs) && fin(night.endMs) && night.endMs > night.startMs ? Math.max(asleep, (night.endMs - night.startMs) / 60_000) : null;
  return {
    asleepMin: Math.round(asleep), inBedMin: inBed === null ? null : Math.round(inBed), efficiency: inBed ? asleep / inBed : null,
    staged, deepMin: Math.round(deep), remMin: Math.round(rem), soundPct: staged ? ((deep + rem) / asleep) * 100 : null,
    remPct: staged ? r1((rem / asleep) * 100) : null, wasoMin: waso === null ? null : Math.round(waso), bedMin: bedMin(night),
  };
}

/** The person's usual bedtime before this night: the median of up to 14 days of main nights, 5 at least. */
export function usualBed(night, prior) {
  if (!night?.date || !Array.isArray(prior)) return null;
  const from = new Date(Date.parse(`${night.date}T00:00:00Z`) - SLEEP.regularDays * 86_400_000).toISOString().slice(0, 10);
  // The longest of each date: a nap the device also called a main sleep is not a bedtime.
  const longest = {};
  for (const n of prior) if (n && n.main !== false && n.date < night.date && n.date >= from && fin(n.asleepMin) && (!longest[n.date] || n.asleepMin > longest[n.date].asleepMin)) longest[n.date] = n;
  const b = Object.values(longest).map(bedMin).filter(fin);
  return b.length >= SLEEP.regularNights ? median(b) : null;
}

/**
 * One night's sleep quality with its parts: { score, band, parts, facts }.
 * `prior`: earlier main nights (any order), for regularity.
 */
export function sleepScoreOf(night, { prior = null } = {}) {
  const f = sleepFacts(night);
  if (!f) return { score: null, band: null, parts: [], facts: null };
  const usual = usualBed(night, prior);
  const off = usual === null || f.bedMin === null ? null : Math.abs(f.bedMin - usual);
  const pts = {
    duration: SLEEP.dur * ramp(f.asleepMin, SLEEP.durZero, SLEEP.durFull),
    efficiency: f.efficiency === null ? null : SLEEP.eff * ramp(f.efficiency, SLEEP.effZero, SLEEP.effFull),
    stages: f.soundPct === null ? null : SLEEP.stages * ramp(f.soundPct, SLEEP.stagesZero, SLEEP.stagesFull),
    awake: f.wasoMin === null ? null : SLEEP.awake * ramp(f.wasoMin, SLEEP.awakeZero, SLEEP.awakeFull),
    regularity: off === null ? null : SLEEP.regular * ramp(off, SLEEP.regularZero, SLEEP.regularFull),
  };
  const text = {
    duration: `${hm(f.asleepMin)} asleep; full marks from ${hm(SLEEP.durFull)}`,
    efficiency: f.efficiency === null ? 'Time in bed not known' : `${Math.round(f.efficiency * 100)}% of the time in bed asleep; full marks from ${SLEEP.effFull * 100}%`,
    stages: f.soundPct === null ? 'No sleep stages that night' : `${Math.round(f.soundPct)}% of it deep or REM sleep; full marks from ${SLEEP.stagesFull}%`,
    awake: f.wasoMin === null ? 'Time awake not known' : `${f.wasoMin} min awake after falling asleep; full marks at ${SLEEP.awakeFull} or less`,
    regularity: off === null ? 'Needs 5 nights in the 2 weeks before' : `In bed ${off < 5 ? 'at your usual time' : `${Math.round(off)} min from your usual time`}; full marks within ${SLEEP.regularFull}`,
  };
  const parts = SLEEP_PARTS.filter(([id]) => pts[id] !== null).map(([id, label]) => ({ id, label, points: r1(pts[id]), max: MAX[id], text: text[id] }));
  const got = parts.reduce((a, p) => a + pts[p.id], 0); const of = parts.reduce((a, p) => a + p.max, 0);
  const score = Math.round(clamp((got / of) * 100, 0, 100));
  return { score, band: sleepBand(score), parts, facts: f, missing: SLEEP_PARTS.filter(([id]) => pts[id] === null).map(([id, label]) => ({ id, label, text: text[id] })) };
}
/** Every night with a time asleep is scored now; there is nothing to estimate. Kept for callers. */
export function sleepScoreEstimate() { return null; }
export const sleepBand = (s) => { const [a, b, c] = SCORE_CUTS.sleep; return !fin(s) ? null : s >= c ? 'Excellent' : s >= b ? 'Good' : s >= a ? 'Fair' : 'Poor'; };

/* ── the person's own baselines ────────────────────────────────────── */

/** Values of a daily key on the days `from`..`to` before `date` (1 = yesterday). */
function back(table, key, date, addDays, from, to, f = (x) => x) {
  const v = [];
  for (let i = from; i <= to; i += 1) { const x = table[addDays(date, -i)]?.[key]; if (fin(x) && (key !== 'hrv' || x > 0)) v.push(f(x)); }
  return v;
}
/** Against a baseline: z, the SD at least `floor` of the mean, kept within ±3. */
function zOf(x, base, floor) {
  if (!fin(x) || base.length < 2) return null;
  const m = mean(base); const s = Math.max(sdOf(base) || 0, Math.abs(m) * floor, 1e-6);
  return clamp((x - m) / s, -3, 3);
}

/* ── recovery ──────────────────────────────────────────────────────── */

export const READY = { base: 62, scale: 18, hrv: 0.5, rhr: 0.3, sleep: 0.2, sleepMid: 75, sleepSpread: 15, tempFrom: 0.5, perTemp: 1, tempMax: 1, minNights: 10, sdFloor: 0.03 };

/** Recovery inputs for `date` (its morning), or null before 10 mornings of baseline or before that day's night. */
export function readyX(table, date, addDays) {
  const row = table[date] || {};
  if (!fin(row.sleep_min) && !fin(row.sleep_score)) return null;
  const lnHrv = back(table, 'hrv', date, addDays, 1, 30, Math.log);
  const rhr = back(table, 'rhr', date, addDays, 1, 30);
  const zH = lnHrv.length >= READY.minNights && fin(row.hrv) && row.hrv > 0 ? zOf(Math.log(row.hrv), lnHrv, READY.sdFloor / 4) : null;
  const zR = rhr.length >= READY.minNights ? zOf(row.rhr, rhr, READY.sdFloor) : null;
  if (zH === null && zR === null) return null;
  return {
    zHrv: zH, zRhr: zR,
    sleep: fin(row.sleep_score) ? row.sleep_score : null,
    temp: fin(row.temp_dev) ? row.temp_dev : null,
  };
}
/** Recovery with its parts: { score, band, parts }; null without inputs. */
export function readinessDetail(x) {
  if (!x) return null;
  // Without HRV its weight goes to the resting heart rate; without that, to HRV.
  const wH = x.zHrv === null ? 0 : x.zRhr === null ? READY.hrv + READY.rhr : READY.hrv;
  const wR = x.zRhr === null ? 0 : x.zHrv === null ? READY.hrv + READY.rhr : READY.rhr;
  const sl = x.sleep === null ? 0 : clamp((x.sleep - READY.sleepMid) / READY.sleepSpread, -2, 1.5);
  const tp = x.temp === null ? 0 : Math.min(READY.tempMax, Math.max(0, x.temp - READY.tempFrom) * READY.perTemp);
  const pts = (v) => r1(READY.scale * v);
  const parts = [
    x.zHrv === null ? null : { id: 'hrv', label: 'HRV', points: pts(wH * x.zHrv), text: `${Math.abs(x.zHrv) < 0.25 ? 'About your usual' : `${r1(Math.abs(x.zHrv))} SD ${x.zHrv > 0 ? 'above' : 'below'} your usual`}` },
    x.zRhr === null ? null : { id: 'rhr', label: 'Resting heart rate', points: pts(-wR * x.zRhr), text: `${Math.abs(x.zRhr) < 0.25 ? 'About your usual' : `${r1(Math.abs(x.zRhr))} SD ${x.zRhr > 0 ? 'above' : 'below'} your usual`}` },
    x.sleep === null ? null : { id: 'sleep', label: 'Last night', points: pts(READY.sleep * sl), text: `Sleep quality ${x.sleep}` },
    tp > 0 ? { id: 'temp', label: 'Temperature', points: pts(-tp), text: `${r1(x.temp)} °C above your usual` } : null,
  ].filter(Boolean);
  const c = wH * (x.zHrv ?? 0) - wR * (x.zRhr ?? 0) + READY.sleep * sl - tp;
  const score = Math.round(clamp(READY.base + READY.scale * c, 1, 100));
  return { score, band: readyBand(score), base: READY.base, parts };
}
/** Recovery out of 100 from readyX's inputs. */
export const readinessOf = (x) => readinessDetail(x)?.score ?? null;
export const readyBand = (s) => (!fin(s) ? null : s >= SCORE_CUTS.ready[1] ? 'High' : s >= SCORE_CUTS.ready[0] ? 'Moderate' : 'Low');

/* ── load balance ──────────────────────────────────────────────────── */

export const RESIL = { acute: 7, chronic: 28, sweetLo: 0.8, sweetHi: 1.3, spike: 1.8, low: 0.4, lowFloor: 0.5, hrv: 0.6, rhr: 0.4, trendBase: 0.45, trendScale: 0.4, minWorn: 14, minBase: 10, weights: { light: 1, moderate: 2, vigorous: 3, peak: 5 } };

/** A day's training load: minutes in heart-rate zones, weighted. Null on a day without zones. */
export function loadOf(r) {
  if (!r || !fin(r.zone_light ?? r.zone_moderate ?? r.zone_vigorous ?? r.zone_peak)) return null;
  const w = RESIL.weights;
  return (r.zone_light || 0) * w.light + (r.zone_moderate || 0) * w.moderate + (r.zone_vigorous || 0) * w.vigorous + (r.zone_peak || 0) * w.peak;
}

/** Load balance inputs for `date` (the 28 days up to yesterday), or null without enough of them. */
export function resilX(table, date, addDays) {
  // Exponentially weighted, oldest first; a worn day without zones is a rest day, an unworn one is skipped.
  const la = 2 / (RESIL.acute + 1); const lc = 2 / (RESIL.chronic + 1);
  let a = null; let c = null; let worn = 0;
  for (let i = RESIL.chronic + 14; i >= 1; i -= 1) {
    const r = table[addDays(date, -i)];
    const l = loadOf(r) ?? (fin(r?.hr_avg) ? 0 : null);
    if (l === null) continue;
    if (i <= RESIL.chronic) worn += 1;
    a = a === null ? l : la * l + (1 - la) * a;
    c = c === null ? l : lc * l + (1 - lc) * c;
  }
  const lnHrv = back(table, 'hrv', date, addDays, 8, 37, Math.log); const rhr = back(table, 'rhr', date, addDays, 8, 37);
  const h7 = back(table, 'hrv', date, addDays, 0, 6, Math.log); const r7 = back(table, 'rhr', date, addDays, 0, 6);
  const zH = lnHrv.length >= RESIL.minBase && h7.length >= 3 ? zOf(mean(h7), lnHrv, READY.sdFloor / 4) : null;
  const zR = rhr.length >= RESIL.minBase && r7.length >= 3 ? zOf(mean(r7), rhr, READY.sdFloor) : null;
  if (worn < RESIL.minWorn || (zH === null && zR === null)) return null;
  return { acwr: c > 0 ? a / c : null, acute: a, chronic: c, zHrv: zH, zRhr: zR };
}
/** Load balance with its parts: { score, label, parts }; null without inputs. */
export function resilienceDetail(x) {
  if (!x) return null;
  const R = RESIL;
  // No training at all for a month: no ratio; it counts as steady.
  const ratio = x.acwr;
  const load = ratio === null ? 1 : ratio > R.sweetHi ? ramp(ratio, R.spike, R.sweetHi) : ratio < R.sweetLo ? R.lowFloor + (1 - R.lowFloor) * ramp(ratio, R.low, R.sweetLo) : 1;
  const wH = x.zHrv === null ? 0 : x.zRhr === null ? 1 : R.hrv;
  const wR = x.zRhr === null ? 0 : x.zHrv === null ? 1 : R.rhr;
  const t = wH * (x.zHrv ?? 0) - wR * (x.zRhr ?? 0);
  const trend = clamp(R.trendBase + R.trendScale * t, 0, 1);
  const score = Math.round(100 * (load + trend) / 2);
  const parts = [
    { id: 'load', label: 'Training load', points: r1(50 * load), max: 50, text: ratio === null ? 'No training in the last 4 weeks' : `This week's load is ${Math.round(ratio * 100)}% of your 4-week average; best between ${Math.round(R.sweetLo * 100)}% and ${Math.round(R.sweetHi * 100)}%` },
    { id: 'trend', label: 'Recovery this week', points: r1(50 * trend), max: 50, text: Math.abs(t) < 0.25 ? 'HRV and resting heart rate about your usual' : t > 0 ? 'HRV up or resting heart rate down against your usual' : 'HRV down or resting heart rate up against your usual' },
  ];
  return { score, label: resilLabel(score), parts };
}
/** Load balance out of 100 from resilX's inputs. */
export const resilienceOf = (x) => resilienceDetail(x)?.score ?? null;
export const resilLabel = (s, cut = { low: SCORE_CUTS.resil[0], high: SCORE_CUTS.resil[1] }) => (!fin(s) ? null : s >= cut.high ? 'Optimal' : s >= cut.low ? 'Balanced' : 'Low');
