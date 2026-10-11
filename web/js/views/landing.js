/* Signed out, at "/". Says what this is and offers the two ways in. The
   picture is the product itself: the Today ring and rows, drawn with the
   real components and labelled as a sample. */

import { app } from '../app.js';
import { html, raw, mount, ic } from '../ui.js';
import { rings, ib } from '../kit.js';

export default async function landing({ root }) {
  document.title = 'Health';
  const open = app.me.registrationOpen !== false;
  // The day's goals as the app draws them: steps, active minutes, sleep.
  const list = [
    { fam: 'steps', value: 6840, goal: 8000, label: 'Steps', icon: 'steps', v: '6,840', of: '8,000' },
    { fam: 'active', value: 19, goal: 22, label: 'Active', icon: 'bolt', v: '19', of: '22 min' },
    { fam: 'sleep', value: 432, goal: 450, label: 'Sleep', icon: 'moon', v: '7:12', of: '7:30' },
  ];

  mount(root, html`<div class="land">
    <header class="land__bar">
      <span class="brand"><span class="brand__mark">${ic('pulse')}</span>Health</span>
      <a class="btn btn--tonal btn--s" href="/signin">Sign in</a>
    </header>

    <div class="land__main">
      <div>
        <h1 class="land__title" tabindex="-1">Your health numbers, next to your friends'.</h1>
        <p class="land__lead">Steps, sleep, heart rate and workouts from whatever you wear, in one calm place. With a leaderboard, because it is more fun that way.</p>
        <div class="land__cta">
          ${open ? html`<a class="btn" href="/register">Create account</a>` : ''}
          <a class="btn ${open ? 'btn--tonal' : ''}" href="/signin">Sign in</a>
        </div>
        <p class="muted small" ${raw('data-style="margin-top:14px"')}>
          ${open
            ? 'Use your ojee.net account, the same one as mtg and dnd.'
            : 'Registration is closed for now. If you already use Health, sign in with your ojee.net account.'}
        </p>
      </div>

      <figure class="sample" aria-label="A sample of the Today screen">
        <div class="ringrow">
          ${rings(list, { size: 140, stroke: 14 })}
          <ul class="ringkey">${list.map((r) => html`<li class="ringkey__i fam fam-${r.fam}">${ib(r.icon)}<span class="ringkey__k">${r.label}</span><span class="ringkey__v">${r.v}<small>/ ${r.of}</small></span></li>`)}</ul>
        </div>
        <hr class="rule sample__rule">
        <div class="stats">
          <div class="stat stat--s fam fam-recovery"><p class="stat__k">${ib('readiness', { size: 's' })}<span>Readiness</span></p><p class="stat__v">Normal day</p><p class="stat__c">HRV and sleep on your usual</p></div>
          <div class="stat stat--s fam fam-heart"><p class="stat__k">${ib('resting', { size: 's' })}<span>Resting heart rate</span></p><p class="stat__v">58<span class="stat__u">bpm</span></p><p class="stat__c">1 below your 30-day average</p></div>
        </div>
        <figcaption class="sample__cap">A sample day, not real data</figcaption>
      </figure>

      <dl class="land__points">
        <div class="land__point fam fam-recovery"><dt>${ib('watch')}<b>Works with what you wear</b></dt><dd><span>Fitbit, Pixel Watch, Garmin, Apple Watch, Samsung, or just your phone. Anything that reaches Google Health shows up here.</span></dd></div>
        <div class="land__point fam fam-workouts"><dt>${ib('strength')}<b>Workouts without the fuss</b></dt><dd><span>Start one by hand, let it notice from your heart rate, or bring your sets in from Hevy.</span></dd></div>
        <div class="land__point fam fam-steps"><dt>${ib('shield')}<b>You choose what others see</b></dt><dd><span>Activity and workouts are shared by default. Sleep, heart and body stay private unless you say so.</span></dd></div>
      </dl>
    </div>

    <footer class="land__foot">
      <span>Made for ojee and friends.</span>
      <span><a href="/privacy" data-native>Privacy</a> · <a href="/terms" data-native>Terms</a></span>
      ${app.me.demo ? html`<span>Demo mode: sign in with demo / demo.</span>` : ''}
    </footer>
  </div>`);
}
