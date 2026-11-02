#!/usr/bin/env node
/* Builds docs/design-system/tokens.json and tokens.css from the app's own
   CSS (web/css/app.css for colour, space, radius and shadow in both themes;
   web/css/system.css for control sizes), and checks every text colour's
   contrast on the grounds docs/DESIGN-SYSTEM.md pairs it with.

     npm run design-tokens

   The CSS is the source: change a value there, run this, commit both.
   tokens.json is the tool-readable copy (a list per family, a usage note on
   every token, light first); tokens.css is the same values as custom
   properties, for pages outside the app. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'design-system');
const app = readFileSync(join(ROOT, 'web/css/app.css'), 'utf8');
const sys = readFileSync(join(ROOT, 'web/css/system.css'), 'utf8');

/** The custom properties of the first block whose selector matches. */
function block(css, selector) {
  const at = css.search(selector);
  if (at < 0) throw new Error(`no block ${selector}`);
  const open = css.indexOf('{', at); const close = css.indexOf('\n}', open);
  const out = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = block(app, /\n:root \{/);
const dark = block(app, /\n:root\[data-theme="dark"\] \{/);
const ctl = block(sys, /\n:root \{/);
const ctlDark = block(sys, /\n:root\[data-theme="dark"\] \{/);

const FAM = { steps: 'steps', active: 'active minutes and cardio', energy: 'calories', heart: 'heart', sleep: 'sleep', recovery: 'readiness and recovery',
  body: 'body', workouts: 'workouts', vitals: 'vitals', nutrition: 'nutrition', water: 'water', mind: 'mind and stress', cycle: 'cycle tracking' };
const BASE = {
  bg: 'The page ground, behind every card. Light: warm paper; dark: true black.',
  surface: 'Cards, sheets, rows and inputs: the main reading ground.',
  'surface-2': 'Insets on a card: tonal buttons, segmented controls, chips when off, skeletons.',
  'surface-3': 'A pressed or hovered tonal fill, one step past surface-2.',
  line: 'Hairlines between rows, card edges on bg.',
  'line-strong': 'Borders that must be seen: a chip, an input, inactive dots.',
  ink: 'Body text and titles on bg, surface and surface-2.',
  'ink-2': 'Secondary text (row values, helper copy) on bg, surface and surface-2.',
  dim: 'Muted text (captions, kicks, timestamps, units) on bg and surface.',
  brand: 'The primary action fill (the Log button, a primary .btn): ink-coloured, never a hue.',
  'on-brand': 'Text and icons on brand.',
  accent: 'Links, focus rings, switches on, a tap-me floating pill. The sleep blue.',
  'accent-soft': "A ghost button's hover, a field's focus halo.",
  'on-accent': 'Text and icons on accent.',
  ok: 'A good state: text and marks on surface. Always with a word or icon.',
  'ok-soft': 'The ground of a good banner or badge, with ok on it.',
  warn: 'Something to look at: text and marks on surface. Always with a word or icon.',
  'warn-soft': 'The ground of a warning banner or badge, with warn on it.',
  bad: "Danger and errors: text, a destructive row, a danger button's ink.",
  'bad-soft': 'The ground of an error banner and of .btn--danger, with bad on it.',
  raise: 'The thumb of a segmented control, raised over surface-2.',
  scrim: 'Behind an open sheet.',
};
function usage(n) {
  if (BASE[n]) return BASE[n];
  let m = /^c-([a-z]+)(-t)?$/.exec(n);
  if (m && FAM[m[1]]) return m[2] ? `Text in the ${FAM[m[1]]} family's hue, on surface and bg.` : `Marks (rings, bars, lines, dots) for ${FAM[m[1]]}, on a card.`;
  m = /^c-(deep|rem|light|awake)$/.exec(n);
  if (m) return `The ${m[1]} sleep stage in a hypnogram and stage bars.`;
  m = /^(on-)?tile-(mark-)?([a-z]+)(-soft)?$/.exec(n);
  if (m) {
    const f = m[3] + (m[4] || '');
    if (m[1]) return `Text and icons on tile-${f}.`;
    if (m[2]) return `The ring or bar drawn on a ${f} tile.`;
    return `The solid fill of a ${f.replace('-soft', ' soft')} family tile on Today and Health.`;
  }
  return '';
}

/* contrast (WCAG 2) */
function lum(hex) {
  let h = hex.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const PAIRS = [['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface-2'], ['ink-2', 'surface'], ['ink-2', 'surface-2'], ['dim', 'bg'], ['dim', 'surface'], ['dim', 'surface-2'],
  ['on-brand', 'brand'], ['on-accent', 'accent'], ['accent', 'surface'], ['ok', 'surface'], ['warn', 'surface'], ['bad', 'surface'], ['ok', 'ok-soft'], ['warn', 'warn-soft'], ['bad', 'bad-soft'],
  ...Object.keys(FAM).map((f) => [`c-${f}-t`, 'surface']), ...['sleep', 'steps', 'energy', 'active', 'heart', 'body', 'water'].map((f) => [`on-tile-${f}`, `tile-${f}`])];

const colors = Object.keys(light).filter((k) => /^(#|rgb)/.test(light[k])).map((k) => ({ name: k, value: { light: light[k].toLowerCase(), dark: (dark[k] || light[k]).toLowerCase() }, usage: usage(k) }));
const misses = [];
for (const [a, b] of PAIRS) {
  for (const [th, d] of [['light', light], ['dark', dark]]) {
    if (!/^#/.test(d[a] || '') || !/^#/.test(d[b] || '')) continue;
    const r = ratio(d[a], d[b]);
    if (r < 4.5) misses.push({ a, b, th, r: Math.round(r * 100) / 100 });
  }
}
for (const x of misses) {
  const t = colors.find((c) => c.name === x.a);
  t.usage += ` Contrast on ${x.b} in ${x.th}: ${x.r}:1, below 4.5:1 for small text (kept as the app has it; use it at 15px semibold and up, or for marks).`;
}

const spaceUse = ['Hairline gaps: an icon and its label.', 'Gaps inside a group: buttons in a row, a chip row.', "Between a card's parts; a row's inner gap.",
  'Card padding; the page gutter on a phone (page-pad).', 'Between sections inside a sheet.', 'Between page sections.', 'Large section breaks.', "The largest gap: a hero's air."];
const T = (name, fontSize, lineHeight, fontWeight, family, letterSpacing, use, sample) => Object.fromEntries(Object.entries({ name, fontSize, lineHeight, fontWeight, family, letterSpacing, usage: use, sample }).filter(([, v]) => v !== null && v !== undefined));
let sha = 'unknown';
try { sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a checkout */ }

const tokens = {
  name: 'Health', version: 1,
  meta: { source: 'web/css/app.css, web/css/system.css', ref: sha, built: new Date().toISOString().slice(0, 10), builtBy: 'npm run design-tokens' },
  color: { themes: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }], tokens: colors },
  type: {
    fonts: [{ family: 'Instrument Sans', file: 'web/fonts/instrument-sans.woff2', weight: '400 700', style: 'normal' },
      { family: 'Instrument Sans', file: 'web/fonts/instrument-sans-ext.woff2', weight: '400 700', style: 'normal' },
      { family: 'Newsreader', file: 'web/fonts/newsreader.woff2', weight: '400 600', style: 'normal' }],
    families: { sans: '"Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', serif: '"Newsreader", Georgia, "Times New Roman", serif' },
    groups: [
      { name: 'Display', family: 'serif', styles: [
        T('tab-title', '2.125rem', 1.06, 500, 'serif', '-0.02em', "The title of a tab's first screen (Today, People).", 'People'),
        T('sheet-title', '1.75rem', 1.1, 500, 'serif', '-0.02em', "A sheet's title.", 'Change the circle')] },
      { name: 'Numbers', family: 'sans', styles: [
        T('stat-xl', light['t-4xl'], 1, 700, 'sans', '-0.035em', 'The hero number of a tile (font-stretch 88%, tabular).', '7,303'),
        T('stat-l', light['t-3xl'], 1.05, 700, 'sans', '-0.03em', 'A large stat on a tile or podium.', '2nd'),
        T('stat', light['t-2xl'], 1.12, 650, 'sans', '-0.022em', 'A stat in a module.', '34,770')] },
      { name: 'Text', family: 'sans', styles: [
        T('screen-title', '1.1875rem', 1.2, 600, 'sans', '-0.01em', 'The title of a deeper screen (with a back arrow).', 'Hall of fame'),
        T('t-l', light['t-l'], 1.35, 600, 'sans', null, 'Card and tile titles.', 'Steps'),
        T('body', light['t-m'], 1.45, 400, 'sans', null, 'Body copy: every paragraph and row title.', 'Friends see your workouts in their feed.'),
        T('section', '0.9375rem', 1.3, 600, 'sans', '-0.005em', 'A section heading over a group (.bsec h2).', 'Steps this week'),
        T('t-s', light['t-s'], 1.4, 400, 'sans', null, 'Secondary text: row subtitles, helper lines, .btn--s.', 'Leading by 12,000 steps'),
        T('label', '0.8125rem', 1.25, 500, 'sans', null, 'Group labels and kicks above a title, in dim.', 'Your account'),
        T('t-cap', light['t-cap'], 1.3, 600, 'sans', null, 'Captions, units, chart axes.', '7 day average')] }],
  },
  spacing: { tokens: spaceUse.map((u, i) => ({ name: `s-${i + 1}`, value: light[`s-${i + 1}`], usage: u })) },
  radius: { tokens: [
    { name: 'r-s', value: light['r-s'], usage: 'Small insets: an icon tile, a tag.' },
    { name: 'r-m', value: light['r-m'], usage: 'Inputs, small cards, a floating sheet on a wide screen.' },
    { name: 'r-l', value: light['r-l'], usage: "Cards, tiles, groups of rows, sheets' top corners." },
    { name: 'r-full', value: light['r-full'], usage: 'Pills and discs: every button, chip, segmented control and floating pill.' }] },
  shadow: { tokens: [
    { name: 'edge', value: { light: light.edge, dark: dark.edge }, usage: 'The 1px inner edge on cards and buttons that sit on bg, instead of a border.' },
    { name: 'shadow-1', value: { light: light['shadow-1'], dark: dark['shadow-1'] }, usage: 'A card lifted a little: a toast, a menu.' },
    { name: 'shadow-2', value: { light: light['shadow-2'], dark: dark['shadow-2'] }, usage: 'Things over the page: sheets, the floating tab bar.' },
    { name: 'shadow-float', value: { light: ctl['shadow-float'], dark: ctlDark['shadow-float'] }, usage: 'Floating pills (live heart rate, whose boards): one shadow for all.' }] },
  size: { tokens: [
    { name: 'ctl-h', value: ctl['ctl-h'], usage: 'A button (.btn).' },
    { name: 'ctl-h-s', value: ctl['ctl-h-s'], usage: 'A small button, an icon button, a floating pill. Never below 44px for a touch target.' },
    { name: 'ctl-h-xs', value: ctl['ctl-h-xs'], usage: "An action inside a list row (.pill-btn); its tap area is the row's." },
    { name: 'hbtn', value: ctl.hbtn, usage: 'Round header buttons (Me, Friends, Circles, Edit).' },
    { name: 'fab', value: ctl.fab, usage: 'The round Log button beside the tab bar.' },
    { name: 'float-h', value: ctl['float-h'], usage: 'Floating pills.' },
    { name: 'tab-h', value: light['tab-h'], usage: "The floating tab bar's height on a phone." },
    { name: 'rail-w', value: light['rail-w'], usage: "The side rail's width from 960px." },
    { name: 'page-pad', value: light['page-pad'], usage: 'The page gutter on a phone.' }] },
  motion: { tokens: [
    { name: 'ease', value: light.ease, usage: 'Most changes: fast out, gentle stop.' },
    { name: 'spring', value: light.spring, usage: 'Thumbs, highlights and things that land (a slight overshoot).' },
    { name: 'ease-io', value: light['ease-io'], usage: 'Both ways at once.' },
    { name: 'dur-1', value: ctl['dur-1'], usage: 'A press, a colour.' },
    { name: 'dur-2', value: ctl['dur-2'], usage: 'A switch, a floating pill arriving.' },
    { name: 'dur-3', value: ctl['dur-3'], usage: 'A sheet rising.' }] },
};

/* tokens.css: the same values as custom properties, light first, dark under [data-theme="dark"] */
const val = (t, th) => (typeof t.value === 'string' ? t.value : t.value[th] ?? t.value.light);
const themed = (th) => [...tokens.color.tokens, ...tokens.shadow.tokens].map((t) => `  --${t.name}: ${val(t, th)};`).join('\n');
const plain = [...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.size.tokens, ...tokens.motion.tokens].map((t) => `  --${t.name}: ${t.value};`).join('\n');
const fonts = Object.entries(tokens.type.families).map(([k, v]) => `  --font-${k}: ${v};`).join('\n');
const styles = tokens.type.groups.flatMap((g) => g.styles.map((s) => `.${s.name} { font-family: var(--font-${s.family || g.family}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ''} }`)).join('\n');
const css = `/* Health — generated from tokens.json by npm run design-tokens (${sha}). The app itself reads web/css/app.css and system.css. */
:root, [data-theme="light"] {\n${themed('light')}\n}
[data-theme="dark"] {\n${themed('dark')}\n}
:root {\n${plain}\n${fonts}\n}
${styles}
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'tokens.json'), `${JSON.stringify(tokens, null, 1)}\n`);
writeFileSync(join(OUT, 'tokens.css'), css);
console.log(`${colors.length} colours in 2 themes, ${tokens.spacing.tokens.length} spaces, ${tokens.radius.tokens.length} radii, ${tokens.shadow.tokens.length} shadows, ${tokens.size.tokens.length} sizes, ${tokens.motion.tokens.length} motion → docs/design-system/`);
console.log(misses.length ? `contrast below 4.5:1: ${misses.map((x) => `${x.a} on ${x.b} (${x.th}) ${x.r}`).join('; ')}` : 'every text pair 4.5:1 or more');
