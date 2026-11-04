/* Routes (/workouts/routes): lines to run, walk or ride. Yours, and the
   ones other people shared with everyone, nearest first. Draw a new one on
   the map (a tap per point), or save one from a workout's map. A route's
   page shows it, its distance and climb, who made it, the GPX for a watch,
   and "Try it": a recording with the route drawn under it.

   Data: /api/routes (server/routelib.js). */

import { api } from '../api.js';
import { go } from '../app.js';
import { html, mount, ic, on, head, empty, errorState, toast, toggle, busy, confirm, errText, field, fieldError } from '../ui.js';
import { avatar } from './shared.js';
import { routeMap } from '../map.js';
import * as f from '../format.js';
import { setPager, riseIn } from '../motion.js';

const SPORTS = [['run', 'Run'], ['walk', 'Walk'], ['hike', 'Hike'], ['ride', 'Ride']];
const SPORT_ICON = { run: 'run', walk: 'walk', hike: 'hike', ride: 'bike' };
const R = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;
const metres = (a, b) => { const dLat = rad(b[0] - a[0]); const dLng = rad(b[1] - a[1]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
const lengthOf = (pts) => pts.reduce((a, p, i) => (i ? a + metres(pts[i - 1], p) : 0), 0);

/**
 * Where the phone is: [lat, lng], or an Error whose message says why not.
 * The browser's own timeout only starts once permission is given, so a
 * prompt that never shows (an app without location access) would wait for
 * ever: this gives up after 12 s and says what to check.
 */
async function whereAmI() {
  if (!navigator.geolocation) throw new Error('This browser cannot tell where you are.');
  try {
    const p = await navigator.permissions?.query?.({ name: 'geolocation' });
    if (p?.state === 'denied') throw new Error('Location is blocked for this site. Allow it in the browser or phone settings, then try again.');
  } catch (e) { if (/blocked/.test(e.message)) throw e; /* no Permissions API: just ask */ }
  return new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error('Your position did not come. Check that location is on for this browser or app, and try again.')), 12_000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(give); resolve([pos.coords.latitude, pos.coords.longitude]); },
      (err) => { clearTimeout(give); reject(new Error(err.code === 1 ? 'Location is not allowed for this site. Allow it in the browser or phone settings, then try again.' : 'Your position could not be found just now. Try again outside, or move the map by hand.')); },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  });
}

function segx(name, options, current, label) {
  const i = Math.max(0, options.findIndex(([v]) => v === current));
  return html`<div class="segx" role="group" aria-label="${label}" style="--n:${options.length};--i:${i}">
    ${options.map(([v, t]) => html`<button type="button" class="segx__o" data-seg="${name}" data-value="${v}" aria-pressed="${String(v === current)}">${t}</button>`)}
  </div>`;
}

export default async function routes(ctx) {
  if (ctx.name === 'route-new' || ctx.name === 'route-edit') return drawRoute(ctx);
  if (ctx.name === 'route') return routePage(ctx);
  return routeList(ctx);
}

/* ── the list ─────────────────────────────────────────────────── */

/* ── while loading: shaped like what comes ──────────────────── */

const SK = (cls = '', style = '') => html`<span class="skel ${cls}" ${style ? html`data-style="${style}"` : ''}></span>`;
/** Route cards: a little map and three lines each. */
const listSkel = (n = 3) => html`<ul class="rt-list" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => html`<li class="rt-card rt-card--skel"><span class="rt-card__a">
  ${SK('rt-card__map')}<span class="rt-card__b">${SK('skel--line', 'width:62%')}${SK('skel--line', 'width:44%;height:12px')}${SK('skel--line', 'width:30%;height:12px')}</span></span></li>`)}</ul>`;
/** One route: the map, the three numbers, the two buttons. */
const pageSkel = () => html`<div aria-busy="true" aria-label="Loading"><div class="rt-hero">${SK('rt-skel-map')}
  <div class="rt-stats">${[0, 1, 2].map(() => html`<div>${SK('skel--line', 'width:60%;height:11px')}${SK('skel--line', 'width:80%;height:16px;margin-top:6px')}</div>`)}</div></div>
  <div class="btnrow rt-acts">${SK('rt-skel-btn')}${SK('rt-skel-btn')}</div></div>`;

async function routeList(ctx) {
  const { root } = ctx;
  document.title = 'Routes · Health';
  let scope = ctx.query.get('scope') === 'public' ? 'public' : 'mine';
  let near = null;
  let maps = [];

  const card = (r) => html`<li class="rt-card">
    <a class="rt-card__a" href="/workouts/routes/${encodeURIComponent(r.id)}">
      <span class="rt-card__map" data-line="${encodeURIComponent(JSON.stringify(r.line))}" aria-hidden="true"></span>
      <span class="rt-card__b">
        <span class="rt-card__t">${r.title}</span>
        <span class="rt-card__s">${ic(SPORT_ICON[r.sport] || 'route', { size: 's' })}<span>${r.sportLabel} · ${f.dist(r.distanceM)}${f.isNum(r.climbM) && r.climbM > 0 ? ` · ${f.int(r.climbM)} m climb` : ''}</span></span>
        <span class="rt-card__w">${scope === 'public'
          ? html`${r.by ? html`<span class="rt-card__by">${avatar(r.by)}<span>${r.mine ? 'You' : r.by.displayName || r.by.username}</span></span>` : ''}${near && f.isNum(r.awayM) ? html`<span>${f.dist(r.awayM)} away</span>` : ''}`
          : html`<span>${r.public ? 'Shared with everyone' : 'Only you'}</span>`}</span>
      </span>
    </a>
  </li>`;

  const paint = (d) => {
    maps.forEach((m) => m.destroy()); maps = [];
    const list = d?.routes || [];
    mount(root, html`${head({ title: 'Routes', back: '/workouts', actions: html`<a class="btn btn--s" href="/workouts/routes/new">${ic('plus', { size: 's' })}Draw a route</a>` })}
      <div class="rt-mode">${segx('rscope', [['mine', 'Mine'], ['public', 'Public']], scope, 'Show')}</div>
      <div class="rt-pane" data-pane>
      ${scope === 'public' ? html`<div class="rt-near"><span>${near ? 'Nearest to you first' : d?.near ? 'Nearest to your newest route first' : 'Newest first'}</span><button type="button" class="btn btn--ghost btn--s" data-act="near">${ic('locate', { size: 's' })}Near me</button></div>` : ''}
      ${!d ? listSkel()
        : list.length ? html`<ul class="rt-list">${list.map(card)}</ul>`
          : scope === 'mine'
            ? empty({ iconName: 'route', title: 'No routes yet', text: 'Draw one on the map, or open a run, walk or ride with a map and save its route from there.', action: html`<a class="btn btn--tonal" href="/workouts/routes/new">Draw a route</a>` })
            : empty({ iconName: 'route', title: 'No shared routes yet', text: 'Routes people share with everyone show up here. Share one of yours from its page.' })}
      </div>`);
    for (const el of root.querySelectorAll('.rt-card__map')) {
      try { maps.push(routeMap(el, { line: JSON.parse(decodeURIComponent(el.dataset.line)), height: 96, still: true, label: '' })); } catch { /* the card still reads */ }
    }
  };

  // Where you are, without asking: only when location is already allowed for this site.
  let quietTried = false;
  async function quietNear() {
    if (quietTried || near) return;
    quietTried = true;
    try {
      const st = await navigator.permissions?.query({ name: 'geolocation' });
      if (st?.state !== 'granted') return;
      near = await whereAmI();
      if (ctx.alive() && scope === 'public') load();
    } catch { /* stays on the newest route */ }
  }
  async function load() {
    if (scope === 'public') quietNear();
    if (!root.querySelector('[data-pane]')) paint(null);
    else { const el = root.querySelector('[data-pane]'); el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; }
    try {
      const d = await api.get(`/api/routes?scope=${scope}${near ? `&near=${near[0].toFixed(4)},${near[1].toFixed(4)}` : ''}`);
      if (ctx.alive()) paint(d);
    } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Routes', back: '/workouts' })}${errorState(err)}`); }
  }
  const setScope = (to) => {
    if (to === scope) return;
    scope = to;
    const sx = root.querySelector('.rt-mode .segx');
    if (sx) { sx.style.setProperty('--i', scope === 'public' ? '1' : '0'); sx.querySelectorAll('.segx__o').forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.value === scope))); }
    history.replaceState(history.state, '', `/workouts/routes${scope === 'public' ? '?scope=public' : ''}`);
    load().then(() => riseIn(root.querySelector('[data-pane]')));
  };
  on(root, 'click', '[data-seg="rscope"]', (e, b) => setScope(b.dataset.value));
  // A sideways swipe: Mine (right) or Public (left), as on the switch. From the left edge it is still Back.
  ctx.onLeave(setPager({
    // Anywhere on the screen, the empty space under a short list too (the tab bar and the + keep their own gestures).
    area: 'body',
    el: () => root.querySelector('[data-pane]'),
    has: (dir) => (dir === 'next' ? scope === 'mine' : scope === 'public'),
    go: (dir) => {
      const el = root.querySelector('[data-pane]');
      if (el) { el.style.transition = 'transform 200ms var(--ease), opacity 200ms'; el.style.transform = `translateX(${dir === 'next' ? -40 : 40}%)`; el.style.opacity = '0'; }
      setTimeout(() => setScope(dir === 'next' ? 'public' : 'mine'), 160);
    },
  }));
  on(root, 'click', '[data-act="near"]', async (e, b) => {
    b.classList.add('is-busy');
    try { near = await whereAmI(); load(); } catch (err) { toast(err.message, { ms: 7000 }); } finally { b.classList.remove('is-busy'); }
  });
  ctx.onLeave?.(() => maps.forEach((m) => m.destroy()));
  load();
}

/* ── drawing one, or editing a saved one ─────────────────────── */

/** Fewer points for a line made from a recording: the bends kept (Douglas-Peucker, a tolerance
    raised until it is at most `max`), so each point left can be moved by hand. */
function simplify(pts, max = 200) {
  if (pts.length <= max) return pts;
  const off = (p, a, b) => {
    // Metres from p to the segment a-b, flat-earth near the segment.
    const k = Math.cos(rad(a[0])); const x = (q) => rad(q[1]) * k * R; const y = (q) => rad(q[0]) * R;
    const ax = x(a); const ay = y(a); const dx = x(b) - ax; const dy = y(b) - ay; const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x(p) - ax) * dx + (y(p) - ay) * dy) / L)) : 0;
    return Math.hypot(x(p) - ax - t * dx, y(p) - ay - t * dy);
  };
  const keep = (tol) => {
    const k = new Uint8Array(pts.length); k[0] = 1; k[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [i, j] = st.pop(); let far = -1; let at = -1;
      for (let n = i + 1; n < j; n += 1) { const d = off(pts[n], pts[i], pts[j]); if (d > far) { far = d; at = n; } }
      if (far > tol) { k[at] = 1; st.push([i, at], [at, j]); }
    }
    return pts.filter((_, i) => k[i]);
  };
  let tol = 4; let out = keep(tol);
  while (out.length > max && tol < 500) { tol *= 1.5; out = keep(tol); }
  return out;
}

async function drawRoute(ctx) {
  const { root } = ctx;
  const editing = ctx.name === 'route-edit';
  const backTo = editing ? `/workouts/routes/${encodeURIComponent(ctx.params.id)}` : '/workouts/routes';
  const title = editing ? 'Edit route' : 'Draw a route';
  document.title = `${title} · Health`;
  let pts = []; let loop = false; let sel = -1; let start = null; let r = null; let thinned = 0;
  const hist = [];
  mount(root, html`${head({ title, back: backTo })}<div aria-busy="true" aria-label="Loading">${SK('skel--line', 'width:90%;margin-bottom:6px')}${SK('skel--line', 'width:60%;margin-bottom:12px')}${SK('rt-skel-map rt-skel-map--draw')}</div>`);
  try {
    if (editing) {
      r = await api.get(`/api/routes/${encodeURIComponent(ctx.params.id)}`);
      if (!r.mine) throw Object.assign(new Error('Only the person who made a route can change it.'), { status: 403 });
      const full = r.line.map((p, i) => (Number.isFinite(r.elevation?.[i]) ? [p[0], p[1], r.elevation[i]] : [p[0], p[1]]));
      // A loop (it ends where it began): kept as its points, closed again on saving.
      if (full.length > 3 && metres(full[0], full.at(-1)) < 15) { loop = true; full.pop(); }
      pts = simplify(full);
      thinned = full.length - pts.length;
    } else { const d = await api.get('/api/routes'); start = d.near || null; }
  } catch (err) {
    if (ctx.alive()) mount(root, html`${head({ title, back: backTo })}${errorState(err)}`);
    return;
  }
  if (!ctx.alive()) return;
  mount(root, html`${head({ title, back: backTo })}
    <p class="rt-help">${editing ? '' : 'Tap the map where the route goes, point by point: straight lines join them. '}Tap a point to pick it, then take it out or tap the map to add one after it. Drag a point to move it.${!editing && !start ? ' Tap Find me to start where you are.' : ''}</p>
    ${thinned ? html`<p class="rt-help rt-help--note">${ic('info', { size: 's' })}<span>Made from a recording, so its ${f.int(pts.length + thinned)} points are thinned to the ${f.int(pts.length)} at its bends, to move by hand. Saving keeps it that way.</span></p>` : ''}
    <div class="rt-draw"><div class="map--draw" data-map></div>
      <div class="rt-draw__bar">
        <span class="rt-draw__d" data-d>0 m</span>
        <button type="button" class="btn btn--ghost btn--s" data-act="find">${ic('locate', { size: 's' })}Find me</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="undo" disabled>Undo</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="reverse" disabled>Reverse</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="loop" disabled>Close the loop</button>
      </div>
      <div class="rt-pt" data-pt hidden>
        <span class="rt-pt__t" data-pt-t></span>
        <button type="button" class="btn btn--ghost btn--s" data-act="first" hidden>Start here</button>
        <button type="button" class="btn btn--tonal btn--s" data-act="remove">${ic('trash', { size: 's' })}Take out</button>
        <button type="button" class="iconbtn" data-act="unpick" aria-label="Done with this point">${ic('x', { size: 's' })}</button>
      </div>
    </div>
    <form class="rt-form" novalidate>
      ${field({ label: 'Name', name: 'title', value: r?.title || '', attrs: 'maxlength="80" required placeholder="Morning loop"' })}
      ${field({ label: 'For', name: 'sport', value: r?.sport || 'run', options: SPORTS })}
      <label class="rt-share"><span><b>Share with everyone</b><small>Anybody signed in can find it under Public, see it on the map and try it. Your name is shown with it.</small></span>${toggle('public', !!r?.public, { label: 'Share with everyone' })}</label>
      <button type="submit" class="btn btn--block" data-save disabled>${editing ? 'Save changes' : 'Save route'}</button>
    </form>`);
  const mapEl = root.querySelector('[data-map]');
  const lineOf = () => (loop && pts.length > 2 ? [...pts, pts[0]] : pts);
  const snap = () => { hist.push(JSON.stringify({ pts, loop, sel })); if (hist.length > 100) hist.shift(); };
  let dirty = false;
  const refresh = ({ handles = true } = {}) => {
    map.update(lineOf(), { keepView: true });
    if (handles) map.setHandles?.(pts, sel, loop);
    root.querySelector('[data-d]').textContent = f.dist(lengthOf(lineOf()));
    root.querySelector('[data-act="undo"]').disabled = !hist.length;
    root.querySelector('[data-act="reverse"]').disabled = pts.length < 2;
    const lb = root.querySelector('[data-act="loop"]');
    lb.disabled = pts.length < 3; lb.textContent = loop ? 'Open the loop' : 'Close the loop';
    root.querySelector('[data-save]').disabled = pts.length < 2 || (editing && !dirty && !formChanged());
    const bar = root.querySelector('[data-pt]');
    bar.hidden = sel < 0;
    if (sel >= 0) {
      root.querySelector('[data-pt-t]').textContent = sel === 0 ? `Start · point 1 of ${pts.length}` : !loop && sel === pts.length - 1 ? `Finish · point ${pts.length} of ${pts.length}` : `Point ${sel + 1} of ${pts.length}`;
      root.querySelector('[data-act="first"]').hidden = !loop || sel === 0;
      root.querySelector('[data-act="remove"]').disabled = pts.length <= 2;
    }
  };
  const change = (fn) => { snap(); fn(); dirty = true; refresh(); };
  let dragging = false;
  const map = routeMap(mapEl, {
    line: lineOf(), height: 360, center: start, closed: true, label: 'Map: tap to add a point to the route',
    onTap: (lat, lng) => change(() => {
      if (sel >= 0) { pts.splice(sel + 1, 0, [lat, lng]); sel += 1; } else pts.push([lat, lng]);
    }),
    handles: {
      onMove: (i, lat, lng, done) => {
        if (!dragging) { snap(); dragging = true; }
        pts[i] = [lat, lng];
        if (done) { dragging = false; dirty = true; refresh(); } else refresh({ handles: false });
      },
      onPick: (i) => { sel = sel === i ? -1 : i; refresh(); },
    },
  });
  const form = root.querySelector('.rt-form');
  const formChanged = () => !!r && (form.elements.title.value.trim() !== r.title || form.elements.sport.value !== r.sport || form.elements.public.checked !== !!r.public);
  on(root, 'input', '.rt-form', () => refresh({ handles: false }));
  on(root, 'change', '.rt-form', () => refresh({ handles: false }));
  on(root, 'click', '[data-act="undo"]', () => { const h = hist.pop(); if (!h) return; ({ pts, loop, sel } = JSON.parse(h)); dirty = true; refresh(); });
  on(root, 'click', '[data-act="reverse"]', () => change(() => {
    // A loop keeps its start and goes round the other way; an open route swaps its start and finish.
    pts = loop ? [pts[0], ...pts.slice(1).reverse()] : pts.slice().reverse();
    if (sel > 0) sel = loop ? pts.length - sel : pts.length - 1 - sel; else if (sel === 0 && !loop) sel = pts.length - 1;
  }));
  on(root, 'click', '[data-act="loop"]', () => change(() => {
    if (loop) { loop = false; return; }
    if (pts.length > 3 && metres(pts[0], pts.at(-1)) < 15) pts.pop();
    loop = pts.length >= 3;
  }));
  on(root, 'click', '[data-act="remove"]', () => { if (sel < 0 || pts.length <= 2) return; change(() => { pts.splice(sel, 1); sel = -1; if (pts.length < 3) loop = false; }); });
  on(root, 'click', '[data-act="first"]', () => { if (sel <= 0 || !loop) return; change(() => { pts = [...pts.slice(sel), ...pts.slice(0, sel)]; sel = 0; }); });
  on(root, 'click', '[data-act="unpick"]', () => { sel = -1; refresh(); });
  on(root, 'click', '[data-act="find"]', async (e, b) => {
    b.classList.add('is-busy');
    try { const [la, ln] = await whereAmI(); if (ctx.alive()) map.goTo(la, ln, 16); } catch (err) { toast(err.message, { ms: 7000 }); } finally { b.classList.remove('is-busy'); }
  });
  on(root, 'submit', '.rt-form', async (e) => {
    e.preventDefault();
    const name = form.elements.title.value.trim();
    fieldError(form, 'title', '');
    if (!name) { fieldError(form, 'title', 'Give the route a name.'); form.elements.title.focus(); return; }
    const body = { title: name, sport: form.elements.sport.value, line: lineOf(), public: form.elements.public.checked };
    try {
      const saved = await busy(form.querySelector('[data-save]'), () => (editing ? api.patch(`/api/routes/${encodeURIComponent(r.id)}`, body) : api.post('/api/routes', body)));
      toast(editing ? 'Route saved.' : 'Route saved.');
      go(`/workouts/routes/${encodeURIComponent(saved.id)}`, { replace: true });
    } catch (err) { fieldError(form, 'title', errText(err)); }
  });
  refresh();
  ctx.onLeave?.(() => map.destroy());
}

/* ── one route ────────────────────────────────────────────────── */

async function routePage(ctx) {
  const { root } = ctx;
  let map = null;
  let r;
  mount(root, html`${head({ title: 'Route', back: '/workouts/routes' })}${pageSkel()}`);
  try { r = await api.get(`/api/routes/${encodeURIComponent(ctx.params.id)}`); } catch (err) {
    if (ctx.alive()) mount(root, html`${head({ title: 'Route', back: '/workouts/routes' })}${errorState(err)}`);
    return;
  }
  if (!ctx.alive()) return;
  const tries = r.tries || [];
  const goTime = (s) => { const v = Math.max(0, Math.round(s)); const h = Math.floor(v / 3600); const m = Math.floor((v % 3600) / 60); return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(v % 60).padStart(2, '0')}`; };
  const paint = () => {
    map?.destroy();
    document.title = `${r.title} · Health`;
    mount(root, html`${head({ title: r.title, back: r.mine ? '/workouts/routes' : '/workouts/routes?scope=public' })}
      <div class="rt-hero">
        <div data-map></div>
        <dl class="rt-stats">
          <div><dt>Distance</dt><dd>${f.dist(r.distanceM)}</dd></div>
          <div><dt>Climb</dt><dd>${f.isNum(r.climbM) ? `${f.int(r.climbM)} m` : 'Not known'}</dd></div>
          <div><dt>For</dt><dd>${r.sportLabel}</dd></div>
        </dl>
      </div>
      ${r.by && !r.mine ? html`<a class="rt-by" href="/u/${encodeURIComponent(r.by.username)}">${avatar(r.by)}<span>Shared by <b>${r.by.displayName || r.by.username}</b> · ${f.dayRel(new Date(r.createdAt).toISOString().slice(0, 10))}</span></a>` : ''}
      <div class="btnrow rt-acts">
        <a class="btn" href="/workouts/record?route=${encodeURIComponent(r.id)}">${ic('play', { size: 's' })}Try it</a>
        <a class="btn btn--tonal" href="/api/routes/${encodeURIComponent(r.id)}/route.gpx" data-native download>${ic('download', { size: 's' })}GPX for a watch</a>
      </div>
      ${r.mine ? html`<div class="mod rt-own">
        <label class="rt-share"><span><b>Share with everyone</b><small>${r.public ? 'Anybody signed in can find it under Public. If your account is private, nobody else sees it.' : 'Only you see it now.'}</small></span>${toggle('public', r.public, { label: 'Share with everyone' })}</label>
        <div class="btnrow"><a class="btn btn--tonal btn--s" href="/workouts/routes/${encodeURIComponent(r.id)}/edit">${ic('edit', { size: 's' })}Edit route</a><button type="button" class="btn btn--danger btn--s" data-act="delete">Delete</button></div>
      </div>` : ''}
      ${tries.length ? html`<section class="bsec"><h2>Your goes</h2></section><p class="small rt-note">Fastest first. Only the route counts: the way to its start and on afterwards is left out.</p>
        <div class="group">${tries.map((x, i) => html`<a class="row" href="/workouts/${encodeURIComponent(x.workoutId)}">
          <span class="row__ic rt-rank">${i + 1}</span>
          <span class="row__body"><span class="row__t">${goTime(x.timeS)}</span><span class="row__d">${f.dayRel(x.date)} · ${f.clock(x.startT)} · ${f.dist(x.distanceM)}${x.byHand ? ' · marked by hand' : ''}</span></span>
          ${i === 0 && tries.length > 1 ? html`<span class="row__v">Best</span>` : ''}</a>`)}</div>` : ''}`);
    requestAnimationFrame(() => { const el = root.querySelector('[data-map]'); if (el) map = routeMap(el, { line: r.line, height: 300, label: `Map of ${r.title}, ${f.dist(r.distanceM)}` }); });
  };
  paint();
  on(root, 'change', '.rt-own input[name="public"]', async (e, input) => {
    try { r = await api.patch(`/api/routes/${encodeURIComponent(r.id)}`, { public: input.checked }); toast(r.public ? 'Shared with everyone.' : 'Only you see it now.'); paint(); } catch (err) { input.checked = !input.checked; toast(errText(err), { tone: 'bad' }); }
  });
  on(root, 'click', '[data-act="delete"]', async () => {
    if (!(await confirm({ title: 'Delete this route?', text: r.public ? 'It is taken off Public too. Workouts done on it stay.' : 'Workouts done on it stay.', yes: 'Delete', danger: true }))) return;
    try { await api.del(`/api/routes/${encodeURIComponent(r.id)}`); toast('Route deleted.'); go('/workouts/routes', { replace: true }); } catch (err) { toast(errText(err), { tone: 'bad' }); }
  });
  ctx.onLeave?.(() => map?.destroy());
}
