/* Body composition worked out the way the Xiaomi app does (server/core/bodycomp.js),
   against what the reference implementation (lolouk44/xiaomi_mi_scale,
   body_score.py and body_scales.py, MIT) gives for the same people. The
   expected numbers below were printed by that Python code. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, bodyScore, bodyType, fatScale, muscleScale, boneScale, bmrStandard, standardWeight, skeletalMuscle, rangeOf, bandOf, ageAt } from '../server/core/bodycomp.js';

const near = (a, b, eps = 0.01, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} is not ${b}`);
const bmiOf = (p) => p.weightKg / (p.heightCm / 100) ** 2;
const offs = (s) => s.parts.map((x) => x.off);

/* Five people. C, D and A take the same path through the score in the
   reference and here; B and E are the two places where the reference's
   branches cannot be reached and this follows its comments instead. */
const C = { sex: 'male', age: 52, heightCm: 170, weightKg: 92, fatPct: 29.5, muscleKg: 61, waterPct: 49, visceral: 16, boneKg: 3.2, bmr: 1800, proteinPct: 15 };
const D = { sex: 'female', age: 24, heightCm: 165, weightKg: 50, fatPct: 22, muscleKg: 35.5, waterPct: 52, visceral: 3, boneKg: 2.0, bmr: 1150, proteinPct: 16.5 };
const A = { sex: 'male', age: 29, heightCm: 178, weightKg: 79.6, fatPct: 18.1, muscleKg: 61.2, waterPct: 56.1, visceral: 8, boneKg: 3.1, bmr: 1720, proteinPct: 18.9 };
const B = { sex: 'female', age: 45, heightCm: 160, weightKg: 59.5, fatPct: 34.7, muscleKg: 36.7, waterPct: 46.9, visceral: 10, boneKg: 2.2, bmr: 1210, proteinPct: 14.1 };
const E = { sex: 'female', age: 35, heightCm: 158, weightKg: 44, fatPct: 15, muscleKg: 34, waterPct: 58, visceral: 1, boneKg: 1.6, bmr: 1000, proteinPct: 17.5 };

test('the body score matches the reference for people on the same path', () => {
  const c = bodyScore({ ...C, bmi: bmiOf(C) });
  near(c.exact, 44.17, 0.01, 'C');
  assert.deepEqual(offs(c), [5, 20, 0, 10, 15, 0, 0, 5.8]);
  const d = bodyScore({ ...D, bmi: bmiOf(D) });
  near(d.exact, 84.62, 0.01, 'D');
  assert.deepEqual(offs(d), [5.4, 0, 6, 0, 0, 0, 0, 4]);
  const a = bodyScore({ ...A, bmi: bmiOf(A) });
  assert.equal(a.score, 100);
  assert.equal(c.score, 44);
  assert.equal(d.score, 85);
});

test('where the reference cannot reach its own branches, the score follows its comments', () => {
  // B: body fat 34.7%, just under the top of standard (36%) for a woman of 45.
  // The reference takes 10 off (its 73.42); "the high part of normal fat" is 3 to 9.
  const b = bodyScore({ ...B, bmi: bmiOf(B) });
  assert.deepEqual(offs(b), [0, 5.1, 0, 0, 10, 0, 0, 6.6]);
  near(b.exact, 100 - 5.1 - 10 - 6.5833, 0.01, 'B');
  // E: body fat 15%, below the low cut-off (21%): the reference takes 10 off (82.50); "very low in fat" is 3 to 10.
  const e = bodyScore({ ...E, bmi: bmiOf(E) });
  assert.equal(offs(e)[0], 7.5, 'BMI part as in the reference (7.4989)');
  near(offs(e)[1], 3 + (6 / 20) * 7, 0.05, 'E fat');
  // Without protein the part is left out; without an input there is no score.
  assert.equal(bodyScore({ ...C, bmi: bmiOf(C), proteinPct: null }).parts.length, 7);
  assert.equal(bodyScore({ ...C, bmi: bmiOf(C), sex: null }), null);
  assert.equal(bodyScore({ ...C, bmi: bmiOf(C), visceral: undefined }), null);
});

test('the scale app\'s tables, by sex, age, height and weight (as the reference prints them)', () => {
  assert.deepEqual(fatScale('male', 52), [12, 18, 23, 28]);
  assert.deepEqual(fatScale('female', 24), [21, 28, 35, 40]);
  assert.deepEqual(fatScale('male', 29), [11, 17, 22, 27]);
  assert.deepEqual(fatScale('female', 45), [22, 29, 36, 41]);
  assert.deepEqual(fatScale('female', 70), [23, 30, 37, 42]);
  assert.deepEqual(fatScale('male', 40), [12, 18, 23, 28], '40 is in the 40 to 60 band');
  assert.equal(fatScale(null, 30), null);
  assert.deepEqual(muscleScale('male', 170), [49.4, 59.5]);
  assert.deepEqual(muscleScale('male', 169), [44.0, 52.5]);
  assert.deepEqual(muscleScale('female', 158), [32.9, 37.6]);
  assert.deepEqual(muscleScale('female', 149), [29.1, 34.8]);
  assert.deepEqual(boneScale('male', 92), [2.0, 4.2]);
  assert.deepEqual(boneScale('female', 44), [1.3, 3.6]);
  assert.deepEqual(boneScale('female', 59.5), [1.5, 3.8]);
  near(bmrStandard('male', 52, 92), 1780.2);
  near(bmrStandard('female', 24, 50), 1062.0);
  near(bmrStandard('female', 45, 59.5), 1162.035);
  near(bmrStandard('male', 29, 79.6), 1719.36);
  // Standard weight: the app's formula with a sex, BMI 22 without.
  near(standardWeight('male', 170), 63.0);
  near(standardWeight('female', 165), 57.0);
  near(standardWeight('male', 178), 68.6);
  near(standardWeight('female', 158), 52.8);
  near(standardWeight(null, 170), 63.58);
});

test('body type: the nine, as the reference classifies them', () => {
  assert.equal(bodyType(C).id, 'thick_set');     // reference 2
  assert.equal(bodyType(D).id, 'skinny');        // reference 6
  assert.equal(bodyType(A).id, 'balanced_muscular');   // reference 5
  assert.equal(bodyType(B).id, 'balanced');       // reference 4
  assert.equal(bodyType(E).id, 'balanced_skinny');  // reference 7
  assert.equal(bodyType({ ...C, sex: null }), null);
});

test('ranges per sex and age: the band a number is in', () => {
  const at = (id, p, v) => { const r = rangeOf(id, p); return r[bandOf(r, v)].label; };
  assert.equal(at('fatPct', { sex: 'male', age: 29 }, 18.1), 'Standard');
  assert.equal(at('fatPct', { sex: 'female', age: 29 }, 18.1), 'Low', 'the same number is low for a woman');
  assert.equal(at('fatPct', { sex: 'male', age: 65 }, 13), 'Low', 'and low for an older man');
  assert.equal(at('fatPct', { sex: 'male', age: 29 }, 22), 'High', 'a cut-off belongs to the band above it');
  assert.equal(at('fatPct', { sex: 'male', age: 29 }, 30), 'Very high');
  assert.equal(at('muscleKg', { sex: 'female', heightCm: 165 }, 35.5), 'Low');
  assert.equal(at('muscleKg', { sex: 'male', heightCm: 178 }, 61.2), 'High');
  assert.equal(at('waterPct', { sex: 'male' }, 49), 'Low');
  assert.equal(at('waterPct', { sex: 'female' }, 49), 'Standard');
  assert.equal(at('visceral', {}, 8), 'Standard');
  assert.equal(at('visceral', {}, 12), 'High');
  assert.equal(at('boneKg', { sex: 'female', weightKg: 59.5 }, 2.2), 'Standard');
  assert.equal(at('bmr', { sex: 'male', age: 52, weightKg: 92 }, 1700), 'Low');
  assert.equal(at('proteinPct', {}, 14.1), 'Low');
  assert.equal(at('bmi', {}, 24.9), 'Standard');
  assert.equal(at('bmi', {}, 29), 'Very high');
  assert.equal(at('whr', { sex: 'female' }, 0.86), 'High');
  assert.equal(at('whr', { sex: 'male' }, 0.86), 'Standard');
  // Unknown sex or age: no range for what depends on them.
  for (const id of ['fatPct', 'muscleKg', 'waterPct', 'boneKg', 'bmr', 'whr']) assert.equal(rangeOf(id, { heightCm: 170, weightKg: 70 }), null, id);
  assert.ok(rangeOf('visceral', {}) && rangeOf('proteinPct', {}) && rangeOf('bmi', {}));
});

test('a weigh-in, everything: masses, shares, goals and what is missing', () => {
  // Rania's real record (tests/xiaomi.test.js): 59.5 kg, 34.7% fat, protein 14.1% and 8.4 kg.
  const d = { weightKg: 59.5, fatPct: 34.7, muscleKg: 36.7, waterPct: 46.9, boneKg: 2.2, proteinPct: 14.1, proteinKg: 8.4, visceral: 10, bmr: 1210, metabolicAge: 45, impedance: 596 };
  const x = analyse(d, { sex: 'female', age: 45, heightCm: 160 });
  const v = x.values;
  near(v.fatKg, 20.65); near(v.leanKg, 38.85); near(v.waterKg, 27.91); near(v.musclePct, 61.68); near(v.bonePct, 3.70);
  assert.equal(v.proteinKg, 8.4, 'the scale\'s own protein mass');
  near(v.bmi, 23.24);
  near(v.skeletalKg, skeletalMuscle({ sex: 'female', age: 45, heightCm: 160, ohm: 596 }));
  near(v.skeletalKg, 0.401 * (160 ** 2 / 596) - 0.071 * 45 + 5.102);
  assert.equal(x.bodyType.id, 'balanced');
  assert.equal(x.bodyType.from, 'estimate');
  assert.equal(x.score.value, 78);
  assert.equal(x.ranges.fatPct.bands[x.ranges.fatPct.at].label, 'Standard');
  assert.equal(x.ranges.proteinPct.bands[x.ranges.proteinPct.at].label, 'Low');
  assert.deepEqual(x.goals, { standardWeight: 54, weightControl: 5.5, fatControl: 0, muscleControl: 0 });
  assert.deepEqual(x.needs, []);
  // A man of 52 over the standard: fat to lose down to the top of standard (23% of 92 kg).
  const c = analyse({ weightKg: 92, fatPct: 29.5, muscleKg: 61, waterPct: 49, boneKg: 3.2, visceral: 16, bmr: 1800, proteinPct: 15 }, { sex: 'male', age: 52, heightCm: 170 });
  assert.deepEqual(c.goals, { standardWeight: 63, weightControl: 29, fatControl: 6, muscleControl: 0 });
  assert.equal(c.score.value, 44);
  // A woman short of muscle and fat: both to gain.
  const dd = analyse({ weightKg: 50, fatPct: 12, muscleKg: 33 }, { sex: 'female', age: 24, heightCm: 165 });
  assert.deepEqual([dd.goals.fatControl, dd.goals.muscleControl], [-8, -3.5]);
  // Nobody known: values, the ranges that need no one, no score, what is missing.
  const n = analyse(d, {});
  assert.deepEqual(n.needs, ['sex', 'age', 'height']);
  assert.equal(n.score, null);
  assert.equal(n.bodyType, null);
  assert.deepEqual(Object.keys(n.ranges).sort(), ['proteinPct', 'visceral']);
  near(n.values.fatKg, 20.65);
  assert.equal(n.values.bmi, undefined, 'no height, no BMI unless the scale sent one');
  assert.equal(analyse({ ...d, bmi: 23.2 }, {}).values.bmi, 23.2);
  // Xiaomi's own word for the body type wins; a bare code does not (its meaning is not published).
  assert.equal(analyse({ ...d, bodyType: 'balanced' }, { sex: 'female', age: 45, heightCm: 160 }).bodyType.label, 'Balanced');
  assert.equal(analyse({ ...d, bodyType: '4' }, { sex: 'female', age: 45, heightCm: 160 }).bodyType.from, 'estimate');
  // Waist and hips from a tape.
  near(analyse(d, { sex: 'female', age: 45 }, { whr: { waist: 80, hips: 100 } }).values.whr, 0.8);
  assert.equal(ageAt(1981, Date.UTC(2026, 9, 31)), 45);
  assert.equal(ageAt(2030, Date.UTC(2026, 9, 31)), null);
});
