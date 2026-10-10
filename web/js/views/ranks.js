/* Ranks: the leaderboard (metric × period, your row pinned when it is off
   screen) and the compare view (you against one person). */

import { api, qs } from '../api.js';
import { app, listen, go } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, empty, banner, on, seg } from '../ui.js';
import * as f from '../format.js';
import { avatar, unitValue, unitText } from './shared.js';

const METRICS = [['steps', 'Steps'], ['active_minutes', 'Active minutes'], ['workouts', 'Workouts'], ['workout_time', 'Workout time'], ['distance', 'Distance'], ['sleep_consistency', 'Sleep consistency']];
const PERIODS = [['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All time']];
const PREV = { today: 'yesterday', week: 'last week', month: 'last month' };

function trend(e, period, higherIsBetter) {
  if (!f.isNum(e.trend) || !PREV[period]) return '';
  const r = Math.round(e.trend);
  if (r === 0) return html`<span>Same as ${PREV[period]}</span>`;
  const up = r > 0;
  const good = up === (higherIsBetter !== false);
  return html`<span class="move ${good ? 'move--up' : 'move--down'}">${ic(up ? 'up' : 'down')}${Math.abs(r)}%<span class="sr"> ${up ? 'up' : 'down'}</span></span><span>vs ${PREV[period]}</span>`;
}

function entry(e, d, { pinned = false } = {}) {
  const x = unitValue(e.value, d.unit);
  const detail = d.metric === 'sleep_consistency' && e.detail ? `${f.plural(e.detail.nights, 'night')}, bedtime within ${f.int(e.detail.bedtimeSdMin)} min` : '';
  return html`<a class="lb ${e.me ? 'lb--me' : ''} ${e.rank === 1 ? 'lb--top' : ''}" href="/u/${encodeURIComponent(e.username)}" ${raw(pinned ? 'data-pinned' : `data-user="${e.me ? 'me' : ''}"`)}>
    <span class="lb__rank"><span class="sr">Rank </span>${e.rank ?? f.DASH}</span>
    ${avatar(e)}
    <span>
      <span class="lb__name">${e.displayName || e.username}${e.me ? html` <span class="badge badge--accent">You</span>` : ''}</span>
      <span class="lb__sub">${detail || trend(e, d.period, d.higherIsBetter)}</span>
    </span>
    <span class="lb__val">${x.v}<span class="lb__unit">${x.u}</span></span>
  </a>`;
}

async function board(ctx) {
  const { root } = ctx;
  document.title = 'Ranks · Health';
  let metric = METRICS.some(([m]) => m === ctx.query.get('metric')) ? ctx.query.get('metric') : 'steps';
  let period = PERIODS.some(([p]) => p === ctx.query.get('period')) ? ctx.query.get('period') : 'week';
  let d = null; let io = null;

  const chrome = (body) => html`
    ${head({ title: 'Ranks', actions: html`<a class="btn btn--tonal btn--s" href="/compare">${ic('compare', { size: 's' })}Compare</a>` })}
    <div class="chips" role="group" aria-label="Metric">
      ${METRICS.map(([id, label]) => html`<button type="button" class="chip" data-metric="${id}" aria-pressed="${String(id === metric)}">${label}</button>`)}
    </div>
    <div class="toolbar" data-style="margin-top:12px">${seg('period', PERIODS, period, { label: 'Period' })}</div>
    ${body}`;

  function paint() {
    const me = d.me || {};
    const mine = d.entries.find((e) => e.me);
    const explain = d.metric === 'sleep_consistency' ? 'A score out of 100 for how regular bedtime and wake time are. It needs three nights in the period.' : '';
    mount(root, chrome(html`
      <div class="stack">
        ${me.listed === false && me.reason ? banner({
          iconName: /private/i.test(me.reason) ? 'lock' : 'info',
          title: /private/i.test(me.reason) ? 'You are not on this board' : 'You are not on this board yet',
          text: /private/i.test(me.reason) ? `${me.reason}, so others cannot see you here. You can change that in privacy settings.` : `${me.reason}.`,
          actions: /private/i.test(me.reason) ? html`<a class="btn btn--tonal btn--s" href="/settings/privacy">Privacy settings</a>` : '',
        }) : ''}
        ${d.entries.length
          ? html`<div class="group" role="list" aria-label="${d.label}, ${d.periodLabel}">${d.entries.map((e) => html`<div role="listitem">${entry(e, d)}</div>`)}</div>`
          : html`<div class="group">${empty({ iconName: 'ranks', title: 'Nobody has a number here yet', text: `Nothing has been recorded for ${String(d.label).toLowerCase()} ${period === 'today' ? 'today' : `in this ${period === 'all' ? 'app' : period}`}. Try another period.` })}</div>`}
        ${explain ? html`<p class="muted small" data-style="padding:0 4px">${explain}</p>` : ''}
        <p class="muted small" data-style="padding:0 4px">Each person's ${period === 'today' ? 'day' : period === 'week' ? 'week (from Monday)' : period === 'month' ? 'month' : 'total'} is counted in their own time zone. Only people who share this are listed.</p>
      </div>
      ${mine ? html`<div class="pinned" data-pin hidden>${entry(mine, d, { pinned: true })}</div>` : ''}`));

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
    if (!quiet) mount(root, chrome(skeleton('list')));
    history.replaceState(history.state, '', `/ranks${qs({ metric: metric === 'steps' ? '' : metric, period: period === 'week' ? '' : period })}`);
    try { d = await api.get(`/api/leaderboard${qs({ metric, period })}`); if (ctx.alive()) paint(); } catch (err) {
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

async function compare(ctx) {
  const { root } = ctx;
  document.title = 'Compare · Health';
  let other = ctx.query.get('with') || '';
  let period = PERIODS.some(([p]) => p === ctx.query.get('period')) ? ctx.query.get('period') : 'week';
  let people = []; let d = null;

  function picker() {
    const list = people.filter((p) => !p.me);
    if (!list.length) {
      return html`<div class="group">${empty({ iconName: 'users', title: 'Nobody to compare with yet', text: 'When friends join and keep their account public, they appear here.' })}</div>`;
    }
    return html`<div class="group" role="list">${list.map((p) => html`<a class="row" role="listitem" href="/compare?with=${encodeURIComponent(p.username)}">${avatar(p)}<span class="row__body"><span class="row__t">${p.displayName || p.username}</span><span class="row__d">@${p.username}</span></span><span class="row__chev">${ic('right', { size: 's' })}</span></a>`)}</div>`;
  }

  function versus() {
    const rows = d.metrics.map((m) => {
      const max = Math.max(m.a || 0, m.b || 0) || 1;
      const lead = f.isNum(m.a) && f.isNum(m.b) && m.a !== m.b ? ((m.a > m.b) === (m.higherIsBetter !== false) ? 'a' : 'b') : null;
      const side = (who, v, cls) => html`<div class="cmp__r">
        <span class="cmp__who">${who}</span>
        ${f.isNum(v) ? html`<div class="meter ${cls}"><div class="meter__v" data-style="--p:${(v / max).toFixed(3)}"></div></div>` : html`<span class="muted small">Not shared</span>`}
        <span class="cmp__n">${f.isNum(v) ? unitText(v, m.unit) : ''}</span>
      </div>`;
      if (!f.isNum(m.a) && !f.isNum(m.b)) {
        return html`<div class="cmp"><p class="cmp__k">${m.label}</p><p class="muted small">Not shared on both sides, or no data for this period.</p></div>`;
      }
      return html`<div class="cmp">
        <p class="cmp__k">${m.label}${lead ? html` <span class="badge ${lead === 'a' ? 'badge--accent' : ''}">${lead === 'a' ? 'You lead' : `${d.b.displayName || d.b.username} leads`}</span>` : ''}</p>
        ${side('You', m.a, '')}
        ${side(d.b.displayName || d.b.username, m.b, 'meter--them')}
      </div>`;
    });
    return html`
      <div class="group">
        <div class="cmp__head">
          <div class="cmp__p">${avatar(d.a, { large: true })}<span class="h3">You</span></div>
          <span class="cmp__vs">${d.periodLabel}</span>
          <a class="cmp__p" href="/u/${encodeURIComponent(d.b.username)}">${avatar(d.b, { large: true })}<span class="h3">${d.b.displayName || d.b.username}</span></a>
        </div>
        ${rows}
      </div>
      <p class="muted small" data-style="padding:0 4px">Only what is public on both sides is compared.</p>
      <div class="btnrow"><a class="btn btn--tonal btn--s" href="/compare">Compare with someone else</a></div>`;
  }

  const chrome = (body) => html`
    ${head({ title: other && d ? 'Compare' : 'Compare with', back: other ? '/compare' : '/ranks' })}
    ${other ? html`<div class="toolbar">${seg('period', PERIODS, period, { label: 'Period' })}</div>` : ''}
    <div class="stack">${body}</div>`;

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, chrome(skeleton('list')));
    try {
      if (!other) {
        people = (await api.get('/api/people')).people || [];
        if (ctx.alive()) mount(root, chrome(picker()));
        return;
      }
      d = await api.get(`/api/compare${qs({ with: other, period })}`);
      if (ctx.alive()) mount(root, chrome(versus()));
    } catch (err) {
      if (!ctx.alive() || quiet) return;
      if (err.status === 404) {
        mount(root, chrome(html`<div class="group">${empty({ iconName: 'lock', title: 'This person is not available', text: 'The account is private or does not exist, so there is nothing to compare.', action: html`<a class="btn btn--tonal btn--s" href="/compare">Pick someone else</a>` })}</div>`));
      } else mount(root, chrome(errorState(err)));
    }
  }

  on(root, 'click', '[data-seg="period"]', (e, b) => {
    period = b.dataset.value;
    history.replaceState(history.state, '', `/compare${qs({ with: other, period: period === 'week' ? '' : period })}`);
    load();
  });
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onRefresh(() => load({ quiet: true }));
  if (other && other.toLowerCase() === app.me.user?.username?.toLowerCase()) { go('/compare', { replace: true }); return; }
  await load();
}

export default async function ranks(ctx) {
  return ctx.name === 'compare' ? compare(ctx) : board(ctx);
}
