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

import { api, qs } from '../api.js';
import { app, listen, go, refreshMe } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, empty, banner, on, seg, sheet, confirm, toast, toastError, busy } from '../ui.js';
import { setPager, haptic } from '../motion.js';
import { ib } from '../kit.js';
import * as f from '../format.js';
import { avatar, unitValue } from './shared.js';
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

/** One post. `full` is the post page: no link around it, the whole exercise list. */
function postCard(p, { full = false } = {}) {
  const k = kindOf(p.type, p);
  const nums = numbersOf(p, k);
  const who = p.author || {};
  const when = f.isNum(p.at) ? f.ago(p.at) : '';
  const title = p.title && p.title !== 'Workout' ? p.title : typeWords(p.type);
  const exs = Array.isArray(p.exercises) ? p.exercises : [];
  const exLine = exs.length ? exs.slice(0, full ? exs.length : 3).map((x) => `${x.name}${f.isNum(x.sets) ? ` ×${x.sets}` : ''}`).join(' · ') + (!full && exs.length > 3 ? ` · +${exs.length - 3}` : '') : '';
  const body = html`
    <h3 class="post__title">${title}</h3>
    ${p.caption ? html`<p class="post__cap">${p.caption}</p>` : ''}
    <div class="bt bt--${k.tile} post__tile">
      <div class="bt__row"><span class="bt__lab">${ic(k.icon)}${typeWords(p.type)}</span>${f.isNum(p.prs) && p.prs > 0 ? html`<span class="post__pr">${ic('record', { size: 's' })}${f.plural(p.prs, 'record')}</span>` : html`<span class="bt__meta">${f.isNum(p.start) ? f.clock(p.start) : ''}</span>`}</div>
      ${nums.length ? html`<div class="post__nums">${nums.map(([v, u, l]) => html`<div><p class="n n-s">${v}${u ? html`<span class="u">${u}</span>` : ''}</p><p class="post__k">${l}</p></div>`)}</div>` : ''}
      ${exLine ? html`<p class="post__ex">${exLine}</p>` : ''}
    </div>`;
  const cw = cheerWords(p);
  return html`<article class="post ${p.hidden ? 'is-hidden' : ''}" data-post="${p.id}">
    <header class="post__head">
      <a class="post__who" href="/u/${encodeURIComponent(who.username || '')}">${avatar(who)}<span><b>${who.me ? 'You' : nameOf(who)}</b><small>${when}${p.hidden ? ' · hidden from the feed' : ''}</small></span></a>
      ${p.mine ? html`<button type="button" class="iconbtn iconbtn--s" data-post-menu aria-label="Post options">${ic('more')}</button>` : ''}
    </header>
    ${full ? html`<div class="post__body">${body}</div>` : html`<a class="post__body" href="/post/${encodeURIComponent(p.id)}">${body}</a>`}
    <footer class="post__foot">
      <button type="button" class="post__act ${p.cheered ? 'is-on' : ''}" data-cheer aria-pressed="${String(!!p.cheered)}" aria-label="${p.cheered ? 'Take back your cheer' : 'Cheer'}">${ic('cheer', { size: 's' })}<span class="n" data-cheers>${p.cheers || ''}</span></button>
      ${full ? '' : html`<a class="post__act" href="/post/${encodeURIComponent(p.id)}#comments" aria-label="${f.plural(p.comments || 0, 'comment')}">${ic('comment', { size: 's' })}<span class="n">${p.comments || ''}</span></a>`}
      <span class="post__who-cheered" data-cheer-words>${cw}</span>
    </footer>
  </article>`;
}

/** Posts with a quiet label above each day. */
function feedList(posts, { lastDay = '' } = {}) {
  let day = lastDay;
  const out = [];
  for (const p of posts) {
    const d = f.instDay(p.at);
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

/** Your own post: change its caption, hide it from the feed or show it again. */
async function postMenu(p, done) {
  const s = sheet({
    title: 'Your post',
    body: html`<form class="stack post-edit" data-form>
      <label class="field"><span class="field__label">Caption</span>
        <textarea class="textarea" name="caption" maxlength="280" rows="3" placeholder="How did it go?">${p.caption || ''}</textarea>
        <span class="field__hint">Your friends see it above the numbers.</span></label>
      <div class="st-cta"><button class="btn" type="submit">Save</button>
        <button class="btn btn--tonal" type="button" data-hide>${p.hidden ? 'Show in the feed' : 'Hide from the feed'}</button></div>
    </form>`,
  });
  const form = s.el.querySelector('[data-form]');
  const save = async (patch, btn) => busy(btn, async () => {
    try { const r = await api.patch(`/api/posts/${encodeURIComponent(p.id)}`, patch); Object.assign(p, r); s.close(); done(p); } catch (err) { toastError(err); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = form.caption.value.trim(); save({ caption: v || null }, form.querySelector('[type="submit"]')); });
  s.el.querySelector('[data-hide]').addEventListener('click', (e) => save({ hidden: !p.hidden }, e.currentTarget));
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

  function chrome(pane) {
    const n = requests();
    return html`
      ${head({ kick: kick(), title: 'People', actions: html`
        <a class="pp-ib" href="/people/friends" aria-label="Friends${n ? `, ${n} waiting` : ''}">${ic('users')}${n ? html`<span class="pp-badge n">${n}</span>` : ''}</a>
        <a class="pp-ib" href="/compare" aria-label="Compare with a friend">${ic('compare')}</a>` })}
      <div class="pp-mode">${seg('pmode', [['feed', 'Feed'], ['boards', 'Boards']], mode, { fit: true, label: 'Show' })}</div>
      <div class="pp-pane" data-pane>${pane}</div>`;
  }

  function url() {
    const u = mode === 'feed' ? '/people' : `/ranks${qs({ metric: metric === 'steps' ? '' : metric, period: period === 'week' ? '' : period })}`;
    history.replaceState(history.state, '', u);
  }

  /* the boards */

  function pickButton() {
    const m = METRIC[metric];
    const i = METRICS.indexOf(metric);
    const group = BOARD_GROUPS.find(([, ids]) => ids.includes(metric))?.[0] || '';
    return html`<button type="button" class="pp-pick fam fam-${m.fam}" data-pick aria-haspopup="dialog" aria-label="Board: ${m.label}. Choose another">
      ${ib(m.icon, { fam: m.fam })}
      <span class="pp-pick__t"><b>${m.label}</b><small>${group}${scope === 'everyone' ? ' · everyone' : ''}</small></span>
      <span class="pp-dots" aria-hidden="true">${METRICS.map((_, j) => html`<i class="${j === i ? 'is-on' : ''}"></i>`)}</span>
      ${ic('chev_d', { size: 's' })}
    </button>`;
  }

  function boardPane() {
    if (!board) return html`${pickButton()}<div class="bt bt--plain pp-pod skel" aria-busy="true" aria-label="Loading"></div><div class="pp-skl">${skeleton('list')}</div>`;
    const d = board;
    const me = d.me || {};
    const meta = METRIC[d.metric] || METRIC.steps;
    const tile = TILE[meta.fam] || 'steps';
    const mine = d.entries.find((e) => e.me);
    const priv = /private/i.test(me.reason || '');
    const span = period === 'today' ? 'day' : period === 'week' ? 'week (from Monday)' : period === 'month' ? 'month' : 'total';
    const notice = me.listed === false && me.reason ? banner({
      iconName: priv ? 'lock' : 'info',
      title: priv ? 'You are not on this board' : 'You are not on this board yet',
      text: priv ? `${me.reason}, so others cannot see you here. You can change that in privacy settings.` : `${me.reason}.`,
      actions: priv ? html`<a class="btn btn--tonal btn--s" href="/settings/privacy">Privacy settings</a>` : '',
    }) : '';
    const explain = d.metric === 'sleep_consistency' ? 'Sleep consistency is a score out of 100 for how regular bedtime and wake time are. It needs three nights in the period. '
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
    return html`${pickButton()}<div class="pp">${body}</div>
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
    return html`${requestStrip()}<div class="feed" data-feed>${list.content}</div>
      ${next ? html`<div class="feed__more" data-more><span class="spin" aria-hidden="true"></span></div>` : html`<p class="feed__end muted small">That is everything from the last few weeks.</p>`}`;
  }

  /* painting */

  function paint() {
    const y = window.scrollY;
    mount(root, chrome(mode === 'feed' ? feedPane() : boardPane()));
    window.scrollTo(0, y);
    const pane = root.querySelector('[data-pane]');
    if (slideFrom) { pane.classList.add(`pp--in-${slideFrom}`); slideFrom = ''; }
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
  }

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
    loadBoard();
  }

  async function boardsSheet() {
    const s = sheet({ title: 'Boards', body: html`<div class="bd-sheet" data-bds>${skeleton('list')}</div>` });
    s.el.classList.add('sheet--bd');
    const slot = s.el.querySelector('[data-bds]');
    const paintSheet = (sum) => {
      const by = Object.fromEntries((sum?.boards || []).map((b) => [b.metric, b]));
      mount(slot, html`
        <div class="bd-scope">${seg('bscope', [['friends', 'Friends'], ['everyone', 'Everyone']], scope, { fit: true, label: 'Who is on the boards' })}</div>
        ${BOARD_GROUPS.map(([name, ids]) => html`<p class="lg-lab">${name}</p><div class="bd-grid">${ids.map((id) => {
          const m = METRIC[id]; const b = by[id];
          const place = b?.me?.listed && f.isNum(b.me.rank) ? `You: ${ordinal(b.me.rank)} of ${f.int(b.total)}`
            : b?.leader ? `${b.leader.me ? 'You lead' : `${nameOf(b.leader)} leads`}` : b ? 'Nobody yet' : '';
          return html`<button type="button" class="lg-mini press bd-tile fam fam-${m.fam} ${id === metric ? 'is-on' : ''}" data-board="${id}" aria-pressed="${String(id === metric)}">
            <span class="lg-mini__ic">${ic(m.icon)}</span><span class="lg-mini__t">${m.label}</span><span class="lg-mini__s">${place || html`&nbsp;`}</span></button>`;
        })}</div>`)}`);
    };
    paintSheet(null);
    const read = async () => { try { paintSheet(await api.get(`/api/boards${qs({ period, scope })}`)); } catch { paintSheet({ boards: [] }); } };
    read();
    on(slot, 'click', '[data-board]', (e, b) => { s.close(); pick(b.dataset.board); });
    on(slot, 'click', '[data-seg="bscope"]', (e, b) => {
      if (b.dataset.value === scope) return;
      scope = b.dataset.value; store.set(KEY.scope, scope);
      for (const o of slot.querySelectorAll('[data-seg="bscope"]')) o.setAttribute('aria-pressed', String(o === b));
      read();
      if (mode === 'boards') loadBoard();
    });
  }

  /* the strip, for a swipe: the feed, then every board */
  const strip = ['feed', ...METRICS];
  const at = () => (mode === 'feed' ? 0 : 1 + METRICS.indexOf(metric));
  ctx.onLeave(setPager({
    area: '.view',
    el: () => root.querySelector('[data-pane]'),
    has: (dir) => (dir === 'next' ? at() < strip.length - 1 : at() > 0),
    go: (dir) => {
      const el = root.querySelector('[data-pane]');
      const to = strip[at() + (dir === 'next' ? 1 : -1)];
      if (el) { el.style.transition = 'transform 200ms var(--ease), opacity 200ms'; el.style.transform = `translateX(${dir === 'next' ? -40 : 40}%)`; el.style.opacity = '0'; }
      const from = dir === 'next' ? 'r' : 'l';
      if (to === 'feed') setMode('feed', from); else pick(to, from);
      for (const o of root.querySelectorAll('[data-seg="pmode"]')) o.setAttribute('aria-pressed', String(o.dataset.value === mode));
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
  bindCheers(root, (id) => posts.find((p) => p.id === id));
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
  }

  async function load() {
    p = await api.get(`/api/posts/${encodeURIComponent(id)}`);
    if (ctx.alive()) paint({ keepInput: true });
  }

  bindCheers(root, (pid) => (p && p.id === pid ? p : null));
  on(root, 'click', '[data-post-menu]', () => postMenu(p, () => paint({ keepInput: true })));
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

