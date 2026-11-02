/* Sign in and create account. The account is the ojee.net one, so the
   rules and the messages are the server's. */

import { api } from '../api.js';
import { app, refreshMe, go } from '../app.js';
import { html, raw, mount, ic, field, formValues, fieldError, busy, banner, errText } from '../ui.js';
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
    ${register ? html`<p class="auth__sub">Pick a username and a password. That is all it takes.</p>` : ''}

    <form class="form" id="auth-form" novalidate ${register ? '' : ''}>
      <div data-slot="error"></div>
      ${field({ label: 'Username', name: 'username', attrs: `autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required minlength="2" maxlength="24" enterkeyhint="next"`, hint: register ? '2 to 24 characters.' : '' })}
      ${field({ label: 'Password', name: 'password', type: 'password', attrs: `autocomplete="${register ? 'new-password' : 'current-password'}" required minlength="4" enterkeyhint="go"`, hint: register ? 'At least 4 characters.' : '' })}
      ${register && app.me.captcha ? html`<div class="field cap">
        <label class="field__label" for="f-code">Type the numbers you see</label>
        <div class="cap__row">
          <div class="cap__pic" data-slot="cap" role="img" aria-label="Five numbers, drawn by hand"><span class="cap__wait">Loading</span></div>
          <button type="button" class="iconbtn" data-act="cap-new" aria-label="Show different numbers" title="Different numbers">${ic('refresh')}</button>
        </div>
        <input class="input cap__in" id="f-code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="5" autocomplete="off" autocorrect="off" spellcheck="false" required enterkeyhint="go">
        <div data-err="code"></div>
      </div>
      <div class="cap__trap" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>` : ''}
      <button class="btn btn--block" type="submit">${register ? 'Create account' : 'Sign in'}</button>
    </form>

    <p class="auth__alt">${register
      ? html`Already have an account? <a class="link" href="/signin${nextQ}">Sign in</a>`
      : app.me.registrationOpen === false
        ? 'Registration is closed, so new accounts cannot be made here right now.'
        : html`New here? <a class="link" href="/register${nextQ}">Create an account</a>`}</p>
    ${app.me.demo ? html`<p class="auth__alt muted">Demo mode: the username and password are both demo.</p>` : ''}
  </div>`);

  const form = root.querySelector('#auth-form');
  const slot = form.querySelector('[data-slot="error"]');
  // The code to type (server/captcha.js): a new one after every try, right or wrong.
  const capSlot = form.querySelector('[data-slot="cap"]');
  let capToken = '';
  const newCode = async () => {
    if (!capSlot) return;
    capToken = '';
    if (form.elements.code) form.elements.code.value = '';
    try {
      const c = await api.get('/auth/captcha');
      capToken = c.token;
      mount(capSlot, raw(c.svg));
    } catch (err) { mount(capSlot, html`<span class="cap__wait">${errText(err, 'Could not load the numbers.')}</span>`); }
  };
  form.querySelector('[data-act="cap-new"]')?.addEventListener('click', () => { newCode(); form.elements.code.focus(); });
  newCode();
  if (matchMedia('(min-width: 600px)').matches) form.elements.username.focus();

  // Enter (or a phone keyboard's Go / Next) always does something: from the username it moves on to
  // the password while that is empty, otherwise it signs in. Some keyboards in the Android and
  // iPhone apps do not submit a form on Enter by themselves.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input')) return;
    e.preventDefault();
    if (e.target.name === 'username' && !form.elements.password.value) { form.elements.password.focus(); return; }
    if (e.target.name === 'password' && form.elements.code && !form.elements.code.value) { form.elements.code.focus(); return; }
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    mount(slot, '');
    fieldError(form, 'username', ''); fieldError(form, 'password', ''); if (capSlot) fieldError(form, 'code', '');
    const username = v.username.trim();
    if (!username) { fieldError(form, 'username', 'Enter your username.'); form.elements.username.focus(); return; }
    if (!v.password) { fieldError(form, 'password', 'Enter your password.'); form.elements.password.focus(); return; }
    if (register && (username.length < 2 || username.length > 24)) { fieldError(form, 'username', 'Username must be 2-24 characters'); form.elements.username.focus(); return; }
    if (register && v.password.length < 4) { fieldError(form, 'password', 'Password must be at least 4 characters'); form.elements.password.focus(); return; }
    const code = capSlot ? String(v.code || '').replace(/\D/g, '') : '';
    if (capSlot && code.length !== 5) { fieldError(form, 'code', 'Type the five numbers in the picture.'); form.elements.code.focus(); return; }

    const btn = form.querySelector('button[type="submit"]');
    try {
      const body = { username, password: v.password, tz: browserTz() };
      if (capSlot) Object.assign(body, { captcha: { token: capToken, answer: code }, website: v.website || '' });
      await busy(btn, () => api.post(register ? '/auth/register' : '/auth/login', body));
      await refreshMe();
      go(next, { replace: true });
    } catch (err) {
      if (capSlot) newCode();
      if (err.code === 'captcha') { fieldError(form, 'code', err.message); form.elements.code.focus(); return; }
      if (/taken/i.test(err.message)) { fieldError(form, 'username', err.message); form.elements.username.focus(); return; }
      if (err.code === 'closed') { go('/register', { replace: true }); return; }
      mount(slot, banner({ tone: 'bad', title: errText(err, 'Could not sign in. Try again.') }));
      if (err.code === 'bad_login') { form.elements.password.value = ''; form.elements.password.focus(); }
    }
  });
}
