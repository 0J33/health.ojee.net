/* Live heart rate on screen: the Today tile, the control that connects a
   sensor, the number beside a running workout's timer, and the help sheet.

   The readings and the Bluetooth connection live in ../live.js. These
   pieces only draw what that store holds, and every one of them keeps
   its size whether a reading is there or not, so nothing on the page
   moves when live heart rate starts or stops. */

import * as live from '../live.js';
import { html, raw, mount, ic, on, sheet, toast, toggle } from '../ui.js';
import { platform } from '../pwa.js';
import { icon as iconSvg } from '../icons.js';

const BLUEFY = 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055';

/* ── words ──────────────────────────────────────────────────── */

/** "From this device" / "From Ojee Pulse". */
export function sourceText(s = live.get()) {
  if (s.local) return 'From this device';
  if (s.source === 'pulse') return 'From Ojee Pulse';
  if (/^relay/.test(s.source || '')) return `From the home relay${s.source.length > 6 ? ` (${s.source.slice(6)})` : ''}`;
  if (s.source === 'browser') return 'From another of your devices';
  return s.source ? `From ${s.source}` : 'From another of your devices';
}

const liveBadge = () => html`<span class="livebadge"><span class="livebadge__dot"></span>Live</span>`;

/* ── the last minute, as a line ─────────────────────────────── */

const SPARK_W = 120; const SPARK_H = 28;
function spark(recent, now) {
  const from = now - 60_000;
  const pts = recent.filter((p) => p[0] >= from);
  if (pts.length < 2) return '';
  let lo = Infinity; let hi = -Infinity;
  for (const p of pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  // A steady heart is a flat line, not a mountain range: never zoom past 12 bpm.
  const span = Math.max(12, hi - lo);
  const mid = (hi + lo) / 2;
  const x = (t) => Math.round(((t - from) / 60_000) * SPARK_W * 10) / 10;
  const y = (v) => Math.round((SPARK_H / 2 - ((v - mid) / span) * (SPARK_H - 6)) * 10) / 10;
  let d = ''; let prev = null;
  for (const [t, v] of pts) {
    // A gap of more than a few seconds is a gap, not a slope.
    d += `${prev !== null && t - prev < 6000 ? 'L' : 'M'}${x(t)},${y(v)}`;
    prev = t;
  }
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" focusable="false"><path class="spark__line" d="${d}"/></svg><span class="spark__dot" data-style="left:${((x(last[0]) / SPARK_W) * 100).toFixed(1)}%;top:${((y(last[1]) / SPARK_H) * 100).toFixed(1)}%"></span>`;
}

/* ── Today's heart tile ─────────────────────────────────────── */

/**
 * The heart-rate tile. `synced` is what the tile says without a live
 * reading: { v, s } (trusted markup and plain text), or null when the
 * device reports no heart rate at all and `na` explains that.
 */
export function heartTile({ synced, na }) {
  // The synced and the live version sit in the same cell, one of them
  // invisible, so the tile is as tall as the taller one at all times.
  return html`<a class="tile tile--hr" href="/trends/heart" data-live-tile>
    <p class="tile__k">${ic('heart')}Heart rate</p>
    <div class="swap">
      <p class="tile__v ${synced ? '' : 'tile__v--na'}" data-sync>${synced ? synced.v : 'Not available'}</p>
      <p class="tile__v" data-live data-live-v data-off aria-hidden="true"></p>
    </div>
    <div class="swap">
      <p class="tile__s" data-sync>${synced ? synced.s : na}</p>
      <div class="tile__livefoot" data-live data-off aria-hidden="true">
        <p class="tile__s" data-live-s></p>
        <div class="tile__liverow">${liveBadge()}<div class="spark" data-live-spark></div></div>
      </div>
    </div>
  </a>`;
}

function paintTile(el, s) {
  const live_ = s.bpm !== null;
  const show = (node, yes) => {
    node.toggleAttribute('data-off', !yes);
    if (yes) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', 'true');
  };
  for (const n of el.querySelectorAll('[data-live]')) show(n, live_);
  for (const n of el.querySelectorAll('[data-sync]')) show(n, !live_);
  if (live_) {
    mount(el.querySelector('[data-live-v]'), html`${Math.round(s.bpm)}<span class="unit">bpm</span>`);
    el.querySelector('[data-live-s]').textContent = sourceText(s);
    el.setAttribute('aria-label', `Heart rate, live: ${Math.round(s.bpm)} beats per minute. ${sourceText(s)}.`);
  } else el.removeAttribute('aria-label');
  mount(el.querySelector('[data-live-spark]'), live_ ? raw(spark(s.recent, s.t)) : '');
}

/* ── the number beside a running workout's timer ────────────── */

function paintBpm(el, s) {
  const text = s.bpm === null ? '' : String(Math.round(s.bpm));
  if (el.dataset.shown === text) return;
  el.dataset.shown = text;
  mount(el, text ? html`${ic('heart', { size: 's' })}<span>${text}</span><span class="now__hru">bpm</span>` : '');
  if (text) el.setAttribute('aria-label', `Live heart rate ${text} beats per minute`); else el.removeAttribute('aria-label');
}

/* ── the control ────────────────────────────────────────────── */

/** Where the "Live heart rate" control goes; bindLive() fills it in. */
export const liveControl = () => html`<section class="group livectl" data-live-ctl aria-label="Live heart rate"></section>`;

function controlParts(s) {
  const b = s.ble;
  const name = b.name || 'your sensor';
  const helpBtn = html`<button type="button" class="btn btn--ghost btn--s" data-live-act="help">How it works</button>`;
  const stop = html`<button type="button" class="btn btn--tonal btn--s" data-live-act="disconnect">Disconnect</button>`;
  const liveElsewhere = s.bpm !== null && !s.local;
  if (!b.supported) {
    return {
      badge: liveElsewhere ? liveBadge() : '',
      text: platform.native
        ? 'This version of the app cannot use Bluetooth. Install the latest Health app, and live heart rate works here.'
        : platform.ios
          ? html`<strong>There is no Connect button on iPhone.</strong> Apple does not let websites use Bluetooth, in Safari or from the Home Screen. Your live heart rate still shows here whenever another of your devices sends it, such as your computer running Ojee Pulse. To connect this iPhone to the sensor itself, use the Health iPhone app, or <a class="link" href="${BLUEFY}" target="_blank" rel="noopener">Bluefy</a> for a sensor the phone is not already connected to.`
          : 'This browser cannot use Bluetooth, but live heart rate still shows here when the home relay or another of your devices passes it on. Chrome or Edge can connect to the sensor directly.',
      buttons: helpBtn,
    };
  }
  // In the Health app it is the phone that reaches the sensor, not a browser.
  const here = b.native ? 'this phone' : 'this browser';
  switch (b.status) {
    case 'connecting':
      return { badge: html`<span class="badge">Connecting…</span>`, text: `Reaching ${name}.`, buttons: html`${stop}${helpBtn}` };
    case 'connected':
      return {
        badge: s.local ? liveBadge() : html`<span class="badge">Connected</span>`,
        text: s.local ? `${name}. Your other devices see it too.` : `${name} is connected. Waiting for a reading: wear it snugly.`,
        buttons: html`${stop}${helpBtn}`,
      };
    case 'reconnecting':
      return { badge: html`<span class="badge">Reconnecting…</span>`, text: `Lost ${name}. Trying again by itself.`, buttons: html`${stop}${helpBtn}` };
    case 'away':
      return { badge: html`<span class="badge badge--warn">Sensor out of range</span>`, text: `Still looking for ${name}. Bring it closer, or check that it is still broadcasting.`, buttons: html`${stop}${helpBtn}` };
    case 'tap':
      return {
        badge: liveElsewhere ? liveBadge() : '',
        text: b.native ? `Tap Reconnect to find ${name} again.` : `This browser needs a tap before it can reach ${name} again.`,
        buttons: html`<button type="button" class="btn btn--s" data-live-act="connect">Reconnect</button>${stop}${helpBtn}`,
      };
    default:
      return {
        badge: liveElsewhere ? liveBadge() : '',
        text: liveElsewhere
          ? `${sourceText(s)}. You can also read a sensor straight from ${here}.`
          : `Read a watch or chest strap that broadcasts its heart rate, straight from ${here}.`,
        buttons: b.remembered
          ? html`<button type="button" class="btn btn--s" data-live-act="connect">Connect ${name}</button><button type="button" class="btn btn--tonal btn--s" data-live-act="choose">Another sensor</button>${helpBtn}`
          : html`<button type="button" class="btn btn--s" data-live-act="choose">Connect a heart-rate sensor</button>${helpBtn}`,
      };
  }
}

const drawn = new WeakMap();
function paintControl(el, s) {
  const p = controlParts(s);
  const body = String(html`<div class="row row--top">
      <span class="row__ic">${ic('wave')}</span>
      <span class="row__body">
        <span class="livectl__head"><span class="row__t">Live heart rate</span>${p.badge}</span>
        <span class="row__d livectl__d" role="status">${p.text}</span>
        <span class="btnrow livectl__act">${p.buttons}</span>
      </span>
    </div>
    ${s.wake.supported ? html`<div class="row">
      <span class="row__ic">${ic('screen')}</span>
      <span class="row__body"><span class="row__t">Keep screen awake while live</span></span>
      ${toggle('live-awake', s.wake.on, { label: 'Keep screen awake while live' })}
    </div>` : ''}`);
  // Only when something it shows has changed: a button being pressed must
  // not be replaced under the finger by the next heartbeat.
  if (drawn.get(el) === body) return;
  drawn.set(el, body);
  mount(el, raw(body));
}

async function act(name, btn) {
  if (name === 'help') { liveHelp(); return; }
  if (name === 'disconnect') { live.disconnect(); toast('Sensor disconnected'); return; }
  btn?.classList.add('is-busy');
  try {
    await live.connect({ choose: name === 'choose' });
  } catch (err) {
    const blocked = err?.name === 'SecurityError' || err?.name === 'NotAllowedError';
    toast(err?.name === 'BluetoothOffError' ? 'Bluetooth is off. Turn it on in Control Centre or Settings, then try again.'
      : blocked && platform.native ? 'Health is not allowed to use Bluetooth. Open Settings, Health, turn on Bluetooth, then try again.'
        : blocked ? 'Bluetooth is blocked for this site. Allow it in your browser settings, then try again.'
          : 'Could not reach a sensor. Check that Bluetooth is on and the sensor is broadcasting.', { tone: 'bad', ms: 7000 });
  } finally { btn?.classList.remove('is-busy'); }
}

/* ── wiring ─────────────────────────────────────────────────── */

/** Draw every live piece under `root` from the store as it is now. */
export function paintLive(root = document) {
  const s = live.get();
  for (const el of root.querySelectorAll('[data-live-tile]')) paintTile(el, s);
  for (const el of root.querySelectorAll('[data-live-bpm]')) paintBpm(el, s);
  for (const el of root.querySelectorAll('[data-live-ctl]')) paintControl(el, s);
  for (const el of root.querySelectorAll('[data-live-hero]')) paintHero(el, s);
}

/* ── Today's top card: the live number, big ─────────────────── */

/** The top of Today: while live, the bpm big with the last minute beside it; otherwise the control (Connect). */
export const liveHero = () => html`<section class="lhero" data-live-hero aria-label="Live heart rate"></section>`;

const heroDrawn = new WeakMap();
function paintHero(el, s) {
  const live_ = s.bpm !== null && s.bpm > 0;
  const mode = live_ ? 'live' : 'ctl';
  if (heroDrawn.get(el) !== mode) {
    heroDrawn.set(el, mode);
    el.classList.toggle('is-live', live_);
    mount(el, live_ ? html`<div class="lhero__main">
        <p class="lhero__k">${ic('heart')}<span>Live heart rate</span><span class="livebadge__dot" aria-hidden="true"></span></p>
        <p class="lhero__v"><span data-hero-v></span><span class="lhero__u">bpm</span></p>
        <p class="lhero__s" data-hero-s></p>
      </div>
      <div class="lhero__spark" data-hero-spark></div>
      <button type="button" class="iconbtn lhero__more" data-hero-more aria-label="Heart-rate sensor controls">${ic('more')}</button>`
      : html`${liveControl()}`);
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      // Its Connect buttons are wired by the screen's bindLive; only the sheet is its own.
      on(el, 'click', '[data-hero-more]', () => { const sh = sheet({ title: 'Live heart rate', body: html`${liveControl()}` }); const stop = bindLive(sh.el); sh.closed.then(stop); });
    }
  }
  if (live_) {
    el.querySelector('[data-hero-v]').textContent = String(Math.round(s.bpm));
    el.querySelector('[data-hero-s]').textContent = sourceText(s);
    mount(el.querySelector('[data-hero-spark]'), raw(spark(s.recent, s.t)));
    el.querySelector('[data-hero-spark] svg')?.setAttribute('preserveAspectRatio', 'none');
  } else {
    const c = el.querySelector('[data-live-ctl]');
    if (c) paintControl(c, s);
  }
}

/**
 * Keep the live pieces under `root` current, and make the control's
 * buttons work. Call once per screen; returns the function that stops it.
 * After the screen repaints itself, call paintLive(root).
 */
export function bindLive(root) {
  if (!root.dataset.liveBound) {
    root.dataset.liveBound = '1';
    on(root, 'click', '[data-live-act]', (e, btn) => { e.preventDefault(); act(btn.dataset.liveAct, btn); });
    on(root, 'change', 'input[name="live-awake"]', (e, input) => live.setAwake(input.checked));
  }
  paintLive(root);
  return live.subscribe(() => paintLive(root));
}

/* ── help ───────────────────────────────────────────────────── */

export function liveHelp() {
  const s = live.get();
  const native = platform.native;
  const item = (title, text) => html`<div class="row row--top"><span class="row__body"><span class="row__t">${title}</span><span class="row__d">${text}</span></span></div>`;
  return sheet({
    title: 'Live heart rate',
    body: html`<div class="stack livehelp">
      <p class="prose">The heart rate that comes through Google Health is a few minutes old. To see it as it happens, your watch or strap has to broadcast it over Bluetooth, and a device of yours has to be listening.</p>
      <div>
        <p class="h3 livehelp__h">Turn on broadcasting</p>
        <div class="group">
          ${item('Fitbit Air', 'In the Google Health app, open your device and turn on Share heart rate.')}
          ${item('Garmin', 'On the watch, turn on Broadcast heart rate.')}
          ${item('Polar and chest straps', 'They broadcast whenever they are worn. Nothing to turn on.')}
          ${item('Apple Watch', 'It cannot broadcast its heart rate, so it cannot be used for this.')}
        </div>
      </div>
      <div>
        <p class="h3 livehelp__h">Where it works</p>
        <div class="group">
          ${native ? item('This app', 'Live heart rate works in this app, including with the screen locked. Tap Connect a heart-rate sensor and pick yours. After that the app finds it again by itself and reconnects when it drops.') : ''}
          ${item('Chrome or Edge, on Android or a computer', 'Tap Connect a heart-rate sensor and pick yours. After that the app finds it again by itself and reconnects when it drops.')}
          ${native
    ? item('Safari and the Home Screen web app', 'Apple does not allow web apps to use Bluetooth, in any browser or from the Home Screen. Live heart rate shows there when another of your devices sends it, and this app is one of them.')
    : item('iPhone and iPad', 'Apple does not allow web apps to use Bluetooth, in any browser or from the Home Screen. Live heart rate shows here when another of your devices sends it, such as a computer running Ojee Pulse or an Android phone with this app open. The Health iPhone app can read a sensor itself.')}
          ${item('Firefox and Safari', 'They have no Bluetooth for web pages. The same applies: another of your devices can send it.')}
          ${item('The home relay', 'A computer at home with Bluetooth reads your sensor when you are near it and passes the reading to every device you have this app open on, Safari included. It steps aside by itself the moment one of your own devices connects.')}
          ${native ? '' : item('Bluefy, on iPhone', html`A free iPhone browser that can use Bluetooth: open this site in <a class="link" href="${BLUEFY}" target="_blank" rel="noopener">Bluefy</a> and connect here as you would in Chrome.`)}
        </div>
      </div>
      <p class="prose">${native ? 'This app keeps reading with the screen locked and while you use other apps. Leave it open in the background: swiping it away in the app switcher stops it. '
        : s.wake.supported ? 'Phones pause Bluetooth for a web page when the screen locks, so turn on Keep screen awake while live if you want it to carry on through a workout. ' : 'Phones pause Bluetooth for a web page when the screen locks, so keep the screen on while you want live readings. '}Close to the sensor is best: a few metres, with nothing solid in between.</p>
      <p class="prose">Live readings are shown only to you, on your own signed-in devices. They are not saved, and they never appear on your profile or the leaderboard.</p>
    </div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Done</button>`,
  });
}

/* ── the pill: live heart rate on every screen ──────────────── */

/**
 * A small pill in the corner of every screen while a sensor is in use (or a
 * reading arrives from another device): the bpm with a beating heart; when
 * the sensor dropped, "Reconnecting…"; when the browser needs a tap to reach
 * it again, a "Tap to reconnect" button, one tap. Tapping it while live
 * opens the controls in a sheet. Mounted once by main.js.
 */
export function livePill(host) {
  host.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lpill';
  btn.hidden = true;
  host.append(btn);
  let last = '';
  const paint = (s) => {
    const b = s.ble;
    const want = b.status !== 'off';
    const elsewhere = s.bpm !== null && !s.local;
    // On Today the big card at the top shows it already.
    const show = (want || elsewhere) && !document.querySelector('[data-live-hero].is-live');
    let cls = 'lpill'; let body = ''; let label = '';
    if (!show) btn.hidden = true;
    else {
      const name = b.name || 'sensor';
      if (s.bpm !== null && s.bpm > 0) {
        cls += ' is-live';
        body = `${iconSvg('heart', { size: 's' })}<b>${s.bpm}</b><small>bpm</small>`;
        label = `Live heart rate ${s.bpm} bpm. ${sourceText(s)}. Tap for the controls.`;
      } else if (b.status === 'tap') {
        cls += ' is-tap';
        body = `${iconSvg('refresh', { size: 's' })}<span>Tap to reconnect</span>`;
        label = `Tap to reconnect ${name}`;
      } else if (b.status === 'reconnecting' || b.status === 'connecting') {
        cls += ' is-wait';
        body = `${iconSvg('heart', { size: 's' })}<span>${b.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>`;
        label = `${b.status === 'connecting' ? 'Connecting to' : 'Reconnecting to'} ${name}. Tap to try now.`;
      } else if (b.status === 'away') {
        cls += ' is-wait';
        body = `${iconSvg('heart', { size: 's' })}<span>Out of range</span>`;
        label = `${name} is out of range. Tap to try now.`;
      } else if (s.bpm === 0) {
        cls += ' is-wait';
        body = `${iconSvg('heart', { size: 's' })}<span>Not on the wrist</span>`;
        label = 'The sensor is not touching the skin.';
      } else {
        cls += ' is-wait';
        body = `${iconSvg('heart', { size: 's' })}<span>Waiting…</span>`;
        label = `${name} is connected. Waiting for a reading.`;
      }
      const key = cls + body;
      if (key !== last) { last = key; btn.className = cls; btn.innerHTML = body; btn.setAttribute('aria-label', label); }
      btn.hidden = false;
    }
  };
  btn.addEventListener('click', () => {
    const s = live.get();
    const st = s.ble.status;
    // Not reading: one tap tries again at once (and opens the chooser only if the browser insists).
    if (st === 'tap' || st === 'reconnecting' || st === 'away') { act('connect', btn); return; }
    const sh = sheet({ title: 'Live heart rate', body: html`${liveControl()}` });
    const stop = bindLive(sh.el);
    sh.closed.then(stop);
  });
  paint(live.get());
  return live.subscribe(paint);
}
