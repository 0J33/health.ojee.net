/* The showcase's objects, flat, in the plate's language: hard fills in two tones of each metal,
   no outlines, no gradients, every object drawn square on (front or side), its depth shown only
   as a darker copy of itself set a little below or beside. The gold plate is not drawn here:
   one plate travels through the whole page and lands where ANCHOR says (cx, cy, r, in the
   480-unit box). Every part that moves carries data-part; landing3-stage.js moves them. */

const SV = ['#CBD1DC', '#8793A7']; const BR = ['#C98352', '#905330'];
const ST = ['#D6CFC4', '#7A7268']; const BG = '#0A0908';
const NUM = 'font-family="Instrument Sans, system-ui, sans-serif" style="font-variant-numeric: tabular-nums lining-nums; font-stretch: 88%"';

/** The plate face on, for the silver and bronze medals. */
const plate = (x, y, r, [f, ring], rim = null) => `${rim ? `<circle cx="${x}" cy="${y}" r="${r + 5}" fill="${rim}"/>` : ''}<circle cx="${x}" cy="${y}" r="${r}" fill="${f}"/><circle cx="${x}" cy="${y}" r="${r * 0.75}" fill="${ring}"/><circle cx="${x}" cy="${y}" r="${r * 0.37}" fill="${f}"/><circle cx="${x}" cy="${y}" r="${r * 0.17}" fill="${BG}"/>`;

/** Where the travelling gold plate sits on each object. */
export const ANCHOR = {
  watch: [240, 210, 24],
  bike: [228, 322, 30],
  scale: [240, 140, 18],
  podium: [240, 142, 54],
};

export const ART = {
  watch: `<svg viewBox="0 0 480 480">
    <rect x="182" y="22" width="116" height="140" rx="28" fill="#4A443C"/><rect x="232" y="22" width="16" height="140" fill="#3A352F"/>
    <rect x="182" y="318" width="116" height="140" rx="28" fill="#4A443C"/><rect x="232" y="318" width="16" height="140" fill="#3A352F"/>
    ${[372, 400, 428].map((y) => `<circle cx="240" cy="${y}" r="6" fill="#2A2622"/>`).join('')}
    <rect x="342" y="190" width="24" height="48" rx="9" fill="${SV[1]}"/>
    <rect x="344" y="258" width="16" height="36" rx="7" fill="${SV[1]}"/>
    <rect x="130" y="126" width="220" height="228" rx="56" fill="${SV[0]}"/>
    <rect x="142" y="138" width="196" height="204" rx="46" fill="${SV[1]}"/>
    <rect x="153" y="149" width="174" height="182" rx="37" fill="${BG}"/>
    <circle cx="240" cy="210" r="41" fill="none" stroke="#2A2622" stroke-width="10"/>
    <circle data-part="ring" cx="240" cy="210" r="41" fill="none" stroke="#E7B653" stroke-width="10" stroke-linecap="round" pathLength="100" stroke-dasharray="70 100" transform="rotate(-90 240 210)"/>
    <text data-part="rec" x="240" y="294" text-anchor="middle" fill="#F2EDE5" ${NUM} font-weight="600" font-size="32">70</text>
    <text x="240" y="316" text-anchor="middle" fill="#A39B90" font-family="Instrument Sans, system-ui, sans-serif" font-weight="600" font-size="13">Recovery</text>
  </svg>`,

  bike: `<svg viewBox="0 0 480 480">
    ${[[118, 318], [362, 318]].map(([x, y]) => `<g data-part="spin" style="transform-origin:${x}px ${y}px">
        ${Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return `<line x1="${x}" y1="${y}" x2="${(x + Math.cos(a) * 72).toFixed(1)}" y2="${(y + Math.sin(a) * 72).toFixed(1)}" stroke="${ST[1]}" stroke-width="2.5"/>`; }).join('')}
      </g>
      <circle cx="${x}" cy="${y}" r="76" fill="none" stroke="${ST[0]}" stroke-width="6"/>
      <circle cx="${x}" cy="${y}" r="86" fill="none" stroke="#5A534A" stroke-width="14"/>
      <circle cx="${x}" cy="${y}" r="9" fill="${ST[0]}"/>`).join('')}
    <circle cx="118" cy="318" r="14" fill="${ST[1]}"/>
    <g stroke="${ST[1]}" stroke-width="4" stroke-linecap="round"><path d="M228 292 L118 304"/><path d="M228 352 L118 332"/></g>
    <g fill="none" stroke="${SV[0]}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M118 318 L228 322" stroke-width="9"/><path d="M118 318 L204 196" stroke-width="9"/>
      <path d="M228 322 L204 196" stroke-width="13"/><path d="M204 196 L332 200" stroke-width="13"/><path d="M228 322 L342 236" stroke-width="15"/>
      <path d="M332 200 L342 236" stroke-width="18"/>
      <path d="M342 236 Q350 280 362 318" stroke-width="10"/>
      <path d="M204 196 L198 166" stroke-width="9"/>
      <path d="M332 200 L328 170" stroke-width="9"/>
    </g>
    <rect x="164" y="154" width="68" height="14" rx="7" fill="${SV[1]}"/>
    <rect x="312" y="164" width="52" height="11" rx="5.5" fill="${SV[1]}"/><rect x="350" y="163" width="22" height="13" rx="6.5" fill="#5A534A"/>
    <g data-part="crank" style="transform-origin:228px 322px"><rect x="223" y="272" width="10" height="100" rx="5" fill="${SV[1]}"/></g>
    <rect data-part="pedal" data-end="1" x="210" y="366" width="36" height="12" rx="3" fill="#5A534A"/>
    <rect data-part="pedal" data-end="-1" x="210" y="266" width="36" height="12" rx="3" fill="#5A534A"/>
  </svg>`,

  scale: `<svg viewBox="0 0 480 480">
    <rect x="96" y="114" width="288" height="290" rx="56" fill="${ST[1]}"/>
    <rect x="96" y="96" width="288" height="290" rx="56" fill="${ST[0]}"/>
    <rect x="111" y="111" width="258" height="260" rx="44" fill="#2A2622"/>
    <circle cx="240" cy="140" r="23" fill="${BG}"/>
    <rect x="192" y="170" width="96" height="30" rx="9" fill="${BG}"/>
    <text data-part="num" x="232" y="191" text-anchor="middle" fill="#E7B653" ${NUM} font-weight="600" font-size="19">72.4</text>
    <text x="268" y="191" text-anchor="middle" fill="#A39B90" font-family="Instrument Sans, system-ui, sans-serif" font-weight="600" font-size="10">kg</text>
    <rect x="138" y="214" width="94" height="146" rx="47" fill="#4A443C"/><rect x="248" y="214" width="94" height="146" rx="47" fill="#4A443C"/>
  </svg>`,

  podium: `<svg viewBox="0 0 480 480">
    ${[[54, 250, 2, 1], [180, 196, 1, 0], [306, 290, 3, 2]].map(([x, top, n, i]) => `<g data-part="step" data-i="${i}" style="transform-origin:${x + 60}px 412px">
      <rect x="${x}" y="${top}" width="120" height="${412 - top}" rx="6" fill="#3A352F"/></g>
      <text data-part="place" data-i="${i}" x="${x + 60}" y="${top + 64}" text-anchor="middle" fill="#F2EDE5" font-family="Instrument Sans, system-ui, sans-serif" font-weight="650" font-size="42">${n}</text>`).join('')}
    <rect x="38" y="412" width="404" height="6" rx="3" fill="#2A2622"/>
    <g data-part="medal" data-i="0">${plate(114, 204, 46, SV)}</g>
    <g data-part="medal" data-i="1">${plate(366, 248, 42, BR)}</g>
  </svg>`,
};
