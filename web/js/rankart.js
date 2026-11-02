/* Rank emblems (server/rating.js): one SVG per tier and division.

   The tier gives the shape and the metal, and it grows as it climbs:
     Bronze    a round shield
     Silver    a pointed shield
     Gold      a shield with a crenellated top
     Platinum  a six-sided crest
     Diamond   a cut gem, its facets drawn
     Champion  a five-point star on a medallion, rays turning behind it,
               a metal that shifts colour, a glow and a sweep of light

   The division adds to it, III to I:
     III  one chevron
     II   two chevrons and an inner rim
     I    three chevrons, the inner rim, wings and a stud on top

   Metal is the one place gradients are allowed (docs/DESIGN-SYSTEM.md, as
   for medals). Motion (the champion's rays, light and glow, the diamond's
   glints) stops under reduced motion (b-health.css). */

import { raw } from './ui.js';

const METAL = {
  bronze: { hi: '#F3C9A0', mid: '#C27E48', lo: '#7A4421', ink: '#FFF4EA', edge: '#5A3015' },
  silver: { hi: '#FFFFFF', mid: '#C6CCD4', lo: '#7D8692', ink: '#2E343C', edge: '#59616C' },
  gold: { hi: '#FFF1B8', mid: '#E6B53E', lo: '#9C6C12', ink: '#4A3105', edge: '#6E4A08' },
  platinum: { hi: '#F2FCFF', mid: '#A9D8E2', lo: '#4F8E9C', ink: '#163A43', edge: '#2F6370' },
  diamond: { hi: '#E8F3FF', mid: '#79A8F0', lo: '#2C56B8', ink: '#FFFFFF', edge: '#1D3C86' },
  champion: { hi: '#FFE9A8', mid: '#E85FB8', lo: '#5B3BD6', ink: '#FFFFFF', edge: '#34207F' },
  none: { hi: '#D9D4CD', mid: '#B3ACA3', lo: '#857E75', ink: '#FFFFFF', edge: '#6A645C' },
};

/* Shapes in a 64 × 72 box, centre (32, 37). */
const SHAPE = {
  bronze: 'M32 5 L55 13 V35 C55 51 45 61 32 68 C19 61 9 51 9 35 V13 Z',
  silver: 'M10 11 L32 4 L54 11 V33 C54 49 44 60 32 68 C20 60 10 49 10 33 Z',
  gold: 'M8 11 H17 L21 4 L27 9 L32 3 L37 9 L43 4 L47 11 H56 V35 C56 51 45 61 32 68 C19 61 8 51 8 35 Z',
  platinum: 'M32 3 L58 18 V52 L32 69 L6 52 V18 Z',
  diamond: 'M17 7 H47 L61 25 L32 68 L3 25 Z',
  none: 'M32 5 L55 13 V35 C55 51 45 61 32 68 C19 61 9 51 9 35 V13 Z',
};
const FACETS = 'M3 25 H61 M17 7 L24 25 L32 68 M47 7 L40 25 L32 68 M24 25 L32 7 L40 25';
const star = (cx, cy, ro, ri) => {
  let d = '';
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 ? ri : ro;
    d += `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)} `;
  }
  return `${d}Z`;
};
const rays = (cx, cy, n = 16, r1 = 24, r2 = 40) => {
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const a = (i * 2 * Math.PI) / n; const w = Math.PI / n / 2.2;
    const p = (ang, r) => `${(cx + r * Math.cos(ang)).toFixed(2)} ${(cy + r * Math.sin(ang)).toFixed(2)}`;
    d += `M${p(a - w, r1)} L${p(a, i % 2 ? r2 - 6 : r2)} L${p(a + w, r1)} Z `;
  }
  return d;
};
const WING_L = 'M9 24 C2 22 -4 26 -6 31 C-2 31 1 30 3 30 C-2 33 -4 37 -4 41 C0 39 3 37 5 37 C2 40 1 44 2 47 C5 44 8 42 10 40 Z';
const WING_R = 'M55 24 C62 22 68 26 70 31 C66 31 63 30 61 30 C66 33 68 37 68 41 C64 39 61 37 59 37 C62 40 63 44 62 47 C59 44 56 42 54 40 Z';
const chevron = (y) => `M21 ${y + 6} L32 ${y} L43 ${y + 6}`;
const CHEV_Y = { diamond: [30, 38, 46], default: [44, 36, 28] };

let seq = 0;

/**
 * The emblem for a rank ({ tier, division, name }), or the grey "placing" one
 * for null. `size`: s (a list), m, l (a profile), xl (the sheet's head).
 */
export function rankEmblem(rank, { size = 'm' } = {}) {
  const tier = rank?.tier || 'none';
  const div = rank?.division || null;
  const n = tier === 'champion' ? 0 : { III: 1, II: 2, I: 3 }[div] || (tier === 'none' ? 0 : 1);
  const m = METAL[tier];
  const id = `rk${(seq += 1).toString(36)}`;
  const champ = tier === 'champion';
  const shape = champ ? null : SHAPE[tier];
  const rim = n >= 2 || champ;
  const wings = n >= 3 || champ;
  const label = rank ? rank.name : 'Not placed yet';
  const ys = (CHEV_Y[tier] || CHEV_Y.default).slice(0, n);
  const body = champ
    ? `<circle cx="32" cy="37" r="25" fill="url(#${id}m)" stroke="${m.edge}" stroke-width="1.6"/>
       <circle cx="32" cy="37" r="20.5" fill="none" stroke="${m.hi}" stroke-opacity="0.75" stroke-width="1.2"/>
       <path d="${star(32, 38, 15.5, 6.8)}" fill="url(#${id}s)" stroke="${m.edge}" stroke-width="1" stroke-linejoin="round"/>`
    : `<path d="${shape}" fill="url(#${id}m)" stroke="${m.edge}" stroke-width="1.6" stroke-linejoin="round"/>
       ${tier === 'diamond' ? `<path d="${FACETS}" fill="none" stroke="${m.hi}" stroke-opacity="0.55" stroke-width="1"/>` : ''}
       ${rim ? `<path d="${shape}" transform="translate(32 37) scale(0.8) translate(-32 -37)" fill="none" stroke="${m.hi}" stroke-opacity="0.8" stroke-width="1.6" stroke-linejoin="round"/>` : ''}`;
  const svg = `<svg viewBox="-10 -6 84 82" class="rk__svg" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${id}m" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stop-color="${m.hi}"/><stop offset="0.48" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.lo}"/>
        ${champ ? `<animate attributeName="x2" values="0.35;1;0.35" dur="6s" repeatCount="indefinite" class="rk__anim"/>` : ''}
      </linearGradient>
      ${champ ? `<linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF8DA"/><stop offset="0.5" stop-color="#FFD25E"/><stop offset="1" stop-color="#E08A1E"/></linearGradient>
        <radialGradient id="${id}g"><stop offset="0" stop-color="#FF7AD0" stop-opacity="0.55"/><stop offset="1" stop-color="#7A5BFF" stop-opacity="0"/></radialGradient>` : ''}
      <clipPath id="${id}c">${champ ? '<circle cx="32" cy="37" r="25"/>' : `<path d="${shape}"/>`}</clipPath>
      <linearGradient id="${id}w" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    </defs>
    ${champ ? `<circle class="rk__glow" cx="32" cy="37" r="40" fill="url(#${id}g)"/>
      <g class="rk__rays"><path d="${rays(32, 37)}" fill="#FFD25E" fill-opacity="0.85"/></g>` : ''}
    ${wings ? `<path d="${WING_L}" fill="url(#${id}m)" stroke="${m.edge}" stroke-width="1.2" stroke-linejoin="round"/><path d="${WING_R}" fill="url(#${id}m)" stroke="${m.edge}" stroke-width="1.2" stroke-linejoin="round"/>` : ''}
    ${body}
    <g clip-path="url(#${id}c)">
      <path d="M-4 4 L68 4 L68 26 C46 32 18 32 -4 24 Z" fill="#fff" fill-opacity="0.22"/>
      ${champ || tier === 'diamond' || n >= 3 ? `<rect class="rk__sweep" x="-30" y="-6" width="22" height="84" fill="url(#${id}w)" transform="skewX(-18)"/>` : ''}
    </g>
    ${ys.map((y) => `<path d="${chevron(y)}" fill="none" stroke="${m.edge}" stroke-opacity="0.5" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="${chevron(y)}" fill="none" stroke="${m.ink}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
    ${n >= 3 ? `<circle cx="32" cy="${tier === 'diamond' ? 15 : tier === 'gold' ? 14 : 14}" r="3.4" fill="${m.ink}" stroke="${m.edge}" stroke-width="1"/>` : ''}
    ${tier === 'diamond' ? '<path class="rk__glint" d="M50 12 l1.6 4 l4 1.6 l-4 1.6 l-1.6 4 l-1.6 -4 l-4 -1.6 l4 -1.6 Z" fill="#fff"/>' : ''}
    ${champ ? '<path class="rk__glint" d="M54 10 l1.8 4.4 l4.4 1.8 l-4.4 1.8 l-1.8 4.4 l-1.8 -4.4 l-4.4 -1.8 l4.4 -1.8 Z" fill="#fff"/><path class="rk__glint rk__glint--2" d="M8 58 l1.3 3.2 l3.2 1.3 l-3.2 1.3 l-1.3 3.2 l-1.3 -3.2 l-3.2 -1.3 l3.2 -1.3 Z" fill="#fff"/>' : ''}
  </svg>`;
  return raw(`<span class="rk rk--${tier} rk--${size}${div ? ` rk--d${n}` : ''}" role="img" aria-label="${label}">${svg}</span>`);
}
