/* A link to one routine or route, to send to someone (server/sharelink.js).

   The sheet makes the link the first time (the same one after that), and
   offers the phone's own share sheet, Copy, and Turn off (the link stops
   working; a new one can be made). Whoever opens it, signed in, sees the
   routine or route as it is now and can add it to their own (views/link.js). */

import { api } from './api.js';
import { html, mount, ic, sheet, toast, toastError, busy, confirm } from './ui.js';

/**
 * @param {object} o
 * @param {'routine'|'route'} o.kind
 * @param {string} o.base   the thing's API address, e.g. /api/routines/r-…
 * @param {string} o.title  its name, for the share text
 */
export async function shareLinkSheet({ kind, base, title }) {
  let path;
  try { path = (await api.post(`${base}/link`)).path; } catch (err) { toastError(err); return; }
  const what = kind === 'route' ? 'route' : 'routine';
  const s = sheet({
    title: `Send ${title}`,
    body: html`<div class="st-sheet"><div data-body></div></div>`,
  });
  const box = s.el.querySelector('[data-body]');
  const paint = () => {
    const url = path ? `${location.origin}${path}` : null;
    mount(box, url ? html`
      <div class="cc-link"><span class="cc-link__u">${url}</span>
        <div class="btnrow"><button type="button" class="btn btn--s" data-share>${ic('share', { size: 's' })}Share</button><button type="button" class="btn btn--tonal btn--s" data-copy>${ic('copy', { size: 's' })}Copy link</button></div></div>
      <p class="muted small sl-note">Anyone you send it to can open this ${what} once signed in to rep., and add it to their own. They always see it as it is now, with your changes. Nothing else of yours is shown but your name.</p>
      <button type="button" class="btn btn--ghost btn--s sl-off" data-off>${ic('x', { size: 's' })}Turn the link off</button>`
      : html`<p class="muted small sl-note">The link is off: it no longer works for anyone.</p>
      <div class="btnrow"><button type="button" class="btn btn--s" data-new>${ic('link', { size: 's' })}Make a new link</button></div>`);
  };
  paint();
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const url = path ? `${location.origin}${path}` : '';
    if (b.matches('[data-copy]')) {
      try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
    } else if (b.matches('[data-share]')) {
      try {
        if (navigator.share) await navigator.share({ title, text: `${title}: a ${what} on rep.`, url });
        else { await navigator.clipboard.writeText(url); toast('Link copied'); }
      } catch { /* closed */ }
    } else if (b.matches('[data-off]')) {
      if (!(await confirm({ title: 'Turn the link off?', text: 'It stops working for everyone it was sent to. You can make a new one.', yes: 'Turn off', danger: true }))) return;
      try { await busy(b, () => api.del(`${base}/link`)); path = null; paint(); toast('The link is off'); } catch (err) { toastError(err); }
    } else if (b.matches('[data-new]')) {
      try { path = (await busy(b, () => api.post(`${base}/link`))).path; paint(); } catch (err) { toastError(err); }
    }
  });
  await s.closed;
}
