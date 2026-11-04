/* Best times: your fastest at each standard distance, and other people's beside them.

   Two levels, as best efforts are everywhere else:

   /workouts/best — the overview. The sport, then every distance in it as one list: your
     time, its pace and when. Pick somebody once at the top ("Compare with…") and every row
     gains their time and who is ahead; with nobody picked, a row says who is fastest here
     when it is not you. A row opens the distance.
   /workouts/best/:sport/:m — one distance. Your record (the session it came from opens),
     you against the person picked, the chart of every effort with their record line beside
     yours, the ranking of everybody at that distance (tap somebody to compare with them
     instead), and each time your record fell. The other distances of the sport sit along
     the top to move between them.

   Who you compare with lives in the address (?with=), so back and forward keep it and a
   link carries it; nothing is remembered behind your back. The sport last looked at is.

   From GET /api/best-times (server/medals.js bestTimes: the fastest stretch of each GPS
   track, on the watch's own distance when it sends one, or a whole session of about the
   distance) and GET /api/best-times/people (server/besttimes.js: only people who share
   their workouts with you while you share yours with them, and only their times). */

import { api } from '../api.js';
import { app, go } from '../app.js';
import { html, mount, head, skeleton, errorState, on, seg, chart, empty, ic, banner, sheet } from '../ui.js';
import * as f from '../format.js';
import { bestTimes as bestChart, clockTime } from '../viz.js';
import { avatar } from './shared.js';

// Runs and walks are one sport here: a 5 km on foot is a 5 km, and the fastest of anybody's,
// run or walked, is the fastest. Each time says which it was. Rides stand apart.
const SPORT = { foot: ['On foot', 'run', 'run or walk'], ride: ['Ride', 'bike', 'ride'] };
const ALL = ['foot', 'ride'];
const RAW = ['run', 'ride', 'walk'];
/** The page's sport for one of the server's (and old links'): run and walk are on foot. */
const sportOf = (sp) => (sp === 'run' || sp === 'walk' ? 'foot' : sp);
/** "run" or "walk", for a time on foot. */
const kindOf = (e) => (e?.kind === 'walk' ? 'walk' : e?.kind === 'run' ? 'run' : '');

/** The server's run and walk times as one sport: every effort kept with what it was, the
    records worked out again across both, in the order they were set. */
function footOf(sports) {
  const out = (sports || []).filter((s) => s.sport !== 'run' && s.sport !== 'walk');
  const by = new Map();
  for (const kind of ['run', 'walk']) {
    for (const d of (sports || []).find((s) => s.sport === kind)?.distances || []) {
      const e = by.get(d.m) || { m: d.m, label: d.label, efforts: [] };
      e.efforts.push(...d.efforts.map((x) => ({ ...x, kind })));
      by.set(d.m, e);
    }
  }
  if (!by.size) return out;
  const distances = [...by.values()].sort((a, b) => a.m - b.m).map((d) => {
    d.efforts.sort((a, b) => a.at - b.at);
    const records = [];
    for (const e of d.efforts) { const prev = records.at(-1); if (!prev || e.timeS < prev.timeS) records.push({ ...e, prevS: prev ? prev.timeS : null }); }
    return { ...d, records, best: records.at(-1) };
  });
  return [{ sport: 'foot', distances }, ...out];
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
const KEY = 'health.best.sport';
const LABELS = { 400: '400 m', 500: '500 m', 1000: '1 km', 1609: '1 mile', 2000: '2 km', 5000: '5 km', 10000: '10 km', 15000: '15 km', 20000: '20 km', 21097: 'Half marathon', 40000: '40 km', 42195: 'Marathon', 100000: '100 km' };
const SHORT = { 21097: 'Half', 42195: 'Marathon' };
const labelOf = (m) => LABELS[m] || `${f.dec1(m / 1000)} km`;
/** "5 km", "half marathon": as it reads inside a sentence. */
const inText = (m) => (m === 21097 || m === 42195 ? labelOf(m).toLowerCase() : labelOf(m));

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
/** Pace per km (or mile) for runs and walks, speed for rides. */
function rate(sport, m, s) {
  if (sport === 'ride') { const kmh = (m / 1000) / (s / 3600); return `${f.dec1(f.distUnit() === 'mi' ? kmh / 1.609344 : kmh)} ${f.distUnit() === 'mi' ? 'mph' : 'km/h'}`; }
  const per = s / (m / 1000) * (f.distUnit() === 'mi' ? 1.609344 : 1);
  return `${clockTime(per)} /${f.distUnit()}`;
}
const nameOf = (p) => p?.displayName || p?.username || '';
const first1 = (p) => nameOf(p).split(/\s+/)[0];
/** Ahead or behind: `gap` is their time minus yours, in seconds. */
const gapWord = (gap) => (gap === 0 ? 'Level' : `${clockTime(Math.abs(gap))} ${gap > 0 ? 'ahead' : 'behind'}`);
const gapCls = (gap) => (gap > 0 ? 'is-ahead' : gap < 0 ? 'is-behind' : '');

export default async function best(ctx) {
  const { root } = ctx;
  const q = ctx.query;
  const detail = ctx.name === 'distance';
  // An old address for one distance (?sport=&d=, or a run or walk of its own): its page now.
  if (detail && (ctx.params.sport === 'run' || ctx.params.sport === 'walk')) {
    go(`/workouts/best/foot/${encodeURIComponent(ctx.params.m)}${q?.get('with') ? `?with=${encodeURIComponent(q.get('with'))}` : ''}`, { replace: true });
    return;
  }
  if (!detail && q?.get('d') && q.get('sport')) {
    go(`/workouts/best/${encodeURIComponent(sportOf(q.get('sport')))}/${encodeURIComponent(q.get('d'))}${q.get('with') ? `?with=${encodeURIComponent(q.get('with'))}` : ''}`, { replace: true });
    return;
  }
  document.title = 'Best times · Health';
  mount(root, html`${head({ title: 'Best times', back: detail ? '/workouts/best' : '/workouts?view=progress' })}${skeleton('page')}`);

  const other = q?.get('with') || '';
  const board = {};    // sport -> [{ username, displayName, avatar, accent, me, bests }]
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
  if (them && !them.hidden) them.sports = footOf(them.sports);
  const mine = footOf(d.sports);
  board.foot = footBoard(board.run, board.walk);

  const mineOf = (sp) => mine.find((x) => x.sport === sp)?.distances || [];
  const theirsOf = (sp) => (them && !them.hidden ? them.sports.find((x) => x.sport === sp)?.distances || [] : []);
  const othersOf = (sp) => (board[sp] || []).filter((p) => !p.me);
  // Every distance anybody here has a time at: yours, theirs, everybody's.
  const distsOf = (sp) => [...new Set([...mineOf(sp).map((x) => x.m), ...theirsOf(sp).map((x) => x.m), ...othersOf(sp).flatMap((p) => Object.keys(p.bests).map(Number))])].sort((a, b) => a - b);
  // The sports there are: yours, the person you compare with's, and (when you have none of
  // your own yet) everybody's, so there is always something to look at.
  let sports = ALL.filter((sp) => mineOf(sp).length || theirsOf(sp).length);
  if (!sports.length) sports = ALL.filter((sp) => othersOf(sp).some((p) => Object.keys(p.bests).length));
  // Everybody you could compare with, in any sport.
  const people = (() => {
    const by = new Map();
    for (const sp of ALL) for (const p of othersOf(sp)) {
      const n = Object.keys(p.bests).length;
      if (!n) continue;
      const e = by.get(p.username) || { ...p, counts: {} };
      e.counts[sp] = n; by.set(p.username, e);
    }
    return [...by.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  })();
  const withQ = (name = other) => (name ? `?with=${encodeURIComponent(name)}` : '');

  if (!sports.length) {
    mount(root, html`${head({ title: 'Best times', back: '/workouts?view=progress' })}<div class="stack">${empty({ iconName: 'flag', title: 'No best times yet', text: 'Record a run, ride or walk with GPS (or bring one in from your watch) and its fastest 1 km, 5 km, 10 km and more show here, with every record you break.' })}</div>`);
    return;
  }

  /** Pick who to compare with, from a sheet: everybody who has times, and nobody. */
  function pickPerson(onPick) {
    const s = sheet({
      title: 'Compare with',
      body: html`<p class="bto-pick__note">People who share their workouts with you, and you yours with them.</p>
        <ul class="bto-pick">${people.map((p) => html`<li><button type="button" class="bto-pick__r press" data-pick="${p.username}" aria-pressed="${String(p.username === other)}">
          ${avatar(p)}<span class="bto-pick__b"><span class="bto-pick__n">${nameOf(p)}</span><small>${ALL.filter((sp) => p.counts[sp]).map((sp) => `${SPORT[sp][0]} ${p.counts[sp]}`).join(' · ')}</small></span>
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

  /* ════ the overview ════ */

  if (!detail) {
    let saved = '';
    try { saved = localStorage.getItem(KEY) || ''; } catch { /* fine */ }
    let sport = sports.find((x) => x === sportOf(q?.get('sport'))) || sports.find((x) => x === sportOf(saved)) || sports.find((x) => mineOf(x).length) || sports[0];

    function rows() {
      const ds = distsOf(sport);
      return ds.map((m) => {
        const x = mineOf(sport).find((y) => y.m === m);
        const t = theirsOf(sport).find((y) => y.m === m);
        const ranked = (board[sport] || []).filter((p) => Number.isFinite(p.bests[m])).sort((a, b) => a.bests[m] - b.bests[m]);
        const lead = ranked[0];
        let side = '';
        if (them && !them.hidden) {
          side = html`<span class="bto-r__them">${t ? html`<b class="n">${clockTime(t.best.timeS)}${kindOf(t.best) ? html`<small> ${kindOf(t.best)}</small>` : ''}</b>${x ? html`<em class="${gapCls(t.best.timeS - x.best.timeS)}">${gapWord(t.best.timeS - x.best.timeS)}</em>` : html`<em>to beat</em>`}` : html`<b class="is-none">${f.DASH}</b><em>none yet</em>`}</span>`;
        } else if (lead && !lead.me) {
          side = html`<span class="bto-r__lead">${avatar(lead)}<span><small>Fastest here${lead.kinds?.[m] ? `, a ${lead.kinds[m]}` : ''}</small><b class="n">${clockTime(lead.bests[m])}</b></span></span>`;
        } else if (lead?.me && ranked.length > 1) {
          side = html`<span class="bto-r__lead is-me"><small>You're fastest here</small></span>`;
        }
        return html`<li><a class="bto-r press" href="/workouts/best/${sport}/${m}${withQ()}">
          <span class="bto-r__d">${SHORT[m] || labelOf(m)}</span>
          <span class="bto-r__me">${x ? html`<b class="n">${clockTime(x.best.timeS)}</b><small>${kindOf(x.best) ? `${kindOf(x.best) === 'walk' ? 'Walk' : 'Run'} · ` : `${rate(sport, m, x.best.timeS)} · `}${f.dayRel(dayOf(x.best.at))}</small>` : html`<b class="is-none">${f.DASH}</b><small>No time yet</small>`}</span>
          ${side}
          ${ic('right', { size: 's' })}
        </a></li>`;
      });
    }

    /** Comparing: how it stands across the sport's distances you have both done. */
    function tally() {
      if (!them || them.hidden) return '';
      let ahead = 0; let both = 0;
      for (const x of mineOf(sport)) { const t = theirsOf(sport).find((y) => y.m === x.m); if (t) { both += 1; if (x.best.timeS <= t.best.timeS) ahead += 1; } }
      const n = first1(them.who);
      return html`<p class="bto-tally">${both ? html`You're ahead of ${n} at <b>${ahead}</b> of <b>${both}</b> ${both === 1 ? 'distance' : 'distances'} you've both done.` : `No ${SPORT[sport][2]} distances you've both done yet.`}</p>`;
    }

    function paint() {
      try { localStorage.setItem(KEY, sport); } catch { /* fine */ }
      history.replaceState(history.state, '', `/workouts/best?sport=${sport}${other ? `&with=${encodeURIComponent(other)}` : ''}`);
      mount(root, html`${head({ title: 'Best times', back: '/workouts?view=progress' })}
        <div class="bto">
          ${sports.length > 1 ? html`<div class="bto-sw">${seg('btsport', sports.map((sp) => [sp, SPORT[sp][0]]), sport, { label: 'Sport', fit: true })}</div>` : ''}
          ${compareBar()}
          ${hiddenNote()}
          ${tally()}
          <ol class="bto-list" aria-label="${SPORT[sport][0]} distances">${rows()}</ol>
          <p class="bt2-foot">The fastest stretch of any ${SPORT[sport][2]} with GPS, on the watch's own distance as its laps and Strava measure it; a session without GPS counts when it was about the distance.</p>
        </div>`);
    }
    paint();
    on(root, 'click', '[data-seg="btsport"]', (e, b) => { sport = b.dataset.value; paint(); });
    on(root, 'click', '[data-cmp-pick]', () => pickPerson((u) => go(`/workouts/best?sport=${sport}${u ? `&with=${encodeURIComponent(u)}` : ''}`, { replace: true })));
    on(root, 'click', '[data-cmp-off]', () => go(`/workouts/best?sport=${sport}`, { replace: true }));
    return;
  }

  /* ════ one distance ════ */

  const sport = ALL.includes(ctx.params.sport) ? ctx.params.sport : 'foot';
  const dist = Number(ctx.params.m);
  const ds = distsOf(sport);
  const overview = `/workouts/best?sport=${sport}${other ? `&with=${encodeURIComponent(other)}` : ''}`;
  const title = sport === 'ride' ? `${labelOf(dist)} ride` : (dist === 21097 || dist === 42195 ? labelOf(dist) : `${labelOf(dist)} on foot`);
  document.title = `${title} · Best times · Health`;
  const top = () => head({ title, back: overview });
  if (!ds.includes(dist)) {
    mount(root, html`${top()}<div class="stack">${empty({ iconName: 'flag', title: `No ${inText(dist)} times here`, text: 'Nobody here has a time at this distance yet.', action: html`<a class="btn btn--tonal" href="${overview}">All distances</a>` })}</div>`);
    return;
  }
  const x = mineOf(sport).find((y) => y.m === dist) || null;
  const t = theirsOf(sport).find((y) => y.m === dist) || null;
  const here = (m, name = other) => `/workouts/best/${sport}/${m}${withQ(name)}`;

  function versus() {
    const n = first1(them.who);
    const gap = x && t ? t.best.timeS - x.best.timeS : null;
    const word = !t ? `No ${inText(dist)} for ${n}` : !x ? 'Yours to set' : gapWord(gap);
    return html`<div class="bt2-vs">
      <span class="bt2-vs__p"><small>You${kindOf(x?.best) ? `, a ${kindOf(x.best)}` : ''}</small><b class="n">${x ? clockTime(x.best.timeS) : f.DASH}</b></span>
      <span class="bt2-vs__g ${gap !== null ? gapCls(gap) : ''}">${word}</span>
      <span class="bt2-vs__p bt2-vs__p--them"><small>${avatar(them.who)}<span>${n}${kindOf(t?.best) ? `, a ${kindOf(t.best)}` : ''}</span></small><b class="n">${t ? clockTime(t.best.timeS) : f.DASH}</b></span>
    </div>`;
  }

  function hero() {
    const kick = html`<p class="bt2-k">${ic(SPORT[sport][1], { size: 's' })}<span>Your fastest ${inText(dist)}${sport === 'foot' ? ' on foot' : ''}</span></p>`;
    const vs = them && !them.hidden ? versus() : '';
    const theirLine = t ? { name: first1(them.who), records: t.records } : null;
    if (!x) {
      const lead = othersOf(sport).filter((p) => Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist])[0];
      return html`<section class="bt2-card bt2-hero">
        ${kick}
        <p class="bt2-none">No time yet</p>
        <p class="bt2-s">A ${SPORT[sport][2]} of ${inText(dist)} or more with GPS sets it.${!t && lead ? ` The fastest here is ${first1(lead)}'s ${clockTime(lead.bests[dist])}${lead.kinds?.[dist] ? `, a ${lead.kinds[dist]}` : ''}.` : ''}</p>
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
        <span>${kindOf(b) ? `A ${kindOf(b)}, ` : ''}${f.dayRel(dayOf(b.at))}${b.title ? html` · ${b.title}` : ''}${b.whole ? ' · the whole session' : ''}</span>${ic('right', { size: 's' })}
      </a>
      ${x.efforts.length > 1 ? html`<p class="bt2-facts">
        <span><b class="n">${f.int(x.efforts.length)}</b> efforts</span>
        <span>${fell ? html`broken <b class="n">${f.int(fell)}</b> ${fell === 1 ? 'time' : 'times'}` : 'your first still stands'}</span>
        ${took ? html`<span><b class="n">${clockTime(took)}</b> off your first</span>` : ''}
      </p>` : ''}
      ${hiddenNote()}${vs}
      ${showChart ? html`${chart((w) => bestChart({ w, efforts: x.efforts, records: x.records, until: Date.now(), go: (i) => `/workouts/${encodeURIComponent(x.efforts[i].id)}`, them: theirLine,
          label: `Your ${labelOf(dist)} times: ${x.efforts.length} efforts, the record falling ${fell} times to ${clockTime(b.timeS)}.${t ? ` ${nameOf(them.who)}'s record: ${clockTime(t.best.timeS)}.` : ''}` }), { cls: 'bt2-chart' })}
        <p class="bt2-note">Higher is faster. The solid line is your record${t ? `, the dashed one ${first1(them.who)}'s` : ''}.</p>` : ''}
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
      const body = html`<span class="bt2-rk__i n">${rank}</span>${avatar(p)}<span class="bt2-rk__n">${p.me ? 'You' : nameOf(p)}${p.kinds?.[dist] ? html`<small>${p.kinds[dist]}</small>` : ''}</span><span class="bt2-rk__g">${on ? html`<span class="bt2-rk__on">${ic('check', { size: 's' })}Comparing</span>` : gap}</span><b class="bt2-rk__t n">${clockTime(v)}</b>`;
      if (p.me) return html`<li class="is-me"><div class="bt2-rk__r">${body}</div></li>`;
      return html`<li class="${on ? 'is-on' : ''}"><a class="bt2-rk__r press" href="${here(dist, on ? '' : p.username)}" aria-label="${on ? 'Stop comparing with' : 'Compare with'} ${nameOf(p)}, ${clockTime(v)}">${body}</a></li>`;
    };
    return html`<section class="bt2-card bt2-rk">
      ${heading}
      <ol class="bt2-rk__l">${ranked.map(row)}${meIn ? '' : html`<li class="is-me is-out"><div class="bt2-rk__r"><span class="bt2-rk__i"></span>${avatar(app.me?.profile || { displayName: 'You' })}<span class="bt2-rk__n">You</span><span class="bt2-rk__g">No time yet</span><b class="bt2-rk__t">${f.DASH}</b></div></li>`}</ol>
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
        <span class="bt2-rec__b"><span class="bt2-rec__t">${f.dayRel(dayOf(r.at))}${r.title ? html` <small>· ${r.title}</small>` : ''}</span><span class="bt2-rec__s">${rate(sport, x.m, r.timeS)}${kindOf(r) ? ` · ${kindOf(r)}` : ''}${r.whole ? ' · the whole session' : ''}</span></span>
        <span class="bt2-rec__v"><b class="n">${clockTime(r.timeS)}</b><small class="${r.prevS ? 'is-up' : ''}">${r.prevS ? `−${clockTime(r.prevS - r.timeS)}` : 'First'}</small></span>
      </a></li>`)}</ol>
    </section>`;
  }

  // The sport's other distances, to move between them (each in place of this one).
  const chips = ds.length > 1 ? html`<nav class="bt2-ds" aria-label="${SPORT[sport][0]} distances">${ds.map((m) => {
    const y = mineOf(sport).find((z) => z.m === m);
    return html`<a class="bt2-d press ${y ? '' : 'is-none'}" href="${here(m)}" data-replace aria-current="${m === dist ? 'page' : 'false'}"><span>${SHORT[m] || labelOf(m)}</span><b class="n">${y ? clockTime(y.best.timeS) : f.DASH}</b></a>`;
  })}</nav>` : '';

  mount(root, html`${top()}
    <div class="bt2">
      <div class="bt2-ctl">${chips}${compareBar()}</div>
      <div class="bt2-main">${hero()}${fellList()}</div>
      <aside class="bt2-side">${ranking()}</aside>
    </div>`);
  const row = root.querySelector('.bt2-ds');
  const cur = row?.querySelector('[aria-current="page"]');
  // Scrolled only when the chosen distance is out of sight: never cutting the first one off for nothing.
  if (row && cur) {
    const l = cur.offsetLeft - row.offsetLeft; const r = l + cur.offsetWidth;
    if (r > row.clientWidth - 8) row.scrollLeft = r - row.clientWidth + 24;
  }
  // Moving between distances, or picking somebody, replaces this page rather than stacking up.
  on(root, 'click', 'a[data-replace], .bt2-rk__r[href]', (e, a) => { e.preventDefault(); e.stopPropagation(); go(a.getAttribute('href'), { replace: true }); });
  on(root, 'click', '[data-cmp-pick]', () => pickPerson((u) => go(here(dist, u), { replace: true })));
  on(root, 'click', '[data-cmp-off]', () => go(here(dist, ''), { replace: true }));
}
