/* First run: six short steps. Each can be skipped, and the step is saved on
   the server, so closing the tab (or going off to Google) resumes here. */

import { api } from '../api.js';
import { app, setMe, go, ONBOARDING } from '../app.js';
import { html, mount, ic, banner, on, formValues, fieldError, busy, toast, toastError } from '../ui.js';
import { install, platform, push } from '../pwa.js';
import * as f from '../format.js';
import { deviceTips, privacyControls, thisDevice, unitRows } from './settings.js';
import { groupsPicker, pickedGroups } from '../groups.js';
import { appsModule, stGrp, stRow, stLab, stNote } from '../apps.js';

const TITLES = {
  profile: ['Set up your profile', 'How you appear to friends, and how your days are counted.'],
  google: ['Connect Google Health or Garmin', 'Your numbers come from Google Health, where whatever you wear gets to first, or straight from a Garmin watch.'],
  install: ['Put Health on your Home Screen', 'It opens like an app, full screen, and it is the only way to get notifications on an iPhone.'],
  notifications: ['Notifications', 'A few useful nudges, each one optional. Nothing is sent unless you turn it on.'],
  privacy: ['What friends can see', 'Leaderboards are the fun part, but you decide what goes on them.'],
};

export default async function onboarding(ctx) {
  const { root } = ctx;
  const me = app.me;
  if (!me.profile) { go('/', { replace: true }); return; }
  const saved = me.profile.onboarding;
  if (saved === 'done' && !ctx.params.step) { go('/', { replace: true }); return; }
  const step = ONBOARDING.includes(ctx.params.step) ? ctx.params.step : (ONBOARDING.includes(saved) ? saved : 'profile');
  if (ctx.params.step !== step) history.replaceState(history.state, '', `/welcome/${step}`);
  const idx = ONBOARDING.indexOf(step);
  const next = ONBOARDING[idx + 1] || 'done';
  const prev = ONBOARDING[idx - 1] || null;
  document.title = `${TITLES[step][0]} · Health`;

  /** Remember the furthest step reached, then move on. */
  async function advance(btn, extra = {}) {
    const furthest = saved === 'done' ? 'done' : (ONBOARDING.indexOf(saved) > idx && next !== 'done' ? saved : next);
    try {
      const r = await busy(btn, () => api.patch('/api/profile', { ...extra, onboarding: furthest }));
      if (r === undefined) return;
      setMe(r);
      go(next === 'done' ? '/' : `/welcome/${next}`);
      if (next === 'done') toast('You are set up');
    } catch (err) { toastError(err); }
  }

  mount(root, html`<div class="narrow">
    <div class="land__bar">
      <span class="brand"><span class="brand__mark">${ic('pulse')}</span>Health</span>
      <button type="button" class="btn btn--ghost btn--s" data-action="skip-all">Skip setup</button>
    </div>
    <p class="ob__count" data-style="margin-top:16px">Step ${idx + 1} of ${ONBOARDING.length}</p>
    <div class="steps" role="img" aria-label="Step ${idx + 1} of ${ONBOARDING.length}">${ONBOARDING.map((s, i) => html`<span class="steps__i ${i < idx ? 'is-done' : i === idx ? 'is-now' : ''}"></span>`)}</div>
    <h1 class="ob__title" tabindex="-1">${TITLES[step][0]}</h1>
    <p class="ob__lead">${TITLES[step][1]}</p>
    <div class="ob__body" data-body></div>
    <div class="ob__foot">
      <button type="button" class="btn btn--block" data-action="next">${next === 'done' ? 'Finish' : 'Continue'}</button>
      <div class="btnrow" data-style="justify-content:space-between">
        ${prev ? html`<a class="btn btn--ghost btn--s" href="/welcome/${prev}">${ic('left', { size: 's' })}Back</a>` : html`<span></span>`}
        ${next !== 'done' ? html`<button type="button" class="btn btn--ghost btn--s" data-action="skip">Skip for now</button>` : ''}
      </div>
    </div>
  </div>`);

  const body = root.querySelector('[data-body]');
  const nextBtn = root.querySelector('[data-action="next"]');
  let onNext = () => advance(nextBtn);

  on(root, 'click', '[data-action="next"]', () => onNext());
  on(root, 'click', '[data-action="skip"]', (e, btn) => advance(btn));
  on(root, 'click', '[data-action="skip-all"]', async (e, btn) => {
    try {
      const r = await busy(btn, () => api.patch('/api/profile', { onboarding: 'done' }));
      if (r === undefined) return;
      setMe(r); go('/');
      toast('Setup skipped. Everything is in Me when you want it.', { ms: 5000 });
    } catch (err) { toastError(err); }
  });

  /* ── profile ── */
  if (step === 'profile') {
    const p = me.profile;
    const here = f.browserTz();
    const zones = f.listTimeZones();
    const tz = saved === 'profile' ? here : p.tz;   // first visit: trust the browser
    for (const z of [p.tz, here]) if (!zones.includes(z)) zones.unshift(z);
    const units = { volume: 't', weight: 'kg', distance: 'km', temp: 'c', water: 'ml', clock: '24', ...(me.units || {}) };
    mount(body, html`<form id="ob-profile" novalidate>
      ${stLab('You')}
      ${stGrp(html`
        ${stRow({ title: 'Name', sub: 'What friends see', end: html`<input class="st-in ob-in" name="displayName" value="${p.displayName || me.user.username}" required maxlength="40" autocomplete="nickname" aria-label="Display name">` })}
        <div data-err="displayName" class="ob-err"></div>
        ${stRow({ title: 'Time zone', sub: 'Your days follow it', end: html`<select class="st-in ob-in" name="tz" aria-label="Time zone">${zones.map((z) => html`<option value="${z}" ${z === tz ? 'selected' : ''}>${z.replace(/_/g, ' ')}</option>`)}</select>` })}`)}
      ${stLab('Units')}
      ${unitRows(units)}
      ${stNote('You can change any of these later in Me.')}
    </form>`);
    on(body, 'click', '[data-sg^="u-"]', (e, b) => {
      units[b.dataset.sg.slice(2)] = b.dataset.v;
      body.querySelectorAll(`[data-sg="${b.dataset.sg}"]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    const submit = async () => {
      const form = body.querySelector('form');
      const v = formValues(form);
      fieldError(form, 'displayName', '');
      if (!v.displayName.trim()) { fieldError(form, 'displayName', 'Enter a name.'); form.elements.displayName.focus(); return; }
      try {
        await busy(nextBtn, async () => { setMe(await api.patch('/api/settings', { units: { ...units } })); });
        await advance(nextBtn, { displayName: v.displayName.trim(), tz: v.tz });
      } catch (err) { toastError(err); }
    };
    onNext = submit;
    on(body, 'submit', 'form', (e) => { e.preventDefault(); submit(); });
  }

  /* ── google ── */
  if (step === 'google') {
    const g = me.google || {};
    const gq = ctx.query.get('google');
    if (gq) history.replaceState(history.state, '', '/welcome/google');
    const note = gq === 'cancelled' ? banner({ tone: 'warn', title: 'Google was not connected', text: 'You pressed Cancel at Google. Try again when you are ready, or skip this for now.' })
      : gq === 'error' ? banner({ tone: 'bad', title: 'Google could not be connected', text: `${ctx.query.get('message') || 'Something went wrong on the way back from Google.'} Try again.` })
        : '';
    if (g.state === 'ok') {
      mount(body, html`
        ${banner({ tone: 'ok', iconName: 'check', title: 'Google is connected', text: `${g.email ? `Signed in as ${g.email}. ` : ''}The first sync has started; your numbers will be there when you finish.` })}
        ${g.missing?.length ? banner({ iconName: 'key', title: 'Some permissions were not given', text: `${g.missing.join('. ')}. You can reconnect later in Me, Connections.` }) : ''}
        ${stLab('Is your watch or phone sending to Google Health?')}
        ${deviceTips()}`);
    } else if (me.garmin?.connected) {
      mount(body, html`
        ${banner({ tone: 'ok', iconName: 'check', title: 'Garmin is connected', text: 'Garmin accepted your key and the first read has started; your numbers will be there when you finish. You can add Google Health later in Me, Connections.' })}`);
    } else if (g.state === 'unconfigured') {
      mount(body, html`${banner({ tone: 'warn', title: 'Google is not available yet', text: 'The server has not been set up to connect to Google. A Garmin can be connected below; otherwise carry on with the rest.' })}<div data-garmin></div>`);
      appsModule(body.querySelector('[data-garmin]'), { only: 'garmin', onLeave: ctx.onLeave });
    } else {
      mount(body, html`
        ${note}
        <div class="st-cta" data-style="margin-top:4px"><button type="button" class="btn" data-action="connect-google" data-return="/welcome/google">${ic('link', { size: 's' })}Connect Google</button></div>
        ${stNote('Google warns once that it has not verified this app. That is expected: choose Advanced, then "Go to health.ojee.net", and tick every box.')}
        ${stLab('Get your data into Google Health first')}
        ${deviceTips()}
        <div data-style="margin-top:8px">${groupsPicker()}</div>
        <details class="st-more ob-garmin" data-style="margin-top:8px"><summary class="st-grp">${stRow({ icon: 'watch', fam: 'active', title: 'Wear a Garmin?', sub: 'Connect it directly instead', chev: false, end: html`<span class="st-chev">${ic('chev_d', { size: 's' })}</span>` })}</summary><div data-garmin></div></details>`);
      appsModule(body.querySelector('[data-garmin]'), { only: 'garmin', onLeave: ctx.onLeave });
      // What is ticked under "More data" is asked for at Google in the same step.
      on(body, 'change', 'input[name="group"]', () => { body.querySelector('[data-action="connect-google"]').dataset.groups = pickedGroups(body).join(','); });
      nextBtn.textContent = 'Continue without connecting';
      nextBtn.classList.add('btn--tonal');
      root.querySelector('[data-action="skip"]')?.setAttribute('hidden', '');
    }
  }

  /* ── install ── */
  if (step === 'install') {
    const paint = () => {
      const st = install.state();
      let inner;
      if (st === 'native') {
        inner = banner({ tone: 'ok', iconName: 'check', title: 'You have the app', text: `You are using the Health app, so there is nothing to install. Notifications are the one thing it cannot do yet: for those, also add health.ojee.net to your Home Screen from ${platform.android ? 'Chrome' : 'Safari'}.` });
      } else if (st === 'installed') {
        inner = banner({ tone: 'ok', iconName: 'check', title: 'Already installed', text: 'You are using Health from your Home Screen. Nothing to do here.' });
      } else if (st === 'prompt') {
        inner = html`<button type="button" class="btn btn--block" data-action="do-install">${ic('addbox', { size: 's' })}Install Health</button>
          <p class="muted small">Your browser asks you to confirm. It takes no space to speak of and can be removed like any app.</p>`;
      } else if (st === 'ios') {
        inner = html`<ol class="howto">
          <li><span>Tap the <b>Share</b> button ${ic('share', { size: 's', label: 'Share icon' })} in Safari's toolbar.</span></li>
          <li><span>Scroll down and tap <b>Add to Home Screen</b> ${ic('addbox', { size: 's', label: 'Add icon' })}.</span></li>
          <li><span>Tap <b>Add</b>, then open <b>Health</b> from your Home Screen and sign in there.</span></li>
        </ol>
        <p class="muted small">Setup carries on where you left off when you open it from the Home Screen.</p>`;
      } else if (st === 'ios-other') {
        inner = banner({ iconName: 'info', title: 'Open this page in Safari', text: 'On iPhone and iPad, only Safari can add an app to the Home Screen. Open health.ojee.net in Safari, then tap Share and Add to Home Screen.' });
      } else {
        inner = html`<ol class="howto">
          ${platform.android
            ? html`<li><span>Open the browser menu (the three dots).</span></li><li><span>Tap <b>Add to Home screen</b> or <b>Install app</b>.</span></li>`
            : html`<li><span>Look for the install icon at the right of the address bar, or open the browser menu.</span></li><li><span>Choose <b>Install Health</b> (Chrome, Edge) or <b>Add to Dock</b> (Safari).</span></li>`}
          <li><span>Open Health from there next time.</span></li>
        </ol>
        <p class="muted small">This is optional on a computer. On a phone it is worth doing.</p>`;
      }
      mount(body, inner);
      nextBtn.classList.toggle('btn--tonal', st === 'prompt');
    };
    paint();
    ctx.onLeave(install.onChange(() => { if (ctx.alive()) paint(); }));
    on(body, 'click', '[data-action="do-install"]', async () => {
      const r = await install.prompt();
      if (r === 'accepted') toast('Installed');
      paint();
    });
  }

  /* ── notifications ── */
  if (step === 'notifications') {
    const state = push.support();
    mount(body, html`
      ${state === 'native' || (platform.ios && state === 'needs-install') ? '' : html`${stLab('What you can get')}${stGrp(html`
        ${stRow({ icon: 'strength', fam: 'energy', title: 'Workouts', sub: 'A question when one seems to start or end' })}
        ${stRow({ icon: 'sun', fam: 'steps', title: 'Mornings and weeks', sub: 'Your readiness, and a weekly summary' })}
        ${stRow({ icon: 'medal', fam: 'active', title: 'Milestones', sub: 'Step goal, a new record, tracker battery low' })}`)}`}
      ${stLab('This device')}
      <div data-here></div>
      ${stNote('Pick exactly which ones, and set quiet hours, in Me, Notifications.')}`);
    let d = null;
    thisDevice(body.querySelector('[data-here]'), { getData: () => d, setData: (r) => { d = r; } });
    api.get('/api/push').then((r) => { d = r; }).catch(() => {});
  }

  /* ── privacy ── */
  if (step === 'privacy') {
    privacyControls(body);
  }

}
