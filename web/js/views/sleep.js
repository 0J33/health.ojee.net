/* Sleep: one night, opened from Today's sleep card (/sleep, /sleep?date=…).
   The same blue as the card. Time asleep and the score first, then the
   night as stages, the time in each stage, what the score is made of, and
   how the night compares with the week and the month. The arrows (or a
   sideways swipe on the hero) step through the nights.

   Data: /api/data (the nights with their stages, the scores) and
   /api/brief (the score's parts, the usual bedtime and wake). */

import { api } from '../api.js';
import { app, listen } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, chart, on } from '../ui.js';
import { sleepNight } from '../charts.js';
import { aiButton } from '../ai.js';
import * as f from '../format.js';
import { tring } from './today.js';

const STAGES = [['DEEP', 'Deep', 'var(--c-deep)'], ['REM', 'REM', 'var(--c-rem)'], ['LIGHT', 'Light', 'var(--c-light)'], ['AWAKE', 'Awake', 'var(--c-awake)']];
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** 105 → "1 h 45", 14 → "14 min". */
const hmin = (m) => (m < 60 ? `${f.int(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`);
const tidy = (v) => (Number.isInteger(v) ? f.int(v) : f.dec1(v));

function hero(n, sc, band, goal) {
  const when = `${f.clock(n.startMs)} – ${f.clock(n.endMs)}`;
  const diff = n.asleepMin - goal;
  const goalText = Math.abs(diff) < 10 ? 'right on your goal' : `${f.dur(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} your ${f.dur(goal)} goal`;
  return html`<section class="bt bt--sleep sl-hero" data-noswipe-x>
    <div class="sl-hero__l">
      <p class="sl-hero__k">${n.date === f.today() ? 'Last night' : f.dayRel(n.date)} · ${when}</p>
      <p class="n n-hero" data-count>${Math.floor(n.asleepMin / 60)}<span class="u">h</span>&thinsp;${Math.round(n.asleepMin % 60)}<span class="u">m</span></p>
      <p class="bt__sub">asleep · ${f.dur(n.periodMin ?? n.asleepMin)} in bed · ${goalText}</p>
    </div>
    ${sc !== null ? tring(sc, { size: 96, sw: 7, inner: html`<b class="n" data-count>${sc}</b><span>${band}</span>` }) : ''}
  </section>`;
}

function stagesCard(n) {
  if (!n.stages?.length) {
    return html`<section class="bt bt--plain sl-card"><div class="bt__row"><h2 class="sl-h">Stages</h2></div><p class="bt__sub">Your tracker did not record sleep stages for this night.</p></section>`;
  }
  return html`<section class="bt bt--plain sl-card">
    <div class="bt__row"><h2 class="sl-h">Stages</h2><span class="bt__meta">${f.clock(n.startMs)} – ${f.clock(n.endMs)}</span></div>
    ${chart((w) => sleepNight({ w, h: 112, start: n.startMs, end: n.endMs, stages: n.stages, label: `Sleep stages from ${f.clock(n.startMs)} to ${f.clock(n.endMs)}` }))}
  </section>`;
}

function eachCard(n, bs) {
  const st = n.stagesMin || {};
  const total = STAGES.reduce((a, [k]) => a + (st[k] || 0), 0);
  return html`<section class="bt bt--plain sl-card sl-each">
    <h2 class="sl-h">Time in each</h2>
    <ul class="sl-kv">${STAGES.map(([k, label, col]) => {
      const usual = bs?.stages?.[k]?.usualPct;
      return html`<li><span><i class="sl-sw" style="background:${col}"></i>${label}</span><b class="n">${hmin(st[k] || 0)}</b>${total ? html`<small>${Math.round(((st[k] || 0) / total) * 100)}%${f.isNum(usual) ? ` · usual ${Math.round(usual)}%` : ''}</small>` : ''}</li>`;
    })}</ul>
  </section>`;
}

function partsCard(sc) {
  if (!sc?.parts?.length) return '';
  return html`<a class="bt bt--sleepsoft sl-card sl-parts" href="/metric/sleep_score">
    <div class="bt__row"><h2 class="sl-h">Score <span class="n">${sc.score}</span></h2>${ic('right', { size: 's' })}</div>
    <ul class="sl-parts__l">${sc.parts.map((p) => html`<li>
      <p><span>${p.label}</span><b class="n">${tidy(p.points)}<small>/${p.max}</small></b></p>
      <span class="tbar fillbar"><i style="width:${Math.round((p.points / p.max) * 100)}%"></i></span>
      ${p.text ? html`<span class="sl-parts__t">${p.text}</span>` : ''}
    </li>`)}</ul>
  </a>`;
}

function avgCard(nights, n) {
  const main = nights.filter((x) => x.main !== false && f.isNum(x.asleepMin) && x.date <= n.date);
  const last7 = avg(main.slice(-7).map((x) => x.asleepMin));
  const all = avg(main.map((x) => x.asleepMin));
  const cell = (label, v) => (v === null ? '' : html`<div><p class="sl-k">${label}</p><p class="n n-s">${hmin(v)}</p><p class="bt__sub">This night ${n.asleepMin - v >= 0 ? '+' : '−'}${f.int(Math.abs(n.asleepMin - v))} min</p></div>`);
  return html`<section class="bt bt--plain sl-avg">${cell('7-night average', last7)}${cell(`${main.length}-night average`, all)}</section>`;
}

function whenCard(bs, n) {
  if (!bs || n.date !== f.today()) return '';
  const rows = [
    bs.bedtime?.last ? ['Asleep at', f.hhmm(bs.bedtime.last), bs.bedtime.usual ? `usual ${f.hhmm(bs.bedtime.usual)}` : ''] : null,
    bs.wake?.last ? ['Up at', f.hhmm(bs.wake.last), bs.wake.usual ? `usual ${f.hhmm(bs.wake.usual)}` : ''] : null,
    f.isNum(bs.regularity) ? ['Regularity', `${f.int(bs.regularity)} of 100`, `over ${f.plural(bs.nights, 'night')}`] : null,
    f.isNum(bs.debt7Min) ? ['Short of goal, 7 nights', bs.debt7Min < 5 ? 'None' : f.dur(bs.debt7Min), ''] : null,
  ].filter(Boolean);
  if (!rows.length) return '';
  return html`<section class="bt bt--plain sl-card"><ul class="sl-kv sl-kv--when">${rows.map(([k, v, s]) => html`<li><span>${k}</span><b class="n">${v}</b><small>${s}</small></li>`)}</ul></section>`;
}

export default async function sleepView(ctx) {
  const { root } = ctx;
  document.title = 'Sleep · Health';
  let data = null; let brief = null;
  const want = ctx.query.get('date');

  function nightsOf(d) {
    return (d.sleep?.nights || []).filter((x) => x.main !== false && f.isNum(x.startMs)).map((x) => {
      const st = {};
      for (const s of x.stages || []) st[s.t] = (st[s.t] || 0) + (s.e - s.s) / 60000;
      return { ...x, stagesMin: Object.keys(st).length ? st : (d.sleep.lastNight?.date === x.date ? d.sleep.lastNight.stages : {}) };
    });
  }

  function paint() {
    const d = data; const b = brief;
    const nights = nightsOf(d);
    const i = want ? nights.findIndex((x) => x.date === want) : nights.length - 1;
    const n = nights[i >= 0 ? i : nights.length - 1];
    const prev = nights[(i >= 0 ? i : nights.length - 1) - 1];
    const next = nights[(i >= 0 ? i : nights.length - 1) + 1];
    const nav = html`<span class="sl-nav">
      ${prev ? html`<a class="iconbtn" href="/sleep?date=${prev.date}" aria-label="The night before">${ic('left')}</a>` : html`<span class="iconbtn is-off" aria-hidden="true">${ic('left')}</span>`}
      ${next ? html`<a class="iconbtn" href="${next.date === nights.at(-1).date ? '/sleep' : `/sleep?date=${next.date}`}" aria-label="The night after">${ic('right')}</a>` : html`<span class="iconbtn is-off" aria-hidden="true">${ic('right')}</span>`}
    </span>`;
    if (!n) {
      mount(root, html`${head({ title: 'Sleep', back: '/' })}<div class="empty"><span class="empty__ic">${ic('moon')}</span><p class="empty__t">No nights yet</p><p class="empty__d">Wear your tracker to bed and your nights show up here.</p></div>`);
      return;
    }
    const goal = d.activity?.sleepTarget || app.me.goals?.sleepMinutes || 450;
    const isLast = n.date === d.scores?.date || n.date === b?.extra?.sleepScore?.date;
    const scObj = isLast && b?.extra?.sleepScore?.date === n.date ? b.extra.sleepScore : null;
    const row = (d.series || []).find((r) => r.date === n.date);
    const sc = isLast && f.isNum(d.scores?.sleep) ? d.scores.sleep : f.isNum(row?.sleepScore) ? row.sleepScore : scObj?.score ?? null;
    const band = isLast && d.scores?.sleepBand ? d.scores.sleepBand : sc === null ? '' : sc >= 90 ? 'Excellent' : sc >= 80 ? 'Good' : sc >= 60 ? 'Fair' : 'Poor';
    mount(root, html`
      ${head({ title: 'Sleep', back: '/', actions: html`${aiButton('sleep', { label: 'Ask' })}${nav}` })}
      <div class="stack sl">
        ${hero(n, sc, band, goal)}
        ${stagesCard(n)}
        <div class="bento">${eachCard(n, b?.sleep)}${partsCard(scObj) || html`<a class="bt bt--sleepsoft sl-card" href="/trends/sleep"><h2 class="sl-h">Your sleep</h2><p class="bt__sub">Trends, regularity and stages over weeks.</p>${ic('right', { size: 's' })}</a>`}</div>
        ${avgCard(nights, n)}
        ${whenCard(b?.sleep, n)}
        <a class="bt bt--plain sl-more" href="/trends/sleep"><span>Sleep trends</span>${ic('right', { size: 's' })}</a>
      </div>`);
  }

  async function load() {
    const [d, b] = await Promise.all([api.get('/api/data?days=30'), api.get('/api/brief').catch(() => null)]);
    data = d; brief = b;
  }

  // Swipe the hero sideways: the night before / after.
  let sx = null;
  on(root, 'touchstart', '.sl-hero', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  on(root, 'touchend', '.sl-hero', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) < 60) return;
    root.querySelector(`.sl-nav a[aria-label="${dx > 0 ? 'The night before' : 'The night after'}"]`)?.click();
  }, { passive: true });

  ctx.onLeave(listen('changed', (what) => { if (what.includes('data')) load().then(() => { if (ctx.alive()) paint(); }).catch(() => {}); }));
  ctx.onRefresh(async () => { await load(); if (ctx.alive()) paint(); });

  mount(root, html`${head({ title: 'Sleep', back: '/' })}${skeleton('page')}`);
  try {
    await load();
    if (ctx.alive()) paint();
  } catch (err) {
    if (ctx.alive()) mount(root, html`${head({ title: 'Sleep', back: '/' })}${errorState(err)}`);
  }
}
