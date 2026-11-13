/* A link sent to you (/s/<token>, server/sharelink.js): one routine or route,
   as its owner has it now, with who sent it and a button to add it to your own. */

import { api } from '../api.js';
import { go } from '../app.js';
import { html, mount, ic, head, errorState, skeleton, toast, toastError, busy } from '../ui.js';
import * as f from '../format.js';
import { avatar } from './shared.js';
import { routeMap } from '../map.js';
import { setText } from '../progs.js';
import { thumb } from '../exlib.js';

export default async function link(ctx) {
  const { root } = ctx;
  const token = ctx.params.token;
  let map = null;
  mount(root, html`${head({ title: 'Shared with you', back: '/workouts' })}${skeleton()}`);
  let d;
  try { d = await api.get(`/api/share/${encodeURIComponent(token)}`); } catch (err) {
    if (ctx.alive()) mount(root, html`${head({ title: 'Shared with you', back: '/workouts' })}${errorState(err)}`);
    return;
  }
  if (!ctx.alive()) return;
  const by = d.by && !d.mine ? html`<a class="prg__by sl-by" href="/u/${encodeURIComponent(d.by.username)}">${avatar(d.by)}<span>Sent by <b>${d.by.displayName || d.by.username}</b></span></a>` : '';
  if (d.kind === 'routine') {
    const r = d.routine; const sum = d.summary;
    document.title = `${r.title} · rep.`;
    mount(root, html`${head({ title: r.title, back: '/workouts/routines' })}
      <div class="stack trn-deep sl">
        ${by}
        <p class="muted small">${['Routine', f.plural(sum.exercises, 'exercise'), r.generic ? '' : f.plural(sum.sets, 'set'), `about ${f.dur(sum.estimateMin)}`].filter(Boolean).join(' · ')}</p>
        ${r.notes ? html`<p class="small">${r.notes}</p>` : ''}
        <div class="xrows sl-list">${r.exercises.map((x, i) => html`<div class="xrow xrow--plain sl-x">
          <span class="sl-x__pic">${thumb(x.image)}</span>
          <span class="xrow__b"><span class="xrow__t">${x.name}</span>
            <span class="xrow__d">${r.generic ? '' : x.sets.map((st) => setText(x, st)).filter(Boolean).join(', ') || f.plural(x.sets.length, 'set')}${x.notes ? html`<br>${x.notes}` : ''}</span></span>
          <span class="xrow__v">${i + 1}</span></div>`)}</div>
        <div class="btnrow sl-acts"><button type="button" class="btn" data-copy>${ic('plus', { size: 's' })}${d.mine ? 'Duplicate it' : 'Add to my routines'}</button></div>
        ${d.mine ? html`<p class="muted small">This is your own routine: this is how the people you send the link to see it.</p>` : ''}
      </div>`);
  } else {
    const r = d.route;
    document.title = `${r.title} · rep.`;
    mount(root, html`${head({ title: r.title, back: '/workouts/routes' })}
      <div class="stack sl">
        <div class="rt-hero">
          <div data-map></div>
          <dl class="rt-stats">
            <div><dt>${r.bothWays ? 'There and back' : 'Distance'}</dt><dd>${f.dist(r.distanceM)}</dd></div>
            <div><dt>Climb</dt><dd>${f.isNum(r.climbM) ? `${f.int(r.climbM)} m` : 'Not known'}</dd></div>
            <div><dt>For</dt><dd>${r.sportLabel}</dd></div>
          </dl>
        </div>
        ${by}
        <div class="btnrow rt-acts"><button type="button" class="btn" data-copy>${ic('plus', { size: 's' })}${d.mine ? 'Duplicate it' : 'Save to my routes'}</button></div>
        ${d.mine ? html`<p class="muted small">This is your own route: this is how the people you send the link to see it.</p>` : ''}
      </div>`);
    requestAnimationFrame(() => { const el = root.querySelector('[data-map]'); if (el) map = routeMap(el, { line: r.line, twoWay: r.bothWays, height: 300, label: `Map of ${r.title}, ${f.dist(r.distanceM)}` }); });
  }
  root.querySelector('[data-copy]').addEventListener('click', async (e) => {
    try {
      const c = await busy(e.currentTarget, () => api.post(`/api/share/${encodeURIComponent(token)}/copy`));
      toast(d.kind === 'route' ? 'Saved to your routes. Only you see it.' : 'Added to your routines.');
      go(c.path);
    } catch (err) { toastError(err); }
  });
  ctx.onLeave?.(() => map?.destroy());
}
