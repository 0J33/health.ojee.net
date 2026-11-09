/* Signed out, at "/". A standalone premium page: the plate of rings, the word
   and its three meanings, and the real app tiles as its pictures. Two ways in:
   open the web app, or ask to test the mobile and desktop apps. */

import { app } from '../app.js';
import { html, mount, ic } from '../ui.js';

/** stroke-dasharray/offset for an activity ring: radius r, fill pct. */
function ring(r, pct) {
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return { c: c.toFixed(1), off: off.toFixed(1) };
}

export default async function landing({ root }) {
  document.title = 'rep. — build your rep.';
  const open = app.me.registrationOpen !== false;
  const enter = open ? '/register' : '/signin';
  const enterLabel = open ? 'Open the web app' : 'Sign in';

  // Three rings = the three meanings. Gold repetition, blue repair, green reputation.
  const R1 = 428, R2 = 364, R3 = 300;
  const r1 = ring(R1, 82), r2 = ring(R2, 64), r3 = ring(R3, 93);
  const tester = 'mailto:contact@ojee.net?subject=rep.%20tester&body=I%27d%20like%20to%20test%20the%20rep.%20app.%0A%0APhone%20(iPhone%20%2F%20Android)%20or%20desktop%3A%0AWhat%20I%20wear%20(Fitbit%2C%20Pixel%2C%20Garmin%2C%20phone%20only)%3A';

  mount(root, html`<div class="lp">
    <nav class="lp-nav"><div class="lp-nav__in">
      <span class="lp-word">rep<i>.</i></span>
      <span class="lp-nav__r">
        <a class="lp-link" href="/signin">Sign in</a>
        <a class="lp-btn lp-btn--gold lp-btn--sm" href="${enter}">${enterLabel}</a>
      </span>
    </div></nav>

    <header class="lp-hero lp__wrap" data-io>
      <div class="lp-hero__txt">
        <h1 class="lp-hero__title" data-rise>Build your rep.</h1>
        <p class="lp-hero__lead" data-rise style="--d:.08s">Sleep, readiness, steps, heart and workouts from whatever you wear — in one calm place, with friends if you like.</p>
        <div class="lp-hero__cta" data-rise style="--d:.16s">
          <a class="lp-btn lp-btn--gold" href="${enter}">${enterLabel}</a>
          <a class="lp-btn lp-btn--ghost" href="${tester}">Become a tester</a>
        </div>
        <p class="lp-hero__note" data-rise style="--d:.24s">Works in your browser now. Phone and desktop apps are in testing.</p>
      </div>
      <div class="lp-hero__art" data-rise style="--d:.1s">
        <div class="lp-stage"><svg viewBox="0 0 1000 1000" role="img" aria-label="Three activity rings and a heartbeat">
          <g class="lp-plate">
            <circle class="lp-ringtrack" cx="500" cy="500" r="${R1}" stroke-width="34"/>
            <circle class="lp-ringfill" cx="500" cy="500" r="${R1}" stroke-width="34" stroke="#E7B653" style="stroke-dasharray:${r1.c};--c:${r1.c};--off:${r1.off}"/>
            <circle class="lp-ringtrack" cx="500" cy="500" r="${R2}" stroke-width="34"/>
            <circle class="lp-ringfill" cx="500" cy="500" r="${R2}" stroke-width="34" stroke="#A9BEFF" style="stroke-dasharray:${r2.c};--c:${r2.c};--off:${r2.off}"/>
            <circle class="lp-ringtrack" cx="500" cy="500" r="${R3}" stroke-width="34"/>
            <circle class="lp-ringfill" cx="500" cy="500" r="${R3}" stroke-width="34" stroke="#74C3A1" style="stroke-dasharray:${r3.c};--c:${r3.c};--off:${r3.off}"/>
            <path class="lp-pulse" d="M330 500 H440 l24 -66 l34 150 l30 -120 l22 36 H670"/>
            <circle class="lp-dot" cx="500" cy="500" r="16" style="transform-box:fill-box;transform-origin:center"/>
          </g>
        </svg></div>
      </div>
    </header>

    <section class="lp-sec lp-name" aria-labelledby="lp-name-h">
      <div class="lp__wrap">
        <p class="lp-name__lead" data-rise>Short for three things worth keeping. <b>rep.</b> holds all of them.</p>
        <h2 id="lp-name-h" class="lp-sec__h" style="position:absolute;left:-9999px">What rep. means</h2>
        <div class="lp-mean">
          <div class="lp-mean__row" data-rise>
            <div class="lp-mean__w"><span class="lit">rep</span>air</div>
            <p class="lp-mean__d">Your body mends between the hard days. rep. reads your sleep, resting heart and recovery, so you push when you're ready and ease off when you're not.</p>
          </div>
          <div class="lp-mean__row" data-rise style="--d:.08s">
            <div class="lp-mean__w"><span class="lit">rep</span>etition</div>
            <p class="lp-mean__d">The habit is the whole point. Small reps — a walk, a lift, a night of real sleep — logged until they're simply yours.</p>
          </div>
          <div class="lp-mean__row" data-rise style="--d:.16s">
            <div class="lp-mean__w"><span class="lit">rep</span>utation</div>
            <p class="lp-mean__d">Among friends. One shared leaderboard that keeps everyone honest and makes the quiet weeks a little louder.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="lp-sec" aria-labelledby="lp-track-h">
      <div class="lp__wrap lp-split">
        <div class="lp-split__txt">
          <h2 id="lp-track-h" class="lp-sec__h" data-rise>One calm place for everything you wear.</h2>
          <p class="lp-sec__p" data-rise style="--d:.08s">Fitbit and Pixel through Google Health, Garmin directly, or just your phone. Sleep, readiness, steps, heart and workouts land together — read at a glance, not dug for.</p>
        </div>
        <div class="lp-fig" data-io>
          <div class="lp-tile lp-tile--sleep lp-tile--hero" data-rise>
            <div>
              <div class="lp-tile__lab">${ic('bed')} Sleep</div>
              <div class="lp-tile__n">7<span class="u">h</span>&thinsp;17<span class="u">m</span></div>
              <div class="lp-tile__sub">97% of your 7h 30 goal · 23:34–07:06</div>
            </div>
            <svg class="lp-rings" viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="50" stroke="rgba(199,210,242,.2)"/>
              <circle class="fill" cx="60" cy="60" r="50" stroke="#C7D2F2" style="stroke-dasharray:${ring(50,97).c};--o:${ring(50,97).off}"/>
            </svg>
          </div>
          <div class="lp-grid2">
            <div class="lp-tile lp-tile--rec" data-rise style="--d:.08s">
              <div class="lp-tile__lab">Recovery</div>
              <div class="lp-tile__n">70</div>
              <div class="lp-tile__sub">Moderate</div>
              <div class="lp-bar"><i class="barfill" style="--w:70%"></i></div>
            </div>
            <div class="lp-tile lp-tile--steps" data-rise style="--d:.16s">
              <div class="lp-tile__lab">${ic('steps')} Steps</div>
              <div class="lp-tile__n">8,214</div>
              <div class="lp-tile__sub">of 10,000</div>
              <div class="lp-bar"><i class="barfill" style="--w:82%"></i></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="lp-sec lp-name" aria-labelledby="lp-friends-h">
      <div class="lp__wrap lp-split lp-split--rev">
        <div class="lp-split__txt">
          <h2 id="lp-friends-h" class="lp-sec__h" data-rise>Better together, honest by default.</h2>
          <p class="lp-sec__p" data-rise style="--d:.08s">A shared leaderboard for the people you choose. Sleep, heart and body stay private unless you share them — the competition is only ever the part you opt into.</p>
        </div>
        <div class="lp-board" data-io>
          <div class="lp-board__row" data-rise><span class="lp-board__av" style="background:#E7B653">D</span><span class="lp-board__rk">1</span><span class="lp-board__nm">Dina</span><span class="lp-board__v">71,140</span></div>
          <div class="lp-board__row" data-rise style="--d:.06s"><span class="lp-board__av" style="background:#A9BEFF">K</span><span class="lp-board__rk">2</span><span class="lp-board__nm">Karim</span><span class="lp-board__v">60,880</span></div>
          <div class="lp-board__row lp-board__row--me" data-rise style="--d:.12s"><span class="lp-board__av" style="background:#74C3A1">Y</span><span class="lp-board__rk">3</span><span class="lp-board__nm">You</span><span class="lp-board__v">48,210</span></div>
          <div class="lp-board__row" data-rise style="--d:.18s"><span class="lp-board__av" style="background:#E890A3">S</span><span class="lp-board__rk">4</span><span class="lp-board__nm">Sara</span><span class="lp-board__v">39,905</span></div>
        </div>
      </div>
    </section>

    <section class="lp-sec lp-ways" aria-labelledby="lp-ways-h">
      <div class="lp__wrap">
        <h2 id="lp-ways-h" class="lp-sec__h" data-rise>Everywhere you check in.</h2>
        <p class="lp-sec__p" data-rise style="--d:.08s">Start in the browser today. The native apps add home and lock-screen widgets, live heart rate over Bluetooth, and background workout recording.</p>
        <div class="lp-ways__grid">
          <div class="lp-way" data-rise><span class="lp-way__ic">${ic('groups')}</span><span class="lp-way__t">Browser</span><span class="lp-way__d">The full app, nothing to install. Open it and sign in.</span><span class="lp-way__tag">Ready now</span></div>
          <div class="lp-way" data-rise style="--d:.06s"><span class="lp-way__ic">${ic('heart')}</span><span class="lp-way__t">iPhone</span><span class="lp-way__d">Widgets, Lock Screen, live heart rate. In testing.</span><span class="lp-way__tag">Testing</span></div>
          <div class="lp-way" data-rise style="--d:.12s"><span class="lp-way__ic">${ic('steps')}</span><span class="lp-way__t">Android</span><span class="lp-way__d">Home and lock widgets, Health Connect, Quick tile. In testing.</span><span class="lp-way__tag">Testing</span></div>
          <div class="lp-way" data-rise style="--d:.18s"><span class="lp-way__ic">${ic('pulse')}</span><span class="lp-way__t">Desktop</span><span class="lp-way__d">A tray with today's numbers and your live heart rate. In testing.</span><span class="lp-way__tag">Testing</span></div>
        </div>
        <div class="lp-tester" data-rise>
          <div>
            <h3 class="lp-tester__h">Want the apps early?</h3>
            <p class="lp-tester__p">The iPhone, Android and desktop builds are open to a small group of testers. Tell me what you wear and which one you want, and I'll set you up.</p>
          </div>
          <a class="lp-btn lp-btn--gold" href="${tester}">Become a tester</a>
        </div>
      </div>
    </section>

    <footer class="lp-foot">
      <div class="lp__wrap">
        <div class="lp-foot__word" aria-hidden="true">rep<i>.</i></div>
        <div class="lp-foot__r">
          <a class="lp-btn lp-btn--gold lp-btn--sm" href="${enter}">${enterLabel}</a>
          <a href="/privacy" data-native>Privacy</a>
          <a href="/terms" data-native>Terms</a>
          <a href="mailto:contact@ojee.net">Contact</a>
          ${app.me.demo ? html`<span>Demo: sign in with demo / demo.</span>` : ''}
        </div>
      </div>
    </footer>
  </div>`);

  // Reveal on scroll. The page shows in full on its own; .anim opts into the
  // rise-in, so nothing is ever hidden if this never runs or motion is off.
  const page = root.querySelector('.lp');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (page && 'IntersectionObserver' in window && !reduce) {
    page.classList.add('anim');
    const io = new IntersectionObserver((entries, ob) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); ob.unobserve(e.target); }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    page.querySelectorAll('[data-rise], [data-io]').forEach((el) => io.observe(el));
    // The hero is already on screen; reveal it next frame so nothing waits.
    requestAnimationFrame(() => page.querySelectorAll('.lp-hero, .lp-hero [data-rise]').forEach((el) => el.classList.add('in')));
  }
}
