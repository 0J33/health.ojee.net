/* Summary: pick a window, have it written, read it. Says plainly whether a
   model wrote it or the built-in rules did, and why. */

import { api } from '../api.js';
import { app, setMe, listen } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, banner, on, seg, busy, toast, toastError, empty, errText } from '../ui.js';
import * as f from '../format.js';

const LABEL = { night: 'Last night', 7: '7 days', 30: '30 days', 90: '90 days' };
const KEY = 'health.summary.window';

export default async function summary(ctx) {
  const { root } = ctx;
  document.title = 'Summary · Health';
  let d = null; let win = '7'; let poll = null; let failed = null;
  try { const s = localStorage.getItem(KEY); if (s && LABEL[s]) win = s; } catch { /* default */ }

  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };

  function body() {
    const item = d.latest?.[win];
    const running = d.running && String(d.running.window) === win;
    if (running) {
      return html`<section class="panel" aria-busy="true">
        <p class="h3">Writing your summary</p>
        <p class="muted small" data-style="margin:4px 0 14px">${d.ai?.keySet ? 'A free model is reading your numbers. This usually takes under a minute.' : 'Working through your numbers.'}</p>
        <div class="skelstack"><div class="skel skel--line"></div><div class="skel skel--line" data-style="width:92%"></div><div class="skel skel--line" data-style="width:60%"></div></div>
      </section>`;
    }
    if (!item) {
      return html`<div class="group">${empty({
        iconName: 'text', title: `No summary for ${LABEL[win].toLowerCase()} yet`,
        text: 'It reads your sleep, heart, activity and workouts for the period and says what stands out and what to try next.',
        action: html`<button type="button" class="btn" data-action="write">Write summary</button>`,
      })}</div>`;
    }
    const s = item.summary || {};
    const byModel = item.source === 'model';
    return html`<article class="panel">
      <h2 class="h2">${s.headline || 'Summary'}</h2>
      <p class="cap" data-style="margin-top:6px">
        <span class="badge ${byModel ? 'badge--accent' : ''}">${byModel ? 'Written by AI' : 'Written without AI'}</span>
        ${byModel ? (item.model ? ` ${item.model} · ` : ' ') : item.why ? ` ${item.why} · ` : ' '}${f.ago(item.at)}
      </p>
      <div class="prose" data-style="margin-top:16px">
        ${(s.sections || []).map((sec) => html`<h3 class="h3" data-style="margin-top:16px">${sec.title}</h3><p class="sumtext" data-style="margin-top:4px">${sec.text}</p>`)}
        ${s.nextSteps?.length ? html`<h3 class="h3" data-style="margin-top:20px">What to try next</h3><ul class="sumtext" data-style="list-style:disc;padding-left:20px;margin-top:6px;display:grid;gap:4px;white-space:normal">${s.nextSteps.map((n) => html`<li>${n}</li>`)}</ul>` : ''}
        ${s.caveats?.length ? html`<p class="muted small" data-style="margin-top:16px">${s.caveats.join(' ')}</p>` : ''}
      </div>
      <div class="btnrow" data-style="margin-top:20px"><button type="button" class="btn btn--tonal btn--s" data-action="write">${ic('refresh', { size: 's' })}Write it again</button></div>
    </article>
    ${!byModel && !d.ai?.keySet ? banner({ iconName: 'key', title: 'Want it written by AI?', text: 'Add a free OpenCode Zen key and the summary is written by a model instead of fixed rules. It is optional.', actions: html`<a class="btn btn--tonal btn--s" href="/settings/connections">Add a key</a>` }) : ''}`;
  }

  function paint() {
    const wins = (d.windows || ['night', 7, 30, 90]).map((w) => [String(w), LABEL[w] || `${w} days`]);
    if (!wins.some(([id]) => id === win)) win = wins[0][0];
    mount(root, html`
      ${head({ title: 'Summary', back: '/' })}
      <div class="toolbar">${seg('window', wins, win, { label: 'Period' })}</div>
      <div class="stack">
        ${failed ? banner({ tone: 'bad', title: failed }) : ''}
        ${body()}
        <section class="sec">
          <div class="sec__head"><h2 class="h2">About you</h2></div>
          <form class="group group--pad form" id="notes-form">
            <div class="field">
              <label class="field__label" for="f-notes">Things the summary should know</label>
              <textarea class="textarea" id="f-notes" name="notes" maxlength="4000" rows="4" placeholder="Desk job. Gym three days a week. Trying to sleep before midnight.">${d.notes ?? app.me.profile?.notes ?? ''}</textarea>
              <p class="field__hint">Your routine, goals, injuries, anything that explains your numbers. Only you and the summary see this.</p>
            </div>
            <div class="btnrow"><button type="submit" class="btn btn--tonal btn--s">Save notes</button></div>
          </form>
        </section>
      </div>`);
  }

  async function refresh() {
    try {
      d = await api.get('/api/summary');
      if (!d.running) stopPoll();
      if (ctx.alive()) paint();
    } catch { /* keep what is on screen */ }
  }

  function watch() {
    stopPoll();
    if (d.running) poll = setInterval(refresh, 4000);
  }

  on(root, 'click', '[data-seg="window"]', (e, b) => {
    win = b.dataset.value; failed = null;
    try { localStorage.setItem(KEY, win); } catch { /* fine */ }
    paint();
  });
  on(root, 'click', '[data-action="write"]', async (e, btn) => {
    failed = null;
    try {
      const r = await busy(btn, () => api.post('/api/summary', { window: win === 'night' ? 'night' : Number(win) }));
      if (r === undefined) return;
      d = r; paint(); watch();
    } catch (err) {
      failed = err.code === 'needs_google' ? 'There is nothing to summarise yet. Connect Google Health and let it sync first.' : err.status === 409 ? 'A summary is already being written. Give it a moment.' : errText(err, 'The summary could not be written. Try again.');
      paint();
    }
  });
  on(root, 'submit', '#notes-form', async (e, form) => {
    e.preventDefault();
    try {
      const me = await busy(form.querySelector('button'), () => api.patch('/api/profile', { notes: form.elements.notes.value.trim() }));
      if (me === undefined) return;
      setMe(me); d.notes = me.profile?.notes ?? ''; toast('Notes saved');
    } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onLeave(listen('summary', () => refresh()));
  ctx.onLeave(stopPoll);
  ctx.onRefresh(refresh);

  async function load() {
    mount(root, html`${head({ title: 'Summary', back: '/' })}${skeleton('page')}`);
    try { d = await api.get('/api/summary'); if (ctx.alive()) { paint(); watch(); } } catch (err) {
      if (ctx.alive()) mount(root, html`${head({ title: 'Summary', back: '/' })}${errorState(err)}`);
    }
  }
  await load();
}
