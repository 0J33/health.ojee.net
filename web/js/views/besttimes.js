/* Best times (/workouts/best): your fastest at each standard distance, how it fell,
   and where it stands among the people you share workouts with.

   One layout for every screen:
     - the sport, then the distances (each with your time, or a dash);
     - your record: the time, its pace, the session it came from (opens it), how often it
       fell and by how much, and the chart of every effort when there is more than one;
     - the ranking at that distance: you and everybody you can compare with, fastest first.
       Tap somebody to set them beside you (their record line joins the chart, and the card
       says who is ahead by how much); tap again to put them away. A distance you have not
       done is still there when somebody has: their time is the one to beat;
     - each time your record fell, when it has more than once.
   On a wide screen the ranking stands beside your record.

   From GET /api/best-times (server/medals.js bestTimes: the fastest stretch of each GPS
   track, on the watch's own distance when it sends one, or a whole session of about the
   distance) and GET /api/best-times/people (server/besttimes.js: only people who share
   their workouts with you while you share yours with them, and only their times). */

import { api } from '../api.js';
import { app } from '../app.js';
import { html, mount, head, skeleton, errorState, on, seg, chart, empty, ic, banner } from '../ui.js';
import * as f from '../format.js';
import { bestTimes as bestChart, clockTime } from '../viz.js';
import { avatar } from './shared.js';

const SPORT = { run: ['Run', 'run', 'run'], ride: ['Ride', 'bike', 'ride'], walk: ['Walk', 'walk', 'walk'] };
const ALL = ['run', 'ride', 'walk'];
const KEY = 'health.best.pick';
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

export default async function best(ctx) {
  const { root } = ctx;
  document.title = 'Best times · Health';
  const top = () => head({ title: 'Best times', back: '/workouts?view=progress' });
  mount(root, html`${top()}${skeleton('page')}`);

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const q = ctx.query;
  // Who is beside you: the link's, else the one last looked at.
  let other = q?.get('with') ?? saved.with ?? '';
  let them = null;     // { who, hidden, sports } of the person beside you
  const board = {};    // sport -> [{ username, displayName, avatar, accent, me, bests }]
  // Yours (and the person beside you), and everybody's in each sport, together: a sport or a
  // distance only they have done is still there to compare.
  const boards = Promise.all(ALL.map((sp) => api.get(`/api/best-times/people?sport=${sp}`).then((r) => { board[sp] = r.people || []; }, () => { board[sp] = []; })));
  let d;
  try { d = await api.get(`/api/best-times${other ? `?with=${encodeURIComponent(other)}` : ''}`); } catch (err) {
    if (err.status !== 404 || !other) { if (ctx.alive()) mount(root, html`${top()}${errorState(err)}`); return; }
    other = '';
    try { d = await api.get('/api/best-times'); } catch (e2) { if (ctx.alive()) mount(root, html`${top()}${errorState(e2)}`); return; }
  }
  await boards;
  if (!ctx.alive()) return;
  them = d.them || null;
  // Somebody no longer there to compare with (not sharing any more): set aside quietly, unless the link asked for them.
  if (them?.hidden && !q?.get('with')) { them = null; other = ''; }
  const mine = d.sports || [];
  const othersIn = (sp) => (board[sp] || []).filter((p) => !p.me && Object.keys(p.bests).length);
  const sports = ALL.filter((sp) => mine.some((x) => x.sport === sp) || othersIn(sp).length);
  if (!sports.length) {
    mount(root, html`${top()}<div class="stack">${empty({ iconName: 'flag', title: 'No best times yet', text: 'Record a run, ride or walk with GPS (or bring one in from your watch) and its fastest 1 km, 5 km, 10 km and more show here, with every record you break.' })}</div>`);
    return;
  }

  const mineOf = (sp) => mine.find((x) => x.sport === sp)?.distances || [];
  const theirsOf = (sp) => (them && !them.hidden ? them.sports.find((x) => x.sport === sp)?.distances || [] : []);
  // Every distance anybody here has a time at: yours, the person beside you, everybody's.
  const distsOf = (sp) => [...new Set([...mineOf(sp).map((x) => x.m), ...theirsOf(sp).map((x) => x.m), ...(board[sp] || []).flatMap((p) => Object.keys(p.bests).map(Number))])].sort((a, b) => a - b);
  // A sport of yours first: the page opens on your own times.
  let sport = sports.find((x) => x === (q?.get('sport') || saved.sport)) || sports.find((x) => mineOf(x).length) || sports[0];
  // The distance asked for; else the one last looked at; else one of yours (the 5 km, the
  // classic, when you have it); else the 5 km or the first anybody has.
  const pickDist = (sp, want) => {
    const ds = distsOf(sp); const my = mineOf(sp).map((x) => x.m);
    return ds.find((m) => m === want) ?? (my.includes(5000) ? 5000 : my[0]) ?? ds.find((m) => m === 5000) ?? ds[0];
  };
  let dist = pickDist(sport, Number(q?.get('d') || saved.d));

  const myDist = () => mineOf(sport).find((y) => y.m === dist) || null;
  const theirDist = () => theirsOf(sport).find((y) => y.m === dist) || null;

  /* ── your record (or the empty card), with the comparison and the chart ── */

  /** You and them, side by side, and who is ahead. */
  function versus(x, t) {
    const n = first1(them.who);
    const gap = x && t ? t.best.timeS - x.best.timeS : null;
    const word = !t ? `No ${inText(dist)} for ${n}` : !x ? 'Yours to set' : gap === 0 ? 'Level' : `${clockTime(Math.abs(gap))} ${gap > 0 ? 'ahead' : 'behind'}`;
    return html`<div class="bt2-vs">
      <span class="bt2-vs__p"><small>You</small><b class="n">${x ? clockTime(x.best.timeS) : f.DASH}</b></span>
      <span class="bt2-vs__g ${gap > 0 ? 'is-ahead' : gap < 0 ? 'is-behind' : ''}">${word}</span>
      <span class="bt2-vs__p bt2-vs__p--them"><small>${avatar(them.who)}<span>${n}</span></small><b class="n">${t ? clockTime(t.best.timeS) : f.DASH}</b></span>
    </div>`;
  }

  function hero() {
    const x = myDist();
    const t = theirDist();
    const kick = html`<p class="bt2-k">${ic(SPORT[sport][1], { size: 's' })}<span>Your fastest ${inText(dist)}</span></p>`;
    const hidden = them?.hidden ? banner({
      tone: 'warn', iconName: 'lock',
      title: them.hidden === 'yours' ? `Share your workouts with ${first1(them.who)} to compare` : `${first1(them.who)} does not share workouts with you`,
      text: them.hidden === 'yours' ? 'Comparing is fair both ways: their times show while yours show to them.' : 'Their best times show here when they share their workouts with you.',
      actions: them.hidden === 'yours' ? html`<a class="btn btn--s btn--tonal" href="/settings/privacy">Privacy</a>` : '',
    }) : '';
    const vs = them && !them.hidden ? versus(x, t) : '';
    const theirLine = t ? { name: first1(them.who), records: t.records } : null;
    if (!x) {
      const lead = (board[sport] || []).filter((p) => !p.me && Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist])[0];
      return html`<section class="bt2-card bt2-hero">
        ${kick}
        <p class="bt2-none">No time yet</p>
        <p class="bt2-s">A ${SPORT[sport][2]} of ${inText(dist)} or more with GPS sets it.${!t && lead ? ` The fastest here is ${first1(lead)}'s ${clockTime(lead.bests[dist])}.` : ''}</p>
        ${hidden}${vs}
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
        <span>${f.dayRel(dayOf(b.at))}${b.title ? html` · ${b.title}` : ''}${b.whole ? ' · the whole session' : ''}</span>${ic('right', { size: 's' })}
      </a>
      ${x.efforts.length > 1 ? html`<p class="bt2-facts">
        <span><b class="n">${f.int(x.efforts.length)}</b> efforts</span>
        <span>${fell ? html`broken <b class="n">${f.int(fell)}</b> ${fell === 1 ? 'time' : 'times'}` : 'your first still stands'}</span>
        ${took ? html`<span><b class="n">${clockTime(took)}</b> off your first</span>` : ''}
      </p>` : ''}
      ${hidden}${vs}
      ${showChart ? html`${chart((w) => bestChart({ w, efforts: x.efforts, records: x.records, until: Date.now(), go: (i) => `/workouts/${encodeURIComponent(x.efforts[i].id)}`, them: theirLine,
          label: `Your ${labelOf(dist)} times: ${x.efforts.length} efforts, the record falling ${fell} times to ${clockTime(b.timeS)}.${t ? ` ${nameOf(them.who)}'s record: ${clockTime(t.best.timeS)}.` : ''}` }), { cls: 'bt2-chart' })}
        <p class="bt2-note">Higher is faster. The solid line is your record${t ? `, the dashed one ${first1(them.who)}'s` : ''}.</p>` : ''}
    </section>`;
  }

  /* ── the ranking at this distance ── */

  function ranking() {
    const people = board[sport] || [];
    const others = people.filter((p) => !p.me);
    const title = html`<header class="bt2-rk__h"><h2>${labelOf(dist)} ranking</h2></header>`;
    if (!others.length) {
      return html`<section class="bt2-card bt2-rk">${title}<p class="bt2-rk__none">${ic('users', { size: 's' })}<span>Nobody to compare with yet. Friends who share their workouts with you, and you yours with them, show here with their times.</span></p></section>`;
    }
    const ranked = people.filter((p) => Number.isFinite(p.bests[dist])).sort((a, b) => a.bests[dist] - b.bests[dist]);
    const fastest = ranked[0]?.bests[dist];
    const tied = ranked.filter((p) => p.bests[dist] === fastest).length > 1;
    const meIn = ranked.some((p) => p.me);
    const without = others.filter((p) => !Number.isFinite(p.bests[dist]));
    const row = (p) => {
      const v = p.bests[dist];
      const rank = ranked.findIndex((o) => o.bests[dist] === v) + 1;
      const gap = v === fastest ? (tied ? 'Level' : 'Fastest') : `+${clockTime(v - fastest)}`;
      const on = p.username === other;
      const body = html`<span class="bt2-rk__i n">${rank}</span>${avatar(p)}<span class="bt2-rk__n">${p.me ? 'You' : nameOf(p)}</span><span class="bt2-rk__g">${on ? html`<span class="bt2-rk__on">${ic('check', { size: 's' })}Comparing</span>` : gap}</span><b class="bt2-rk__t n">${clockTime(v)}</b>`;
      return p.me
        ? html`<li class="is-me"><div class="bt2-rk__r">${body}</div></li>`
        : html`<li class="${on ? 'is-on' : ''}"><button type="button" class="bt2-rk__r press" data-with="${p.username}" aria-pressed="${String(on)}" aria-label="${on ? 'Stop comparing with' : 'Compare with'} ${nameOf(p)}, ${clockTime(v)}">${body}</button></li>`;
    };
    return html`<section class="bt2-card bt2-rk">
      ${title}
      ${ranked.length ? html`<ol class="bt2-rk__l">${ranked.map(row)}${meIn ? '' : html`<li class="is-me is-out"><div class="bt2-rk__r"><span class="bt2-rk__i"></span>${avatar(app.me?.profile || { username: 'you', displayName: 'You' })}<span class="bt2-rk__n">You</span><span class="bt2-rk__g">No time yet</span><b class="bt2-rk__t">${f.DASH}</b></div></li>`}</ol>`
        : html`<p class="bt2-rk__none">${ic('flag', { size: 's' })}<span>Nobody here has a ${inText(dist)} yet.</span></p>`}
      ${without.length ? html`<p class="bt2-rk__more">No ${inText(dist)} yet: ${without.map(nameOf).join(', ')}</p>` : ''}
      <p class="bt2-rk__tip">${other && them && !them.hidden ? html`Comparing with ${first1(them.who)}. <button type="button" class="bt2-link" data-with="">Stop</button>` : 'Tap somebody to set their record beside yours.'}</p>
    </section>`;
  }

  /* ── each time the record fell ── */

  function fellList() {
    const x = myDist();
    if (!x || x.records.length < 2) return '';
    return html`<section class="bt2-hist">
      <h2 class="bt2-h">Each time you broke it</h2>
      <ol class="bt2-recs">${[...x.records].reverse().map((r, i) => html`<li><a class="bt2-rec press" href="/workouts/${encodeURIComponent(r.id)}">
        <span class="bt2-rec__dot ${i === 0 ? 'is-now' : ''}" aria-hidden="true">${i === 0 ? ic('record', { size: 's' }) : ''}</span>
        <span class="bt2-rec__b"><span class="bt2-rec__t">${f.dayRel(dayOf(r.at))}${r.title ? html` <small>· ${r.title}</small>` : ''}</span><span class="bt2-rec__s">${rate(sport, x.m, r.timeS)}${r.whole ? ' · the whole session' : ''}</span></span>
        <span class="bt2-rec__v"><b class="n">${clockTime(r.timeS)}</b><small class="${r.prevS ? 'is-up' : ''}">${r.prevS ? `−${clockTime(r.prevS - r.timeS)}` : 'First'}</small></span>
      </a></li>`)}</ol>
    </section>`;
  }

  function paint() {
    const ds = distsOf(sport);
    if (!ds.includes(dist)) dist = pickDist(sport, dist);
    try { localStorage.setItem(KEY, JSON.stringify({ sport, d: dist, with: other })); } catch { /* fine */ }
    history.replaceState(history.state, '', `/workouts/best?sport=${sport}&d=${dist}${other ? `&with=${encodeURIComponent(other)}` : ''}`);
    const keep = root.querySelector('.bt2-ds')?.scrollLeft || 0;
    const chips = ds.map((m) => {
      const y = mineOf(sport).find((z) => z.m === m);
      return html`<button type="button" class="bt2-d press ${y ? '' : 'is-none'}" data-d="${m}" aria-pressed="${String(m === dist)}"><span>${SHORT[m] || labelOf(m)}</span><b class="n">${y ? clockTime(y.best.timeS) : f.DASH}</b></button>`;
    });
    mount(root, html`${top()}
      <div class="bt2">
        <div class="bt2-ctl">
          ${sports.length > 1 ? seg('btsport', sports.map((sp) => [sp, SPORT[sp][0]]), sport, { label: 'Sport', fit: true }) : ''}
          <div class="bt2-ds" role="group" aria-label="Distance">${chips}</div>
        </div>
        <div class="bt2-main">${hero()}${fellList()}</div>
        <aside class="bt2-side">${ranking()}</aside>
        <p class="bt2-foot">The fastest stretch of any ${SPORT[sport][2]} with GPS, on the watch's own distance as its laps and Strava measure it; a session without GPS counts when it was about the distance.</p>
      </div>`);
    // The chosen distance in view, the row otherwise where it was.
    const row = root.querySelector('.bt2-ds');
    const on = row?.querySelector('[aria-pressed="true"]');
    if (row) {
      row.scrollLeft = keep;
      if (on && (on.offsetLeft - row.offsetLeft < row.scrollLeft || on.offsetLeft - row.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth)) row.scrollLeft = on.offsetLeft - row.offsetLeft - 16;
    }
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

  paint();
  on(root, 'click', '[data-seg="btsport"]', (e, b) => { sport = b.dataset.value; dist = pickDist(sport, dist); paint(); });
  on(root, 'click', '[data-d]', (e, b) => { dist = Number(b.dataset.d); paint(); });
  // Somebody in the ranking (again to put them away), or "Stop".
  on(root, 'click', '[data-with]', (e, b) => { const u = b.dataset.with; pickWith(u && u === other ? '' : u); });
}
