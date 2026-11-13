/* Sign in with Google or Apple (server/signin.js), wherever the page runs.

     website, desktop app   Google and Apple
     iPhone app             Apple, then Google
     Android app            Google

   On the website the page simply goes to the provider and back. Inside the
   apps Google will not sign in, so the system browser does it: a ticket
   from the server, bound to a secret only this page holds, opened outside,
   and asked after every two seconds until the browser side is done. Apple
   in the iPhone app is the phone's own sheet (the SignInWithApple plugin),
   when the app build has it; an older build goes through the browser too. */

import { api } from './api.js';
import { refreshMe, go } from './app.js';
import { html, raw, sheet, toast, toastError, busy } from './ui.js';
import { platform, openOutside, browserName, BrowserName } from './pwa.js';
import { browserTz } from './format.js';

const NAME = { google: 'Google', apple: 'Apple' };
const inApp = () => platform.native || platform.desktop;

/** Which providers this device offers, in order. */
export function providers() {
  if (platform.native && platform.android) return ['google'];
  if (platform.native) return ['apple', 'google'];
  return ['google', 'apple'];
}

/* The marks, as Google and Apple publish them. */
const G_MARK = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>';
const A_MARK = '<svg viewBox="0 0 814 1000" width="16" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>';
export const providerMark = (p) => raw(p === 'google' ? G_MARK : A_MARK);

/** The buttons, in each provider's own look (web/css/app.css .sso). */
export function providerButtons(list = providers()) {
  return html`<div class="sso">${list.map((p) => html`<button type="button" class="sso__btn sso__btn--${p}" data-sso="${p}">
    <span class="sso__mark">${providerMark(p)}</span><span class="sso__t">Continue with ${NAME[p]}</span></button>`)}</div>`;
}

/** The buttons' clicks, in `root`: `opts` as for start(). */
export function bindProviderButtons(root, opts = {}) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sso]');
    if (!b || !root.contains(b)) return;
    busy(b, () => start(b.dataset.sso, opts)).catch((err) => { if (err) (opts.onError || toastError)(err); });
  });
}

/**
 * Sign in (or, with `link`, add this provider to the signed-in account).
 * `next`: where to go once signed in. `back`: where linking returns on the website.
 */
export async function start(provider, { link = false, next = '/', back = '/settings/account', onLinked = null } = {}) {
  if (provider === 'apple' && nativeApple()) return appleNative({ link, next, onLinked });
  if (inApp()) return viaBrowser(provider, { link, next, onLinked });
  const q = link ? new URLSearchParams({ link: '1', return: back }) : new URLSearchParams({ next, tz: browserTz() });
  location.href = `/auth/signin/${provider}/start?${q}`;
  // The page is leaving: the button stays busy until it has.
  return new Promise(() => {});
}

/** The iPhone app's own Apple sheet: only in a build that says it has it, and has the plugin. */
function nativeApple() {
  return platform.native && platform.ios && platform.iosCaps.has('applesignin') && !!window.Capacitor?.Plugins?.SignInWithApple?.authorize;
}

/** What the server said, acted on: signed in, linked, or a username still to choose. */
async function settle(r, { next, onLinked }) {
  if (r.state === 'done') { await refreshMe(); go(next || '/', { replace: true }); return; }
  if (r.state === 'linked') { await refreshMe(); toast(`${NAME[r.provider]} is linked`); onLinked?.(r.provider); return; }
  if (r.state === 'pending') go(`/register?${new URLSearchParams({ pending: r.pending, ...(next && next !== '/' ? { next } : {}) })}`, { replace: true });
}

async function appleNative({ link, next, onLinked }) {
  const n = await api.post('/auth/signin/nonce', {});
  let res;
  try {
    res = await window.Capacitor.Plugins.SignInWithApple.authorize({
      clientId: 'net.ojee.health', redirectURI: `${location.origin}/auth/signin/apple/callback`, scopes: 'email name',
      state: n.nonce.slice(0, 16), nonce: n.hashed,
    });
  } catch (err) {
    // Closed by the person (Apple's code 1001): nothing to say.
    if (/1001|cancel/i.test(String(err?.code || err?.message || ''))) return;
    throw err;
  }
  const token = res?.response?.identityToken;
  if (!token) throw new Error('Apple did not say who you are. Try again.');
  await settle(await api.post('/auth/signin/apple/native', { identityToken: token, nonce: n.nonce, link, tz: browserTz() }), { next, onLinked });
}

/** In an app: the system browser signs in; this page waits for it, and then is signed in itself. */
async function viaBrowser(provider, { link, next, onLinked }) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const t = await api.post('/auth/signin/ticket', { provider, secret, link });
  let stopped = false;
  const s = sheet({
    title: `${link ? 'Link' : 'Continue with'} ${NAME[provider]} in ${browserName()}`,
    body: html`<div class="stack">
      <p class="prose">${NAME[provider]} does not allow signing in from inside an app like this one, so this one step happens in ${browserName()}.</p>
      <ol class="howto">
        <li><span>${BrowserName()} has opened at ${NAME[provider]}. Choose your account there.</span></li>
        <li><span>Come back here: this screen goes on by itself.</span></li>
      </ol>
      <p class="sso-wait" role="status"><span class="sso-wait__dot" aria-hidden="true"></span>Waiting for ${browserName()}</p>
    </div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="button" class="btn" data-reopen>Open ${browserName()} again</button>`,
  });
  s.el.querySelector('[data-reopen]').addEventListener('click', () => openOutside(t.path));
  s.closed.then(() => { stopped = true; });
  openOutside(t.path);
  const until = Date.now() + t.expiresIn * 1000;
  // Back from the browser: asked at once, not at the next tick.
  let wake = null;
  const onVisible = () => { if (document.visibilityState === 'visible') wake?.(); };
  document.addEventListener('visibilitychange', onVisible);
  try {
    while (!stopped && Date.now() < until) {
      await new Promise((r) => { wake = r; setTimeout(r, 2000); });
      if (stopped) return;
      let r;
      try { r = await api.post('/auth/signin/ticket/poll', { ticket: t.ticket, secret, tz: browserTz() }); } catch (err) {
        if (err.offline) continue;
        throw err;
      }
      if (r.state === 'waiting') continue;
      try { window.Capacitor?.Plugins?.Browser?.close?.()?.catch?.(() => {}); } catch { /* none open */ }
      s.close();
      await settle(r, { next, onLinked });
      return;
    }
    if (!stopped) { s.close(); throw new Error('That took too long. Start again.'); }
  } finally { document.removeEventListener('visibilitychange', onVisible); }
}
