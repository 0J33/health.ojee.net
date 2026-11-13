/* Routes (/workouts/routes): lines to run, walk or ride. Yours, and the
   ones other people shared with everyone, nearest first. Draw a new one on
   the map (a tap per point), or save one from a workout's map. A route's
   page shows it, its distance and climb, who made it, the GPX for a watch,
   and "Try it": a recording with the route drawn under it.

   Data: /api/routes (server/routelib.js). */

import { api } from '../api.js';
import { app, go } from '../app.js';
import { html, mount, ic, on, head, empty, errorState, toast, toggle, busy, confirm, errText, field, fieldError, segx, segxTo, info, chart } from '../ui.js';
import { figure } from '../kit.js';
import { hrTrace } from '../charts.js';
import { avatar } from './shared.js';
import { routeMap } from '../map.js';
import * as RE from '../routedit.js';
import * as f from '../format.js';
import { setPager, riseIn } from '../motion.js';
import { shareLinkSheet } from '../sharelink.js';

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

/* Sorting and filtering the list: all in the page, over what came (up to 200 a scope). */
const SORTS = [['new', 'Newest'], ['near', 'Nearest to me'], ['short', 'Shortest'], ['long', 'Longest'], ['az', 'A to Z'], ['climb', 'Most climb']];
const LENS = [['', 'Any distance'], ['0-5', 'Under 5 km'], ['5-10', '5 to 10 km'], ['10-20', '10 to 20 km'], ['20-', 'Over 20 km']];
const SORT_KEY = 'health.routes.sort';

async function routeList(ctx) {
  const { root } = ctx;
  document.title = 'Routes · rep.';
  const q = ctx.query;
  let scope = q.get('scope') === 'public' ? 'public' : 'mine';
  let near = null;
  let maps = [];
  let data = null;
  let saved = '';
  try { saved = localStorage.getItem(SORT_KEY) || ''; } catch { /* fine */ }
  // What is shown: the sort, the kind, the length, the words searched for (kept in the address).
  const want = { sort: SORTS.some(([v]) => v === q.get('sort')) ? q.get('sort') : SORTS.some(([v]) => v === saved) ? saved : 'new', sport: q.get('sport') || '', len: LENS.some(([v]) => v === q.get('len')) ? q.get('len') : '', q: q.get('q') || '' };
  const filtered = () => Boolean(want.sport || want.len || want.q.trim());

  const card = (r) => html`<li class="rt-card">
    <a class="rt-card__a" href="/workouts/routes/${encodeURIComponent(r.id)}">
      <span class="rt-card__map" data-line="${encodeURIComponent(JSON.stringify(r.line))}" aria-hidden="true"></span>
      <span class="rt-card__b">
        <span class="rt-card__t">${r.title}</span>
        <span class="rt-card__s">${ic(SPORT_ICON[r.sport] || 'route', { size: 's' })}<span>${r.sportLabel} · ${f.dist(r.distanceM)}${r.bothWays ? ' there and back' : ''}${f.isNum(r.climbM) && r.climbM > 0 ? ` · ${f.int(r.climbM)} m climb` : ''}</span></span>
        <span class="rt-card__w">${scope === 'public' && r.by ? html`<span class="rt-card__by">${avatar(r.by)}<span>${r.mine ? 'You' : r.by.displayName || r.by.username}</span></span>` : scope === 'mine' ? html`<span>${r.public ? 'Shared' : 'Only you'}</span>` : ''}${near && f.isNum(r.awayM) ? html`<span class="rt-card__away">${ic('locate', { size: 's' })}${f.dist(r.awayM)} away</span>` : ''}</span>
      </span>
    </a>
  </li>`;

  /** The routes to show: the kind, the length and the words, then the order. */
  function shown() {
    const list = (data?.routes || []).filter((r) => {
      if (want.sport && r.sport !== want.sport) return false;
      if (want.len) { const [lo, hi] = want.len.split('-').map((x) => (x === '' ? null : Number(x) * 1000)); if ((lo !== null && r.distanceM < lo) || (hi !== null && r.distanceM >= hi)) return false; }
      if (want.q.trim()) { const w = want.q.trim().toLowerCase(); if (!r.title.toLowerCase().includes(w) && !(r.by && `${r.by.displayName || ''} ${r.by.username || ''}`.toLowerCase().includes(w))) return false; }
      return true;
    });
    const by = {
      new: (a, b) => b.createdAt - a.createdAt,
      near: (a, b) => (f.isNum(a.awayM) ? a.awayM : Infinity) - (f.isNum(b.awayM) ? b.awayM : Infinity),
      short: (a, b) => a.distanceM - b.distanceM,
      long: (a, b) => b.distanceM - a.distanceM,
      az: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
      climb: (a, b) => (b.climbM || 0) - (a.climbM || 0),
    }[want.sort] || ((a, b) => b.createdAt - a.createdAt);
    return list.sort(by);
  }

  /** A filter as a pill holding a native picker: easy on a phone, active ones marked. */
  const pick = (name, options, value, label, on) => html`<label class="rt-f ${on ? 'is-on' : ''}"><span class="sr">${label}</span>
    <select name="${name}" aria-label="${label}">${options.map(([v, t]) => html`<option value="${v}" ${v === value ? 'selected' : ''}>${t}</option>`)}</select>${ic('more_down', { size: 's' })}</label>`;

  function controls() {
    const sports = [...new Set((data?.routes || []).map((r) => r.sport))];
    const kinds = [['', 'All types'], ...SPORTS.filter(([v]) => sports.includes(v) || v === want.sport)];
    return html`<div class="rt-tools">
      <label class="rt-q">${ic('search', { size: 's' })}<input type="search" name="q" value="${want.q}" placeholder="${scope === 'public' ? 'Search by name or person' : 'Search your routes'}" aria-label="Search routes" autocomplete="off" enterkeyhint="search"></label>
      <div class="rt-fs">
        ${pick('sort', SORTS, want.sort, 'Sort by', want.sort !== 'new')}
        ${kinds.length > 2 || want.sport ? pick('sport', kinds, want.sport, 'Type', !!want.sport) : ''}
        ${pick('len', LENS, want.len, 'Distance', !!want.len)}
      </div>
    </div>`;
  }

  function listPart() {
    if (!data) return listSkel();
    const all = data.routes || [];
    if (!all.length) {
      return scope === 'mine'
        ? empty({ iconName: 'route', title: 'No routes yet', text: 'Draw one on the map, or open a run, walk or ride with a map and save its route from there.', action: html`<a class="btn btn--tonal" href="/workouts/routes/new">Draw a route</a>` })
        : empty({ iconName: 'route', title: html`No shared routes yet${info('Routes people share with everyone show up here.', { label: 'About shared routes' })}`, text: 'Share one of yours from its page.' });
    }
    const list = shown();
    const count = html`<p class="rt-count"><span>${list.length === all.length ? `${f.int(all.length)} ${all.length === 1 ? 'route' : 'routes'}` : `${f.int(list.length)} of ${f.int(all.length)} routes`}${want.sort === 'near' && near ? ', nearest to you first' : ''}</span>${filtered() ? html`<button type="button" class="rt-clear" data-act="clear">Clear filters</button>` : ''}</p>`;
    if (!list.length) return html`${count}${empty({ iconName: 'search', title: 'No routes match', text: 'Try another distance or type, or clear the search.', action: html`<button type="button" class="btn btn--tonal" data-act="clear">Clear filters</button>` })}`;
    return html`${count}<ul class="rt-list">${list.map(card)}</ul>`;
  }

  /** Just the list (and its count) drawn again: the controls, and what is typed, stay put. */
  function paintList() {
    maps.forEach((m) => m.destroy()); maps = [];
    const el = root.querySelector('[data-list]');
    if (!el) return;
    mount(el, listPart());
    for (const m of el.querySelectorAll('.rt-card__map')) {
      try { maps.push(routeMap(m, { line: JSON.parse(decodeURIComponent(m.dataset.line)), height: 96, still: true, label: '' })); } catch { /* the card still reads */ }
    }
  }

  const paint = () => {
    mount(root, html`${head({ title: 'Routes', back: '/workouts', actions: html`<a class="btn btn--s" href="/workouts/routes/new">${ic('plus', { size: 's' })}Draw a route</a>` })}
      <div class="rt-mode">${segx('rscope', [['mine', 'Mine'], ['public', 'Public']], scope, 'Show')}</div>
      <div class="rt-pane" data-pane>
        ${data?.routes?.length ? controls() : ''}
        <div data-list></div>
      </div>`);
    paintList();
  };

  const address = () => {
    const p = new URLSearchParams();
    if (scope === 'public') p.set('scope', 'public');
    if (want.sort !== 'new') p.set('sort', want.sort);
    if (want.sport) p.set('sport', want.sport);
    if (want.len) p.set('len', want.len);
    if (want.q.trim()) p.set('q', want.q.trim());
    history.replaceState(history.state, '', `/workouts/routes${p.toString() ? `?${p}` : ''}`);
  };

  // Where you are, without asking: only when location is already allowed for this site.
  async function quietNear() {
    if (near) return;
    try {
      const st = await navigator.permissions?.query({ name: 'geolocation' });
      if (st?.state !== 'granted') return;
      near = await whereAmI();
      if (ctx.alive()) load();
    } catch { /* the distances away wait for "Nearest to me" */ }
  }
  async function load() {
    if (!root.querySelector('[data-pane]')) { data = null; paint(); } else { const el = root.querySelector('[data-pane]'); el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; }
    try {
      const d = await api.get(`/api/routes?scope=${scope}&limit=200${near ? `&near=${near[0].toFixed(4)},${near[1].toFixed(4)}` : ''}`);
      if (!ctx.alive()) return;
      data = d;
      paint();
    } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Routes', back: '/workouts' })}${errorState(err)}`); }
  }
  const setScope = (to) => {
    if (to === scope) return;
    scope = to;
    want.sport = ''; want.q = '';
    segxTo(root, 'rscope', scope);
    address();
    data = null;
    const el = root.querySelector('[data-pane]');
    if (el) mount(el, html`<div data-list>${listSkel()}</div>`);
    load().then(() => riseIn(root.querySelector('[data-pane]')));
  };
  on(root, 'click', '[data-seg="rscope"]', (e, b) => setScope(b.dataset.value));
  // A sideways swipe: Mine (right) or Public (left), as on the switch. From the left edge it is still Back.
  ctx.onLeave(setPager({
    area: 'body',
    el: () => root.querySelector('[data-pane]'),
    has: (dir) => (dir === 'next' ? scope === 'mine' : scope === 'public'),
    go: (dir) => {
      const el = root.querySelector('[data-pane]');
      if (el) { el.style.transition = 'transform 200ms var(--ease), opacity 200ms'; el.style.transform = `translateX(${dir === 'next' ? -40 : 40}%)`; el.style.opacity = '0'; }
      setTimeout(() => setScope(dir === 'next' ? 'public' : 'mine'), 160);
    },
  }));
  // The filters: a change shows the list again at once; nearest asks where you are first.
  on(root, 'change', '.rt-fs select', async (e, sel) => {
    want[sel.name] = sel.value;
    if (sel.name === 'sort') { try { localStorage.setItem(SORT_KEY, sel.value); } catch { /* fine */ } }
    sel.closest('.rt-f')?.classList.toggle('is-on', sel.name === 'sort' ? sel.value !== 'new' : !!sel.value);
    address();
    if (sel.name === 'sort' && sel.value === 'near' && !near) {
      const lab = sel.closest('.rt-f'); lab?.classList.add('is-busy');
      try { near = await whereAmI(); await load(); } catch (err) { toast(err.message, { ms: 7000 }); } finally { lab?.classList.remove('is-busy'); }
      return;
    }
    paintList();
  });
  let typing = null;
  on(root, 'input', '.rt-q input', (e, input) => {
    clearTimeout(typing);
    typing = setTimeout(() => { want.q = input.value; address(); paintList(); }, 150);
  });
  on(root, 'click', '[data-act="clear"]', () => {
    want.sport = ''; want.len = ''; want.q = '';
    address();
    paint();
  });
  ctx.onLeave?.(() => { clearTimeout(typing); maps.forEach((m) => m.destroy()); });
  quietNear();
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
  document.title = `${title} · rep.`;
  // The route as pieces (routedit.js), and the points picked (keys).
  let st = RE.fromLine([]); let sel = []; let start = null; let r = null; let thinned = 0;
  const hist = [];
  mount(root, html`${head({ title, back: backTo })}<div aria-busy="true" aria-label="Loading">${SK('skel--line', 'width:90%;margin-bottom:6px')}${SK('skel--line', 'width:60%;margin-bottom:12px')}${SK('rt-skel-map rt-skel-map--draw')}</div>`);
  try {
    if (editing) {
      r = await api.get(`/api/routes/${encodeURIComponent(ctx.params.id)}`);
      if (!r.mine) throw Object.assign(new Error('Only the person who made a route can change it.'), { status: 403 });
      const full = r.line.map((p, i) => (Number.isFinite(r.elevation?.[i]) ? [p[0], p[1], r.elevation[i]] : [p[0], p[1]]));
      // A loop (it ends where it began): kept as its points, closed again on saving.
      let loop = false;
      if (full.length > 3 && metres(full[0], full.at(-1)) < 15) { loop = true; full.pop(); }
      const pts = simplify(full);
      thinned = full.length - pts.length;
      st = RE.fromLine(pts, loop);
    } else { const d = await api.get('/api/routes'); start = d.near || null; }
  } catch (err) {
    if (ctx.alive()) mount(root, html`${head({ title, back: backTo })}${errorState(err)}`);
    return;
  }
  if (!ctx.alive()) return;
  const fine = matchMedia('(pointer: fine)').matches;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Cmd' : 'Ctrl';
  const helpMore = html`${editing ? '' : html`<p>Tap a point to pick it, then take it out or tap the map to add one after it. Drag a point to move it.</p>`}${fine ? '' : html`<p>To pick several, tap Pick an area and drag over them.</p>`}${fine ? html`<p>Click a <b>+</b> on the line to add a point there, or drag it. ${mod} or Shift and click picks more points; Shift and drag picks every point in a box. <kbd>Delete</kbd> takes the picked points out, <kbd>${mod}</kbd> <kbd>Z</kbd> undoes, <kbd>Esc</kbd> lets go.</p>` : ''}${thinned ? html`<p>Made from a recording, so its ${f.int(RE.points(st).length + thinned)} points are thinned to the ${f.int(RE.points(st).length)} at its bends, to move by hand. Saving keeps it that way.</p>` : ''}`;
  mount(root, html`${head({ title: html`${title}${info(helpMore, { label: 'How to draw a route' })}`, back: backTo })}
    <p class="rt-help">${editing ? 'Tap a point to pick it, then take it out or tap the map to add one after it. Drag a point to move it.' : 'Tap the map where the route goes, point by point: straight lines join them.'}${!editing && !start ? ' Tap Find me to start where you are.' : ''}</p>
    <div class="rt-draw"><div class="map--draw" data-map></div>
      <div class="rt-draw__bar">
        <span class="rt-draw__d" data-d>0 m</span>
        <button type="button" class="btn btn--ghost btn--s" data-act="find">${ic('locate', { size: 's' })}Find me</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="undo" disabled>Undo</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="reverse" disabled>Reverse</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="loop" disabled>Close the loop</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="area" aria-pressed="false" title="Drag on the map to pick every point in a box">Pick an area</button>
      </div>
      <p class="rt-pieces" data-pieces hidden>${ic('info', { size: 's' })}<span data-pieces-t></span></p>
      <div class="rt-pt" data-pt hidden>
        <span class="rt-pt__t" data-pt-t></span>
        <button type="button" class="btn btn--ghost btn--s" data-act="first" hidden>Start here</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="all">Pick all</button>
        <button type="button" class="btn btn--ghost btn--s" data-act="cut" title="Take the picked points out and leave a gap: the line is in pieces until you join them">Cut out</button>
        <button type="button" class="btn btn--tonal btn--s" data-act="remove" title="Take the picked points out and join the line straight over where they were">${ic('trash', { size: 's' })}Take out</button>
        <button type="button" class="iconbtn" data-act="unpick" aria-label="Let go of the picked points">${ic('x', { size: 's' })}</button>
      </div>
    </div>
    <form class="rt-form" novalidate>
      ${field({ label: 'Name', name: 'title', value: r?.title || '', attrs: 'maxlength="80" required placeholder="Morning loop"' })}
      ${field({ label: 'For', name: 'sport', value: r?.sport || 'run', options: SPORTS })}
      <label class="rt-share" data-both-row><span><b>There and back</b><small>Out along the line, then back the same way to the start: twice the distance.</small></span>${toggle('bothWays', !!r?.bothWays, { label: 'There and back' })}</label>
      <label class="rt-share"><span><b>Share with everyone</b><small>Anybody signed in can find it under Public, see it on the map and try it. Your name is shown with it.</small></span>${toggle('public', !!r?.public, { label: 'Share with everyone' })}</label>
      <p class="rt-why" data-why hidden></p>
      <button type="submit" class="btn btn--block" data-save disabled>${editing ? 'Save changes' : 'Save route'}</button>
    </form>`);
  const mapEl = root.querySelector('[data-map]');
  const snap = () => { hist.push(JSON.stringify({ st, sel })); if (hist.length > 100) hist.shift(); };
  let dirty = false; let area = false;
  const flatLine = () => RE.linesOf(st).flat();
  const refresh = ({ handles = true } = {}) => {
    if (map.setEdit) map.setEdit(st, sel, { handles }); else map.update(flatLine(), { keepView: true });
    const total = RE.linesOf(st).reduce((a, l) => a + lengthOf(l), 0);
    const n = RE.points(st).length;
    // A loop ends where it starts already: there and back is for a line that does not.
    root.querySelector('[data-both-row]').hidden = st.loop;
    const both = !st.loop && form.elements.bothWays.checked;
    root.querySelector('[data-d]').textContent = both ? `${f.dist(total * 2)} there and back` : f.dist(total);
    root.querySelector('[data-act="undo"]').disabled = !hist.length;
    root.querySelector('[data-act="reverse"]').disabled = n < 2;
    const lb = root.querySelector('[data-act="loop"]');
    lb.disabled = st.loop ? false : st.segs.length !== 1 || n < 3;
    lb.textContent = st.loop ? 'Open the loop' : 'Close the loop';
    const ab = root.querySelector('[data-act="area"]');
    ab.hidden = !map.setArea; ab.setAttribute('aria-pressed', String(area)); ab.classList.toggle('is-on', area);
    const pieces = root.querySelector('[data-pieces]');
    pieces.hidden = st.segs.length < 2;
    if (st.segs.length > 1) root.querySelector('[data-pieces-t]').textContent = `In ${st.segs.length} pieces. Click the + on a dashed gap to join it straight, or drag the + to where the line should go. A piece you do not want: pick it and take it out.`;
    const ok = RE.check(st);
    const why = root.querySelector('[data-why]');
    why.hidden = ok.ok || n === 0; why.textContent = ok.ok ? '' : ok.why;
    root.querySelector('[data-save]').disabled = !ok.ok || (editing && !dirty && !formChanged());
    const bar = root.querySelector('[data-pt]');
    bar.hidden = !sel.length;
    if (sel.length) {
      root.querySelector('[data-pt-t]').textContent = sel.length === 1 ? RE.nameOf(st, sel[0]) : `${f.int(sel.length)} points picked`;
      root.querySelector('[data-act="first"]').hidden = !(st.loop && sel.length === 1 && sel[0] !== '0:0');
      root.querySelector('[data-act="all"]').hidden = sel.length >= n;
      root.querySelector('[data-act="remove"]').disabled = false;
      root.querySelector('[data-act="cut"]').hidden = !cutsSomething();
    }
  };
  // Cutting leaves a gap only where a point picked has a point kept on both sides of it (or in a loop).
  const cutsSomething = () => {
    if (st.loop) return true;
    const gone = new Set(sel);
    return st.segs.some((g, s) => g.some((_, i) => gone.has(RE.key(s, i)) && i > 0 && i < g.length - 1 && g.slice(0, i).some((__, a) => !gone.has(RE.key(s, a))) && g.slice(i + 1).some((__, b) => !gone.has(RE.key(s, i + 1 + b)))));
  };
  const apply = (res) => { snap(); st = res.st; sel = res.sel; dirty = true; refresh(); };
  let dragBase = null;
  const map = routeMap(mapEl, {
    line: flatLine(), height: fine ? 460 : 360, center: start, closed: true, label: 'Map: tap to add a point to the route',
    onTap: (lat, lng) => {
      if (area) return;
      // Several picked: a tap lets go of them. One picked: the new point goes after it. None: at the end.
      if (sel.length > 1) { sel = []; refresh(); return; }
      apply(sel.length === 1 ? RE.insertAfter(st, sel[0], [lat, lng]) : RE.append(st, [lat, lng]));
    },
    edit: {
      onPick: (k, add) => {
        if (add) sel = sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k];
        else sel = sel.length === 1 && sel[0] === k ? [] : [k];
        refresh();
      },
      onDrag: (keys, dlat, dlng, done) => {
        if (!dragBase) { snap(); dragBase = st; }
        st = RE.moveBy(dragBase, keys, dlat, dlng);
        if (done) { dragBase = null; dirty = true; refresh(); } else refresh({ handles: false });
      },
      onInsert: (s, j, lat, lng) => apply(RE.insertAt(st, s, j, [lat, lng])),
      onJoin: (k, p) => apply(RE.join(st, k, p)),
      onBox: (keys, add) => { sel = add ? [...new Set([...sel, ...keys])] : keys; refresh(); },
    },
  });
  const form = root.querySelector('.rt-form');
  const formChanged = () => !!r && (form.elements.title.value.trim() !== r.title || form.elements.sport.value !== r.sport || form.elements.public.checked !== !!r.public || (!st.loop && form.elements.bothWays.checked) !== !!r.bothWays);
  on(root, 'input', '.rt-form', () => refresh({ handles: false }));
  on(root, 'change', '.rt-form', () => refresh({ handles: false }));
  const undo = () => { const h = hist.pop(); if (!h) return; ({ st, sel } = JSON.parse(h)); dirty = true; refresh(); };
  const remove = () => { if (sel.length) apply(RE.takeOut(st, sel)); };
  on(root, 'click', '[data-act="undo"]', undo);
  on(root, 'click', '[data-act="reverse"]', () => apply(RE.reverse(st, sel)));
  on(root, 'click', '[data-act="loop"]', () => apply({ st: RE.setLoop(st, !st.loop, (a, b) => metres(a, b) < 15), sel: [] }));
  on(root, 'click', '[data-act="remove"]', remove);
  on(root, 'click', '[data-act="cut"]', () => { if (sel.length) apply(RE.cutOut(st, sel)); });
  on(root, 'click', '[data-act="all"]', () => { sel = RE.allKeys(st); refresh(); });
  on(root, 'click', '[data-act="first"]', () => { if (sel.length === 1) apply(RE.startAt(st, sel[0])); });
  on(root, 'click', '[data-act="unpick"]', () => { sel = []; refresh(); });
  on(root, 'click', '[data-act="area"]', () => { area = !area; map.setArea?.(area); refresh({ handles: false }); });
  on(root, 'click', '[data-act="find"]', async (e, b) => {
    b.classList.add('is-busy');
    try { const [la, ln] = await whereAmI(); if (ctx.alive()) map.goTo(la, ln, 16); } catch (err) { toast(err.message, { ms: 7000 }); } finally { b.classList.remove('is-busy'); }
  });
  // The keyboard, away from the form's fields: Delete, undo, pick all, let go.
  const onKey = (e) => {
    if (!ctx.alive()) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const cmd = e.ctrlKey || e.metaKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); remove(); } else if (cmd && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } else if (cmd && e.key.toLowerCase() === 'a') { e.preventDefault(); sel = RE.allKeys(st); refresh(); } else if (e.key === 'Escape' && (sel.length || area)) { sel = []; if (area) { area = false; map.setArea?.(false); } refresh(); }
  };
  document.addEventListener('keydown', onKey);
  on(root, 'submit', '.rt-form', async (e) => {
    e.preventDefault();
    const name = form.elements.title.value.trim();
    fieldError(form, 'title', '');
    const ok = RE.check(st);
    if (!ok.ok) { toast(ok.why, { ms: 7000 }); return; }
    if (!name) { fieldError(form, 'title', 'Give the route a name.'); form.elements.title.focus(); return; }
    const body = { title: name, sport: form.elements.sport.value, line: RE.lineOf(st), public: form.elements.public.checked, bothWays: !st.loop && form.elements.bothWays.checked };
    try {
      const saved = await busy(form.querySelector('[data-save]'), () => (editing ? api.patch(`/api/routes/${encodeURIComponent(r.id)}`, body) : api.post('/api/routes', body)));
      toast(editing ? 'Route saved.' : 'Route saved.');
      go(`/workouts/routes/${encodeURIComponent(saved.id)}`, { replace: true });
    } catch (err) { fieldError(form, 'title', errText(err)); }
  });
  refresh();
  ctx.onLeave?.(() => { document.removeEventListener('keydown', onKey); map.destroy(); });
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
  // A loop ends where it starts already: no going back the same way to offer.
  const loopy = r.line.length > 3 && metres(r.line[0], r.line.at(-1)) < 15;
  /* The heart rate through your best go (the workout it was part of, the go shaded). Each go's own is on its workout. */
  let beat = null;
  const paintHeart = () => {
    const el = root.querySelector('[data-rt-heart]');
    if (!el || !beat) return;
    const { pts, start, end, avg, go1 } = beat;
    mount(el, html`<section class="bsec"><h2>Heart rate</h2><a href="/workouts/${encodeURIComponent(go1.workoutId)}">Your ${tries.length > 1 ? 'best go' : 'go'}</a></section>
      <section class="bt bt--plain fam fam-heart" aria-label="Heart rate">${figure(chart((cw) => hrTrace({ zones: app.me?.hrZones, w: cw, h: cw > 620 ? 240 : 180, points: pts, start, end, avg, label: `Heart rate through your go on ${r.title}, from ${f.clock(pts[0][0])} to ${f.clock(pts[pts.length - 1][0])}${f.isNum(avg) ? `, average ${Math.round(avg)} bpm` : ''}.` })), { read: 'Touch the line to read a minute. The shaded part is the route.' })}</section>`);
  };
  const paint = () => {
    map?.destroy();
    document.title = `${r.title} · rep.`;
    mount(root, html`${head({ title: r.title, back: r.mine ? '/workouts/routes' : '/workouts/routes?scope=public' })}
      <div class="rt-hero">
        <div data-map></div>
        <dl class="rt-stats">
          <div><dt>${r.bothWays ? 'There and back' : 'Distance'}</dt><dd>${f.dist(r.distanceM)}</dd></div>
          <div><dt>Climb</dt><dd>${f.isNum(r.climbM) ? `${f.int(r.climbM)} m` : 'Not known'}</dd></div>
          <div><dt>For</dt><dd>${r.sportLabel}</dd></div>
        </dl>
      </div>
      ${r.by && !r.mine ? html`<a class="rt-by" href="/u/${encodeURIComponent(r.by.username)}">${avatar(r.by)}<span>Shared by <b>${r.by.displayName || r.by.username}</b> · ${f.dayRel(new Date(r.createdAt).toISOString().slice(0, 10))}</span></a>` : ''}
      <div class="btnrow rt-acts">
        <a class="btn" href="/workouts/record?route=${encodeURIComponent(r.id)}">${ic('play', { size: 's' })}Try it</a>
        <a class="btn btn--tonal" href="/api/routes/${encodeURIComponent(r.id)}/route.gpx" data-native download>${ic('download', { size: 's' })}GPX for a watch</a>
        ${r.mine ? html`<button type="button" class="btn btn--tonal" data-act="link">${ic('link', { size: 's' })}Send a link</button>` : html`<button type="button" class="btn btn--tonal" data-act="copy">${ic('copy', { size: 's' })}Save a copy</button>`}
      </div>
      ${r.mine ? html`<div class="mod rt-own">
        ${loopy ? '' : html`<label class="rt-share"><span><b>There and back</b><small>${r.bothWays ? `Out and back the same way: ${f.dist(r.distanceM)} in all, ${f.dist(r.distanceM / 2)} each way.` : 'Out along it, then back the same way: twice the distance.'}</small></span>${toggle('bothWays', r.bothWays, { label: 'There and back' })}</label>`}
        <label class="rt-share"><span><b>Share with everyone</b><small>${r.public ? 'Anybody signed in can find it under Public. If your account is private, nobody else sees it.' : 'Only you see it now.'}</small></span>${toggle('public', r.public, { label: 'Share with everyone' })}</label>
        <div class="btnrow"><a class="btn btn--tonal btn--s" href="/workouts/routes/${encodeURIComponent(r.id)}/edit">${ic('edit', { size: 's' })}Edit route</a><button type="button" class="btn btn--tonal btn--s" data-act="copy">${ic('copy', { size: 's' })}Duplicate</button><button type="button" class="btn btn--danger btn--s" data-act="delete">Delete</button></div>
      </div>` : ''}
      ${tries.length ? html`<section class="bsec"><h2>Your goes${info('Fastest first. Only the route counts: the way to its start and on afterwards is left out.', { label: 'About your goes' })}</h2></section>
        <div class="group">${tries.map((x, i) => html`<a class="row" href="/workouts/${encodeURIComponent(x.workoutId)}">
          <span class="row__ic rt-rank">${i + 1}</span>
          <span class="row__body"><span class="row__t">${goTime(x.timeS)}</span><span class="row__d">${f.dayRel(x.date)} · ${f.clock(x.startT)} · ${f.dist(x.distanceM)}${x.byHand ? ' · marked by hand' : ''}</span></span>
          ${i === 0 && tries.length > 1 ? html`<span class="row__v">Best</span>` : ''}</a>`)}</div>` : ''}
      <div data-rt-heart></div>`);
    paintHeart();
    requestAnimationFrame(() => { const el = root.querySelector('[data-map]'); if (el) map = routeMap(el, { line: r.line, twoWay: r.bothWays, height: 300, label: `Map of ${r.title}, ${f.dist(r.distanceM)}${r.bothWays ? ' there and back' : ''}` }); });
  };
  paint();
  if (tries[0]) {
    const go1 = tries[0];
    api.get(`/api/workouts/${encodeURIComponent(go1.workoutId)}`).then((w) => {
      if (!ctx.alive()) return;
      const stop = w.end ?? (go1.startT + go1.timeS * 1000);
      const pts = (w.trace || []).filter((p) => f.isNum(p[1]) && p[0] >= w.start && p[0] <= stop).map((p) => [p[0], p[1]]);
      if (pts.length < 2) return;
      const start = go1.startT; const end = go1.startT + go1.timeS * 1000;
      const inGo = pts.filter((p) => p[0] >= start && p[0] <= end).map((p) => p[1]);
      beat = { pts, start, end, go1, avg: inGo.length ? inGo.reduce((a, v) => a + v, 0) / inGo.length : null };
      paintHeart();
    }).catch(() => { /* the page is whole without it */ });
  }
  on(root, 'change', '.rt-own input[name="bothWays"]', async (e, input) => {
    try { r = { ...r, ...(await api.patch(`/api/routes/${encodeURIComponent(r.id)}`, { bothWays: input.checked })) }; toast(r.bothWays ? `There and back: ${f.dist(r.distanceM)}.` : `One way: ${f.dist(r.distanceM)}.`); paint(); } catch (err) { input.checked = !input.checked; toast(errText(err), { tone: 'bad' }); }
  });
  on(root, 'change', '.rt-own input[name="public"]', async (e, input) => {
    try { r = await api.patch(`/api/routes/${encodeURIComponent(r.id)}`, { public: input.checked }); toast(r.public ? 'Shared with everyone.' : 'Only you see it now.'); paint(); } catch (err) { input.checked = !input.checked; toast(errText(err), { tone: 'bad' }); }
  });
  // A copy, yours and private: made, then opened, to change as you like.
  on(root, 'click', '[data-act="copy"]', async (e, b) => {
    try {
      const c = await busy(b, () => api.post(`/api/routes/${encodeURIComponent(r.id)}/copy`));
      toast(r.mine ? 'Copy made. Edit it to make it different.' : 'Saved to your routes. Only you see it.');
      go(`/workouts/routes/${encodeURIComponent(c.id)}`);
    } catch (err) { toast(errText(err), { tone: 'bad' }); }
  });
  on(root, 'click', '[data-act="link"]', () => shareLinkSheet({ kind: 'route', base: `/api/routes/${encodeURIComponent(r.id)}`, title: r.title }));
  on(root, 'click', '[data-act="delete"]', async () => {
    if (!(await confirm({ title: 'Delete this route?', text: r.public ? 'It is taken off Public too. Workouts done on it stay.' : 'Workouts done on it stay.', yes: 'Delete', danger: true }))) return;
    try { await api.del(`/api/routes/${encodeURIComponent(r.id)}`); toast('Route deleted.'); go('/workouts/routes', { replace: true }); } catch (err) { toast(errText(err), { tone: 'bad' }); }
  });
  ctx.onLeave?.(() => map?.destroy());
}
