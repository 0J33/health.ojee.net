/* Signed out, at "/". Says what this is and offers the two ways in. The
   picture is the product itself: the Today ring and rows, drawn with the
   real components and labelled as a sample. */

import { app } from '../app.js';
import { html, raw, mount, ic } from '../ui.js';
import { ring } from '../charts.js';

export default async function landing({ root }) {
  document.title = 'Health';
  const open = app.me.registrationOpen !== false;
  const sample = ring({
    value: 6840, goal: 8000, size: 148, stroke: 13,
    label: 'Sample: 6,840 of 8,000 steps',
    inner: '<div><div class="big big--m">6,840</div><div class="cap">of 8,000 steps</div></div>',
  });

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
        <div class="lead-card__top">
          ${raw(sample)}
          <div class="lead-card__txt">
            <p class="lead-card__k">Steps today</p>
            <p class="lead-card__l">86% of the goal. About 15 minutes of walking to go.</p>
          </div>
        </div>
        <div class="kv" ${raw('data-style="margin-top:16px;border-radius:12px;overflow:hidden"')}>
          <div><dt>Sleep</dt><dd>7 h 12 min</dd></div>
          <div><dt>Resting heart rate</dt><dd>58<span class="unit">bpm</span></dd></div>
        </div>
        <figcaption class="sample__cap">A sample day, not real data</figcaption>
      </figure>

      <dl class="land__points">
        <div class="land__point"><dt><b>Works with what you wear</b></dt><dd><span>Fitbit, Pixel Watch, Garmin, Apple Watch, Samsung, or just your phone. Anything that reaches Google Health shows up here.</span></dd></div>
        <div class="land__point"><dt><b>Workouts without the fuss</b></dt><dd><span>Start one by hand, let it notice from your heart rate, or bring your sets in from Hevy.</span></dd></div>
        <div class="land__point"><dt><b>You choose what others see</b></dt><dd><span>Activity and workouts are shared by default. Sleep, heart and body stay private unless you say so.</span></dd></div>
      </dl>
    </div>

    <footer class="land__foot">
      <span>Made for ojee and friends.</span>
      <span><a href="/privacy" data-native>Privacy</a> · <a href="/terms" data-native>Terms</a></span>
      ${app.me.demo ? html`<span>Demo mode: sign in with demo / demo.</span>` : ''}
    </footer>
  </div>`);
}
