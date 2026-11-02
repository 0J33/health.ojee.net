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

/* Getting back in without the password (server/passwords.js): your recovery
   code (/forgot), or a one-time link an admin made (/reset?t=…). */
const brandHead = () => html`<div class="auth__head"><a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a></div>`;
const pwFields = () => html`${field({ label: 'New password', name: 'password', type: 'password', attrs: 'autocomplete="new-password" required minlength="4"', hint: 'At least 4 characters. It is your login on mtg.ojee.net and dnd.ojee.net too.' })}
  ${field({ label: 'New password again', name: 'again', type: 'password', attrs: 'autocomplete="new-password" required enterkeyhint="go"' })}`;
function pwCheck(form, v) {
  fieldError(form, 'password', ''); fieldError(form, 'again', '');
  if (v.password.length < 4) { fieldError(form, 'password', 'Password must be at least 4 characters'); form.elements.password.focus(); return false; }
  if (v.password !== v.again) { fieldError(form, 'again', 'The two do not match.'); form.elements.again.focus(); return false; }
  return true;
}
/** Signed in again: the new recovery code (if there is one) before going on. */
function signedIn(root, code) {
  if (!code) { go('/', { replace: true }); return; }
  mount(root, html`<div class="narrow">${brandHead()}
    <h1 class="auth__title" tabindex="-1">You are back in</h1>
    <p class="auth__sub">Your old recovery code is used up. This is your new one: keep it somewhere safe. It is not shown again.</p>
    <p class="rc-code">${code}</p>
    <div class="st-actions"><button type="button" class="btn btn--tonal" data-copy>${ic('copy', { size: 's' })}Copy</button><a class="btn" href="/">I have kept it</a></div>
  </div>`);
  root.querySelector('[data-copy]').addEventListener('click', () => navigator.clipboard?.writeText(code).catch(() => {}));
}

async function forgot(root, query) {
  document.title = 'Forgot password · Health';
  mount(root, html`<div class="narrow">${brandHead()}
    <h1 class="auth__title" tabindex="-1">Forgot your password?</h1>
    <p class="auth__sub">Accounts here have no email or phone number, so there are two ways back in.</p>
    <form class="form" id="fp-form" novalidate>
      <div data-slot="error"></div>
      <p class="auth__step"><b>With your recovery code.</b> You made it in Settings, Account. It looks like K7QF-2MPD-9XWA-H4TC.</p>
      ${field({ label: 'Username', name: 'username', value: query.get('u') || '', attrs: 'autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required' })}
      ${field({ label: 'Recovery code', name: 'code', attrs: 'autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" required' })}
      ${pwFields()}
      <button class="btn btn--block" type="submit">Set the new password</button>
    </form>
    <div class="group auth__other"><div class="row"><span class="row__body"><span class="row__t">No recovery code?</span><span class="row__d">Ask an admin (ojee) for a password link. They make it for your username and send it to you; it works once, for 24 hours.</span></span></div></div>
    <p class="auth__alt"><a class="link" href="/signin">Back to sign in</a></p>
  </div>`);
  const form = root.querySelector('#fp-form');
  const slot = form.querySelector('[data-slot="error"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    mount(slot, '');
    fieldError(form, 'username', ''); fieldError(form, 'code', '');
    if (!v.username.trim()) { fieldError(form, 'username', 'Enter your username.'); return; }
    if (v.code.replace(/[^a-z0-9]/gi, '').length !== 16) { fieldError(form, 'code', 'A recovery code has 16 letters and numbers.'); return; }
    if (!pwCheck(form, v)) return;
    try {
      const r = await busy(form.querySelector('[type="submit"]'), () => api.post('/auth/reset', { username: v.username.trim(), code: v.code, password: v.password, tz: browserTz() }));
      await refreshMe();
      signedIn(root, r.recoveryCode);
    } catch (err) { mount(slot, banner({ tone: 'bad', title: errText(err, 'That did not work. Try again.') })); }
  });
}

async function resetLink(root, query) {
  document.title = 'New password · Health';
  const t = query.get('t') || '';
  let who = null;
  try { who = await api.get(`/auth/reset?t=${encodeURIComponent(t)}`); } catch (err) {
    mount(root, html`<div class="narrow">${brandHead()}<div class="group"><div class="empty">
      <span class="empty__ic">${ic('key')}</span><h1 class="empty__t" tabindex="-1">This link does not work</h1>
      <p class="empty__d">${errText(err, 'It has been used or has run out.')} Ask for a new one.</p>
      <a class="btn" href="/signin">Sign in</a></div></div></div>`);
    return;
  }
  mount(root, html`<div class="narrow">${brandHead()}
    <h1 class="auth__title" tabindex="-1">A new password for @${who.username}</h1>
    <p class="auth__sub">This link works once. Every device signed in to this account is signed out.</p>
    <form class="form" id="rl-form" novalidate><div data-slot="error"></div>${pwFields()}<button class="btn btn--block" type="submit">Set the password and sign in</button></form>
  </div>`);
  const form = root.querySelector('#rl-form');
  form.elements.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    if (!pwCheck(form, v)) return;
    try {
      await busy(form.querySelector('[type="submit"]'), () => api.post('/auth/reset', { token: t, password: v.password, tz: browserTz() }));
      history.replaceState(null, '', '/');
      await refreshMe();
      go('/', { replace: true });
    } catch (err) { mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err, 'That did not work. Try again.') })); }
  });
}

export default async function auth({ root, name, query }) {
  if (name === 'forgot') return forgot(root, query);
  if (name === 'reset') return resetLink(root, query);
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
      ${register ? '' : html`<p class="auth__forgot"><a class="link" href="/forgot" data-forgot>Forgot password?</a></p>`}
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
  // Forgot password: the username typed so far comes along.
  form.querySelector('[data-forgot]')?.addEventListener('click', (e) => { e.preventDefault(); const u = form.elements.username.value.trim(); go(`/forgot${u ? `?u=${encodeURIComponent(u)}` : ''}`); });
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
