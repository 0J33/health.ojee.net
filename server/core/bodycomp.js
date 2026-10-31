/* ============================================================
   health.ojee.net — body composition, worked out the way the Xiaomi
   app does. Pure functions: no database, no clock.

   A Xiaomi scale sends its own numbers for each weigh-in (weight, body
   fat %, muscle kg, water %, bone kg, protein % and kg, visceral fat,
   BMR, body age, impedance). Those are shown as they came. What this
   file adds is OUR ESTIMATE of what the Xiaomi app shows around them:

     masses and shares   fat mass, fat-free mass, water mass, protein
                         mass, muscle %, bone %: plain arithmetic on the
                         scale's own numbers
     ranges              Low / Standard / High … for each number, by sex,
                         age, height and weight: the standard ranges the
                         scale's app uses
     weight goals        standard weight, and how far weight, fat and
                         muscle are from it
     body type           one of nine, from where fat % and muscle sit
     body score          100, less points for each number outside its
                         range
     skeletal muscle     an estimate from impedance (the scale does not
                         send one)

   None of it is medical advice; the ranges are wellness ranges.

   Sources (the numbers and formulas, written again here, not copied):

     lolouk44/xiaomi_mi_scale, src/body_scales.py, src/body_score.py and
     src/Xiaomi_Scale_Body_Metrics.py (MIT licence), reverse-engineered
     from Xiaomi's Mi Fit / Zepp Life app. The same tables are in
     openScale's MiScaleLib (GPL-3.0; not used here). Where body_score.py
     cannot do what its own comments say (two branches of the body-fat
     deduction are unreachable, so a body fat just under the top of
     Standard loses 10 points and a very low one 10), this follows the
     comments: 3 to 9 points across the top of Standard, 3 to 10 below
     it. tests/bodycomp.test.js holds both cases.

     Skeletal muscle mass: Janssen I, Heymsfield SB, Baumgartner RN,
     Ross R. "Estimation of skeletal muscle mass by bioelectrical
     impedance analysis." J Appl Physiol 2000;89:465-471:
       SM (kg) = 0.401 × height² / R + 3.825 × (1 male, 0 female)
                 − 0.071 × age + 5.102          (height cm, R ohm)
     The equation is for hand-to-foot impedance; a scale measures
     foot to foot, so this is a rough estimate and is said to be one.

     Waist-to-hip ratio: Xiaomi's estimate has not been published, so
     this app does not invent one. It shows the real ratio when waist
     and hips have been measured with a tape (Body measurements), with
     the WHO's cut-offs (0.85 for women, 0.90 for men; "Waist
     circumference and waist-hip ratio", WHO expert consultation, 2008).
   ============================================================ */

const fin = Number.isFinite;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const SEXES = ['female', 'male'];
export const NOTE = 'Our estimate, worked out the way the Xiaomi app does. The ranges are the standard ranges the scale\'s app uses: a guide for wellness, not medical advice.';

/** A whole age at a time, from a year of birth (no birthday is kept, so
    it is the age reached during that year). */
export function ageAt(birthYear, t) {
  if (!fin(birthYear) || !fin(t)) return null;
  const a = new Date(t).getUTCFullYear() - birthYear;
  return a >= 5 && a <= 110 ? a : null;
}

/* ── the scale app's tables ─────────────────────────────────────────── */

/** Body fat % cut-offs [a, b, c, d] by age: below a is low, b to c is
    standard, c to d high, from d very high. */
const FAT = [
  [12, { female: [12, 21, 30, 34], male: [7, 16, 25, 30] }],
  [14, { female: [15, 24, 33, 37], male: [7, 16, 25, 30] }],
  [16, { female: [18, 27, 36, 40], male: [7, 16, 25, 30] }],
  [18, { female: [20, 28, 37, 41], male: [7, 16, 25, 30] }],
  [40, { female: [21, 28, 35, 40], male: [11, 17, 22, 27] }],
  [60, { female: [22, 29, 36, 41], male: [12, 18, 23, 28] }],
  [Infinity, { female: [23, 30, 37, 42], male: [14, 20, 25, 30] }],
];
export const fatScale = (sex, age) => (SEXES.includes(sex) && fin(age) ? FAT.find(([under]) => age < under)[1][sex] : null);

/** Muscle mass kg [low, high] by height (cm). */
export function muscleScale(sex, heightCm) {
  if (!SEXES.includes(sex) || !fin(heightCm)) return null;
  if (sex === 'male') return heightCm >= 170 ? [49.4, 59.5] : heightCm >= 160 ? [44.0, 52.5] : [38.5, 46.6];
  return heightCm >= 160 ? [36.5, 42.6] : heightCm >= 150 ? [32.9, 37.6] : [29.1, 34.8];
}
export const waterScale = (sex) => (sex === 'male' ? [55.0, 65.1] : sex === 'female' ? [45.0, 60.1] : null);
export const VISCERAL = [10, 15];
/** Bone mass kg [low, high] by weight. */
export function boneScale(sex, kg) {
  if (!SEXES.includes(sex) || !fin(kg)) return null;
  if (sex === 'male') return kg >= 75 ? [2.0, 4.2] : kg >= 60 ? [1.9, 4.1] : [1.6, 3.9];
  return kg >= 60 ? [1.8, 3.9] : kg >= 45 ? [1.5, 3.8] : [1.3, 3.6];
}
/** The BMR the app calls standard: weight times a factor by age. */
export function bmrStandard(sex, age, kg) {
  if (!SEXES.includes(sex) || !fin(age) || !fin(kg)) return null;
  const k = sex === 'male' ? (age < 30 ? 21.6 : age < 50 ? 20.07 : 19.35) : (age < 30 ? 21.24 : age < 50 ? 19.53 : 18.63);
  return kg * k;
}
export const PROTEIN = [16, 20];
export const BMI = [18.5, 25, 28, 32];

/** The weight the app calls standard. With a sex, the app's own formula;
    without one, the weight of a BMI of 22. */
export function standardWeight(sex, heightCm) {
  if (!fin(heightCm) || heightCm < 100) return null;
  if (sex === 'female') return (heightCm - 70) * 0.6;
  if (sex === 'male') return (heightCm - 80) * 0.7;
  return 22 * (heightCm / 100) ** 2;
}

/** Janssen et al. 2000 (above). */
export function skeletalMuscle({ sex, age, heightCm, ohm }) {
  if (!SEXES.includes(sex) || !fin(age) || !fin(heightCm) || !fin(ohm) || ohm < 200 || ohm > 1500) return null;
  return 0.401 * (heightCm ** 2 / ohm) + 3.825 * (sex === 'male' ? 1 : 0) - 0.071 * age + 5.102;
}

/* ── body type ──────────────────────────────────────────────────────── */

/** The nine, as the Xiaomi app names them: fat high / standard / low
    (rows) by muscle low / standard / high (columns). */
export const BODY_TYPES = [
  ['obese', 'Obese', 'More fat and less muscle than the standard ranges'],
  ['overweight', 'Overweight', 'More fat than standard, with standard muscle'],
  ['thick_set', 'Thick-set', 'More fat than standard, with plenty of muscle'],
  ['lack_exercise', 'Lack of exercise', 'Standard fat, less muscle than standard'],
  ['balanced', 'Balanced', 'Fat and muscle both in the standard range'],
  ['balanced_muscular', 'Balanced muscular', 'Standard fat, with plenty of muscle'],
  ['skinny', 'Skinny', 'Less fat and less muscle than standard'],
  ['balanced_skinny', 'Balanced skinny', 'Less fat than standard, with standard muscle'],
  ['skinny_muscular', 'Skinny muscular', 'Less fat than standard, with plenty of muscle'],
].map(([id, label, text], i) => ({ i, id, label, text }));

export function bodyType({ fatPct, muscleKg, sex, age, heightCm }) {
  const fs = fatScale(sex, age); const ms = muscleScale(sex, heightCm);
  if (!fs || !ms || !fin(fatPct) || !fin(muscleKg)) return null;
  const row = fatPct > fs[2] ? 0 : fatPct < fs[1] ? 2 : 1;
  const col = muscleKg > ms[1] ? 2 : muscleKg < ms[0] ? 0 : 1;
  return BODY_TYPES[row * 3 + col];
}

/* ── body score ─────────────────────────────────────────────────────── */

/** Points taken off, rising from minM at `max` to maxM at `min` (never below zero before the base is added). */
const malus = (v, min, max, maxM, minM) => Math.max(0, ((v - max) / (min - max)) * (maxM - minM));

const PARTS = [['bmi', 'BMI'], ['fat', 'Body fat'], ['muscle', 'Muscle'], ['water', 'Water'], ['visceral', 'Visceral fat'], ['bone', 'Bone mass'], ['bmr', 'BMR'], ['protein', 'Protein']];

/**
 * The body score, out of 100: { score, parts: [{ id, label, off }] } with
 * the points each number took off, or null when an input is missing.
 * Protein is counted only when the scale sent it.
 */
export function bodyScore({ sex, age, heightCm, weightKg, bmi, fatPct, muscleKg, waterPct, visceral, boneKg, bmr, proteinPct }) {
  const fs = fatScale(sex, age);
  const need = [heightCm, weightKg, bmi, fatPct, muscleKg, waterPct, visceral, boneKg, bmr];
  if (!fs || !need.every(fin)) return null;
  const off = {};
  // BMI: nothing off for an adult at 18.5 and up whose fat is not high.
  off.bmi = (() => {
    if (heightCm < 90) return 0;
    if (fatPct < fs[2] && ((age >= 18 && bmi >= 18.5) || (age < 18 && bmi >= 14))) return 0;
    if (bmi <= 14) return 30;
    if (bmi < 15) return malus(bmi, 14, 15, 30, 15) + 15;
    if (bmi < 18.5 && age >= 18) return malus(bmi, 15, 18.5, 15, 5) + 5;
    if (fatPct >= fs[2]) { if (bmi >= 32) return 10; if (bmi > 28) return 5; }
    return 0;
  })();
  off.fat = (() => {
    const best = fs[2] - (sex === 'male' ? 3 : 2);
    if (fatPct >= fs[0] && fatPct < best) return 0;
    if (fatPct >= fs[3]) return 20;
    if (fatPct > fs[2]) return malus(fatPct, fs[3], fs[2], 20, 10) + 10;      // slightly high
    if (fatPct >= best) return ((fatPct - best) / (fs[2] - best)) * 6 + 3;   // the top of standard: 3 to 9
    return clamp(((fs[0] - fatPct) / (fs[0] - 1)) * 7, 0, 7) + 3;            // very low: 3 to 10
  })();
  const ms = muscleScale(sex, heightCm);
  off.muscle = muscleKg >= ms[0] ? 0 : muscleKg < ms[0] - 5 ? 10 : malus(muscleKg, ms[0] - 5, ms[0], 10, 5) + 5;
  const ws = waterScale(sex);
  off.water = waterPct >= ws[0] ? 0 : waterPct <= ws[0] - 5 ? 10 : malus(waterPct, ws[0] - 5, ws[0], 10, 5) + 5;
  off.visceral = visceral < VISCERAL[0] ? 0 : visceral >= VISCERAL[1] ? 15 : malus(visceral, VISCERAL[1], VISCERAL[0], 15, 10) + 10;
  const bs = boneScale(sex, weightKg);
  off.bone = boneKg >= bs[0] ? 0 : boneKg <= bs[0] - 0.3 ? 10 : malus(boneKg, bs[0] - 0.3, bs[0], 10, 5) + 5;
  const std = bmrStandard(sex, age, weightKg);
  // +5 as the app has it (the reference notes 3 would be more consistent).
  off.bmr = bmr >= std ? 0 : bmr <= std - 300 ? 6 : malus(bmr, std - 300, std, 6, 3) + 5;
  off.protein = !fin(proteinPct) ? 0 : proteinPct > 17 ? 0 : proteinPct < 10 ? 10 : proteinPct <= 16 ? malus(proteinPct, 10, 16, 10, 5) + 5 : malus(proteinPct, 16, 17, 5, 3) + 3;
  const total = Object.values(off).reduce((a, b) => a + b, 0);
  return {
    score: Math.round(clamp(100 - total, 0, 100)),
    exact: r2(clamp(100 - total, 0, 100)),
    parts: PARTS.filter(([k]) => k !== 'protein' || fin(proteinPct)).map(([id, label]) => ({ id, label, off: r1(off[id]) })),
  };
}
/** The score in words: the app's bands (50, 60, 80, 90). */
export const scoreWord = (s) => (!fin(s) ? null : s >= 90 ? 'Excellent' : s >= 80 ? 'Good' : s >= 60 ? 'Fair' : 'Low');

/* ── ranges ─────────────────────────────────────────────────────────── */

/** Bands from cut-offs: [{ label, lo, hi, std }], open at both ends. */
function bands(cuts, labels, std = 'Standard') {
  return labels.map((label, i) => ({ label, lo: i === 0 ? null : r2(cuts[i - 1]), hi: i === cuts.length ? null : r2(cuts[i]), std: label === std }));
}
/** Which band a value is in (a value on a cut-off is in the band above it). */
export const bandOf = (list, v) => (fin(v) && list ? list.findIndex((b) => (b.lo === null || v >= b.lo) && (b.hi === null || v < b.hi)) : -1);

/**
 * The range of one number for one person, or null when it needs what is
 * not known (sex, age, height).
 */
export function rangeOf(id, p) {
  const { sex, age, heightCm, weightKg } = p;
  const h2 = fin(heightCm) ? (heightCm / 100) ** 2 : null;
  switch (id) {
    case 'bmi': return bands(BMI.slice(0, 3), ['Low', 'Standard', 'High', 'Very high']);
    case 'weightKg': return h2 ? bands(BMI.slice(0, 3).map((b) => b * h2), ['Low', 'Standard', 'High', 'Very high']) : null;
    case 'fatPct': { const s = fatScale(sex, age); return s ? bands(s, ['Low', 'Lean', 'Standard', 'High', 'Very high']) : null; }
    case 'fatKg': { const s = fatScale(sex, age); return s && fin(weightKg) ? bands(s.map((x) => (x * weightKg) / 100), ['Low', 'Lean', 'Standard', 'High', 'Very high']) : null; }
    case 'muscleKg': { const s = muscleScale(sex, heightCm); return s ? bands(s, ['Low', 'Standard', 'High']) : null; }
    case 'waterPct': { const s = waterScale(sex); return s ? bands(s, ['Low', 'Standard', 'High']) : null; }
    case 'visceral': return bands(VISCERAL, ['Standard', 'High', 'Very high']);
    case 'boneKg': { const s = boneScale(sex, weightKg); return s ? bands(s, ['Low', 'Standard', 'High']) : null; }
    case 'bmr': { const s = bmrStandard(sex, age, weightKg); return s ? bands([s], ['Low', 'Standard']) : null; }
    case 'proteinPct': return bands(PROTEIN, ['Low', 'Standard', 'High']);
    case 'proteinKg': return fin(weightKg) ? bands(PROTEIN.map((x) => (x * weightKg) / 100), ['Low', 'Standard', 'High']) : null;
    case 'whr': return sex === 'female' ? bands([0.85], ['Standard', 'High']) : sex === 'male' ? bands([0.9], ['Standard', 'High']) : null;
    default: return null;
  }
}

/* ── one weigh-in, everything ───────────────────────────────────────── */

/**
 * The numbers of the Body composition page, in the order it lists them.
 * sent: the scale's own number (else ours, worked out); unit; decimals;
 * group: where the page puts it.
 */
export const FIELDS = [
  { id: 'weightKg', label: 'Weight', unit: 'kg', decimals: 1, group: 'main', sent: true },
  { id: 'bmi', label: 'BMI', unit: null, decimals: 1, group: 'main', sent: true },
  { id: 'fatPct', label: 'Body fat', unit: '%', decimals: 1, group: 'fat', sent: true },
  { id: 'fatKg', label: 'Fat mass', unit: 'kg', decimals: 1, group: 'fat' },
  { id: 'visceral', label: 'Visceral fat', unit: null, decimals: 0, group: 'fat', sent: true, about: 'A rating from 1 to 59; under 10 is the standard range.' },
  { id: 'leanKg', label: 'Fat-free mass', unit: 'kg', decimals: 1, group: 'lean' },
  { id: 'muscleKg', label: 'Muscle mass', unit: 'kg', decimals: 1, group: 'lean', sent: true },
  { id: 'musclePct', label: 'Muscle %', unit: '%', decimals: 1, group: 'lean' },
  { id: 'skeletalKg', label: 'Skeletal muscle', unit: 'kg', decimals: 1, group: 'lean', about: 'Estimated from the scale\'s impedance (Janssen and others, 2000). The scale does not send one.' },
  { id: 'skeletalPct', label: 'Skeletal muscle %', unit: '%', decimals: 1, group: 'lean' },
  { id: 'waterPct', label: 'Body water', unit: '%', decimals: 1, group: 'lean', sent: true },
  { id: 'waterKg', label: 'Body water mass', unit: 'kg', decimals: 1, group: 'lean' },
  { id: 'proteinPct', label: 'Protein', unit: '%', decimals: 1, group: 'lean', sent: true },
  { id: 'proteinKg', label: 'Protein mass', unit: 'kg', decimals: 1, group: 'lean' },
  { id: 'boneKg', label: 'Bone mineral', unit: 'kg', decimals: 1, group: 'lean', sent: true },
  { id: 'bonePct', label: 'Bone mineral %', unit: '%', decimals: 1, group: 'lean' },
  { id: 'bmr', label: 'Basal metabolic rate', unit: 'kcal', decimals: 0, group: 'energy', sent: true },
  { id: 'metabolicAge', label: 'Body age', unit: 'years', decimals: 0, group: 'energy', sent: true },
  { id: 'whr', label: 'Waist-to-hip ratio', unit: null, decimals: 2, group: 'energy', from: 'tape', about: 'From your tape measurements (Body measurements). Xiaomi\'s own estimate is not published, so it is not guessed here.' },
  { id: 'heartRate', label: 'Heart rate', unit: 'bpm', decimals: 0, group: 'energy', sent: true },
];

/**
 * Everything for one weigh-in.
 * @param {object} d      a bodycomp row's data (weightKg, fatPct, muscleKg, waterPct, boneKg,
 *                        proteinPct, proteinKg, visceral, bmr, metabolicAge, bmi, impedance, bodyType, heartRate)
 * @param {object} p      the person: { sex, age, heightCm }; any may be null
 * @param {object} [o]    { whr: { waist, hips } } from tape measurements
 * @returns {{ values, ranges, bodyType, score, goals, needs }}
 */
export function analyse(d, p = {}, o = {}) {
  const w = d.weightKg;
  const sex = SEXES.includes(p.sex) ? p.sex : null;
  const age = fin(p.age) ? p.age : null;
  const heightCm = fin(p.heightCm) && p.heightCm >= 100 && p.heightCm <= 230 ? p.heightCm : null;
  const has = (k) => fin(d[k]);
  const v = {};
  for (const k of ['weightKg', 'fatPct', 'visceral', 'muscleKg', 'waterPct', 'proteinPct', 'proteinKg', 'boneKg', 'bmr', 'metabolicAge', 'heartRate']) if (has(k)) v[k] = d[k];
  v.bmi = has('bmi') && d.bmi > 0 ? d.bmi : heightCm && fin(w) ? w / (heightCm / 100) ** 2 : undefined;
  if (fin(w) && w > 0) {
    if (has('fatPct')) { v.fatKg = (w * d.fatPct) / 100; v.leanKg = w - v.fatKg; }
    if (has('waterPct')) v.waterKg = (w * d.waterPct) / 100;
    if (!has('proteinKg') && has('proteinPct')) v.proteinKg = (w * d.proteinPct) / 100;
    if (!has('proteinPct') && has('proteinKg')) v.proteinPct = (d.proteinKg / w) * 100;
    if (has('muscleKg')) v.musclePct = (d.muscleKg / w) * 100;
    if (has('boneKg')) v.bonePct = (d.boneKg / w) * 100;
    const sm = skeletalMuscle({ sex, age, heightCm, ohm: d.impedance });
    if (fin(sm) && sm > 0 && sm < w) { v.skeletalKg = sm; v.skeletalPct = (sm / w) * 100; }
  }
  if (fin(o.whr?.waist) && fin(o.whr?.hips) && o.whr.hips > 0) v.whr = o.whr.waist / o.whr.hips;
  for (const k of Object.keys(v)) if (!fin(v[k])) delete v[k];

  const person = { sex, age, heightCm, weightKg: w };
  const ranges = {};
  for (const k of Object.keys(v)) { const r = rangeOf(k, person); if (r) ranges[k] = { bands: r, at: bandOf(r, v[k]) }; }

  // Body type: Xiaomi's word when it sent one (a code is not a word: its meaning is not published), else ours.
  let type = null;
  const sent = typeof d.bodyType === 'string' && d.bodyType && !/^\d+$/.test(d.bodyType) ? d.bodyType : null;
  const ours = bodyType({ fatPct: v.fatPct, muscleKg: v.muscleKg, sex, age, heightCm });
  if (sent) type = { id: null, label: sent[0].toUpperCase() + sent.slice(1), text: 'As your Xiaomi scale named it', from: 'scale' };
  else if (ours) type = { id: ours.id, label: ours.label, text: ours.text, from: 'estimate', i: ours.i };

  const sc = bodyScore({ sex, age, heightCm, weightKg: w, bmi: v.bmi, fatPct: v.fatPct, muscleKg: v.muscleKg, waterPct: v.waterPct, visceral: v.visceral, boneKg: v.boneKg, bmr: v.bmr, proteinPct: v.proteinPct });
  const score = sc ? { value: sc.score, word: scoreWord(sc.score), parts: sc.parts } : null;

  // Weight goals: how far from the standard weight, the standard fat and the standard muscle.
  const goals = {};
  const sw = standardWeight(sex, heightCm);
  if (fin(sw) && fin(w)) { goals.standardWeight = r1(sw); goals.weightControl = r1(w - sw); }
  const fs = fatScale(sex, age);
  if (fs && fin(v.fatKg)) {
    const lo = (w * fs[1]) / 100; const hi = (w * fs[2]) / 100;
    goals.fatControl = r1(v.fatKg > hi ? v.fatKg - hi : v.fatKg < lo ? v.fatKg - lo : 0);
  }
  const ms = muscleScale(sex, heightCm);
  if (ms && fin(v.muscleKg)) goals.muscleControl = r1(v.muscleKg < ms[0] ? v.muscleKg - ms[0] : 0);

  const needs = [!sex && 'sex', age === null && 'age', !heightCm && 'height'].filter(Boolean);
  return { values: v, ranges, bodyType: type, score, goals, needs };
}
