/* Circle goals, events and ranks (server/challenges.js, server/rating.js,
   docs/CHALLENGES.md), as the circle page, its goal and event pages and a
   profile draw them: a goal's card with its trophy road, an event's card,
   the rank badge, the sheet that explains a rank, and a person's honours. */

import { api } from './api.js';
import { html, raw, ic, sheet, on, toast, toastError, busy } from './ui.js';
import * as f from './format.js';
import { avatar, unitText } from './views/shared.js';
import { medal, trophy } from './medals.js';
import { METRIC, nameOf } from './views/ranks.js';
import { rankEmblem } from './rankart.js';
import { overBy } from './kit.js';

export const TIER_WORD = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
const PLACE = ['', 'first', 'second', 'third'];
const PLACE_TIER = ['', 'gold', 'silver', 'bronze'];
const who = (p) => (p.me ? 'You' : nameOf(p));

/** "3 days left", "5 h left", "Ends soon": until a moment. */
export function timeLeft(at, now = Date.now()) {
  const ms = at - now;
  if (ms <= 0) return 'Adding up the last numbers';
  const h = ms / 3_600_000;
  if (h < 1) return 'Ends within the hour';
  if (h < 36) return `${Math.round(h)} h left`;
  return `${Math.round(h / 24)} days left`;
}
const amount = (v, unit) => unitText(v, unit);

/* ── goals ───────────────────────────────────────────────────── */

/* The road to the trophies: the bar runs to 150% (platinum); a small medal stands at each of 50, 75, 100 and 150. */
const ROAD_MAX = 150;
const roadX = (pct) => `${Math.min(100, (pct / ROAD_MAX) * 100).toFixed(2)}%`;
function road(g) {
  return html`<div class="gl-road" role="img" aria-label="${f.int(g.pct)}% of the goal. ${g.tiers.map((t) => `${TIER_WORD[t.tier]} at ${t.pct}%${t.reached ? ', reached' : ''}`).join('. ')}.">
    <div class="gl-road__marks" aria-hidden="true">${g.tiers.map((t) => html`<span class="gl-road__m ${t.reached ? 'is-on' : ''}" data-style="--x:${roadX(t.pct)}">${trophy(t.tier, { size: 's', label: '' })}</span>`)}</div>
    <div class="meter meter--l gl-road__bar ${g.pct > ROAD_MAX ? 'meter--over' : ''}" aria-hidden="true"><div class="meter__v" data-style="--p:${Math.min(1, g.pct / ROAD_MAX).toFixed(4)}"></div>
      ${g.tiers.map((t) => html`<span class="meter__tick ${t.pct === 100 ? 'meter__tick--goal' : ''}" data-style="--x:${roadX(t.pct)}"></span>`)}
      ${g.pace && g.pace > g.total ? html`<span class="gl-road__pace" data-style="--x:${roadX((g.pace / g.target) * 100)}"></span>` : ''}</div>
  </div>`;
}

/** A goal on the circle page: what, how far, what it earns next, and who gave most. */
export function goalCard(g, { href = '', compact = false } = {}) {
  const m = METRIC[g.metric] || { icon: 'target', fam: 'steps' };
  const kick = g.kind === 'week' ? 'This week\'s goal' : 'This month\'s big goal';
  const top = g.people.filter((p) => p.value > 0).slice(0, 3);
  const me = g.people.find((p) => p.me);
  const tag = g.closed ? (g.tier ? `${TIER_WORD[g.tier]} trophy` : 'No trophy') : g.settling ? 'Adding up' : timeLeft(g.endsAt);
  const nextLine = g.closed ? (g.tier ? `Reached ${f.int(g.pct)}%: ${TIER_WORD[g.tier].toLowerCase()} for the circle.` : `Reached ${f.int(g.pct)}%. Bronze needed 50%.`)
    : g.next ? `${TIER_WORD[g.next.tier]} at ${amount(g.next.at, g.unit)}: ${amount(g.next.left, g.unit)} to go.`
      : `Platinum: every trophy is won, ${amount(g.total - g.target * (ROAD_MAX / 100), g.unit)} past it.`;
  const inner = html`
    <div class="gl__h">
      <span class="gl__ic">${ic(m.icon)}</span>
      <span class="gl__t"><span class="gl__k">${kick}</span><span class="gl__n">${g.label}</span></span>
      <span class="gl__tag ${g.tier ? `gl__tag--${g.tier}` : ''}">${tag}</span>
    </div>
    <p class="gl__v"><b class="n">${unitText(g.total, g.unit)}</b><span> of ${amount(g.target, g.unit)} · ${f.int(g.pct)}%</span>${g.total > g.target ? html` ${overBy(amount(g.total - g.target, g.unit))}` : ''}</p>
    ${road(g)}
    <p class="gl__next">${nextLine}${g.pace && !g.closed ? html` <span class="gl__pace">On pace for ${f.int((g.pace / g.target) * 100)}%.</span>` : ''}</p>
    ${compact ? '' : top.length ? html`<div class="gl__top">${top.map((p) => html`<span class="gl__who ${p.me ? 'is-me' : ''}">${avatar(p)}<span class="gl__whob"><span class="gl__whon">${who(p)}</span><span class="gl__whov n">${f.int(p.share * 100)}%</span></span></span>`)}</div>` : html`<p class="gl__none">Nobody has a number for it yet. Every bit counts.</p>`}
    ${compact && !g.hidden ? '' : g.hidden ? html`<p class="gl__me">You are not counted: your ${g.cat === 'workouts' ? 'workouts are' : 'activity is'} kept from your circles (Privacy).</p>`
      : me && !g.closed ? html`<p class="gl__me">You: <b class="n">${amount(me.value, g.unit)}</b>, ${f.int(me.share * 100)}% of it${me.place ? `, ${PLACE[me.place]} in the circle` : ''}.</p>` : ''}`;
  return href ? html`<a class="gl fam fam-${m.fam} press" href="${href}">${inner}</a>` : html`<div class="gl fam fam-${m.fam}">${inner}</div>`;
}

/** Everybody's part in a goal, in order, for its page. */
export function goalPeople(g) {
  if (!g.people.length) return html`<p class="muted small">Nobody is counted for it.</p>`;
  // Who gave something, in order; who has nothing yet, named on one line under them.
  const gave = g.people.filter((p) => p.value > 0);
  const none = g.people.filter((p) => !(p.value > 0));
  const noneLine = none.length ? html`<p class="gl-none">${g.closed ? 'Gave nothing to it' : 'Nothing yet'}: ${none.map((p) => who(p)).join(', ')}.</p>` : '';
  if (!gave.length) return html`<p class="muted small">Nobody has given anything to it yet.</p>${noneLine}`;
  return html`<div class="group">${gave.map((p, i) => html`<a class="row fr-row gl-row ${p.me ? 'is-me' : ''}" href="/u/${encodeURIComponent(p.username)}">
    <span class="hf-tally__pos n">${i + 1}</span>${avatar(p)}
    <span class="row__body"><span class="row__t">${who(p)}${p.place && g.closed ? html` ${medal(PLACE_TIER[p.place], 'up', { size: 's', label: `Top contributor, ${PLACE[p.place]}` })}` : ''}</span>
      <span class="gl-row__bar"><span class="meter"><span class="meter__v" data-style="--p:${(gave[0].value ? p.value / gave[0].value : 0).toFixed(4)}"></span></span></span></span>
    <span class="gl-row__v"><b class="n">${unitText(p.value, g.unit)}</b><small class="n">${f.int(p.share * 100)}%</small></span></a>`)}</div>${noneLine}`;
}

/* ── events ──────────────────────────────────────────────────── */

const legAmount = (l, v) => (l.unit === 'min' ? unitText(v, 'min') : f.dist(v));
export const modeWord = (mode) => (mode === 'race' ? 'Race' : 'Together');
const statusWord = (e) => (e.status === 'soon' ? `Starts ${f.dayShort(e.start)}` : e.status === 'live' ? timeLeft(e.endsAt) : e.status === 'settling' ? 'Adding up' : `Ended ${f.dayShort(e.end)}`);

/** An event on the circle page. */
export function eventCard(e) {
  const me = e.people.find((p) => p.me);
  const lead = e.people[0];
  const line = e.mode === 'team'
    ? html`<div class="ev__prog"><span class="ev__pl">Together</span><span class="meter ${e.legs?.some((l) => (e.team.done?.[l.leg] || 0) > l.need) ? 'meter--over' : ''}"><span class="meter__v" data-style="--p:${Math.min(1, e.team.pct / 100).toFixed(4)}"></span></span><b class="n">${f.int(e.team.pct)}%</b></div>`
    : html`${me ? html`<div class="ev__prog"><span class="ev__pl">You</span><span class="meter"><span class="meter__v" data-style="--p:${Math.min(1, me.pct / 100).toFixed(4)}"></span></span><b class="n">${me.finished ? 'Done' : `${f.int(me.pct)}%`}</b></div>` : ''}
      ${lead && !lead.me ? html`<div class="ev__prog ev__prog--them"><span class="ev__pl">${who(lead)}</span><span class="meter meter--them"><span class="meter__v" data-style="--p:${Math.min(1, lead.pct / 100).toFixed(4)}"></span></span><b class="n">${lead.finished ? 'Done' : `${f.int(lead.pct)}%`}</b></div>` : ''}`;
  return html`<a class="ev press" href="/circles/${e.circle.id}/events/${e.id}">
    <div class="ev__h"><span class="ev__ic">${ic(e.icon)}</span>
      <span class="ev__t"><span class="ev__k">${modeWord(e.mode)} · ${f.plural(e.people.length, 'person', 'people')}</span><span class="ev__n">${e.label}</span></span>
      <span class="gl__tag">${statusWord(e)}</span></div>
    <p class="ev__legs">${e.legs.map((l) => `${l.label} ${legAmount(l, e.mode === 'team' ? l.need : l.amount)}`).join(' · ')}${e.mode === 'team' ? ' between you' : ''}</p>
    ${line}
    ${e.canJoin ? html`<span class="ev__join">${ic('plus', { size: 's' })}Join in</span>` : ''}
  </a>`;
}

const radio = (name, value, checked, icon, title, sub) => html`<label class="st-row st-radio">
  <span class="st-ic st-ic--workouts">${ic(icon)}</span><span class="st-b"><span class="st-t">${title}</span><span class="st-s">${sub}</span></span>
  <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span class="st-tick" aria-hidden="true">${ic('check')}</span>
</label>`;

/** The sheet that starts an event: which, race or together, how long, when. */
export async function startEventSheet(cid, kinds) {
  const pick = { kind: kinds[0]?.id || 'marathon', mode: 'race', days: 7, start: 'today' };
  const paint = () => html`<div class="st-sheet evs">
    <p class="st-lead">Everybody in the circle can join. Runs, rides, swims and gym time from their workouts count, from the first day to the last.</p>
    <p class="st-lab"><span>Which</span></p>
    <div class="st-grp">${kinds.map((k) => radio('ev-kind', k.id, pick.kind === k.id, k.icon, k.label, k.say))}</div>
    <p class="st-lab"><span>How</span></p>
    <div class="st-grp">
      ${radio('ev-mode', 'race', pick.mode === 'race', 'sprint', 'Race', 'Each of you does it all. First to finish wins; the first three get medals.')}
      ${radio('ev-mode', 'team', pick.mode === 'team', 'groups', 'Together', 'One each, pooled: everybody\'s kilometres add up. Finish it and the circle wins a trophy.')}
    </div>
    <p class="st-lab"><span>How long</span></p>
    <div class="evs__seg">${[[7, '1 week'], [14, '2 weeks'], [28, '4 weeks']].map(([v, t]) => html`<button type="button" class="seg__opt" data-days="${v}" aria-pressed="${String(pick.days === v)}">${t}</button>`)}</div>
    <p class="st-lab"><span>Starts</span></p>
    <div class="evs__seg">${[['today', 'Today'], ['tomorrow', 'Tomorrow']].map(([v, t]) => html`<button type="button" class="seg__opt" data-start="${v}" aria-pressed="${String(pick.start === v)}">${t}</button>`)}</div>
  </div>`;
  return new Promise((resolve) => {
    let done = null;
    const s = sheet({
      title: 'Start an event',
      body: paint(),
      foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-go>Start it</button>`,
    });
    const body = s.el.querySelector('.sheet__body');
    s.el.addEventListener('change', (ev) => {
      if (ev.target.name === 'ev-kind') pick.kind = ev.target.value;
      if (ev.target.name === 'ev-mode') pick.mode = ev.target.value;
    });
    on(s.el, 'click', '[data-days]', (ev, b) => { pick.days = Number(b.dataset.days); body.querySelectorAll('[data-days]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
    on(s.el, 'click', '[data-start]', (ev, b) => { pick.start = b.dataset.start; body.querySelectorAll('[data-start]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
    on(s.el, 'click', '[data-go]', async (ev, b) => {
      try { done = await busy(b, () => api.post(`/api/circles/${encodeURIComponent(cid)}/events`, pick)); if (done) { toast(`${done.label} started`); s.close(); } } catch (err) { toastError(err); }
    });
    s.closed.then(() => resolve(done));
  });
}

/* ── ranks ───────────────────────────────────────────────────── */

/** The rank badge (rankart.js): the tier's shape and metal, the division's chevrons, rim and wings. */
export const rankBadge = (rank, { size = 'm' } = {}) => rankEmblem(rank, { size });

/** The rating week by week as a line, over the tier bands it moved through: each band named in its middle, each week a dot. */
function historyChart(hist, tiers) {
  const W = 320; const L = 8; const T = 10; const B = 22;
  const vals = hist.map((h) => h.rating);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const pad = Math.max(80, (hi - lo) * 0.25);
  lo = Math.max(0, lo - pad); hi = Math.min(Math.max(hi + pad, lo + 200), 3300);
  // The bands in view: from each tier's line (or the bottom) to the next (or the top).
  const bands = tiers.map((t, i) => ({ t, a: Math.max(lo, t.at), b: Math.min(hi, tiers[i + 1]?.at ?? Infinity) })).filter((x) => x.b > x.a);
  // Room on the right for the longest name shown (about 5.9 units a letter at this size).
  // Taller when it spans many tiers, so every band keeps room for its name.
  const H = Math.max(132, T + B + Math.round(((hi - lo) / 400) * 17));
  const R = 16 + Math.max(24, ...bands.map((x) => x.t.label.length * 5.9));
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, hist.length - 1);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let svg = '';
  for (const { t, a, b } of bands) {
    if (t.at > lo) { const yy = y(t.at).toFixed(1); svg += `<line class="rkh__tl" x1="${L}" x2="${W}" y1="${yy}" y2="${yy}"/>`; }
    // Named only where the band is tall enough for the name.
    if (y(a) - y(b) >= 13) svg += `<text class="rkh__tt rkh__tt--${t.tier}" x="${W}" y="${((y(a) + y(b)) / 2 + 3.5).toFixed(1)}" text-anchor="end">${t.label}</text>`;
  }
  svg += `<path class="rkh__ln" d="${hist.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h.rating).toFixed(1)}`).join('')}"/>`;
  hist.forEach((h, i) => { svg += `<circle class="rkh__dt rkh__dt--${h.rank?.tier || 'none'}" cx="${x(i).toFixed(1)}" cy="${y(h.rating).toFixed(1)}" r="${i === hist.length - 1 ? 5 : 3.5}"/>`; });
  const lab = (i, an) => `<text class="rkh__x" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${an}">${f.dayShort(hist[i].week)}</text>`;
  svg += lab(0, 'start') + lab(hist.length - 1, 'end');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating over ${hist.length} weeks, from ${f.int(vals[0])} to ${f.int(vals[vals.length - 1])}">${svg}</svg>`;
}

/** In words: what carried a week and what held it back. */
function whyText(list, who) {
  const by = [...list].sort((a, b) => b.points - a.points);
  const top = by[0]; const low = by[by.length - 1];
  if (!top || top.points === 0) return `${who === 'You' ? 'You' : who} had no numbers that week.`;
  const lowText = low.points < 200 ? ` ${low.label} held it back (${f.int(low.points)} of 400 at par).` : ' Every part was near par or better.';
  if (low.points >= 800) return 'Every part at the max: the most a week can earn.';
  return `${top.label} carried it: ${f.int(top.points)} points${top.points >= 800 ? ', the max' : top.points >= 400 ? ', over par' : ''}.${lowText}`;
}

const signed = (v) => (v > 0 ? `+${f.int(v)}` : v < 0 ? `−${f.int(-v)}` : '±0');

/** Time left, in words: "2 days 5 h", "5 h 20 min", "12 min". */
function leftWords(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mm = m % 60;
  return d ? `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}` : h ? `${h} h${mm ? ` ${mm} min` : ''}` : `${mm} min`;
}
/** A moment in the viewer's own words: "Thursday 23:59" style, ending at midnight shown as the end of the day before. */
const endWords = (t) => f.weekdayClock(t - 60_000).replace(/ 23:59$/, ' at midnight');
const signedN = (v) => (v > 0 ? `+${f.int(v)}` : v < 0 ? `−${f.int(-v)}` : '±0');

/** This week, for a card or the sheet: the dates, the time left, the points so far, the pace and where it ends. */
function weekBlock(r, { full = false, me = true } = {}) {
  const w = r.week;
  if (!w) return '';
  const now = Date.now();
  const span = Math.max(1, (w.endsAt ?? 0) - (w.startsAt ?? 0));
  const timePct = Math.min(1, Math.max(0, (now - (w.startsAt ?? now)) / span));
  const strong = 1600; const MAX = w.maxScore || 3200;
  const pts = Math.min(1, w.score / MAX);
  const moved = r.placed && w.projectedRank && w.projectedRank.name !== r.rank.name;
  const up = moved && w.projected > r.rating;
  const st = w.stakes;
  return html`<section class="rkw">
    <div class="rkw__top"><span class="rkw__k">This week</span><span class="rkw__dates">${f.dayShort(w.from)} – ${f.dayShort(w.to)}</span></div>
    <div class="rkw__clock">${ic('clock', { size: 's' })}<span>Ends in <b>${leftWords((w.endsAt ?? now) - now)}</b> · ${endWords(w.endsAt ?? now)}</span></div>
    <div class="rkw__bars" role="img" aria-label="${Math.round(timePct * 100)}% of the week gone; ${f.int(w.score)} points">
      <div class="rkw__bar rkw__bar--time"><i data-style="--p:${timePct.toFixed(4)}"></i></div>
      <div class="rkw__bar rkw__bar--pts"><i data-style="--p:${pts.toFixed(4)}"></i><span class="rkw__mark" data-style="--x:${(strong / MAX * 100).toFixed(2)}%" title="A strong week"></span></div>
    </div>
    <div class="rkw__nums">
      <div><b class="n">${f.int(w.score)}</b><small>points so far</small></div>
      ${r.placed ? html`<div><b class="n">${f.int(r.rating)}</b><small>your level</small></div>` : ''}
      <div>${w.paced === null ? html`<b class="n rkw__na">–</b><small>pace from tomorrow</small>` : html`<b class="n">${f.int(w.paced)}</b><small>points on this pace</small>`}</div>
    </div>
    ${r.placed ? html`<p class="rkw__rule ${w.paced === null ? '' : w.paced > r.rating ? 'is-up' : w.paced < r.rating ? 'is-down' : ''}">${ic(w.paced === null || w.paced >= r.rating ? 'up' : 'down', { size: 's' })}<span>${me ? 'Finish' : 'They finish'} the week above <b>${f.int(r.rating)}</b> points and ${me ? 'your' : 'their'} level goes up; below it, it slips.${w.projected === null ? '' : html` On this pace it ${w.projected > r.rating ? 'goes up' : w.projected < r.rating ? 'slips' : 'stays'} to <b>${f.int(w.projected)}</b>${moved ? html`: <b>${w.projectedRank.name}</b>` : ''}.`}</span></p>` : ''}
    <p class="rkw__legend"><span class="rkw__sw rkw__sw--time"></span>Time gone <span class="rkw__sw rkw__sw--pts"></span>Points (the line: a strong week, ${f.int(strong)})</p>
    ${r.placed && st ? html`<div class="rkw__stakes">
      ${st.up ? html`<span class="rkw__st is-up">${ic('up', { size: 's' })}${st.up.score === null ? html`${st.up.name}: not reachable this week` : html`<b>${f.int(st.up.score)}</b> points reaches ${st.up.name}`}</span>` : ''}
      ${st.down ? html`<span class="rkw__st is-down">${ic('down', { size: 's' })}Under <b>${f.int(st.down.under)}</b> drops to ${st.down.name}</span>` : html`<span class="rkw__st">${ic('down', { size: 's' })}No week drops ${me ? 'you' : 'them'} a division</span>`}
    </div>` : ''}
    ${full ? '' : ''}
  </section>`;
}

/** The rank on a profile: the badge, the rating and the way to the next division, then this week. Tap for everything. */
export function rankCard(r, { me = false, name = '' } = {}) {
  if (!r) return '';
  if (!r.placed) {
    return html`<button type="button" class="rkc press" data-rank-info>
      <div class="rkc__h">${rankBadge(null, { size: 'l' })}<span class="rkc__b"><span class="rkc__k">Rank</span><span class="rkc__n">Placing</span>
        <span class="rkc__s">${me ? 'You are' : `${name} is`} placed after ${f.plural(r.weeksToPlace, 'more week')} with numbers. Then every week moves it.</span></span>${ic('chev_r', { size: 's' })}</div>
    </button>`;
  }
  const nx = r.rank.next;
  const span = nx ? Math.max(1, nx.at - r.rank.from) : 1;
  const into = nx ? Math.min(1, Math.max(0, (r.rating - r.rank.from) / span)) : 1;
  return html`<button type="button" class="rkc rkc--${r.rank.tier} press" data-rank-info>
    <div class="rkc__h">${rankBadge(r.rank, { size: 'l' })}
      <span class="rkc__b"><span class="rkc__k">Rank</span><span class="rkc__n">${r.rank.name}</span>
        <span class="rkc__s">Level <b class="n">${f.int(r.rating)}</b>${r.delta !== null ? html` · <span class="rkc__d ${r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}">${signed(r.delta)} last week</span>` : ''}</span></span>
      ${ic('chev_r', { size: 's' })}</div>
    ${nx ? html`<div class="rkc__road"><span class="rkc__bar"><span class="rkc__fill" data-style="--p:${into.toFixed(4)}"></span></span>
      <span class="rkc__ends"><span>${r.rank.name}</span><span>${f.int(nx.left)} to ${nx.name}</span></span></div>`
      : html`<p class="rkc__next">The top of the ladder.</p>`}
    ${weekBlock(r, { me })}
  </button>`;
}

/** The sheet behind a rank: this week first, then the weeks before and how it works, folded away. */
export async function rankSheet(r, { me = false, name = '', username = '', face = null } = {}) {
  let lad = null;
  try { lad = await api.get('/api/rank/ladder'); } catch { lad = null; }
  const w = r.week;
  const MAX = lad?.max || 3200;
  const val = (c, v) => (c.unit === 'm' ? f.dist(v) : c.unit === 'steps' ? f.int(v) : c.unit === 'min' ? (v % 60 === 0 ? `${v / 60} h` : f.dur(v)) : unitText(v, c.unit));
  const maxOf = (c) => c.max ?? c.par * 2;
  const top = (c) => c.maxPoints ?? 800;
  // Each of the four: what it is at, par, and its points; the fine print folded under it.
  const cats = (list) => html`<div class="rkcat">${list.map((c) => {
    const over = c.over ?? Math.max(0, c.value - maxOf(c));
    const note = c.filled ? `Not counted by ${me ? 'your' : 'their'} device: given the steps' points, at most par.`
      : [c.say, c.scaled ? `From ${f.plural(c.scaled, 'day')} with steps, scaled to a week.` : ''].filter(Boolean).join('. ');
    return html`<div class="rkcat__r">
      <div class="rkcat__h"><span class="rkcat__t">${c.label}</span><span class="rkcat__p n">${f.int(c.points)}<small> / ${f.int(top(c))}</small></span></div>
      <span class="meter ${over > 0 ? 'meter--over' : ''}"><span class="meter__v" data-style="--p:${Math.min(1, c.points / top(c)).toFixed(4)}"></span><span class="meter__tick" data-style="--x:50%"></span></span>
      <div class="rkcat__s">${c.filled ? 'Not measured' : val(c, c.value)} of ${val(c, c.par)} par${over > 0 ? ' · past the max' : ''}</div>
      ${note ? html`<details class="rkcat__more"><summary>Why</summary><p>${note}</p></details>` : ''}
    </div>`;
  })}</div>`;
  const hist = [...(r.history || [])].reverse();
  sheet({
    title: r.placed ? r.rank.name : 'Rank',
    body: html`<div class="st-sheet rks">
      ${face && !me ? html`<a class="rks__who press" href="/u/${encodeURIComponent(username)}">${avatar(face)}<span class="rks__whob"><b>${name}</b><small>@${username}</small></span><span class="btn btn--tonal btn--s">View profile</span></a>` : ''}
      ${r.placed ? html`<div class="rks__hero rkc--${r.rank.tier}">${rankBadge(r.rank, { size: 'xl' })}<span class="rks__hr"><b class="n">${f.int(r.rating)}</b><small>level${r.delta !== null ? html` · <span class="rkc__d ${r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}">${signed(r.delta)} last week</span>` : ''}${r.rank.next ? html`<br>${f.int(r.rank.next.left)} to ${r.rank.next.name}` : ''}</small></span></div>`
        : html`<p class="st-lead">${me ? 'You are' : `${name} is`} placed after ${f.plural(r.weeksToPlace, 'more week')} with numbers.</p>`}

      ${weekBlock(r, { full: true, me })}
      <p class="st-lab"><span>Where this week's points come from</span><span class="st-lab__n">${f.int(w.score)} of ${f.int(MAX)}</span></p>
      ${cats(w.cats)}

      ${hist.length ? html`<details class="rks-fold">
        <summary><span>Previous weeks</span><small>${r.last ? `Last week ${f.int(r.last.score)} points` : f.plural(hist.length, 'week')}</small>${ic('chev_d', { size: 's' })}</summary>
        ${hist.length > 1 ? html`<div class="rkh">${raw(historyChart(r.history, lad?.tiers || []))}</div>` : ''}
        <div class="st-grp">${hist.map((h, i) => {
          const prev = hist[i + 1];
          const moved = prev?.rank && h.rank && prev.rank.name !== h.rank.name ? (h.rating > prev.rating ? `Up to ${h.rank.name}` : `Down to ${h.rank.name}`) : '';
          return html`<div class="st-row rkh__r ${moved ? (h.rating > prev.rating ? 'is-up' : 'is-down') : ''}">${rankBadge(h.rank || null, { size: 's' })}
            <span class="st-b"><span class="st-t">${f.dayShort(h.week)} – ${f.dayShort(addDaysCivil(h.week, 6))}${moved ? html` <span class="rkh__mv">${moved}</span>` : ''}</span><span class="st-s">${f.int(h.score)} points · level after: ${h.rank ? h.rank.name : 'placing'}</span></span>
            <span class="rks__r"><b class="n">${f.int(h.rating)}</b>${h.delta !== null ? html`<small class="rkc__d ${h.delta > 0 ? 'is-up' : h.delta < 0 ? 'is-down' : ''}">${signed(h.delta)}</small>` : html`<small>first</small>`}</span></div>`;
        })}</div>
        ${r.last ? html`<p class="rks__why">${whyText(r.last.cats, me ? 'You' : name)}</p>` : ''}
      </details>` : ''}

      <details class="rks-fold">
        <summary><span>How ranks work</span><small>Points, level, the ladder</small>${ic('chev_d', { size: 's' })}</summary>
        <ul class="rks-how">
          <li><b>The one rule:</b> finish a week above your level and your level goes up; below it and it slips. Your level decides your rank (Bronze, Silver, Gold and up, each in three steps).</li>
          <li><b>How far it moves:</b> 30% of the gap. Level 563 and a week of 1,000 points: up 131, to 694. One big week lifts it, one quiet week lets it slip, no single week decides it.</li>
          <li><b>Points come from four things:</b> steps, active minutes, running, and gym and sports. Each gives 400 at par (a strong week for that thing) and up to 800 at twice par. A strong week in all four is ${f.int(1600)}; the most is ${f.int(MAX)}.</li>
          <li><b>The week</b> runs Friday to Thursday. It ends at midnight at the end of your Thursday; the points then count and a new week starts.</li>
          <li><b>Fair to every device:</b> a week counts with ${lad?.minDays || 4} or more days with steps, and fewer than 7 are scaled up. A device without active minutes gets the steps' points for them, at most par.${r.short ? ` ${f.plural(r.short, 'week')} had too few days to count.` : ''}</li>
          <li>Placed after two weeks with numbers. Only what ${me ? 'you share' : 'they share'} counts.</li>
        </ul>
        ${lad ? html`<div class="st-grp rks-lad">${[...lad.tiers].reverse().map((t) => html`<div class="st-row rks-lad__r ${r.rank?.tier === t.tier ? `is-here rkc--${t.tier}` : ''}">
          <span class="st-b"><span class="st-t">${t.label}</span><span class="st-s">${t.tier === 'champion' ? `${f.int(t.at)}: every week at the max` : `From ${f.int(t.at)}`}</span></span>
          <span class="rks-lad__e">${(t.tier === 'champion' ? [null] : ['I', 'II', 'III']).map((d) => html`<span class="rks-lad__d ${r.rank?.tier === t.tier && r.rank?.division === d ? 'is-me' : ''}">${rankBadge({ tier: t.tier, division: d, name: d ? `${t.label} ${d}` : t.label }, { size: 's' })}<small>${r.rank?.tier === t.tier && r.rank?.division === d ? (me ? 'You' : name.split(' ')[0]) : d || ''}</small></span>`)}</span></div>`)}</div>` : ''}
      </details>
    </div>`,
  });
}
const addDaysCivil = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ── honours ─────────────────────────────────────────────────── */

const tallyOf = (t, icon, label) => ['platinum', 'gold', 'silver', 'bronze'].filter((k) => t?.[k] > 0).map((k) => html`<span class="hn__i">${icon === 'groups' ? trophy(k, { size: 's', label: `${TIER_WORD[k]} ${label}` }) : medal(k, icon, { size: 's', label: `${TIER_WORD[k]} ${label}` })}<b class="n">${f.int(t[k])}</b></span>`);

/**
 * Everything from circles in one place, for the Circles view of Awards and the
 * sheet behind somebody else's trophy shelf: the weekly board medals, the goal
 * trophies and what they gave to each goal, and the events.
 */
export function honoursPane(h, { me = true } = {}) {
  const you = me ? 'you' : 'they';
  if (!h) return html`<p class="muted aw-empty">${me ? html`Nothing from circles yet. In a circle, a top-three week on one of its boards wins a medal, and every goal it reaches wins a trophy for everyone who gave to it. <a href="/people?show=circles">Find a circle</a>.` : 'Nothing from circles yet.'}</p>`;
  const sum = (t) => Object.values(t || {}).reduce((a, b) => a + b, 0);
  const bm = h.boardMedals || { gold: 0, silver: 0, bronze: 0 };
  const trophies = sum(h.trophies); const tops = sum(h.top); const evm = sum(h.eventMedals);
  const tile = (k, icon, n, word) => html`<div role="listitem">${medal(k, icon, { size: 'm', label: '' })}<b class="n">${f.int(n)}</b><span>${word}</span></div>`;
  const where = (c) => (c ? ` · ${c.name}` : '');
  const boardRows = (h.boards || []).map((b) => {
    const m = METRIC[b.metric] || { icon: 'medal', fam: 'steps' };
    const inner = html`${medal(PLACE_TIER[b.place], m.icon, { size: 's', label: '' })}<span class="hn__b"><span class="hn__t">${PLACE[b.place][0].toUpperCase()}${PLACE[b.place].slice(1)} on ${b.label}</span><span class="hn__s">Week of ${f.dayShort(b.week)}${where(b.circle)}</span></span><span class="hn__v n">${unitText(b.value, b.unit)}</span>`;
    return b.circle ? html`<a class="hn__ev press fam fam-${m.fam}" href="/circles/${b.circle.id}/hall">${inner}</a>` : html`<div class="hn__ev fam fam-${m.fam}">${inner}</div>`;
  });
  const goalRows = (h.goals || []).map((g) => {
    const m = METRIC[g.metric] || { icon: 'target', fam: 'steps' };
    const when = g.kind === 'week' ? `${f.dayShort(g.start)} to ${f.dayShort(g.end)}` : f.monthYear(g.start);
    const inner = html`${g.tier ? trophy(g.tier, { size: 'm', label: `${TIER_WORD[g.tier]} trophy` }) : html`<span class="hn__evic">${ic('target', { size: 's' })}</span>`}
      <span class="hn__b"><span class="hn__t">${g.label}, ${g.kind === 'week' ? 'weekly goal' : 'monthly goal'}</span>
      <span class="hn__s">${when}${where(g.circle)}</span>
      <span class="hn__s">${g.tier ? `${TIER_WORD[g.tier]} trophy` : 'No trophy'}, ${f.int(g.pct)}%${g.place ? html` · <b class="hn__top hn__top--${PLACE_TIER[g.place]}">${PLACE[g.place] === 'first' ? 'top' : PLACE[g.place] === 'second' ? '2nd' : '3rd'} contributor</b>` : ''}</span></span>
      <span class="hn__v"><b class="n">${unitText(g.value, g.unit)}</b><small class="n">${f.int(g.share * 100)}% of it</small></span>`;
    return g.circle ? html`<a class="hn__ev press fam fam-${m.fam}" href="/circles/${g.circle.id}/goals">${inner}</a>` : html`<div class="hn__ev fam fam-${m.fam}">${inner}</div>`;
  });
  const eventRows = (h.events || []).map((e) => {
    const res = e.mode === 'race' ? (e.place ? `${PLACE[e.place][0].toUpperCase()}${PLACE[e.place].slice(1)} place` : e.finished ? 'Finished' : `${f.int(e.pct)}% done`) : (e.finished ? 'Finished together' : `${f.int(e.pct)}% of the pool`);
    const inner = html`${e.place ? medal(PLACE_TIER[e.place], e.icon, { size: 's', label: '' }) : html`<span class="hn__evic">${ic(e.icon, { size: 's' })}</span>`}<span class="hn__b"><span class="hn__t">${e.label}</span><span class="hn__s">${modeWord(e.mode)} · ${res}${where(e.circle)} · ${f.dayShort(e.end)}</span></span>`;
    return e.circle ? html`<a class="hn__ev press" href="/circles/${e.circle.id}/events/${e.id}">${inner}</a>` : html`<div class="hn__ev">${inner}</div>`;
  });
  return html`
    <div class="aw-top" role="list" aria-label="Board medals">${tile('gold', 'medal', bm.gold, 'gold')}${tile('silver', 'medal', bm.silver, 'silver')}${tile('bronze', 'medal', bm.bronze, 'bronze')}</div>
    <p class="muted small aw-note">Board medals: first, second or third for a week on one of a circle's boards.</p>
    ${boardRows.length ? html`<p class="ach-group"><span>Latest board medals</span><small class="n">${f.plural(sum(bm), 'medal')} in all</small></p><div class="hn__card hn__list">${boardRows.slice(0, 4)}</div>
      ${boardRows.length > 4 ? html`<details class="rkh-all hn__more"><summary><span>${f.int(boardRows.length - 4)} more</span>${ic('chev_d', { size: 's' })}</summary><div class="hn__card hn__list">${boardRows.slice(4)}</div></details>` : ''}` : ''}
    <p class="ach-group"><span>Goals</span><small class="n">${f.plural(h.given || 0, 'goal')} given to</small></p>
    <div class="hn__card">
      <div class="hn__row"><span class="hn__ic hn__ic--tp">${trophy(['platinum', 'gold', 'silver', 'bronze'].find((k) => h.trophies?.[k]) || 'none', { size: 'm', label: '' })}</span><span class="hn__b"><span class="hn__t">${f.plural(trophies, 'trophy', 'trophies')}</span><span class="hn__s">Circle goals ${you} helped reach</span></span><span class="hn__tal">${tallyOf(h.trophies, 'groups', 'trophy')}</span></div>
      <div class="hn__row"><span class="hn__ic hn__ic--tp">${medal(['gold', 'silver', 'bronze'].find((k) => h.top?.[k]) || 'none', 'up', { size: 'm', label: '' })}</span><span class="hn__b"><span class="hn__t">Top contributor ${f.plural(tops, 'time')}</span><span class="hn__s">Gave the most to a goal: first, second or third</span></span><span class="hn__tal">${tallyOf(h.top, 'up', 'top contributor')}</span></div>
    </div>
    ${goalRows.length ? html`<div class="hn__card hn__list">${goalRows.slice(0, 4)}</div>
      ${goalRows.length > 4 ? html`<details class="rkh-all hn__more"><summary><span>${f.plural(goalRows.length - 4, 'more goal')}</span>${ic('chev_d', { size: 's' })}</summary><div class="hn__card hn__list">${goalRows.slice(4)}</div></details>` : ''}` : html`<p class="muted small aw-note">No goal has closed with ${me ? 'your' : 'their'} part in it yet.</p>`}
    ${eventRows.length || h.finishes ? html`<p class="ach-group"><span>Events</span><small class="n">${f.plural(h.finishes, 'finish', 'finishes')}${evm ? ` · ${f.plural(evm, 'medal')}` : ''}</small></p><div class="hn__card hn__list">${eventRows}</div>` : ''}`;
}

/** A person's honours from their circles, for a profile. */
export function honoursCard(h, { me = false } = {}) {
  if (!h) return '';
  const trophies = Object.values(h.trophies).reduce((a, b) => a + b, 0);
  const tops = Object.values(h.top).reduce((a, b) => a + b, 0);
  const evm = Object.values(h.eventMedals).reduce((a, b) => a + b, 0);
  const bms = Object.values(h.boardMedals || {}).reduce((a, b) => a + b, 0);
  const row = (icon, title, sub, t, label) => html`<div class="hn__row"><span class="hn__ic">${ic(icon)}</span><span class="hn__b"><span class="hn__t">${title}</span><span class="hn__s">${sub}</span></span><span class="hn__tal">${tallyOf(t, icon === 'groups' ? 'groups' : icon === 'up' ? 'up' : icon === 'medal' ? 'medal' : 'flag', label)}</span></div>`;
  return html`<section class="hn" aria-label="Circle honours">
    <div class="bsec"><h2>Circle honours</h2></div>
    <div class="hn__card">
      ${bms ? row('medal', f.plural(bms, 'board medal'), 'Top three for a week on a circle board', h.boardMedals, 'board medal') : ''}
      ${trophies ? row('groups', f.plural(trophies, 'trophy', 'trophies'), `Circle goals ${me ? 'you' : 'they'} helped reach`, h.trophies, 'trophy') : ''}
      ${tops ? row('up', `Top contributor ${f.plural(tops, 'time')}`, 'Gave the most to a circle goal: first, second or third', h.top, 'top contributor') : ''}
      ${evm || h.finishes ? row('flag', `${f.plural(h.finishes, 'event')} finished`, evm ? `${f.plural(evm, 'medal')} for a place in the first three` : 'Races and events done together', h.eventMedals, 'event medal') : ''}
      ${h.events.length ? html`<div class="hn__evs">${h.events.map((e) => {
        const res = e.mode === 'race' ? (e.place ? `${PLACE[e.place][0].toUpperCase()}${PLACE[e.place].slice(1)} place` : e.finished ? 'Finished' : `${f.int(e.pct)}% done`) : (e.finished ? 'Finished together' : `${f.int(e.pct)}% of the pool`);
        const inner = html`${e.place ? medal(PLACE_TIER[e.place], e.icon, { size: 's', label: '' }) : html`<span class="hn__evic">${ic(e.icon, { size: 's' })}</span>`}<span class="hn__b"><span class="hn__t">${e.label}</span><span class="hn__s">${modeWord(e.mode)} · ${res}${e.circle ? ` · ${e.circle.name}` : ''} · ${f.dayShort(e.end)}</span></span>`;
        return e.circle ? html`<a class="hn__ev press" href="/circles/${e.circle.id}/events/${e.id}">${inner}</a>` : html`<div class="hn__ev">${inner}</div>`;
      })}</div>` : ''}
    </div>
  </section>`;
}
