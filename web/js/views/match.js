/* Match Google Health: type in what the Google Health app showed for a few
   days (sleep score, readiness, resilience) and this app's own scores are
   fitted to them (server/core/scores.js). Each entry fits again at once,
   and the page shows how close the two now are. */

import { api } from '../api.js';
import { html, mount, ic, on, head, toast, toastError, errorState, skeleton } from '../ui.js';
import * as f from '../format.js';

const RESIL = ['Optimal', 'Balanced', 'Low'];

export default async function match(ctx) {
  const { root } = ctx;
  document.title = 'Match Google Health · Health';
  let d = null; let timer = null;
  const closeness = (m, what) => (m.fitted ? `${what}: matched on ${f.plural(m.n, 'day')}, about ${m.mae} ${m.mae === 1 ? 'point' : 'points'} off on average` : m.n ? `${what}: ${3 - m.n > 0 ? `${3 - m.n} more ${3 - m.n === 1 ? 'day' : 'days'} to start matching` : 'not matched yet'}` : `${what}: no days entered yet`);
  const off = (ours, theirs) => (f.isNum(ours) && f.isNum(theirs) ? html`<span class="mt__d ${Math.abs(ours - theirs) <= 3 ? 'is-close' : ''}">${ours === theirs ? 'same' : `${ours > theirs ? '+' : ''}${ours - theirs}`}</span>` : '');
  const paint = () => {
    const m = d.models;
    mount(root, html`
      ${head({ title: 'Match Google Health', back: '/' })}
      <div class="stack narrow-l">
        <div class="group group--pad"><div class="stack">
          <p class="prose small">Google does not share its sleep score, readiness or resilience with other apps, so this app works them out the way Google describes them. To make them match yours, type in what the Google Health app showed for some days, ideally a week or more. Each one makes the match closer, at once.</p>
          <ul class="mt__fit small">
            <li>${closeness(m.sleep, 'Sleep score')}</li>
            <li>${closeness(m.ready, 'Readiness')}</li>
            <li>${closeness(m.resil, 'Resilience')}</li>
          </ul>
        </div></div>
        <div class="mt" role="table" aria-label="Your scores and Google's, by day">
          <div class="mt__r mt__r--h" role="row"><span>Day</span><span>Sleep score</span><span>Readiness</span><span>Resilience</span></div>
          ${d.days.map((x) => html`<div class="mt__r" role="row" data-date="${x.date}">
            <span class="mt__day">${f.dayRel(x.date)}</span>
            <span class="mt__c"><small class="muted">Here ${x.ours.sleep ?? '–'}</small><input class="input mt__in" inputmode="numeric" data-k="sleep" value="${x.google?.sleep ?? ''}" placeholder="Google" aria-label="Google's sleep score for ${f.dayRel(x.date)}" ${x.ours.sleep === null && !x.google?.sleep ? '' : ''}>${off(x.ours.sleep, x.google?.sleep)}</span>
            <span class="mt__c"><small class="muted">Here ${x.ours.ready ?? '–'}</small><input class="input mt__in" inputmode="numeric" data-k="ready" value="${x.google?.ready ?? ''}" placeholder="Google" aria-label="Google's readiness for ${f.dayRel(x.date)}">${off(x.ours.ready, x.google?.ready)}</span>
            <span class="mt__c"><small class="muted">Here ${x.ours.resilLabel ?? '–'}</small><select class="select mt__in" data-k="resil" aria-label="Google's resilience for ${f.dayRel(x.date)}"><option value="">Google</option>${RESIL.map((r) => html`<option value="${r}" ${x.google?.resil === r ? 'selected' : ''}>${r}</option>`)}</select></span>
          </div>`)}
        </div>
        <p class="muted small">In the Google Health app: Sleep for the sleep score, Readiness on the Today screen, and Health, Mental wellbeing, Resilience. A day can be left partly empty. Clearing a box takes that day's number away again.</p>
      </div>`);
  };
  const load = async () => {
    try { d = await api.get('/api/scores/match?days=21'); if (ctx.alive()) paint(); } catch (err) { mount(root, html`${head({ title: 'Match Google Health', back: '/' })}${errorState(err)}`); }
  };
  const save = async (row) => {
    const body = { date: row.dataset.date, days: 21 };
    for (const el of row.querySelectorAll('[data-k]')) body[el.dataset.k] = el.value.trim() === '' ? null : el.dataset.k === 'resil' ? el.value : Number(el.value);
    try {
      const y = window.scrollY;
      d = await api.put('/api/scores/match', body);
      paint();
      window.scrollTo(0, y);
      toast('Matched');
    } catch (err) { toastError(err); }
  };
  on(root, 'change', '.mt [data-k]', (e, el) => { clearTimeout(timer); timer = setTimeout(() => save(el.closest('[data-date]')), 150); });
  mount(root, html`${head({ title: 'Match Google Health', back: '/' })}${skeleton('page')}`);
  await load();
}
