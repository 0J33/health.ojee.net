/* Signed out, at "/". Says what this is and offers the two ways in. The
   picture is the product itself: Today's first tiles, drawn with the real
   components and labelled as a sample. */

import { app } from '../app.js';
import { html, mount, ic } from '../ui.js';
import { tring } from './today.js';

export default async function landing({ root }) {
  document.title = 'Health';
  const open = app.me.registrationOpen !== false;

  mount(root, html`<div class="land">
    <header class="land__bar">
      <span class="brand"><span class="brand__mark">${ic('pulse')}</span>Health</span>
      <a class="pill-btn pill-btn--soft" href="/signin">Sign in</a>
    </header>

    <div class="land__main">
      <div class="land__intro">
        <h1 class="land__title" tabindex="-1">Your health, at a glance.</h1>
        <p class="land__lead">Sleep, readiness, steps, heart and workouts from whatever you wear, in one calm place. With friends, if you like.</p>
        <div class="land__cta">
          ${open ? html`<a class="btn" href="/register">Create account</a>` : ''}
          <a class="btn ${open ? 'btn--tonal' : ''}" href="/signin">Sign in</a>
        </div>
        ${open ? '' : html`<p class="land__note">New accounts are closed for now.</p>`}
      </div>

      <figure class="land__sample" aria-label="A sample of the Today screen">
        <div class="bento bento--today">
          <div class="bt bt--sleep bt--wide bt-sleep">
            <div class="bt-sleep__l">
              <div class="bt__row"><span class="bt__lab">${ic('bed')}Sleep</span><span class="bt__meta">23:34 – 07:06</span></div>
              <div><p class="n n-hero">7<span class="u">h</span>&thinsp;17<span class="u">m</span></p><span class="tbar"><i style="width:97%"></i></span><p class="bt__sub">97 % of your 7 h 30 goal</p></div>
            </div>
            ${tring(97, { size: 96, sw: 8, inner: html`<b class="n">97</b><span>Excellent</span>` })}
          </div>
          <div class="bt bt--plain bt-ready"><div class="bt__row"><span class="bt__lab">Readiness</span></div><p class="bt__line"><span class="n n-l">70</span><span class="bt__state band-mid">Moderate</span></p></div>
          <div class="bt bt--steps bt-small"><div class="bt__row"><span class="bt__lab">${ic('steps')}Steps</span>${tring(82)}</div><div><p class="n n-m">8,214</p><p class="bt__sub">of 10,000</p></div></div>
        </div>
        <figcaption class="land__cap">A sample day, not real data</figcaption>
      </figure>

      <ul class="land__points">
        <li><span class="land__ic">${ic('watch')}</span><span><b>Works with what you wear</b>Fitbit and Pixel through Google Health, Garmin directly, or just your phone.</span></li>
        <li><span class="land__ic">${ic('dumbbell')}</span><span><b>Workouts without the fuss</b>Start one, let it notice from your heart rate, or bring sets in from Hevy.</span></li>
        <li><span class="land__ic">${ic('shield')}</span><span><b>You choose what others see</b>Sleep, heart and body stay private unless you share them.</span></li>
      </ul>
    </div>

    <footer class="land__foot">
      <span><a href="/privacy" data-native>Privacy</a> · <a href="/terms" data-native>Terms</a></span>
      ${app.me.demo ? html`<span>Demo mode: sign in with demo / demo.</span>` : ''}
    </footer>
  </div>`);
}
