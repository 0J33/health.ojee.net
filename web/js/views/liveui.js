/* Live heart rate on screen: the Today tile, the control that connects a
   sensor, the number beside a running workout's timer, and the help sheet.

   The readings and the Bluetooth connection live in ../live.js. These
   pieces only draw what that store holds, and every one of them keeps
   its size whether a reading is there or not, so nothing on the page
   moves when live heart rate starts or stops. */

import * as live from '../live.js';
import { html, raw, mount, ic, on, sheet, toast } from '../ui.js';
import { platform } from '../pwa.js';
import { listen } from '../app.js';
import { icon as iconSvg } from '../icons.js';
import { stGrp, stRow, stSwitch, stLab } from '../apps.js';

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

/* ── pinned to Today ─────────────────────────────────────────── */

/* Live heart rate sits at the top of Today only while it is live and pinned.
   A new connection pins it; Unpin sends it back to the corner button until
   live heart rate has stopped for a minute and starts again. */
const UNPIN_KEY = 'health.liveUnpinned';
let unpinned = (() => { try { return sessionStorage.getItem(UNPIN_KEY) === '1'; } catch { return false; } })();
const isLive = (s) => s.bpm !== null && s.bpm > 0;
/** Whether Today shows the big live card now. */
export const pinned = (s = live.get()) => isLive(s) && !unpinned;
const pinWatchers = new Set();
export function setPinned(on) {
  unpinned = !on;
  try { if (on) sessionStorage.removeItem(UNPIN_KEY); else sessionStorage.setItem(UNPIN_KEY, '1'); } catch { /* fine: for this page only */ }
  for (const fn of pinWatchers) fn();
}
let endTimer = null;
live.subscribe((s) => {
  if (isLive(s)) { clearTimeout(endTimer); endTimer = null; return; }
  if (unpinned && !endTimer) endTimer = setTimeout(() => { endTimer = null; if (!isLive(live.get())) setPinned(true); }, 60_000);
});

/** The sensor controls in a sheet (Today's heart tile always shows the number). */
export function openLiveSheet() {
  const sh = sheet({ title: 'Live heart rate', body: liveControl() });
  const stop = bindLive(sh.el);
  sh.closed.then(() => stop());
  return sh;
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

/* ── the Today bento tile ───────────────────────────────────── */

/**
 * Today's heart tile (redesign): the live bpm when there is one, beating at
 * that rate, else the latest synced reading. `synced` is { v, s } (number
 * and words) or null. Tapping it opens the sensor controls.
 */
export function heartBento({ synced }) {
  return html`<button type="button" class="bt bt--heart bt-small bt-heart" data-live-bt aria-label="Heart rate">
    <div class="bt__row"><span class="bt__lab">${ic('heart')}Heart</span><span class="livechip livechip--idle" data-bt-chip><i></i><span>Connect</span></span></div>
    <svg class="ecg" viewBox="0 0 120 30" aria-hidden="true"><path d="M0 18h34l4-6 4 6h8l4-15 5 26 4-11h14l4-4 4 4h35"/></svg>
    <div><p class="n n-m" data-bt-v>${synced ? raw(synced.v) : '–'}</p><p class="bt__sub" data-bt-s>${synced ? synced.s : 'No reading yet'}</p></div>
  </button>`;
}

function paintBento(el, s) {
  const b = s.ble || {};
  const on_ = s.bpm !== null && s.bpm > 0;
  if (!el.dataset.synced) el.dataset.synced = JSON.stringify([el.querySelector('[data-bt-v]').innerHTML, el.querySelector('[data-bt-s]').textContent]);
  const [sv, ss] = JSON.parse(el.dataset.synced);
  const chip = el.querySelector('[data-bt-chip]');
  el.classList.toggle('is-live', on_);
  const want = b.status && b.status !== 'off';
  const word = on_ ? 'Live' : b.status === 'tap' ? 'Reconnect' : b.status === 'connecting' ? 'Connecting' : b.status === 'reconnecting' ? 'Reconnecting' : b.status === 'away' ? 'Out of range' : s.bpm === 0 ? 'Off wrist' : want ? 'Waiting' : 'Connect';
  chip.classList.toggle('livechip--idle', !on_);
  chip.querySelector('span').textContent = word;
  if (on_) el.style.setProperty('--beat', `${Math.max(0.3, Math.min(2, 60 / s.bpm)).toFixed(2)}s`);
  // While live only the digits change: the beating element stays, so its beat stays in step with the heart's.
  const vEl = el.querySelector('[data-bt-v]');
  const hb = vEl.querySelector('.hb');
  if (on_ && hb) hb.textContent = String(Math.round(s.bpm));
  else vEl.innerHTML = on_ ? `<span class="hb">${Math.round(s.bpm)}</span><span class="u">bpm</span>` : sv;
  el.querySelector('[data-bt-s]').textContent = on_ ? sourceText(s) : ss;
  el.setAttribute('aria-label', on_ ? `Heart rate, live: ${Math.round(s.bpm)} beats per minute. ${sourceText(s)}. Opens the sensor controls.` : `Heart rate: ${ss}. ${word === 'Connect' ? 'Connect a sensor for live heart rate.' : word}.`);
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
export const liveControl = () => html`<section class="livectl" data-live-ctl aria-label="Live heart rate"></section>`;

/** What the control says now: a state (dot and word), one line, the buttons. */
function controlParts(s) {
  const b = s.ble;
  const name = b.name || 'your sensor';
  const stop = html`<button type="button" class="btn btn--tonal" data-live-act="disconnect">Disconnect</button>`;
  const liveElsewhere = s.bpm !== null && !s.local;
  const liveDot = ['ok', 'Live'];
  if (!b.supported) {
    return {
      state: liveElsewhere ? liveDot : ['off', 'No Bluetooth here'],
      text: platform.native
        ? 'This version of the app cannot use Bluetooth. Install the latest Health app.'
        : platform.ios
          ? 'Apple does not let websites use Bluetooth. It shows here when another of your devices sends it.'
          : 'This browser has no Bluetooth. It shows here when another of your devices sends it. Chrome or Edge can connect.',
      buttons: '',
    };
  }
  // In the Health app it is the phone that reaches the sensor, not a browser.
  const here = b.native ? 'this phone' : 'this browser';
  switch (b.status) {
    case 'connecting':
      return { state: ['accent', 'Connecting'], text: `Reaching ${name}.`, buttons: stop };
    case 'connected':
      return { state: s.local ? liveDot : ['ok', 'Connected'], text: s.local ? `${name}. Your other devices see it too.` : `${name} is connected. Waiting for a reading: wear it snugly.`, buttons: stop };
    case 'reconnecting':
      return { state: ['warn', 'Reconnecting'], text: `Lost ${name}. Trying again by itself.`, buttons: stop };
    case 'away':
      return { state: ['warn', 'Out of range'], text: `Still looking for ${name}. Bring it closer.`, buttons: stop };
    case 'tap':
      return {
        state: liveElsewhere ? liveDot : ['warn', 'Needs a tap'],
        text: b.native ? `Tap Reconnect to find ${name} again.` : `This browser needs a tap before it can reach ${name} again.`,
        buttons: html`<button type="button" class="btn" data-live-act="connect">Reconnect</button>${stop}`,
      };
    default:
      return {
        state: liveElsewhere ? liveDot : ['off', 'Not connected'],
        text: liveElsewhere ? `${sourceText(s)}. You can also read a sensor from ${here}.` : `Read a strap or watch that broadcasts its heart rate, from ${here}.`,
        buttons: b.remembered
          ? html`<button type="button" class="btn" data-live-act="connect">Connect ${name}</button><button type="button" class="btn btn--tonal" data-live-act="choose">Another sensor</button>`
          : html`<button type="button" class="btn" data-live-act="choose">Connect a heart-rate sensor</button>`,
      };
  }
}

const drawn = new WeakMap();
function paintControl(el, s) {
  const p = controlParts(s);
  const body = String(html`${stGrp(html`
      ${stRow({ icon: 'heart', fam: p.state[0] === 'ok' ? 'heart' : '', title: p.state[1], sub: html`<span role="status">${p.text}</span>`, top: true })}
      ${s.wake.supported ? stSwitch('live-awake', s.wake.on, 'Keep the screen awake', 'While it is live', { icon: 'screen', label: 'Keep screen awake while live' }) : ''}
      ${stRow({ btn: true, attrs: 'data-live-act="help"', icon: 'info', title: 'How it works' })}`)}
    ${p.buttons ? html`<div class="st-cta">${p.buttons}</div>` : ''}`);
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
  const bts = root.querySelectorAll('[data-live-bt]');
  for (const el of bts) paintBento(el, s);
  if (bts.length) queueMicrotask(() => repaintPill());
}

/* ── Today's top card: the live number, big ─────────────────── */

/** The top of Today: while live and pinned, the bpm big with the last minute beside it; otherwise nothing (the corner button has it). */
export const liveHero = () => html`<section class="lhero" data-live-hero aria-label="Live heart rate" hidden></section>`;

const heroDrawn = new WeakMap();
function paintHero(el, s) {
  const live_ = pinned(s);
  const mode = live_ ? 'live' : 'none';
  if (heroDrawn.get(el) !== mode) {
    heroDrawn.set(el, mode);
    el.classList.toggle('is-live', live_);
    el.hidden = !live_;
    queueMicrotask(repaintPill);
    mount(el, live_ ? html`<div class="lhero__main">
        <p class="lhero__k">${ic('heart')}<span>Live heart rate</span><span class="livebadge__dot" aria-hidden="true"></span></p>
        <p class="lhero__v"><span data-hero-v></span><span class="lhero__u">bpm</span></p>
        <p class="lhero__s" data-hero-s></p>
      </div>
      <div class="lhero__spark" data-hero-spark></div>
      <span class="lhero__acts">
        <button type="button" class="iconbtn" data-hero-unpin aria-label="Unpin from Today" title="Unpin">${ic('pin')}</button>
        <button type="button" class="iconbtn" data-hero-more aria-label="Heart-rate sensor controls">${ic('more')}</button>
      </span>`
      : '');
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      on(el, 'click', '[data-hero-more]', () => openLiveSheet());
      on(el, 'click', '[data-hero-unpin]', () => { setPinned(false); paintLive(); toast('Unpinned. Tap the heart button to see it.'); });
      const redraw = () => paintHero(el, live.get());
      pinWatchers.add(redraw);
    }
  }
  if (live_) {
    el.querySelector('[data-hero-v]').textContent = String(Math.round(s.bpm));
    el.querySelector('[data-hero-s]').textContent = sourceText(s);
    mount(el.querySelector('[data-hero-spark]'), raw(spark(s.recent, s.t)));
    el.querySelector('[data-hero-spark] svg')?.setAttribute('preserveAspectRatio', 'none');
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
    on(root, 'click', '[data-live-bt]', (e) => {
      e.preventDefault();
      const st = live.get().ble?.status;
      if (st === 'tap' || st === 'reconnecting' || st === 'away') act('connect', e.target.closest('[data-live-bt]')); else openLiveSheet();
    });
    on(root, 'change', 'input[name="live-awake"]', (e, input) => live.setAwake(input.checked));
  }
  paintLive(root);
  return live.subscribe(() => paintLive(root));
}

/* ── help ───────────────────────────────────────────────────── */

export function liveHelp() {
  const s = live.get();
  const native = platform.native;
  const item = (title, text) => stRow({ title, sub: text, top: true });
  return sheet({
    title: 'Live heart rate',
    body: html`<div class="st-sheet livehelp">
      <p class="st-lead">Google Health's heart rate is a few minutes old. To see it as it happens, your watch or strap broadcasts it over Bluetooth and a device of yours listens.</p>
      ${stLab('Turn on broadcasting')}
      ${stGrp(html`
        ${item('Fitbit Air', 'In the Google Health app, open your device and turn on Share heart rate.')}
        ${item('Garmin', 'On the watch, turn on Broadcast heart rate.')}
        ${item('Polar and chest straps', 'They broadcast whenever they are worn.')}
        ${item('Apple Watch', 'It cannot broadcast its heart rate, so it cannot be used for this.')}`)}
      ${stLab('Where it works')}
      ${stGrp(html`
        ${native ? item('This app', 'Works here, even with the screen locked. Tap Connect a heart-rate sensor and pick yours; it reconnects by itself after that.') : ''}
        ${item('Chrome or Edge, on Android or a computer', 'Tap Connect a heart-rate sensor and pick yours; it reconnects by itself after that.')}
        ${native
    ? item('Safari and the Home Screen web app', 'Apple does not allow web apps to use Bluetooth. They show it when another of your devices sends it, and this app is one of them.')
    : item('iPhone and iPad', 'Apple does not allow web apps to use Bluetooth. It shows here when another of your devices sends it, such as a computer running Ojee Pulse or an Android phone with this app open. The Health iPhone app can read a sensor itself.')}
        ${item('Firefox and Safari', 'No Bluetooth for web pages. Another of your devices can send it.')}
        ${item('The home relay', 'A computer at home reads your sensor when you are near and passes it to every device you have this app open on. It steps aside when one of your own devices connects.')}
        ${native ? '' : item('Bluefy, on iPhone', html`A free iPhone browser that can use Bluetooth: open this site in <a class="link" href="${BLUEFY}" target="_blank" rel="noopener">Bluefy</a> and connect as in Chrome.`)}`)}
      ${stLab('Good to know')}
      ${stGrp(html`
        ${item('With the screen locked', native ? 'This app keeps reading in the background. Swiping it away in the app switcher stops it.'
    : s.wake.supported ? 'Phones pause Bluetooth for a web page when the screen locks. Turn on Keep the screen awake for a whole workout.' : 'Phones pause Bluetooth for a web page when the screen locks, so keep the screen on.')}
        ${item('Distance', 'A few metres, with nothing solid in between, is best.')}
        ${item('Private', 'Live readings are shown only to you, on your own devices. They are not saved and never appear on your profile or the leaderboard.')}`)}
    </div>`,
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
    // Pinned on Today: the big card at the top shows it already.
    const onHero = Boolean(document.querySelector('[data-live-hero].is-live:not([hidden]), [data-live-bt]'));
    // Nothing going on: a Connect button, on Today only.
    const idle = !want && !elsewhere;
    const show = !onHero && (!idle || location.pathname === '/');
    let cls = 'lpill'; let body = ''; let label = '';
    if (!show) btn.hidden = true;
    else {
      const name = b.name || 'sensor';
      if (idle) {
        cls += ' is-cta';
        body = `${iconSvg('heart', { size: 's' })}<span>Live heart rate</span>`;
        label = 'Live heart rate: connect a sensor';
      } else if (s.bpm !== null && s.bpm > 0) {
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
    openLiveSheet();
  });
  repaintPill = () => paint(live.get());
  listen('route', () => paint(live.get()));
  pinWatchers.add(repaintPill);
  paint(live.get());
  return live.subscribe(paint);
}
let repaintPill = () => {};
