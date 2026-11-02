/* Circles (server/circles.js, docs/CIRCLES.md): groups of people with
   their own boards and a hall of fame.

     /circles            yours, invitations, requests you made, finding one, starting one
     /circles/:id        one circle: its members, who asked to join, the owner's settings
     /circles/:id/hall   the hall of fame: each week's winner of every board

   Somebody outside a circle sees its name, its line and how many are in
   it, never who. Being in one is choosing to be seen by its members. */

import { api, qs } from '../api.js';
import { app, listen, go, refreshMe } from '../app.js';
import { html, mount, ic, head, skeleton, errorState, empty, on, sheet, confirm, toast, toastError, busy, field, fieldError, errText } from '../ui.js';
import { stGrp, stRow, stNote, stPick } from '../apps.js';
import * as f from '../format.js';
import { avatar, unitText } from './shared.js';
import { METRIC, nameOf } from './ranks.js';

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
          ${inIt ? html`<div class="btnrow"><a class="btn btn--s" href="/ranks?scope=circle:${c.id}">${ic('leaderboard', { size: 's' })}Boards</a><a class="btn btn--tonal btn--s" href="/circles/${c.id}/hall">${ic('medal', { size: 's' })}Hall of fame</a></div>`
            : c.status === 'pending' ? html`<div class="btnrow"><span class="muted small">You asked to join. The owner decides.</span><button type="button" class="btn btn--tonal btn--s" data-leave>Take it back</button></div>`
              : c.status === 'invited' ? html`<div class="btnrow"><button type="button" class="btn btn--s" data-join>${ic('check', { size: 's' })}Join</button><button type="button" class="btn btn--tonal btn--s" data-leave>Decline</button></div>`
                : html`<div class="btnrow"><button type="button" class="btn btn--s" data-join>${ic('plus', { size: 's' })}Ask to join</button></div>`}
        </section>
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
    try { const r = await busy(b, fn); if (okText) toast(okText); refreshMe().catch(() => {}); if (r?.circle) { c = r.circle; paint(); } else await load(); return r; } catch (err) { toastError(err); return null; }
  };
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
        try { c = await api.patch(`/api/circles/${id}`, formBody(form)); refreshMe().catch(() => {}); toast('Saved'); paint(); return true; } catch (err) { fieldError(form, 'name', errText(err)); return false; }
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

function winnerTile(w) {
  const m = METRIC[w.metric] || { icon: 'medal', fam: 'steps', label: w.label };
  const who = w.people.map((p) => (p.me ? 'You' : nameOf(p)));
  return html`<div class="hf-tile fam fam-${m.fam}">
    <span class="hf-tile__ic">${ic(m.icon)}</span>
    <span class="hf-tile__b"><span class="hf-tile__t">${w.label}</span><span class="hf-tile__who">${w.people.slice(0, 3).map((p) => avatar(p))}<b>${who.length > 2 ? `${who.slice(0, 2).join(', ')} +${who.length - 2}` : who.join(' and ')}</b></span><span class="hf-tile__v n">${unitText(w.value, w.unit)}</span></span>
  </div>`;
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
        <p class="hf-sub muted">${d.circle.name}. Each week, the first on every board, kept for good. A week runs Friday 12:00 UTC to the next.</p>
        ${!last ? html`<div class="mod mod--12">${empty({ iconName: 'medal', title: 'No weeks yet', text: 'The first week is kept when it ends, on Friday at 12:00 UTC.' })}</div>` : html`
          <section><div class="bsec"><h2>Last week</h2><span class="pp-bsec-n">${f.dayShort(last.week)} to ${f.dayShort(last.to)}</span></div>
            ${last.winners.length ? html`<div class="hf-grid">${last.winners.map(winnerTile)}</div>` : html`<p class="muted small">Nobody had a number on any board.</p>`}
          </section>
          ${d.tally.length ? html`<section><div class="bsec"><h2>Most weeks won</h2><span class="pp-bsec-n">${f.plural(d.weeksKept, 'week')} kept</span></div>
            <div class="group">${d.tally.map((t, i) => html`<a class="row fr-row hf-tally" href="/u/${encodeURIComponent(t.username)}">
              <span class="hf-tally__pos n">${i + 1}</span>${avatar(t)}
              <span class="row__body"><span class="row__t">${t.me ? 'You' : nameOf(t)}</span><span class="row__d">${t.boards.map((b) => `${b.label} ${b.wins}`).join(' · ')}</span></span>
              <span class="hf-tally__n"><b class="n">${f.int(t.wins)}</b><small>${t.wins === 1 ? 'win' : 'wins'}</small></span></a>`)}</div>
          </section>` : ''}
          ${before.length ? html`<section><div class="bsec"><h2>Every week before</h2></div>
            <div class="hf-weeks">${before.map((w) => html`<details class="hf-week"><summary><span>${f.dayShort(w.week)} to ${f.dayShort(w.to)}</span><span class="muted small">${w.winners.length ? [...new Set(w.winners.flatMap((x) => x.people.map((p) => (p.me ? 'You' : nameOf(p)))))].slice(0, 3).join(', ') : 'Nobody'}</span>${ic('chev_d', { size: 's' })}</summary>
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

export default async function circles(ctx) {
  if (ctx.name === 'hall') return hallPage(ctx);
  if (ctx.name === 'circle') return onePage(ctx);
  return listPage(ctx);
}
