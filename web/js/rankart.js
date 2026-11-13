/* Rank insignia (server/rating.js), in the awards' language (medals.css):
   flat, two tones of one metal, the marks pressed in, nothing lit and nothing
   cast. The metals are the plates' own; Diamond, Master and Grandmaster add
   an ice blue, a ruby and an emerald.

   The tier is the crest's shape, each a step grander than the last:
     Bronze    a round-topped shield        Platinum  a six-sided crest
     Silver    a shield peaked at the top   Diamond   a diamond, set on its point
     Gold      a shield with a three-point top
     Master    ruby: a crowned shield, notched at the shoulders
     Grandmaster  emerald: a winged crest, points out at both sides
     Legend    two metals: a silver frame with a fluted crown, a dark field
               inside it, the chevrons raised in silver
     Champion  two metals: a gold frame with a peak and two points, a dark
               field inside it, all three chevrons and a star above them in gold
               (3,200: every week at the cap)

   The division is what is pressed into it, I to III (the numeral is the
   number of chevrons):
     I    one chevron
     II   two chevrons
     III  three chevrons

   Somebody not placed yet has the plain shield with an x pressed in.

   Light runs across Champion now and then, as across a new medal once;
   it stops under reduced motion. */

import { raw } from './ui.js';

/* mid: the crest and its inner field; ring: the deep band between them. Marks are pressed in on-metal, always on mid. */
const METAL = {
  bronze: { mid: 'var(--aw-bronze)', ring: 'var(--aw-bronze-lo)' },
  silver: { mid: 'var(--aw-silver)', ring: 'var(--aw-silver-lo)' },
  gold: { mid: 'var(--aw-gold)', ring: 'var(--aw-gold-lo)' },
  platinum: { mid: 'var(--aw-platinum)', ring: 'var(--aw-platinum-lo)' },
  diamond: { mid: '#A9C8F7', ring: '#648ACF' },
  master: { mid: '#EE7A76', ring: '#B44147' },
  grandmaster: { mid: '#5CC796', ring: '#328A65' },
  none: { mid: 'var(--aw-none)', ring: 'var(--aw-none-lo)', ink: 'var(--aw-none-ink)' },
};

const rosette = (cx, cy, ro, ri, n) => {
  let d = '';
  for (let i = 0; i < n * 2; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / n; const r = i % 2 ? ri : ro;
    d += `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)} `;
  }
  return `${d}Z`;
};
const star = (cx, cy, ro, ri) => rosette(cx, cy, ro, ri, 5);

/* Shapes in a 64 × 64 box, centre (32, 33). */
const SHAPE = {
  bronze: 'M32 4 C42 4 52 7 56 10 V30 C56 45 46 55 32 61 C18 55 8 45 8 30 V10 C12 7 22 4 32 4 Z',
  silver: 'M8 12 L32 3 L56 12 V30 C56 45 46 55 32 61 C18 55 8 45 8 30 Z',
  gold: 'M8 10 L20 14 L32 3 L44 14 L56 10 V30 C56 45 46 55 32 61 C18 55 8 45 8 30 Z',
  platinum: 'M32 3 L57 17 V47 L32 61 L7 47 V17 Z',
  diamond: 'M32 2 L61 32 L32 62 L3 32 Z',
  master: 'M8 7 L22 10 L32 3 L42 10 L56 7 L53 19 L56 30 C56 45 46 55 32 61 C18 55 8 45 8 30 L11 19 Z',
  grandmaster: 'M32 2 L41 10 L54 6 L52 18 L61 26 L52 34 C50 46 42 55 32 62 C22 55 14 46 12 34 L3 26 L12 18 L10 6 L23 10 Z',
  none: 'M32 4 C42 4 52 7 56 10 V30 C56 45 46 55 32 61 C18 55 8 45 8 30 V10 C12 7 22 4 32 4 Z',
};
/* The middle of each shape as the eye reads it: the chevrons are stacked around it, the stud above them. */
const MID = { bronze: 32, silver: 33, gold: 34, platinum: 32, diamond: 32, master: 34, grandmaster: 31, legend: 35, none: 32 };
const STEP = 6.4;
/** The y of each chevron (its tip) for `n` of them, centred on the shape, and of the stud above. */
function marksFor(tier, n) {
  const h = 5 + STEP * (n - 1);
  const top = (MID[tier] ?? 32) - h / 2;
  return { chev: Array.from({ length: n }, (_, i) => top + i * STEP), stud: top - 5.5 };
}
/* A chevron: narrow enough to sit inside the rim of the narrowest shape (the diamond) with room around it. */
const chev = (y, w = 7.5) => `M${32 - w} ${y + 5} L32 ${y} L${32 + w} ${y + 5}`;

let seq = 0;

/* The two-metal crests: a frame of metal, a dark field inside, the marks in the metal. */
const FRAMED = {
  legend: { shape: 'M32 2 L38 9 L48 5 L52 13 L60 12 V32 C60 47 47 57 32 63 C17 57 4 47 4 32 V12 L12 13 L16 5 L26 9 Z', metal: METAL.silver, field: '#1C2438' },
  champion: { shape: 'M32 2 L44 11 L59 6 V30 C59 47 47 57 32 63 C17 57 5 47 5 30 V6 L20 11 Z', metal: METAL.gold, field: 'var(--on-metal)' },
};
/* The marks are drawn heavier as the crest gets smaller: a 3-unit line is one blurred pixel at 28 px. */
const MARK_W = { s: 4.6, m: 3.7 };
function framed(tier, id, n, size) {
  const { shape, metal: M, field } = FRAMED[tier];
  const champ = tier === 'champion';
  const at = (k) => `transform="translate(32 33) scale(${k}) translate(-32 -33)"`;
  const ys = champ ? [27.5, 33.9, 40.3] : marksFor(tier, n).chev;
  return `<svg viewBox="0 0 64 64" class="rk__svg" aria-hidden="true" focusable="false">
    ${champ ? `<defs><clipPath id="${id}c"><path d="${shape}"/></clipPath>
    <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0.38" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.62" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` : ''}
    <path d="${shape}" fill="${M.mid}"/>
    <path d="${shape}" ${at(0.88)} fill="${M.ring}"/>
    <path d="${shape}" ${at(0.74)} fill="${field}"/>
    ${champ ? `<path d="${star(32, 19.5, 5.4, 2.4)}" fill="${M.mid}"/>` : ''}
    ${ys.map((y) => `<path d="${chev(y, 7)}" fill="none" stroke="${M.mid}" stroke-width="${champ ? Math.min(MARK_W[size] || 3, 3.6) : MARK_W[size] || 3}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
    ${champ ? `<g clip-path="url(#${id}c)"><rect class="rk__shine" x="-64" y="0" width="64" height="64" fill="url(#${id}s)"/></g>` : ''}
  </svg>`;
}

/**
 * The insignia of a rank ({ tier, division, name }), or the plain one for
 * somebody not placed yet (null). `size`: s (a list), m, l (a profile), xl (a sheet's head).
 */
export function rankEmblem(rank, { size = 'm' } = {}) {
  const tier = rank?.tier || 'none';
  const n = rank ? ({ I: 1, II: 2, III: 3 }[rank.division] || 1) : 0;
  if (FRAMED[tier]) {
    return raw(`<span class="rk rk--${tier} rk--${size}" role="img" aria-label="${rank.name}">${framed(tier, `rk${(seq += 1).toString(36)}`, n, size)}</span>`);
  }
  const m = METAL[tier];
  const shape = SHAPE[tier];
  const at = marksFor(tier, n);
  const ys = at.chev;
  const ink = m.ink || 'var(--on-metal)';
  const mark = (d, w) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const svg = `<svg viewBox="0 0 64 64" class="rk__svg" aria-hidden="true" focusable="false">
    <path d="${shape}" fill="${m.mid}"/>
    <path d="${shape}" transform="translate(32 32.5) scale(0.88) translate(-32 -32.5)" fill="${m.ring}"/>
    <path d="${shape}" transform="translate(32 32.5) scale(0.74) translate(-32 -32.5)" fill="${m.mid}"/>
    ${ys.map((y) => mark(chev(y), MARK_W[size] || 3)).join('')}
    ${rank ? '' : mark('M25 25 L39 39 M39 25 L25 39', Math.max(3.6, MARK_W[size] || 0))}
  </svg>`;
  return raw(`<span class="rk rk--${tier} rk--${size}" role="img" aria-label="${rank ? rank.name : 'Not placed yet'}">${svg}</span>`);
}
