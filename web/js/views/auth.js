/* Sign in, create account, and the step an account from before Google and
   Apple takes once (server/signin.js). The provider says who you are; the
   account is the ojee.net one, with the username you chose, so the rules
   and the messages are the server's. */

import { api } from '../api.js';
import { app, refreshMe, go } from '../app.js';
import { html, mount, ic, field, formValues, fieldError, busy, banner, errText } from '../ui.js';
import { browserTz } from '../format.js';
import { providers, providerButtons, bindProviderButtons } from '../signin.js';

function safeNext(q) {
  const n = q.get('next');
  return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/auth/') && !n.startsWith('/api/') ? n : '/';
}

const NAME = { google: 'Google', apple: 'Apple' };
const brandHead = () => html`<div class="auth__head"><a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span><span class="brand__word">rep<i>.</i></span></a></div>`;
/** Back from a provider with an error (?signin=error&message=…): said once, and taken out of the address. */
function errorFromQuery(query) {
  if (query.get('signin') !== 'error') return '';
  const msg = query.get('message') || 'That did not work. Try again.';
  const u = new URL(location.href);
  u.searchParams.delete('signin'); u.searchParams.delete('message');
  history.replaceState(history.state, '', u.pathname + u.search);
  return banner({ tone: 'bad', title: msg });
}

/* ── sign in ─────────────────────────────────────────────────── */

function signinView(root, query) {
  const next = safeNext(query);
  const nextQ = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  document.title = 'Sign in · rep.';
  mount(root, html`<div class="narrow">${brandHead()}
    <h1 class="auth__title" tabindex="-1">Sign in</h1>
    <p class="auth__sub">With the Google or Apple account you use for rep.</p>
    <div data-slot="error">${errorFromQuery(query)}</div>
    ${providerButtons()}
    <p class="auth__alt">${app.me.registrationOpen === false
      ? 'Registration is closed, so new accounts cannot be made here right now.'
      : html`New here? <a class="link" href="/register${nextQ}">Create an account</a>`}</p>
    <details class="auth__more">
      <summary><span class="link">Other ways to sign in</span>${ic('chev_r', { size: 's' })}</summary>
      <form class="form" id="pw-form" novalidate>
        <p class="auth__step">A username and password, for accounts that still have one.</p>
        <div data-slot="pw-error"></div>
        ${field({ label: 'Username', name: 'username', attrs: 'autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required maxlength="24" enterkeyhint="next"' })}
        ${field({ label: 'Password', name: 'password', type: 'password', attrs: 'autocomplete="current-password" required enterkeyhint="go"' })}
        <button class="btn btn--tonal btn--block" type="submit">Sign in with password</button>
      </form>
    </details>
    ${app.me.demo ? html`<p class="auth__alt muted">Demo mode: the stand-in Google and Apple make a new account, or use Other ways to sign in with demo and demo.</p>` : ''}
  </div>`);
  const slot = root.querySelector('[data-slot="error"]');
  bindProviderButtons(root, { next, onError: (err) => mount(slot, banner({ tone: 'bad', title: errText(err, 'Could not sign in. Try again.') })) });

  const form = root.querySelector('#pw-form');
  const pwSlot = form.querySelector('[data-slot="pw-error"]');
  root.querySelector('.auth__more').addEventListener('toggle', (e) => { if (e.target.open) form.elements.username.focus(); });
  // Enter moves from the username to the password while that is empty (some phone keyboards do not submit by themselves).
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input')) return;
    e.preventDefault();
    if (e.target.name === 'username' && !form.elements.password.value) { form.elements.password.focus(); return; }
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    mount(pwSlot, '');
    fieldError(form, 'username', ''); fieldError(form, 'password', '');
    const username = v.username.trim();
    if (!username) { fieldError(form, 'username', 'Enter your username.'); form.elements.username.focus(); return; }
    if (!v.password) { fieldError(form, 'password', 'Enter your password.'); form.elements.password.focus(); return; }
    try {
      await busy(form.querySelector('button[type="submit"]'), () => api.post('/auth/login', { username, password: v.password, tz: browserTz() }));
      await refreshMe();
      go(next, { replace: true });
    } catch (err) {
      mount(pwSlot, banner({ tone: 'bad', title: errText(err, 'Could not sign in. Try again.') }));
      if (err.code === 'bad_login') { form.elements.password.value = ''; form.elements.password.focus(); }
    }
  });
}

/* ── create an account ───────────────────────────────────────── */

function closedView(root, nextQ) {
  mount(root, html`<div class="narrow">${brandHead()}
    <div class="group"><div class="empty">
      <span class="empty__ic">${ic('lock')}</span>
      <h1 class="empty__t" tabindex="-1">Registration is closed</h1>
      <p class="empty__d">rep. is not taking new people right now. If you already use it, sign in. Otherwise ask ojee to open registration.</p>
      <a class="btn" href="/signin${nextQ}">Sign in</a>
    </div></div>
  </div>`);
}

async function registerView(root, query) {
  const next = safeNext(query);
  const nextQ = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  document.title = 'Create account · rep.';
  if (app.me.registrationOpen === false) { closedView(root, nextQ); return; }
  const pending = query.get('pending');
  if (!pending) {
    // First, who you are: Google or Apple. Then the username (below, on the way back).
    mount(root, html`<div class="narrow">${brandHead()}
      <h1 class="auth__title" tabindex="-1">Create your account</h1>
      <p class="auth__sub">Continue with Google or Apple, then pick a username. Nothing else is asked.</p>
      <div data-slot="error">${errorFromQuery(query)}</div>
      ${providerButtons()}
      <p class="auth__alt">Already have an account? <a class="link" href="/signin${nextQ}">Sign in</a></p>
    </div>`);
    const slot = root.querySelector('[data-slot="error"]');
    bindProviderButtons(root, { next, onError: (err) => mount(slot, banner({ tone: 'bad', title: errText(err, 'Could not sign in. Try again.') })) });
    return;
  }
  let who;
  try { who = await api.get(`/auth/signin/pending?k=${encodeURIComponent(pending)}`); } catch (err) {
    mount(root, html`<div class="narrow">${brandHead()}
      <h1 class="auth__title" tabindex="-1">Start again</h1>
      <div data-slot="error">${banner({ tone: 'bad', title: errText(err, 'This sign-up has expired.') })}</div>
      ${providerButtons()}
    </div>`);
    bindProviderButtons(root, { next });
    return;
  }
  mount(root, html`<div class="narrow">${brandHead()}
    <h1 class="auth__title" tabindex="-1">Choose a username</h1>
    <p class="auth__sub">Signed in with ${NAME[who.provider]}${who.email ? html` as <b>${who.email}</b>` : ''}. Your username is how people find you, and it cannot be changed.</p>
    <form class="form" id="auth-form" novalidate>
      <div data-slot="error"></div>
      ${field({ label: 'Username', name: 'username', attrs: 'autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required minlength="2" maxlength="24" enterkeyhint="done"', hint: '2 to 24 characters.' })}
      <label class="check auth__agree"><input type="checkbox" name="accept" value="1" required><span><span class="check__t">I'm 18 or older, and I accept the <a class="link" href="/terms" target="_blank" rel="noopener">Terms</a> and the <a class="link" href="/privacy" target="_blank" rel="noopener">Privacy policy</a></span><span class="check__d">rep. is not a medical device and does not give medical advice.</span></span></label><div data-err="accept"></div>
      <button class="btn btn--block" type="submit">Create account</button>
    </form>
  </div>`);
  const form = root.querySelector('#auth-form');
  const slot = form.querySelector('[data-slot="error"]');
  if (matchMedia('(min-width: 600px)').matches) form.elements.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    mount(slot, '');
    fieldError(form, 'username', ''); fieldError(form, 'accept', '');
    const username = v.username.trim();
    if (username.length < 2 || username.length > 24) { fieldError(form, 'username', 'Username must be 2-24 characters'); form.elements.username.focus(); return; }
    if (!form.elements.accept.checked) { fieldError(form, 'accept', 'Tick the box to go on: you need to be 18 or older and accept the Terms.'); form.elements.accept.focus(); return; }
    try {
      await busy(form.querySelector('button[type="submit"]'), () => api.post('/auth/signin/complete', { pending, username, accept: true, tz: browserTz() }));
      await refreshMe();
      go(next, { replace: true });
    } catch (err) {
      if (/username/i.test(err.message)) { fieldError(form, 'username', err.message); form.elements.username.focus(); return; }
      if (err.code === 'closed') { go('/register', { replace: true }); return; }
      mount(slot, banner({ tone: 'bad', title: errText(err, 'The account could not be made. Try again.'), actions: err.code === 'pending_gone' ? html`<a class="btn btn--s" href="/register">Start again</a>` : err.code === 'identity_taken' ? html`<a class="btn btn--s" href="/signin">Sign in</a>` : '' }));
    }
  });
}

/* ── an account from before Google and Apple ─────────────────── */

function linkView(root, query) {
  document.title = 'Keep signing in · rep.';
  const u = app.me.user.username;
  mount(root, html`<div class="narrow">${brandHead()}
    <h1 class="auth__title" tabindex="-1">Link Google or Apple to keep signing in</h1>
    <p class="auth__sub">rep. no longer uses passwords. Link the Google or Apple account you want to sign in with to <b>@${u}</b>: your username and everything in your account stay as they are.</p>
    <div data-slot="error">${errorFromQuery(query)}</div>
    ${providerButtons()}
    <p class="auth__step">After this, your old password stops working. You can link the other one too, in Settings.</p>
    <p class="auth__alt">Not you? <button type="button" class="link" data-action="signout">Sign out</button></p>
  </div>`);
  const slot = root.querySelector('[data-slot="error"]');
  const next = safeNext(query);
  bindProviderButtons(root, { link: true, back: next, onLinked: () => go(next, { replace: true }), onError: (err) => mount(slot, banner({ tone: 'bad', title: errText(err, 'It could not be linked. Try again.') })) });
}

export default async function auth({ root, name, query }) {
  if (name === 'link') return linkView(root, query);
  if (name === 'register') return registerView(root, query);
  return signinView(root, query);
}

export { providers };
