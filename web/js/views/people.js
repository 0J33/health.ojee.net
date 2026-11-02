/* People: friends' workouts (Feed) and the leaderboards (Boards), one tab.

     /people          the feed, or the boards when those were open last
     /ranks           the boards (old links keep ?metric= and ?period=)
     /people/friends  friends, requests, people you may know
     /post/:id        one post: who cheered, the comments

   Sideways, the screen is one strip: the feed, then each board in the
   order the picker lists them. A swipe moves along it; past either end it
   moves to the next tab (motion.js, setPager).

   The feed is what friends did, newest first, grouped by day: a post per
   workout, made by the server from what each person already shares. A
   cheer is one tap; comments are short. Both exist to say "nice one",
   so there is no count of anything that could turn into a contest.

   Everything here is what the API returned; a missing number is left out,
   never worked out from something else. */

import { medalTally, medalText, medalRow } from '../medals.js';
import { api, qs } from '../api.js';
import { app, listen, go, refreshMe } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, empty, banner, on, seg, sheet, confirm, toast, toastError, busy } from '../ui.js';
import { setPager, haptic, riseIn } from '../motion.js';
import { ib } from '../kit.js';
import * as f from '../format.js';
import { avatar, unitValue } from './shared.js';
import { lookSheet } from '../progs.js';
import { mediaStrip, bindStrips, editGrid, bindEditGrid, addToPost, MAX_PER_POST } from '../media.js';
import { METRIC, METRICS, BOARD_GROUPS, PERIODS, TILE, PERIOD_WORDS, PREV, entry, podium, groupCard, nameOf, ordinal } from './ranks.js';

const KEY = { mode: 'health.people.mode', scope: 'health.people.scope' };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: it is only a convenience */ } },
};

/* ── what a workout looks like in the feed ──────────────────── */

/** A workout type → its kind: the icon, the tile colour, which numbers lead. */
function kindOf(type, p = {}) {
  const t = String(type || '').toUpperCase();
  if (p.sets || /STRENGTH|WEIGHT|CALISTHEN|CROSSFIT|POWERLIFT|BODY_WEIGHT|FREE_WEIGHTS|TRX/.test(t)) return { id: 'strength', icon: 'dumbbell', tile: 'energy' };
  if (/RUN|JOG|TREADMILL$|TRACK/.test(t)) return { id: 'run', icon: 'run', tile: 'active' };
  if (/BIK|CYCL|SPIN/.test(t)) return { id: 'ride', icon: 'bike', tile: 'water' };
  if (/HIK|BACKPACK|SNOWSHOE|RUCK/.test(t)) return { id: 'hike', icon: 'hike', tile: 'steps' };
  if (/WALK/.test(t)) return { id: 'walk', icon: 'walk', tile: 'steps' };
  if (/SWIM/.test(t)) return { id: 'swim', icon: 'swim', tile: 'water' };
  if (/YOGA|PILATES|STRETCH|MEDITAT|TAI_CHI/.test(t)) return { id: 'calm', icon: 'yoga', tile: 'sleep' };
  if (/ROW/.test(t)) return { id: 'row', icon: 'rowing', tile: 'water' };
  return { id: 'sport', icon: 'sport', tile: 'heart' };
}

/** A full-width switch of a few options with a thumb that slides to the chosen one. */
function segx(name, options, current, label) {
  const i = Math.max(0, options.findIndex(([v]) => v === current));
  return html`<div class="segx" role="group" aria-label="${label}" style="--n:${options.length};--i:${i}">
    ${options.map(([v, t]) => html`<button type="button" class="segx__o" data-seg="${name}" data-value="${v}" aria-pressed="${String(v === current)}">${t}</button>`)}
  </div>`;
}
/** Move a segx to `value` without drawing it again, so the thumb slides. */
function segxTo(root, name, value) {
  const opts = [...root.querySelectorAll(`[data-seg="${name}"]`)];
  opts.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.value === value)));
  const box = opts[0]?.parentElement;
  const i = opts.findIndex((o) => o.dataset.value === value);
  if (box && i >= 0) box.style.setProperty('--i', String(i));
}

const typeWords = (t) => (t ? String(t).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Workout');

/** "5:31" a km (or a mile), from seconds a km. */
function pace(sPerKm) {
  if (!f.isNum(sPerKm) || sPerKm <= 0) return null;
  const s = Math.round(f.distUnit() === 'mi' ? sPerKm * 1.609344 : sPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** km/h (or mph) from km/h. */
const speed = (kmh) => (f.isNum(kmh) && kmh > 0 ? f.dec1(f.distUnit() === 'mi' ? kmh / 1.609344 : kmh) : null);

/** The two or three numbers a post leads with, as [value, unit, label]. */
function numbersOf(p, k) {
  const out = [];
  const time = f.isNum(p.durationMin) ? f.durParts(p.durationMin) : null;
  const timeCell = time ? [time.h ? `${time.h}:${String(time.m).padStart(2, '0')}` : String(time.m), time.h ? 'h' : 'min', 'Time'] : null;
  if (f.isNum(p.distanceM) && p.distanceM > 0) {
    out.push([f.distNum(p.distanceM), f.distUnit(), 'Distance']);
    if (k.id === 'ride' || k.id === 'row') { const v = speed(p.avgSpeedKmh); if (v) out.push([v, f.distUnit() === 'mi' ? 'mph' : 'km/h', 'Speed']); } else { const v = pace(p.paceSPerKm); if (v) out.push([v, `/${f.distUnit()}`, 'Pace']); }
    if (timeCell) out.push(timeCell);
  } else if (f.isNum(p.sets) && p.sets > 0) {
    if (timeCell) out.push(timeCell);
    out.push([f.int(p.sets), '', p.sets === 1 ? 'Set' : 'Sets']);
    if (f.isNum(p.volumeKg) && p.volumeKg > 0) { const v = f.volume(p.volumeKg, { unit: false }); out.push([v, f.volumeUnit() === 't' ? 't' : f.volumeUnit(), 'Volume']); }
  } else {
    if (timeCell) out.push(timeCell);
    if (f.isNum(p.avgHr)) out.push([f.int(p.avgHr), 'bpm', 'Avg heart']);
    if (f.isNum(p.kcal) && p.kcal > 0) out.push([f.int(p.kcal), 'kcal', 'Calories']);
  }
  return out.slice(0, 3);
}

/** "Noor", "Noor and Sam", "Noor and 3 others": who cheered. */
function cheerWords(p) {
  const list = (p.cheerers || []).map((x) => (x.me ? 'You' : nameOf(x)));
  if (!p.cheers) return '';
  if (list.length === 0) return f.plural(p.cheers, 'cheer');
  const rest = p.cheers - 1;
  return rest <= 0 ? list[0] : rest === 1 && list[1] ? `${list[0]} and ${list[1]}` : `${list[0]} and ${f.plural(rest, 'other')}`;
}

/** A set as words: "60 kg × 8", "45 s", "400 m"; a warm-up is marked. */
function setWords([kg, reps, type, secs, metres]) {
  const parts = [];
  if (f.isNum(kg) && kg > 0) parts.push(`${f.weightNum(kg).replace(/[.,]0$/, '')} ${f.weightUnit()}`);
  if (f.isNum(reps)) parts.push(`${parts.length ? '× ' : ''}${reps}${parts.length ? '' : ' reps'}`);
  if (f.isNum(secs) && secs > 0) parts.push(secs >= 60 ? `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}` : `${Math.round(secs)} s`);
  if (f.isNum(metres) && metres > 0) parts.push(f.dist(metres));
  return parts.join(' ') || 'Done';
}
const SET_MARK = { warmup: 'W', dropset: 'D', failure: 'F' };

/** The kilometre splits of a route: a bar a split, the fastest full. */
function splitsCard(p, k) {
  const sp = (p.splits || []).filter((x) => f.isNum(x.movingS) && x.movingS > 0);
  if (sp.length < 2) return '';
  const ride = k.id === 'ride';
  const rate = (x) => (ride ? x.speedKmh : x.paceSPerKm);
  // The short last stretch is shown but never the best (it is too short to judge).
  const vals = sp.filter((x) => !x.partial).map(rate).filter(f.isNum);
  const best = ride ? Math.max(...vals) : Math.min(...vals);
  const worst = ride ? Math.min(...vals) : Math.max(...vals);
  const w = (v) => Math.max(0.12, Math.min(1, best === worst ? 1 : ride ? 0.35 + 0.65 * ((v - worst) / (best - worst)) : 0.35 + 0.65 * ((worst - v) / (worst - best))));
  return html`<section class="bt bt--plain post-splits"><p class="post-sec">${ic('flag', { size: 's' })}Splits</p>
    <ul class="spl">${sp.map((x) => { const v = rate(x); return html`<li class="${v === best && !x.partial ? 'is-best' : ''}">
      <span class="spl__n n">${x.partial ? f.distNum(x.distanceM) : x.n}</span>
      <span class="spl__bar"><i data-w="${w(v).toFixed(3)}"></i></span>
      <span class="spl__v n">${ride ? `${speed(v)} ${f.distUnit() === 'mi' ? 'mph' : 'km/h'}` : `${pace(v)} /${f.distUnit()}`}</span>
      ${f.isNum(x.elevM) && x.elevM !== 0 ? html`<span class="spl__e">${x.elevM > 0 ? '+' : ''}${x.elevM} m</span>` : html`<span class="spl__e"></span>`}
    </li>`; })}</ul></section>`;
}

/** Every exercise of a session with each set, records first noted on the card. */
function setsCard(p) {
  // Kept as exercises only by its owner (all: null): the names, no sets.
  const exs = (p.exercises || []).filter((x) => (Array.isArray(x.all) && x.all.length) || x.all === null);
  if (!exs.length) return '';
  return html`<section class="bt bt--plain post-sets"><p class="post-sec">${ic('dumbbell', { size: 's' })}Exercises</p>
    ${exs.map((x) => (x.all === null ? html`<div class="pset"><p class="pset__n">${x.name}</p></div>` : html`<div class="pset"><p class="pset__n">${x.name}</p><ol class="pset__l">${x.all.map((st, i) => html`<li><span class="pset__i n">${SET_MARK[st[2]] || i + 1 - x.all.slice(0, i).filter((z) => SET_MARK[z[2]] === 'W').length}</span><span class="n">${setWords(st)}</span></li>`)}</ol></div>`))}
  </section>`;
}

/** One post. `full` is the post page: no link around it, a map to move, splits and every set. */
function postCard(p, { full = false } = {}) {
  const k = kindOf(p.type, p);
  const nums = numbersOf(p, k);
  const who = p.author || {};
  // Fresh: "2 h ago". Older: the day and the time it started, as Google and Strava list them.
  const when = !f.isNum(p.at) ? '' : Date.now() - p.at < 6 * 3600_000 ? f.ago(p.at) : `${f.dayRel(f.instDay(p.start ?? p.at))} at ${f.clock(p.start ?? p.at)}`;
  const title = p.title && p.title !== 'Workout' ? p.title : typeWords(p.type);
  const exs = Array.isArray(p.exercises) ? p.exercises : [];
  const exLine = !full && exs.length ? exs.slice(0, 3).map((x) => `${x.name}${f.isNum(x.sets) ? ` ×${x.sets}` : ''}`).join(' · ') + (exs.length > 3 ? ` · +${exs.length - 3}` : '') : '';
  const route = Array.isArray(p.route) && p.route.length > 1;
  const top = html`
    <h3 class="post__title">${title}</h3>
    ${p.routine ? (full && p.routineId
    ? html`<button type="button" class="post__routine post__routine--btn" data-shared-rt="${p.routineId}">${ic('playlist', { size: 's' })}<span>${p.routine}</span><span class="post__rtsee">See the routine</span></button>`
    : html`<p class="post__routine">${ic('playlist', { size: 's' })}${p.routine}</p>`) : ''}
    ${p.caption ? html`<p class="post__cap">${p.caption}</p>` : ''}`;
  // Photos and videos sit between the words and the numbers. On a card they are
  // outside its link (a tap opens the viewer, not the post), so the link is in two parts.
  const strip = mediaStrip(p.media);
  const body = html`
    ${route ? html`<div class="post__map" data-route="${p.id}"></div>` : ''}
    <div class="bt bt--${k.tile} post__tile">
      <div class="bt__row"><span class="bt__lab">${ic(k.icon)}${typeWords(p.type)}</span>${f.isNum(p.prs) && p.prs > 0 && !p.medals ? html`<span class="post__pr">${ic('record', { size: 's' })}${f.plural(p.prs, 'record')}</span>` : html`<span class="bt__meta">${f.isNum(p.start) ? f.clock(p.start) : ''}</span>`}</div>
      ${nums.length ? html`<div class="post__nums">${nums.map(([v, u, l]) => html`<div><p class="n n-s">${v}${u ? html`<span class="u">${u}</span>` : ''}</p><p class="post__k">${l}</p></div>`)}</div>` : ''}
      ${exLine ? html`<p class="post__ex">${exLine}</p>` : ''}
      ${p.medals ? html`<div class="post__md">${medalTally(p.medals)}${p.medals.top?.[0] ? html`<span class="post__mdt">${medalText(p.medals.top[0]).title}${p.medals.top[0].exercise ? ` · ${p.medals.top[0].exercise}` : ''}</span>` : ''}</div>` : ''}
    </div>
    ${full && p.medals?.top?.length ? html`<div class="md-case md-case--list post__mdlist">${p.medals.top.map((m) => medalRow(m))}</div>` : ''}`;
  const cw = cheerWords(p);
  const priv = p.mine && p.shared === false;
  return html`<article class="post ${priv ? 'is-private' : ''}" data-post="${p.id}">
    <header class="post__head">
      <a class="post__who" href="/u/${encodeURIComponent(who.username || '')}">${avatar(who)}<span><b>${who.me ? 'You' : nameOf(who)}</b><small>${when}</small></span></a>
      ${p.mine ? html`<button type="button" class="iconbtn iconbtn--s" data-post-menu aria-label="Post options">${ic('more')}</button>` : ''}
    </header>
    ${full ? html`<div class="post__body">${top}${strip}${body}</div>`
      : html`<a class="post__body" href="/post/${encodeURIComponent(p.id)}">${top}</a>${strip}<a class="post__body" href="/post/${encodeURIComponent(p.id)}" tabindex="-1">${body}</a>`}
    ${priv ? html`<div class="post__share"><span>${ic('lock', { size: 's' })}Only you see this</span><button type="button" class="pill-btn pill-btn--ink" data-share="on">Share</button></div>`
      : html`<footer class="post__foot">
      <button type="button" class="post__act ${p.cheered ? 'is-on' : ''}" data-cheer aria-pressed="${String(!!p.cheered)}" aria-label="${p.cheered ? 'Take back your cheer' : 'Cheer'}">${ic('cheer', { size: 's' })}<span class="n" data-cheers>${p.cheers || ''}</span></button>
      ${full ? '' : html`<a class="post__act" href="/post/${encodeURIComponent(p.id)}#comments" aria-label="${f.plural(p.comments || 0, 'comment')}">${ic('comment', { size: 's' })}<span class="n">${p.comments || ''}</span></a>`}
      <span class="post__who-cheered" data-cheer-words>${cw}</span>
    </footer>`}
  </article>`;
}

/** Draw the route maps of the posts under `root` that have none yet. `full`: one to move about. */
async function drawRoutes(root, find, { full = false } = {}) {
  const slots = [...root.querySelectorAll('[data-route]:not(.map)')];
  if (!slots.length) return;
  const { routeMap } = await import('../map.js');
  for (const el of slots) {
    const p = find(el.dataset.route);
    if (p?.route?.length > 1 && el.isConnected) routeMap(el, { line: p.route, height: full ? 280 : 168, still: !full, label: `Map of ${p.title || 'the route'}` });
  }
}

/** Splits' bars take their widths after drawing (no inline styles in the markup). */
function sizeBars(root) {
  root.querySelectorAll('.spl__bar i[data-w]').forEach((i) => { i.style.width = `${Number(i.dataset.w) * 100}%`; i.removeAttribute('data-w'); });
}

/** Posts with a quiet label above each day. */
function feedList(posts, { lastDay = '' } = {}) {
  let day = lastDay;
  const out = [];
  for (const p of posts) {
    const d = f.instDay(p.start ?? p.at);   // a session belongs to the day it started, as in Google Health
    if (d !== day) { day = d; out.push(html`<h2 class="feed__day" data-day="${d}">${f.dayRel(d)}</h2>`); }
    out.push(postCard(p));
  }
  return { content: out, lastDay: day };
}

/** A cheer, from any post card under `root`. */
function bindCheers(root, find) {
  on(root, 'click', '[data-cheer]', async (e, b) => {
    const card = b.closest('[data-post]');
    const p = find(card?.dataset.post);
    if (!p || b.classList.contains('is-busy')) return;
    const was = { cheered: p.cheered, cheers: p.cheers };
    const paint = () => {
      b.classList.toggle('is-on', !!p.cheered);
      b.setAttribute('aria-pressed', String(!!p.cheered));
      b.setAttribute('aria-label', p.cheered ? 'Take back your cheer' : 'Cheer');
      b.querySelector('[data-cheers]').textContent = p.cheers || '';
      const list = (p.cheerers || []).filter((x) => !x.me);
      if (p.cheered) list.unshift({ me: true });
      p.cheerers = list;
      card.querySelector('[data-cheer-words]').textContent = cheerWords(p);
    };
    p.cheered = !p.cheered; p.cheers = Math.max(0, (p.cheers || 0) + (p.cheered ? 1 : -1));
    if (p.cheered) { haptic(10); b.classList.remove('is-pop'); void b.offsetWidth; b.classList.add('is-pop'); }
    paint();
    b.classList.add('is-busy');
    try {
      const r = await api.post(`/api/posts/${encodeURIComponent(p.id)}/cheer`);
      p.cheered = !!r.cheered; p.cheers = r.cheers;
      paint();
    } catch (err) {
      Object.assign(p, was); paint();
      toastError(err, 'That cheer did not go through. Try again.');
    } finally { b.classList.remove('is-busy'); }
  });
}

/** Your own post: its photos and videos, its caption, hiding it from the feed or showing it again.
    `onMedia()` after a photo or video was added or removed (p.media is current by then). */
async function postMenu(p, done, onMedia = () => done(p)) {
  const shared = p.shared !== false;
  const s = sheet({
    title: 'Your post',
    body: html`<form class="stack post-edit" data-form>
      <div class="field"><span class="field__label">Photos and videos</span>${editGrid(p)}
        <span class="field__hint">Up to ${MAX_PER_POST}. Whoever sees this post sees them.</span></div>
      <label class="field"><span class="field__label">Caption</span>
        <textarea class="textarea" name="caption" maxlength="280" rows="3" placeholder="How did it go?">${p.caption || ''}</textarea>
        <span class="field__hint">Your friends see it above the numbers.</span></label>
      <div class="st-cta"><button class="btn" type="submit">Save</button>
        <button class="btn btn--tonal" type="button" data-toggle>${shared ? 'Stop sharing' : 'Share with friends'}</button></div>
      <p class="muted small">${shared ? 'Friends see this workout in their feed.' : 'Only you see this workout.'} Whether new workouts are shared by themselves is in Me, Privacy.</p>
    </form>`,
  });
  const form = s.el.querySelector('[data-form]');
  const save = async (patch, btn) => busy(btn, async () => {
    try { const r = await api.patch(`/api/posts/${encodeURIComponent(p.id)}`, patch); Object.assign(p, r); s.close(); done(p); } catch (err) { toastError(err); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = form.caption.value.trim(); save({ caption: v || null }, form.querySelector('[type="submit"]')); });
  s.el.querySelector('[data-toggle]').addEventListener('click', (e) => save({ shared: !shared }, e.currentTarget));
  bindEditGrid(s.el, p, () => mediaChanged(p, () => {
    const grid = s.el.querySelector('[data-mgrid]');
    if (grid && s.el.isConnected) { const h = document.createElement('div'); mount(h, editGrid(p)); grid.replaceWith(h.firstElementChild); }
    onMedia();
  }));
}

/** After photos or videos changed on a post: read its list again, then `then()`. */
async function mediaChanged(p, then) {
  try { p.media = (await api.get(`/api/posts/${encodeURIComponent(p.id)}`)).media || []; } catch { /* keep what is shown */ }
  then();
}

/** Share one of your posts with friends, from its card. */
function bindShare(root, find, done) {
  on(root, 'click', '[data-share]', async (e, b) => {
    const p = find(b.closest('[data-post]')?.dataset.post);
    if (!p) return;
    await busy(b, async () => {
      try { Object.assign(p, await api.patch(`/api/posts/${encodeURIComponent(p.id)}`, { shared: true })); haptic(10); toast('Shared with your friends'); done(p); } catch (err) { toastError(err); }
    });
  });
}

/* ── the people strip: a person with an action ──────────────── */

function personRow(p, end, { sub = '' } = {}) {
  return html`<div class="row fr-row" data-user="${p.username}">
    <a class="fr-row__who" href="/u/${encodeURIComponent(p.username)}">${avatar(p)}<span class="row__body"><span class="row__t">${nameOf(p)}</span><span class="row__d">${sub || `@${p.username}`}</span></span></a>
    <span class="fr-row__end">${end}</span>
  </div>`;
}

async function friendAct(action, username, btn) {
  return busy(btn, async () => {
    try {
      const r = await api.post(`/api/friends/${action}`, { username });
      refreshMe().catch(() => {});
      return r;
    } catch (err) { toastError(err); return null; }
  });
}

/* ── the main screen ────────────────────────────────────────── */

async function main(ctx) {
  const { root } = ctx;
  on(root, 'click', '[data-routes-ask-off]', (e, b) => { try { localStorage.setItem('health.routesAsk', 'off'); } catch { /* fine */ } b.closest('.feed-ask')?.remove(); });
  document.title = 'People · Health';
  const q = ctx.query;
  let mode = ctx.name === 'board' || q.get('metric') ? 'boards' : (store.get(KEY.mode) === 'boards' ? 'boards' : 'feed');
  let metric = METRICS.includes(q.get('metric')) ? q.get('metric') : 'steps';
  let period = PERIODS.some(([p]) => p === q.get('period')) ? q.get('period') : 'week';
  let scope = store.get(KEY.scope) === 'everyone' ? 'everyone' : 'friends';
  let board = null; let feed = null; let friends = null;
  let posts = []; let next = null; let lastDay = '';
  let io = null; let more = null;
  let slideFrom = '';

  const requests = () => app.me?.social?.requests || friends?.incoming?.length || 0;
  const kick = () => (friends ? (friends.friends.length ? f.plural(friends.friends.length, 'friend') : 'No friends yet') : html`&nbsp;`);

  function headPart() {
    const n = requests();
    return head({ kick: kick(), title: 'People', actions: html`
      <a class="pp-ib" href="/people/friends" aria-label="Friends${n ? `, ${n} waiting` : ''}">${ic('users')}${n ? html`<span class="pp-badge n">${n}</span>` : ''}</a>
      <a class="pp-ib" href="/compare" aria-label="Compare with a friend">${ic('compare')}</a>` });
  }

  function url() {
    const u = mode === 'feed' ? '/people' : `/ranks${qs({ metric: metric === 'steps' ? '' : metric, period: period === 'week' ? '' : period })}`;
    history.replaceState(history.state, '', u);
  }

  /* the boards */

  function pickInner() {
    const m = METRIC[metric];
    const group = BOARD_GROUPS.find(([, ids]) => ids.includes(metric))?.[0] || '';
    return html`${ib(m.icon, { fam: m.fam })}<span class="pp-pick__t"><b>${m.label}</b><small>${group}${scope === 'everyone' ? ' · everyone' : ''}</small></span>`;
  }
  function pickButton() {
    const m = METRIC[metric];
    const i = METRICS.indexOf(metric);
    return html`<button type="button" class="pp-pick fam fam-${m.fam}" data-pick aria-haspopup="dialog" aria-label="Board: ${m.label}. Choose another">
      <span class="pp-pick__in" data-pick-in>${pickInner()}</span>
      <span class="pp-dots" aria-hidden="true">${METRICS.map((_, j) => html`<i class="${j === i ? 'is-on' : ''}"></i>`)}</span>
      ${ic('chev_d', { size: 's' })}
    </button>`;
  }
  /** The board button shows another board in place: the dot slides, the name comes in from the side it was swiped from. */
  function pickUpdate(from = '') {
    const btn = root.querySelector('[data-pick]');
    if (!btn) return false;
    const m = METRIC[metric];
    btn.className = `pp-pick fam fam-${m.fam}`;
    btn.setAttribute('aria-label', `Board: ${m.label}. Choose another`);
    const inner = btn.querySelector('[data-pick-in]');
    const shown = inner.dataset.metric;
    inner.dataset.metric = metric;
    if (shown !== metric) {
      mount(inner, pickInner());
      inner.classList.remove('is-in-l', 'is-in-r'); void inner.offsetWidth;
      if (from) inner.classList.add(`is-in-${from}`);
    }
    btn.querySelectorAll('.pp-dots i').forEach((d, j) => d.classList.toggle('is-on', j === METRICS.indexOf(metric)));
    return true;
  }

  function boardBody() {
    if (!board) return html`<div class="pp"><div class="bt bt--plain pp-pod skel" aria-busy="true" aria-label="Loading"></div><div class="pp-skl">${skeleton('list')}</div></div>`;
    const d = board;
    const me = d.me || {};
    const meta = METRIC[d.metric] || METRIC.steps;
    const tile = TILE[meta.fam] || 'steps';
    const mine = d.entries.find((e) => e.me);
    const priv = /private/i.test(me.reason || '');
    const span = period === 'today' ? 'day' : period === 'week' ? 'week (from the day they chose their week to start)' : period === 'month' ? 'month' : 'total';
    // The podium card already says "not on this board"; a banner only for privacy, which has a fix.
    const notice = me.listed === false && priv ? banner({
      iconName: priv ? 'lock' : 'info',
      title: priv ? 'You are not on this board' : 'You are not on this board yet',
      text: priv ? `${me.reason}, so others cannot see you here. You can change that in privacy settings.` : `${me.reason}.`,
      actions: priv ? html`<a class="btn btn--tonal btn--s" href="/settings/privacy">Privacy settings</a>` : '',
    }) : '';
    const explain = d.metric === 'sleep_consistency' ? 'Sleep consistency is out of 100: how far bedtime and wake time usually are from each person\'s own usual ones. It halves for every hour off (1 hour off is 50). A period without three nights yet uses the last 7 nights. '
      : d.metric === 'medals' ? 'Medals won in workouts on these days: gold for a best ever, silver for a best in a year, bronze for a best in 90 days, each against your own. '
      : d.metric === 'gym' || d.metric === 'gym_time' ? 'Counts strength sessions only: strength training, weights, weight machines, CrossFit and the like, and workouts logged in this app. '
      : d.metric === 'workouts' || d.metric === 'workout_time' ? 'Counts every workout, walks and runs too. The gym boards count strength sessions only. '
      : /^(run|ride|walk)_distance$/.test(d.metric) ? `Counts the distance of workouts recorded as ${d.metric === 'run_distance' ? 'runs' : d.metric === 'ride_distance' ? 'rides' : 'walks and hikes'}, from any app. ` : '';
    const who = scope === 'friends' ? 'You and your friends who share this are listed.' : 'Everyone who shares this is listed.';
    const foot = html`${explain}Each person's ${span} is counted in their own time zone. ${who}${PREV[period] ? ` Arrows show places moved since ${PREV[period]}.` : ''}`;
    const nobody = scope === 'friends' && !(friends?.friends?.length)
      ? empty({ iconName: 'users', title: 'Just you here so far', text: 'Add friends and they show up on every board.', action: html`<a class="btn btn--tonal" href="/people/friends">Find friends</a>` })
      : empty({ iconName: 'ranks', title: 'Nobody has a number here yet', text: `Nothing has been recorded for ${String(d.label).toLowerCase()} ${period === 'today' ? 'today' : period === 'all' ? 'in this app' : `this ${period}`}. Try another period.` });
    const body = !d.entries.length
      ? html`${podium(d, period)}${notice}<div class="mod mod--12">${nobody}</div><p class="ranks__foot muted small">${foot}</p>`
      : html`${podium(d, period)}
        ${notice}
        <div class="bsec"><h2>${d.label} ${PERIOD_WORDS[period] || ''}</h2><span class="pp-bsec-n">All ${f.int(d.entries.length)}</span></div>
        <div class="pp-board fam fam-${meta.fam}" style="--pdc: var(--tile-${tile})">
          <div class="lbs" role="list" aria-label="${d.label}, ${d.periodLabel}">${d.entries.map((e) => html`<div role="listitem">${entry(e, d)}</div>`)}</div>
        </div>
        ${groupCard(d)}
        <p class="ranks__foot muted small">${foot}</p>`;
    return html`<div class="pp">${body}</div>
      ${mine ? html`<div class="pinned pp-pin fam fam-${meta.fam}" style="--pdc: var(--tile-${tile})" data-pin hidden>${entry(mine, d, { pinned: true })}</div>` : ''}`;
  }

  /* the feed */

  function requestStrip() {
    const inc = friends?.incoming || [];
    if (!inc.length) return '';
    const p = inc[0];
    return html`<section class="bt bt--plain feed__req" data-user="${p.username}">
      <a class="post__who" href="/u/${encodeURIComponent(p.username)}">${avatar(p)}<span><b>${nameOf(p)}</b><small>${inc.length > 1 ? `and ${f.plural(inc.length - 1, 'other')} want to be friends` : 'wants to be friends'}</small></span></a>
      <span class="feed__req-b">${inc.length > 1 ? html`<a class="pill-btn pill-btn--soft" href="/people/friends">See all</a>` : html`<button type="button" class="pill-btn pill-btn--soft" data-fr="decline">Not now</button>`}<button type="button" class="pill-btn pill-btn--ink" data-fr="accept">Accept</button></span>
    </section>`;
  }

  function feedPane() {
    if (!feed) return html`<div class="feed" aria-busy="true" aria-label="Loading">${[0, 1, 2].map(() => html`<div class="skel feed__skel"></div>`)}</div>`;
    if (!posts.length) {
      const sug = (friends?.suggestions || []).slice(0, 4);
      const lonely = !(friends?.friends?.length);
      return html`${requestStrip()}<div class="feed">
        <section class="bt bt--plain feed__empty">
          <span class="feed__empty-ic">${ic(lonely ? 'users' : 'run')}</span>
          <p class="feed__empty-t">${lonely ? 'Your feed is your friends' : 'Quiet for now'}</p>
          <p class="bt__sub">${lonely ? 'When friends finish a run, a ride or a session, it shows up here. Cheer them on; they can cheer you.' : 'Nothing from you or your friends in the last few weeks. The next workout anyone records shows up here.'}</p>
          ${lonely ? html`<a class="btn" href="/people/friends">${ic('user_plus', { size: 's' })}Find friends</a>` : ''}
        </section>
        ${sug.length ? html`<div class="bsec"><h2>People you may know</h2></div><div class="group">${sug.map((p) => personRow(p, html`<button type="button" class="pill-btn pill-btn--soft" data-fr="request">Add</button>`))}</div>` : ''}
      </div>`;
    }
    const list = feedList(posts);
    lastDay = list.lastDay;
    // Their runs could show their maps: route maps are not allowed at Google yet. Once, until dismissed.
    let askOff = false; try { askOff = localStorage.getItem('health.routesAsk') === 'off'; } catch { /* shown */ }
    const ask = feed?.routesAsk && !askOff ? html`<div class="feed-ask">${ic('map', { size: 's' })}<span>Show the maps of your runs, walks and rides on your posts: allow route maps at Google.</span>
      <button type="button" class="btn btn--tonal btn--s" data-action="connect-google" data-groups="routes" data-return="/people">Allow</button><button type="button" class="iconbtn iconbtn--s" data-routes-ask-off aria-label="Not now">${ic('x', { size: 's' })}</button></div>` : '';
    return html`${requestStrip()}${ask}<div class="feed" data-feed>${list.content}</div>
      ${next ? html`<div class="feed__more" data-more><span class="spin" aria-hidden="true"></span></div>` : html`<p class="feed__end muted small">That is everything from the last few weeks.</p>`}`;
  }

  /* painting */

  /**
   * Draw what changed. The header, the Feed / Boards switch and the board
   * button stay where they are (so the switch's thumb and the board's dot
   * can slide); only what is under them is drawn again.
   * `slideFrom` ('l' | 'r') brings the new content in from that side:
   * the whole pane when the switch changed, the board alone otherwise.
   */
  let shownMode = '';
  function paint() {
    const y = window.scrollY;
    let pane = root.querySelector('[data-pane]');
    if (!pane) {
      mount(root, html`${headPart()}<div class="pp-mode">${segx('pmode', [['feed', 'Feed'], ['boards', 'Boards']], mode, 'Show')}</div><div class="pp-pane" data-pane></div>`);
      pane = root.querySelector('[data-pane]');
    } else {
      const h = document.createElement('div');
      mount(h, headPart());
      const old = root.querySelector('.head');
      if (old && h.firstElementChild && old.outerHTML !== h.firstElementChild.outerHTML) old.replaceWith(h.firstElementChild);
      segxTo(root, 'pmode', mode);
    }
    const whole = shownMode !== mode;
    let target = pane;
    if (mode === 'feed') {
      mount(pane, feedPane());
    } else if (!whole && pane.querySelector('[data-slide]')) {
      pickUpdate(slideFrom);
      target = pane.querySelector('[data-slide]');
      mount(target, boardBody());
    } else {
      mount(pane, html`${pickButton()}<div class="pp-slide" data-slide>${boardBody()}</div>`);
      pane.querySelector('[data-pick-in]').dataset.metric = metric;
    }
    shownMode = mode;
    // What a swipe left on them (it moved them by hand) goes; a slide already running is left
    // alone: a quiet refresh redrawing the content a moment after a switch used to cut it short.
    for (const el of [pane, pane.querySelector('[data-slide]')]) if (el) { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; }
    if (slideFrom) {
      for (const el of [pane, pane.querySelector('[data-slide]')]) el?.classList.remove('pp--in-l', 'pp--in-r');
      void target.offsetWidth; target.classList.add(`pp--in-${slideFrom}`); slideFrom = '';
      riseIn(target);
    }
    window.scrollTo(0, y);
    // Your own row pinned while the real one is scrolled out of view.
    io?.disconnect(); io = null;
    if (mode === 'boards') {
      const real = root.querySelector('[data-user="me"]');
      const pin = root.querySelector('[data-pin]');
      if (real && pin && 'IntersectionObserver' in window) {
        io = new IntersectionObserver(([en]) => { pin.hidden = en.isIntersecting || en.boundingClientRect.top > 0; }, { rootMargin: '0px 0px -72px 0px' });
        io.observe(real);
      }
    }
    watchMore();
    if (mode === 'feed') drawRoutes(root, findPost);
  }
  const findPost = (id) => posts.find((p) => p.id === id);

  function watchMore() {
    more?.disconnect(); more = null;
    const s = root.querySelector('[data-more]');
    if (!s || !('IntersectionObserver' in window)) return;
    more = new IntersectionObserver(([en]) => { if (en.isIntersecting) loadMore(); }, { rootMargin: '600px 0px' });
    more.observe(s);
  }

  /* loading */

  async function loadFriends() {
    try { friends = await api.get('/api/friends'); } catch { friends = friends || null; }
  }

  async function loadFeed({ quiet = false } = {}) {
    if (!quiet) { feed = null; paint(); }
    try {
      const [r] = await Promise.all([api.get('/api/feed?limit=20'), loadFriends()]);
      if (!ctx.alive() || mode !== 'feed') return;
      feed = r; posts = r.posts || []; next = r.next ?? null;
      paint();
    } catch (err) {
      if (ctx.alive() && !quiet && mode === 'feed') mount(root.querySelector('[data-pane]') || root, errorState(err));
    }
  }

  let moreBusy = false;
  async function loadMore() {
    if (moreBusy || !next) return;
    moreBusy = true;
    try {
      const r = await api.get(`/api/feed${qs({ before: next, limit: 20 })}`);
      if (!ctx.alive() || mode !== 'feed') return;
      const fresh = (r.posts || []).filter((p) => !posts.some((x) => x.id === p.id));
      posts.push(...fresh);
      next = r.next ?? null;
      const list = feedList(fresh, { lastDay });
      lastDay = list.lastDay;
      const holder = document.createElement('div');
      mount(holder, html`${list.content}`);
      root.querySelector('[data-feed]')?.append(...holder.childNodes);
      drawRoutes(root, findPost);
      if (!next) { const m = root.querySelector('[data-more]'); if (m) mount(m, html`<p class="feed__end muted small">That is everything from the last few weeks.</p>`); m?.removeAttribute('data-more'); more?.disconnect(); }
    } catch { /* the next scroll tries again */ } finally { moreBusy = false; }
  }

  async function loadBoard({ quiet = false } = {}) {
    if (!quiet && !board) paint();
    else if (!quiet) root.querySelector('.pp')?.classList.add('is-loading');
    const want = `${metric}/${period}/${scope}`;
    try {
      const [r] = await Promise.all([api.get(`/api/leaderboard${qs({ metric, period, scope })}`), friends ? null : loadFriends()]);
      if (!ctx.alive() || mode !== 'boards' || want !== `${metric}/${period}/${scope}`) return;
      board = r;
      paint();
    } catch (err) {
      if (ctx.alive() && !quiet && mode === 'boards') mount(root.querySelector('[data-pane]') || root, errorState(err));
    }
  }

  const load = (o) => (mode === 'feed' ? loadFeed(o) : loadBoard(o));

  /* moving around */

  function setMode(m, from = '') {
    if (m === mode) return;
    mode = m;
    store.set(KEY.mode, m);
    slideFrom = from;
    url();
    window.scrollTo(0, 0);
    if (m === 'feed' && feed) { paint(); loadFeed({ quiet: true }); } else if (m === 'boards' && board && board.metric === metric && board.period === period) { paint(); loadBoard({ quiet: true }); } else { if (m === 'boards') board = null; load(); }
  }

  function pick(id, from = '') {
    if (!METRICS.includes(id)) return;
    if (mode !== 'boards') { metric = id; board = null; setMode('boards', from); return; }
    if (id === metric) return;
    metric = id;
    slideFrom = from;
    url();
    pickUpdate(from);
    loadBoard();
  }

  async function boardsSheet() {
    const s = sheet({ title: 'Boards', body: html`<div class="bd-sheet" data-bds>${skeleton('list')}</div>` });
    s.el.classList.add('sheet--bd');
    const slot = s.el.querySelector('[data-bds]');
    const paintSheet = (sum) => {
      const by = Object.fromEntries((sum?.boards || []).map((b) => [b.metric, b]));
      mount(slot, html`
        <div class="bd-scope">${segx('bscope', [['friends', 'Friends'], ['everyone', 'Everyone']], scope, 'Who is on the boards')}</div>
        <div class="bd-list ${slideIn ? `pp--in-${slideIn}` : ''}">${BOARD_GROUPS.map(([name, ids]) => html`<p class="lg-lab">${name}</p><div class="bd-grid">${ids.map((id) => {
          const m = METRIC[id]; const b = by[id];
          const place = b?.me?.listed && f.isNum(b.me.rank) ? `You: ${ordinal(b.me.rank)} of ${f.int(b.total)}`
            : b?.leader ? `${b.leader.me ? 'You lead' : `${nameOf(b.leader)} leads`}` : b ? 'Nobody yet' : '';
          return html`<button type="button" class="lg-mini press bd-tile fam fam-${m.fam} ${id === metric ? 'is-on' : ''}" data-board="${id}" aria-pressed="${String(id === metric)}">
            <span class="lg-mini__ic">${ic(m.icon)}</span><span class="lg-mini__t">${m.label}</span><span class="lg-mini__s">${place || html`&nbsp;`}</span></button>`;
        })}</div>`)}</div>`);
      slideIn = '';
    };
    let slideIn = '';
    paintSheet(null);
    const read = async () => { try { paintSheet(await api.get(`/api/boards${qs({ period, scope })}`)); } catch { paintSheet({ boards: [] }); } };
    read();
    on(slot, 'click', '[data-board]', (e, b) => { s.close(); pick(b.dataset.board); });
    const setScope = (v) => {
      if (v === scope) return;
      slideIn = v === 'everyone' ? 'r' : 'l';
      scope = v; store.set(KEY.scope, scope);
      segxTo(slot, 'bscope', scope);
      haptic(8);
      read();
      if (mode === 'boards') loadBoard();
    };
    on(slot, 'click', '[data-seg="bscope"]', (e, b) => setScope(b.dataset.value));
    // A sideways swipe anywhere on the sheet: Friends (right) or Everyone (left), as on the switch.
    let t0 = null;
    slot.addEventListener('touchstart', (e) => { t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
    slot.addEventListener('touchend', (e) => {
      if (!t0) return;
      const dx = e.changedTouches[0].clientX - t0.x; const dy = e.changedTouches[0].clientY - t0.y;
      t0 = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      setScope(dx < 0 ? 'everyone' : 'friends');
    }, { passive: true });
  }

  /* the strip, for a swipe: the feed, then every board */
  const strip = ['feed', ...METRICS];
  const at = () => (mode === 'feed' ? 0 : 1 + METRICS.indexOf(metric));
  ctx.onLeave(setPager({
    area: '.view',
    // Between boards only the board moves; to or from the feed, everything under the switch does.
    el: (dir) => {
      const crossing = mode === 'feed' || (dir === 'prev' && at() === 1);
      return (!crossing && root.querySelector('[data-slide]')) || root.querySelector('[data-pane]');
    },
    has: (dir) => (dir === 'next' ? at() < strip.length - 1 : at() > 0),
    go: (dir) => {
      const crossing = mode === 'feed' || (dir === 'prev' && at() === 1);
      const el = (!crossing && root.querySelector('[data-slide]')) || root.querySelector('[data-pane]');
      const to = strip[at() + (dir === 'next' ? 1 : -1)];
      if (el) { el.style.transition = 'transform 200ms var(--ease), opacity 200ms'; el.style.transform = `translateX(${dir === 'next' ? -40 : 40}%)`; el.style.opacity = '0'; }
      const from = dir === 'next' ? 'r' : 'l';
      if (to === 'feed') setMode('feed', from); else pick(to, from);
      segxTo(root, 'pmode', mode);
    },
  }));

  /* taps */

  on(root, 'click', '[data-seg="pmode"]', (e, b) => setMode(b.dataset.value, b.dataset.value === 'boards' ? 'r' : 'l'));
  on(root, 'click', '[data-pick]', () => boardsSheet());
  on(root, 'click', '[data-seg="period"]', (e, b) => {
    if (b.dataset.value === period) return;
    period = b.dataset.value;
    for (const o of root.querySelectorAll('[data-seg="period"]')) o.setAttribute('aria-pressed', String(o === b));
    url();
    loadBoard();
  });
  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-fr]', async (e, b) => {
    const row = b.closest('[data-user]');
    const r = await friendAct(b.dataset.fr, row?.dataset.user, b);
    if (!r) return;
    if (b.dataset.fr === 'accept') toast(`You and ${row.querySelector('b, .row__t')?.textContent || 'they'} are friends now`);
    if (b.dataset.fr === 'request') toast(r.status === 'friends' ? 'You are friends now' : 'Request sent');
    await loadFriends();
    loadFeed({ quiet: true });
  });
  bindCheers(root, findPost);
  bindShare(root, findPost, () => paint());
  bindStrips(root, findPost);
  on(root, 'click', '[data-post-menu]', (e, b) => {
    const p = posts.find((x) => x.id === b.closest('[data-post]')?.dataset.post);
    if (p) postMenu(p, () => paint());
  });

  ctx.onLeave(listen('changed', (what) => { if (what.includes('social') || what.includes('data') || what.includes('workouts')) load({ quiet: true }); }));
  ctx.onLeave(() => { io?.disconnect(); more?.disconnect(); });
  ctx.onRefresh(() => load({ quiet: true }));
  url();
  await load();
}

/* ── friends (/people/friends) ──────────────────────────────── */

async function friendsPage(ctx) {
  const { root } = ctx;
  document.title = 'Friends · Health';
  let d = null;

  function paint() {
    const fr = d.friends || []; const inc = d.incoming || []; const out = d.outgoing || []; const sug = d.suggestions || [];
    const y = window.scrollY;
    mount(root, html`${head({ title: 'Friends', back: '/people' })}
      <div class="stack fr">
        <form class="fr-add" data-add>
          <label class="log__find">${ic('user_plus', { size: 's' })}<input class="input" name="username" placeholder="Add a friend by username" aria-label="Username" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="send"></label>
          <button class="btn" type="submit">Add</button>
        </form>
        ${inc.length ? html`<section><div class="bsec"><h2>Asking to be friends</h2><span class="pp-bsec-n">${f.int(inc.length)}</span></div>
          <div class="group">${inc.map((p) => personRow(p, html`<button type="button" class="pill-btn pill-btn--soft" data-fr="decline">Decline</button><button type="button" class="pill-btn pill-btn--ink" data-fr="accept">Accept</button>`, { sub: f.isNum(p.at) ? `@${p.username} · ${f.ago(p.at)}` : '' }))}</div></section>` : ''}
        <section><div class="bsec"><h2>Your friends</h2><span class="pp-bsec-n">${f.int(fr.length)}</span></div>
          ${fr.length ? html`<div class="group">${fr.map((p) => personRow(p, html`<button type="button" class="iconbtn iconbtn--s" data-fr-menu aria-label="Options for ${nameOf(p)}">${ic('more')}</button>`, { sub: f.isNum(p.since) ? `Friends since ${f.dayShort(f.instDay(p.since))}` : '' }))}</div>`
            : html`<div class="mod mod--12">${empty({ iconName: 'users', title: 'No friends yet', text: 'Friends see each other\'s workouts in the feed and share the boards. Add someone by their username, or pick from below.' })}</div>`}
        </section>
        ${out.length ? html`<section><div class="bsec"><h2>Waiting for an answer</h2></div>
          <div class="group">${out.map((p) => personRow(p, html`<button type="button" class="pill-btn pill-btn--soft" data-fr="remove">Cancel</button>`, { sub: f.isNum(p.at) ? `Asked ${f.ago(p.at)}` : '' }))}</div></section>` : ''}
        ${sug.length ? html`<section><div class="bsec"><h2>People you may know</h2></div>
          <div class="group">${sug.map((p) => personRow(p, html`<button type="button" class="pill-btn pill-btn--soft" data-fr="request">Add</button>`))}</div></section>` : ''}
        <p class="ranks__foot muted small">Friends see your workouts in their feed and you on their boards, as far as your privacy settings allow. Removing a friend tells nobody.</p>
      </div>`);
    window.scrollTo(0, y);
  }

  async function load() {
    d = await api.get('/api/friends');
    if (ctx.alive()) paint();
  }

  on(root, 'submit', '[data-add]', async (e, form) => {
    e.preventDefault();
    const name = form.username.value.trim().replace(/^@/, '');
    if (!name) return;
    const r = await friendAct('request', name, form.querySelector('[type="submit"]'));
    if (!r) return;
    toast(r.status === 'friends' ? `You and ${name} are friends now` : `Request sent to ${name}`);
    form.reset();
    load().catch(() => {});
  });
  on(root, 'click', '[data-fr]', async (e, b) => {
    const r = await friendAct(b.dataset.fr, b.closest('[data-user]')?.dataset.user, b);
    if (r) { if (b.dataset.fr === 'request') toast(r.status === 'friends' ? 'You are friends now' : 'Request sent'); load().catch(() => {}); }
  });
  on(root, 'click', '[data-fr-menu]', async (e, b) => {
    const row = b.closest('[data-user]');
    const name = row.querySelector('.row__t')?.textContent || row.dataset.user;
    if (await confirm({ title: `Remove ${name}?`, text: `${name} leaves your feed and your boards, and you leave theirs. Nobody is told.`, yes: 'Remove', danger: true })) {
      const r = await friendAct('remove', row.dataset.user, b);
      if (r) { toast(`${name} removed`); load().catch(() => {}); }
    }
  });
  ctx.onRefresh(() => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social')) load().catch(() => {}); }));
  mount(root, html`${head({ title: 'Friends', back: '/people' })}${skeleton('list')}`);
  try { await load(); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Friends', back: '/people' })}${errorState(err)}`); }
}

/* ── one post (/post/:id) ───────────────────────────────────── */

async function postPage(ctx) {
  const { root } = ctx;
  on(root, 'click', '[data-shared-rt]', (e, b) => lookSheet(b.dataset.sharedRt));
  document.title = 'Workout · Health';
  const id = ctx.params.id;
  let p = null;

  function paint({ keepInput = false } = {}) {
    const typed = keepInput ? root.querySelector('[data-cmt] [name="text"]')?.value || '' : '';
    const y = window.scrollY;
    const who = p.author || {};
    const cm = p.comments || [];
    const cheerers = p.cheerers || [];
    mount(root, html`${head({ title: who.me ? 'Your workout' : `${nameOf(who)}'s workout`, back: '/people' })}
      <div class="stack post-page">
        ${postCard(p, { full: true })}
        ${p.mine && (p.media?.length || 0) < MAX_PER_POST ? html`<div class="post-addm"><button type="button" class="pill-btn pill-btn--soft" data-add-media>${ic('camera', { size: 's' })}${p.media?.length ? 'Add more photos or videos' : 'Add photos or videos'}</button></div>` : ''}
        ${splitsCard(p, kindOf(p.type, p))}
        ${setsCard(p)}
        ${cheerers.length ? html`<section class="bt bt--plain post-cheers"><p class="post-cheers__t">${ic('cheer', { size: 's' })}Cheered by</p>
          <div class="post-cheers__l">${cheerers.map((x) => html`<a href="/u/${encodeURIComponent(x.username)}" class="post-cheers__p">${avatar(x)}<span>${x.me ? 'You' : nameOf(x)}</span></a>`)}</div></section>` : ''}
        <section class="cmts" id="comments" aria-label="Comments">
          <div class="bsec"><h2>Comments</h2>${cm.length ? html`<span class="pp-bsec-n">${f.int(cm.length)}</span>` : ''}</div>
          ${cm.length ? html`<ul class="cmts__l">${cm.map((c) => html`<li class="cmt" data-cmt-id="${c.id}">
            <a href="/u/${encodeURIComponent(c.author?.username || '')}">${avatar(c.author)}</a>
            <div class="cmt__b"><p class="cmt__h"><b>${c.author?.me ? 'You' : nameOf(c.author)}</b><small>${f.ago(c.at)}</small></p><p class="cmt__t">${c.text}</p></div>
            ${c.canDelete ? html`<button type="button" class="iconbtn iconbtn--s" data-cmt-del aria-label="Delete this comment">${ic('trash', { size: 's' })}</button>` : ''}
          </li>`)}</ul>` : html`<p class="muted small cmts__none">${who.me ? 'No comments yet.' : `Say something to ${nameOf(who)}.`}</p>`}
          <form class="cmt-form" data-cmt>
            <input class="input" name="text" maxlength="500" placeholder="${who.me ? 'Add a comment' : 'Nice one…'}" aria-label="Your comment" autocomplete="off" enterkeyhint="send">
            <button class="iconbtn cmt-form__send" type="submit" aria-label="Send">${ic('send', { size: 's' })}</button>
          </form>
        </section>
      </div>`);
    if (typed) root.querySelector('[data-cmt] [name="text"]').value = typed;
    window.scrollTo(0, y);
    sizeBars(root);
    drawRoutes(root, (pid) => (p.id === pid ? p : null), { full: true });
  }

  async function load() {
    p = await api.get(`/api/posts/${encodeURIComponent(id)}`);
    if (ctx.alive()) paint({ keepInput: true });
  }

  bindCheers(root, (pid) => (p && p.id === pid ? p : null));
  bindShare(root, (pid) => (p && p.id === pid ? p : null), () => paint({ keepInput: true }));
  on(root, 'click', '[data-post-menu]', () => postMenu(p, () => paint({ keepInput: true })));
  bindStrips(root, (pid) => (p && p.id === pid ? p : null));
  on(root, 'click', '[data-add-media]', () => addToPost(p, { onDone: () => mediaChanged(p, () => { if (ctx.alive()) paint({ keepInput: true }); }) }));
  on(root, 'submit', '[data-cmt]', async (e, form) => {
    e.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    await busy(form.querySelector('[type="submit"]'), async () => {
      try {
        const c = await api.post(`/api/posts/${encodeURIComponent(id)}/comments`, { text });
        p.comments = [...(p.comments || []), c];
        form.text.value = '';
        paint();
        root.querySelector(`[data-cmt-id="${CSS.escape(c.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (err) { toastError(err, 'That comment was not sent. Try again.'); }
    });
  });
  on(root, 'click', '[data-cmt-del]', async (e, b) => {
    const cid = b.closest('[data-cmt-id]')?.dataset.cmtId;
    if (!cid || !(await confirm({ title: 'Delete this comment?', text: 'It goes for everyone.', yes: 'Delete', danger: true }))) return;
    try { await api.del(`/api/posts/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}`); p.comments = p.comments.filter((c) => c.id !== cid); paint({ keepInput: true }); } catch (err) { toastError(err); }
  });
  ctx.onRefresh(() => load());
  mount(root, html`${head({ title: 'Workout', back: '/people' })}${skeleton('page')}`);
  try {
    await load();
    if (location.hash === '#comments') requestAnimationFrame(() => root.querySelector('#comments')?.scrollIntoView({ block: 'start' }));
  } catch (err) {
    if (!ctx.alive()) return;
    mount(root, html`${head({ title: 'Workout', back: '/people' })}${err?.status === 404
      ? html`<div class="mod mod--12">${empty({ iconName: 'eyeoff', title: 'This post is not here', text: 'It was removed, hidden, or it belongs to someone who is not your friend.', action: html`<a class="btn btn--tonal" href="/people">Back to the feed</a>` })}</div>`
      : errorState(err)}`);
  }
}

export default async function people(ctx) {
  if (ctx.name === 'friends') return friendsPage(ctx);
  if (ctx.name === 'post') return postPage(ctx);
  return main(ctx);
}

