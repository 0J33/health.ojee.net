/* Best times (/workouts/best): each standard distance's fastest, and the
   history of every time that record fell.

   Pick the sport (when there is more than one) and the distance; the hero
   says the record, its pace and when it was set; the chart draws every
   effort at that distance with the record stepping down through them
   (faster is higher); the list under it is each record, newest first, with
   how much it took off, and opens its workout.

   From GET /api/best-times (server/medals.js bestTimes): the fastest
   stretch of each GPS track, or a whole session of about the distance.

   Compare: a row of the people you can set beside you (they share their
   workouts with you and you yours with them, as on Compare), each with
   their time at the distance; pick one and their record line joins yours
   on the chart and the hero says who is ahead and by how much. Under it,
   everybody's best at that distance, fastest first, you among them
   (GET /api/best-times/people). Their times only: never their workouts. */

import { api } from '../api.js';
import { html, mount, head, skeleton, errorState, on, seg, chart, empty, ic, banner } from '../ui.js';
import * as f from '../format.js';
import { bestTimes as bestChart, clockTime } from '../viz.js';
import { avatar } from './shared.js';

const SPORT = { run: ['Run', 'run'], ride: ['Ride', 'bike'], walk: ['Walk', 'walk'] };
const KEY = 'health.best.pick';

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
/** Pace per km (or mile) for runs and walks, speed for rides. */
function rate(sport, m, s) {
  if (sport === 'ride') { const kmh = (m / 1000) / (s / 3600); return `${f.dec1(f.distUnit() === 'mi' ? kmh / 1.609344 : kmh)} ${f.distUnit() === 'mi' ? 'mph' : 'km/h'}`; }
  const per = s / (m / 1000) * (f.distUnit() === 'mi' ? 1.609344 : 1);
  return `${clockTime(per)} /${f.distUnit()}`;
}

export default async function best(ctx) {
  const { root } = ctx;
  document.title = 'Best times · Health';
  const top = () => head({ title: 'Best times', back: '/workouts?view=progress' });
  mount(root, html`${top()}${skeleton('page')}`);
  let d;
  let other = ctx.query?.get('with') || '';
  let them = null;     // { who, hidden, sports } of the person beside you
  let board = {};      // sport -> [{ username, displayName, avatar, accent, me, bests }]
  try { d = await api.get(`/api/best-times${other ? `?with=${encodeURIComponent(other)}` : ''}`); } catch (err) {
    if (err.status !== 404 || !other) { if (ctx.alive()) mount(root, html`${top()}${errorState(err)}`); return; }
    other = '';
    try { d = await api.get('/api/best-times'); } catch (e2) { if (ctx.alive()) mount(root, html`${top()}${errorState(e2)}`); return; }
  }
  if (!ctx.alive()) return;
  them = d.them || null;
  const sports = d.sports || [];
  if (!sports.length) {
    mount(root, html`${top()}<div class="stack">${empty({ iconName: 'flag', title: 'No best times yet', text: 'Record a run, ride or walk with GPS (or bring one in from your watch) and its fastest 1 km, 5 km, 10 km and more show here, with every record you break.' })}</div>`);
    return;
  }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const q = ctx.query;
  let sport = sports.find((x) => x.sport === (q?.get('sport') || saved.sport))?.sport || sports[0].sport;
  const distOf = (sp) => sports.find((x) => x.sport === sp).distances;
  // The distance asked for; else the one last looked at; else the 5 km, the classic, or the first there is.
  const pickDist = (sp, want) => { const ds = distOf(sp); return (ds.find((x) => x.m === want) || ds.find((x) => x.m === 5000) || ds[0]).m; };
  let dist = pickDist(sport, Number(q?.get('d') || saved.d));

  const nameOf = (p) => p?.displayName || p?.username || '';
  const first1 = (p) => nameOf(p).split(/\s+/)[0];
  /** Their distance, when they have run it. */
  const theirDist = () => (them && !them.hidden ? them.sports.find((x) => x.sport === sport)?.distances.find((y) => y.m === dist) : null);

  /** Who you can compare with at this distance, and everybody's time there, fastest first. */
  function compareBlock() {
    const people = board[sport];
    if (!people) return html`<div class="bst-cmp" data-cmp aria-busy="true" aria-label="Loading"></div>`;
    const others = people.filter((p) => !p.me);
    if (!others.length) {
      return html`<section class="bst-cmp" data-cmp><p class="bst-cmp__none">${ic('users', { size: 's' })}<span>Nobody to compare with yet. Friends who share their workouts with you, and you with them, show here with their times.</span></p></section>`;
    }
    const ranked = people.filter((p) => Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist]);
    const label = distOf(sport).find((y) => y.m === dist).label;
    return html`<section class="bst-cmp" data-cmp>
      <div class="bsec"><h2>Compare with</h2>${other ? html`<button type="button" class="bst-cmp__off" data-with="">Just me</button>` : ''}</div>
      <div class="bst-pp" role="group" aria-label="Compare with">${others.map((p) => {
        const t = p.bests[dist];
        return html`<button type="button" class="bst-p press" data-with="${p.username}" aria-pressed="${String(p.username === other)}">
          ${avatar(p)}<span class="bst-p__n">${first1(p)}</span><b class="bst-p__t n">${Number.isFinite(t) ? clockTime(t) : html`<small>No ${label}</small>`}</b></button>`;
      })}</div>
      ${ranked.length > 1 ? html`<ol class="bst-board">${ranked.map((p, i) => html`<li class="${p.me ? 'is-me' : ''} ${p.username === other ? 'is-them' : ''}">
        <button type="button" class="bst-board__r" ${p.me ? 'disabled' : html`data-with="${p.username}"`}>
          <span class="bst-board__i n">${ranked.findIndex((o) => o.bests[dist] === p.bests[dist]) + 1}</span>${avatar(p)}<span class="bst-board__n">${p.me ? 'You' : nameOf(p)}</span>
          <span class="bst-board__t n">${clockTime(p.bests[dist])}</span>
          <span class="bst-board__g">${p.bests[dist] === ranked[0].bests[dist] ? (ranked.filter((o) => o.bests[dist] === ranked[0].bests[dist]).length > 1 ? 'Level' : 'Fastest') : `+${clockTime(p.bests[dist] - ranked[0].bests[dist])}`}</span>
        </button></li>`)}</ol>` : ''}
    </section>`;
  }

  /** You against them at this distance: who is ahead and by how much. */
  function versus(x) {
    if (!them) return '';
    const n = first1(them.who);
    if (them.hidden) {
      return banner({ tone: 'warn', iconName: 'lock', title: them.hidden === 'yours' ? `Share your workouts with ${n} to compare` : `${n} does not share workouts with you`,
        text: them.hidden === 'yours' ? 'Comparing is fair both ways: their times show while yours show to them. Your workouts\' audience is in Settings, Privacy.' : 'Their best times show here when they share their workouts with you.',
        actions: them.hidden === 'yours' ? html`<a class="btn btn--s btn--tonal" href="/settings/privacy">Privacy</a>` : '' });
    }
    const t = theirDist();
    if (!t) return html`<p class="bst-vs bst-vs--none">${avatar(them.who)}<span>${n} has no ${x.label} yet.</span></p>`;
    const gap = t.best.timeS - x.best.timeS;
    return html`<div class="bst-vs">
      <span class="bst-vs__p"><small>You</small><b class="n">${clockTime(x.best.timeS)}</b></span>
      <span class="bst-vs__g ${gap > 0 ? 'is-ahead' : gap < 0 ? 'is-behind' : ''}">${gap === 0 ? 'Level' : `${clockTime(Math.abs(gap))} ${gap > 0 ? 'faster' : 'slower'}`}</span>
      <span class="bst-vs__p bst-vs__p--them">${avatar(them.who)}<small>${n}</small><b class="n">${clockTime(t.best.timeS)}</b></span>
    </div>`;
  }

  async function loadBoard() {
    if (board[sport]) return;
    const sp = sport;
    try {
      const r = await api.get(`/api/best-times/people?sport=${sp}`);
      board[sp] = r.people || [];
    } catch { board[sp] = []; }
    if (ctx.alive() && sp === sport) mount(root.querySelector('[data-cmp]'), compareBlock());
  }

  async function pickWith(username) {
    other = username;
    if (!other) { them = null; paint(); return; }
    try {
      const r = await api.get(`/api/best-times?with=${encodeURIComponent(other)}`);
      if (!ctx.alive() || other !== username) return;
      them = r.them || null;
    } catch { them = null; other = ''; }
    paint();
  }

  function paint() {
    const ds = distOf(sport);
    const x = ds.find((y) => y.m === dist);
    const b = x.best;
    const recs = [...x.records].reverse();
    const first = x.records[0];
    const took = first && b !== first ? first.timeS - b.timeS : 0;
    const t = theirDist();
    try { localStorage.setItem(KEY, JSON.stringify({ sport, d: dist })); } catch { /* fine */ }
    history.replaceState(history.state, '', `/workouts/best?sport=${sport}&d=${dist}${other ? `&with=${encodeURIComponent(other)}` : ''}`);
    mount(root, html`${top()}
      <div class="stack bst-pg">
        ${sports.length > 1 ? html`<div class="bst-sw">${seg('btsport', sports.map((s) => [s.sport, SPORT[s.sport][0]]), sport, { label: 'Sport', fit: true })}</div>` : ''}
        <div class="bst-ds" role="group" aria-label="Distance">${ds.map((y) => html`<button type="button" class="bst-d press" data-d="${y.m}" aria-pressed="${String(y.m === dist)}"><span>${y.label}</span><b class="n">${clockTime(y.best.timeS)}</b></button>`)}</div>
        <section class="bst-hero">
          <p class="bst-hero__k">${ic(SPORT[sport][1], { size: 's' })}Fastest ${x.label.toLowerCase().startsWith('half') || x.label === 'Marathon' ? x.label.toLowerCase() : x.label}</p>
          <p class="bst-hero__v n">${clockTime(b.timeS)}</p>
          <p class="bst-hero__s">${rate(sport, x.m, b.timeS)} · ${f.dayRel(dayOf(b.at))}${b.whole ? ' · the whole run' : ''}</p>
          <div class="bst-hero__f">
            <span><b class="n">${f.int(x.records.length)}</b><small>${x.records.length === 1 ? 'record' : 'records'}</small></span>
            <span><b class="n">${f.int(x.efforts.length)}</b><small>${x.efforts.length === 1 ? 'effort' : 'efforts'}</small></span>
            <span><b class="n">${took ? `−${clockTime(took)}` : f.DASH}</b><small>since the first</small></span>
          </div>
          ${versus(x)}
          ${chart((w) => bestChart({ w, efforts: x.efforts, records: x.records, until: Date.now(), go: (i) => `/workouts/${encodeURIComponent(x.efforts[i].id)}`,
            them: t ? { name: first1(them.who), records: t.records } : null,
            label: `Your ${x.label} times: ${x.efforts.length} efforts, the record falling ${x.records.length - 1} times to ${clockTime(b.timeS)}.${t ? ` ${nameOf(them.who)}'s record: ${clockTime(t.best.timeS)}.` : ''}` }), { cls: 'bst-chart' })}
          <p class="bst-hero__note">Higher is faster. The line is your record; each dot on it is a time you beat it.${t ? ` The dashed line is ${first1(them.who)}'s.` : ''}</p>
        </section>
        ${compareBlock()}
        <div class="bsec"><h2>Each record</h2><span class="hs-s">newest first</span></div>
        <ol class="bst-recs">${recs.map((r, i) => html`<li><a class="bst-rec press" href="/workouts/${encodeURIComponent(r.id)}">
          <span class="bst-rec__dot ${i === 0 ? 'is-now' : ''}" aria-hidden="true">${i === 0 ? ic('record', { size: 's' }) : ''}</span>
          <span class="bst-rec__b"><span class="bst-rec__t">${f.dayRel(dayOf(r.at))}${r.title ? html` <small>· ${r.title}</small>` : ''}</span><span class="bst-rec__s">${rate(sport, x.m, r.timeS)}${r.whole ? ' · the whole run' : ''}</span></span>
          <span class="bst-rec__v"><b class="n">${clockTime(r.timeS)}</b><small class="${r.prevS ? 'is-up' : ''}">${r.prevS ? `−${clockTime(r.prevS - r.timeS)}` : 'First'}</small></span>
          ${ic('chev_r', { size: 's' })}
        </a></li>`)}</ol>
        <p class="muted small bst-foot">The fastest stretch of each run, ride or walk with a GPS track, as your medals count it; a session without one counts when it was about the distance. A time can only be a record against an earlier one.</p>
      </div>`);
  }
  paint();
  loadBoard();
  on(root, 'click', '[data-seg="btsport"]', (e, b) => { sport = b.dataset.value; dist = pickDist(sport, dist); paint(); loadBoard(); });
  on(root, 'click', '[data-d]', (e, b) => { dist = Number(b.dataset.d); paint(); });
  // Pick somebody (again to put them away), or "Just me".
  on(root, 'click', '[data-with]', (e, b) => { const u = b.dataset.with; pickWith(u && u === other ? '' : u); });
}
