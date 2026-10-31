/* The AI conversation, on a screen of its own (/ai?topic=…&id=…&title=…).
   Opened by any "Ask AI" button and by the morning line on Today
   (ai.js, openAi). The page scrolls like every other screen. */

import { html, mount, head } from '../ui.js';
import { mountChat, takeHandoff, TITLES } from '../ai.js';

export default async function aichat(ctx) {
  const { root } = ctx;
  const topic = ctx.query.get('topic') || 'ask';
  const id = ctx.query.get('id') || '';
  const h = takeHandoff(topic, id);
  const title = h?.title || ctx.query.get('title') || TITLES[topic] || 'Ask AI';
  document.title = `${title} · Health`;
  // Back goes where the person came from.
  const back = history.state?.from && history.state.from !== '/ai' ? history.state.from : '/';
  mount(root, html`${head({ title, back })}<div class="aipage" data-chat></div>`);
  mountChat(root.querySelector('[data-chat]'), { topic, id, seed: h?.seed || null, alive: ctx.alive });
}
