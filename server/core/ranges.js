/* ============================================================
   health.ojee.net — reference ranges for the metric pages. Pure
   functions: no database, no clock.

   For a metric, a value and the person, which band the value falls in:
   general population reference ranges from public sources, the app's own
   bands for the app's own scores, and the person's own usual range where
   a number differs too much between people for a population range to
   mean anything (HRV, sleep temperature). A guide for wellness, not
   medical advice: no word here diagnoses anything, and the tones are
   calm ones (docs/RELEASE.md, section 3).

   A band is { label, from, to, tone }: from inclusive, to exclusive, null
   at an open end. Tones: 'good' (a band people aim for), 'ok' (the
   typical, standard band), 'low' and 'high' (below or above it; drawn
   quietly, never as an alarm).

   Sources, each named on screen in the ranges sheet:

     Resting heart rate   American Heart Association, "All About Heart Rate":
                          60 to 100 bpm at rest for most adults; well-trained
                          athletes can be nearer 40.
                          https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse
     Breathing rate,      Cleveland Clinic, "Vital Signs": 12 to 18 breaths
     body temperature     a minute at rest; 36.5 to 37.3 °C; above 38 °C is a fever.
                          https://my.clevelandclinic.org/health/articles/10881-vital-signs
     Blood oxygen         Cleveland Clinic, "Blood Oxygen Level": 95 to 100% for
                          most people; at home, 92% or lower is a reason to call
                          a provider.
                          https://my.clevelandclinic.org/health/diagnostics/22447-blood-oxygen-level
     Blood glucose        American Diabetes Association, "Diagnosis": fasting
                          under 100 mg/dL normal, 100 to 125 above it, 126 and up
                          high; under 70 is low ("Hypoglycemia").
                          https://diabetes.org/about-diabetes/diagnosis
     VO2 max              The Cooper Institute's norms, as Garmin's manuals reprint
                          them with permission: 40th, 60th, 80th, 95th percentiles
                          by sex and age (Poor, Fair, Good, Excellent, Superior).
                          https://www8.garmin.com/manuals/webhelp/edge530/EN-US/GUID-1FBCCD9E-19E1-4E4C-BD60-1793B5B97EB3.html
     Steps                Tudor-Locke C, Bassett DR. "How many steps/day are
                          enough?" Sports Med 2004;34:1-8: under 5,000 sedentary,
                          5,000 low active, 7,500 somewhat active, 10,000 active,
                          12,500 highly active.  https://pubmed.ncbi.nlm.nih.gov/14715035/
     Active minutes,      WHO, "Physical activity" fact sheet: adults 150 to 300
     cardio minutes       minutes of moderate activity a week (or 75 to 150
                          vigorous).  https://www.who.int/news-room/fact-sheets/detail/physical-activity
     Sleep                National Sleep Foundation, Hirshkowitz M et al., Sleep
                          Health 2015;1:40-43: recommended and "may be
                          appropriate" hours by age.
                          https://www.thensf.org/how-many-hours-of-sleep-do-you-really-need/
     Sleep efficiency     National Sleep Foundation, Ohayon M et al., Sleep Health
                          2017;3:6-19: 85% and up is good sleep quality at every
                          age, 74% and under is not.  https://doi.org/10.1016/j.sleh.2016.11.006
     Sleep stages         Texas Health Resources, "How Much Deep, Light and REM
                          Sleep Do You Need?": deep about 13 to 25% of the night,
                          REM about 20 to 25%.
                          https://www.texashealth.org/areyouawellbeing/Health-and-Well-Being/How-Much-Deep-Light-and-REM-Sleep-Do-You-Need
     Stress               Garmin: 0 to 25 rest, 26 to 50 low, 51 to 75 medium,
                          76 to 100 high.  https://www8.garmin.com/manuals/webhelp/vivoactive4_4S/EN-US/GUID-9282196F-D969-404D-B678-F48A13D8D0CB.html
     Body Battery         Garmin's manuals: 5 to 25 very low, 26 to 50 low, 51 to
                          75 medium, 76 to 100 high reserve energy.
                          https://www8.garmin.com/manuals/webhelp/vivoactive4_4S/EN-US/GUID-87E1392B-2C55-40B7-A1FF-3AB9252DA0A0.html
     Waist                WHO, "Waist circumference and waist-hip ratio" (expert
                          consultation, 2008): over 94 cm (men) / 80 cm (women)
                          raised, over 102 / 88 high; waist-to-hip 0.90 / 0.85.
                          https://www.who.int/publications/i/item/9789241501491
     Body composition     core/bodycomp.js: the ranges the Xiaomi scale's app uses
                          (BMI's 18.5 and 25 are the WHO's).
     Scores               the app's own bands (core/scores.js, core/bodycomp.js,
                          core/derived.js).
   ============================================================ */

import { rangeOf as compRange } from './bodycomp.js';

const fin = Number.isFinite;
const r2 = (x) => Math.round(x * 100) / 100;

export const NOTE = 'A guide, not medical advice.';

const S = {
  aha: { name: 'American Heart Association', url: 'https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse' },
  ccVitals: { name: 'Cleveland Clinic', url: 'https://my.clevelandclinic.org/health/articles/10881-vital-signs' },
  ccSpo2: { name: 'Cleveland Clinic', url: 'https://my.clevelandclinic.org/health/diagnostics/22447-blood-oxygen-level' },
  ada: { name: 'American Diabetes Association', url: 'https://diabetes.org/about-diabetes/diagnosis' },
  cooper: { name: 'The Cooper Institute', url: 'https://www8.garmin.com/manuals/webhelp/edge530/EN-US/GUID-1FBCCD9E-19E1-4E4C-BD60-1793B5B97EB3.html' },
  tudor: { name: 'Tudor-Locke and Bassett, Sports Medicine, 2004', url: 'https://pubmed.ncbi.nlm.nih.gov/14715035/' },
  who: { name: 'World Health Organization', url: 'https://www.who.int/news-room/fact-sheets/detail/physical-activity' },
  nsf: { name: 'National Sleep Foundation', url: 'https://www.thensf.org/how-many-hours-of-sleep-do-you-really-need/' },
  nsfQ: { name: 'National Sleep Foundation (Ohayon and others, 2017)', url: 'https://doi.org/10.1016/j.sleh.2016.11.006' },
  stages: { name: 'Texas Health Resources', url: 'https://www.texashealth.org/areyouawellbeing/Health-and-Well-Being/How-Much-Deep-Light-and-REM-Sleep-Do-You-Need' },
  gStress: { name: 'Garmin', url: 'https://www8.garmin.com/manuals/webhelp/vivoactive4_4S/EN-US/GUID-9282196F-D969-404D-B678-F48A13D8D0CB.html' },
  gBattery: { name: 'Garmin', url: 'https://www8.garmin.com/manuals/webhelp/vivoactive4_4S/EN-US/GUID-87E1392B-2C55-40B7-A1FF-3AB9252DA0A0.html' },
  whoWaist: { name: 'World Health Organization', url: 'https://www.who.int/publications/i/item/9789241501491' },
  xiaomi: { name: 'The Xiaomi scale app\'s standard ranges', url: null },
  janssen: { name: 'Janssen, Heymsfield and Ross, Journal of the American Geriatrics Society, 2002', url: 'https://pubmed.ncbi.nlm.nih.gov/12028177/' },
  efsa: { name: 'European Food Safety Authority, 2010', url: 'https://www.efsa.europa.eu/en/efsajournal/pub/1459' },
  bmi: { name: 'World Health Organization (18.5, 25); the Xiaomi scale app (28, 32)', url: 'https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight' },
  app: { name: 'This app\'s own bands', url: null },
  own: { name: 'Your own last 30 days', url: null },
};

/**
 * Bands from cut-offs and [label, tone] pairs (one more pair than
 * cut-offs). A cut-off may be [at, shown]: where a source's range ends on
 * a number that is still in it ("60 to 100"), the cut is just above it
 * and `shown` is the number to write: the band below reads "to 100" and
 * the one above "over 100".
 */
function cut(cuts, pairs) {
  const at = cuts.map((x) => (Array.isArray(x) ? x[0] : x));
  const shown = cuts.map((x) => (Array.isArray(x) ? x[1] : null));
  return pairs.map(([label, tone], i) => {
    const b = { label, from: i === 0 ? null : at[i - 1], to: i === at.length ? null : at[i], tone };
    if (i < at.length && shown[i] !== null) b.toShown = shown[i];
    if (i > 0 && shown[i - 1] !== null) b.over = shown[i - 1];
    return b;
  });
}
/** The band a value is in (a value on a cut-off is in the band above it); -1 for none. */
export const bandIndex = (bands, v) => (fin(v) && bands ? bands.findIndex((b) => (b.from === null || v >= b.from) && (b.to === null || v < b.to)) : -1);

/* ── the tables ─────────────────────────────────────────────────────── */

/** Cooper Institute VO2 max cut-offs [Fair, Good, Excellent, Superior] (40th, 60th, 80th, 95th percentiles), by decade from 20. */
const VO2 = {
  male: [[41.7, 45.4, 51.1, 55.4], [40.5, 44.0, 48.3, 54.0], [38.5, 42.4, 46.4, 52.5], [35.6, 39.2, 43.4, 48.9], [32.3, 35.5, 39.5, 45.7], [29.4, 32.3, 36.7, 42.1]],
  female: [[36.1, 39.5, 43.9, 49.6], [34.4, 37.8, 42.4, 47.4], [33.0, 36.3, 39.7, 45.3], [30.1, 33.0, 36.7, 41.1], [27.5, 30.0, 33.0, 37.8], [25.9, 28.1, 30.9, 36.7]],
};
export function vo2Cuts(sex, age) {
  if (!VO2[sex] || !fin(age) || age < 18) return null;
  return VO2[sex][Math.min(5, Math.max(0, Math.floor((age - 20) / 10)))];
}

/** National Sleep Foundation hours by age: [may be appropriate from, recommended from, recommended to, may be appropriate to]. */
export function sleepHours(age) {
  if (!fin(age)) return [6, 7, 9, 10];           // adults, when the age is not known
  if (age < 14) return [7, 9, 11, 12];            // 6 to 13
  if (age < 18) return [7, 8, 10, 11];            // 14 to 17
  if (age < 26) return [6, 7, 9, 11];             // 18 to 25
  if (age < 65) return [6, 7, 9, 10];             // 26 to 64
  return [5, 7, 8, 9];                            // 65 and up
}

/** WHO waist cut-offs (cm): [raised from, high from]. */
const WAIST = { male: [94, 102], female: [80, 88] };

/* ── what each metric needs ─────────────────────────────────────────── */

/** What a metric's range needs of the person, beyond its value. */
const NEEDS = {
  vo2max: ['sex', 'age'], body_fat: ['sex', 'age'], muscle_mass: ['sex', 'height'], body_water: ['sex'],
  basal_rate: ['sex', 'age', 'weight'], measurements: ['sex'], weight: ['height'], bone_mineral: ['sex', 'weight'], protein_mass: ['weight'],
  skeletal_muscle: ['sex', 'weight'], body_age: ['age'], calories_basal: ['sex', 'age', 'weight'], water: ['sex'],
};
/** The person's details a metric's range is missing: [] when it has all it needs (or needs none). */
export function rangeNeeds(id, p = {}) {
  const has = { sex: p.sex === 'female' || p.sex === 'male', age: fin(p.age), height: fin(p.heightCm), weight: fin(p.weightKg) };
  return (NEEDS[id] || []).filter((k) => !has[k]);
}

/** The metrics this file gives a range for, and the ones it never does (with why; docs/SPEC.md). */
export const RANGED = ['resting_hr', 'hrv', 'vo2max', 'recovery', 'readiness', 'resilience', 'steps', 'active', 'cardio_week', 'sleep', 'sleep_score', 'sleep_stages', 'sleep_efficiency',
  'weight', 'body_fat', 'measurements', 'muscle_mass', 'body_water', 'protein_mass', 'bone_mineral', 'skeletal_muscle', 'body_age', 'calories_basal', 'water', 'visceral_fat', 'basal_rate', 'body_score', 'bmi', 'resp', 'spo2', 'skin_temp', 'body_temp', 'glucose', 'stress', 'body_battery'];

/* ── the person's own usual ─────────────────────────────────────────── */

/**
 * The person's usual range from their own days: the mean and one
 * standard deviation either side of it. null under 10 days.
 */
export function ownBaseline(values) {
  const v = (values || []).filter(fin);
  if (v.length < 10) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  return { mean, sd, n: v.length };
}

/* ── one range ──────────────────────────────────────────────────────── */

/**
 * The range of one metric for one value and person, or null when no
 * sensible range applies (or the person's details it needs are missing:
 * see rangeNeeds).
 *
 * @param {string} id        a catalogue metric id, or 'deep' / 'rem' (shares of sleep, %) or 'whr'
 * @param {number} value     in the catalogue's unit (sleep in minutes, temperatures in °C)
 * @param {object} [p]       { sex, age, heightCm, weightKg }; any may be null
 * @param {object} [o]       { baseline: number[] } the person's own 30 days, for hrv and skin_temp
 * @returns {{ id, title, value, bands, at, current, tone, source: { name, url }, note } | null}
 */
export function rangeFor(id, value, p = {}, o = {}) {
  if (!fin(value)) return null;
  const sex = p.sex === 'female' || p.sex === 'male' ? p.sex : null;
  const age = fin(p.age) ? p.age : null;
  const spec = specOf(id, value, { sex, age, heightCm: fin(p.heightCm) ? p.heightCm : null, weightKg: fin(p.weightKg) ? p.weightKg : null }, o);
  if (!spec) return null;
  const bands = spec.bands.map((b) => ({ ...b, from: b.from === null ? null : r2(b.from), to: b.to === null ? null : r2(b.to) }));
  for (const b of bands) { if (b.toShown === undefined) delete b.toShown; if (b.over === undefined) delete b.over; }
  const at = bandIndex(bands, value);
  return {
    id, title: spec.title || null, value, bands, at,
    current: at >= 0 ? bands[at].label : null, tone: at >= 0 ? bands[at].tone : null,
    source: spec.source, note: spec.note ? `${spec.note} ${NOTE}` : NOTE,
  };
}

/** A body composition range (core/bodycomp.js) in this file's shape. */
function fromComp(compId, p, label) {
  const b = compRange(compId, p);
  if (!b) return null;
  return {
    bands: b.map((x) => ({ label: x.label, from: x.lo, to: x.hi, tone: x.std ? 'ok' : x.label === 'Lean' || (compId === 'muscleKg' && x.label === 'High') || x.label === 'Under your age' ? 'good' : /low/i.test(x.label) ? 'low' : 'high' })),
    source: compId === 'bmi' || compId === 'weightKg' ? S.bmi : compId === 'whr' ? S.whoWaist : compId === 'skeletalKg' ? S.janssen : S.xiaomi,
    note: compId === 'skeletalKg' ? label : `${label} The ranges a Xiaomi body composition scale's app uses${compId === 'bmi' || compId === 'weightKg' ? '' : ' for your sex, age and height'}.`,
  };
}

function specOf(id, v, p, o) {
  const { sex, age } = p;
  switch (id) {
    /* heart */
    case 'resting_hr': return {
      bands: cut([40, 60, [100.5, 100]], [['Very low', 'low'], ['Low', 'good'], ['Typical', 'ok'], ['High', 'high']]),
      source: S.aha, note: 'For your resting heart rate. 60 to 100 beats a minute at rest is typical for adults; below 60 is common in fit people, and well-trained ones are often nearer 40.',
    };
    case 'hrv': case 'skin_temp': {
      const b = ownBaseline(o.baseline);
      if (!b) return null;
      const half = Math.max(b.sd, id === 'hrv' ? 1 : 0.05);
      const word = id === 'hrv' ? 'HRV' : 'sleep temperature';
      return {
        bands: cut([b.mean - half, b.mean + half], [['Below your usual', 'low'], ['Your usual', 'ok'], ['Above your usual', id === 'hrv' ? 'good' : 'high']]),
        source: S.own,
        note: id === 'hrv'
          ? 'HRV differs too much between people for a population range to mean anything, so this is your usual range: your average over the 30 days before, give or take one of your ordinary day-to-day swings.'
          : `Sleep temperature is already a difference from your own baseline, so this is your usual range of it: your average ${word} over the 30 days before, give or take one of your ordinary night-to-night swings.`,
      };
    }
    case 'vo2max': {
      const c = vo2Cuts(sex, age);
      if (!c) return null;
      return {
        bands: cut(c, [['Poor', 'low'], ['Fair', 'ok'], ['Good', 'good'], ['Excellent', 'good'], ['Superior', 'good']]),
        source: S.cooper, note: `For ${sex === 'female' ? 'women' : 'men'} aged ${age < 30 ? '20 to 29' : age >= 70 ? '70 to 79' : `${Math.floor(age / 10) * 10} to ${Math.floor(age / 10) * 10 + 9}`}: the 40th, 60th, 80th and 95th percentiles of the Cooper Institute's norms. Your watch's VO2 max is an estimate.`,
      };
    }
    case 'recovery': return {
      bands: cut([-0.5, 0.5], [['Below your usual', 'low'], ['Near your usual', 'ok'], ['Above your usual', 'good']]),
      source: S.app, note: 'The app\'s own words for its recovery trend: half of your ordinary day-to-day spread either side of your usual.',
    };
    case 'readiness': return {
      bands: cut([30, 65], [['Low', 'low'], ['Moderate', 'ok'], ['High', 'good']]),
      source: S.app, note: 'The bands this app\'s readiness uses, as Google\'s does.',
    };
    case 'resilience': return {
      bands: cut([35, 65], [['Low', 'low'], ['Balanced', 'ok'], ['Optimal', 'good']]),
      source: S.app, note: 'The bands this app\'s resilience uses, as Google\'s does.',
    };

    /* activity */
    case 'steps': return {
      bands: cut([5000, 7500, 10000, 12500], [['Sedentary', 'low'], ['Low active', 'low'], ['Somewhat active', 'ok'], ['Active', 'good'], ['Highly active', 'good']]),
      source: S.tudor, note: 'For the steps of a day (on a longer period, the average day). Steps a day as researchers group them.',
    };
    case 'active': return {
      bands: cut([150 / 7, 300 / 7], [['Under guideline', 'low'], ['Meets guideline', 'good'], ['Above guideline', 'good']]),
      source: S.who, note: 'For the minutes of a day (on a longer period, the average day). The WHO\'s 150 to 300 minutes of moderate activity a week is about 21 to 43 a day.',
    };
    case 'cardio_week': return {
      bands: cut([150, 300], [['Under guideline', 'low'], ['Meets guideline', 'good'], ['Above guideline', 'good']]),
      source: S.who, note: 'For the minutes of a week. The WHO suggests adults get 150 to 300 minutes of moderate activity a week, or 75 to 150 of vigorous.',
    };

    /* sleep */
    case 'sleep': {
      const [a, b, c, d] = sleepHours(age);
      const h = (x) => x * 60;
      return {
        bands: cut([h(a), h(b), h(c), h(d)], [['Short', 'low'], ['May be enough', 'ok'], ['Recommended', 'good'], ['May be enough', 'ok'], ['Long', 'high']]),
        source: S.nsf, note: `For time asleep in a night (on a longer period, the average night). ${age === null ? 'The hours for adults; add your year of birth for the hours for your age.' : `The hours for your age: ${b} to ${c} recommended, ${a} to ${d} may be enough for some.`}`,
      };
    }
    case 'sleep_score': return {
      bands: cut([60, 80, 90], [['Poor', 'low'], ['Fair', 'ok'], ['Good', 'good'], ['Excellent', 'good']]),
      source: S.app, note: 'The bands of this app\'s sleep score, as Google\'s are.',
    };
    case 'sleep_efficiency': return {
      bands: cut([75, 85], [['Low', 'low'], ['Fair', 'ok'], ['Good', 'good']]),
      source: S.nsfQ, note: 'For the share of time in bed spent asleep. 85% and up is a sign of good sleep at every age; 74% and under is not.',
    };
    case 'deep': return {
      title: 'Deep sleep', bands: cut([13, 25], [['Below typical', 'low'], ['Typical', 'ok'], ['Above typical', 'ok']]),
      source: S.stages, note: 'For deep sleep as a share of time asleep. Typical for healthy adults, and less with age. Devices estimate the stages.',
    };
    case 'rem': return {
      title: 'REM sleep', bands: cut([20, [25.5, 25]], [['Below typical', 'low'], ['Typical', 'ok'], ['Above typical', 'ok']]),
      source: S.stages, note: 'For REM sleep as a share of time asleep. Typical for healthy adults. Devices estimate the stages.',
    };

    /* body */
    case 'weight': return fromComp('weightKg', p, 'For your weight at your height: the weights of the BMI bands.');
    case 'bmi': return fromComp('bmi', p, 'For body mass index. It says nothing about what the weight is made of.');
    case 'body_fat': return fromComp('fatPct', p, 'For body fat as a share of weight.');
    case 'muscle_mass': return fromComp('muscleKg', p, 'For muscle mass.');
    case 'body_water': return fromComp('waterPct', p, 'For body water as a share of weight.');
    case 'visceral_fat': return fromComp('visceral', p, 'For the visceral fat rating.');
    case 'protein_mass': return fromComp('proteinKg', p, 'For protein mass: 16 to 20 % of your weight.');
    case 'bone_mineral': return fromComp('boneKg', p, 'For bone mineral against your weight.');
    case 'skeletal_muscle': return fromComp('skeletalKg', p, 'For skeletal muscle as a share of your weight. Under 37% for men or 28% for women is more than one ordinary spread below the young-adult average, and under 31% or 22% more than two. The study estimated skeletal muscle with the same impedance equation this app uses.');
    case 'body_age': return fromComp('metabolicAge', p, 'For body age against your real age: under it is better, as the scale\'s app has it.');
    case 'calories_basal': return fromComp('bmr', p, 'For resting energy against the standard for your weight and age.');
    case 'water': {
      // EFSA's adequate intake of water from food and drink (2.5 L men, 2.0 L women), about 80% of it from drinks.
      const ai = sex === 'male' ? 2500 : sex === 'female' ? 2000 : null;
      if (!ai) return null;
      return {
        bands: cut([ai * 0.8], [['Under the usual intake', 'low'], ['Meets the usual intake', 'good']]),
        source: S.efsa,
        note: `For the water you logged in a day. The adequate intake for adults is ${ai / 1000} litres a day from food and drink together; about 80% of it, ${(ai * 0.8) / 1000} litres, usually comes from drinks. More is needed in heat and with exercise.`,
      };
    }
    case 'basal_rate': return fromComp('bmr', p, 'For the basal metabolic rate against the standard for your weight and age.');
    case 'body_score': return {
      bands: cut([60, 80, 90], [['Low', 'low'], ['Fair', 'ok'], ['Good', 'good'], ['Excellent', 'good']]),
      source: S.app, note: 'The bands of this app\'s body score, as the Xiaomi app has them.',
    };
    case 'measurements': {
      const w = WAIST[sex];
      if (!w) return null;
      return {
        title: 'Waist', bands: cut([w[0], w[1]], [['Standard', 'ok'], ['Raised', 'high'], ['High', 'high']]),
        source: S.whoWaist, note: `For your waist, the number this page follows. For ${sex === 'female' ? 'women' : 'men'}: over ${w[0]} cm raised, over ${w[1]} cm high.`,
      };
    }
    case 'whr': {
      const b = fromComp('whr', p, '');
      return b ? { ...b, title: 'Waist-to-hip ratio', note: `For the ratio of your latest waist and hips. Over ${sex === 'female' ? '0.85 for women' : '0.90 for men'} is high.` } : null;
    }

    /* vitals */
    case 'resp': return {
      bands: cut([12, [18.05, 18]], [['Below typical', 'low'], ['Typical', 'ok'], ['Above typical', 'high']]),
      source: S.ccVitals, note: 'For breaths a minute. 12 to 18 is typical for adults at rest; asleep, many people are near the low end.',
    };
    case 'spo2': return {
      bands: cut([92, 95], [['Low', 'low'], ['Below typical', 'low'], ['Typical', 'ok']]),
      source: S.ccSpo2, note: 'For the night\'s average oxygen saturation. 95 to 100% is typical; it can be lower with some lung conditions or at altitude. A wrist device estimates it, less exactly than a fingertip one.',
    };
    case 'body_temp': return {
      bands: cut([36.5, [37.35, 37.3], 38], [['Below typical', 'low'], ['Typical', 'ok'], ['Slightly raised', 'high'], ['Raised', 'high']]),
      source: S.ccVitals, note: 'For a body temperature. 36.5 to 37.3 °C is typical for adults; above 38 °C is a fever. It varies with the time of day and where it is measured.',
    };
    case 'glucose': return {
      title: 'For a fasting reading', bands: cut([70, [100, 99], [126, 125]], [['Low', 'low'], ['Typical', 'ok'], ['Above typical', 'high'], ['High', 'high']]),
      source: S.ada, note: 'For a fasting reading (no food for at least 8 hours). A reading after a meal is higher, and these bands do not fit it.',
    };

    /* mind */
    case 'stress': return {
      bands: cut([[26, 25], [51, 50], [76, 75]], [['Rest', 'good'], ['Low', 'ok'], ['Medium', 'high'], ['High', 'high']]),
      source: S.gStress, note: 'For the day\'s average stress level, as your Garmin works it out, in Garmin\'s own levels.',
    };
    case 'body_battery': return {
      bands: cut([[26, 25], [51, 50], [76, 75]], [['Very low', 'low'], ['Low', 'low'], ['Medium', 'ok'], ['High', 'good']]),
      source: S.gBattery, note: 'For the day\'s highest Body Battery, in Garmin\'s own levels of reserve energy.',
    };
    default: return null;
  }
}
