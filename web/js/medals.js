/* Medals and achievements on screen (rules: medalcore.js; earned: server/medals.js).

   A medal is a disc of its metal under a short ribbon, with the icon of
   what it was for: drawn in CSS (medals.css), so it takes the theme and
   any size. A new one turns in and catches the light once; with reduced
   motion it is simply there. */

import { html, ic } from './ui.js';
import * as f from './format.js';
import { clockS } from './exlib.js';

export const TIER_WORD = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze', platinum: 'Platinum' };
/** What each medal tier means. */
export const TIER_SAY = { gold: 'Your best ever', silver: 'Your best in a year', bronze: 'Your best in 90 days' };
/** The same, short, for a row. */
const TIER_SHORT = { gold: 'Best ever', silver: 'Best in a year', bronze: 'Best in 90 days' };
const SPORT_WORD = { run: 'run', ride: 'ride', walk: 'walk' };

/** The icon of what a medal is for. */
const ICON = { heaviest: 'dumbbell', e1rm: 'trends', reps_at: 'replay', volume: 'layers', set_reps: 'replay', hold: 'timer', session_volume: 'stacked_bar_chart', duration: 'timer', effort: 'speed' };
const iconOf = (m) => (m.kind === 'distance' ? (m.sport === 'ride' ? 'bike' : m.sport === 'walk' ? 'walk' : 'run') : ICON[m.kind] || 'record');

/**
 * A medal. `size`: s (in a line of text), m (a list), l (a reveal).
 * `fresh`: it turns in, `i` staggers several.
 */
export function medal(tier, icon = 'record', { size = 'm', fresh = false, i = 0, label = '' } = {}) {
  return html`<span class="md md--${tier} md--${size} ${fresh ? 'md--new' : ''}" style="--i:${i}" role="img" aria-label="${label || `${TIER_WORD[tier]} medal`}">
    <span class="md__rib" aria-hidden="true"></span><span class="md__disc" aria-hidden="true">${ic(icon)}</span></span>`;
}

const hms = (s) => {
  const v = Math.round(s); const h = Math.floor(v / 3600);
  return h ? `${h}:${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}` : clockS(v);
};
const effortName = (m) => (m.effortM === 21097 ? 'half marathon' : m.effortM === 42195 ? 'marathon' : f.dist(m.effortM).replace(/\.00 /, ' '));

/** What a medal says: { title, what, value, was }. */
export function medalText(m) {
  const sw = SPORT_WORD[m.sport] || 'workout';
  switch (m.kind) {
    case 'heaviest': return { title: 'Heaviest weight', what: m.exercise, value: f.weight(m.value), was: f.weight(m.previous) };
    case 'e1rm': return { title: 'Best estimated 1-rep max', what: m.exercise, value: f.weight(m.value), was: f.weight(m.previous) };
    case 'reps_at': return { title: `Most reps at ${f.weight(m.kg)}`, what: m.exercise, value: f.plural(m.value, 'rep'), was: f.plural(m.previous, 'rep') };
    case 'volume': return { title: 'Most volume', what: m.exercise, value: f.volume(m.value), was: f.volume(m.previous) };
    case 'set_reps': return { title: 'Most reps in a set', what: m.exercise, value: f.plural(m.value, 'rep'), was: f.plural(m.previous, 'rep') };
    case 'hold': return { title: 'Longest set', what: m.exercise, value: hms(m.value), was: hms(m.previous) };
    case 'session_volume': return { title: 'Most weight lifted', what: 'In one workout', value: f.volume(m.value), was: f.volume(m.previous) };
    case 'distance': return { title: `Longest ${sw}`, what: 'Distance', value: f.dist(m.value), was: f.dist(m.previous) };
    case 'duration': return { title: `Longest ${sw}`, what: 'Moving time', value: hms(m.value), was: hms(m.previous) };
    case 'effort': return { title: `Fastest ${effortName(m)}`, what: `On a ${sw}`, value: hms(m.value), was: hms(m.previous) };
    default: return { title: 'Medal', what: '', value: '', was: '' };
  }
}

/** "9 medals · 6 gold, 3 silver": a row's words. */
export function medalSummary(list) {
  const t = { gold: 0, silver: 0, bronze: 0 };
  for (const m of list || []) t[m.tier] += 1;
  return [f.plural((list || []).length, 'medal'), ['gold', 'silver', 'bronze'].filter((k) => t[k]).map((k) => `${t[k]} ${k}`).join(', ')].join(' · ');
}

/** Medal counts, as small medals with numbers: for a post, a list row. */
export function medalTally(t, { size = 's' } = {}) {
  if (!t) return '';
  const parts = ['gold', 'silver', 'bronze'].filter((k) => t[k] > 0);
  if (!parts.length) return '';
  const say = parts.map((k) => `${t[k]} ${k}`).join(', ');
  return html`<span class="md-tally" role="img" aria-label="Medals: ${say}">${parts.map((k) => html`<span class="md-tally__i">${medal(k, 'record', { size, label: '' })}<b>${t[k]}</b></span>`)}</span>`;
}

/** One medal as a row: the medal, what it was for, the number and what it beat. */
export function medalRow(m, { fresh = false, i = 0 } = {}) {
  const t = medalText(m);
  return html`<div class="md-row ${fresh ? 'md-row--new' : ''}" style="--i:${i}">
    ${medal(m.tier, iconOf(m), { size: 'm', fresh, i, label: `${TIER_WORD[m.tier]}: ${t.title}` })}
    <span class="md-row__b"><span class="md-row__t">${t.title}</span><span class="md-row__s">${t.what || TIER_SHORT[m.tier]}</span><span class="md-row__tier">${TIER_SHORT[m.tier]}</span></span>
    <span class="md-row__v"><b>${t.value}</b><small>was ${t.was}</small></span>
  </div>`;
}

/**
 * The medals of one workout: the row of discs (turning in when `fresh`) and
 * each one listed. For the workout's page.
 */
export function medalCase(medals, { fresh = false } = {}) {
  if (!medals?.length) return '';
  const list = medals.slice().sort((a, b) => ({ gold: 3, silver: 2, bronze: 1 })[b.tier] - ({ gold: 3, silver: 2, bronze: 1 })[a.tier]);
  return html`<section class="md-case ${fresh ? 'md-case--new' : ''}" aria-label="Medals">
    <div class="md-case__top">
      <div class="md-case__row" aria-hidden="true">${list.slice(0, 6).map((m, i) => medal(m.tier, iconOf(m), { size: 'l', fresh, i }))}</div>
      <p class="md-case__t">${f.plural(list.length, 'medal')}</p>
      <p class="md-case__s">${['gold', 'silver', 'bronze'].map((k) => [k, list.filter((m) => m.tier === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ')}</p>
    </div>
    <div class="md-list">${list.map((m, i) => medalRow(m, { fresh, i: i + Math.min(list.length, 6) }))}</div>
  </section>`;
}

/* ── achievements ───────────────────────────────────────────── */

const LEVEL_WORD = ['', 'Bronze', 'Silver', 'Gold', 'Platinum'];
/** An achievement's number, in its unit. */
export function achValue(a, v = a.value) {
  if (a.unit === 'kg') return f.volume(v);
  if (a.unit === 'm') return f.dist(v);
  return f.int(v);
}
const unitWord = (a, n) => (a.unit === 'kg' || a.unit === 'm' ? '' : ` ${Math.round(n) === 1 ? a.unit.replace(/s$/, '') : a.unit}`);

/** One achievement: its badge in the level's metal (dim until the first), the tally and the way to the next level. */
export function achCard(a, { own = true } = {}) {
  const tier = a.tier || 'none';
  const next = a.next;
  return html`<article class="ach ach--${tier} ${a.fresh ? 'ach--new' : ''}" aria-label="${a.label}${a.level ? `, ${LEVEL_WORD[a.level]}` : ''}">
    ${a.level ? medal(a.tier, a.icon, { size: 'm', fresh: !!a.fresh, label: `${LEVEL_WORD[a.level]} ${a.label}` }) : html`<span class="md md--none md--m" aria-hidden="true"><span class="md__rib"></span><span class="md__disc">${ic(a.icon)}</span></span>`}
    <div class="ach__b">
      <p class="ach__t">${a.label}${a.fresh ? html`<span class="ach__new">New</span>` : ''}</p>
      <p class="ach__v"><b>${achValue(a)}</b>${unitWord(a, a.value)}${a.level ? html` · <span class="ach__lv">${LEVEL_WORD[a.level]}</span>` : ''}</p>
      ${own && next ? html`<div class="ach__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((a.progress || 0) * 100)}" aria-label="${LEVEL_WORD[a.level + 1]} at ${achValue(a, next)}"><i style="--p:${Math.round((a.progress || 0) * 100)}%"></i></div>
        <p class="ach__next">${LEVEL_WORD[a.level + 1]} at ${achValue(a, next)}${unitWord(a, next)}</p>` : own && !next ? html`<p class="ach__next">Every level reached</p>` : ''}
    </div>
  </article>`;
}

/** The cabinet: every achievement. */
export function achGrid(list, opts) {
  return html`<div class="ach-grid">${list.map((a) => achCard(a, opts))}</div>`;
}

/** The live medal on a set as it is ticked: the best one it earned. */
export function setMedal(m) {
  return m ? medal(m.tier, 'record', { size: 's', fresh: true, label: `${TIER_WORD[m.tier]}: ${medalText(m).title}` }) : '';
}
