/* Best times (/workouts/best): each standard distance's fastest, and the
   history of every time that record fell.

   Pick the sport (when there is more than one) and the distance; the hero
   says the record, its pace and when it was set; the chart draws every
   effort at that distance with the record stepping down through them
   (faster is higher); the list under it is each record, newest first, with
   how much it took off, and opens its workout.

   From GET /api/best-times (server/medals.js bestTimes): the fastest
   stretch of each GPS track, or a whole session of about the distance. */

import { api } from '../api.js';
import { html, mount, head, skeleton, errorState, on, seg, chart, empty, ic } from '../ui.js';
import * as f from '../format.js';
import { bestTimes as bestChart, clockTime } from '../viz.js';

const SPORT = { run: ['Run', 'run'], ride: ['Ride', 'bike'], walk: ['Walk', 'walk'] };
const KEY = 'health.best.pick';

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
/** Pace per km (or mile) for runs and walks, speed for rides. */
function rate(sport, m, s) {
  if (sport === 'ride') { const kmh = (m / 1000) / (s / 3600); return `${f.dec1(f.distUnit() === 'mi' ? kmh / 1.609344 : kmh)} ${f.distUnit() === 'mi' ? 'mph' : 'km/h'}`; }
  const per = s / (m / 1000) * (f.distUnit() === 'mi' ? 1.609344 : 1);
  return `${clockTime(per)} /${f.distUnit()}`;
}

export default async function best(ctx) {
  const { root } = ctx;
  document.title = 'Best times · Health';
  const top = () => head({ title: 'Best times', back: '/workouts?view=progress' });
  mount(root, html`${top()}${skeleton('page')}`);
  let d;
  try { d = await api.get('/api/best-times'); } catch (err) { if (ctx.alive()) mount(root, html`${top()}${errorState(err)}`); return; }
  if (!ctx.alive()) return;
  const sports = d.sports || [];
  if (!sports.length) {
    mount(root, html`${top()}<div class="stack">${empty({ iconName: 'flag', title: 'No best times yet', text: 'Record a run, ride or walk with GPS (or bring one in from your watch) and its fastest 1 km, 5 km, 10 km and more show here, with every record you break.' })}</div>`);
    return;
  }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const q = ctx.query;
  let sport = sports.find((x) => x.sport === (q?.get('sport') || saved.sport))?.sport || sports[0].sport;
  const distOf = (sp) => sports.find((x) => x.sport === sp).distances;
  // The distance asked for; else the one last looked at; else the 5 km, the classic, or the first there is.
  const pickDist = (sp, want) => { const ds = distOf(sp); return (ds.find((x) => x.m === want) || ds.find((x) => x.m === 5000) || ds[0]).m; };
  let dist = pickDist(sport, Number(q?.get('d') || saved.d));

  function paint() {
    const ds = distOf(sport);
    const x = ds.find((y) => y.m === dist);
    const b = x.best;
    const recs = [...x.records].reverse();
    const first = x.records[0];
    const took = first && b !== first ? first.timeS - b.timeS : 0;
    try { localStorage.setItem(KEY, JSON.stringify({ sport, d: dist })); } catch { /* fine */ }
    history.replaceState(history.state, '', `/workouts/best?sport=${sport}&d=${dist}`);
    mount(root, html`${top()}
      <div class="stack bst-pg">
        ${sports.length > 1 ? html`<div class="bst-sw">${seg('btsport', sports.map((s) => [s.sport, SPORT[s.sport][0]]), sport, { label: 'Sport', fit: true })}</div>` : ''}
        <div class="bst-ds" role="group" aria-label="Distance">${ds.map((y) => html`<button type="button" class="bst-d press" data-d="${y.m}" aria-pressed="${String(y.m === dist)}"><span>${y.label}</span><b class="n">${clockTime(y.best.timeS)}</b></button>`)}</div>
        <section class="bst-hero">
          <p class="bst-hero__k">${ic(SPORT[sport][1], { size: 's' })}Fastest ${x.label.toLowerCase().startsWith('half') || x.label === 'Marathon' ? x.label.toLowerCase() : x.label}</p>
          <p class="bst-hero__v n">${clockTime(b.timeS)}</p>
          <p class="bst-hero__s">${rate(sport, x.m, b.timeS)} · ${f.dayRel(dayOf(b.at))}${b.whole ? ' · the whole run' : ''}</p>
          <div class="bst-hero__f">
            <span><b class="n">${f.int(x.records.length)}</b><small>${x.records.length === 1 ? 'record' : 'records'}</small></span>
            <span><b class="n">${f.int(x.efforts.length)}</b><small>${x.efforts.length === 1 ? 'effort' : 'efforts'}</small></span>
            <span><b class="n">${took ? `−${clockTime(took)}` : f.DASH}</b><small>since the first</small></span>
          </div>
          ${chart((w) => bestChart({ w, efforts: x.efforts, records: x.records, until: Date.now(), go: (i) => `/workouts/${encodeURIComponent(x.efforts[i].id)}`, label: `Your ${x.label} times: ${x.efforts.length} efforts, the record falling ${x.records.length - 1} times to ${clockTime(b.timeS)}.` }), { cls: 'bst-chart' })}
          <p class="bst-hero__note">Higher is faster. The line is your record; each dot on it is a time you beat it.</p>
        </section>
        <div class="bsec"><h2>Each record</h2><span class="hs-s">newest first</span></div>
        <ol class="bst-recs">${recs.map((r, i) => html`<li><a class="bst-rec press" href="/workouts/${encodeURIComponent(r.id)}">
          <span class="bst-rec__dot ${i === 0 ? 'is-now' : ''}" aria-hidden="true">${i === 0 ? ic('record', { size: 's' }) : ''}</span>
          <span class="bst-rec__b"><span class="bst-rec__t">${f.dayRel(dayOf(r.at))}${r.title ? html` <small>· ${r.title}</small>` : ''}</span><span class="bst-rec__s">${rate(sport, x.m, r.timeS)}${r.whole ? ' · the whole run' : ''}</span></span>
          <span class="bst-rec__v"><b class="n">${clockTime(r.timeS)}</b><small class="${r.prevS ? 'is-up' : ''}">${r.prevS ? `−${clockTime(r.prevS - r.timeS)}` : 'First'}</small></span>
          ${ic('chev_r', { size: 's' })}
        </a></li>`)}</ol>
        <p class="muted small bst-foot">The fastest stretch of each run, ride or walk with a GPS track, as your medals count it; a session without one counts when it was about the distance. A time can only be a record against an earlier one.</p>
      </div>`);
  }
  paint();
  on(root, 'click', '[data-seg="btsport"]', (e, b) => { sport = b.dataset.value; dist = pickDist(sport, dist); paint(); });
  on(root, 'click', '[data-d]', (e, b) => { dist = Number(b.dataset.d); paint(); });
}
