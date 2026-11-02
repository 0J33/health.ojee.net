/* Circles (server/circles.js, docs/CIRCLES.md): groups of people with
   their own boards and a hall of fame.

     /circles            yours, invitations, requests you made, finding one, starting one
     /circles/:id        one circle: its members, who asked to join, the owner's settings
     /circles/:id/hall   the hall of fame: each week's first three on every board, and a medal table
     /circles/:id/goals  this week's and this month's goal, and every one before (challenges.js)
     /circles/:id/events the events on and over; /circles/:id/events/:eid one of them

   Somebody outside a circle sees its name, its line and how many are in
   it, never who. Being in one is choosing to be seen by its members. */

import { api, qs } from '../api.js';
import { app, listen, go, refreshMe } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, empty, on, sheet, confirm, toast, toastError, busy, field, fieldError, errText } from '../ui.js';
import { stGrp, stRow, stNote, stPick } from '../apps.js';
import * as f from '../format.js';
import { avatar, unitText } from './shared.js';
import { METRIC, nameOf } from './ranks.js';
import { medal, medalTally } from '../medals.js';
import { goalCard, goalPeople, eventCard, startEventSheet, rankBadge, rankSheet, timeLeft, modeWord, TIER_WORD } from '../challenges.js';

const ACCENTS = ['#2E7D5B', '#3E6FB4', '#B4543E', '#7A5BC9', '#C98A2E', '#2E8C9A', '#B43E7A', '#5E6B2E'];
const JOIN = [
  ['request', 'Anyone can ask', 'Listed under Find a circle. You say yes or no to each request.'],
  ['invite', 'Invitation only', 'Not listed. You invite your friends.'],
];
const joinWord = (v) => JOIN.find(([k]) => k === v)?.[1] || '';
const DOT = (accent) => html`<span class="cc-dot" data-style="--cc:${accent || ACCENTS[0]}" aria-hidden="true">${ic('groups', { size: 's' })}</span>`;
const people = (n) => f.plural(n || 0, 'person', 'people');

/** A sheet with one form; `save(form)` returns true to close it. */
function formSheet({ title, body, yes = 'Save', save }) {
  const id = `cf${Date.now().toString(36)}`;
  const s = sheet({
    title,
    body: html`<form class="form st-sheet" id="${id}" novalidate>${body}</form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="${id}">${yes}</button>`,
  });
  const form = s.el.querySelector('form');
  // Who can join: two choices side by side, with what the chosen one means under them.
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-join]');
    if (!b) return;
    form.elements.join.value = b.dataset.join;
    for (const o of form.querySelectorAll('[data-join]')) { const on1 = o === b; o.setAttribute('aria-pressed', String(on1)); o.setAttribute('aria-checked', String(on1)); }
    form.querySelector('[data-join-hint]').textContent = JOIN.find(([v]) => v === b.dataset.join)[2];
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await busy(s.el.querySelector('button[type="submit"]'), () => save(form));
    if (ok) s.close(true);
  });
  return s;
}

/** Name, about, colour and how people get in: for a new circle, or the owner's edit. */
function circleForm(c = {}) {
  const accent = c.accent || ACCENTS[Math.floor(Math.random() * ACCENTS.length)];
  return html`${field({ label: 'Name', name: 'name', value: c.name || '', attrs: 'required minlength="2" maxlength="40" autocomplete="off" autofocus', hint: '2 to 40 characters.' })}
    ${field({ label: 'What it is about', name: 'about', value: c.about || '', attrs: 'maxlength="160" autocomplete="off"', hint: 'One line, if you like. Anyone who finds it can read it.' })}
    <fieldset class="field cc-sw"><legend class="field__label">Colour</legend><div class="cc-sw__row">${ACCENTS.map((a) => html`<label class="cc-sw__o" data-style="--cc:${a}"><input type="radio" name="accent" value="${a}" ${a === accent ? 'checked' : ''} aria-label="Colour ${a}"><span></span></label>`)}</div></fieldset>
    <div class="field cc-join"><span class="field__label" id="cc-join-l">Who can join</span>
      <div class="seg seg--fit" role="radiogroup" aria-labelledby="cc-join-l">${JOIN.map(([v, t]) => html`<button type="button" class="seg__opt" role="radio" data-join="${v}" aria-checked="${String((c.join || 'request') === v)}" aria-pressed="${String((c.join || 'request') === v)}">${t}</button>`)}</div>
      <input type="hidden" name="join" value="${c.join || 'request'}">
      <p class="field__hint" data-join-hint>${JOIN.find(([v]) => v === (c.join || 'request'))[2]}</p>
    </div>`;
}
const formBody = (form) => ({ name: form.elements.name.value.trim(), about: form.elements.about.value.trim(), accent: form.elements.accent.value, join: form.elements.join.value });

/* ── /circles ─────────────────────────────────────────────── */

function card(c, end = '') {
  const sub = [people(c.members), c.role === 'owner' ? 'You run it' : '', c.join === 'invite' && c.role ? 'Invitation only' : ''].filter(Boolean).join(' · ');
  return html`<div class="row cc-row" data-circle="${c.id}">
    <a class="cc-row__who" href="/circles/${c.id}">${DOT(c.accent)}<span class="row__body"><span class="row__t">${c.name}${c.waiting ? html`<span class="pp-badge n cc-wait">${c.waiting}</span>` : ''}</span><span class="row__d">${c.about || sub}</span>${c.about ? html`<span class="row__d">${sub}</span>` : ''}</span></a>
    ${end ? html`<span class="fr-row__end">${end}</span>` : ''}
  </div>`;
}

async function listPage(ctx) {
  const { root } = ctx;
  document.title = 'Circles · Health';
  let d = null; let found = null; let q = '';

  function paint() {
    // Drawn again in place: keep where the page was. The first time, the screen's own scroll stands.
    const y = root.querySelector('.cc') ? window.scrollY : null;
    mount(root, html`${head({ title: 'Circles', back: '/people', actions: html`<button type="button" class="btn btn--s" data-new>${ic('plus', { size: 's' })}Start one</button>` })}
      <div class="stack fr cc">
        ${d.invites.length ? html`<section><div class="bsec"><h2>Invitations</h2><span class="pp-bsec-n">${f.int(d.invites.length)}</span></div>
          <div class="group">${d.invites.map((c) => card({ ...c, about: c.by ? `${nameOf(c.by)} invited you` : c.about }, html`<button type="button" class="pill-btn pill-btn--soft" data-act="leave">Decline</button><button type="button" class="pill-btn pill-btn--ink" data-act="join">Join</button>`))}</div></section>` : ''}
        <section><div class="bsec"><h2>Your circles</h2><span class="pp-bsec-n">${f.int(d.circles.length)}</span></div>
          ${d.circles.length ? html`<div class="group">${d.circles.map((c) => card(c, html`<a class="pill-btn pill-btn--soft" href="/ranks?scope=circle:${c.id}">Boards</a>`))}</div>`
            : html`<div class="mod mod--12">${empty({ iconName: 'groups', title: 'No circles yet', text: 'A circle is a group with its own boards, and every week\'s winners kept in a hall of fame. Start one for your friends, or find one below.' })}</div>`}
        </section>
        ${d.requests.length ? html`<section><div class="bsec"><h2>Waiting for an answer</h2></div>
          <div class="group">${d.requests.map((c) => card({ ...c, about: `Asked ${f.ago(c.at)}` }, html`<button type="button" class="pill-btn pill-btn--soft" data-act="leave">Cancel</button>`))}</div></section>` : ''}
        <section><div class="bsec"><h2>Find a circle</h2></div>
          <form class="fr-add" data-find>
            <label class="log__find">${ic('search', { size: 's' })}<input class="input" name="q" value="${q}" placeholder="Search by name" aria-label="Search circles" autocomplete="off" enterkeyhint="search"></label>
            <button class="btn btn--tonal" type="submit">Search</button>
          </form>
          <div data-found>${foundList()}</div>
        </section>
        <p class="ranks__foot muted small">In a circle, its members see you on its boards and your profile, for what you share with friends and circles (Settings, Privacy). Outside it, people see only its name, its line and how many are in it.</p>
      </div>`);
    if (y !== null) window.scrollTo(0, y);
  }
  function foundList() {
    if (!found) return '';
    if (!found.length) return html`<p class="fr-find__hint muted small">${q ? `No circle anyone can ask to join has "${q}" in its name.` : 'No circles to join yet. Start the first.'}</p>`;
    return html`<div class="group">${found.map((c) => card(c, c.status === 'pending' ? html`<span class="muted small">Asked</span>`
      : c.status === 'invited' ? html`<button type="button" class="pill-btn pill-btn--ink" data-act="join">Join</button>`
        : html`<button type="button" class="pill-btn pill-btn--ink" data-act="join">Ask to join</button>`))}</div>`;
  }
  async function load() {
    const [mine, br] = await Promise.all([api.get('/api/circles'), api.get(`/api/circles/browse${qs({ q })}`)]);
    d = mine; found = br.circles;
    if (ctx.alive()) paint();
  }
  on(root, 'submit', '[data-find]', async (e, form) => {
    e.preventDefault();
    q = form.q.value.trim();
    try { found = (await busy(form.querySelector('[type="submit"]'), () => api.get(`/api/circles/browse${qs({ q })}`))).circles; } catch (err) { toastError(err); return; }
    mount(root.querySelector('[data-found]'), foundList());
  });
  on(root, 'click', '[data-act]', async (e, b) => {
    const id = b.closest('[data-circle]')?.dataset.circle;
    try {
      const r = await busy(b, () => api.post(`/api/circles/${id}/${b.dataset.act}`, {}));
      if (b.dataset.act === 'join') toast(r.status === 'member' ? 'You are in' : 'Asked: the owner decides');
      refreshMe().catch(() => {});
      await load();
    } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-new]', () => {
    formSheet({
      title: 'Start a circle',
      yes: 'Start it',
      body: circleForm(),
      save: async (form) => {
        fieldError(form, 'name', '');
        const b = formBody(form);
        if (b.name.length < 2) { fieldError(form, 'name', 'A name needs 2 to 40 characters.'); return false; }
        try {
          const c = await api.post('/api/circles', b);
          refreshMe().catch(() => {});
          toast(`${c.name} started`);
          setTimeout(() => go(`/circles/${c.id}`), 150);
          return true;
        } catch (err) { fieldError(form, 'name', errText(err)); return false; }
      },
    });
  });
  ctx.onRefresh(() => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social')) load().catch(() => {}); }));
  mount(root, html`${head({ title: 'Circles', back: '/people' })}${skeleton('list')}`);
  try { await load(); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Circles', back: '/people' })}${errorState(err)}`); }
}

/* ── /circles/:id ─────────────────────────────────────────── */

function memberRow(p, end = '') {
  const sub = [p.owner ? 'Runs it' : '', !p.me && p.friend ? 'Friend' : '', f.isNum(p.since) ? `In since ${f.dayShort(f.instDay(p.since))}` : ''].filter(Boolean).join(' · ');
  return html`<div class="row fr-row" data-user="${p.username}">
    <a class="fr-row__who" href="/u/${encodeURIComponent(p.username)}">${avatar(p)}<span class="row__body"><span class="row__t">${p.me ? 'You' : nameOf(p)}</span><span class="row__d">${sub || `@${p.username}`}</span></span></a>
    ${end ? html`<span class="fr-row__end">${end}</span>` : ''}
  </div>`;
}

/** What the circle has won: trophies from its goals, events finished together, and the weekly medals given. */
function cabinetStrip(c) {
  const t = c.cabinet.trophies;
  const trophies = Object.values(t).reduce((a, b) => a + b, 0) + c.cabinet.events;
  const m = c.cabinet.medals;
  return html`<a class="cc-cab press" href="/circles/${c.id}/hall">
    <span class="cc-cab__i"><span class="cc-cab__n n">${f.int(trophies)}</span><span class="cc-cab__l">${trophies === 1 ? 'trophy' : 'trophies'}</span></span>
    <span class="cc-cab__i"><span class="cc-cab__n n">${f.int(m.total)}</span><span class="cc-cab__l">medals given</span></span>
    <span class="cc-cab__tal">${medalTally(m)}</span>${ic('chev_r', { size: 's' })}
  </a>`;
}

/** The circle's members by rank (rating.js): badge, rank and rating, last week's move. */
function ranksSection(c) {
  const face = new Map(c.memberList.map((p) => [p.username, p]));
  const rows = c.ranks.map((r) => ({ ...r, p: face.get(r.username) })).filter((r) => r.p);
  const placed = rows.filter((r) => r.placed);
  const sign = (v) => (v > 0 ? `+${f.int(v)}` : v < 0 ? `−${f.int(-v)}` : '±0');
  return html`<section><div class="bsec"><h2>Ranks</h2><button type="button" class="link" data-rank-how>How it works${ic('info', { size: 's' })}</button></div>
    <div class="group">${rows.map((r, i) => html`<a class="row fr-row cc-rank ${r.p.me ? 'is-me' : ''}" href="/u/${encodeURIComponent(r.username)}">
      <span class="hf-tally__pos n">${r.placed ? placed.indexOf(r) + 1 : f.DASH}</span>${rankBadge(r.rank, { size: 's' })}
      <span class="row__body"><span class="row__t">${r.p.me ? 'You' : nameOf(r.p)}</span><span class="row__d">${r.placed ? r.rank.name : `Placing: ${f.plural(r.weeksToPlace, 'more week')}`}</span></span>
      ${r.placed ? html`<span class="cc-rank__v"><b class="n">${f.int(r.rating)}</b>${r.delta !== null ? html`<small class="rkc__d ${r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}">${sign(r.delta)}</small>` : ''}</span>` : ''}
    </a>`)}</div></section>`;
}

async function onePage(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  let c = null;

  function paint() {
    document.title = `${c.name} · Health`;
    const owner = c.role === 'owner';
    const inIt = c.status === 'member';
    // Drawn again in place: keep where the page was. The first time, the screen's own scroll stands.
    const y = root.querySelector('.cc') ? window.scrollY : null;
    const actions = owner ? html`<button type="button" class="iconbtn" data-edit aria-label="Change the circle">${ic('edit')}</button>` : '';
    mount(root, html`${head({ title: c.name, back: '/circles', actions })}
      <div class="stack fr cc">
        <section class="bt bt--plain cc-hero" data-style="--cc:${c.accent}">
          <div class="cc-hero__top">${DOT(c.accent)}<div><p class="cc-hero__n">${people(c.members)}</p><p class="cc-hero__s">${joinWord(c.join)}${c.owner && inIt ? ` · run by ${c.owner.username === app.me.user?.username ? 'you' : nameOf(c.owner)}` : ''}</p></div></div>
          ${c.about ? html`<p class="cc-hero__about">${c.about}</p>` : ''}
          ${inIt && c.cabinet ? cabinetStrip(c) : ''}
          ${inIt ? html`<div class="btnrow"><a class="btn btn--s" href="/ranks?scope=circle:${c.id}">${ic('leaderboard', { size: 's' })}Boards</a><a class="btn btn--tonal btn--s" href="/circles/${c.id}/hall">${ic('medal', { size: 's' })}Hall of fame</a></div>`
            : c.status === 'pending' ? html`<div class="btnrow"><span class="muted small">You asked to join. The owner decides.</span><button type="button" class="btn btn--tonal btn--s" data-leave>Take it back</button></div>`
              : c.status === 'invited' ? html`<div class="btnrow"><button type="button" class="btn btn--s" data-join>${ic('check', { size: 's' })}Join</button><button type="button" class="btn btn--tonal btn--s" data-leave>Decline</button></div>`
                : html`<div class="btnrow"><button type="button" class="btn btn--s" data-join>${ic('plus', { size: 's' })}Ask to join</button></div>`}
        </section>
        ${inIt && c.goals ? html`<section><div class="bsec"><h2>Goals</h2><a class="link" href="/circles/${c.id}/goals">Every goal${ic('chev_r', { size: 's' })}</a></div>
          <div class="gl-list">${c.goals.map((g) => goalCard(g, { href: `/circles/${c.id}/goals` }))}</div></section>` : ''}
        ${inIt && c.events ? html`<section><div class="bsec"><h2>Events</h2><a class="link" href="/circles/${c.id}/events">${c.pastEvents ? 'All events' : 'About events'}${ic('chev_r', { size: 's' })}</a></div>
          ${c.events.length ? html`<div class="gl-list">${c.events.map((e) => eventCard(e))}</div>` : html`<p class="cc-empty">No event on. Start a marathon, a hybrid race or a triathlon: as a race, or all of you together.</p>`}
          ${c.events.length < 3 ? html`<button type="button" class="btn btn--tonal btn--block cc-start" data-start-event>${ic('flag', { size: 's' })}Start an event</button>` : ''}</section>` : ''}
        ${inIt && c.ranks?.length ? ranksSection(c) : ''}
        ${owner && c.pending?.length ? html`<section><div class="bsec"><h2>Asking to join</h2><span class="pp-bsec-n">${f.int(c.pending.length)}</span></div>
          <div class="group">${c.pending.map((p) => memberRow({ ...p, since: null }, html`<button type="button" class="pill-btn pill-btn--soft" data-m="decline">Decline</button><button type="button" class="pill-btn pill-btn--ink" data-m="accept">Let in</button>`))}</div></section>` : ''}
        ${inIt ? html`<section><div class="bsec"><h2>Who is in it</h2>${owner ? html`<button type="button" class="link" data-invite>${ic('user_plus', { size: 's' })}Invite friends</button>` : html`<span class="pp-bsec-n">${f.int(c.memberList.length)}</span>`}</div>
          <div class="group">${c.memberList.map((p) => memberRow(p, owner && !p.me ? html`<button type="button" class="iconbtn iconbtn--s" data-m-menu aria-label="Options for ${nameOf(p)}">${ic('more')}</button>` : ''))}</div></section>` : ''}
        ${owner && c.invited?.length ? html`<section><div class="bsec"><h2>Invited</h2></div>
          <div class="group">${c.invited.map((p) => memberRow({ ...p, since: null }, html`<button type="button" class="pill-btn pill-btn--soft" data-m="decline">Take back</button>`))}</div></section>` : ''}
        ${inIt ? stGrp(owner
          ? stRow({ btn: true, attrs: 'data-delete', icon: 'trash', title: 'Delete the circle', sub: 'Its boards and hall of fame go too. To leave it instead, hand it to someone first (the menu by their name).', danger: true, chev: false })
          : stRow({ btn: true, attrs: 'data-leave', icon: 'logout', title: 'Leave the circle', sub: 'Its members stop seeing you on its boards. Your wins stay in its hall of fame.', danger: true, chev: false })) : ''}
        <p class="ranks__foot muted small">${inIt ? 'Members see each other on the circle\'s boards and profiles, for what each shares with friends and circles. Somebody who keeps a kind for friends only is seen there only by their friends.' : 'Only members see who is in a circle.'}</p>
      </div>`);
    if (y !== null) window.scrollTo(0, y);
  }
  async function load() {
    c = await api.get(`/api/circles/${encodeURIComponent(id)}`);
    if (ctx.alive()) paint();
  }
  const act = async (b, fn, okText) => {
    try { const r = await busy(b, fn); if (okText) toast(okText); refreshMe().catch(() => {}); if (r?.circle) { c = { ...c, ...r.circle }; paint(); } else await load(); return r; } catch (err) { toastError(err); return null; }
  };
  on(root, 'click', '[data-rank-how]', async () => {
    try { const me = await api.get(`/api/users/${encodeURIComponent(app.me.user.username)}`); if (me.rank) rankSheet(me.rank, { me: true }); else toast('Your activity is kept to yourself, so you have no rank.'); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-start-event]', async () => {
    let kinds;
    try { kinds = (await api.get(`/api/circles/${id}/events`)).kinds; } catch (err) { toastError(err); return; }
    const made = await startEventSheet(id, kinds);
    if (made) go(`/circles/${id}/events/${made.id}`);
  });
  on(root, 'click', '[data-join]', (e, b) => act(b, () => api.post(`/api/circles/${id}/join`, {}), c.status === 'invited' ? 'You are in' : 'Asked: the owner decides'));
  on(root, 'click', '[data-leave]', async (e, b) => {
    if (c.status === 'member' && !(await confirm({ title: `Leave ${c.name}?`, text: 'You can ask to join again later.', yes: 'Leave', danger: true }))) return;
    try { await busy(b, () => api.post(`/api/circles/${id}/leave`, {})); refreshMe().catch(() => {}); toast(c.status === 'member' ? 'You left' : 'Done'); go('/circles', { replace: true }); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-m]', (e, b) => {
    const u = b.closest('[data-user]').dataset.user;
    act(b, () => api.post(`/api/circles/${id}/members/${encodeURIComponent(u)}/${b.dataset.m}`, {}), b.dataset.m === 'accept' ? 'Let in' : '');
  });
  on(root, 'click', '[data-m-menu]', async (e, b) => {
    const u = b.closest('[data-user]').dataset.user;
    const p = c.memberList.find((x) => x.username === u);
    const v = await stPick({ title: nameOf(p), options: [['owner', 'Hand the circle to them', 'They run it from now on; you stay in it'], ['remove', 'Take them out', 'They can ask to join again']], current: '' });
    if (v === 'owner' && await confirm({ title: `Hand ${c.name} to ${nameOf(p)}?`, text: 'They can then change it, let people in and take people out. You stay in it.', yes: 'Hand it over' })) act(b, () => api.patch(`/api/circles/${id}`, { owner: u }), `${nameOf(p)} runs it now`);
    if (v === 'remove' && await confirm({ title: `Take ${nameOf(p)} out?`, text: 'Nobody is told. Their wins stay in the hall of fame.', yes: 'Take out', danger: true })) act(b, () => api.del(`/api/circles/${id}/members/${encodeURIComponent(u)}`), 'Taken out');
  });
  on(root, 'click', '[data-invite]', async () => {
    let fr;
    try { fr = (await api.get('/api/friends')).friends; } catch (err) { toastError(err); return; }
    const inIt = new Set([...(c.memberList || []), ...(c.invited || []), ...(c.pending || [])].map((p) => p.username));
    const left = fr.filter((p) => !inIt.has(p.username));
    const s = sheet({
      title: 'Invite friends',
      body: html`<div class="st-sheet">${left.length ? html`<div class="group">${left.map((p) => memberRow({ ...p, since: null, friend: true }, html`<button type="button" class="pill-btn pill-btn--ink" data-inv>Invite</button>`))}</div>`
        : html`<p class="st-lead">${fr.length ? 'All your friends are in it or invited.' : 'You can invite your friends. Add friends first, on People, Friends.'}</p>`}
        ${stNote('Anyone else can find the circle and ask to join, unless it is invitation only.')}</div>`,
    });
    on(s.el, 'click', '[data-inv]', async (ev, btn) => {
      const u = btn.closest('[data-user]').dataset.user;
      try { const r = await busy(btn, () => api.post(`/api/circles/${id}/invite`, { username: u })); btn.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: r.status === 'member' ? 'In' : 'Invited' })); c = r.circle; paint(); } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-edit]', () => {
    formSheet({
      title: 'Change the circle',
      body: circleForm(c),
      save: async (form) => {
        fieldError(form, 'name', '');
        try { c = { ...c, ...(await api.patch(`/api/circles/${id}`, formBody(form))) }; refreshMe().catch(() => {}); toast('Saved'); paint(); return true; } catch (err) { fieldError(form, 'name', errText(err)); return false; }
      },
    });
  });
  on(root, 'click', '[data-delete]', async (e, b) => {
    if (!(await confirm({ title: `Delete ${c.name}?`, text: 'Everyone in it leaves it, and its boards and hall of fame are gone for good.', yes: 'Delete', danger: true }))) return;
    try { await busy(b, () => api.del(`/api/circles/${id}`)); refreshMe().catch(() => {}); toast('Deleted'); go('/circles', { replace: true }); } catch (err) { toastError(err); }
  });
  ctx.onRefresh(() => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social')) load().catch(() => {}); }));
  mount(root, html`${head({ title: 'Circle', back: '/circles' })}${skeleton('list')}`);
  try { await load(); } catch (err) {
    if (!ctx.alive()) return;
    mount(root, html`${head({ title: 'Circle', back: '/circles' })}${err.status === 404 ? html`<div class="mod mod--12">${empty({ iconName: 'groups', title: 'This circle is not here', text: 'It was deleted, or it is invitation only and you are not in it.', action: html`<a class="btn btn--tonal" href="/circles">Your circles</a>` })}</div>` : errorState(err)}`);
  }
}

/* ── /circles/:id/hall ────────────────────────────────────── */

const TIER_NAME = { gold: 'First', silver: 'Second', bronze: 'Third' };
const whoText = (people) => { const who = people.map((p) => (p.me ? 'You' : nameOf(p))); return who.length > 2 ? `${who.slice(0, 2).join(', ')} +${who.length - 2}` : who.join(' and '); };

/** One board's week: the board, then first, second and third, each with its medal, who and how much. */
function winnerTile(w) {
  const m = METRIC[w.metric] || { icon: 'medal', fam: 'steps', label: w.label };
  const podium = w.podium?.length ? w.podium : [{ place: 1, tier: 'gold', value: w.value, people: w.people }];
  return html`<div class="hf-tile fam fam-${m.fam}">
    <div class="hf-tile__h"><span class="hf-tile__ic">${ic(m.icon)}</span><span class="hf-tile__t">${w.label}</span></div>
    <ol class="hf-pod">${podium.map((pl) => html`<li class="hf-pod__r ${pl.people.some((p) => p.me) ? 'is-me' : ''}">
      ${medal(pl.tier, m.icon, { size: 's', label: `${TIER_NAME[pl.tier]} place` })}
      <span class="hf-pod__who">${pl.people.slice(0, 3).map((p) => avatar(p))}<b>${whoText(pl.people)}</b></span>
      <span class="hf-pod__v n">${unitText(pl.value, w.unit)}</span></li>`)}</ol>
  </div>`;
}

/** A person's medals in the circle: gold, silver and bronze, and the boards they came from. */
function tallyRow(t, i) {
  const boards = (t.boards || []).slice(0, 4).map((b) => {
    const parts = ['gold', 'silver', 'bronze'].filter((k) => b[k]).map((k) => `${b[k]} ${k}`);
    return `${b.label}: ${parts.join(', ') || `${b.wins} gold`}`;
  });
  return html`<a class="row fr-row hf-tally" href="/u/${encodeURIComponent(t.username)}">
    <span class="hf-tally__pos n">${i + 1}</span>${avatar(t)}
    <span class="row__body"><span class="row__t">${t.me ? 'You' : nameOf(t)}</span><span class="row__d">${boards.join(' · ')}</span></span>
    <span class="hf-tally__n"><span class="hf-tally__tot"><b class="n">${f.int(t.medals ?? t.wins)}</b> ${(t.medals ?? t.wins) === 1 ? 'medal' : 'medals'}</span>${medalTally({ gold: t.gold ?? t.wins, silver: t.silver || 0, bronze: t.bronze || 0 })}</span></a>`;
}

async function hallPage(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  let d = null; let n = 12;

  function paint() {
    document.title = `Hall of fame · ${d.circle.name} · Health`;
    const [last, ...before] = d.weeks;
    mount(root, html`${head({ title: 'Hall of fame', back: `/circles/${id}` })}
      <div class="stack hf" data-style="--cc:${d.circle.accent}">
        <p class="hf-sub muted">${d.circle.name}. Each week, the first three on every board, kept for good. A week runs Friday 12:00 UTC to the next.</p>
        ${!last ? html`<div class="mod mod--12">${empty({ iconName: 'medal', title: 'No weeks yet', text: 'The first week is kept when it ends, on Friday at 12:00 UTC.' })}</div>` : html`
          <section><div class="bsec"><h2>Last week</h2><span class="pp-bsec-n">${f.dayShort(last.week)} to ${f.dayShort(last.to)}</span></div>
            ${last.winners.length ? html`<div class="hf-grid">${last.winners.map(winnerTile)}</div>` : html`<p class="muted small">Nobody had a number on any board.</p>`}
          </section>
          ${d.medals?.total ? html`<div class="hf-sum">
            <span class="hf-sum__n"><b class="n">${f.int(d.medals.total)}</b><small>medals given</small></span>
            ${['gold', 'silver', 'bronze'].map((k) => html`<span class="hf-sum__i">${medal(k, 'medal', { size: 'm', label: '' })}<b class="n">${f.int(d.medals[k])}</b><small>${k[0].toUpperCase()}${k.slice(1)}</small></span>`)}
          </div>` : ''}
          ${d.tally.length ? html`<section><div class="bsec"><h2>Medal table</h2><span class="pp-bsec-n">${f.plural(d.weeksKept, 'week')} kept</span></div>
            <p class="hf-sub muted hf-sub--in">Gold for first on a board in a week, silver for second, bronze for third. Most golds first.</p>
            <div class="group">${d.tally.map(tallyRow)}</div>
          </section>` : ''}
          ${before.length ? html`<section><div class="bsec"><h2>Every week before</h2></div>
            <div class="hf-weeks">${before.map((w) => html`<details class="hf-week"><summary><span>${f.dayShort(w.week)} to ${f.dayShort(w.to)}</span><span class="muted small">${w.winners.length ? `Gold: ${[...new Set(w.winners.flatMap((x) => x.people.map((p) => (p.me ? 'You' : nameOf(p)))))].slice(0, 3).join(', ')}` : 'Nobody'}</span>${ic('chev_d', { size: 's' })}</summary>
              ${w.winners.length ? html`<div class="hf-grid">${w.winners.map(winnerTile)}</div>` : html`<p class="muted small">Nobody had a number on any board.</p>`}</details>`)}</div>
            ${d.weeksKept > d.weeks.length ? html`<button type="button" class="btn btn--tonal btn--block" data-more>Show older weeks</button>` : ''}
          </section>` : ''}`}
      </div>`);
  }
  async function load() {
    d = await api.get(`/api/circles/${encodeURIComponent(id)}/winners${qs({ weeks: n })}`);
    if (ctx.alive()) paint();
  }
  on(root, 'click', '[data-more]', async (e, b) => { n += 26; try { await busy(b, load); } catch (err) { toastError(err); } });
  ctx.onRefresh(() => load());
  mount(root, html`${head({ title: 'Hall of fame', back: `/circles/${id}` })}${skeleton('list')}`);
  try { await load(); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Hall of fame', back: `/circles/${id}` })}${errorState(err)}`); }
}

/* ── /circles/:id/goals ───────────────────────────────────── */

async function goalsPage(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  let d = null;
  const back = `/circles/${id}`;
  function paint() {
    document.title = 'Goals · Health';
    const t = d.cabinet.trophies;
    mount(root, html`${head({ title: 'Goals', back })}
      <div class="stack hf">
        <p class="hf-sub muted">Every week and every month the circle has a goal, made from what its members usually do and pushed further. Everybody's numbers add up. Half of it wins a bronze trophy, three quarters silver, all of it gold, and half as much again platinum. Whoever gives most is the top contributor.</p>
        ${d.current.map((g) => html`<section><div class="gl-list">${goalCard(g)}</div>
          <div class="bsec"><h2>Who gave what</h2><span class="pp-bsec-n">${f.plural(g.counted, 'person', 'people')}</span></div>${goalPeople(g)}</section>`)}
        <section><div class="bsec"><h2>Trophy cabinet</h2></div>
          <div class="gl-cab">${['platinum', 'gold', 'silver', 'bronze'].map((k) => html`<span class="gl-cab__i ${t[k] ? '' : 'is-none'}">${medal(k, 'groups', { size: 'm', label: `${TIER_WORD[k]} trophies` })}<b class="n">${f.int(t[k])}</b><small>${TIER_WORD[k]}</small></span>`)}</div>
        </section>
        ${d.past.length ? html`<section><div class="bsec"><h2>Goals before</h2></div>
          <div class="group">${d.past.map((g) => html`<details class="hf-week gl-past"><summary>
            ${g.tier ? medal(g.tier, 'groups', { size: 's', label: `${TIER_WORD[g.tier]} trophy` }) : html`<span class="gl-past__no">${ic('target', { size: 's' })}</span>`}
            <span class="gl-past__b"><span>${g.label} · ${g.kind === 'week' ? `${f.dayShort(g.start)} to ${f.dayShort(g.end)}` : f.monthYear(g.start)}</span><span class="muted small">${g.closed ? '' : 'Adding up · '}${f.int(g.pct)}% of ${unitText(g.target, g.unit)}${g.people[0]?.value ? ` · most: ${g.people[0].me ? 'you' : nameOf(g.people[0])}` : ''}</span></span>${ic('chev_d', { size: 's' })}</summary>
            <div class="gl-past__in">${goalPeople(g)}</div></details>`)}</div></section>` : ''}
      </div>`);
  }
  async function load() { d = await api.get(`/api/circles/${encodeURIComponent(id)}/goals`); if (ctx.alive()) paint(); }
  ctx.onRefresh(() => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social')) load().catch(() => {}); }));
  mount(root, html`${head({ title: 'Goals', back })}${skeleton('list')}`);
  try { await load(); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Goals', back })}${errorState(err)}`); }
}

/* ── /circles/:id/events, /circles/:id/events/:eid ────────── */

async function eventsPage(ctx) {
  const { root } = ctx;
  const id = ctx.params.id;
  let d = null;
  const back = `/circles/${id}`;
  function paint() {
    document.title = 'Events · Health';
    mount(root, html`${head({ title: 'Events', back })}
      <div class="stack hf">
        <p class="hf-sub muted">An event runs for one, two or four weeks. In a race each of you does every leg, and the first to finish wins. Together, the legs are done once for each of you, pooled, and the circle wins a trophy if you finish. Runs, rides, swims and gym time from workouts count.</p>
        ${d.open.length ? html`<section><div class="bsec"><h2>On now</h2></div><div class="gl-list">${d.open.map((e) => eventCard(e))}</div></section>` : ''}
        ${d.open.length < d.max ? html`<button type="button" class="btn btn--block" data-start-event>${ic('flag', { size: 's' })}Start an event</button>` : html`<p class="muted small">${d.max} events are on: one has to finish before another starts.</p>`}
        ${d.past.length ? html`<section><div class="bsec"><h2>Over</h2></div><div class="group">${d.past.map((e) => {
          const me = e.people.find((p) => p.me);
          const res = e.mode === 'team' ? (e.team.complete ? 'Finished together' : `${f.int(e.team.pct)}% together`) : `${f.plural(e.finishers, 'finisher')}${e.people[0]?.finished ? `, won by ${e.people[0].me ? 'you' : nameOf(e.people[0])}` : ''}`;
          return html`<a class="row fr-row" href="/circles/${id}/events/${e.id}"><span class="ev__ic ev__ic--s">${ic(e.icon, { size: 's' })}</span>
            <span class="row__body"><span class="row__t">${e.label}</span><span class="row__d">${modeWord(e.mode)} · ${res} · ${f.dayShort(e.end)}</span></span>
            ${me?.place ? medal(['', 'gold', 'silver', 'bronze'][me.place], e.icon, { size: 's', label: `You: ${['', 'first', 'second', 'third'][me.place]}` }) : ''}${ic('chev_r', { size: 's' })}</a>`;
        })}</div></section>` : ''}
      </div>`);
  }
  async function load() { d = await api.get(`/api/circles/${encodeURIComponent(id)}/events`); if (ctx.alive()) paint(); }
  on(root, 'click', '[data-start-event]', async () => { const made = await startEventSheet(id, d.kinds); if (made) go(`/circles/${id}/events/${made.id}`); });
  ctx.onRefresh(() => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social')) load().catch(() => {}); }));
  mount(root, html`${head({ title: 'Events', back })}${skeleton('list')}`);
  try { await load(); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Events', back })}${errorState(err)}`); }
}

const legText = (l, v) => (l.unit === 'min' ? unitText(v, 'min') : f.dist(v));

async function eventPage(ctx) {
  const { root } = ctx;
  const { id, eid } = ctx.params;
  let e = null;
  const back = `/circles/${id}/events`;
  function paint() {
    document.title = `${e.label} · Health`;
    const actions = e.canEnd ? html`<button type="button" class="iconbtn" data-end aria-label="Call the event off">${ic('trash')}</button>` : '';
    const status = e.status === 'soon' ? `Starts ${f.dayLong(e.start)}` : e.status === 'live' ? `${timeLeft(e.endsAt)} · ends ${f.dayShort(e.end)}` : e.status === 'settling' ? 'Over: adding up the last numbers' : `Ended ${f.dayLong(e.end)}`;
    const person = (p, i) => html`<a class="row fr-row ev-p ${p.me ? 'is-me' : ''}" href="/u/${encodeURIComponent(p.username)}">
      <span class="hf-tally__pos n">${p.place && (e.mode === 'race' ? p.finished : true) ? p.place : i + 1}</span>${avatar(p)}
      <span class="row__body"><span class="row__t">${p.me ? 'You' : nameOf(p)}${p.place && p.place <= 3 && (e.mode === 'race' ? p.finished : e.team.complete) ? html` ${medal(['', 'gold', 'silver', 'bronze'][p.place], e.icon, { size: 's', label: ['', 'First', 'Second', 'Third'][p.place] })}` : ''}</span>
        <span class="ev-p__legs">${e.legs.map((l) => html`<span class="ev-p__leg"><span class="ev-p__ll">${ic(l.icon, { size: 's' })}</span><span class="meter"><span class="meter__v" data-style="--p:${Math.min(1, (p.done[l.leg] || 0) / (e.mode === 'team' ? l.need : l.amount)).toFixed(4)}"></span></span><span class="ev-p__lv n">${legText(l, p.done[l.leg] || 0)}</span></span>`)}</span></span>
      <span class="ev-p__v"><b class="n">${e.mode === 'team' ? `${f.int(p.share * 100)}%` : p.finished ? 'Done' : `${f.int(p.pct)}%`}</b><small>${e.mode === 'team' ? 'of the pool' : p.finished ? f.dayShort(p.finished) : 'done'}</small></span></a>`;
    mount(root, html`${head({ title: e.label, back, actions })}
      <div class="stack hf">
        <section class="ev-hero fam fam-workouts">
          <div class="ev__h"><span class="ev__ic">${ic(e.icon)}</span><span class="ev__t"><span class="ev__k">${modeWord(e.mode)}${e.by ? ` · started by ${e.by.username === app.me.user?.username ? 'you' : nameOf(e.by)}` : ''}</span><span class="ev__n">${status}</span></span></div>
          <p class="ev-hero__say">${e.say} ${e.mode === 'race' ? 'Each of you does all of it, from the first day to the last. The first to finish wins.' : `Together: once for each of the ${f.plural(e.people.length, 'person', 'people')} in it, pooled.`}</p>
          ${e.mode === 'team' ? html`<div class="ev-legs">${e.legs.map((l) => html`<div class="ev-leg"><span class="ev-leg__h">${ic(l.icon, { size: 's' })}<b>${l.label}</b><span class="n">${legText(l, e.team.done[l.leg] || 0)} of ${legText(l, l.need)}</span></span>
            <span class="meter meter--l"><span class="meter__v" data-style="--p:${Math.min(1, (e.team.done[l.leg] || 0) / l.need).toFixed(4)}"></span></span></div>`)}
            <p class="ev-hero__tot"><b class="n">${f.int(e.team.pct)}%</b> ${e.team.complete ? 'done: the circle wins a trophy.' : 'of the way.'}</p></div>`
            : html`<p class="ev-hero__tot">${e.legs.map((l) => `${l.label} ${legText(l, l.amount)}`).join(' · ')}</p>`}
          ${e.canJoin ? html`<button type="button" class="btn" data-ev="join">${ic('plus', { size: 's' })}Join in</button>`
            : e.shareFirst ? html`<p class="gl__me">Your workouts are kept from your circles. <a href="/settings/privacy">Share them with circles</a> to take part.</p>`
              : e.joined && e.status !== 'done' ? html`<button type="button" class="btn btn--tonal btn--s" data-ev="leave">Leave the event</button>` : ''}
        </section>
        <section><div class="bsec"><h2>${e.mode === 'race' ? 'Standings' : 'Who carried what'}</h2><span class="pp-bsec-n">${f.plural(e.people.length, 'person', 'people')}</span></div>
          ${e.people.length ? html`<div class="group">${e.people.map(person)}</div>` : html`<p class="muted small">Nobody is in it yet.</p>`}</section>
      </div>`);
  }
  async function load() { e = await api.get(`/api/circles/${encodeURIComponent(id)}/events/${encodeURIComponent(eid)}`); if (ctx.alive()) paint(); }
  on(root, 'click', '[data-ev]', async (ev, b) => {
    try { const r = await busy(b, () => api.post(`/api/circles/${id}/events/${eid}/${b.dataset.ev}`, {})); if (r) { e = r; toast(b.dataset.ev === 'join' ? 'You are in' : 'You left it'); paint(); } } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-end]', async (ev, b) => {
    if (!(await confirm({ title: `Call off the ${e.label}?`, text: 'It ends for everybody in it, with no result kept.', yes: 'Call it off', danger: true }))) return;
    try { await busy(b, () => api.del(`/api/circles/${id}/events/${eid}`)); toast('Called off'); go(`/circles/${id}`, { replace: true }); } catch (err) { toastError(err); }
  });
  ctx.onRefresh(() => load());
  ctx.onLeave(listen('changed', (what) => { if (what.includes('social')) load().catch(() => {}); }));
  mount(root, html`${head({ title: 'Event', back })}${skeleton('list')}`);
  try { await load(); } catch (err) { if (ctx.alive()) mount(root, html`${head({ title: 'Event', back })}${err.status === 404 ? html`<div class="mod mod--12">${empty({ iconName: 'flag', title: 'This event is not here', text: 'It was called off, or you are not in this circle.' })}</div>` : errorState(err)}`); }
}

export default async function circles(ctx) {
  if (ctx.name === 'goals') return goalsPage(ctx);
  if (ctx.name === 'events') return eventsPage(ctx);
  if (ctx.name === 'event') return eventPage(ctx);
  if (ctx.name === 'hall') return hallPage(ctx);
  if (ctx.name === 'circle') return onePage(ctx);
  return listPage(ctx);
}
