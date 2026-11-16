/* The signed-out landing at "/" (it replaced landing.js, which is kept unused).
   The same page as landing.js, made unmistakably a tracker, a gym log, a
   competition and a health app: the hero's gold plate stays on screen as the
   page scrolls, turns into a loaded barbell, then travels through a watch, a
   bike, a scale and a podium, one screen each (landing3-stage.js).

   Every number on this page is a sample and says so. The page is complete
   without its script; motion only ever rewinds what is already there. */

import { app } from '../app.js';
import { html, raw, mount, ic } from '../ui.js';
import { ART } from './landing3-art.js';
import { stage } from './landing3-stage.js';

const TESTER = 'mailto:contact@ojee.net?subject=rep.%20tester&body=I%27d%20like%20to%20test%20the%20rep.%20app.%0A%0APhone%20(iPhone%20%2F%20Android)%20or%20desktop%3A%0AWhat%20I%20wear%20(Fitbit%2C%20Pixel%2C%20Garmin%2C%20WHOOP%2C%20phone%20only)%3A%0AMy%20scale%2C%20if%20any%3A';

/* The things people wear, drawn in the same line as the icon family. */
const STRAPS = '<path d="M9 6.5 9.5 2.5h5L15 6.5"/><path d="M9 17.5l.5 4h5l.5-4"/>';
const DRAWN = {
  band: '<rect x="8.5" y="6" width="7" height="12" rx="3.5"/><path d="M10 6V2.5h4V6"/><path d="M10 18v3.5h4V18"/>',
  round: `<circle cx="12" cy="12" r="6"/>${STRAPS}`,
  square: `<rect x="6.5" y="6.5" width="11" height="11" rx="3"/>${STRAPS}`,
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  scale: '<rect x="3.5" y="5" width="17" height="15" rx="4"/><path d="M9 10a4 4 0 0 1 6 0"/><path d="M12 10l1-1.5"/>',
};
const DEVICES = [
  ['band', 'Fitbit', 'through Google Health'],
  ['round', 'Pixel Watch', 'through Google Health'],
  ['square', 'Apple Watch', 'through Apple and Google Health'],
  ['round', 'Galaxy Watch', 'on the Android app, in testing'],
  ['round', 'Garmin', 'connected directly'],
  ['band', 'WHOOP', 'connected directly'],
  ['scale', 'Withings', 'connected directly, in full'],
  ['scale', 'Xiaomi, Garmin Index', 'every weigh-in, in full'],
  ['scale', 'Any smart scale', 'Renpho, Eufy, Omron, Aria'],
  ['phone', 'Just a phone', 'steps and distance'],
];

const READS = [
  ['bed', 'Sleep', 'stages, times and naps'],
  ['heartpulse', 'Heart', 'resting, HRV, zones'],
  ['steps', 'Steps', 'and distance'],
  ['dumbbell', 'Workouts', 'gym, runs, rides'],
  ['scale', 'Body', 'weight and composition'],
  ['drop', 'Water', 'and food, if you log it'],
];

/* One sample night, minutes per stage. Asleep 7h 17m, awake 15m. */
const NIGHT = [['L', 14], ['D', 46], ['L', 24], ['R', 18], ['L', 30], ['D', 38], ['L', 22], ['W', 4], ['L', 22], ['R', 28], ['L', 28], ['D', 22], ['L', 30], ['R', 34], ['L', 24], ['W', 5], ['L', 27], ['R', 30], ['W', 6]];
const STAGE_Y = { W: 2, R: 26, L: 50, D: 74 };
const STAGE_C = { W: 'var(--c-awake)', R: 'var(--c-rem)', L: 'var(--c-light)', D: 'var(--c-deep)' };

function hypnogram() {
  const total = NIGHT.reduce((n, [, m]) => n + m, 0);
  let x = 0;
  const bars = NIGHT.map(([s, m]) => {
    const w = (m / total) * 400;
    const bar = `<rect x="${x.toFixed(1)}" y="${STAGE_Y[s]}" width="${Math.max(w - 1.2, 1.5).toFixed(1)}" height="20" rx="3" fill="${STAGE_C[s]}"/>`;
    x += w;
    return bar;
  }).join('');
  return html`<svg class="lp-hyp" viewBox="0 0 400 96" role="img" aria-label="Sleep stages across a sample night, moving between light, deep and REM sleep with three short wakings">${raw(bars)}</svg>`;
}

/** The app's score ring (today.js), without its own arrival animation. */
function ring(pct, size, sw, inner) {
  const r = size / 2 - sw / 2; const c = size / 2;
  return html`<span class="tring" style="width:${size / 16}rem;height:${size / 16}rem"><svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="trk" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}"/><circle class="val" data-ring="${pct}" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 ${c} ${c})"/></svg>${inner ? html`<span class="tring__in">${inner}</span>` : ''}</span>`;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/* The showcase: one object at a time, in the order a week goes. */
const SHOW = [
  ['barbell', 'Lift', 'Every set, logged as you lift.', 'Weight, reps and rest for each set, your bests marked, routines ready for next time. Coming from Hevy? Bring it all.'],
  ['watch', 'Track', 'Wear anything. Wake up to one answer.', 'Sleep, heart and steps become one recovery score each morning, read against your own last 30 days.'],
  ['bike', 'Ride', 'Runs and rides come in on their own.', 'Workouts from your watch or Strava arrive with heart rate, pace and route. Or record one on your phone.'],
  ['scale', 'Body', 'Your weight, beside your sleep.', 'Weight and body fat from almost any smart scale, with muscle, water and bone from the ones that measure them, next to how you slept, read against your own normal.'],
  ['podium', 'Compete', 'Then win the week.', 'A board for the friends you choose, reset every Friday. Steps and workouts are shared; sleep, heart and body stay private.'],
];

export default async function landing({ root }) {
  if (!document.querySelector('link[href="/css/landing3.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/landing3.css' }));
  document.title = 'rep. Sleep, health and training from whatever you wear';
  const open = app.me.registrationOpen !== false;
  const enter = open ? '/register' : '/signin';
  const enterLabel = open ? 'Open the web app' : 'Sign in';

  const room = (cls, word, body) => html`<section class="lp-room lp-room--${cls}">
    <p class="lp-room__word" aria-hidden="true">${word}<i></i></p>
    <div class="lp-room__grid">${body}</div>
  </section>`;

  // Wide screens hold the hero inside the stage, so its plate can stay while its words leave.
  const pinned = window.matchMedia?.('(min-width: 1200px) and (min-height: 700px)').matches;
  const heroHtml = html`<section class="lp-hero lp__wrap" data-hero>
      <div class="lp-hero__txt">
        <h1 class="lp-h1"><span class="m"><span>Build</span></span> <span class="m"><span>your</span></span> <span class="m"><span>rep<b>.</b></span></span></h1>
        <p class="lp-hero__lead">rep. tracks your sleep, heart and steps from whatever you wear, logs every set in the gym, and puts you on a weekly board with your friends.</p>
        <div class="lp-cta">
          <a class="lp-btn lp-btn--gold" href="${enter}">${enterLabel}</a>
          <a class="lp-btn lp-btn--ghost" href="${TESTER}">Become a tester</a>
        </div>
        <p class="lp-hero__note">Reads from Fitbit, Pixel, Apple Watch, Galaxy Watch, Garmin, WHOOP, almost any smart scale or just your phone.</p>
      </div>

      <div class="lp-hero__art">
        <div class="lp-disc" aria-hidden="true"><img src="/favicon.svg" alt=""></div>
        <div class="lp-today">
          <div class="lp-today__top">
            <span class="lp-today__t">Today</span>
            <span class="lp-sync"><i></i>Pixel Watch, synced just now</span>
          </div>
          <div class="bento">
            <div class="bt bt--sleep bt--wide bt-sleep">
              <div class="bt-sleep__l">
                <div class="bt__row"><span class="bt__lab">${ic('bed')}Sleep</span><span class="bt__meta">23:34 – 07:06</span></div>
                <div>
                  <p class="n n-hero"><span data-count="7">7</span><span class="u">h</span>&thinsp;<span data-count="17">17</span><span class="u">m</span></p>
                  <span class="tbar"><i data-bar="97" style="width:97%"></i></span>
                  <p class="bt__sub">97 % of your 7h 30 goal</p>
                </div>
              </div>
              ${ring(97, 104, 8, html`<b class="n" data-count="97">97</b><span>Excellent</span>`)}
            </div>
            <div class="bt bt--plain bt-ready">
              <div class="bt__row"><span class="bt__lab">Recovery</span>
                <svg class="gauge" viewBox="0 0 44 26" aria-hidden="true"><path class="trk" d="M4 23a18 18 0 0 1 36 0" pathLength="100"/><path class="val" data-ring="70" d="M4 23a18 18 0 0 1 36 0" pathLength="100" stroke-dasharray="70 100"/></svg></div>
              <p class="bt__line"><span class="n n-l" data-count="70">70</span><span class="bt__state band-mid">Moderate</span></p>
            </div>
            <div class="bt bt--steps bt-small">
              <div class="bt__row"><span class="bt__lab">${ic('steps')}Steps</span>${ring(82, 40, 4, '')}</div>
              <div><p class="n n-m" data-steps data-count="8214">8,214</p><p class="bt__sub">of 10,000</p></div>
            </div>
            <div class="bt bt--plain bt--wide lp-work">
              <span class="lp-work__ic">${ic('dumbbell')}</span>
              <span class="lp-work__t"><b>Push day</b><span>6 exercises, 18 sets, 9,840 kg</span></span>
              <span class="lp-work__v n n-s">52<span class="u">min</span></span>
            </div>
          </div>
          <p class="lp-sample">Sample numbers, in the app's own layout.</p>
        </div>
      </div>
    </section>`;

  mount(root, html`<div class="lp">
    <header class="lp-top lp__wrap">
      <span class="lp-word"><img src="/favicon.svg" alt="" width="26" height="26">rep<i>.</i></span>
      <a class="lp-link" href="/signin">Sign in</a>
    </header>

    ${pinned ? '' : heroHtml}
    <section class="l3-stage${pinned ? ' l3-stage--pinned' : ''}" data-stage aria-labelledby="l3-stage-h" style="--n:${SHOW.length}">
      <h2 id="l3-stage-h" class="l3-sr">What rep. covers</h2>
      <div class="l3-pin">
        <div class="l3-art" aria-hidden="true">${SHOW.slice(1).map(([m]) => html`<div class="l3-obj">${raw(ART[m])}</div>`)}</div>
        <div class="l3-caps">${SHOW.map(([, , h, p]) => html`<div class="l3-cap"><h3 class="l3-cap__h">${h}</h3><p class="l3-cap__p">${p}</p></div>`)}</div>
        <ol class="l3-rail" aria-hidden="true">${SHOW.map(([, k]) => html`<li>${k}</li>`)}</ol>
        ${pinned ? html`<div class="l3-hl">${heroHtml}</div>` : ''}
      </div>
    </section>


    <section class="lp-feed lp__wrap" data-in aria-labelledby="lp-feed-h">
      <div class="lp-feed__head">
        <h2 id="lp-feed-h" class="lp-h2">Wear what you wear.<br>rep. reads it.</h2>
        <p class="lp-p">Your watch or phone already records the day. rep. brings it into one place and works out its own sleep and recovery scores against your own last 30 days. If it has too little to go on, it says so.</p>
      </div>
      <div class="lp-flow" data-flow>
        <ul class="lp-flow__in">${DEVICES.map(([d, n, how]) => html`<li><svg class="lp-flow__dev" viewBox="0 0 24 24" aria-hidden="true">${raw(DRAWN[d])}</svg><b>${n}</b><span>${how}</span></li>`)}</ul>
        <div class="lp-flow__plate" aria-hidden="true"><img src="/favicon.svg" alt=""></div>
        <ul class="lp-flow__out">${READS.map(([i, n, what]) => html`<li>${ic(i)}<b>${n}</b><span>${what}</span></li>`)}</ul>
        <svg class="lp-flow__wires" aria-hidden="true"></svg>
      </div>
    </section>

    <section class="lp-name" data-name aria-labelledby="lp-name-h">
      <div class="lp-name__pin">
        <div class="lp-name__head">
          <h2 id="lp-name-h" class="lp-name__lead">Short for three things worth keeping.</h2>
          <p class="lp-name__sub">Three plates make the mark. Each one stands for a word.</p>
        </div>
        <svg class="lp-mark" viewBox="70 280 860 490" role="img" aria-label="The rep. mark: three standing plates, silver, gold and bronze">
          <use href="/rep-mark.svg#plate-repair" data-i="1"></use>
          <use href="/rep-mark.svg#plate-reputation" data-i="3"></use>
          <use href="/rep-mark.svg#plate-repetition" data-i="2"></use>
        </svg>
        <div class="lp-mean">
          <div class="lp-mean__c" data-i="1">
            <h3 class="lp-mean__w"><span style="color:#CBD1DC">rep</span>air</h3>
            <p>Your body mends between the hard days. rep. reads how well it did.</p>
          </div>
          <div class="lp-mean__c" data-i="2">
            <h3 class="lp-mean__w"><span style="color:#E7B653">rep</span>etition</h3>
            <p>The habit is the whole point. Every set, run and walk, kept until it is simply yours.</p>
          </div>
          <div class="lp-mean__c" data-i="3">
            <h3 class="lp-mean__w"><span style="color:#C98352">rep</span>utation</h3>
            <p>Among friends. One board that makes the quiet weeks a little louder.</p>
          </div>
        </div>
      </div>
    </section>

    <div class="lp-rooms">
      ${room('silver', 'repair', html`
        <div class="lp-room__txt" data-in>
          <h2 class="lp-h2">Sleep, heart and recovery, read every morning.</h2>
          <p class="lp-p">Stages from your watch, resting heart and HRV next to your own normal, and your naps kept apart from the night. One recovery score, so you know whether to push today or leave it. Ask the AI about any of it, in plain words.</p>
        </div>
        <div class="lp-frag" data-in data-night>
          <div class="lp-frag__row"><span class="bt__lab">${ic('bed')}Last night</span><span class="bt__meta">Sample · 23:34 – 07:06</span></div>
          <p class="n n-hero">7<span class="u">h</span>&thinsp;17<span class="u">m</span></p>
          <div class="lp-hypwrap">
            <div class="lp-hyplab" aria-hidden="true"><span>Awake</span><span>REM</span><span>Light</span><span>Deep</span></div>
            ${hypnogram()}
          </div>
          <div class="lp-stats">
            <div><p class="n n-m">70</p><span>Recovery</span></div>
            <div><p class="n n-m">58<span class="u">bpm</span></p><span>Resting heart</span></div>
            <div><p class="n n-m">46<span class="u">ms</span></p><span>HRV</span></div>
          </div>
        </div>`)}

      ${room('gold', 'repetition', html`
        <div class="lp-room__txt" data-in>
          <h2 class="lp-h2">The gym, set by set. The rest arrives on its own.</h2>
          <p class="lp-p">Log lifts as you do them: sets, weight, reps, rests and your bests. Runs, rides and walks come in from your watch or Strava, or record them yourself: draw a route and follow it, with push-and-rest intervals that buzz your phone. Coming from Hevy? Import it.</p>
        </div>
        <div class="lp-stack" data-in data-gym>
          <div class="lp-frag">
            <div class="lp-frag__row"><span class="bt__lab">${ic('dumbbell')}Push day</span><span class="bt__meta">Sample · 52 min · 9,840 kg</span></div>
            <p class="lp-ex">Bench press</p>
            <ol class="lp-sets">
              ${[[80, 8], [80, 8], [82.5, 6]].map(([kg, r], i) => html`<li style="--i:${i}"><span class="lp-sets__n">${i + 1}</span><span class="n">${kg}<span class="u">kg</span></span><span class="lp-sets__x">×</span><span class="n">${r}</span>${i === 2 ? html`<em>Best yet</em>` : ''}<i aria-hidden="true">${ic('check')}</i></li>`)}
            </ol>
            <p class="lp-more">Incline press, cable fly and 3 more</p>
          </div>
          <div class="lp-frag lp-run">
            <div>
              <div class="bt__lab">${ic('steps')}Morning run</div>
              <p class="n n-m">5.2<span class="u">km</span></p>
              <p class="bt__sub">27:14 · 5:14 /km · Sample</p>
            </div>
            <div class="lp-splits" aria-hidden="true">${[62, 78, 100, 70, 88].map((h, i) => html`<i style="--h:${h}%;--i:${i}"></i>`)}</div>
          </div>
        </div>`)}

      ${room('bronze', 'reputation', html`
        <div class="lp-room__txt" data-in>
          <h2 class="lp-h2">A leaderboard for the people you choose.</h2>
          <p class="lp-p">Steps and training, week by week, with the friends you add. Every workout becomes a post they can cheer and comment on. Sleep, heart and body stay private unless you decide to share them.</p>
        </div>
        <div class="lp-frag" data-in data-board>
          <div class="lp-frag__row"><span class="bt__lab">${ic('groups')}Steps this week</span><span class="bt__meta">Sample</span></div>
          <ol class="lp-rank">
            <li><span class="lp-rank__r">1</span><span class="lp-rank__a" style="background:#E7B653">D</span><span class="lp-rank__n">Dina</span><span class="n">71,140</span></li>
            <li class="lp-rank__you" data-you><span class="lp-rank__r">2</span><span class="lp-rank__a" style="background:#74C3A1">Y</span><span class="lp-rank__n">You</span><span class="n" data-you-n>61,420</span></li>
            <li data-karim><span class="lp-rank__r">3</span><span class="lp-rank__a" style="background:#A9BEFF">K</span><span class="lp-rank__n">Karim</span><span class="n">60,880</span></li>
            <li><span class="lp-rank__r">4</span><span class="lp-rank__a" style="background:#E890A3">S</span><span class="lp-rank__n">Sara</span><span class="n">39,905</span></li>
          </ol>
          <ul class="lp-priv">
            <li><span>Steps and workouts</span><b class="on">Shared</b></li>
            <li><span>Sleep, heart and body</span><b>Private</b></li>
          </ul>
        </div>`)}
    </div>

    <section class="lp-ways lp__wrap" aria-labelledby="lp-ways-h">
      <h2 id="lp-ways-h" class="lp-h2">Start in your browser today.</h2>
      <dl class="lp-table">
        <div><dt>Web</dt><dd>The full app. Nothing to install.</dd><dd class="lp-table__s lp-table__s--on">Open now</dd></div>
        <div><dt>iPhone</dt><dd>Home and Lock Screen widgets, live heart rate over Bluetooth, background route recording.</dd><dd class="lp-table__s">In testing</dd></div>
        <div><dt>Android</dt><dd>Home and lock widgets, Health Connect, a Quick Settings tile, background route recording.</dd><dd class="lp-table__s">In testing</dd></div>
        <div><dt>Desktop</dt><dd>A tray with today's numbers and your live heart rate.</dd><dd class="lp-table__s">In testing</dd></div>
        <div><dt><a href="/developers">API and MCP</a></dt><dd>Your own data for your own scripts, and for AI assistants like Claude or ChatGPT, with a key you make.</dd><dd class="lp-table__s lp-table__s--on">Open now</dd></div>
      </dl>
    </section>

    <section class="lp-close lp__wrap" aria-labelledby="lp-close-h">
      <img class="lp-close__plate" src="/favicon.svg" alt="" width="88" height="88">
      <h2 id="lp-close-h" class="lp-close__h">Build your rep<b>.</b></h2>
      <p class="lp-p">Testers get the phone and desktop apps early. Send what you wear and which app you want. Testers are added by hand.</p>
      <div class="lp-cta">
        <a class="lp-btn lp-btn--gold" href="${enter}">${enterLabel}</a>
        <a class="lp-btn lp-btn--ghost" href="${TESTER}">Become a tester</a>
      </div>
    </section>

    <footer class="lp-foot lp__wrap">
      <span class="lp-word"><img src="/favicon.svg" alt="" width="20" height="20">rep<i>.</i></span>
      <span class="lp-foot__r">
        <a href="/privacy" data-native>Privacy</a>
        <a href="/terms" data-native>Terms</a>
        <a href="/guidelines" data-native>Guidelines</a>
        <a href="/licenses" data-native>Licences</a>
        <a href="mailto:contact@ojee.net">Contact</a>
        ${app.me.demo ? html`<span>Demo: sign in with demo / demo.</span>` : ''}
      </span>
    </footer>
  </div>`);

  const page = root.querySelector('.lp');
  if (!page) return;
  page.classList.add('l3');
  stage(page, SHOW, { pinned });
  drawWires(page);
  const flowRo = 'ResizeObserver' in window ? new ResizeObserver(() => drawWires(page)) : null;
  flowRo?.observe(page.querySelector('[data-flow]'));

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  page.classList.add('anim');
  arriveToday(page);
  tickSteps(page);
  watchIn(page);
  pinName(page);
  rewindBoard(page);
}

/* ── the wires from what you wear, through the plate, to what it reads ───── */

function drawWires(page) {
  const flow = page.querySelector('[data-flow]');
  const svg = flow?.querySelector('.lp-flow__wires');
  if (!svg) return;
  if (window.matchMedia('(max-width: 899px)').matches) { svg.innerHTML = ''; return; }
  const box = flow.getBoundingClientRect();
  const plate = flow.querySelector('.lp-flow__plate').getBoundingClientRect();
  const cy = plate.top + plate.height / 2 - box.top;
  const L = plate.left - box.left - 6;
  const R = plate.right - box.left + 6;
  const curve = (x1, y1, x2, y2) => { const mid = (x1 + x2) / 2; return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${mid.toFixed(1)} ${y1.toFixed(1)} ${mid.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const wires = [];
  flow.querySelectorAll('.lp-flow__in li').forEach((li) => {
    const r = li.getBoundingClientRect();
    wires.push(curve(r.right - box.left + 12, r.top + r.height / 2 - box.top, L, cy));
  });
  const fromIn = wires.length;
  flow.querySelectorAll('.lp-flow__out li').forEach((li) => {
    const r = li.getBoundingClientRect();
    wires.push(curve(R, cy, r.left - box.left - 12, r.top + r.height / 2 - box.top));
  });
  svg.setAttribute('viewBox', `0 0 ${box.width.toFixed(0)} ${box.height.toFixed(0)}`);
  svg.innerHTML = wires.map((d, i) => `<path class="w" d="${d}"/><path class="p" pathLength="100" d="${d}" style="animation-delay:${(-((i * 0.53) % 3.2) - (i >= fromIn ? 1.1 : 0)).toFixed(2)}s"/>`).join('');
}

/* ── the Today card arrives: the ring closes as the numbers count ─────────── */

function countUp(el, to, delay, dur = 1100) {
  const start = performance.now() + delay;
  const show = (n) => { el.textContent = fmt(n); };
  show(0);
  const step = (now) => {
    if (!el.isConnected) return;
    const t = Math.min(1, Math.max(0, (now - start) / dur));
    const eased = 1 - (1 - t) ** 4;
    show(eased * to);
    if (t < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}

function arriveToday(page) {
  const card = page.querySelector('.lp-today');
  card.querySelectorAll('[data-count]').forEach((el) => countUp(el, Number(el.dataset.count), 420));
  const rings = [...card.querySelectorAll('[data-ring]')];
  rings.forEach((c) => c.setAttribute('stroke-dasharray', '0 100'));
  card.querySelectorAll('[data-bar]').forEach((b) => { b.style.transform = 'scaleX(0)'; });
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
    rings.forEach((c) => c.setAttribute('stroke-dasharray', `${c.dataset.ring} 100`));
    card.querySelectorAll('[data-bar]').forEach((b) => { b.style.transform = ''; });
  }, 420)));
}

/** Steps keep coming in while the card is on screen. It is a sample; it says so. */
function tickSteps(page) {
  const el = page.querySelector('[data-steps]');
  const hero = page.querySelector('[data-hero]');
  const ringEl = el?.closest('.bt')?.querySelector('.val');
  if (!el || !ringEl) return;
  let steps = 8214; let seen = true;
  const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; });
  io.observe(hero);
  const tick = () => {
    if (!el.isConnected) { io.disconnect(); return; }
    if (seen && !document.hidden && steps < 9400) {
      steps += 1 + Math.floor(Math.random() * 4);
      el.textContent = fmt(steps);
      ringEl.setAttribute('stroke-dasharray', `${(steps / 100).toFixed(1)} 100`);
    }
    setTimeout(tick, 1400 + Math.random() * 2200);
  };
  setTimeout(tick, 2600);
}

/* ── each section gets one thing that happens once it is in view ──────────── */

function watchIn(page) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
      if (e.target.matches('[data-board]')) climb(e.target);
    }
  }, { rootMargin: '0px 0px -14% 0px', threshold: 0.15 });
  page.querySelectorAll('[data-in]').forEach((el) => io.observe(el));

  // The wires only run while they are on screen.
  const flow = page.querySelector('[data-flow]');
  const live = new IntersectionObserver(([e]) => flow.classList.toggle('live', e.isIntersecting));
  live.observe(flow);
}

/* ── the name: the plates light one at a time as you scroll past ──────────── */

function pinName(page) {
  const name = page.querySelector('[data-name]');
  const pin = name.querySelector('.lp-name__pin');
  let frame = 0;
  const fit = () => {
    name.classList.add('pin');
    if (pin.scrollHeight > page.clientHeight + 1 || pin.offsetWidth < 320) { name.classList.remove('pin'); name.removeAttribute('data-step'); }
    measure();
  };
  const measure = () => {
    frame = 0;
    if (!name.classList.contains('pin')) return;
    const r = name.getBoundingClientRect();
    const span = r.height - page.clientHeight;
    const p = span > 0 ? -r.top / span : 1;
    const step = p < 0.08 ? 0 : p < 0.36 ? 1 : p < 0.64 ? 2 : 3;
    if (name.dataset.step !== String(step)) name.dataset.step = String(step);
  };
  page.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(measure); }, { passive: true });
  if (document.fonts?.ready) document.fonts.ready.then(() => name.isConnected && fit());
  fit();
  const ro = new ResizeObserver(() => { if (!name.isConnected) { ro.disconnect(); return; } fit(); });
  ro.observe(page);
}

/* ── the board: you start third, and overtake ─────────────────────────────── */

function rewindBoard(page) {
  const board = page.querySelector('[data-board]');
  const you = board.querySelector('[data-you]');
  const karim = board.querySelector('[data-karim]');
  karim.after(you);
  you.querySelector('.lp-rank__r').textContent = '3';
  karim.querySelector('.lp-rank__r').textContent = '2';
  you.querySelector('[data-you-n]').textContent = '58,210';
}

function climb(board) {
  const you = board.querySelector('[data-you]');
  const karim = board.querySelector('[data-karim]');
  const n = you.querySelector('[data-you-n]');
  setTimeout(() => {
    const start = performance.now();
    const from = 58210; const to = 61420;
    let swapped = false;
    const run = (now) => {
      if (!n.isConnected) return;
      const t = Math.min(1, (now - start) / 1300);
      const v = from + (to - from) * (1 - (1 - t) ** 3);
      n.textContent = fmt(v);
      if (!swapped && v >= 60880) { swapped = true; swap(you, karim); }
      if (t < 1) requestAnimationFrame(run); else n.textContent = fmt(to);
    };
    requestAnimationFrame(run);
  }, 700);
}

function swap(you, karim) {
  const a = you.getBoundingClientRect().top;
  const b = karim.getBoundingClientRect().top;
  you.after(karim);
  you.querySelector('.lp-rank__r').textContent = '2';
  karim.querySelector('.lp-rank__r').textContent = '3';
  const ease = 'cubic-bezier(0.77, 0, 0.175, 1)';
  const dy1 = a - you.getBoundingClientRect().top;
  const dy2 = b - karim.getBoundingClientRect().top;
  you.animate([{ transform: `translateY(${dy1}px)` }, { transform: 'none' }], { duration: 520, easing: ease });
  karim.animate([{ transform: `translateY(${dy2}px)` }, { transform: 'none' }], { duration: 520, easing: ease });
}
