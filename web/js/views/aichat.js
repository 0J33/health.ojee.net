/* The AI conversation on a page of its own (/ai, and /ai?topic=…&id=… from older links).
   The same conversation as the modal (ai.js): kept on the server, the latest exchange at the
   top of the view, earlier ones above it. The box to ask is pinned to the foot of the screen. */

import { html, mount, head } from '../ui.js';
import { mountChat, TITLES } from '../ai.js';

export default async function aichat(ctx) {
  const { root } = ctx;
  const topic = ctx.query.get('topic') || '';
  const id = ctx.query.get('id') || '';
  const title = ctx.query.get('title') || TITLES[topic] || '';
  document.title = 'Ask AI · rep.';
  const back = history.state?.from && history.state.from !== '/ai' ? history.state.from : '/';
  mount(root, html`${head({ title: 'Ask AI', back, actions: html`<span class="aix-bar" data-tools></span>` })}<div class="aipage" data-chat></div>`);
  const dock = document.createElement('div');
  dock.className = 'aidock';
  document.body.append(dock);
  ctx.onLeave(() => dock.remove());
  // On a wide screen the box sits under the conversation's own column, wherever the page puts it.
  const col = root.querySelector('[data-chat]');
  const fit = () => {
    if (innerWidth < 960) { dock.style.left = ''; dock.style.width = ''; return; }
    const r = col.getBoundingClientRect();
    dock.style.left = `${Math.round(r.left)}px`; dock.style.width = `${Math.round(r.width)}px`;
  };
  requestAnimationFrame(fit);
  addEventListener('resize', fit);
  ctx.onLeave(() => removeEventListener('resize', fit));
  mountChat(root.querySelector('[data-chat]'), {
    alive: ctx.alive, dock, toolbar: root.querySelector('[data-tools]'),
    ask: topic && topic !== 'ask' ? { topic, id, title } : null,
  });
}
