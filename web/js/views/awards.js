/* Awards (/workouts/awards): one page, three views under a switch.

     Medals        the count by metal, then each medal by when it was won
                   (this week, this month, earlier), each opening its workout.
     Achievements  how many reached, by metal, then a grid of badges by group;
                   a badge opens its four levels and the way to the next.
     Circles       what circles gave: weekly board medals, goal trophies and
                   each goal's part, top-contributor medals, events (honoursPane).

   Your profile's trophy shelf opens this page; somebody else's opens a sheet
   of what they share, drawn with the same tiles (achTiles, medals.js). A level
   reached since last seen turns in once, then counts as seen. */

import { api } from '../api.js';
import { html, mount, head, skeleton, errorState, on, seg } from '../ui.js';
import * as f from '../format.js';
import { medal, medalRow, achTiles, achSheet, TIER_SAY } from '../medals.js';
import { setPager, riseIn } from '../motion.js';
import { honoursPane } from '../challenges.js';

const TIERS = ['gold', 'silver', 'bronze'];
const KEY = 'health.awards.view';

/** Medals by when they were won: this week, this month, earlier. */
function medalGroups(recent) {
  const now = Date.now();
  const groups = [['This week', []], ['This month', []], ['Earlier', []]];
  for (const m of recent) {
    const age = now - m.at;
    groups[age < 7 * 86_400_000 ? 0 : age < 31 * 86_400_000 ? 1 : 2][1].push(m);
  }
  return groups.filter(([, l]) => l.length);
}

export default async function awards(ctx) {
  const { root } = ctx;
  document.title = 'Awards · Health';
  mount(root, html`${head({ title: 'Awards', back: '/workouts' })}${skeleton('page')}`);
  let d;
  try { d = await api.get('/api/achievements'); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Awards', back: '/workouts' })}${errorState(err)}`); return; }
  if (!ctx.alive()) return;
  const m = d.medals || { gold: 0, silver: 0, bronze: 0 };
  const recent = d.recent || [];
  const ach = d.achievements || [];
  const got = ach.filter((a) => a.level);
  const VIEWS = ['medals', 'achievements', 'circles'];
  const asked = ctx.query?.get('view');
  let view = VIEWS.includes(asked) ? asked : (() => { try { const v = localStorage.getItem(KEY); return VIEWS.includes(v) ? v : 'medals'; } catch { return 'medals'; } })();
  const row = (x) => html`<a class="aw-link" href="/workouts/${encodeURIComponent(x.sessionId)}">${medalRow(x)}<span class="aw-when">${f.dayRel(new Date(x.at).toISOString().slice(0, 10))}</span></a>`;
  const h = d.honours;
  const circleN = h ? ['boardMedals', 'top', 'eventMedals'].reduce((t, k) => t + Object.values(h[k] || {}).reduce((a, b) => a + b, 0), 0) : 0;
  const byLevel = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  for (const a of got) byLevel[a.tier] += 1;

  const medalsPane = () => html`
    <div class="aw-top" role="list" aria-label="Medals won">
      ${TIERS.map((k) => html`<div role="listitem" title="${TIER_SAY[k]}">${medal(k, 'record', { size: 'm' })}<b class="n">${f.int(m[k])}</b><span>${k}</span></div>`)}
    </div>
    <p class="muted small aw-note">A medal is one of your own bests beaten: gold your best ever, silver your best in a year, bronze in 90 days.</p>
    ${recent.length ? medalGroups(recent).map(([t, l]) => html`<p class="ach-group"><span>${t}</span><small class="n">${f.plural(l.length, 'medal')}</small></p>
      <div class="md-case md-case--list">${l.map(row)}</div>`)
      : html`<p class="muted aw-empty">No medals yet. Beat one of your own bests (a heavier set, more reps at a weight, a longer run) and the first one comes.</p>`}`;

  const achPane = () => html`
    <div class="aw-sum">
      <span class="aw-sum__n"><b class="n">${f.int(got.length)}</b><small>of ${f.int(ach.length)} reached</small></span>
      <span class="aw-sum__lv">${['platinum', 'gold', 'silver', 'bronze'].map((k) => html`<span class="aw-sum__i"><i class="aw-dot aw-dot--${k}"></i><b class="n">${f.int(byLevel[k])}</b><small>${k}</small></span>`)}</span>
    </div>
    <p class="muted small aw-note">Every badge has four levels, bronze to platinum. Tap one for what each needs.</p>
    ${achTiles(ach, { own: true })}`;

  /** Show the other view; `from` ('l' | 'r') is the side it comes in from, after a swipe or a tap. */
  function setView(v, from = '') {
    if (v === view) return;
    view = v;
    try { localStorage.setItem(KEY, view); } catch { /* fine */ }
    history.replaceState(history.state, '', `/workouts/awards?view=${view}`);
    paint();
    const pane = root.querySelector('[data-aw-pane]');
    if (pane && from) { pane.classList.add(`pp--in-${from}`); riseIn(pane); }
  }

  function paint() {
    mount(root, html`${head({ title: 'Awards', back: '/workouts', sub: `${f.plural(m.gold + m.silver + m.bronze, 'medal')} · ${f.int(got.length)} of ${f.int(ach.length)} achievements${circleN ? ` · ${f.plural(circleN, 'circle medal')}` : ''}` })}
      <div class="stack aw">
        <div class="aw-switch">${seg('awview', [['medals', 'Medals'], ['achievements', 'Achievements'], ['circles', 'Circles']], view, { label: 'Show' })}</div>
        <div data-aw-pane>${view === 'medals' ? medalsPane() : view === 'achievements' ? achPane() : honoursPane(d.honours, { me: true })}</div>
      </div>`);
  }
  paint();
  on(root, 'click', '[data-seg="awview"]', (e, b) => setView(b.dataset.value, VIEWS.indexOf(b.dataset.value) > VIEWS.indexOf(view) ? 'r' : 'l'));
  // A swipe moves along the three: medals, achievements, circles.
  ctx.onLeave(setPager({
    area: 'body',
    el: () => root.querySelector('[data-aw-pane]'),
    has: (dir) => (dir === 'next' ? VIEWS.indexOf(view) < VIEWS.length - 1 : VIEWS.indexOf(view) > 0),
    go: (dir) => {
      const el = root.querySelector('[data-aw-pane]');
      if (el) { el.style.transition = 'transform 200ms var(--ease), opacity 200ms'; el.style.transform = `translateX(${dir === 'next' ? -40 : 40}%)`; el.style.opacity = '0'; }
      setTimeout(() => setView(VIEWS[VIEWS.indexOf(view) + (dir === 'next' ? 1 : -1)], dir === 'next' ? 'r' : 'l'), 160);
    },
  }));
  on(root, 'click', '[data-ach]', (e, b) => { const a = ach.find((x) => x.id === b.dataset.ach); if (a) achSheet(a, { own: true }); });
  // What turned in has been seen.
  if (ach.some((a) => a.fresh)) setTimeout(() => api.post('/api/achievements/seen', {}).catch(() => {}), 1500);
}
