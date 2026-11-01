/* Ranks: the board (metric × period: you against the group, then exact
   standings with movement, a 7-day shape and the distance to the leader;
   your row pinned when it is off screen) and the compare view (you against
   one person: the score, each metric with who leads, and the period day by
   day).

   Everything here is what the API returned. A null is somebody's privacy
   or a missing number, and is shown as "not shared", never worked out from
   something else. */

import { api, qs } from '../api.js';
import { app, listen, go } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, empty, banner, chart, on, seg } from '../ui.js';
import { tableAlt } from '../charts.js';
import { spark, cats, duel } from '../viz.js';
import { mod, grid, range, facts, figure, ib } from '../kit.js';
import * as f from '../format.js';
import { avatar, unitValue, unitText } from './shared.js';
import { moreRows, bindMore } from '../metrics.js';

/* Metric → its family (colour) and glyph. */
const METRIC = {
  steps: { label: 'Steps', fam: 'steps', icon: 'steps' },
  active_minutes: { label: 'Active minutes', fam: 'active', icon: 'bolt' },
  workouts: { label: 'Workouts', fam: 'workouts', icon: 'strength' },
  workout_time: { label: 'Workout time', fam: 'workouts', icon: 'timer' },
  gym: { label: 'Gym sessions', fam: 'workouts', icon: 'strength' },
  gym_time: { label: 'Gym time', fam: 'workouts', icon: 'timer' },
  distance: { label: 'Distance', fam: 'steps', icon: 'distance' },
  run_distance: { label: 'Running', fam: 'active', icon: 'run' },
  ride_distance: { label: 'Cycling', fam: 'water', icon: 'bike' },
  walk_distance: { label: 'Walks and hikes', fam: 'steps', icon: 'hike' },
  sleep_consistency: { label: 'Sleep consistency', fam: 'sleep', icon: 'moon' },
};
export const METRICS = Object.keys(METRIC);
/* The boards as the picker groups them. */
export const BOARD_GROUPS = [
  ['Every day', ['steps', 'active_minutes', 'distance']],
  ['Training', ['workouts', 'workout_time', 'gym', 'gym_time']],
  ['Distance sports', ['run_distance', 'ride_distance', 'walk_distance']],
  ['Sleep', ['sleep_consistency']],
];
export { METRIC };
export const PERIODS = [['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All time']];
export const PREV = { today: 'yesterday', week: 'last week', month: 'last month' };

export const nameOf = (p) => p?.displayName || p?.username || '';
export const ordinal = (n) => {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};
/** "5,349 steps", "1 h 12 min", "2 workouts", "7 points", "3.2 km". */
const amount = (v, unit) => (unit === 'score' ? f.plural(v, 'point') : unitText(v, unit));

/* ── the board ──────────────────────────────────────────────── */

function trendChip(e, d) {
  if (!f.isNum(e.trend) || !PREV[d.period]) return '';
  const r = Math.round(e.trend);
  if (r === 0) return html`<span class="lb__trend">Same as ${PREV[d.period]}</span>`;
  const up = r > 0;
  const good = up === (d.higherIsBetter !== false);
  return html`<span class="lb__trend"><span class="move ${good ? 'move--up' : 'move--down'}">${ic(up ? 'up' : 'down')}${Math.abs(r)}%<span class="sr"> ${up ? 'up' : 'down'}</span></span><span class="lb__vs"> vs ${PREV[d.period]}</span></span>`;
}

/** Places gained or lost since the previous period. */
function movement(e, d) {
  if (!PREV[d.period]) return '';
  if (!f.isNum(e.prevRank)) return html`<span class="lb__move lb__move--new">New</span>`;
  const m = e.move;
  if (!m) return html`<span class="lb__move" title="Same place as ${PREV[d.period]}">${ic('flat')}<span class="sr">Same place as ${PREV[d.period]}</span></span>`;
  const up = m > 0;
  return html`<span class="lb__move ${up ? 'move--up' : 'move--down'}">${ic(up ? 'up' : 'down')}${Math.abs(m)}<span class="sr"> ${Math.abs(m) === 1 ? 'place' : 'places'} ${up ? 'up' : 'down'} since ${PREV[d.period]}</span></span>`;
}

export function entry(e, d, { pinned = false } = {}) {
  const x = unitValue(e.value, d.unit);
  const best = d.group?.best;
  const share = f.isNum(best) && best > 0 && f.isNum(e.value) ? Math.max(0, Math.min(1, e.value / best)) : null;
  const detail = d.metric === 'sleep_consistency' && e.detail
    ? `${e.detail.lastNights ? 'Last ' : ''}${f.plural(e.detail.nights, 'night')} · bedtime ±${f.int(e.detail.bedtimeOffMin)} min, waking ±${f.int(e.detail.wakeOffMin)} min`
    : e.rank === 1 ? (d.total > 1 ? 'Leading' : '')
      : f.isNum(e.gapToNext) && e.gapToNext > 0 ? `${amount(e.gapToNext, d.unit)} behind next place` : '';
  const sp = !pinned && Array.isArray(e.spark) && e.spark.filter(f.isNum).length >= 2
    ? chart((w) => spark({ w, h: 30, values: e.spark, bars: true, label: `${nameOf(e)}, the last 7 days: ${e.spark.map((v) => (f.isNum(v) ? unitText(v, d.unit) : 'nothing')).join(', ')}.` }))
    : '';
  return html`<a class="lb pp-lb ${e.me ? 'lb--me' : ''}" href="/u/${encodeURIComponent(e.username)}" ${raw(pinned ? 'data-pinned' : `data-user="${e.me ? 'me' : ''}"`)}>
    <span class="lb__pos"><span class="lb__rank n"><span class="sr">Rank </span>${e.rank ?? f.DASH}</span>${movement(e, d)}</span>
    ${avatar(e)}
    <span class="lb__who">
      <span class="lb__name">${e.me ? 'You' : nameOf(e)}</span>
      ${share !== null ? html`<span class="lb__bar" aria-hidden="true"><span data-style="--p:${share.toFixed(3)}"></span></span>` : ''}
      ${detail ? html`<span class="lb__sub">${detail}</span>` : ''}
    </span>
    <span class="lb__spark" ${raw(sp ? '' : 'aria-hidden="true"')}>${sp}</span>
    <span class="lb__num">
      <span class="lb__val n">${x.v}${x.u && d.unit !== 'steps' ? html`<span class="lb__unit">${x.u}</span>` : ''}</span>
      ${trendChip(e, d)}
    </span>
  </a>`;
}

/* The podium card takes the metric's tile colour. */
export const TILE = { steps: 'steps', active: 'active', workouts: 'energy', sleep: 'sleep', water: 'water' };
export const SHORT = { steps: 'Steps', active_minutes: 'Active', workouts: 'Workouts', workout_time: 'Workout time', gym: 'Gym', gym_time: 'Gym time', distance: 'Distance', run_distance: 'Running', ride_distance: 'Cycling', walk_distance: 'Walks', sleep_consistency: 'Sleep' };
export const PERIOD_WORDS = { today: 'today', week: 'this week', month: 'this month', all: 'of all time' };

/** A gap in words: "4,120" for steps and points, "12 min" or "2 workouts" otherwise. */
const gapOf = (v, unit) => (unit === 'steps' || unit === 'score' ? f.int(v) : unitText(v, unit));

/** The coloured card: the period inside, your place, the gaps either side, the top three. */
export function podium(d, period) {
  const meta = METRIC[d.metric] || METRIC.steps;
  const tile = TILE[meta.fam] || 'steps';
  const me = d.me || {};
  const top = d.entries.slice(0, 3);
  const listed = me.listed !== false && f.isNum(me.rank);
  const line = (who, word) => html`<p class="pd-l"><b class="n">${gapOf(who.by, d.unit)}</b> ${word} <a href="/u/${encodeURIComponent(who.username)}">${nameOf(who)}</a></p>`;
  let text;
  if (!listed) {
    text = html`<p class="pd-word">Not on this board</p><p class="pd-l">${me.reason || 'Nothing recorded for you yet.'}</p>`;
  } else {
    const lead = me.rank === 1 && me.behind ? html`<p class="pd-l">Leading by <b class="n">${gapOf(me.behind.by, d.unit)}</b></p>` : '';
    text = html`<p class="pd-rank"><span class="n">${ordinal(me.rank)}</span><span class="pd-of">of ${f.int(d.group?.n || d.total)}</span></p>
      ${me.ahead ? line(me.ahead, 'behind') : lead}
      ${me.behind ? line(me.behind, 'ahead of') : d.group?.n > 1 ? html`<p class="pd-l">Nobody is behind you</p>` : html`<p class="pd-l">The only one here so far</p>`}`;
  }
  const H = [94, 66, 46];
  const step = (e, i) => (e ? html`<a class="pd pd--${i + 1}" href="/u/${encodeURIComponent(e.username)}" aria-label="${ordinal(i + 1)}: ${e.me ? 'you' : nameOf(e)}, ${unitText(e.value, d.unit)}">
      <span class="pd-av ${e.me ? 'pd-av--me' : ''}">${avatar(e)}</span>
      <span class="pd-blk" style="height:${H[i]}px"><b class="n">${e.rank ?? i + 1}</b></span>
    </a>` : '');
  return html`<section class="bt bt--${tile} pp-pod" style="--pdc: var(--tile-${tile})" aria-label="${d.label}, ${d.periodLabel}">
    ${seg('period', PERIODS, period, { label: 'Period', fit: true })}
    <div class="pd-body">
      <div class="pd-text">${text}</div>
      ${top.length ? html`<div class="pd-steps" aria-label="Podium: ${top.map((e, i) => `${ordinal(i + 1)} ${e.me ? 'you' : nameOf(e)}`).join(', ')}">${step(top[1], 1)}${step(top[0], 0)}${step(top[2], 2)}</div>` : ''}
    </div>
  </section>`;
}

/** The working-out behind your place: the group's spread, its median, your movement. */
export function groupCard(d) {
  const g = d.group || {};
  const me = d.me || {};
  if (!(g.n > 0)) return '';
  const vals = d.entries.map((e) => e.value).filter(f.isNum);
  const lo = vals.length ? Math.min(...vals) : null;
  const mine = d.entries.find((e) => e.me);
  const moved = mine && PREV[d.period] && f.isNum(mine.move) && mine.move !== 0
    ? `${mine.move > 0 ? 'Up' : 'Down'} ${f.plural(Math.abs(mine.move), 'place')} on ${PREV[d.period]}`
    : mine && PREV[d.period] && mine.move === 0 ? `Same place as ${PREV[d.period]}` : '';
  const pct = me.vsMedianPct;
  const medianWords = !f.isNum(pct) ? ''
    : Math.abs(pct) < 1 ? "Right on the group's median"
      : `${Math.abs(Math.round(pct))}% ${pct > 0 ? 'above' : 'below'} the group's median`;
  const x = f.isNum(me.value) ? unitValue(me.value, d.unit) : null;
  const showRange = g.n > 1 && f.isNum(me.value) && me.listed !== false;
  return html`<div class="bsec"><h2>The group</h2><span class="pp-bsec-n">${f.plural(g.n, 'person', 'people')}</span></div>
  <section class="mod pp-group">
    ${x ? html`<div class="pp-you">
      <p class="pp-you__v"><span class="n">${x.v}</span>${x.u ? html`<span class="pp-you__u">${x.u}</span>` : ''}</p>
      <p class="pp-you__t">${[`Your ${String(d.label).toLowerCase()} ${PERIOD_WORDS[d.period] || ''}`.trim(), medianWords, moved].filter(Boolean).join(' · ')}</p>
    </div>` : ''}
    ${showRange ? html`<div class="where">
      ${range({ value: me.value, tick: g.median, min: lo, max: g.best, label: `You: ${unitText(me.value, d.unit)}. The group runs from ${unitText(lo, d.unit)} to ${unitText(g.best, d.unit)}, with a median of ${unitText(g.median, d.unit)}.` })}
      <p class="where__key" style="--x:${(Math.max(0, Math.min(1, (g.median - lo) / ((g.best - lo) || 1))) * 100).toFixed(1)}%"><span>Lowest ${unitValue(lo, d.unit).v}</span><span class="where__mid"><i></i>Median ${unitValue(g.median, d.unit).v}</span><span>Best ${unitValue(g.best, d.unit).v}</span></p>
    </div>` : ''}
    ${facts([
      { k: 'Middle of the group', v: unitValue(g.median, d.unit).v, u: unitValue(g.median, d.unit).u },
      { k: 'Best', v: unitValue(g.best, d.unit).v, u: unitValue(g.best, d.unit).u },
      d.unit !== 'score' ? { k: 'All together', v: unitValue(g.total, d.unit).v, u: unitValue(g.total, d.unit).u } : null,
      { k: 'On this board', v: f.int(g.n), u: g.n === 1 ? 'person' : 'people' },
    ], { cols: 2, cls: 'facts--s' })}
  </section>`;
}

/* ── compare ────────────────────────────────────────────────── */

const SERIES_NOTE = { today: 'The last 7 days', week: 'This week, day by day', month: 'This month, day by day', all: 'The last 12 weeks, week by week' };

async function compare(ctx) {
  const { root } = ctx;
  document.title = 'Compare · Health';
  let other = ctx.query.get('with') || '';
  let period = PERIODS.some(([p]) => p === ctx.query.get('period')) ? ctx.query.get('period') : 'week';
  let mode = 'each';
  let people = []; let d = null;

  function picker() {
    const list = people.filter((p) => !p.me);
    if (!list.length) {
      return html`<div class="mod mod--12">${empty({ iconName: 'users', title: 'Nobody to compare with yet', text: 'When friends join and keep their account public, they appear here.' })}</div>`;
    }
    return html`<div class="group picker" role="list">${list.map((p) => html`<a class="row" role="listitem" href="/compare?with=${encodeURIComponent(p.username)}">${avatar(p)}<span class="row__body"><span class="row__t">${nameOf(p)}</span><span class="row__d">@${p.username}${p.joinedAt ? ` · joined ${f.monthYear(f.instDay(p.joinedAt))}` : ''}</span></span><span class="row__chev">${ic('right', { size: 's' })}</span></a>`)}</div>`;
  }

  /** The period day by day (or week by week), as paired bars or running totals. */
  function seriesChart(m, them) {
    const s = d.series?.[m.metric];
    if (!s || !Array.isArray(s.a) || !Array.isArray(s.b) || !Array.isArray(s.labels)) return '';
    if (![...s.a, ...s.b].some((v) => f.isNum(v) && v > 0)) return '';
    const n = s.labels.length;
    const weekly = d.period === 'all';
    const short = (dt) => (weekly ? `${f.dom(dt)}/${Number(String(dt).slice(5, 7))}` : n <= 8 ? f.dow(dt) : String(f.dom(dt)));
    const long = (dt) => (weekly ? `Week of ${f.dayShort(dt)}` : f.dayMed(dt));
    const fmt = (v) => unitText(v, m.unit);
    const tick = m.unit === 'm' ? (v) => f.compact(f.distVal(v)) : f.compact;
    const running = mode === 'total';
    const lines = running || n > 16;
    // A running total carries over a day with nothing, up to that side's last day.
    const sum = (arr) => { let t = 0; let last = -1; arr.forEach((v, i) => { if (f.isNum(v)) last = i; }); return arr.map((v, i) => { if (i > last) return null; if (f.isNum(v)) t += v; return t; }); };
    const A = running ? sum(s.a) : s.a; const B = running ? sum(s.b) : s.b;
    const what = `${m.label} ${weekly ? 'per week' : 'per day'}${running ? ', running total' : ''}: you against ${them}.`;
    const slot = lines
      ? chart((w) => duel({ w, h: 160, labels: s.labels.map((dt) => (weekly || n > 8 ? f.dayShort(dt) : f.dow(dt))), a: A, b: B, nameA: 'You', nameB: them, fmt, tick, label: what }))
      : chart((w) => cats({ w, h: 150, labels: s.labels.map(short), a: s.a, b: s.b, fmt, tick, label: what, reads: s.labels.map((dt, i) => `${long(dt)}: ${[f.isNum(s.a[i]) ? `you ${fmt(s.a[i])}` : null, f.isNum(s.b[i]) ? `${them} ${fmt(s.b[i])}` : null].filter(Boolean).join(', ') || 'nothing on either side'}`) }));
    // A day one side has nothing for counts for the other (a workout against none).
    const v0 = (v) => (f.isNum(v) ? v : 0);
    const wonA = s.labels.filter((_, i) => (f.isNum(s.a[i]) || f.isNum(s.b[i])) && v0(s.a[i]) > v0(s.b[i])).length;
    const wonB = s.labels.filter((_, i) => (f.isNum(s.a[i]) || f.isNum(s.b[i])) && v0(s.b[i]) > v0(s.a[i])).length;
    const unitWord = (k) => (weekly ? (k === 1 ? 'week' : 'weeks') : (k === 1 ? 'day' : 'days'));
    return figure(slot, {
      read: wonA || wonB ? `${SERIES_NOTE[d.period] || ''} · you were ahead on ${f.int(wonA)} ${unitWord(wonA)}, ${them} on ${f.int(wonB)}` : SERIES_NOTE[d.period] || '',
      legendItems: [['sw-met', 'You'], [lines ? 'sw-inkline' : 'sw-them', them]],
      table: tableAlt([weekly ? 'Week of' : 'Day', 'You', them], s.labels.map((dt, i) => [weekly ? f.dayShort(dt) : f.dayMed(dt), f.isNum(s.a[i]) ? fmt(s.a[i]) : f.DASH, f.isNum(s.b[i]) ? fmt(s.b[i]) : f.DASH])),
    });
  }

  /** Who leads a metric, in words, and the pieces of its sheet. */
  function lead(m, them) {
    const diff = Math.abs(m.a - m.b);
    const who = m.a === m.b ? null : ((m.a > m.b) === (m.higherIsBetter !== false) ? 'a' : 'b');
    const low = Math.min(m.a, m.b);
    const pct = low > 0 ? Math.round((diff / low) * 100) : null;
    return { who, pct, words: who === null ? 'Level' : `${who === 'a' ? 'You lead' : `${them} leads`} by ${amount(diff, m.unit)}` };
  }

  /** One metric in full: the two bars, the period day by day, and how the chart counts. */
  function metricBody(m, them) {
    const { who, pct, words } = lead(m, them);
    const max = Math.max(m.a, m.b) || 1;
    const side = (name, v, cls) => html`<div class="duo__r ${cls}">
      <span class="duo__who">${name}</span>
      <span class="duo__bar"><span data-style="--p:${Math.max(0, v / max).toFixed(3)}"></span></span>
      <span class="duo__n">${unitText(v, m.unit)}</span>
    </div>`;
    const graph = seriesChart(m, them);
    return html`<div class="cmpm ${who === 'a' ? 'cmpm--a' : ''}">
      <p class="cmpm__lead"><span class="cmpm__w">${who === 'a' ? ic('up', { size: 's' }) : who === 'b' ? ic('down', { size: 's' }) : ic('flat', { size: 's' })}${words}</span>${who !== null && pct !== null && pct > 0 ? html`<span class="muted">${f.int(pct)}% more</span>` : ''}</p>
      <div class="duo" role="img" aria-label="${m.label}: you ${unitText(m.a, m.unit)}, ${them} ${unitText(m.b, m.unit)}.">${side('You', m.a, 'duo__r--a')}${side(them, m.b, 'duo__r--b')}</div>
      ${graph ? html`<div class="cmp__mode">${seg('mode', [['each', d.period === 'all' ? 'Each week' : 'Each day'], ['total', 'Running total']], mode, { label: 'Chart mode', fit: true })}</div>${graph}` : ''}
    </div>`;
  }

  let rowsNow = [];
  function versus() {
    const them = nameOf(d.b);
    const both = d.metrics.filter((m) => f.isNum(m.a) && f.isNum(m.b));
    const rest = d.metrics.filter((m) => !(f.isNum(m.a) && f.isNum(m.b)));
    const sc = d.score || null;
    const scoreWords = !sc ? ''
      : sc.a + sc.b + sc.ties === 0 ? 'Nothing to compare for this period'
        : [sc.a || sc.b ? `You lead ${f.int(sc.a)}, ${them} leads ${f.int(sc.b)}` : '', sc.ties ? `${f.int(sc.ties)} level` : ''].filter(Boolean).join(' · ');
    const ordered = [...both.filter((m) => d.series?.[m.metric]), ...both.filter((m) => !d.series?.[m.metric])];
    rowsNow = [
      ...ordered.map((m) => {
        const meta = METRIC[m.metric] || { fam: 'steps', icon: 'steps' };
        const l = lead(m, them);
        return {
          key: `c-${m.metric}`, icon: meta.icon, fam: meta.fam, title: m.label, text: l.words,
          value: html`<span class="cmpr__v ${l.who === 'a' ? 'is-you' : ''}">${unitText(m.a, m.unit)}<small> vs ${unitText(m.b, m.unit)}</small></span>`,
          body: () => metricBody(m, them),
          open: (sh, swap) => on(sh.el, 'click', '[data-seg="mode"]', (e, b) => { if (b.dataset.value === mode) return; mode = b.dataset.value; swap(metricBody(m, them)); }),
        };
      }),
      rest.length ? {
        key: 'rest', icon: 'eyeoff', fam: '', title: both.length ? 'Not compared' : 'Nothing to compare', text: rest.map((m) => m.label).join(', '),
        body: html`<p class="tr-quiet">A metric is compared only when both of you share it and both have a number for the period. Not shared can also mean nothing was recorded.</p>
          <div class="lines2">${rest.map((m) => {
            const meta = METRIC[m.metric] || { fam: 'steps', icon: 'steps' };
            const one = f.isNum(m.a) ? `Only you have a number here: ${unitText(m.a, m.unit)}` : f.isNum(m.b) ? `Only ${them} has a number here: ${unitText(m.b, m.unit)}` : '';
            return html`<div class="ns fam fam-${meta.fam}">${ib(meta.icon, { size: 's' })}<span class="ns__b"><span class="ns__k">${m.label}</span>${one ? html`<span class="ns__d">${one}</span>` : ''}</span><span class="ns__v">Not shared</span></div>`;
          })}</div>`,
      } : null,
    ].filter(Boolean);
    const links = [
      { key: 'profile', icon: 'person', fam: '', title: `${them}'s profile`, text: `@${d.b.username}`, href: `/u/${encodeURIComponent(d.b.username)}` },
      { key: 'other', icon: 'compare', fam: '', title: 'Compare with someone else', text: 'Pick another person', href: '/compare' },
    ];
    return html`
      <section class="bt bt--plain h2h cmp-hero" aria-label="You against ${them}, ${d.periodLabel}">
        <div class="h2h__row">
          <div class="h2h__p">${avatar(d.a, { large: true })}<span class="h2h__name">You</span></div>
          <div class="h2h__mid">
            ${sc ? html`<p class="h2h__score n" aria-hidden="true"><span class="${sc.a > sc.b ? 'is-lead' : ''}">${f.int(sc.a)}</span><i>–</i><span class="${sc.b > sc.a ? 'is-lead' : ''}">${f.int(sc.b)}</span></p>` : ''}
            <p class="h2h__k">${d.periodLabel}</p>
          </div>
          <a class="h2h__p" href="/u/${encodeURIComponent(d.b.username)}">${avatar(d.b, { large: true })}<span class="h2h__name">${them}</span></a>
        </div>
        ${scoreWords ? html`<p class="h2h__words">${scoreWords}</p>` : ''}
      </section>
      ${rowsNow.length ? html`<div class="cmp-sec"><h2 class="mx-h2">Each metric</h2>${moreRows(rowsNow, { label: 'Each metric' })}</div>` : ''}
      <div class="cmp-sec">${moreRows(links)}</div>
      <p class="muted small cmp__note">Only what is public on both sides is compared. Each side's days are counted in that person's own time zone.</p>`;
  }

  const chrome = (body) => html`
    ${head({ title: other && d ? 'Compare' : 'Compare with', back: other ? '/compare' : '/ranks' })}
    ${other ? html`<div class="toolbar">${seg('period', PERIODS, period, { label: 'Period' })}</div>` : ''}
    <div class="stack cmpv">${body}</div>`;

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, chrome(skeleton(other ? 'chart' : 'list')));
    try {
      if (!other) {
        people = (await api.get('/api/people')).people || [];
        if (ctx.alive()) mount(root, chrome(picker()));
        return;
      }
      const want = period;
      const got = await api.get(`/api/compare${qs({ with: other, period })}`);
      if (!ctx.alive() || want !== period) return;
      d = got;
      mount(root, chrome(versus()));
    } catch (err) {
      if (!ctx.alive() || quiet) return;
      if (err.status === 404) {
        mount(root, chrome(html`<div class="mod mod--12">${empty({ iconName: 'lock', title: 'This person is not available', text: 'The account is private or does not exist, so there is nothing to compare.', action: html`<a class="btn btn--tonal btn--s" href="/compare">Pick someone else</a>` })}</div>`));
      } else mount(root, chrome(errorState(err)));
    }
  }

  on(root, 'click', '[data-seg="period"]', (e, b) => {
    period = b.dataset.value;
    history.replaceState(history.state, '', `/compare${qs({ with: other, period: period === 'week' ? '' : period })}`);
    load();
  });
  bindMore(root, () => rowsNow);
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onRefresh(() => load({ quiet: true }));
  if (other && other.toLowerCase() === app.me.user?.username?.toLowerCase()) { go('/compare', { replace: true }); return; }
  await load();
}

export default async function ranks(ctx) {
  return compare(ctx);
}
