/* What a person agrees to (server/consent.js), asked where it matters:

     before you start   once, before the app is used: the Terms and age (for anyone
                        from before the signup box), health data, and who can see them
                        (a private or public account, chosen, never assumed).
                        One sheet that cannot be closed until it is answered.
     AI                 before the first summary or question: what is sent, to whom,
                        that it can be wrong, and which kinds of data it may read.
                        Changed or turned off again in Me → Privacy → AI. */

import { api } from './api.js';
import { app, refreshMe, onMe } from './app.js';
import { html, sheet, toast, toastError, busy } from './ui.js';

const box = (name, title, sub) => html`<label class="check cn-check"><input type="checkbox" name="${name}" value="1"><span><span class="check__t">${title}</span>${sub ? html`<span class="check__d">${sub}</span>` : ''}</span></label>`;

let asking = false;
/** The one-time sheet, when something is still to be asked. */
async function beforeYouStart(me) {
  const needs = me?.consent?.needs || [];
  if (!needs.length || asking || !me.profile) return;
  asking = true;
  const want = { terms: needs.includes('terms'), health: needs.includes('health'), sharing: !me.consent.sharing };
  const s = sheet({
    title: 'Before you start',
    dismissable: false,
    cls: 'cn-sheet',
    body: html`<div class="cn">
      <p class="cn__lead">rep. is a fitness and wellness app. <b>It is not a medical device and does not give medical advice.</b> Its scores and hints are estimates. See a doctor about symptoms; in an emergency, call your local emergency number.</p>
      ${want.terms ? box('terms', html`I'm 18 or older, and I accept the <a class="link" href="/terms" target="_blank" rel="noopener">Terms</a> and the <a class="link" href="/privacy" target="_blank" rel="noopener">Privacy policy</a>`, '') : ''}
      ${want.health ? box('health', 'rep. may read and keep my health data', 'From the services I connect (Google Health, Health Connect, Garmin, Hevy, Strava and others), kept on rep.\'s server in Egypt, and workouts synced back to them as I choose. To do that, my data goes to those services, which are outside Egypt, and passes through Cloudflare; AI summaries, if I turn them on, go to the AI provider I see named. Never sold, never used for ads. I can export or delete it all in Me → Your data.') : ''}
      ${want.sharing ? html`<fieldset class="cn-who">
        <legend class="cn-who__t">Who can see you</legend>
        <label class="radio cn-who__o"><input type="radio" name="account" value="private"><span><span class="check__t">Private</span><span class="check__d">Only friends you accept, and people in circles you join, see your workouts, posts and totals. Others can find you only by typing your exact username.</span></span></label>
        <label class="radio cn-who__o"><input type="radio" name="account" value="public"><span><span class="check__t">Public</span><span class="check__d">Anyone on rep. can find you and see your workouts, posts and step totals, and you are on the Everyone boards. Signed-out visitors can open your profile.</span></span></label>
        <p class="check__d cn-who__n">Either way, sleep, heart, body and sensitive data (cycle, mood, symptoms, food, ECG) are shared with nobody unless you choose. You can change all of it in Me → Privacy.</p>
      </fieldset>` : ''}
      <p class="cn__err" data-err hidden>Tick each box, and choose who can see you, to go on.</p>
    </div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-out>Sign out</button><button type="button" class="btn" data-go>Continue</button>`,
  });
  s.el.querySelector('[data-out]').addEventListener('click', async () => {
    try { await api.post('/auth/logout', {}); } catch { /* fine */ }
    location.href = '/';
  });
  s.el.querySelector('[data-go]').addEventListener('click', async (e) => {
    const account = s.el.querySelector('[name="account"]:checked')?.value || null;
    const ticked = (n) => (n === 'sharing' ? !!account : !!s.el.querySelector(`[name="${n}"]`)?.checked);
    const missing = Object.keys(want).filter((k) => want[k] && !ticked(k));
    s.el.querySelector('[data-err]').hidden = !missing.length;
    if (missing.length) { s.el.querySelector(missing[0] === 'sharing' ? '.cn-who' : `[name="${missing[0]}"]`)?.closest('label, fieldset')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); s.el.querySelector('[data-err]').scrollIntoView({ block: 'nearest' }); return; }
    try {
      await busy(e.currentTarget, async () => {
        // Public or private: chosen here, not assumed (a new account was public until it chose).
        if (account) await api.patch('/api/settings', { privacy: { account } });
        await api.patch('/api/consent', { terms: true, health: true, sharing: true });
      });
      s.close();
      await refreshMe();
    } catch (err) { toastError(err); }
  });
  await s.closed;
  asking = false;
}

/** Asked on every /api/me: shown once something is to be asked, for the signed-in. */
export function installConsent() {
  // Not before an account from before Google and Apple has linked one (views/auth.js asks that first).
  const check = (me) => { if (!me?.user || !me.profile || me.signin?.linkRequired) return; if (me.suspended) suspended(); else beforeYouStart(me); };
  onMe(check);
  check(app.me);
}

/** Suspended by an admin after reports (server/safety.js): said, and nothing else to do here. */
let toldSuspended = false;
function suspended() {
  if (toldSuspended) return;
  toldSuspended = true;
  const s = sheet({
    title: 'Your account is suspended', dismissable: false, cls: 'cn-sheet',
    body: html`<div class="cn"><p class="cn__lead">After reports, the people who run rep. suspended this account. Nobody sees your posts or comments while it is. If you think this is a mistake, write to <a class="link" href="mailto:contact@ojee.net">contact@ojee.net</a>.</p></div>`,
    foot: html`<button type="button" class="btn" data-out>Sign out</button>`,
  });
  s.el.querySelector('[data-out]').addEventListener('click', async () => { try { await api.post('/auth/logout', {}); } catch { /* fine */ } location.href = '/'; });
}

/**
 * The AI sheet: what goes where, and the kinds it may read. Resolves true when AI is on.
 * `again`: changing what is allowed (from Privacy), with a way to turn it off.
 */
export async function aiConsent({ again = false } = {}) {
  const c = app.me?.consent || {};
  const kinds = c.aiKinds || {};
  const on = c.ai?.allow || null;
  const own = app.me?.ai?.own ? app.me.ai : null;
  const s = sheet({
    title: again ? 'What the AI may read' : 'Turn on AI summaries?',
    cls: 'cn-sheet',
    body: html`<div class="cn">
      <p class="cn__lead">Summaries and answers are written by an AI model. To write them, the numbers and notes you choose below are sent to ${own ? html`<b>${own.label}</b> with your own key (${own.model}), under its terms` : 'OpenCode, which passes them to the model\'s provider'}. Your name and username are never sent, nor anything from Strava.</p>
      <p class="cn__lead">The AI can be wrong. It is not medical advice.${own ? '' : ' Only models whose providers keep nothing and train on nothing are used. You can use your own AI account instead in Me → API and AI.'}</p>
      <div class="cn__kinds">${Object.entries(kinds).map(([k, label]) => html`<label class="check"><input type="checkbox" name="k" value="${k}" ${!on || on[k] ? 'checked' : ''}><span><span class="check__t">${label}</span></span></label>`)}</div>
      <p class="cn__err" data-err hidden>Choose at least one kind, or turn AI off.</p>
    </div>`,
    foot: html`${again && c.ai ? html`<button type="button" class="btn btn--tonal" data-off>Turn AI off</button>` : html`<button type="button" class="btn btn--tonal" data-close>Not now</button>`}<button type="button" class="btn" data-on>${again ? 'Save' : 'Turn on'}</button>`,
  });
  let result = false;
  s.el.querySelector('[data-off]')?.addEventListener('click', async (e) => {
    try { await busy(e.currentTarget, () => api.patch('/api/consent', { ai: null })); await refreshMe(); toast('AI is off'); s.close(); } catch (err) { toastError(err); }
  });
  s.el.querySelector('[data-on]').addEventListener('click', async (e) => {
    const allow = {};
    for (const i of s.el.querySelectorAll('[name="k"]')) allow[i.value] = i.checked;
    const any = Object.values(allow).some(Boolean);
    s.el.querySelector('[data-err]').hidden = any;
    if (!any) return;
    try { await busy(e.currentTarget, () => api.patch('/api/consent', { ai: { allow } })); await refreshMe(); result = true; s.close(); } catch (err) { toastError(err); }
  });
  await s.closed;
  return result;
}

/** Before anything goes to the AI: on already, or turned on now. */
export async function aiReady() {
  if (app.me?.consent?.ai) return true;
  return aiConsent();
}
