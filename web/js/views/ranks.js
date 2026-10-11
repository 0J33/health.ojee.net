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
import { mod, grid, stat, range, facts, figure, ib } from '../kit.js';
import * as f from '../format.js';
import { avatar, unitValue, unitText } from './shared.js';

/* Metric → its family (colour) and glyph. */
const METRIC = {
  steps: { label: 'Steps', fam: 'steps', icon: 'steps' },
  active_minutes: { label: 'Active minutes', fam: 'active', icon: 'bolt' },
  workouts: { label: 'Workouts', fam: 'workouts', icon: 'strength' },
  workout_time: { label: 'Workout time', fam: 'workouts', icon: 'timer' },
  distance: { label: 'Distance', fam: 'steps', icon: 'distance' },
  sleep_consistency: { label: 'Sleep consistency', fam: 'sleep', icon: 'moon' },
};
const METRICS = Object.keys(METRIC);
const PERIODS = [['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All time']];
const PREV = { today: 'yesterday', week: 'last week', month: 'last month' };

const nameOf = (p) => p?.displayName || p?.username || '';
const ordinal = (n) => {
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

function entry(e, d, { pinned = false } = {}) {
  const x = unitValue(e.value, d.unit);
  const best = d.group?.best;
  const share = f.isNum(best) && best > 0 && f.isNum(e.value) ? Math.max(0, Math.min(1, e.value / best)) : null;
  const detail = d.metric === 'sleep_consistency' && e.detail
    ? `${f.plural(e.detail.nights, 'night')}, bedtime within ${f.int(e.detail.bedtimeSdMin)} min`
    : e.rank === 1 ? (d.total > 1 ? 'Leading' : '')
      : f.isNum(e.gapToNext) && e.gapToNext > 0 ? `${amount(e.gapToNext, d.unit)} behind next place` : '';
  const sp = !pinned && Array.isArray(e.spark) && e.spark.filter(f.isNum).length >= 2
    ? chart((w) => spark({ w, h: 34, values: e.spark, bars: true, label: `${nameOf(e)}, the last 7 days: ${e.spark.map((v) => (f.isNum(v) ? unitText(v, d.unit) : 'nothing')).join(', ')}.` }))
    : '';
  return html`<a class="lb ${e.me ? 'lb--me' : ''}" href="/u/${encodeURIComponent(e.username)}" ${raw(pinned ? 'data-pinned' : `data-user="${e.me ? 'me' : ''}"`)}>
    <span class="lb__pos"><span class="lb__rank"><span class="sr">Rank </span>${e.rank ?? f.DASH}</span>${movement(e, d)}</span>
    ${avatar(e)}
    <span class="lb__who">
      <span class="lb__name">${nameOf(e)}${e.me ? html` <span class="badge badge--accent">You</span>` : ''}</span>
      ${detail ? html`<span class="lb__sub">${detail}</span>` : ''}
    </span>
    <span class="lb__spark" ${raw(sp ? '' : 'aria-hidden="true"')}>${sp}</span>
    <span class="lb__num">
      <span class="lb__val">${x.v}${x.u ? html`<span class="lb__unit">${x.u}</span>` : ''}</span>
      ${trendChip(e, d)}
    </span>
    ${share !== null ? html`<span class="lb__bar" aria-hidden="true"><span data-style="--p:${share.toFixed(3)}"></span></span>` : ''}
  </a>`;
}

/** "You against the group": rank, value, where you sit, who is next to you. */
function against(d) {
  const meta = METRIC[d.metric];
  const me = d.me || {};
  const g = d.group || {};
  const what = String(d.label).toLowerCase();
  const groupFacts = g.n > 0 ? facts([
    { k: 'On this board', v: f.int(g.n), u: g.n === 1 ? 'person' : 'people' },
    { k: 'Middle of the group', v: unitValue(g.median, d.unit).v, u: unitValue(g.median, d.unit).u },
    { k: 'Best', v: unitValue(g.best, d.unit).v, u: unitValue(g.best, d.unit).u },
    d.unit !== 'score' ? { k: 'All together', v: unitValue(g.total, d.unit).v, u: unitValue(g.total, d.unit).u } : null,
  ], { cols: 2, cls: 'facts--s' }) : '';

  if (me.listed === false || !f.isNum(me.value)) {
    return mod({
      title: 'The group', icon: 'leaderboard', fam: meta.fam, span: 5, note: `${d.label} · ${d.periodLabel}`,
      body: groupFacts,
    });
  }

  const x = unitValue(me.value, d.unit);
  const vals = d.entries.map((e) => e.value).filter(f.isNum);
  const lo = vals.length ? Math.min(...vals) : null;
  const alone = g.n <= 1;
  const mine = d.entries.find((e) => e.me);
  const moved = mine && PREV[d.period] && f.isNum(mine.move) && mine.move !== 0
    ? `${mine.move > 0 ? 'up' : 'down'} ${f.plural(Math.abs(mine.move), 'place')} on ${PREV[d.period]}`
    : mine && PREV[d.period] && mine.move === 0 ? `same place as ${PREV[d.period]}` : '';
  const pct = me.vsMedianPct;
  const medianWords = !f.isNum(pct) ? ''
    : Math.abs(pct) < 1 ? "Right on the group's median"
      : `${Math.abs(Math.round(pct))}% ${pct > 0 ? 'above' : 'below'} the group's median`;

  const beside = (who, word, dir) => (who
    ? html`<a class="near" href="/u/${encodeURIComponent(who.username)}">
        <span class="near__ic">${ic(dir)}</span>
        <span class="near__t"><b>${nameOf(who)}</b> is ${amount(who.by, d.unit)} ${word}</span>
        <span class="row__chev">${ic('right', { size: 's' })}</span>
      </a>`
    : html`<p class="near near--none"><span class="near__ic">${ic(dir)}</span><span class="near__t">${word === 'ahead' ? 'Nobody is ahead of you.' : 'Nobody is behind you.'}</span></p>`);

  return mod({
    title: 'You against the group', icon: 'leaderboard', fam: meta.fam, span: 5, note: `${d.label} · ${d.periodLabel}`,
    body: html`
      <div class="you">
        ${stat({ size: 'l', label: `Your ${what}`, value: x.v, unit: x.u, context: alone ? '' : html`<span>${medianWords}</span>` })}
        <p class="you__rank"><span class="you__n">${f.isNum(me.rank) ? ordinal(me.rank) : f.DASH}</span><span class="you__of">of ${f.int(g.n)}${moved ? html`<br>${moved}` : ''}</span></p>
      </div>
      ${alone
        ? html`<p class="muted">You are the only one on this board for now. When someone else has ${what} for this period, they show up here.</p>`
        : html`<div class="where">
            ${range({ value: me.value, tick: g.median, min: lo, max: g.best, label: `You: ${unitText(me.value, d.unit)}. The group runs from ${unitText(lo, d.unit)} to ${unitText(g.best, d.unit)}, with a median of ${unitText(g.median, d.unit)}.` })}
            <p class="where__key"><span>Lowest ${unitValue(lo, d.unit).v}</span><span class="where__mid"><i></i>Median ${unitValue(g.median, d.unit).v}</span><span>Best ${unitValue(g.best, d.unit).v}</span></p>
          </div>
          <div class="nears">${beside(me.ahead, 'ahead', 'up')}${beside(me.behind, 'behind', 'down')}</div>`}
      ${alone ? '' : html`<hr class="rule">${groupFacts}`}`,
  });
}

async function board(ctx) {
  const { root } = ctx;
  document.title = 'Ranks · Health';
  let metric = METRICS.includes(ctx.query.get('metric')) ? ctx.query.get('metric') : 'steps';
  let period = PERIODS.some(([p]) => p === ctx.query.get('period')) ? ctx.query.get('period') : 'week';
  let d = null; let io = null;

  const chrome = (body) => html`
    ${head({ title: 'Ranks', actions: html`<a class="btn btn--tonal btn--s" href="/compare">${ic('compare', { size: 's' })}Compare</a>` })}
    <div class="chips ranks__chips" role="group" aria-label="Metric">
      ${METRICS.map((id) => html`<button type="button" class="chip fam fam-${METRIC[id].fam}" data-metric="${id}" aria-pressed="${String(id === metric)}">${ic(METRIC[id].icon, { size: 's' })}${METRIC[id].label}</button>`)}
    </div>
    <div class="toolbar ranks__bar">${seg('period', PERIODS, period, { label: 'Period' })}</div>
    ${body}`;

  const loading = () => grid(html`<div class="mod mod--5 mod--plain"><div class="skel skel--tall"></div></div><div class="mod mod--7 mod--plain">${skeleton('list')}</div>`);

  function paint() {
    const me = d.me || {};
    const meta = METRIC[d.metric] || METRIC.steps;
    const mine = d.entries.find((e) => e.me);
    const priv = /private/i.test(me.reason || '');
    const span = period === 'today' ? 'day' : period === 'week' ? 'week (from Monday)' : period === 'month' ? 'month' : 'total';
    const notice = me.listed === false && me.reason ? banner({
      iconName: priv ? 'lock' : 'info',
      title: priv ? 'You are not on this board' : 'You are not on this board yet',
      text: priv ? `${me.reason}, so others cannot see you here. You can change that in privacy settings.` : `${me.reason}.`,
      actions: priv ? html`<a class="btn btn--tonal btn--s" href="/settings/privacy">Privacy settings</a>` : '',
    }) : '';
    const explain = d.metric === 'sleep_consistency' ? 'Sleep consistency is a score out of 100 for how regular bedtime and wake time are. It needs three nights in the period. ' : '';
    const foot = html`${explain}Each person's ${span} is counted in their own time zone. Only people who share this are listed.`;

    const body = !d.entries.length
      ? html`${notice}<div class="mod mod--12">${empty({ iconName: 'ranks', title: 'Nobody has a number here yet', text: `Nothing has been recorded for ${String(d.label).toLowerCase()} ${period === 'today' ? 'today' : period === 'all' ? 'in this app' : `this ${period}`}. Try another period.` })}</div>
          <p class="ranks__foot muted small">${foot}</p>`
      : html`${notice}
        ${grid(html`
          ${against(d)}
          ${mod({
            title: 'Standings', span: 7, cls: 'mod--flush standings', icon: meta.icon, fam: meta.fam,
            note: `${d.label} · ${d.periodLabel}${PREV[period] ? ` · movement since ${PREV[period]}` : ''}`,
            body: html`<div class="lbs" role="list" aria-label="${d.label}, ${d.periodLabel}">${d.entries.map((e) => html`<div role="listitem">${entry(e, d)}</div>`)}</div>`,
            foot,
          })}`, `ranks fam fam-${meta.fam}`)}`;

    mount(root, chrome(html`<div class="stack">${body}</div>
      ${mine ? html`<div class="pinned fam fam-${meta.fam}" data-pin hidden>${entry(mine, d, { pinned: true })}</div>` : ''}`));

    // Pin your own row when the real one is scrolled out of view.
    io?.disconnect();
    const real = root.querySelector('[data-user="me"]');
    const pin = root.querySelector('[data-pin]');
    if (real && pin && 'IntersectionObserver' in window) {
      io = new IntersectionObserver(([en]) => { pin.hidden = en.isIntersecting; }, { rootMargin: '0px 0px -72px 0px' });
      io.observe(real);
    }
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, chrome(loading()));
    history.replaceState(history.state, '', `/ranks${qs({ metric: metric === 'steps' ? '' : metric, period: period === 'week' ? '' : period })}`);
    const want = `${metric}/${period}`;
    try {
      const got = await api.get(`/api/leaderboard${qs({ metric, period })}`);
      if (!ctx.alive() || want !== `${metric}/${period}`) return;
      d = got;
      paint();
    } catch (err) {
      if (ctx.alive() && !quiet) mount(root, chrome(errorState(err)));
    }
  }

  on(root, 'click', '[data-metric]', (e, b) => { metric = b.dataset.metric; load(); });
  on(root, 'click', '[data-seg="period"]', (e, b) => { period = b.dataset.value; load(); });
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social') || what.includes('data')) load({ quiet: true }); }));
  ctx.onLeave(() => io?.disconnect());
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
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
    const wonA = s.labels.filter((_, i) => f.isNum(s.a[i]) && f.isNum(s.b[i]) && s.a[i] > s.b[i]).length;
    const wonB = s.labels.filter((_, i) => f.isNum(s.a[i]) && f.isNum(s.b[i]) && s.b[i] > s.a[i]).length;
    const unitWord = (k) => (weekly ? (k === 1 ? 'week' : 'weeks') : (k === 1 ? 'day' : 'days'));
    return figure(slot, {
      read: wonA || wonB ? `${SERIES_NOTE[d.period] || ''} · you were ahead on ${f.int(wonA)} ${unitWord(wonA)}, ${them} on ${f.int(wonB)}` : SERIES_NOTE[d.period] || '',
      legendItems: [['sw-met', 'You'], [lines ? 'sw-inkline' : 'sw-them', them]],
      table: tableAlt([weekly ? 'Week of' : 'Day', 'You', them], s.labels.map((dt, i) => [weekly ? f.dayShort(dt) : f.dayMed(dt), f.isNum(s.a[i]) ? fmt(s.a[i]) : f.DASH, f.isNum(s.b[i]) ? fmt(s.b[i]) : f.DASH])),
    });
  }

  function metricMod(m, them) {
    const meta = METRIC[m.metric] || { fam: 'steps', icon: 'steps' };
    const diff = Math.abs(m.a - m.b);
    const lead = m.a === m.b ? null : ((m.a > m.b) === (m.higherIsBetter !== false) ? 'a' : 'b');
    const low = Math.min(m.a, m.b);
    const pct = low > 0 ? Math.round((diff / low) * 100) : null;
    const words = lead === null ? 'Level' : `${lead === 'a' ? 'You lead' : `${them} leads`} by ${amount(diff, m.unit)}`;
    const max = Math.max(m.a, m.b) || 1;
    const side = (who, v, cls) => html`<div class="duo__r ${cls}">
      <span class="duo__who">${who}</span>
      <span class="duo__bar"><span data-style="--p:${Math.max(0, v / max).toFixed(3)}"></span></span>
      <span class="duo__n">${unitText(v, m.unit)}</span>
    </div>`;
    const graph = seriesChart(m, them);
    return mod({
      title: m.label, fam: meta.fam, icon: meta.icon, span: 6, cls: `cmpm ${lead === 'a' ? 'cmpm--a' : ''}`,
      body: html`
        <p class="cmpm__lead"><span class="cmpm__w">${lead === 'a' ? ic('up', { size: 's' }) : lead === 'b' ? ic('down', { size: 's' }) : ic('flat', { size: 's' })}${words}</span>${lead !== null && pct !== null && pct > 0 ? html`<span class="muted">${f.int(pct)}% more</span>` : ''}</p>
        <div class="duo" role="img" aria-label="${m.label}: you ${unitText(m.a, m.unit)}, ${them} ${unitText(m.b, m.unit)}.">${side('You', m.a, 'duo__r--a')}${side(them, m.b, 'duo__r--b')}</div>
        ${graph}`,
    });
  }

  function versus() {
    const them = nameOf(d.b);
    const both = d.metrics.filter((m) => f.isNum(m.a) && f.isNum(m.b));
    const rest = d.metrics.filter((m) => !(f.isNum(m.a) && f.isNum(m.b)));
    const sc = d.score || null;
    const scoreWords = !sc ? ''
      : sc.a + sc.b + sc.ties === 0 ? 'Nothing to compare for this period'
        : [sc.a || sc.b ? `You lead ${f.int(sc.a)}, ${them} leads ${f.int(sc.b)}` : '', sc.ties ? `${f.int(sc.ties)} level` : ''].filter(Boolean).join(' · ');
    const hasSeries = both.some((m) => Array.isArray(d.series?.[m.metric]?.a) && Array.isArray(d.series?.[m.metric]?.b));
    return html`
      <section class="mod mod--12 h2h" aria-label="You against ${them}, ${d.periodLabel}">
        <div class="h2h__row">
          <div class="h2h__p">${avatar(d.a, { large: true })}<span class="h2h__name">You</span></div>
          <div class="h2h__mid">
            ${sc ? html`<p class="h2h__score" aria-hidden="true"><span class="${sc.a > sc.b ? 'is-lead' : ''}">${f.int(sc.a)}</span><i>–</i><span class="${sc.b > sc.a ? 'is-lead' : ''}">${f.int(sc.b)}</span></p>` : ''}
            <p class="h2h__k">${d.periodLabel}</p>
          </div>
          <a class="h2h__p" href="/u/${encodeURIComponent(d.b.username)}">${avatar(d.b, { large: true })}<span class="h2h__name">${them}</span></a>
        </div>
        ${scoreWords ? html`<p class="h2h__words">${scoreWords}</p>` : ''}
      </section>
      ${hasSeries ? html`<div class="toolbar cmp__mode"><span class="muted small">Charts show</span>${seg('mode', [['each', d.period === 'all' ? 'Each week' : 'Each day'], ['total', 'Running total']], mode, { label: 'Chart mode', fit: true })}</div>` : ''}
      ${both.length ? grid([...both.filter((m) => d.series?.[m.metric]), ...both.filter((m) => !d.series?.[m.metric])].map((m) => metricMod(m, them)), 'cmpgrid') : ''}
      ${rest.length ? mod({
        title: both.length ? 'Not compared' : 'Nothing to compare', icon: 'eyeoff', span: 12, cls: 'mod--flush notshared',
        note: 'A metric is compared only when both of you share it and both have a number for the period. Not shared can also mean nothing was recorded.',
        body: html`<div class="lines2">${rest.map((m) => {
          const meta = METRIC[m.metric] || { fam: 'steps', icon: 'steps' };
          const one = f.isNum(m.a) ? `Only you have a number here: ${unitText(m.a, m.unit)}` : f.isNum(m.b) ? `Only ${them} has a number here: ${unitText(m.b, m.unit)}` : '';
          return html`<div class="ns fam fam-${meta.fam}">${ib(meta.icon, { size: 's' })}<span class="ns__b"><span class="ns__k">${m.label}</span>${one ? html`<span class="ns__d">${one}</span>` : ''}</span><span class="ns__v">Not shared</span></div>`;
        })}</div>`,
      }) : ''}
      <p class="muted small cmp__note">Only what is public on both sides is compared. Each side's days are counted in that person's own time zone.</p>
      <div class="btnrow"><a class="btn btn--tonal btn--s" href="/compare">Compare with someone else</a><a class="btn btn--tonal btn--s" href="/u/${encodeURIComponent(d.b.username)}">${them}'s profile</a></div>`;
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
  on(root, 'click', '[data-seg="mode"]', (e, b) => {
    mode = b.dataset.value;
    if (d) mount(root, chrome(versus()));
  });
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onRefresh(() => load({ quiet: true }));
  if (other && other.toLowerCase() === app.me.user?.username?.toLowerCase()) { go('/compare', { replace: true }); return; }
  await load();
}

export default async function ranks(ctx) {
  return ctx.name === 'compare' ? compare(ctx) : board(ctx);
}
