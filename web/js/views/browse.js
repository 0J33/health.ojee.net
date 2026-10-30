/* Browse: everything the person has, by category, and everything they do
   not have yet. The home of the Browse tab (/trends); the analysis views
   sit behind the same sub-tab bar.

   Data: GET /api/browse (docs/API.md, "Every metric"). A category is a
   module, a metric a row (metrics.js metricRow) that links to its page.
   The search text and the open "No data yet" list live in history.state,
   so coming back from a metric page finds the list as it was left. */

import { api } from '../api.js';
import { app, listen } from '../app.js';
import { html, mount, ic, head, errorState, on, toast } from '../ui.js';
import { mod, tabsub, ib } from '../kit.js';
import { metricRow, metricIcon, matches } from '../metrics.js';
import { addEntry, bindPins } from '../entry.js';
import { turnOnGroup, groupOf, groupGrantToast } from '../groups.js';
import { connectionBanner, sectionTabs } from './shared.js';
import * as f from '../format.js';

/* The colour a category's title takes: the family most of it belongs to. */
const CAT_FAM = { activity: 'steps', heart: 'heart', sleep: 'sleep', body: 'body', vitals: 'vitals', nutrition: 'nutrition', mindfulness: 'mind', cycle: 'cycle', other: '' };
const CAT_LABEL = { activity: 'Activity', heart: 'Heart', sleep: 'Sleep', body: 'Body', vitals: 'Vitals', nutrition: 'Nutrition', mindfulness: 'Mindfulness', cycle: 'Cycle', other: 'Other' };
const CAT_ORDER = Object.keys(CAT_LABEL);
const MAX_PINS = 8;

/* The last payload, so coming back paints at once (and the scroll position
   can be put back) while a fresh one is fetched. */
let cache = null;        // { uid, data }
const cached = () => (cache && cache.uid === app.me.user?.id ? cache.data : null);

const state = () => history.state || {};
const remember = (patch) => history.replaceState({ ...state(), ...patch }, '', location.href);

function emptyRow(e) {
  const g = e.group ? groupOf(e.group) : null;
  const action = !e.groupOn && e.group
    ? html`<button type="button" class="btn btn--tonal btn--s" data-group="${e.group}" aria-label="Turn on ${g?.label || e.label}">Turn on</button>`
    : e.canAdd ? html`<button type="button" class="btn btn--tonal btn--s" data-add="${e.id}" aria-label="Add ${e.label}">${ic('plus', { size: 's' })}Add</button>` : '';
  return html`<li class="erow">
    ${ib(metricIcon(e), { plain: true })}
    <span class="erow__b"><span class="erow__t">${e.label}</span><span class="erow__d">${!e.groupOn && g ? `Part of ${g.label}, which is off. ` : ''}${e.provides}</span></span>
    ${action}
  </li>`;
}

function emptyList(list) {
  return CAT_ORDER.filter((c) => list.some((e) => e.category === c)).map((c) => html`<div class="part">
    <p class="sub">${CAT_LABEL[c]}</p>
    <ul class="erows">${list.filter((e) => e.category === c).map(emptyRow)}</ul>
  </div>`);
}

function category(c, today) {
  return mod({
    title: c.label, fam: CAT_FAM[c.id] || '', cls: 'br-cat', id: `br-${c.id}`,
    tools: html`<span class="br-count"><span aria-hidden="true">${c.metrics.length}</span><span class="sr">${f.plural(c.metrics.length, 'metric')}</span></span>`,
    body: html`<ul class="mrows">${c.metrics.map((m) => metricRow(m, { today }))}</ul>`,
  });
}

export default async function browse(ctx) {
  const { root } = ctx;
  document.title = 'Health';
  let data = cached();
  let q = typeof state().q === 'string' ? state().q : '';
  let seq = 0;

  const gq = ctx.query.get('google');
  if (gq) {
    history.replaceState(history.state, '', '/trends');
    const grant = groupGrantToast(gq);
    if (grant) toast(grant.text, { tone: grant.tone, ms: 7000 });
    else if (gq === 'connected') toast('Google allowed it. It is on now.');
    else if (gq === 'cancelled') toast('Nothing was changed at Google.');
    else toast(ctx.query.get('message') || 'Google could not be asked. Try again.', { tone: 'bad', ms: 8000 });
  }

  const sub = () => {
    if (!data) return 'Everything you track, in one place';
    const have = data.categories.reduce((a, c) => a + c.metrics.length, 0);
    const all = have + data.empty.length;
    return have === all ? `All ${all} kinds of data` : have ? `${have} of ${all} kinds of data so far` : `${all} kinds of data, none yet`;
  };

  const chrome = (body) => html`
    ${head({ title: 'Health', sub: sub() })}
    ${tabsub(sectionTabs('browse'), 'browse', { label: 'Browse and trends' })}
    <div class="br-search">
      <label class="sr" for="br-q">Search your data</label>
      <span class="br-search__ic">${ic('search', { size: 's' })}</span>
      <input class="input" id="br-q" type="search" placeholder="Search: steps, oxygen, water…" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" value="${q}">
      <button type="button" class="iconbtn br-search__x" data-action="clear" aria-label="Clear the search" ${q ? '' : 'hidden'}>${ic('x', { size: 's' })}</button>
    </div>
    <div class="br-body" data-body>${body}</div>`;

  function results() {
    const cats = data.categories.map((c) => ({ ...c, metrics: c.metrics.filter((m) => matches(m, q, c.label)) })).filter((c) => c.metrics.length);
    const none = data.empty.filter((e) => matches(e, q, CAT_LABEL[e.category]));
    const hits = cats.flatMap((c) => c.metrics);
    if (!hits.length && !none.length) {
      return html`<div class="mod br-nomatch" role="status"><div class="empty">
        <span class="empty__ic">${ic('search')}</span>
        <p class="empty__t">Nothing matches "${q}"</p>
        <p class="empty__d">Try the name of a measurement, such as heart, sleep or weight, or a word for it, such as calories or breathing.</p>
        <button type="button" class="btn btn--tonal btn--s" data-action="clear">Clear the search</button>
      </div></div>`;
    }
    return html`
      <p class="br-found" role="status">${f.plural(hits.length + none.length, 'match', 'matches')} for "${q}"</p>
      ${hits.length ? mod({ label: 'Matches', cls: 'br-cat', body: html`<ul class="mrows">${hits.map((m) => metricRow(m, { today: data.today }))}</ul>` }) : ''}
      ${none.length ? mod({ title: 'No data yet', cls: 'br-cat br-none', body: emptyList(none) }) : ''}`;
  }

  function everything() {
    const metrics = data.categories.flatMap((c) => c.metrics);
    const byId = new Map(metrics.map((m) => [m.id, m]));
    const pinned = (data.pinned || []).map((id) => byId.get(id)).filter(Boolean);
    const g = app.me.google?.state;
    const fresh = !metrics.length;
    const open = fresh || state().none === true;

    const intro = fresh
      ? html`<div class="mod br-intro"><div class="empty empty--inline">
          <p class="empty__t">Nothing here yet</p>
          <p class="empty__d">${g === 'ok'
            ? 'Your first sync is still filling in. What your devices report appears here by itself; the list below shows everything this app can hold.'
            : 'What your phone or watch reports appears here once Google Health is connected. Some things you can log by hand straight away: they are in the list below, marked Add.'}</p>
        </div></div>`
      : metrics.length <= 4
        ? html`<p class="br-thin">This is what your devices report so far. The list at the end shows what a watch or band would add, and what you can log by hand.</p>`
        : '';

    return html`
      ${connectionBanner('/trends')}
      ${intro}
      ${pinned.length ? mod({
        title: 'Pinned', icon: 'pin', cls: 'br-cat br-pinned',
        tools: html`<span class="br-count">${pinned.length} of ${MAX_PINS}<span class="sr"> pins used</span></span>`,
        body: html`<ul class="mrows mrows--wide">${pinned.map((m) => metricRow(m, { today: data.today }))}</ul>`,
      }) : ''}
      ${data.categories.length ? html`<div class="br-cols">${data.categories.map((c) => category(c, data.today))}</div>` : ''}
      ${data.empty.length ? html`<details class="mod br-none" ${open ? 'open' : ''}>
        <summary class="br-none__s"><span class="br-none__t">No data yet</span><span class="br-count"><span aria-hidden="true">${data.empty.length}</span><span class="sr">${f.plural(data.empty.length, 'metric')}</span></span><span class="row__chev">${ic('right', { size: 's' })}</span></summary>
        <div class="br-none__b">
          <p class="mod__note">What this app can also hold. Each line says what gives it; nothing here is shown as a zero.</p>
          <div class="br-none__cols">${emptyList(data.empty)}</div>
        </div>
      </details>` : ''}`;
  }

  const body = () => (q.trim() ? results() : everything());

  function paintBody() {
    const el = root.querySelector('[data-body]');
    if (!el) { mount(root, chrome(body())); return; }
    const y = window.scrollY;
    mount(el, body());
    const hs = root.querySelector('.head__sub'); if (hs) hs.textContent = sub();
    window.scrollTo(0, y);
  }

  async function load({ quiet = false } = {}) {
    const mine = seq += 1;
    if (!data) mount(root, chrome(html`<div class="skelstack" aria-busy="true" aria-label="Loading"><div class="skel skel--tall"></div><div class="skel skel--tall"></div><div class="skel skel--block"></div></div>`));
    try {
      const b = await api.get('/api/browse');
      if (!ctx.alive() || mine !== seq) return;
      data = b; cache = { uid: app.me.user?.id, data: b };
      paintBody();
    } catch (err) {
      if (!ctx.alive() || mine !== seq) return;
      if (!data || !quiet) { data = null; cache = null; mount(root, chrome(errorState(err))); }
    }
  }

  let typing = 0;
  on(root, 'input', '#br-q', (e, input) => {
    q = input.value;
    root.querySelector('.br-search__x').hidden = !q;
    clearTimeout(typing);
    typing = setTimeout(() => remember({ q }), 250);
    if (data) paintBody();
  });
  on(root, 'keydown', '#br-q', (e, input) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); } });
  on(root, 'click', '[data-action="clear"]', () => {
    const input = root.querySelector('#br-q');
    input.value = ''; q = ''; remember({ q: '' });
    root.querySelector('.br-search__x').hidden = true;
    if (data) paintBody();
    input.focus();
  });
  root.addEventListener('toggle', (e) => { if (e.target.matches?.('details.br-none')) remember({ none: e.target.open }); }, true);
  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-add]', (e, b) => { b.classList.add('is-busy'); addEntry(b.dataset.add, { onSaved: () => load({ quiet: true }) }).finally(() => b.classList.remove('is-busy')); });
  on(root, 'click', '[data-group]', async (e, b) => {
    if (b.classList.contains('is-busy')) return;
    b.classList.add('is-busy');
    const ok = await turnOnGroup(b.dataset.group, { ret: '/trends' });
    b.classList.remove('is-busy');
    if (ok) load({ quiet: true });
  });
  bindPins(root, {
    changed: (pinned) => {
      if (!data) return;
      data.pinned = pinned;
      for (const c of data.categories) for (const m of c.metrics) m.pinned = pinned.includes(m.id);
      paintBody();
    },
  });

  ctx.onLeave(() => clearTimeout(typing));
  ctx.onLeave(listen('changed', (what) => { if (what.includes('data') || what.includes('me')) load({ quiet: true }); }));
  ctx.onRefresh(() => load({ quiet: true }));

  if (data) { mount(root, chrome(body())); load({ quiet: true }); } else await load();
}
