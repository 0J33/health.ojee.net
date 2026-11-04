/* Best times: your fastest at each standard distance, and other people's beside them.

   Two levels, as best efforts are everywhere else:

   /workouts/best — the overview. One row of filters says what is counted: run & walk (a
     5 km on foot is a 5 km, whichever it was), runs only, walks only, rides. Then every
     distance as a table with two columns under named heads: you, and either the person you
     compare with (picked once, at the top) or whoever is fastest here. The faster time of
     the two is marked, with by how much. A row opens the distance.
   /workouts/best/:filter/:m — one distance. The same filters and the distances along the
     top; your record (the session it came from opens), you against the person picked, the
     chart of every effort with their record line beside yours, the ranking of everybody at
     that distance (tap somebody to compare with them instead), and each time it fell.

   You are always in the colour and the other person in grey, as on the chart's lines.
   Who you compare with lives in the address (?with=), so back and forward keep it and a
   link carries it; nothing is remembered behind your back. The filter last used is.

   From GET /api/best-times (server/medals.js bestTimes: the fastest stretch of each GPS
   track, on the watch's own distance when it sends one, or a whole session of about the
   distance) and GET /api/best-times/people (server/besttimes.js: only people who share
   their workouts with you while you share yours with them, and only their times). */

import { api } from '../api.js';
import { app, go } from '../app.js';
import { html, mount, head, skeleton, errorState, on, chart, empty, ic, banner, sheet } from '../ui.js';
import * as f from '../format.js';
import { bestTimes as bestChart, clockTime } from '../viz.js';
import { avatar } from './shared.js';

/* The filters: what a time is counted under. [chip label, icon, in a sentence, in a title]. */
const SPORT = {
  foot: ['Run & walk', 'footprint', 'run or walk', 'on foot'],
  run: ['Runs', 'run', 'run', 'run'],
  walk: ['Walks', 'walk', 'walk', 'walk'],
  ride: ['Rides', 'bike', 'ride', 'ride'],
};
const ALL = ['foot', 'run', 'walk', 'ride'];
const RAW = ['run', 'walk', 'ride'];
const KEY = 'health.best.sport';
// As races name them: the same words whatever the units.
const LABELS = { 400: '400 m', 805: '½ mile', 1000: '1K', 1609: '1 mile', 3219: '2 miles', 5000: '5K', 10000: '10K', 15000: '15K', 16093: '10 miles', 20000: '20K', 21097: 'Half marathon', 30000: '30K', 40000: '40K', 42195: 'Marathon', 100000: '100K' };
const SHORT = { 21097: 'Half', 42195: 'Marathon' };
const labelOf = (m) => LABELS[m] || `${f.dec1(m / 1000)} km`;
/** "5 km", "half marathon": as it reads inside a sentence. */
const inText = (m) => (m === 21097 || m === 42195 ? labelOf(m).toLowerCase() : labelOf(m));

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
/** Pace per km (or mile) on foot, speed for rides. */
function rate(sport, m, s) {
  if (sport === 'ride') { const kmh = (m / 1000) / (s / 3600); return `${f.dec1(f.distUnit() === 'mi' ? kmh / 1.609344 : kmh)} ${f.distUnit() === 'mi' ? 'mph' : 'km/h'}`; }
  const per = s / (m / 1000) * (f.distUnit() === 'mi' ? 1.609344 : 1);
  return `${clockTime(per)} /${f.distUnit()}`;
}
const nameOf = (p) => p?.displayName || p?.username || '';
const first1 = (p) => nameOf(p).split(/\s+/)[0];
const KIND = { run: 'Run', walk: 'Walk' };

/** The server's times, under every filter: runs, walks and rides as they came (each effort
    kept with what it was), and run & walk as one, its records worked out again across both. */
function bySport(sports) {
  const out = {};
  for (const s of sports || []) {
    const tag = (e) => e && { ...e, kind: s.sport };
    out[s.sport] = s.distances.map((d) => ({ ...d, efforts: d.efforts.map(tag), records: d.records.map(tag), best: tag(d.best) }));
  }
  const by = new Map();
  for (const kind of ['run', 'walk']) {
    for (const d of out[kind] || []) {
      const e = by.get(d.m) || { m: d.m, label: d.label, efforts: [] };
      e.efforts.push(...d.efforts);
      by.set(d.m, e);
    }
  }
  if (by.size) {
    out.foot = [...by.values()].sort((a, b) => a.m - b.m).map((d) => {
      d.efforts.sort((a, b) => a.at - b.at);
      const records = [];
      for (const e of d.efforts) { const prev = records.at(-1); if (!prev || e.timeS < prev.timeS) records.push({ ...e, prevS: prev ? prev.timeS : null }); }
      return { ...d, records, best: records.at(-1) };
    });
  }
  return out;
}
/** Everybody's best on foot: the faster of their run and their walk at each distance, and which. */
function footBoard(run = [], walk = []) {
  const by = new Map();
  for (const [kind, list] of [['run', run], ['walk', walk]]) {
    for (const p of list) {
      const e = by.get(p.username) || { ...p, bests: {}, kinds: {} };
      for (const [m, t] of Object.entries(p.bests)) if (!Number.isFinite(e.bests[m]) || t < e.bests[m]) { e.bests[m] = t; e.kinds[m] = kind; }
      by.set(p.username, e);
    }
  }
  return [...by.values()];
}

export default async function best(ctx) {
  const { root } = ctx;
  const q = ctx.query;
  const detail = ctx.name === 'distance';
  // An old address for one distance (?sport=&d=): its own page now.
  if (!detail && q?.get('d') && q.get('sport')) {
    go(`/workouts/best/${encodeURIComponent(q.get('sport'))}/${encodeURIComponent(q.get('d'))}${q.get('with') ? `?with=${encodeURIComponent(q.get('with'))}` : ''}`, { replace: true });
    return;
  }
  document.title = 'Best times · Health';
  mount(root, html`${head({ title: 'Best times', back: detail ? '/workouts/best' : '/workouts?view=progress' })}${skeleton('page')}`);

  const other = q?.get('with') || '';
  const board = {};    // filter -> [{ username, displayName, avatar, accent, me, bests, kinds? }]
  const boards = Promise.all(RAW.map((sp) => api.get(`/api/best-times/people?sport=${sp}`).then((r) => { board[sp] = r.people || []; }, () => { board[sp] = []; })));
  let d;
  try { d = await api.get(`/api/best-times${other ? `?with=${encodeURIComponent(other)}` : ''}`); } catch (err) {
    if (err.status === 404 && other) { go(ctx.path, { replace: true }); return; }   // nobody of that name: without them
    if (ctx.alive()) mount(root, html`${head({ title: 'Best times', back: '/workouts?view=progress' })}${errorState(err)}`);
    return;
  }
  await boards;
  if (!ctx.alive()) return;
  const them = d.them || null;   // { who, hidden, sports }
  const mineBy = bySport(d.sports);
  const theirBy = them && !them.hidden ? bySport(them.sports) : {};
  for (const sp of RAW) for (const p of board[sp]) p.kinds = Object.fromEntries(Object.keys(p.bests).map((m) => [m, sp]));
  board.foot = footBoard(board.run, board.walk);
  const me = app.me?.profile || { displayName: 'You', username: 'you' };

  const mineOf = (sp) => mineBy[sp] || [];
  const theirsOf = (sp) => theirBy[sp] || [];
  const othersOf = (sp) => (board[sp] || []).filter((p) => !p.me);
  const anyIn = (sp) => mineOf(sp).length || theirsOf(sp).length || othersOf(sp).some((p) => Object.keys(p.bests).length);
  // Every distance anybody here has a time at: yours, theirs, everybody's.
  // In your own units: miles bring the half mile, 2 and 10 miles; kilometres the 1K, 15K, 20K and 30K.
  const distsOf = (sp) => [...new Set([...mineOf(sp).map((x) => x.m), ...theirsOf(sp).map((x) => x.m), ...othersOf(sp).flatMap((p) => Object.keys(p.bests).map(Number))])]
    .filter((m) => f.effortShown(m, { ride: sp === 'ride' })).sort((a, b) => a - b);
  // The filters there are: each with a time in it (yours, theirs or anybody's here); run & walk
  // only when there are both, as with only one it is that one again.
  const sports = ALL.filter((sp) => (sp === 'foot' ? anyIn('run') && anyIn('walk') : anyIn(sp)));
  // Everybody you could compare with, and how many times each has.
  const people = (() => {
    const by = new Map();
    for (const sp of RAW) for (const p of othersOf(sp)) {
      const n = Object.keys(p.bests).length;
      if (!n) continue;
      const e = by.get(p.username) || { ...p, counts: {} };
      e.counts[sp] = n; by.set(p.username, e);
    }
    return [...by.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  })();
  const withQ = (name = other) => (name ? `?with=${encodeURIComponent(name)}` : '');
  const comparing = Boolean(them && !them.hidden);

  if (!sports.length) {
    mount(root, html`${head({ title: 'Best times', back: '/workouts?view=progress' })}<div class="stack">${empty({ iconName: 'flag', title: 'No best times yet', text: 'Record a run, ride or walk with GPS (or bring one in from your watch) and its fastest 1 km, 5 km, 10 km and more show here, with every record you break.' })}</div>`);
    return;
  }

  /** The filters, as a row of chips: what the times count. */
  function filters(sport, hrefOf) {
    if (sports.length < 2) return '';
    return html`<nav class="btf" aria-label="Count">${sports.map((sp) => html`<a class="btf__c press" href="${hrefOf(sp)}" data-replace aria-current="${sp === sport ? 'page' : 'false'}">${ic(SPORT[sp][1], { size: 's' })}<span>${SPORT[sp][0]}</span></a>`)}</nav>`;
  }

  /** Pick who to compare with, from a sheet: everybody who has times, and nobody. */
  function pickPerson(onPick) {
    const s = sheet({
      title: 'Compare with',
      body: html`<p class="bto-pick__note">People who share their workouts with you, and you yours with them.</p>
        <ul class="bto-pick">${people.map((p) => html`<li><button type="button" class="bto-pick__r press" data-pick="${p.username}" aria-pressed="${String(p.username === other)}">
          ${avatar(p)}<span class="bto-pick__b"><span class="bto-pick__n">${nameOf(p)}</span><small>${RAW.filter((sp) => p.counts[sp]).map((sp) => `${p.counts[sp]} ${SPORT[sp][2]} ${p.counts[sp] === 1 ? 'time' : 'times'}`).join(' · ')}</small></span>
          ${p.username === other ? ic('check', { size: 's' }) : ''}
        </button></li>`)}</ul>
        ${other ? html`<button type="button" class="btn btn--tonal bto-pick__off" data-pick="">Stop comparing</button>` : ''}`,
    });
    s.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      s.close();
      onPick(b.dataset.pick);
    });
  }

  /** The bar at the top: who you compare with, or the way to pick somebody. */
  function compareBar() {
    if (!people.length) return '';
    if (them) {
      return html`<div class="bto-cmp is-on">
        ${avatar(them.who)}<span class="bto-cmp__t">Comparing with <b>${nameOf(them.who)}</b></span>
        <button type="button" class="bto-cmp__b" data-cmp-pick>Change</button>
        <button type="button" class="bto-cmp__x" data-cmp-off aria-label="Stop comparing">${ic('x', { size: 's' })}</button>
      </div>`;
    }
    return html`<button type="button" class="bto-cmp press" data-cmp-pick>
      <span class="bto-cmp__faces">${people.slice(0, 3).map((p) => avatar(p))}</span>
      <span class="bto-cmp__t">Compare with someone</span>${ic('right', { size: 's' })}
    </button>`;
  }
  const hiddenNote = () => (them?.hidden ? banner({
    tone: 'warn', iconName: 'lock',
    title: them.hidden === 'yours' ? `Share your workouts with ${first1(them.who)} to compare` : `${first1(them.who)} does not share workouts with you`,
    text: them.hidden === 'yours' ? 'Comparing is fair both ways: their times show while yours show to them.' : 'Their best times show here when they share their workouts with you.',
    actions: them.hidden === 'yours' ? html`<a class="btn btn--s btn--tonal" href="/settings/privacy">Privacy</a>` : '',
  }) : '');

  // Moving between filters and distances, or picking somebody, replaces the page rather than stacking up.
  on(root, 'click', 'a[data-replace], .bt2-rk__r[href]', (e, a) => { e.preventDefault(); e.stopPropagation(); go(a.getAttribute('href'), { replace: true }); });

  /* ════ the overview ════ */

  if (!detail) {
    let saved = '';
    try { saved = localStorage.getItem(KEY) || ''; } catch { /* fine */ }
    const sport = sports.find((x) => x === q?.get('sport')) || sports.find((x) => x === saved) || sports[0];
    try { localStorage.setItem(KEY, sport); } catch { /* fine */ }
    const kd = (e) => (sport === 'foot' && KIND[e?.kind] ? KIND[e.kind] : '');
    const here = (sp, name = other) => `/workouts/best?sport=${sp}${name ? `&with=${encodeURIComponent(name)}` : ''}`;

    /** A cell: a time, and under it what it was or by how much it is the faster. */
    const cell = (who, time, sub, { win = false, none = '' } = {}) => html`<span class="bto-c bto-c--${who} ${win ? 'is-win' : ''}">
      ${Number.isFinite(time) ? html`<b class="n">${clockTime(time)}</b>` : html`<b class="is-none">${f.DASH}</b>`}
      <small>${Number.isFinite(time) ? sub : none}</small>
    </span>`;

    function rows() {
      return distsOf(sport).map((m) => {
        const x = mineOf(sport).find((y) => y.m === m);
        const mt = x?.best.timeS;
        let mineSub = x ? [kd(x.best), f.dayRel(dayOf(x.best.at))].filter(Boolean).join(' · ') : '';
        let right;
        if (comparing) {
          const t = theirsOf(sport).find((y) => y.m === m);
          const tt = t?.best.timeS;
          const both = Number.isFinite(mt) && Number.isFinite(tt);
          const gap = both ? tt - mt : null;
          if (both && gap > 0) mineSub = html`<span class="bto-up">${ic('up', { size: 's' })}${clockTime(gap)} faster</span>`;
          if (both && gap === 0) mineSub = 'Level';
          right = cell('them', tt, both && gap < 0 ? html`<span class="bto-up">${ic('up', { size: 's' })}${clockTime(-gap)} faster</span>` : kd(t?.best) || (t ? f.dayRel(dayOf(t.best.at)) : ''), { win: both && gap < 0, none: 'No time yet' });
          return { m, mine: cell('me', mt, mineSub, { win: both && gap > 0, none: 'No time yet' }), right };
        }
        // Not comparing: whoever is fastest here, when it is not you.
        const ranked = (board[sport] || []).filter((p) => Number.isFinite(p.bests[m])).sort((a, b) => a.bests[m] - b.bests[m]);
        const lead = ranked.find((p) => !p.me);
        const meFirst = ranked[0]?.me;
        if (meFirst) right = html`<span class="bto-c bto-c--them is-you"><small>${ranked.length > 1 ? html`${ic('up', { size: 's' })}You're fastest` : 'Only you so far'}</small></span>`;
        else if (lead) right = html`<span class="bto-c bto-c--them bto-c--lead">${avatar(lead)}<span><b class="n">${clockTime(lead.bests[m])}</b><small>${first1(lead)}${sport === 'foot' && lead.kinds?.[m] ? ` · ${KIND[lead.kinds[m]]}` : ''}</small></span></span>`;
        else right = html`<span class="bto-c bto-c--them"><b class="is-none">${f.DASH}</b></span>`;
        return { m, mine: cell('me', mt, mineSub, { none: 'No time yet' }), right };
      }).map((r) => html`<li><a class="bto-r press" href="/workouts/best/${sport}/${r.m}${withQ()}">
        <span class="bto-r__d">${SHORT[r.m] || labelOf(r.m)}</span>${r.mine}${r.right}${ic('right', { size: 's' })}
      </a></li>`);
    }

    /** Comparing: how it stands across the distances you have both done. */
    function tally() {
      if (!comparing) return '';
      let ahead = 0; let both = 0;
      for (const x of mineOf(sport)) { const t = theirsOf(sport).find((y) => y.m === x.m); if (t) { both += 1; if (x.best.timeS <= t.best.timeS) ahead += 1; } }
      const n = first1(them.who);
      return html`<p class="bto-tally">${both ? html`You're faster than ${n} at <b>${ahead}</b> of <b>${both}</b> ${both === 1 ? 'distance' : 'distances'} you've both done.` : `No distances you've both done yet: each is the other's to set.`}</p>`;
    }

    history.replaceState(history.state, '', here(sport));
    mount(root, html`${head({ title: 'Best times', back: '/workouts?view=progress' })}
      <div class="bto">
        ${filters(sport, (sp) => here(sp))}
        ${compareBar()}
        ${hiddenNote()}
        ${tally()}
        <div class="bto-t" role="table" aria-label="${SPORT[sport][0]}: your best times${comparing ? ` and ${nameOf(them.who)}'s` : ''}">
          <div class="bto-hd" role="row">
            <span role="columnheader">Distance</span>
            <span class="bto-hd__c bto-hd__c--me" role="columnheader">${avatar(me)}<span>You</span></span>
            <span class="bto-hd__c bto-hd__c--them" role="columnheader">${comparing ? html`${avatar(them.who)}<span>${first1(them.who)}</span>` : html`<span>Fastest here</span>`}</span>
            <span></span>
          </div>
          <ol class="bto-list">${rows()}</ol>
        </div>
        <p class="bt2-foot">The fastest stretch of any ${SPORT[sport][2]} with GPS, on the watch's own distance as its laps and Strava measure it; a session without GPS counts when it was about the distance.</p>
      </div>`);
    on(root, 'click', '[data-cmp-pick]', () => pickPerson((u) => go(here(sport, u), { replace: true })));
    on(root, 'click', '[data-cmp-off]', () => go(here(sport, ''), { replace: true }));
    return;
  }

  /* ════ one distance ════ */

  const sport = ALL.includes(ctx.params.sport) ? ctx.params.sport : 'foot';
  const dist = Number(ctx.params.m);
  const ds = distsOf(sport);
  const kd = (e) => (sport === 'foot' && KIND[e?.kind] ? KIND[e.kind].toLowerCase() : '');
  const overview = `/workouts/best?sport=${sport}${other ? `&with=${encodeURIComponent(other)}` : ''}`;
  const title = dist === 21097 || dist === 42195 ? `${labelOf(dist)}${sport === 'ride' ? ' ride' : ''}` : `${labelOf(dist)} ${SPORT[sport][3]}`;
  document.title = `${title} · Best times · Health`;
  const top = () => head({ title, back: overview });
  const here = (m, name = other, sp = sport) => `/workouts/best/${sp}/${m}${withQ(name)}`;
  // Another filter keeps the distance when it has it, else its first.
  const filterHref = (sp) => here(distsOf(sp).includes(dist) ? dist : distsOf(sp)[0], other, sp);
  if (!ds.includes(dist)) {
    mount(root, html`${top()}<div class="stack">${filters(sport, filterHref)}${empty({ iconName: 'flag', title: `No ${inText(dist)} times here`, text: 'Nobody here has a time at this distance yet.', action: html`<a class="btn btn--tonal" href="${overview}">All distances</a>` })}</div>`);
    return;
  }
  const x = mineOf(sport).find((y) => y.m === dist) || null;
  const t = theirsOf(sport).find((y) => y.m === dist) || null;

  function versus() {
    const n = first1(them.who);
    const gap = x && t ? t.best.timeS - x.best.timeS : null;
    const word = !t ? `No ${inText(dist)} for ${n}` : !x ? 'Yours to set' : gap === 0 ? 'Level' : `${clockTime(Math.abs(gap))} ${gap > 0 ? 'faster' : 'slower'}`;
    return html`<div class="bt2-vs">
      <span class="bt2-vs__p"><small>${avatar(me)}<span>You${kd(x?.best) ? `, a ${kd(x.best)}` : ''}</span></small><b class="n">${x ? clockTime(x.best.timeS) : f.DASH}</b></span>
      <span class="bt2-vs__g ${gap > 0 ? 'is-ahead' : gap < 0 ? 'is-behind' : ''}">${word}</span>
      <span class="bt2-vs__p bt2-vs__p--them"><small>${avatar(them.who)}<span>${n}${kd(t?.best) ? `, a ${kd(t.best)}` : ''}</span></small><b class="n">${t ? clockTime(t.best.timeS) : f.DASH}</b></span>
    </div>`;
  }

  function hero() {
    const kick = html`<p class="bt2-k">${ic(SPORT[sport][1], { size: 's' })}<span>Your fastest ${inText(dist)} ${SPORT[sport][3]}</span></p>`;
    const vs = comparing ? versus() : '';
    const theirLine = t ? { name: first1(them.who), records: t.records } : null;
    if (!x) {
      const lead = othersOf(sport).filter((p) => Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist])[0];
      return html`<section class="bt2-card bt2-hero">
        ${kick}
        <p class="bt2-none">No time yet</p>
        <p class="bt2-s">A ${SPORT[sport][2]} of ${inText(dist)} or more with GPS sets it.${!t && lead ? ` The fastest here is ${first1(lead)}'s ${clockTime(lead.bests[dist])}${sport === 'foot' && lead.kinds?.[dist] ? `, a ${lead.kinds[dist]}` : ''}.` : ''}</p>
        ${hiddenNote()}${vs}
        ${t ? html`${chart((w) => bestChart({ w, efforts: [], records: [], until: Date.now(), them: theirLine, label: `${nameOf(them.who)}'s ${labelOf(dist)} record: ${clockTime(t.best.timeS)}.` }), { cls: 'bt2-chart' })}
          <p class="bt2-note">Higher is faster. The dashed line is ${first1(them.who)}'s record.</p>` : ''}
      </section>`;
    }
    const b = x.best;
    const first = x.records[0];
    const took = first && b !== first ? first.timeS - b.timeS : 0;
    const fell = x.records.length - 1;
    const showChart = x.efforts.length > 1 || t;
    return html`<section class="bt2-card bt2-hero">
      ${kick}
      <div class="bt2-big"><p class="bt2-v n">${clockTime(b.timeS)}</p><p class="bt2-pace">${rate(sport, x.m, b.timeS)}</p></div>
      <a class="bt2-from press" href="/workouts/${encodeURIComponent(b.id)}">
        <span>${kd(b) ? `A ${kd(b)}, ` : ''}${f.dayRel(dayOf(b.at))}${b.title ? html` · ${b.title}` : ''}${b.whole ? ' · the whole session' : ''}</span>${ic('right', { size: 's' })}
      </a>
      ${x.efforts.length > 1 ? html`<p class="bt2-facts">
        <span><b class="n">${f.int(x.efforts.length)}</b> efforts</span>
        <span>${fell ? html`broken <b class="n">${f.int(fell)}</b> ${fell === 1 ? 'time' : 'times'}` : 'your first still stands'}</span>
        ${took ? html`<span><b class="n">${clockTime(took)}</b> off your first</span>` : ''}
      </p>` : ''}
      ${hiddenNote()}${vs}
      ${showChart ? html`${chart((w) => bestChart({ w, efforts: x.efforts, records: x.records, until: Date.now(), go: (i) => `/workouts/${encodeURIComponent(x.efforts[i].id)}`, them: theirLine,
          label: `Your ${labelOf(dist)} times: ${x.efforts.length} efforts, the record falling ${fell} times to ${clockTime(b.timeS)}.${t ? ` ${nameOf(them.who)}'s record: ${clockTime(t.best.timeS)}.` : ''}` }), { cls: 'bt2-chart' })}
        <p class="bt2-note">Higher is faster. <span class="bt2-key bt2-key--me"></span>Your record${t ? html`, <span class="bt2-key bt2-key--them"></span>${first1(them.who)}'s` : ''}.</p>` : ''}
    </section>`;
  }

  function ranking() {
    const all = board[sport] || [];
    const ranked = all.filter((p) => Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist]);
    const others = othersOf(sport);
    const heading = html`<header class="bt2-rk__h"><h2>Ranking</h2></header>`;
    if (!others.length) {
      return html`<section class="bt2-card bt2-rk">${heading}<p class="bt2-rk__none">${ic('users', { size: 's' })}<span>Nobody to compare with yet. Friends who share their workouts with you, and you yours with them, show here with their times.</span></p></section>`;
    }
    const fastest = ranked[0]?.bests[dist];
    const tied = ranked.filter((p) => p.bests[dist] === fastest).length > 1;
    const meIn = ranked.some((p) => p.me);
    const without = others.filter((p) => !Number.isFinite(p.bests[dist]));
    const row = (p) => {
      const v = p.bests[dist];
      const rank = ranked.findIndex((o) => o.bests[dist] === v) + 1;
      const gap = v === fastest ? (tied ? 'Level' : 'Fastest') : `+${clockTime(v - fastest)}`;
      const on = p.username === other;
      const kind = sport === 'foot' && p.kinds?.[dist] ? html`<small>${p.kinds[dist]}</small>` : '';
      const body = html`<span class="bt2-rk__i n">${rank}</span>${avatar(p)}<span class="bt2-rk__n">${p.me ? 'You' : nameOf(p)}${kind}</span><span class="bt2-rk__g">${on ? html`<span class="bt2-rk__on">${ic('check', { size: 's' })}Comparing</span>` : gap}</span><b class="bt2-rk__t n">${clockTime(v)}</b>`;
      if (p.me) return html`<li class="is-me"><div class="bt2-rk__r">${body}</div></li>`;
      return html`<li class="${on ? 'is-on' : ''}"><a class="bt2-rk__r press" href="${here(dist, on ? '' : p.username)}" aria-label="${on ? 'Stop comparing with' : 'Compare with'} ${nameOf(p)}, ${clockTime(v)}">${body}</a></li>`;
    };
    return html`<section class="bt2-card bt2-rk">
      ${heading}
      <ol class="bt2-rk__l">${ranked.map(row)}${meIn ? '' : html`<li class="is-me is-out"><div class="bt2-rk__r"><span class="bt2-rk__i"></span>${avatar(me)}<span class="bt2-rk__n">You</span><span class="bt2-rk__g">No time yet</span><b class="bt2-rk__t">${f.DASH}</b></div></li>`}</ol>
      ${without.length ? html`<p class="bt2-rk__more">No ${inText(dist)} yet: ${without.map(nameOf).join(', ')}</p>` : ''}
      <p class="bt2-rk__tip">Tap somebody to compare with them${other ? ', again to stop' : ''}.</p>
    </section>`;
  }

  function fellList() {
    if (!x || x.records.length < 2) return '';
    return html`<section class="bt2-hist">
      <h2 class="bt2-h">Each time you broke it</h2>
      <ol class="bt2-recs">${[...x.records].reverse().map((r, i) => html`<li><a class="bt2-rec press" href="/workouts/${encodeURIComponent(r.id)}">
        <span class="bt2-rec__dot ${i === 0 ? 'is-now' : ''}" aria-hidden="true">${i === 0 ? ic('record', { size: 's' }) : ''}</span>
        <span class="bt2-rec__b"><span class="bt2-rec__t">${f.dayRel(dayOf(r.at))}${r.title ? html` <small>· ${r.title}</small>` : ''}</span><span class="bt2-rec__s">${rate(sport, x.m, r.timeS)}${kd(r) ? ` · ${kd(r)}` : ''}${r.whole ? ' · the whole session' : ''}</span></span>
        <span class="bt2-rec__v"><b class="n">${clockTime(r.timeS)}</b><small class="${r.prevS ? 'is-up' : ''}">${r.prevS ? `−${clockTime(r.prevS - r.timeS)}` : 'First'}</small></span>
      </a></li>`)}</ol>
    </section>`;
  }

  // The filter's distances, to move between them.
  const chips = ds.length > 1 ? html`<nav class="bt2-ds" aria-label="Distances">${ds.map((m) => {
    const y = mineOf(sport).find((z) => z.m === m);
    return html`<a class="bt2-d press ${y ? '' : 'is-none'}" href="${here(m)}" data-replace aria-current="${m === dist ? 'page' : 'false'}"><span>${SHORT[m] || labelOf(m)}</span><b class="n">${y ? clockTime(y.best.timeS) : f.DASH}</b></a>`;
  })}</nav>` : '';

  mount(root, html`${top()}
    <div class="bt2">
      <div class="bt2-ctl">${filters(sport, filterHref)}${chips}${compareBar()}</div>
      <div class="bt2-main">${hero()}${fellList()}</div>
      <aside class="bt2-side">${ranking()}</aside>
    </div>`);
  // The chosen filter and distance in view, scrolling only when they are out of sight.
  for (const row of root.querySelectorAll('.bt2-ds, .btf')) {
    const cur = row.querySelector('[aria-current="page"]');
    if (!cur) continue;
    const r = cur.offsetLeft - row.offsetLeft + cur.offsetWidth;
    if (r > row.clientWidth - 8) row.scrollLeft = r - row.clientWidth + 24;
  }
  on(root, 'click', '[data-cmp-pick]', () => pickPerson((u) => go(here(dist, u), { replace: true })));
  on(root, 'click', '[data-cmp-off]', () => go(here(dist, ''), { replace: true }));
}
