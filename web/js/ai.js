/* AI on the page (server/ai.js).

   aiButton(topic, { id })   a small "Ask AI" button for a section; any of
                             them anywhere opens the conversation (installAi
                             listens once, for the whole app)
   openAi({ topic, id })     the conversation, on its own screen (/ai,
                             views/aichat.js): what it is doing while it
                             works (reading your data, asking a model, for
                             how long), then the answer laid out, follow-up
                             questions to tap, and a box to ask more
   morningCard(el)           Today's morning summary: there when it was
                             written today, written now when it is due
                             (after waking, once last night has synced) */

import { api } from './api.js';
import { html, raw, mount, ic, on, toast } from './ui.js';

const STEP = {
  reading: 'Reading your data',
  asking: 'Thinking',
};

/** The small button a section puts in its header. */
export const aiButton = (topic, { id = '', label = 'Ask AI' } = {}) => html`<button type="button" class="aibtn" data-ai="${topic}" data-ai-id="${id}">${ic('spark', { size: 's' })}<span>${label}</span></button>`;

/** What a waiting job shows; a change in it is worth redrawing, nothing else is. */
const look = (j) => `${j.state}|${j.model || ''}|${j.attempt || ''}|${j.error || ''}`;

/** Follow a job until it is done. `tick(job)` when what it shows changes. */
async function follow(job, tick, { alive = () => true } = {}) {
  let j = job; let shown = look(j);
  tick(j);
  while (alive() && (j.state === 'reading' || j.state === 'asking')) {
    await new Promise((r) => setTimeout(r, 800));
    if (!alive()) return null;
    try { j = await api.get(`/api/ai/${j.id}`); } catch (e) { j = { ...j, state: 'error', error: e.message }; }
    if (look(j) !== shown) { shown = look(j); tick(j); }
  }
  return j;
}

/* The seconds counters count by themselves: only their text changes, so
   the dots and the shimmer never restart. */
let clock = null;
const secsSince = (t) => Math.max(0, Math.round((Date.now() - t) / 1000));
function startClock() {
  if (clock) return;
  clock = setInterval(() => {
    const els = document.querySelectorAll('.aiw__s[data-since]');
    if (!els.length) { clearInterval(clock); clock = null; return; }
    for (const el of els) { const t = `${secsSince(Number(el.dataset.since))} s`; if (el.textContent !== t) el.textContent = t; }
  }, 1000);
}

/** The waiting state: what it is doing, for how long, unmistakably busy. */
const waiting = (j) => j.state === 'reading' || j.state === 'asking';
const stepText = (j) => `${j.state === 'asking' ? `${STEP.asking}${j.model ? ` (${j.model}${j.attempt > 1 ? `, try ${j.attempt}` : ''})` : ''}` : STEP.reading}…`;
const noteText = (j) => (j.state === 'asking' ? 'Free AI models can take 10 to 40 seconds. You can close this; the answer is kept.' : 'Gathering your days, nights, workouts and trends.');
/** Still waiting, only the words changed: change the words, keep the animation running. */
function retext(host, j) {
  const w = host?.querySelector('.aiw:not(.aiw--err)');
  if (!w || !waiting(j)) return false;
  w.querySelector('.aiw__t').textContent = stepText(j);
  w.querySelector('.aiw__note').textContent = noteText(j);
  return true;
}

function thinking(j) {
  const since = j.startedAt || Date.now();
  const what = stepText(j).slice(0, -1);
  queueMicrotask(startClock);
  return html`<div class="aiw" role="status" aria-live="polite">
    <div class="aiw__row"><span class="aiw__dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="aiw__t">${what}…</span><span class="aiw__s" data-since="${since}" aria-hidden="true">${secsSince(since)} s</span></div>
    <div class="aiw__lines" aria-hidden="true"><span></span><span></span><span class="is-short"></span></div>
    <p class="muted small aiw__note">${noteText(j)}</p>
  </div>`;
}

/** An answer, laid out. */
export function answerHtml(a, { model = null } = {}) {
  if (!a) return '';
  return html`<div class="aia">
    ${a.headline ? html`<p class="aia__h">${a.headline}</p>` : ''}
    ${a.summary ? html`<p class="aia__s">${a.summary}</p>` : ''}
    ${a.points?.length ? html`<ul class="aia__p">${a.points.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
    ${model ? html`<p class="aia__m">${ic('spark', { size: 's' })}Written by AI (${model}) from your data. It can be wrong.</p>` : ''}
  </div>`;
}

/**
 * The conversation: a topic's summary, then questions and answers. It is a
 * screen of its own (/ai, views/aichat.js), not a sheet: the page itself
 * scrolls, as every other screen does. (In a sheet, an iPhone would not
 * scroll the answer once it had arrived.)
 *
 * openAi() remembers what to show and goes there; mountChat() draws it.
 */
let handoff = null;
export function openAi({ topic = 'ask', id = '', title = null, seed = null } = {}) {
  handoff = { topic, id, title, seed };
  import('./app.js').then(({ go }) => go(`/ai?topic=${encodeURIComponent(topic)}${id ? `&id=${encodeURIComponent(id)}` : ''}${title ? `&title=${encodeURIComponent(title)}` : ''}`));
}
/** What openAi() asked for, once (a reload starts the topic afresh). */
export function takeHandoff(topic, id) {
  const h = handoff; handoff = null;
  return h && h.topic === topic && (h.id || '') === (id || '') ? h : null;
}

/* Conversations kept while the app is open: back to the same topic the same day, it is
   all still there (questions, answers), not started over. */
const kept = new Map();
const dayKey = () => new Date().toDateString();

/** Draw the conversation into `root`. `alive()` says the screen is still shown. */
export function mountChat(root, { topic = 'ask', id = '', seed = null, alive = () => true, dock = null } = {}) {
  const turns = [];   // { role: 'user' | 'ai', text, answer, job }
  // The box to ask goes in `dock` when given: outside the screen, so the screen's entrance
  // animation never carries it about (a pinned box inside a moving screen moves with it).
  const box = html`<form class="aiq aichat__q" data-ask novalidate><input class="input" name="q" maxlength="500" autocomplete="off" placeholder="Ask about your data" aria-label="Ask about your data"><button type="submit" class="btn btn--s" aria-label="Send">${ic('right', { size: 's' })}</button></form>`;
  mount(root, html`<div class="aic aichat"><div data-turns></div></div>${dock ? '' : box}`);
  if (dock) mount(dock, box);
  const host = dock || root;
  const key = `${topic}|${id}|${dayKey()}`;
  const keep = () => {
    // Only what is settled: a question whose answer is still coming is asked again next time.
    const done = [];
    for (let i = 0; i < turns.length; i += 1) {
      const t = turns[i];
      if (t.role === 'ai' && t.answer) done.push({ role: 'ai', answer: t.answer, model: t.model });
      else if (t.role === 'user' && turns[i + 1]?.answer) done.push({ role: 'user', text: t.text });
    }
    if (done.length) kept.set(key, done);
  };
  const el = root.querySelector('[data-turns]');
  const open = () => alive() && el.isConnected;
  let scrolledFor = 0;
  const draw = () => {
    keep();
    mount(el, html`${turns.map((t, i) => (t.role === 'user'
      ? html`<p class="aic__u">${t.text}</p>`
      : html`<div class="aic__a">${t.job && (t.job.state === 'reading' || t.job.state === 'asking') ? thinking(t.job)
        : t.job?.state === 'error' ? html`<div class="aiw aiw--err"><p>${t.job.error}</p><button type="button" class="btn btn--tonal btn--s" data-retry="${i}">Try again</button></div>`
          : answerHtml(t.answer, { model: t.model })}
        ${t.answer?.followUps?.length && i === turns.length - 1 && t.answer ? html`<div class="aic__f">${t.answer.followUps.map((q) => html`<button type="button" class="chip" data-follow="${q}">${q}</button>`)}</div>` : ''}</div>`))}`);
    // A new question: the page scrolls to it, so its answer starts in view. The first turn is already at the top.
    const items = el.querySelectorAll('.aic__u, .aic__a');
    const last = items[items.length - 1];
    const target = last?.classList.contains('aic__a') && items.length > 1 && items[items.length - 2].classList.contains('aic__u') ? items[items.length - 2] : last;
    if (target && turns.length !== scrolledFor) {
      const first = scrolledFor === 0;
      scrolledFor = turns.length;
      if (!first) window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - 84), behavior: 'smooth' });
    }
  };
  const history = () => turns.filter((t) => t.role === 'user' || t.answer).map((t) => ({ role: t.role, text: t.role === 'user' ? t.text : [t.answer.headline, t.answer.summary, ...(t.answer.points || [])].filter(Boolean).join(' ') }));
  const run = async (body, turn) => {
    try {
      // Keep the moment the person asked, so the counter does not jump back.
      const job = { ...(await api.post('/api/ai', body)), startedAt: turn.job?.startedAt };
      const done = await follow(job, (j) => {
        const was = turn.job;
        turn.job = { ...j, startedAt: was?.startedAt || j.startedAt };
        if (j.state === 'done') { turn.answer = j.answer; turn.model = j.model; }
        if (!open()) return;
        if (was && waiting(was) && retext(el.querySelectorAll('.aic__a')[turns.filter((t) => t.role === 'ai').indexOf(turn)], turn.job)) return;
        draw();
      }, { alive: open });
      if (done?.state === 'done' && open()) draw();
    } catch (e) { turn.job = { state: 'error', error: e.message }; if (open()) draw(); }
  };
  const ask = (q) => {
    const h = history();
    turns.push({ role: 'user', text: q });
    const turn = { role: 'ai', job: { state: 'reading', startedAt: Date.now() } };
    turns.push(turn);
    draw();
    run({ topic: 'ask', question: q, history: h }, turn);
  };
  // Sent: the keyboard goes away, so the answer has the screen.
  const settle = () => { const a = document.activeElement; if (a && host.contains(a) && a.matches('input, textarea')) a.blur(); };
  on(host, 'submit', '[data-ask]', (e, f) => { e.preventDefault(); const q = f.elements.q.value.trim(); if (!q) return; f.elements.q.value = ''; settle(); ask(q); });
  on(root, 'click', '[data-follow]', (e, b) => { settle(); ask(b.dataset.follow); });
  on(root, 'click', '[data-retry]', (e, b) => {
    const i = Number(b.dataset.retry);
    const t = turns[i]; const q = turns[i - 1]?.role === 'user' ? turns[i - 1].text : null;
    t.job = { state: 'reading', startedAt: Date.now() }; draw();
    run(q ? { topic: 'ask', question: q, history: history() } : { topic, id }, t);
  });
  const before = kept.get(key);
  if (before?.length && (!seed || before[0]?.answer?.headline === seed.answer?.headline)) { turns.push(...before.map((t) => ({ ...t }))); scrolledFor = turns.length; draw(); }
  else if (seed) { turns.push({ role: 'ai', answer: seed.answer, model: seed.model }); draw(); }
  else if (topic === 'ask' && !id) {
    // Nothing asked yet: a line, and a few questions to start from.
    mount(el, html`<div class="aic__a"><p class="aia__s">Ask anything about your sleep, activity, heart or workouts. It reads your own numbers.</p>
      <div class="aic__f">${STARTERS.map((q) => html`<button type="button" class="chip" data-follow="${q}">${q}</button>`)}</div></div>`);
  } else {
    const turn = { role: 'ai', job: { state: 'reading', startedAt: Date.now() } };
    turns.push(turn);
    draw();
    run({ topic, id }, turn);
  }
}

/** One listener for every "Ask AI" button in the app. */
export function installAi() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-ai]');
    if (!b) return;
    e.preventDefault();
    openAi({ topic: b.dataset.ai, id: b.dataset.aiId || '', title: b.dataset.aiTitle || TITLES[b.dataset.ai] || 'Ask AI' });
  });
}

const STARTERS = ['How did I sleep this week?', 'Am I more active than last month?', 'What is my resting heart rate doing?'];
export const TITLES = { sleep: 'Last night', readiness: 'Readiness and recovery', activity: 'Today\'s activity', heart: 'Heart', week: 'This week', workout: 'This workout', metric: 'This metric', morning: 'Good morning' };

/**
 * Today's morning summary in `el`: the one written today, or written now
 * when it is due. Quiet when there is nothing to say.
 */
export async function morningCard(el, { alive = () => true } = {}) {
  let m;
  try { m = await api.get('/api/ai/morning'); } catch { return; }
  if (!alive()) return;
  const card = (inner) => html`<section class="aim" aria-label="Morning summary">
    <div class="aim__head"><span class="aim__k">${ic('sun', { size: 's' })}Good morning</span>${inner.more ? html`<button type="button" class="btn btn--ghost btn--s" data-aim-more>${ic('spark', { size: 's' })}Ask more</button>` : ''}</div>
    ${inner.body}
  </section>`;
  const show = (answer, model) => {
    mount(el, card({ more: true, body: html`${answerHtml(answer, { model })}` }));
    el.querySelector('[data-aim-more]')?.addEventListener('click', () => openAi({ topic: 'morning', title: 'Good morning', seed: { answer, model } }));
  };
  if (m.answer) { show(m.answer, m.model); return; }
  if (!m.due || !m.configured) { mount(el, ''); return; }
  let r;
  try { r = await api.post('/api/ai/morning', {}); } catch { mount(el, ''); return; }
  if (r.answer) { show(r.answer, r.model); return; }
  const paint = (j) => { if (!retext(el, j)) mount(el, card({ body: j.state === 'error' ? html`<p class="muted small">${j.error}</p>` : thinking(j) })); };
  const done = await follow(r.job, paint, { alive });
  if (!alive()) return;
  if (done?.state === 'done') show(done.answer, done.model);
  else if (done?.state === 'error') { mount(el, card({ body: html`<p class="muted small">${done.error}</p><button type="button" class="btn btn--tonal btn--s" data-aim-retry>Try again</button>` })); el.querySelector('[data-aim-retry]')?.addEventListener('click', () => morningCard(el, { alive })); }
}

/**
 * Today's one-line morning note (redesign): the summary's headline in the
 * serif, then its first words; tap for the whole summary and a
 * conversation. Without an AI summary, `fallback` ({ lead, text, href })
 * from the brief stands in, or nothing.
 */
/* Today's morning summary as last shown, so coming back to Today draws it at once
   instead of the plain line first and then the summary over it. */
let lastNote = null;   // { day, answer, model }
const noteDay = () => new Date().toDateString();

export async function morningNote(el, { alive = () => true, fallback = null } = {}) {
  const note = (lead, text, attrs = '') => html`<button type="button" class="today-note" ${raw(attrs)}>${ic('spark')}<span>${lead ? html`<b>${lead}</b> ` : ''}${text}</span></button>`;
  const show = (answer, model) => {
    lastNote = { day: noteDay(), answer, model };
    mount(el, note(answer.headline || '', answer.summary || (answer.points || [])[0] || '', 'data-aim-more aria-label="Good morning: open the morning summary"'));
    el.querySelector('[data-aim-more]')?.addEventListener('click', () => openAi({ topic: 'morning', title: 'Good morning', seed: { answer, model } }));
  };
  const plain = () => {
    if (!fallback?.text) { mount(el, ''); return; }
    mount(el, note(fallback.lead || '', fallback.text, 'data-note-ai'));
    el.querySelector('[data-note-ai]')?.addEventListener('click', () => openAi({ topic: 'morning', title: 'Good morning' }));
  };
  // Drawn now, so the tiles below never move when the AI's words arrive: today's summary
  // if it was already shown, else the plain line.
  if (lastNote?.day === noteDay()) show(lastNote.answer, lastNote.model); else plain();
  let m;
  try { m = await api.get('/api/ai/morning'); } catch { return; }
  if (!alive()) return;
  if (m.answer) { if (JSON.stringify(m.answer) !== JSON.stringify(lastNote?.answer)) show(m.answer, m.model); return; }
  // Rewritten since (more of the night arrived) or none any more: the plain line until it is.
  if (lastNote) { lastNote = null; plain(); }
  if (!m.due || !m.configured) return;
  let r;
  try { r = await api.post('/api/ai/morning', {}); } catch { return; }
  if (!alive()) return;
  if (r.answer) { show(r.answer, r.model); return; }
  const done = await follow(r.job, () => {}, { alive });
  if (alive() && done?.state === 'done') show(done.answer, done.model);
}

export { toast };
