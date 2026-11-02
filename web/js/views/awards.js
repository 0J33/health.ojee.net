/* Awards (/workouts/awards): the medals won (gold, silver, bronze, with the
   latest ones) and the achievements, each with the way to its next level.
   A level reached since last seen turns in once, then counts as seen. */

import { api } from '../api.js';
import { html, mount, head, skeleton, errorState } from '../ui.js';
import * as f from '../format.js';
import { medal, medalRow, achGrid, TIER_SAY } from '../medals.js';

export default async function awards(ctx) {
  const { root } = ctx;
  document.title = 'Awards · Health';
  mount(root, html`${head({ title: 'Awards', back: '/workouts' })}${skeleton('page')}`);
  let d;
  try { d = await api.get('/api/achievements'); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Awards', back: '/workouts' })}${errorState(err)}`); return; }
  if (!ctx.alive()) return;
  const m = d.medals || { gold: 0, silver: 0, bronze: 0 };
  const recent = d.recent || [];
  const levels = d.achievements.filter((a) => a.level).length;
  mount(root, html`${head({ title: 'Awards', back: '/workouts', sub: `${f.plural(m.gold + m.silver + m.bronze, 'medal')} · ${f.plural(levels, 'achievement')}` })}
    <div class="stack aw">
      <div class="aw-top" role="list" aria-label="Medals won">
        ${['gold', 'silver', 'bronze'].map((k) => html`<div role="listitem" title="${TIER_SAY[k]}">${medal(k, 'record', { size: 'm' })}<b>${f.int(m[k])}</b><span>${k}</span></div>`)}
      </div>
      <p class="muted small aw-note">Gold beats your best ever, silver your best in a year, bronze your best in 90 days: the heaviest weight, the most reps at a weight, an estimated 1-rep max, the most volume, the longest or fastest run, ride or walk.</p>
      <section class="bsec"><h2>Achievements</h2></section>
      ${achGrid(d.achievements)}
      ${recent.length ? html`<section class="bsec"><h2>Latest medals</h2></section>
        <div class="md-case md-case--list">${recent.slice(0, 20).map((x) => html`<a class="aw-link" href="/workouts/${encodeURIComponent(x.sessionId)}">${medalRow(x)}<span class="aw-when">${f.dayRel(new Date(x.at).toISOString().slice(0, 10))}</span></a>`)}</div>`
        : html`<p class="muted aw-empty">No medals yet. Beat one of your own bests (a heavier set, more reps at a weight, a longer run) and the first one comes.</p>`}
    </div>`);
  // What turned in has been seen.
  if (d.achievements.some((a) => a.fresh)) setTimeout(() => api.post('/api/achievements/seen', {}).catch(() => {}), 1500);
}
