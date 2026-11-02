/* Rank insignia (server/rating.js), drawn in the medals' language
   (medals.css): metal lit from the top left, a struck rim, the marks
   pressed into it, a soft shadow under it. The metals are the medals'
   own; Diamond and Champion add an ice blue and a deep violet.

   The tier is the crest's shape, each a step grander than the last:
     Bronze    a round-topped shield        Platinum  a six-sided crest
     Silver    a shield peaked at the top   Diamond   a diamond, set on its point
     Gold      a shield with a three-point top
     Champion  a twelve-point rosette, a star pressed in

   The division is what is pressed into it, I to III (the numeral is the
   number of chevrons):
     I    one chevron
     II   two chevrons, and a second rim inside the first
     III  three chevrons, the second rim, and a stud at the top

   Champion's ring turns slowly and the light runs across it now and
   then, as a new medal's does once; both stop under reduced motion. */

import { raw } from './ui.js';

/* hi, mid, lo: the metal lit from the top left (as .md__disc); ink: what is pressed in. */
const METAL = {
  bronze: { hi: '#F6D2AE', mid: '#C98A55', lo: '#87502A', ink: '#4D2A12' },
  silver: { hi: '#F7F8FA', mid: '#C9CED5', lo: '#868E99', ink: '#3F4650' },
  gold: { hi: '#FBEDB4', mid: '#E4B94C', lo: '#A9791C', ink: '#5E400B' },
  platinum: { hi: '#F1FAFC', mid: '#BFDCE3', lo: '#7BA2AC', ink: '#2F5059' },
  diamond: { hi: '#EEF5FF', mid: '#9DBDF2', lo: '#4A6FB8', ink: '#1E3466' },
  champion: { hi: '#B9A2F5', mid: '#5E43C2', lo: '#22165C', ink: '#FFD25E' },
  none: { hi: '#E4DFD8', mid: '#C7C0B6', lo: '#958D82', ink: '#6E675E' },
};

const rosette = (cx, cy, ro, ri, n = 12) => {
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
  champion: rosette(32, 32, 30, 25),
  none: 'M32 4 C42 4 52 7 56 10 V30 C56 45 46 55 32 61 C18 55 8 45 8 30 V10 C12 7 22 4 32 4 Z',
};
/* Where the chevrons sit, top first, and the stud. */
const MARKS = {
  diamond: { chev: [24, 31, 38], stud: 13 },
  platinum: { chev: [26, 33, 40], stud: 12 },
  default: { chev: [24, 31, 38], stud: 12 },
};
const chev = (y, w = 10) => `M${32 - w} ${y + 6} L32 ${y} L${32 + w} ${y + 6}`;

let seq = 0;

/**
 * The insignia of a rank ({ tier, division, name }), or the plain one for
 * somebody not placed yet (null). `size`: s (a list), m, l (a profile), xl (a sheet's head).
 */
export function rankEmblem(rank, { size = 'm' } = {}) {
  const tier = rank?.tier || 'none';
  const champ = tier === 'champion';
  const n = champ ? 0 : rank ? ({ I: 1, II: 2, III: 3 }[rank.division] || 1) : 0;
  const m = METAL[tier];
  const id = `rk${(seq += 1).toString(36)}`;
  const shape = SHAPE[tier];
  const at = MARKS[tier] || MARKS.default;
  const ys = at.chev.slice(0, n);
  // Pressed in: the mark in the ink, a hairline of light under it (as the medals' icons).
  const pressed = (d, w) => `<path d="${d}" transform="translate(0 0.9)" fill="none" stroke="${m.hi}" stroke-opacity="0.75" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${m.ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const inner = (k) => `<path d="${shape}" transform="translate(32 32.5) scale(${k}) translate(-32 -32.5)" fill="none" stroke="${m.hi}" stroke-opacity="0.6" stroke-width="1.4" stroke-linejoin="round"/>`;
  const svg = `<svg viewBox="0 0 64 64" class="rk__svg" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="${id}m" cx="0.32" cy="0.26" r="0.86"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.46" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.lo}"/></radialGradient>
      <clipPath id="${id}c"><path d="${shape}"/></clipPath>
      ${champ ? `<linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0.38" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.7"/><stop offset="0.62" stop-color="#fff" stop-opacity="0"/></linearGradient>` : ''}
    </defs>
    ${champ ? '<circle class="rk__ring" cx="32" cy="32" r="31" fill="none" stroke="#E4B94C" stroke-width="1.3" stroke-dasharray="2.2 3.6" stroke-linecap="round"/>' : ''}
    <path d="${shape}" fill="url(#${id}m)" stroke="${m.lo}" stroke-width="1.6" stroke-linejoin="round"/>
    ${inner(champ ? 0.9 : 0.88)}
    ${n >= 2 || champ ? inner(champ ? 0.66 : 0.74) : ''}
    ${champ ? `<path d="${star(32, 33.5, 13, 5.6)}" transform="translate(0 0.9)" fill="${m.hi}" fill-opacity="0.55"/><path d="${star(32, 33.5, 13, 5.6)}" fill="${m.ink}" stroke="#B9831F" stroke-width="0.8" stroke-linejoin="round"/>` : ''}
    ${ys.map((y) => pressed(chev(y), 3.6)).join('')}
    ${n >= 3 ? `<circle cx="32" cy="${at.stud + 0.9}" r="2.6" fill="${m.hi}" fill-opacity="0.75"/><circle cx="32" cy="${at.stud}" r="2.6" fill="${m.ink}"/>` : ''}
    ${champ ? `<g clip-path="url(#${id}c)"><rect class="rk__shine" x="-64" y="0" width="64" height="64" fill="url(#${id}s)"/></g>` : ''}
  </svg>`;
  return raw(`<span class="rk rk--${tier} rk--${size}" role="img" aria-label="${rank ? rank.name : 'Not placed yet'}">${svg}</span>`);
}
