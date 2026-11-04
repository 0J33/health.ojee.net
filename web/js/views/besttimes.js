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

const ALL = ['run', 'ride', 'walk'];
const LABELS = { 400: '400 m', 500: '500 m', 1000: '1 km', 1609: '1 mile', 2000: '2 km', 5000: '5 km', 10000: '10 km', 15000: '15 km', 20000: '20 km', 21097: 'Half marathon', 40000: '40 km', 42195: 'Marathon', 100000: '100 km' };
const labelOf = (m) => LABELS[m] || `${f.dec1(m / 1000)} km`;

export default async function best(ctx) {
  const { root } = ctx;
  document.title = 'Best times · Health';
  const top = () => head({ title: 'Best times', back: '/workouts?view=progress' });
  mount(root, html`${top()}${skeleton('page')}`);
  let d;
  let other = ctx.query?.get('with') || '';
  let them = null;     // { who, hidden, sports } of the person beside you
  const board = {};    // sport -> [{ username, displayName, avatar, accent, me, bests }]
  // Yours (and the person asked for), and everybody's in each sport, together: a sport or a
  // distance only they have done is still there to compare.
  const boards = Promise.all(ALL.map((sp) => api.get(`/api/best-times/people?sport=${sp}`).then((r) => { board[sp] = r.people || []; }, () => { board[sp] = []; })));
  try { d = await api.get(`/api/best-times${other ? `?with=${encodeURIComponent(other)}` : ''}`); } catch (err) {
    if (err.status !== 404 || !other) { if (ctx.alive()) mount(root, html`${top()}${errorState(err)}`); return; }
    other = '';
    try { d = await api.get('/api/best-times'); } catch (e2) { if (ctx.alive()) mount(root, html`${top()}${errorState(e2)}`); return; }
  }
  await boards;
  if (!ctx.alive()) return;
  them = d.them || null;
  const mine = d.sports || [];
  const othersIn = (sp) => (board[sp] || []).filter((p) => !p.me && Object.keys(p.bests).length);
  const sports = ALL.filter((sp) => mine.some((x) => x.sport === sp) || othersIn(sp).length);
  if (!sports.length) {
    mount(root, html`${top()}<div class="stack">${empty({ iconName: 'flag', title: 'No best times yet', text: 'Record a run, ride or walk with GPS (or bring one in from your watch) and its fastest 1 km, 5 km, 10 km and more show here, with every record you break.' })}</div>`);
    return;
  }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const q = ctx.query;
  const mineOf = (sp) => mine.find((x) => x.sport === sp)?.distances || [];
  const theirsOf = (sp) => (them && !them.hidden ? them.sports.find((x) => x.sport === sp)?.distances || [] : []);
  // Every distance anybody here has a time at: yours, the person beside you, everybody's.
  const distsOf = (sp) => [...new Set([...mineOf(sp).map((x) => x.m), ...theirsOf(sp).map((x) => x.m), ...(board[sp] || []).flatMap((p) => Object.keys(p.bests).map(Number))])].sort((a, b) => a - b);
  let sport = sports.find((x) => x === (q?.get('sport') || saved.sport)) || sports.find((x) => mineOf(x).length) || sports[0];
  // The distance asked for; else the one last looked at; else the 5 km, the classic, or the first there is.
  const pickDist = (sp, want) => { const ds = distsOf(sp); return ds.find((m) => m === want) ?? ds.find((m) => m === 5000) ?? ds[0]; };
  let dist = pickDist(sport, Number(q?.get('d') || saved.d));

  const nameOf = (p) => p?.displayName || p?.username || '';
  const first1 = (p) => nameOf(p).split(/\s+/)[0];
  /** Yours and theirs at this distance, when done. */
  const myDist = () => mineOf(sport).find((y) => y.m === dist) || null;
  const theirDist = () => theirsOf(sport).find((y) => y.m === dist) || null;

  /** Who you can compare with at this distance, and everybody's time there, fastest first. */
  function compareBlock() {
    const people = board[sport] || [];
    const others = people.filter((p) => !p.me);
    if (!others.length) {
      return html`<section class="bst-cmp" data-cmp><p class="bst-cmp__none">${ic('users', { size: 's' })}<span>Nobody to compare with yet. Friends who share their workouts with you, and you with them, show here with their times.</span></p></section>`;
    }
    const ranked = people.filter((p) => Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist]);
    return html`<section class="bst-cmp" data-cmp>
      <div class="bsec"><h2>Compare with</h2>${other ? html`<button type="button" class="bst-cmp__off" data-with="">Just me</button>` : ''}</div>
      <div class="bst-pp" role="group" aria-label="Compare with">${others.map((p) => {
        const t = p.bests[dist];
        return html`<button type="button" class="bst-p press" data-with="${p.username}" aria-pressed="${String(p.username === other)}">
          ${avatar(p)}<span class="bst-p__n">${first1(p)}</span><b class="bst-p__t n">${Number.isFinite(t) ? clockTime(t) : html`<small>No ${labelOf(dist)}</small>`}</b></button>`;
      })}</div>
      ${ranked.length > 1 || (ranked.length === 1 && !ranked[0].me) ? html`<ol class="bst-board">${ranked.map((p) => html`<li class="${p.me ? 'is-me' : ''} ${p.username === other ? 'is-them' : ''}">
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
    if (!t) return html`<p class="bst-vs bst-vs--none">${avatar(them.who)}<span>${n} has no ${labelOf(dist)} yet.</span></p>`;
    if (!x) return html`<div class="bst-vs"><span class="bst-vs__p"><small>You</small><b class="n">${f.DASH}</b></span><span class="bst-vs__g">Your first sets it</span><span class="bst-vs__p bst-vs__p--them">${avatar(them.who)}<small>${n}</small><b class="n">${clockTime(t.best.timeS)}</b></span></div>`;
    const gap = t.best.timeS - x.best.timeS;
    return html`<div class="bst-vs">
      <span class="bst-vs__p"><small>You</small><b class="n">${clockTime(x.best.timeS)}</b></span>
      <span class="bst-vs__g ${gap > 0 ? 'is-ahead' : gap < 0 ? 'is-behind' : ''}">${gap === 0 ? 'Level' : `${clockTime(Math.abs(gap))} ${gap > 0 ? 'faster' : 'slower'}`}</span>
      <span class="bst-vs__p bst-vs__p--them">${avatar(them.who)}<small>${n}</small><b class="n">${clockTime(t.best.timeS)}</b></span>
    </div>`;
  }

  async function pickWith(username) {
    other = username;
    if (!other) { them = null; paint(); return; }
    try {
      const r = await api.get(`/api/best-times?with=${encodeURIComponent(other)}`);
      if (!ctx.alive() || other !== username) return;
      them = r.them || null;
    } catch { them = null; other = ''; }
    // Their distances join the chips; stay on this one when it is still there.
    dist = pickDist(sport, dist);
    paint();
  }

  /** The hero when the distance is yours: your record, its pace and when, and the chart. */
  function heroMine(x, t) {
    const b = x.best;
    const first = x.records[0];
    const took = first && b !== first ? first.timeS - b.timeS : 0;
    return html`<p class="bst-hero__k">${ic(SPORT[sport][1], { size: 's' })}Fastest ${x.label.toLowerCase().startsWith('half') || x.label === 'Marathon' ? x.label.toLowerCase() : x.label}</p>
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
      <p class="bst-hero__note">Higher is faster. The line is your record; each dot on it is a time you beat it.${t ? ` The dashed line is ${first1(them.who)}'s.` : ''}</p>`;
  }

  /** The hero when you have no time at the distance: theirs, when somebody is beside you. */
  function heroNone(t) {
    const label = labelOf(dist);
    return html`<p class="bst-hero__k">${ic(SPORT[sport][1], { size: 's' })}Fastest ${label}</p>
      <p class="bst-hero__v bst-hero__v--none">No ${label} yet</p>
      <p class="bst-hero__s">${t ? `Your first ${SPORT[sport][0].toLowerCase()} of ${label} or more with GPS sets your time against ${first1(them.who)}'s.` : `Others here have one: pick somebody below to see their record, or record a ${SPORT[sport][0].toLowerCase()} of ${label} or more with GPS.`}</p>
      ${versus(null)}
      ${t ? html`${chart((w) => bestChart({ w, efforts: [], records: [], until: Date.now(), them: { name: first1(them.who), records: t.records }, label: `${nameOf(them.who)}'s ${label} record: ${clockTime(t.best.timeS)}, falling ${t.records.length - 1} times.` }), { cls: 'bst-chart' })}
        <p class="bst-hero__note">Higher is faster. The dashed line is ${first1(them.who)}'s record.</p>` : ''}`;
  }

  function paint() {
    const ds = distsOf(sport);
    if (!ds.includes(dist)) dist = pickDist(sport, dist);
    const x = myDist();
    const t = theirDist();
    try { localStorage.setItem(KEY, JSON.stringify({ sport, d: dist })); } catch { /* fine */ }
    history.replaceState(history.state, '', `/workouts/best?sport=${sport}&d=${dist}${other ? `&with=${encodeURIComponent(other)}` : ''}`);
    const recs = x ? [...x.records].reverse() : [];
    mount(root, html`${top()}
      <div class="stack bst-pg">
        ${sports.length > 1 ? html`<div class="bst-sw">${seg('btsport', sports.map((sp) => [sp, SPORT[sp][0]]), sport, { label: 'Sport', fit: true })}</div>` : ''}
        <div class="bst-ds" role="group" aria-label="Distance">${ds.map((m) => { const y = mineOf(sport).find((z) => z.m === m); return html`<button type="button" class="bst-d press" data-d="${m}" aria-pressed="${String(m === dist)}"><span>${labelOf(m)}</span><b class="n">${y ? clockTime(y.best.timeS) : f.DASH}</b></button>`; })}</div>
        <section class="bst-hero">${x ? heroMine(x, t) : heroNone(t)}</section>
        ${compareBlock()}
        ${recs.length ? html`<div class="bsec"><h2>Each record</h2><span class="hs-s">newest first</span></div>
        <ol class="bst-recs">${recs.map((r, i) => html`<li><a class="bst-rec press" href="/workouts/${encodeURIComponent(r.id)}">
          <span class="bst-rec__dot ${i === 0 ? 'is-now' : ''}" aria-hidden="true">${i === 0 ? ic('record', { size: 's' }) : ''}</span>
          <span class="bst-rec__b"><span class="bst-rec__t">${f.dayRel(dayOf(r.at))}${r.title ? html` <small>· ${r.title}</small>` : ''}</span><span class="bst-rec__s">${rate(sport, x.m, r.timeS)}${r.whole ? ' · the whole run' : ''}</span></span>
          <span class="bst-rec__v"><b class="n">${clockTime(r.timeS)}</b><small class="${r.prevS ? 'is-up' : ''}">${r.prevS ? `−${clockTime(r.prevS - r.timeS)}` : 'First'}</small></span>
          ${ic('chev_r', { size: 's' })}
        </a></li>`)}</ol>` : ''}
        <p class="muted small bst-foot">The fastest stretch of each run, ride or walk with a GPS track, measured on the watch's own distance where it sends one (as its laps and Strava are), as your medals count it; a session without one counts when it was about the distance. A time can only be a record against an earlier one.</p>
      </div>`);
  }
  paint();
  on(root, 'click', '[data-seg="btsport"]', (e, b) => { sport = b.dataset.value; dist = pickDist(sport, dist); paint(); });
  on(root, 'click', '[data-d]', (e, b) => { dist = Number(b.dataset.d); paint(); });
  // Pick somebody (again to put them away), or "Just me".
  on(root, 'click', '[data-with]', (e, b) => { const u = b.dataset.with; pickWith(u && u === other ? '' : u); });
}
