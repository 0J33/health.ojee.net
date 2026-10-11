#!/usr/bin/env node
/* Builds web/js/icons.js from Material Symbols (Rounded, weight 400), so the
   app has one icon family: the same grid, weight and corner radius in every
   tab, metric, action and settings row.

   Material Symbols is by Google, licensed Apache-2.0 (see docs/ICONS.md).
   Only the glyphs named below are shipped, as path data inside a JS module
   served from our own origin: no icon font, no external host.

     npm pack @material-symbols/svg-400 && tar -xzf material-symbols-svg-400-*.tgz
     node scripts/make-icon-set.mjs <path-to>/package

   Each icon has an outline and a filled drawing. `fill: true` below makes
   the filled one the default (metrics, which take their family's colour);
   everything else defaults to the outline, and the tab bar shows the filled
   one for the selected tab. */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/make-icon-set.mjs <path to @material-symbols/svg-400 package>'); process.exit(1); }
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js', 'icons.js');

/* our name: [material name, filled by default?] */
const MAP = {
  // navigation
  today: ['sunny'], trends: ['monitoring'], workouts: ['exercise'], ranks: ['trophy'], me: ['person'],
  // metrics (filled: they carry a family colour)
  steps: ['steps', true], distance: ['distance', true], bolt: ['bolt', true], flame: ['local_fire_department', true],
  heart: ['favorite', true], resting: ['hr_resting', true], ecg: ['ecg_heart', true], wave: ['vital_signs', true],
  spo2: ['spo2', true], temp: ['thermometer', true], drop: ['water_drop', true],
  moon: ['bedtime', true], sleepscore: ['sleep_score', true], deep: ['airline_seat_flat', true], rem: ['relax', true], awake: ['light_mode', true],
  scale: ['monitor_weight', true], bodyfat: ['body_fat', true],
  readiness: ['readiness_score', true], streak: ['mode_heat', true], record: ['award_star', true], medal: ['military_tech', true],
  leaderboard: ['leaderboard', true], target: ['target', true],
  // exercise types
  strength: ['fitness_center', true], run: ['directions_run', true], walk: ['directions_walk', true], bike: ['directions_bike', true],
  swim: ['pool', true], hike: ['hiking', true], yoga: ['self_improvement', true], sport: ['sports_and_outdoors', true], rowing: ['rowing', true],
  // time, devices
  clock: ['schedule'], timer: ['timer'], calendar: ['calendar_month'], week: ['date_range'], history: ['history'],
  battery: ['battery_horiz_075'], watch: ['watch'], phone: ['mobile'], screen: ['desktop_windows'],
  // actions
  refresh: ['sync'], right: ['chevron_right'], left: ['chevron_left'], up: ['arrow_upward'], down: ['arrow_downward'], flat: ['remove'],
  more_down: ['keyboard_arrow_down'], plus: ['add'], check: ['check'], x: ['close'], play: ['play_arrow', true], stop: ['stop', true], pause: ['pause', true],
  more: ['more_horiz'], external: ['open_in_new'], copy: ['content_copy'], share: ['ios_share'], addbox: ['add_box'],
  download: ['download'], upload: ['upload'], trash: ['delete'], edit: ['edit'], compare: ['compare_arrows'], sort: ['swap_vert'], search: ['search'],
  // states and settings
  alert: ['warning'], info: ['info'], help: ['help'], bell: ['notifications'], lock: ['lock'], globe: ['public'],
  eye: ['visibility'], eyeoff: ['visibility_off'], settings: ['settings'], link: ['link'], key: ['key'], text: ['description'],
  shield: ['shield'], logout: ['logout'], sun: ['light_mode'], users: ['group'], offline: ['cloud_off'], flag: ['flag'],
  data: ['database'], route: ['route'], list: ['list'], admin: ['tune'], spark: ['wand_stars'], idea: ['lightbulb'], chair: ['chair'], sick: ['sick'],
};

const BOTH = new Set(['today', 'trends', 'workouts', 'ranks', 'me', 'heart', 'bell', 'lock', 'eye']);

const read = (name, fill) => {
  // A glyph with no enclosed area has no separate filled drawing.
  let file = join(src, 'rounded', `${name}${fill ? '-fill' : ''}.svg`);
  if (fill && !existsSync(file)) file = join(src, 'rounded', `${name}.svg`);
  const svg = readFileSync(file, 'utf8');
  const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!d.length) throw new Error(`no path in ${file}`);
  return d.join('');
};

const lines = []; const filled = [];
for (const [name, [glyph, fillDefault]] of Object.entries(MAP)) {
  // Only the drawings that are used ship: both for the tabs (outline, and
  // filled when selected), the filled one for metrics, the outline for the rest.
  const both = BOTH.has(name);
  lines.push(`  ${JSON.stringify(name)}: [${both || !fillDefault ? JSON.stringify(read(glyph, false)) : 'null'}, ${both || fillDefault ? JSON.stringify(read(glyph, true)) : 'null'}],`);
  if (fillDefault) filled.push(name);
}

const pulse = 'm24,12c0,.552-.447,1-1,1h-2.466c-.452,0-.849.305-.966.74l-1.677,6.242c-.191.625-.725,1.018-1.341,1.018h-.017c-.623-.007-1.155-.415-1.324-1.014l-3.274-13.226-3.178,11.239c-.191.597-.69.976-1.28.999-.612.033-1.119-.315-1.345-.862l-1.6-4.474c-.143-.396-.521-.663-.942-.663H1c-.553,0-1-.448-1-1s.447-1,1-1h2.591c1.264,0,2.398.799,2.825,1.989l.938,2.626,3.284-11.615c.201-.625.727-1.027,1.361-1,.618.011,1.146.418,1.315,1.012l3.259,13.166,1.062-3.956c.351-1.308,1.542-2.222,2.897-2.222h2.466c.553,0,1,.448,1,1Z';

writeFileSync(out, `/* GENERATED by scripts/make-icon-set.mjs — do not edit by hand.

   One icon family: Material Symbols Rounded, weight 400 (Google, Apache-2.0;
   see docs/ICONS.md). Every glyph is a filled path on a 960 grid, so .ic is
   \`fill: currentColor; stroke: none\`. Metric glyphs are the filled drawing and take their family's colour;
   actions are the outline; the tabs have both (filled when selected).
   \`pulse\` is the app's own mark (docs/heart-rate.svg), on its own 24 grid.
   Inline SVG only: nothing is fetched and nothing is an emoji. */

const P = {
${lines.join('\n')}
};

const FILLED = new Set(${JSON.stringify(filled)});
const PULSE = '<path d="${pulse}"/>';

/**
 * An icon as an SVG string. Decorative by default (aria-hidden); pass a
 * label when the icon is the only content of a control. \`fill\` picks the
 * filled or the outline drawing (default: filled for metric glyphs).
 */
export function icon(name, { size = '', label = '', fill = null } = {}) {
  const a11y = label ? \`role="img" aria-label="\${label.replace(/"/g, '&quot;')}"\` : 'aria-hidden="true" focusable="false"';
  const cls = \`ic\${size ? \` ic--\${size}\` : ''}\`;
  if (name === 'pulse') return \`<svg class="\${cls}" viewBox="0 0 24 24" \${a11y}>\${PULSE}</svg>\`;
  const p = P[name] || P.info;
  const want = (fill ?? FILLED.has(name)) ? 1 : 0;
  const d = p[want] ?? p[1 - want];
  return \`<svg class="\${cls}" viewBox="0 -960 960 960" \${a11y}><path d="\${d}"/></svg>\`;
}

export const hasIcon = (name) => name === 'pulse' || name in P;
export const iconNames = () => ['pulse', ...Object.keys(P)];
`);
console.log(`wrote ${out}: ${Object.keys(MAP).length} icons`);
