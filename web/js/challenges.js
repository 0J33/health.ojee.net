/* Circle goals, events and ranks (server/challenges.js, server/rating.js,
   docs/CHALLENGES.md), as the circle page, its goal and event pages and a
   profile draw them: a goal's card with its trophy road, an event's card,
   the rank badge, the sheet that explains a rank, and a person's honours. */

import { api } from './api.js';
import { html, ic, sheet, on, toast, toastError, busy } from './ui.js';
import * as f from './format.js';
import { avatar, unitText } from './views/shared.js';
import { medal } from './medals.js';
import { METRIC, nameOf } from './views/ranks.js';
import { rankEmblem } from './rankart.js';

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
    <div class="gl-road__marks" aria-hidden="true">${g.tiers.map((t) => html`<span class="gl-road__m ${t.reached ? 'is-on' : ''}" data-style="--x:${roadX(t.pct)}">${medal(t.tier, 'groups', { size: 's', label: '' })}</span>`)}</div>
    <div class="meter meter--l gl-road__bar" aria-hidden="true"><div class="meter__v" data-style="--p:${Math.min(1, g.pct / ROAD_MAX).toFixed(4)}"></div>
      ${g.tiers.map((t) => html`<span class="meter__tick ${t.pct === 100 ? 'meter__tick--goal' : ''}" data-style="--x:${roadX(t.pct)}"></span>`)}
      ${g.pace && g.pace > g.total ? html`<span class="gl-road__pace" data-style="--x:${roadX((g.pace / g.target) * 100)}"></span>` : ''}</div>
  </div>`;
}

/** A goal on the circle page: what, how far, what it earns next, and who gave most. */
export function goalCard(g, { href = '' } = {}) {
  const m = METRIC[g.metric] || { icon: 'target', fam: 'steps' };
  const kick = g.kind === 'week' ? 'This week\'s goal' : 'This month\'s big goal';
  const top = g.people.filter((p) => p.value > 0).slice(0, 3);
  const me = g.people.find((p) => p.me);
  const tag = g.closed ? (g.tier ? `${TIER_WORD[g.tier]} trophy` : 'No trophy') : g.settling ? 'Adding up' : timeLeft(g.endsAt);
  const nextLine = g.closed ? (g.tier ? `Reached ${f.int(g.pct)}%: ${TIER_WORD[g.tier].toLowerCase()} for the circle.` : `Reached ${f.int(g.pct)}%. Bronze needed 50%.`)
    : g.next ? `${TIER_WORD[g.next.tier]} at ${amount(g.next.at, g.unit)}: ${amount(g.next.left, g.unit)} to go.` : 'Platinum: every trophy is won.';
  const inner = html`
    <div class="gl__h">
      <span class="gl__ic">${ic(m.icon)}</span>
      <span class="gl__t"><span class="gl__k">${kick}</span><span class="gl__n">${g.label}</span></span>
      <span class="gl__tag ${g.tier ? `gl__tag--${g.tier}` : ''}">${tag}</span>
    </div>
    <p class="gl__v"><b class="n">${unitText(g.total, g.unit)}</b><span> of ${amount(g.target, g.unit)} · ${f.int(g.pct)}%</span></p>
    ${road(g)}
    <p class="gl__next">${nextLine}${g.pace && !g.closed ? html` <span class="gl__pace">On pace for ${f.int((g.pace / g.target) * 100)}%.</span>` : ''}</p>
    ${top.length ? html`<div class="gl__top">${top.map((p) => html`<span class="gl__who ${p.me ? 'is-me' : ''}">${avatar(p)}<span class="gl__whob"><span class="gl__whon">${who(p)}</span><span class="gl__whov n">${f.int(p.share * 100)}%</span></span></span>`)}</div>` : html`<p class="gl__none">Nobody has a number for it yet. Every bit counts.</p>`}
    ${g.hidden ? html`<p class="gl__me">You are not counted: your ${g.cat === 'workouts' ? 'workouts are' : 'activity is'} kept from your circles (Privacy).</p>`
      : me && !g.closed ? html`<p class="gl__me">You: <b class="n">${amount(me.value, g.unit)}</b>, ${f.int(me.share * 100)}% of it${me.place ? `, ${PLACE[me.place]} in the circle` : ''}.</p>` : ''}`;
  return href ? html`<a class="gl fam fam-${m.fam} press" href="${href}">${inner}</a>` : html`<div class="gl fam fam-${m.fam}">${inner}</div>`;
}

/** Everybody's part in a goal, in order, for its page. */
export function goalPeople(g) {
  if (!g.people.length) return html`<p class="muted small">Nobody is counted for it.</p>`;
  return html`<div class="group">${g.people.map((p, i) => html`<a class="row fr-row gl-row ${p.me ? 'is-me' : ''}" href="/u/${encodeURIComponent(p.username)}">
    <span class="hf-tally__pos n">${i + 1}</span>${avatar(p)}
    <span class="row__body"><span class="row__t">${who(p)}${p.place && g.closed ? html` ${medal(PLACE_TIER[p.place], 'up', { size: 's', label: `Top contributor, ${PLACE[p.place]}` })}` : ''}</span>
      <span class="gl-row__bar"><span class="meter"><span class="meter__v" data-style="--p:${(g.people[0].value ? p.value / g.people[0].value : 0).toFixed(4)}"></span></span></span></span>
    <span class="gl-row__v"><b class="n">${unitText(p.value, g.unit)}</b><small class="n">${f.int(p.share * 100)}%</small></span></a>`)}</div>`;
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
    ? html`<div class="ev__prog"><span class="ev__pl">Together</span><span class="meter"><span class="meter__v" data-style="--p:${Math.min(1, e.team.pct / 100).toFixed(4)}"></span></span><b class="n">${f.int(e.team.pct)}%</b></div>`
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

const signed = (v) => (v > 0 ? `+${f.int(v)}` : v < 0 ? `−${f.int(-v)}` : '±0');

/** The rank on a profile: badge, rating, last week's move, the way to the next step, this week's pace. */
export function rankCard(r, { me = false, name = '' } = {}) {
  if (!r) return '';
  const w = r.week;
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
        <span class="rkc__s"><b class="n">${f.int(r.rating)}</b> rating${r.delta !== null ? html` · <span class="rkc__d ${r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}">${signed(r.delta)} last week</span>` : ''}</span></span>
      ${ic('chev_r', { size: 's' })}</div>
    ${nx ? html`<div class="rkc__road"><span class="rkc__bar"><span class="rkc__fill" data-style="--p:${into.toFixed(4)}"></span></span>
      <span class="rkc__ends"><span>${r.rank.name}</span><span>${nx.name} at ${f.int(nx.at)}: ${f.int(nx.left)} to go</span></span></div>`
      : html`<p class="rkc__next">The top of the ladder. Every week above 2,100 keeps it.</p>`}
    <p class="rkc__week">This week so far: <b class="n">${f.int(w.score)}</b> points. On pace for ${f.int(w.paced)}, which would make it <b class="n">${f.int(w.projected)}</b>${w.projectedRank && w.projectedRank.name !== r.rank.name ? ` (${w.projectedRank.name})` : ''}.</p>
  </button>`;
}

/** The sheet behind a rank: what counts and its points this week, the weeks before, and the ladder. */
export async function rankSheet(r, { me = false, name = '' } = {}) {
  let lad = null;
  try { lad = await api.get('/api/rank/ladder'); } catch { lad = null; }
  const w = r.week;
  const parText = (c) => (c.unit === 'm' ? f.dist(c.par) : unitText(c.par, c.unit));
  sheet({
    title: r.placed ? r.rank.name : 'Rank',
    body: html`<div class="st-sheet rks">
      ${r.placed ? html`<div class="rks__hero rkc--${r.rank.tier}">${rankBadge(r.rank, { size: 'xl' })}<span class="rks__hr"><b class="n">${f.int(r.rating)}</b><small>rating${r.best && r.best > r.rating ? ` · best ${f.int(r.best)}` : ''}</small></span></div>` : ''}
      <p class="st-lead">Every week earns points from four things. Each gives 400 at its par, a strong week, and up to 800 at twice it. The rating moves 30% of the way to each week's points, so one big week lifts it and one quiet week lets it slip, but no week alone decides it.</p>
      <p class="st-lab"><span>This week so far</span><span class="st-lab__n">${f.int(w.score)} points</span></p>
      <div class="st-grp">${w.cats.map((c) => html`<div class="st-row rks__c"><span class="st-b"><span class="st-t">${c.label}</span><span class="st-s">${c.unit === 'm' ? f.dist(c.value) : unitText(c.value, c.unit)} · par ${parText(c)}</span>
        <span class="meter"><span class="meter__v" data-style="--p:${Math.min(1, c.points / 800).toFixed(4)}"></span><span class="meter__tick" data-style="--x:50%"></span></span></span><span class="rks__p n">${f.int(c.points)}</span></div>`)}</div>
      ${r.history?.length ? html`<p class="st-lab"><span>Week by week</span></p>
        <div class="st-grp">${[...r.history].reverse().map((h) => html`<div class="st-row"><span class="st-b"><span class="st-t">${f.dayShort(h.week)}</span><span class="st-s">${f.int(h.score)} points</span></span>
          <span class="rks__r"><b class="n">${f.int(h.rating)}</b>${h.delta !== null ? html`<small class="rkc__d ${h.delta > 0 ? 'is-up' : h.delta < 0 ? 'is-down' : ''}">${signed(h.delta)}</small>` : html`<small>first</small>`}</span></div>`)}</div>` : ''}
      ${lad ? html`<p class="st-lab"><span>The ranks</span></p>
        <div class="st-grp rks-lad">${[...lad.tiers].reverse().map((t) => html`<div class="st-row rks-lad__r ${r.rank?.tier === t.tier ? 'is-here' : ''}">
          <span class="st-b"><span class="st-t">${t.label}</span><span class="st-s">${t.tier === 'champion' ? `${f.int(t.at)} and up` : `From ${f.int(t.at)}: I, II, then III`}</span></span>
          <span class="rks-lad__e">${(t.tier === 'champion' ? [null] : ['I', 'II', 'III']).map((d) => html`<span class="rks-lad__d ${r.rank?.tier === t.tier && r.rank?.division === d ? 'is-me' : ''}">${rankBadge({ tier: t.tier, division: d, name: d ? `${t.label} ${d}` : t.label }, { size: 's' })}${d ? html`<small>${d}</small>` : ''}</span>`)}</span></div>`)}</div>` : ''}
      <p class="st-note">Placed after two weeks with numbers. Only what ${me ? 'you share' : 'they share'} counts: a kind kept to ${me ? 'yourself' : 'themselves'} counts as nothing. Weeks run Friday 12:00 UTC to the next, as on the boards.</p>
    </div>`,
  });
}

/* ── honours ─────────────────────────────────────────────────── */

const tallyOf = (t, icon, label) => ['platinum', 'gold', 'silver', 'bronze'].filter((k) => t?.[k] > 0).map((k) => html`<span class="hn__i">${medal(k, icon, { size: 's', label: `${TIER_WORD[k]} ${label}` })}<b class="n">${f.int(t[k])}</b></span>`);

/** A person's honours from their circles, for a profile. */
export function honoursCard(h, { me = false } = {}) {
  if (!h) return '';
  const trophies = Object.values(h.trophies).reduce((a, b) => a + b, 0);
  const tops = Object.values(h.top).reduce((a, b) => a + b, 0);
  const evm = Object.values(h.eventMedals).reduce((a, b) => a + b, 0);
  const row = (icon, title, sub, t, label) => html`<div class="hn__row"><span class="hn__ic">${ic(icon)}</span><span class="hn__b"><span class="hn__t">${title}</span><span class="hn__s">${sub}</span></span><span class="hn__tal">${tallyOf(t, icon === 'groups' ? 'groups' : icon === 'up' ? 'up' : 'flag', label)}</span></div>`;
  return html`<section class="hn" aria-label="Circle honours">
    <div class="bsec"><h2>Circle honours</h2></div>
    <div class="hn__card">
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
