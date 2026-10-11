/* Summary: pick a window, have it written, read it. Says plainly whether a
   model wrote it or the built-in rules did, and why. */

import { api } from '../api.js';
import { app, setMe, listen } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, banner, on, seg, busy, toast, toastError, empty, errText } from '../ui.js';
import { ib } from '../kit.js';
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
        <p class="muted small" data-style="margin:4px 0 14px">A free model is reading your numbers. This usually takes under a minute.</p>
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
    const FAMS = { sleep: ['sleep', 'moon'], heart: ['heart', 'heart'], activity: ['steps', 'steps'], weight: ['body', 'scale'], readiness: ['recovery', 'readiness'] };
    return html`<article class="mod sum">
      <header>
        <h2 class="sum__head">${s.headline || 'Summary'}</h2>
        <p class="sum__by">
          <span class="badge ${byModel ? 'badge--accent' : ''}">${ic(byModel ? 'spark' : 'text', { size: 's' })}${byModel ? 'Written by AI' : 'Written without AI'}</span>
          <span>${byModel ? (item.model ? `${item.model} · ` : '') : item.why ? `${item.why} · ` : ''}${f.ago(item.at)}</span>
        </p>
      </header>
      <div class="sum__secs">
        ${(s.sections || []).map((sec) => { const [fam, icon] = FAMS[sec.id] || ['recovery', 'info']; return html`<section class="sum__sec fam fam-${fam}">${ib(icon)}<div><h3 class="sum__t">${sec.title}</h3><p class="sumtext">${sec.text}</p></div></section>`; })}
      </div>
      ${s.nextSteps?.length ? html`<div class="sum__next"><h3 class="sub">What to try next</h3><ul>${s.nextSteps.map((n) => html`<li>${ic('right', { size: 's' })}<span>${n}</span></li>`)}</ul></div>` : ''}
      ${s.caveats?.length ? html`<p class="muted small">${s.caveats.join(' ')}</p>` : ''}
      <div class="btnrow"><button type="button" class="btn btn--tonal btn--s" data-action="write">${ic('refresh', { size: 's' })}Write it again</button></div>
    </article>
    ${!byModel && !d.ai?.keySet ? banner({ iconName: 'key', title: 'Your own key is optional', text: 'Summaries are normally written by free OpenCode models, with nothing to set up. This one was not, for the reason above. If you add your own OpenCode Zen key, it is used first.', actions: html`<a class="btn btn--tonal btn--s" href="/settings/connections">Add your own key</a>` }) : ''}`;
  }

  const notesHint = (text) => (String(text || '').trim() ? 'Notes added. The summary reads them.' : 'No notes yet. Add your routine and goals.');

  /* The frame is mounted once; only the summary inside it is repainted. The
     notes editor is left alone, so it stays open and keeps unsaved text when
     a summary finishes or the period changes. */
  function frame() {
    const notes = d.notes ?? app.me.profile?.notes ?? '';
    mount(root, html`
      ${head({ title: 'Summary', back: '/' })}
      <div class="toolbar" data-bar></div>
      <div class="stack sum-col">
        <div class="stack" data-sum></div>
        <section class="sec">
          <div class="group">
            <details class="acc" data-notes>
              <summary><span class="row__ic">${ic('edit')}</span><span class="row__body"><span class="row__t">Your notes</span><span class="row__d" data-notes-hint>${notesHint(notes)}</span></span><span class="row__chev">${ic('right', { size: 's' })}</span></summary>
              <form class="acc__body acc__body--form form" id="notes-form">
                <div class="field">
                  <label class="field__label" for="f-notes">Things the summary should know</label>
                  <textarea class="textarea" id="f-notes" name="notes" maxlength="4000" rows="4" placeholder="Desk job. Gym three days a week. Trying to sleep before midnight.">${notes}</textarea>
                  <p class="field__hint">Your routine, goals, injuries, anything that explains your numbers. Only you and the summary see this.</p>
                </div>
                <div class="btnrow"><button type="submit" class="btn btn--tonal btn--s">Save notes</button></div>
              </form>
            </details>
          </div>
        </section>
      </div>`);
  }

  function paint() {
    const wins = (d.windows || ['night', 7, 30, 90]).map((w) => [String(w), LABEL[w] || `${w} days`]);
    if (!wins.some(([id]) => id === win)) win = wins[0][0];
    if (!root.querySelector('[data-sum]')) frame();
    mount(root.querySelector('[data-bar]'), seg('window', wins, win, { label: 'Period' }));
    mount(root.querySelector('[data-sum]'), html`${failed ? banner({ tone: 'bad', title: failed }) : ''}${body()}`);
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
      const hint = root.querySelector('[data-notes-hint]');
      if (hint) hint.textContent = notesHint(d.notes);
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
