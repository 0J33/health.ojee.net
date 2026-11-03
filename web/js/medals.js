/* Medals and achievements on screen (rules: medalcore.js; earned: server/medals.js).

   A medal is a disc of its metal under a short ribbon, with the icon of
   what it was for: drawn in CSS (medals.css), so it takes the theme and
   any size. A new one turns in and catches the light once; with reduced
   motion it is simply there. */

import { html, raw, ic, sheet } from './ui.js';
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

/* A trophy: a cup in the medals' metals (the same --hi, --mid, --lo of .md--<tier>), lit
   from the top left, handles, a stem and a plinth, a star pressed into the bowl. For what a
   circle wins together: its goals. Sizes as the medal's: s 18, m 36, l 64. */
let tpSeq = 0;
export function trophy(tier, { size = 'm', label = '', fresh = false, i = 0 } = {}) {
  const id = `tp${(tpSeq += 1).toString(36)}`;
  const small = size === 's';
  const star = 'M32 15.2 L33.9 19.4 L38.4 19.8 L35 22.8 L36 27.2 L32 24.9 L28 27.2 L29 22.8 L25.6 19.8 L30.1 19.4 Z';
  return html`<span class="tp md--${tier} tp--${size} ${fresh ? 'tp--new' : ''}" style="--i:${i}" role="img" aria-label="${label || `${TIER_WORD[tier] || 'No'} trophy`}">${raw(`<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="${id}m" cx="0.3" cy="0.2" r="0.95"><stop offset="0" class="tp-hi"/><stop offset="0.5" class="tp-mid"/><stop offset="1" class="tp-lo"/></radialGradient>
      <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="tp-mid"/><stop offset="1" class="tp-lo"/></linearGradient>
    </defs>
    <path d="M17 13 C5 13 5 31 21 33 M47 13 C59 13 59 31 43 33" fill="none" class="tp-line" stroke-width="${small ? 5 : 4}" stroke-linecap="round"/>
    <path d="M15 7 H49 V19 C49 31 42 38 32 39 C22 38 15 31 15 19 Z" fill="url(#${id}m)" class="tp-line" stroke-width="1.4" stroke-linejoin="round"/>
    ${small ? '' : `<path d="M20.5 11 C20.5 23 22.5 29 26.5 33" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round"/>
    <path d="${star}" transform="translate(0 0.8)" class="tp-fhi" fill-opacity="0.8"/><path d="${star}" class="tp-fink" fill-opacity="0.85"/>`}
    <path d="M29 39 H35 L36.5 47 H27.5 Z" fill="url(#${id}b)"/>
    <rect x="22" y="46" width="20" height="4.5" rx="1.5" fill="url(#${id}m)" class="tp-line" stroke-width="1"/>
    <rect x="17" y="50.5" width="30" height="9.5" rx="2.5" fill="url(#${id}b)" class="tp-line" stroke-width="1"/>
    ${small ? '' : '<rect x="26" y="53" width="12" height="4.5" rx="1" class="tp-fhi" fill-opacity="0.55"/>'}
  </svg>`)}</span>`;
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
  if (a.unit === 'weight') return f.weight(v);
  if (a.unit === 'm') return f.dist(v);
  return f.int(v);
}
const unitWord = (a, n) => (a.unit === 'kg' || a.unit === 'm' || a.unit === 'weight' ? '' : ` ${Math.round(n) === 1 ? a.unit.replace(/s$/, '') : a.unit}`);

/* An achievement's badge is not a medal: a square of enamel in its family's colour,
   framed in the metal of the level reached, with a pip for each of the four levels.
   (A medal is a round disc on a ribbon; a rank, a shield.) */
const ACH_FAM = { workouts: 'workouts', activity: 'steps', sleep: 'sleep' };
const famOf = (a) => (a.group === 'Distance' ? 'active' : ACH_FAM[a.cat] || 'workouts');
export function achBadge(a, { size = 'm', fresh = false } = {}) {
  const tier = a.level ? a.tier : 'none';
  return html`<span class="ab ab--${tier} ab--${size} fam fam-${famOf(a)} ${fresh ? 'ab--new' : ''}" role="img" aria-label="${a.label}${a.level ? `, ${LEVEL_WORD[a.level]}` : ', not reached yet'}">
    <span class="ab__face">${ic(a.icon)}</span>
    <span class="ab__pips" aria-hidden="true">${[1, 2, 3, 4].map((n) => html`<i class="${n <= (a.level || 0) ? 'is-on' : ''}"></i>`)}</span>
  </span>`;
}

/** One achievement: its badge, the tally and the way to the next level. */
export function achCard(a, { own = true } = {}) {
  const next = a.next;
  return html`<article class="ach ach--${a.tier || 'none'} ${a.fresh ? 'ach--new' : ''}" aria-label="${a.label}${a.level ? `, ${LEVEL_WORD[a.level]}` : ''}">
    ${achBadge(a, { fresh: !!a.fresh })}
    <div class="ach__b">
      <p class="ach__t">${a.label}${a.fresh ? html`<span class="ach__new">New</span>` : ''}</p>
      ${a.say ? html`<p class="ach__s">${a.say}</p>` : ''}
      <p class="ach__v"><b>${achValue(a)}</b>${unitWord(a, a.value)}${a.level ? html` · <span class="ach__lv">${LEVEL_WORD[a.level]}</span>` : ''}</p>
      ${own && next ? html`<div class="ach__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((a.progress || 0) * 100)}" aria-label="${LEVEL_WORD[a.level + 1]} at ${achValue(a, next)}"><i style="--p:${Math.round((a.progress || 0) * 100)}%"></i></div>
        <p class="ach__next">${LEVEL_WORD[a.level + 1]} at ${achValue(a, next)}${unitWord(a, next)}</p>` : own && !next ? html`<p class="ach__next">Every level reached</p>` : ''}
    </div>
  </article>`;
}

/** The cabinet: every achievement, in its groups (Training, Moving, Distance, Records, Habits). */
export function achGrid(list, opts) {
  const groups = [...new Set(list.map((a) => a.group || 'Training'))];
  if (groups.length < 2) return html`<div class="ach-grid">${list.map((a) => achCard(a, opts))}</div>`;
  return html`${groups.map((g) => {
    const in1 = list.filter((a) => (a.group || 'Training') === g);
    const got = in1.filter((a) => a.level).length;
    return html`<p class="ach-group"><span>${g}</span><small class="n">${opts?.own === false ? f.int(got) : `${f.int(got)} of ${f.int(in1.length)}`}</small></p><div class="ach-grid">${in1.map((a) => achCard(a, opts))}</div>`;
  })}`;
}

/** Badges as tiles, by group: the badge, its name, its level (or how far to the first). Each opens achSheet. */
export function achTiles(list, { own = true } = {}) {
  const groups = [...new Set(list.map((a) => a.group || 'Training'))];
  const tile = (a) => html`<button type="button" class="abt ${a.level ? '' : 'abt--off'} ${a.fresh ? 'abt--new' : ''}" data-ach="${a.id}" aria-label="${a.label}${a.level ? `, ${LEVEL_WORD[a.level]}` : ', not reached yet'}">
    ${achBadge(a, { size: 'm', fresh: !!a.fresh })}
    <span class="abt__t">${a.label}</span>
    <span class="abt__s">${a.level ? LEVEL_WORD[a.level] : own && a.next ? `${Math.round((a.progress || 0) * 100)}% to bronze` : 'Not yet'}</span>
  </button>`;
  return html`${groups.map((g) => {
    const in1 = list.filter((a) => (a.group || 'Training') === g);
    const got = in1.filter((a) => a.level).length;
    return html`<p class="ach-group"><span>${g}</span><small class="n">${own ? `${f.int(got)} of ${f.int(in1.length)}` : f.int(got)}</small></p><div class="abt-grid">${in1.map(tile)}</div>`;
  })}`;
}

/** One achievement up close: its badge, what it counts, the four levels (each ticked once reached), the way to the next. */
export function achSheet(a, { own = true } = {}) {
  const lv = a.levels || [];
  sheet({
    title: a.label,
    body: html`<div class="st-sheet abs">
      <div class="abs__top">${achBadge(a, { size: 'l' })}<span class="abs__b"><b>${a.level ? LEVEL_WORD[a.level] : 'Not reached yet'}</b><small>${a.say}</small><span class="abs__v"><b class="n">${achValue(a)}</b>${unitWord(a, a.value)}</span></span></div>
      ${own && a.next ? html`<div class="ach__bar"><i style="--p:${Math.round((a.progress || 0) * 100)}%"></i></div><p class="ach__next">${LEVEL_WORD[a.level + 1]} at ${achValue(a, a.next)}${unitWord(a, a.next)}</p>` : ''}
      ${lv.length ? html`<div class="st-grp abs__lv">${lv.map((x, i) => html`<div class="st-row ${a.level > i ? 'is-on' : ''}">${achBadge({ ...a, level: i + 1, tier: ['bronze', 'silver', 'gold', 'platinum'][i] }, { size: 's' })}
        <span class="st-b"><span class="st-t">${LEVEL_WORD[i + 1]}</span><span class="st-s">${achValue(a, x)}${unitWord(a, x)}</span></span>${a.level > i ? html`<span class="abs__ok">${ic('check', { size: 's' })}</span>` : ''}</div>`)}</div>` : ''}
    </div>`,
  });
}

/** The live medal on a set as it is ticked: the best one it earned. */
export function setMedal(m) {
  return m ? medal(m.tier, 'record', { size: 's', fresh: true, label: `${TIER_WORD[m.tier]}: ${medalText(m).title}` }) : '';
}
