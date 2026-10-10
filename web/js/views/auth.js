/* Sign in and create account. The account is the shared ojee.net one, so
   the rules and the messages are the server's (and mtg's). */

import { api } from '../api.js';
import { app, refreshMe, go } from '../app.js';
import { html, mount, ic, field, formValues, fieldError, busy, banner, errText } from '../ui.js';
import { browserTz } from '../format.js';

function safeNext(q) {
  const n = q.get('next');
  return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/auth/') && !n.startsWith('/api/') ? n : '/';
}

export default async function auth({ root, name, query }) {
  const register = name === 'register';
  const next = safeNext(query);
  const nextQ = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  const closed = register && app.me.registrationOpen === false;
  document.title = `${register ? 'Create account' : 'Sign in'} · Health`;

  if (closed) {
    mount(root, html`<div class="narrow">
      <div class="auth__head"><a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a></div>
      <div class="group"><div class="empty">
        <span class="empty__ic">${ic('lock')}</span>
        <h1 class="empty__t" tabindex="-1">Registration is closed</h1>
        <p class="empty__d">Health is not taking new people right now. If you already use it, sign in. Otherwise ask ojee to open registration.</p>
        <a class="btn" href="/signin${nextQ}">Sign in</a>
      </div></div>
    </div>`);
    return;
  }

  mount(root, html`<div class="narrow">
    <div class="auth__head">
      <a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a>
    </div>
    <h1 class="auth__title" tabindex="-1">${register ? 'Create your account' : 'Sign in'}</h1>
    <p class="auth__sub">${register
      ? 'This makes an ojee.net account. It also works on mtg and dnd, and if you already have one there, sign in with it instead.'
      : 'Use your ojee.net account, the same one as mtg and dnd.'}</p>

    <form class="form" id="auth-form" novalidate ${register ? '' : ''}>
      <div data-slot="error"></div>
      ${field({ label: 'Username', name: 'username', attrs: `autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required minlength="2" maxlength="24" enterkeyhint="next"`, hint: register ? '2 to 24 characters.' : '' })}
      ${field({ label: 'Password', name: 'password', type: 'password', attrs: `autocomplete="${register ? 'new-password' : 'current-password'}" required minlength="4" enterkeyhint="go"`, hint: register ? 'At least 4 characters.' : '' })}
      <button class="btn btn--block" type="submit">${register ? 'Create account' : 'Sign in'}</button>
    </form>

    <p class="auth__alt">${register
      ? html`Already have an ojee.net account? <a class="link" href="/signin${nextQ}">Sign in</a>`
      : app.me.registrationOpen === false
        ? 'Registration is closed, so new accounts cannot be made here right now.'
        : html`New here? <a class="link" href="/register${nextQ}">Create an account</a>`}</p>
    ${app.me.demo ? html`<p class="auth__alt muted">Demo mode: the username and password are both demo.</p>` : ''}
  </div>`);

  const form = root.querySelector('#auth-form');
  const slot = form.querySelector('[data-slot="error"]');
  if (matchMedia('(min-width: 600px)').matches) form.elements.username.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    mount(slot, '');
    fieldError(form, 'username', ''); fieldError(form, 'password', '');
    const username = v.username.trim();
    if (!username) { fieldError(form, 'username', 'Enter your username.'); form.elements.username.focus(); return; }
    if (!v.password) { fieldError(form, 'password', 'Enter your password.'); form.elements.password.focus(); return; }
    if (register && (username.length < 2 || username.length > 24)) { fieldError(form, 'username', 'Username must be 2-24 characters'); form.elements.username.focus(); return; }
    if (register && v.password.length < 4) { fieldError(form, 'password', 'Password must be at least 4 characters'); form.elements.password.focus(); return; }

    const btn = form.querySelector('button[type="submit"]');
    try {
      await busy(btn, () => api.post(register ? '/auth/register' : '/auth/login', { username, password: v.password, tz: browserTz() }));
      await refreshMe();
      go(next, { replace: true });
    } catch (err) {
      if (/taken/i.test(err.message)) { fieldError(form, 'username', err.message); form.elements.username.focus(); return; }
      if (err.code === 'closed') { go('/register', { replace: true }); return; }
      mount(slot, banner({ tone: 'bad', title: errText(err, 'Could not sign in. Try again.') }));
      if (err.code === 'bad_login') { form.elements.password.value = ''; form.elements.password.focus(); }
    }
  });
}
