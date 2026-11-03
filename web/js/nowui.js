/* Who is here now, and who is working out (GET /api/now, server/presence.js).

     nowStrip(d)   People's Now strip: working out first, as cards that say
                   what (the workout, the exercise and set, the route and its
                   distance, the bpm when their heart is shared), then
                   everybody else online, as faces with a dot
     nowBadge(n)   one line under a profile's name: "Online", or what they
                   are doing and for how long
     nowPreview(u) tapping one: what they are doing, live (GET /api/now/:u):
                   the route so far on a map (friends only), the time, the
                   distance and pace; the workout's exercise and set and its
                   plan; the bpm and its last two minutes (with their heart)
     bindNow(root) the taps that open it

   Each person chooses whether they show (Me, Privacy); it is on by default
   for a public account. */

import { html, raw, ic, mount, sheet, on } from './ui.js';
import { api } from './api.js';
import { go } from './app.js';
import * as f from './format.js';
import { avatar } from './views/shared.js';

const ROUTE = { RUNNING: ['Run', 'run'], WALKING: ['Walk', 'walk'], HIKING: ['Hike', 'hike'], BIKING: ['Ride', 'bike'], MOUNTAIN_BIKE: ['Mountain bike', 'bike'], ROLLERBLADING: ['Skate', 'sport'] };
const nameOf = (p) => p.displayName || p.username;

/** Minutes, then hours: "34 min", "1 h 05". */
function since(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/**
 * What somebody is doing, in words: { icon, what, doing, time }.
 * `at`: when the server said so (a route's moving time is as of then).
 */
export function doingOf(a, at = Date.now()) {
  if (!a) return null;
  const t = Date.now();
  if (a.kind === 'route') {
    const [word, icon] = ROUTE[a.type] || ['Route', 'route'];
    const ms = Number.isFinite(a.ms) ? a.ms + (a.paused ? 0 : t - at) : t - a.start;
    return {
      icon, what: a.type ? `${word}${a.paused ? ', paused' : ''}` : (a.paused ? 'Route, paused' : 'Recording a route'),
      doing: Number.isFinite(a.m) ? f.dist(a.m) : '', time: since(ms),
    };
  }
  const d = a.doing;
  return {
    icon: 'dumbbell',
    what: a.title || 'Working out',
    doing: a.resting ? (d ? `Resting · ${d.name} next` : 'Resting') : d ? `${d.name}${d.of ? ` · set ${d.set} of ${d.of}` : ''}` : (a.sets ? f.plural(a.sets, 'set') : ''),
    time: since(t - a.start),
  };
}

const heart = (bpm) => (bpm ? html`<span class="nw__hr">${ic('heart', { size: 's' })}<b class="n">${bpm}</b></span>` : '');

function card(p, at, name = nameOf(p)) {
  const w = doingOf(p.activity, at);
  return html`<button type="button" class="nw__card" data-now-open="${p.username}" aria-label="${name}: ${w.what}${w.doing ? `, ${w.doing}` : ''}, ${w.time}${p.bpm ? `, ${p.bpm} bpm` : ''}">
    <span class="nw__face">${avatar(p)}<span class="nw__ic">${ic(w.icon, { size: 's' })}</span></span>
    <span class="nw__txt">
      <b class="nw__n">${name}</b>
      <span class="nw__what">${w.what}</span>
      ${w.doing ? html`<span class="nw__doing">${w.doing}</span>` : ''}
      <span class="nw__meta"><span class="n">${w.time}</span>${heart(p.bpm)}</span>
    </span>
  </button>`;
}

const face = (p) => html`<a class="nw__p" href="/u/${encodeURIComponent(p.username)}" aria-label="${nameOf(p)}, online">
  <span class="nw__face">${avatar(p)}<span class="nw__dot" aria-hidden="true"></span></span><small>${nameOf(p)}</small></a>`;

/** You, first: as your friends see you, or that you are hidden (a way to the setting). */
function selfPart(d, at) {
  const me = d.self;
  if (!me) return '';
  if (!d.me?.shown) {
    return html`<a class="nw__p nw__p--off" href="/settings/privacy" aria-label="You are hidden from Now. Change it in Privacy">
      <span class="nw__face">${avatar(me)}<span class="nw__off" aria-hidden="true">${ic('eyeoff', { size: 's' })}</span></span><small>Hidden</small></a>`;
  }
  if (me.activity) return card(me, at, 'You');
  return html`<a class="nw__p nw__p--me" href="/u/${encodeURIComponent(me.username)}" aria-label="You, online: as others see you">
    <span class="nw__face">${avatar(me)}<span class="nw__dot" aria-hidden="true"></span></span><small>You</small></a>`;
}

/** The Now strip: you first, then everybody here you may see. */
export function nowStrip(d) {
  const people = d?.people || [];
  if (!d || (!people.length && !d.self)) return '';
  const act = people.filter((p) => p.activity);
  const idle = people.filter((p) => !p.activity && p.online);
  const on = people.filter((p) => p.online).length;
  const words = [act.length ? `${act.length} working out` : '', on ? `${on} online` : ''].filter(Boolean).join(' · ');
  return html`<section class="nw" aria-label="Now">
    <div class="nw__h"><h2><span class="nw__live" aria-hidden="true"></span>Now</h2>${words ? html`<small>${words}</small>` : ''}</div>
    <div class="nw__row">${selfPart(d, d.at || Date.now())}${act.map((p) => card(p, d.at || Date.now()))}${idle.map(face)}</div>
  </section>`;
}

/** Under a profile's name: online, or what they are doing now (a tap shows it, live). */
export function nowBadge(n, at = Date.now(), username = '') {
  if (!n) return '';
  if (n.activity) {
    const w = doingOf(n.activity, at);
    return html`<p class="nw-badge nw-badge--act"${username ? raw(` role="button" tabindex="0" data-now-open="${username.replace(/"/g, '')}"`) : ''}><span class="nw__live" aria-hidden="true"></span>${ic(w.icon, { size: 's' })}<span>${w.what}${w.doing ? html` · ${w.doing}` : ''} · <span class="n">${w.time}</span>${n.bpm ? html` · ${heart(n.bpm)}` : ''}</span></p>`;
  }
  return n.online ? html`<p class="nw-badge"><span class="nw__dot nw__dot--in" aria-hidden="true"></span>Online now</p>` : '';
}

/* ── the preview: one person, live ──────────────────────────── */

/** "5:12 /km" (a run, a walk), or "24.3 km/h" (a ride). */
function paceOf(type, ms, m) {
  if (!(m > 30) || !(ms > 0)) return null;
  const unit = f.distVal(m);
  if (/BIK/.test(type || '')) return { v: (unit / (ms / 3_600_000)).toFixed(1), u: `${f.distUnit()}/h`, k: 'Speed' };
  const s = Math.round(ms / 1000 / unit);
  if (s > 3600) return null;
  return { v: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, u: `/${f.distUnit()}`, k: 'Pace' };
}

/** The last two minutes of heart rate as a line. */
function hrLine(recent) {
  const pts = (recent || []).filter((p) => p[1] > 0);
  if (pts.length < 2) return '';
  const W = 300; const H = 56;
  const t1 = pts[pts.length - 1][0]; const t0 = Math.min(pts[0][0], t1 - 60_000);
  let lo = Infinity; let hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  const pad = Math.max(3, (16 - (hi - lo)) / 2); const y0 = lo - pad; const y1 = hi + pad;
  const x = (t) => (((t - t0) / (t1 - t0)) * W).toFixed(1);
  const y = (b) => (H - ((b - y0) / (y1 - y0)) * H).toFixed(1);
  let d = ''; let prev = null;
  for (const [t, b] of pts) { d += `${prev !== null && t - prev < 20_000 ? 'L' : 'M'}${x(t)},${y(b)}`; prev = t; }
  const last = pts[pts.length - 1];
  return raw(`<div class="nwp__hrl"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="lvh__line" d="${d}"/></svg><span class="lvh__pt" data-style="left:${((x(last[0]) / W) * 100).toFixed(1)}%;top:${((y(last[1]) / H) * 100).toFixed(1)}%"></span></div>`);
}

const MAP_SAY = { friends: 'Only friends see where they are.', off: 'They keep their map to themselves.' };

function previewBody(d, at) {
  const a = d.activity;
  const w = a ? doingOf(a, at) : null;
  const t = Date.now();
  const head = html`<div class="nwp__who">${avatar(d)}<div><b>${d.me ? 'You' : nameOf(d)}</b>
    <small>${a ? html`<span class="nw__live" aria-hidden="true"></span>${w.what}` : d.online ? html`<span class="nw__dot nw__dot--in" aria-hidden="true"></span>Online now` : 'Not on right now'}</small></div></div>`;
  if (!a) return html`${head}<p class="muted nwp__idle">${d.online ? 'Not working out right now. When they start a workout or a route, it shows here.' : 'Nothing going on right now.'}</p>`;
  const hr = d.bpm ? html`<section class="nwp__hr"><div class="nwp__bpm"><span class="nwp__beat">${ic('heart', { size: 's' })}</span><b class="n">${d.bpm}</b><small>bpm</small></div>${hrLine(d.hr?.recent)}</section>` : '';
  if (a.kind === 'route') {
    const ms = Number.isFinite(a.ms) ? a.ms + (a.paused ? 0 : t - at) : t - a.start;
    const pc = paceOf(a.type, a.ms, a.m);
    return html`${head}
      ${d.line ? html`<div class="nwp__map" data-nwp-map></div>` : d.map ? html`<p class="nwp__nomap muted small">${ic('lock', { size: 's' })}${MAP_SAY[d.map] || ''}</p>` : ''}
      <div class="nwp__stats">
        <div><b class="n">${Number.isFinite(a.m) ? f.distNum(a.m) : '–'}</b><small>${f.distUnit()}</small></div>
        <div><b class="n">${f.stopwatch(ms)}</b><small>${a.paused ? 'Paused' : 'Moving time'}</small></div>
        ${pc ? html`<div><b class="n">${pc.v}</b><small>${pc.k} ${pc.u}</small></div>` : ''}
      </div>
      ${hr}`;
  }
  const doing = a.doing;
  return html`${head}
    <div class="nwp__now">
      ${a.resting ? html`<p class="nwp__k">Resting</p>` : doing ? html`<p class="nwp__k">Now</p>` : ''}
      ${doing ? html`<p class="nwp__ex">${doing.name}</p>${doing.of ? html`<p class="nwp__set">Set ${doing.set} of ${doing.of}</p>` : ''}` : html`<p class="nwp__ex">${a.title || 'Workout'}</p>`}
    </div>
    <div class="nwp__stats">
      <div><b class="n">${f.stopwatch(t - a.start)}</b><small>Time</small></div>
      ${a.exercises ? html`<div><b class="n">${a.exercises}</b><small>${a.exercises === 1 ? 'Exercise' : 'Exercises'}</small></div>` : ''}
      ${a.sets ? html`<div><b class="n">${a.sets}</b><small>Sets done</small></div>` : ''}
    </div>
    ${hr}
    ${a.list?.length ? html`<ol class="nwp__list">${a.list.map((x) => html`<li class="${doing && x.name === doing.name ? 'is-now' : x.done !== null && x.done >= x.of && x.of ? 'is-done' : ''}"><span>${x.name}</span><small class="n">${x.done !== null ? `${x.done}/${x.of}` : f.plural(x.of, 'set')}</small></li>`)}</ol>` : ''}`;
}

/** Tap someone in Now: what they are doing, kept up to date while it is open. */
export function nowPreview(username) {
  let d = null; let at = Date.now(); let map = null;
  const sh = sheet({
    title: 'Now', cls: 'nwp',
    body: html`<div data-nwp><div class="skel nwp__skel"></div></div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-nwp-profile>${ic('person', { size: 's' })}See profile</button>`,
  });
  const box = sh.el.querySelector('[data-nwp]');
  const paint = async () => {
    if (!d) return;
    const y = sh.el.querySelector('.sheet__body')?.scrollTop || 0;
    const mapEl = box.querySelector('[data-nwp-map]');
    // The map is kept across repaints: it moves with the line instead of being drawn again.
    if (mapEl && map && d.line) mapEl.remove();
    mount(box, previewBody(d, at));
    const slot = box.querySelector('[data-nwp-map]');
    if (slot && d.line) {
      if (map && mapEl) { slot.replaceWith(mapEl); map.update(d.line, { keepView: true }); }
      else {
        const { routeMap } = await import('./map.js');
        if (!slot.isConnected) return;
        map = routeMap(slot, { line: d.line, height: 220, live: true, label: `Map of ${nameOf(d)}'s route so far` });
      }
    } else if (map) { map.destroy?.(); map = null; }
    const b = sh.el.querySelector('.sheet__body'); if (b) b.scrollTop = y;
  };
  const load = async () => {
    try { d = await api.get(`/api/now/${encodeURIComponent(username)}`); at = Date.now(); paint(); } catch (err) { if (!d) mount(box, html`<p class="muted">Could not load it. ${err.message || ''}</p>`); }
  };
  load();
  const poll = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
  // The clock moves between loads.
  const tick = setInterval(() => {
    if (!d?.activity) return;
    const a = d.activity;
    const ms = a.kind === 'route' ? (Number.isFinite(a.ms) ? a.ms + (a.paused ? 0 : Date.now() - at) : Date.now() - a.start) : Date.now() - a.start;
    const el = box.querySelector('.nwp__stats > div:nth-child(' + (a.kind === 'route' ? 2 : 1) + ') b');
    if (el) el.textContent = f.stopwatch(ms);
  }, 1000);
  sh.el.addEventListener('click', (e) => { if (e.target.closest('[data-nwp-profile]')) { sh.close(); go(`/u/${encodeURIComponent(username)}`); } });
  sh.closed.then(() => { clearInterval(poll); clearInterval(tick); map?.destroy?.(); });
  return sh;
}

/** Taps on Now cards and the profile line open the preview. Returns nothing to undo: it lives on `root`. */
export function bindNow(root) {
  if (root.dataset.nowBound) return;
  root.dataset.nowBound = '1';
  on(root, 'click', '[data-now-open]', (e, b) => { e.preventDefault(); nowPreview(b.dataset.nowOpen); });
  on(root, 'keydown', '[data-now-open][role="button"]', (e, b) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nowPreview(b.dataset.nowOpen); } });
}
