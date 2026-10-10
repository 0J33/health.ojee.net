/* Live heart rate on screen: the Today tile, the control that connects a
   sensor, the number beside a running workout's timer, and the help sheet.

   The readings and the Bluetooth connection live in ../live.js. These
   pieces only draw what that store holds, and every one of them keeps
   its size whether a reading is there or not, so nothing on the page
   moves when live heart rate starts or stops. */

import * as live from '../live.js';
import { html, raw, mount, ic, on, sheet, toast, toggle } from '../ui.js';
import { platform } from '../pwa.js';

/* ── words ──────────────────────────────────────────────────── */

/** "From this device" / "From Ojee Pulse". */
export function sourceText(s = live.get()) {
  if (s.local) return 'From this device';
  if (s.source === 'pulse') return 'From Ojee Pulse';
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
      text: platform.ios
        ? 'Apple does not allow web apps to use Bluetooth. Live heart rate shows here when another of your devices sends it.'
        : 'This browser cannot use Bluetooth. Live heart rate shows here when another of your devices sends it.',
      buttons: helpBtn,
    };
  }
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
        text: `This browser needs a tap before it can reach ${name} again.`,
        buttons: html`<button type="button" class="btn btn--s" data-live-act="connect">Reconnect</button>${stop}${helpBtn}`,
      };
    default:
      return {
        badge: liveElsewhere ? liveBadge() : '',
        text: liveElsewhere
          ? `${sourceText(s)}. You can also read a sensor straight from this browser.`
          : 'Read a watch or chest strap that broadcasts its heart rate, straight from this browser.',
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
    toast(err?.name === 'SecurityError' || err?.name === 'NotAllowedError'
      ? 'Bluetooth is blocked for this site. Allow it in your browser settings, then try again.'
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
          ${item('Chrome or Edge, on Android or a computer', 'Tap Connect a heart-rate sensor and pick yours. After that the app finds it again by itself and reconnects when it drops.')}
          ${item('iPhone and iPad', 'Apple does not allow web apps to use Bluetooth, in any browser or from the Home Screen. Live heart rate shows here when another of your devices sends it, such as a computer running Ojee Pulse or an Android phone with this app open.')}
          ${item('Firefox and Safari', 'They have no Bluetooth for web pages. The same applies: another of your devices can send it.')}
        </div>
      </div>
      <p class="prose">${s.wake.supported ? 'Phones pause Bluetooth for a web page when the screen locks, so turn on Keep screen awake while live if you want it to carry on through a workout. ' : 'Phones pause Bluetooth for a web page when the screen locks, so keep the screen on while you want live readings. '}Close to the sensor is best: a few metres, with nothing solid in between.</p>
      <p class="prose">Live readings are shown only to you, on your own signed-in devices. They are not saved, and they never appear on your profile or the leaderboard.</p>
    </div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Done</button>`,
  });
}
