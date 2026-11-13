/* AI on the page (server/ai.js, server/aithread.js).

   One conversation per person, kept on the server: the same on every device,
   still there after closing the app, and still being written while nobody looks.

   aiButton(topic, { id })   a small "Ask AI" button for a section; any of them
                             anywhere asks for that section's summary
   openAi({ topic, id })     the conversation in a sheet (a page of its own at /ai
                             for links): the summary asked for is added at the end
                             and shown, older turns above it
   mountChat(root, o)        draws the conversation into a scroller: requests,
                             questions, what the AI is doing (reading, which model,
                             the ones that were busy), answers with what they read,
                             follow-ups, Stop, Clear, and the box to ask
   installAiFab()            the Ask AI button, when switched on (Me): floating on a wide
                             screen; on a phone it is a header button (ui.js head) */

import { api } from './api.js';
import { html, mount, ic, on, toast, toastError, confirm, lockPage, dragToClose } from './ui.js';

/** The small button a section puts in its header. */
export const aiButton = (topic, { id = '', label = 'Ask AI', title = '' } = {}) => html`<button type="button" class="aibtn" data-ai="${topic}" data-ai-id="${id}" data-ai-title="${title}">${ic('spark', { size: 's' })}<span>${label}</span></button>`;

export const TITLES = { sleep: 'Last night', readiness: 'Recovery and load balance', activity: 'Today\'s activity', heart: 'Heart', week: 'This week', workout: 'This workout', metric: 'This metric', morning: 'Good morning', ask: 'Ask AI' };
const STARTERS = ['What should I do today?', 'Why is my recovery low?', 'How can I sleep better this week?', 'Am I training too much?'];

/* ── the answer ──────────────────────────────────────────────────── */

/** An answer, laid out: the takeaway, why, what to do. */
export function answerHtml(a, { model = null, seen = null } = {}) {
  if (!a) return '';
  return html`<div class="aia">
    ${a.headline ? html`<p class="aia__h">${a.headline}</p>` : ''}
    ${a.summary ? html`<p class="aia__s">${a.summary}</p>` : ''}
    ${a.points?.length ? html`<ul class="aia__p">${a.points.map((p) => html`<li><span class="aia__dot" aria-hidden="true"></span><span>${p}</span></li>`)}</ul>` : ''}
    ${seen?.length || model ? html`<div class="aia__foot">
      ${seen?.length ? html`<details class="aia__seen"><summary>${ic('eye', { size: 's' })}What it read <span class="aia__n">${seen.length}</span></summary><ul>${seen.map((x) => html`<li class="${/^Not shared/.test(x) ? 'is-off' : ''}">${x}</li>`)}</ul></details>` : ''}
      ${model ? html`<p class="aia__m">${ic('spark', { size: 's' })}${model} · AI can be wrong</p>` : ''}
    </div>` : ''}
  </div>`;
}

/* ── one turn ────────────────────────────────────────────────────── */

const RUN = new Set(['reading', 'asking']);
const secsSince = (t) => Math.max(0, Math.round((Date.now() - t) / 1000));
const when = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What the person asked: a section's summary (a card unlike a message) or their own words (a bubble). */
function askedHtml(t) {
  if (t.kind === 'question') return html`<div class="aix-q"><p>${t.question}</p><time>${when(t.at)}</time></div>`;
  return html`<div class="aix-req"><span class="aix-req__ic">${ic('spark', { size: 's' })}</span><span class="aix-req__b"><small>Summary asked for</small><b>${t.title || TITLES[t.topic] || 'Summary'}</b></span><time>${when(t.at)}</time></div>`;
}

/** What the AI is doing, step by step, with the models that were busy. */
function workingHtml(t) {
  if (t.state === 'queued') {
    return html`<div class="aix-work is-queued" role="status"><div class="aix-work__row"><span class="aix-work__ic">${ic('clock', { size: 's' })}</span><span class="aix-work__t">Waiting its turn</span></div><p class="aix-work__note">It starts as soon as the one above is answered.</p></div>`;
  }
  const reading = t.state === 'reading';
  const step = (on, done, label, sub = '') => html`<li class="${done ? 'is-done' : on ? 'is-on' : ''}"><span class="aix-step__m" aria-hidden="true">${done ? ic('check', { size: 's' }) : ''}</span><span>${label}${sub ? html`<small>${sub}</small>` : ''}</span></li>`;
  const busy = (t.tries || []).filter((x) => x.kind !== 'ok');
  return html`<div class="aix-work" role="status" aria-live="polite">
    <div class="aix-work__row"><span class="aix-orb" aria-hidden="true"><i></i></span><span class="aix-work__t">${reading ? 'Reading your data' : 'Thinking'}</span><span class="aix-work__s" data-since="${t.startedAt || t.at}">${secsSince(t.startedAt || t.at)} s</span></div>
    <ol class="aix-steps">
      ${step(reading, !reading, 'Reading your data', t.seen?.length ? `${t.seen.length} ${t.seen.length === 1 ? 'part' : 'parts'}` : '')}
      ${step(!reading, false, t.model ? `Asking ${t.model}` : 'Asking an AI model', t.of > 1 ? `try ${t.attempt} of ${t.of}` : '')}
    </ol>
    ${busy.length ? html`<p class="aix-work__tries">${busy.map((x) => html`<span>${x.model} ${x.kind === 'quota' ? 'at its limit' : x.kind === 'invalid' ? 'answered badly' : 'was busy'}</span>`)}</p>` : ''}
    <p class="aix-work__note">${reading ? 'Your days, nights and workouts, as you allowed.' : 'Free models can take 10 to 40 seconds. You can close this: it carries on, and the answer waits here.'}</p>
  </div>`;
}

function turnHtml(t, { last = false } = {}) {
  let reply;
  if (t.state === 'queued' || RUN.has(t.state)) reply = workingHtml(t);
  else if (t.state === 'done') {
    reply = html`<div class="aix-a">${answerHtml(t.answer, { model: t.model ? `${t.model}${t.cached ? ', kept from earlier' : ''}` : null, seen: t.seen })}
      ${last && t.answer?.followUps?.length ? html`<div class="aix-fu">${t.answer.followUps.map((q) => html`<button type="button" class="aix-fu__b" data-follow="${q}">${q}</button>`)}</div>` : ''}</div>`;
  } else {
    const stopped = t.state === 'stopped';
    reply = html`<div class="aix-err ${stopped ? 'is-stopped' : ''}"><p>${stopped ? 'Stopped.' : t.error || 'Something went wrong.'}</p><button type="button" class="btn btn--tonal btn--s" data-retry="${t.id}">${ic('refresh', { size: 's' })}Try again</button></div>`;
  }
  return html`<article class="aix-turn" data-turn="${t.id}">${askedHtml(t)}${reply}</article>`;
}

/* The seconds counters count by themselves: only their text changes. */
let clock = null;
function startClock() {
  if (clock) return;
  clock = setInterval(() => {
    const els = document.querySelectorAll('.aix-work__s[data-since]');
    if (!els.length) { clearInterval(clock); clock = null; return; }
    for (const el of els) { const s = `${secsSince(Number(el.dataset.since))} s`; if (el.textContent !== s) el.textContent = s; }
  }, 1000);
}

/* ── the conversation ────────────────────────────────────────────── */

/**
 * The conversation in `root`. `scroller`: the element that scrolls (the modal's body, or the
 * window for the page). `dock`: where the box to ask goes. `ask`: a section's summary to add
 * ({ topic, id, title }), unless the same was just asked. `onUsing(label)`: who writes answers.
 */
export function mountChat(root, { alive = () => true, dock = null, scroller = null, ask = null, toolbar = null, usingEl = null } = {}) {
  let turns = []; let using = null; let running = false; let firstPaint = true;
  const win = !scroller;
  const scrollEl = scroller || document.scrollingElement;
  mount(root, html`<div class="aix" data-list></div>`);
  const list = root.querySelector('[data-list]');
  const box = html`<form class="aix-ask" data-ask novalidate>
    <textarea class="aix-ask__in" name="q" rows="1" maxlength="500" placeholder="Ask about your data" aria-label="Ask about your data" enterkeyhint="send"></textarea>
    <button type="submit" class="aix-ask__go" aria-label="Send">${ic('up', { size: 's' })}</button>
  </form>`;
  const host = dock || root;
  if (dock) mount(dock, box); else { const slot = document.createElement('div'); root.append(slot); mount(slot, box); }
  const form = host.querySelector('[data-ask]');
  const input = form.elements.q;
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });

  const paintBar = () => {
    if (!toolbar) return;
    // Who writes the answers: under the sheet's title when it has a place for it, else first in the bar.
    const who = html`<span class="aix-using" title="Who writes the answers">${ic('spark', { size: 's' })}<span>${using?.own ? `${using.label}, your account` : 'Free AI models'}</span></span>`;
    if (usingEl) mount(usingEl, who);
    mount(toolbar, html`${usingEl ? '' : who}
      ${running ? html`<button type="button" class="aix-tb aix-tb--stop" data-stop>${ic('stop', { size: 's' })}Stop</button>` : ''}
      ${turns.length ? html`<button type="button" class="aix-tb" data-clear aria-label="Clear the conversation">${ic('trash', { size: 's' })}<span>Clear</span></button>` : ''}`);
  };

  const empty = () => html`<div class="aix-hello">
    <span class="aix-hello__mark" aria-hidden="true">${ic('spark')}</span>
    <p class="aix-hello__t">Ask about your data</p>
    <p class="aix-hello__s">Sleep, recovery, training, habits: it reads your numbers (only the kinds you allowed) and tells you what they mean and what to do.</p>
    <div class="aix-start" role="list">${STARTERS.map((q) => html`<button type="button" class="aix-start__b" role="listitem" data-follow="${q}"><span>${q}</span>${ic('right', { size: 's' })}</button>`)}</div>
  </div>`;

  const scrollToTurn = (id, smooth) => {
    const el = list.querySelector(`[data-turn="${id}"]`);
    if (!el) return;
    if (win) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 76), behavior: smooth ? 'smooth' : 'auto' });
    else scrollEl.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - 40), behavior: smooth ? 'smooth' : 'auto' });
  };

  const draw = ({ focus = null } = {}) => {
    const lastDone = [...turns].reverse().find((t) => t.state === 'done')?.id;
    const earlier = turns.length > 1 ? html`<p class="aix-earlier">${ic('history', { size: 's' })}Earlier in this conversation</p>` : '';
    mount(list, turns.length ? html`${earlier}${turns.map((t, i) => html`${i === turns.length - 1 && turns.length > 1 ? html`<p class="aix-now">Latest</p>` : ''}${turnHtml(t, { last: t.id === lastDone && i === turns.length - 1 })}`)}` : empty());
    if (turns.some((t) => RUN.has(t.state))) queueMicrotask(startClock);
    paintBar();
    // Opened: the latest exchange at the top of the view; what came before is above it, a scroll up away.
    if (firstPaint && turns.length) { firstPaint = false; requestAnimationFrame(() => scrollToTurn(turns.at(-1).id, false)); }
    else if (focus) requestAnimationFrame(() => scrollToTurn(focus, true));
  };

  let timer = 0;
  const load = async ({ focus = null } = {}) => {
    let d;
    try { d = await api.get('/api/ai/thread'); } catch (e) { if (alive()) mount(list, html`<div class="aix-err"><p>${e.message}</p></div>`); return; }
    if (!alive()) return;
    const before = JSON.stringify(turns.map((t) => [t.id, t.state, t.model, t.attempt, (t.tries || []).length, (t.seen || []).length]));
    turns = d.turns || []; using = d.using || null; running = !!d.running;
    const now = JSON.stringify(turns.map((t) => [t.id, t.state, t.model, t.attempt, (t.tries || []).length, (t.seen || []).length]));
    if (before !== now || focus || firstPaint) draw({ focus });
    else paintBar();
    clearTimeout(timer);
    if (running) timer = setTimeout(() => { if (alive()) load(); }, 1500);
  };

  const send = async (body) => {
    try {
      const r = await api.post('/api/ai', body);
      await load({ focus: r.turn?.id || r.id });
    } catch (e) {
      if (e.code === 'ai_consent') {
        const { aiConsent } = await import('./consent.js');
        if (await aiConsent()) return send(body);
        return undefined;
      }
      toastError(e);
    }
    return undefined;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = ''; grow();
    send({ topic: 'ask', question: q });
  });
  on(root, 'click', '[data-follow]', (e, b) => send({ topic: 'ask', question: b.dataset.follow }));
  on(root, 'click', '[data-retry]', async (e, b) => { try { const r = await api.post(`/api/ai/retry/${b.dataset.retry}`, {}); await load({ focus: r.turn?.id }); } catch (err) { toastError(err); } });
  if (toolbar) {
    on(toolbar, 'click', '[data-stop]', async () => { try { await api.post('/api/ai/stop', { all: true }); await load(); } catch (err) { toastError(err); } });
    on(toolbar, 'click', '[data-clear]', async () => {
      if (!(await confirm({ title: 'Clear the conversation?', text: 'Every question and answer goes, on all your devices. Anything still being written is stopped.', yes: 'Clear', danger: true }))) return;
      try { await api.del('/api/ai/thread'); firstPaint = true; await load(); } catch (err) { toastError(err); }
    });
  }
  // Another device asked, or an answer arrived: read again.
  import('./app.js').then(({ listen }) => { const off = listen('changed', (what) => { if (!alive()) { off(); return; } if (what.includes('ai')) load(); }); });

  (async () => {
    await load();
    if (!ask) return;
    // A section's summary: asked for again only if it was not just asked (the same one, in the last 20 minutes).
    const same = [...turns].reverse().find((t) => t.kind === 'section' && t.topic === ask.topic && (t.refId || '') === (ask.id || '') && t.state !== 'error' && t.state !== 'stopped' && Date.now() - t.at < 20 * 60_000);
    if (same) { scrollToTurn(same.id, true); return; }
    await send({ topic: ask.topic, id: ask.id || undefined, title: ask.title });
  })();
  return { focus: () => input.focus(), reload: () => load() };
}

/* ── the sheet ───────────────────────────────────────────────────── */

let modal = null;
/**
 * The conversation over whatever screen is showing, as the app's sheet (ui.js sheet): from the
 * bottom on a phone, with its handle, following the finger down and closing past a third or on a
 * flick; centred on a wide screen. Built by hand because it is more than a sheet's body: a header
 * with who answers and Stop and Clear, the conversation in a scroller of its own (so a phone
 * scrolls it like any list, answers arriving included), and the box to ask pinned under it, kept
 * above the keyboard. The page behind does not scroll.
 */
export function openAi({ topic = 'ask', id = '', title = null } = {}) {
  const ask = topic && topic !== 'ask' ? { topic, id, title: title || TITLES[topic] } : null;
  if (modal?.el?.open) modal.close();
  const opener = document.activeElement;
  const d = document.createElement('dialog');
  d.className = 'sheet aisheet';
  const tid = `ai${Date.now().toString(36)}`;
  d.setAttribute('aria-labelledby', tid);
  mount(d, html`<div class="sheet__grab" aria-hidden="true"></div>
    <header class="sheet__head aisheet__head">
      <span class="aisheet__mark" aria-hidden="true"></span>
      <div class="aisheet__t"><h2 class="sheet__title" id="${tid}" tabindex="-1">Ask AI</h2><p class="aisheet__using" data-using></p></div>
      <div class="aisheet__tools" data-tools></div>
      <button type="button" class="iconbtn" data-close aria-label="Close">${ic('x')}</button>
    </header>
    <div class="aisheet__body" data-scroll><div data-chat></div></div>
    <div class="aisheet__dock" data-dock></div>`);
  document.body.append(d);
  document.documentElement.classList.add('ai-open');
  lockPage(true);
  let open = true;
  // It goes the way it came: down off a phone, fading on a wide screen (shell.css), as every sheet.
  const close = () => {
    if (!d.open || d.classList.contains('is-out')) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { d.close(); return; }
    d.classList.add('is-out');
    setTimeout(() => { if (d.open) d.close(); }, 200);
  };
  const body = d.querySelector('[data-scroll]');
  const unDrag = dragToClose(d, { dismissable: true, close, body });
  // The keyboard: the sheet stands on it rather than under it (iPhone and Android alike move
  // only the visual viewport), so the box to ask and the latest answer stay in view.
  const vv = window.visualViewport;
  const fitKb = () => {
    const kb = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
    const up = kb > 60;
    d.style.setProperty('--kb', `${up ? kb : 0}px`);
    if (up) d.style.setProperty('--avail', `${Math.round(vv.height)}px`); else d.style.removeProperty('--avail');
    d.classList.toggle('is-kb', up);
  };
  vv?.addEventListener('resize', fitKb); vv?.addEventListener('scroll', fitKb);
  body.addEventListener('scroll', () => d.classList.toggle('is-scrolled', body.scrollTop > 2), { passive: true });
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) close(); });
  d.addEventListener('close', () => {
    open = false;
    unDrag();
    vv?.removeEventListener('resize', fitKb); vv?.removeEventListener('scroll', fitKb);
    lockPage(false);
    document.documentElement.classList.remove('ai-open');
    d.remove();
    if (modal?.el === d) modal = null;
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  });
  // The dialog's first focus on its title, never the box: a phone's keyboard would cover the answer.
  d.querySelector('.sheet__title').setAttribute('autofocus', '');
  d.showModal();
  d.querySelector('.sheet__title').focus({ preventScroll: true });
  const chat = mountChat(d.querySelector('[data-chat]'), { alive: () => open, dock: d.querySelector('[data-dock]'), scroller: body, ask, toolbar: d.querySelector('[data-tools]'), usingEl: d.querySelector('[data-using]') });
  // A keyboard on a desktop: straight to the box.
  if (!ask && matchMedia('(hover: hover) and (pointer: fine)').matches) setTimeout(() => chat.focus(), 60);
  modal = { el: d, close };
}
/** The AI page (/ai) kept for links: a page of its own, the same conversation. */
export function takeHandoff() { return null; }

/** One listener for every "Ask AI" button in the app. */
export function installAi() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-ai]');
    if (!b) return;
    e.preventDefault();
    // Off until turned on (consent.js): asked first, and nothing is sent if they say no.
    import('./consent.js').then(async ({ aiReady }) => { if (await aiReady()) openAi({ topic: b.dataset.ai, id: b.dataset.aiId || '', title: b.dataset.aiTitle || TITLES[b.dataset.ai] || 'Ask AI' }); });
  });
  installAiFab();
}

/* ── the floating Ask AI button (Me → App, off unless switched on) ── */

const FAB_KEY = 'health.aifab';
export const aiFabOn = () => { try { return localStorage.getItem(FAB_KEY) === '1'; } catch { return false; } };
export function setAiFab(on) {
  try { if (on) localStorage.setItem(FAB_KEY, '1'); else localStorage.removeItem(FAB_KEY); } catch { /* this device only */ }
  installAiFab();
}
let fab = null;
export function installAiFab() {
  // The floating button is gone: the switch now puts the "Ask AI" pill at the top of each tab (ui.js head).
  const want = false;
  if (!want) { fab?.remove(); fab = null; return; }
  if (fab) return;
  fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'aifab';
  fab.setAttribute('aria-label', 'Ask AI');
  fab.dataset.ai = 'ask';
  mount(fab, html`${ic('spark')}<span class="aifab__t">Ask AI</span>`);
  document.body.append(fab);
}

export { toast };
