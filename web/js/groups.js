/* The optional groups of data ("More data"): nutrition and water, mood,
   symptoms, cycle, ECG. Switching one on or off, the two ways one can be
   on (saved to Google Health too, or kept on this site only), and the
   module that lists them in Me → Connections.

   The server's GroupsView is the contract (docs/API.md, POST
   /api/google/groups): `mode` is 'off' | 'google' | 'local'. */

import { api } from './api.js';
import { app, refreshMe, setMe } from './app.js';
import { html, mount, ic, sheet, toast, toastError, on } from './ui.js';
import { platform } from './pwa.js';
import { stGrp, stRow, stSwitch, stNote } from './apps.js';

/** How each group looks: its family colour and glyph. */
export const GROUP_LOOK = {
  nutrition: { fam: 'water', icon: 'drop' },
  mindfulness: { fam: 'mind', icon: 'mood' },
  symptoms: { fam: 'vitals', icon: 'symptom' },
  cycle: { fam: 'cycle', icon: 'cycle' },
  sleeplog: { fam: 'sleep', icon: 'moon' },
  ecg: { fam: 'heart', icon: 'ecg_trace' },
};

export const ALWAYS_PRIVATE = 'These are always private: never on your profile, the leaderboard or compare.';

const ASKED_KEY = 'health.group.asked';

/**
 * Back from Google with ?google=…: when the trip was for ONE optional group
 * on an account that was already connected, the sentence for it (and not
 * the first-connect one). null when this was not such a trip.
 *   const t = groupGrantToast(gq); if (t) toast(t.text, { tone: t.tone });
 */
export function groupGrantToast(gq) {
  let id = null;
  try { id = sessionStorage.getItem(ASKED_KEY); sessionStorage.removeItem(ASKED_KEY); } catch { /* no storage */ }
  const g = id ? groupOf(id) : null;
  if (!g) return null;
  if (gq === 'cancelled') return { text: `Nothing was changed at Google. ${g.label}: still off.`, tone: '' };
  if (gq !== 'connected') return null;
  if (g.mode === 'google') return { text: g.readOnly ? `Allowed. ${g.label}: now read from Google Health.` : `Allowed. ${g.label}: what you log is now saved to Google Health too.`, tone: '' };
  return { text: `Google did not allow it, so ${g.label.toLowerCase()} is still off. You can try again any time.`, tone: 'bad' };
}

export const groupsOf = () => app.me.google?.groups || [];
export const groupOf = (id) => groupsOf().find((g) => g.id === id) || null;

/** A group's state in a few words. */
export function groupState(g) {
  if (g.mode === 'google') return g.readOnly ? 'On: read from Google Health' : 'On: saved to Google Health too';
  if (g.mode === 'local') return 'On: kept on this site only';
  return 'Off';
}

/* The group's note without the sentence its description and its state already say. */
const note = (g) => String(g.note || '').split(/(?<=\.)\s+/).filter((x) => !/saved to Google Health too/i.test(x)).join(' ');

function applyGroups(r) {
  if (r?.groups && app.me.google) setMe({ ...app.me, google: { ...app.me.google, groups: r.groups } });
  refreshMe().catch(() => {});
}

/** Send the browser to Google for one group (or explain Safari, in the Health app). */
async function askGoogle(start, ret, id) {
  if (platform.native) { const { googleInSafari } = await import('./views/shared.js'); googleInSafari(); return; }
  // Remembered across the trip to Google, so the page that comes back can say what was allowed.
  try { if (id) sessionStorage.setItem(ASKED_KEY, id); } catch { /* the plain sentence is shown instead */ }
  location.href = `${start}${start.includes('?') ? '&' : '?'}return=${encodeURIComponent(ret)}`;
}

/**
 * Switch a group on. Resolves true when it is on now; false when the person
 * backed out, or left for Google (the page comes back with ?google=…).
 *   await turnOnGroup('nutrition', { ret: '/settings/connections' })
 */
export async function turnOnGroup(id, { ret = '/settings/connections' } = {}) {
  const g = groupOf(id);
  const name = g?.label || 'This';
  try {
    const r = await api.post('/api/google/groups', { group: id, on: true });
    applyGroups(r);
    toast(r.group?.mode === 'local' ? `${name} is on. What you log is kept on this site only.` : `${name} is on.`);
    return true;
  } catch (err) {
    if (err.code !== 'needs_scope' && err.code !== 'needs_google') { toastError(err); return false; }
    const d = err.detail || {};
    const connected = err.code === 'needs_scope';
    const s = sheet({
      title: `Turn on ${name.toLowerCase()}`,
      body: html`<div class="st-sheet">
        <p class="st-lead">${err.message}</p>
        ${stGrp(html`
          ${connected && d.start ? stRow({ btn: true, attrs: 'data-go="google"', icon: 'link', title: 'Allow in Google', sub: d.canLocal === false ? 'Google asks for this one permission, then brings you back.' : 'Google asks, then brings you back. What you log is saved there too.' }) : ''}
          ${!connected ? stRow({ btn: true, attrs: 'data-go="connect"', icon: 'link', title: 'Connect Google Health', sub: 'These readings come from a watch through Google Health. Connect it first.' }) : ''}
          ${d.canLocal ? stRow({ btn: true, attrs: 'data-go="local"', icon: 'lock', title: 'Keep on this site only', sub: 'Nothing is sent to Google. Allow it later and what you logged is sent then.' }) : ''}`, 'data-style="margin-top:12px"')}
        ${stNote(`${g && note(g) ? `${note(g)} ` : ''}${ALWAYS_PRIVATE}`)}
      </div>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Not now</button>`,
    });
    on(s.el, 'click', '[data-go]', async (e, b) => {
      if (b.dataset.go === 'google') { b.classList.add('is-busy'); s.close('left'); askGoogle(d.start, ret, id); return; }
      if (b.dataset.go === 'connect') { s.close('left'); const { connectGoogle } = await import('./views/shared.js'); connectGoogle(ret, [id]); return; }
      try {
        const r = await api.post('/api/google/groups', { group: id, on: true, local: true });
        applyGroups(r);
        toast(`${name} is on. What you log is kept on this site only.`);
        s.close('on');
      } catch (e2) { toastError(e2); }
    });
    return (await s.closed) === 'on';
  }
}

/**
 * Switch a group off, after asking (with the choice to delete what was
 * logged here). Resolves true when it is off now.
 */
export async function turnOffGroup(id) {
  const g = groupOf(id);
  const name = g?.label || 'This';
  const canPurge = g && !g.readOnly;
  const s = sheet({
    title: `Turn off ${name.toLowerCase()}?`,
    body: html`<div class="st-sheet">
      <p class="st-lead">${g?.readOnly ? 'Its readings leave Browse and Today and are no longer read from Google Health.' : 'Its metrics leave Browse, Today and your pins, and nothing more can be logged.'} Turn it on again and everything is back.</p>
      ${canPurge ? stGrp(stSwitch('purge', false, 'Also delete what I logged here', 'Gone from this site for good. Copies in Google Health stay.'), 'data-style="margin-top:12px"') : ''}
      ${stNote('To withdraw it at Google too, disconnect and connect again.')}
    </div>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Keep it on</button><button type="button" class="btn btn--solid-danger" data-off>Turn off</button>`,
  });
  s.el.querySelector('[data-off]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const purge = Boolean(s.el.querySelector('[name="purge"]')?.checked);
    btn.disabled = true; btn.classList.add('is-busy');
    try {
      const r = await api.post('/api/google/groups', { group: id, on: false, ...(purge ? { purge: true } : {}) });
      applyGroups(r);
      toast(purge ? `${name} is off. ${r.purged === 1 ? '1 entry was' : `${r.purged || 0} entries were`} deleted from this site.` : `${name} is off. What you logged is kept.`);
      s.close('off');
    } catch (err) { toastError(err); btn.disabled = false; btn.classList.remove('is-busy'); }
  });
  return (await s.closed) === 'off';
}

/* ── the module in Me → Connections ─────────────────────────── */

const famOf = (id) => (GROUP_LOOK[id] || { fam: 'steps' }).fam;

/**
 * "More data": one row per group (its state in a line); a row opens the
 * group in a sheet, with its switch, "Include in summaries" and the rest.
 * Paints into `pane` and keeps itself up to date. `changed()` runs after a
 * group goes on or off.
 */
export function groupsModule(pane, { ret = '/settings/connections', changed } = {}) {
  let open = null;   // the sheet of the group open now: { id, el }
  function paint() {
    const groups = groupsOf();
    if (!groups.length) { mount(pane, ''); return; }
    mount(pane, html`
      <p class="st-lead">Things you log by hand, and readings a watch takes on request. Each is off until you turn it on.</p>
      ${stGrp(groups.map((g) => {
        const look = GROUP_LOOK[g.id] || { icon: 'info' };
        return stRow({ btn: true, attrs: `data-group="${g.id}"`, icon: look.icon, fam: famOf(g.id), title: g.label, sub: g.readOnly && g.mode === 'off' ? 'Off · needs Google Health' : groupState(g) });
      }), 'data-style="margin-top:12px"')}
      ${stNote(ALWAYS_PRIVATE)}`);
    if (open) paintSheet();
  }
  function sheetBody(g) {
    const share = app.me.aiShare || {};
    const isOn = g.mode !== 'off';
    return html`<div class="st-sheet">
      <p class="st-lead">${g.about}</p>
      ${stGrp(html`
        ${stSwitch(`grp-${g.id}`, isOn, isOn ? 'On' : 'Off', groupState(g).replace(/^(On|Off):?\s*/, '') || (g.readOnly ? 'Needs Google Health' : 'Nothing is logged'), { label: `${g.label}: ${isOn ? 'on' : 'off'}` })}
        ${isOn ? stSwitch(`ai-${g.id}`, Boolean(share[g.id]), 'Include in summaries', share[g.id] ? 'A written summary may read it. Your notes never.' : 'A written summary never reads it.', { label: `Include ${g.label.toLowerCase()} in summaries` }) : ''}
        ${g.mode === 'local' && app.me.google?.state === 'ok' ? stRow({ btn: true, attrs: `data-allow="${g.id}"`, icon: 'link', title: 'Allow in Google as well', sub: 'What you log is saved to Google Health too' }) : ''}`, 'data-style="margin-top:12px"')}
      ${note(g) ? stNote(note(g)) : ''}
    </div>`;
  }
  function paintSheet() {
    const g = groupOf(open.id);
    if (!g || !open.el.isConnected) return;
    mount(open.el.querySelector('.sheet__body'), sheetBody(g));
  }
  on(pane, 'click', '[data-group]', (e, b) => {
    const g = groupOf(b.dataset.group);
    if (!g) return;
    const s = sheet({ title: g.label, body: sheetBody(g) });
    open = { id: g.id, el: s.el };
    s.closed.then(() => { if (open?.el === s.el) open = null; });
    on(s.el, 'change', 'input[name^="grp-"]', async (ev, input) => {
      const id = input.name.slice(4);
      input.disabled = true;
      const ok = input.checked ? await turnOnGroup(id, { ret }) : await turnOffGroup(id);
      paint();
      if (ok) changed?.();
    });
    on(s.el, 'change', 'input[name^="ai-"]', async (ev, input) => {
      const id = input.name.slice(3);
      try {
        setMe(await api.patch('/api/settings', { aiShare: { [id]: input.checked } }));
        toast(input.checked ? 'Summaries may read this group from now on' : 'Summaries no longer read this group');
      } catch (err) { toastError(err); }
      paint();
    });
    on(s.el, 'click', '[data-allow]', (ev, btn) => {
      const gg = groupOf(btn.dataset.allow);
      if (!gg?.start) return;
      btn.classList.add('is-busy');
      askGoogle(gg.start, ret, gg.id);
    });
  });
  paint();
  return { paint };
}

/**
 * The same groups as optional switches, folded away by default, for the
 * connect step of onboarding. Read the choice with pickedGroups(root).
 */
export function groupsPicker() {
  const groups = groupsOf();
  if (!groups.length) return '';
  return html`<details class="st-more grp-pick">
    <summary class="st-grp"><span class="st-row"><span class="st-ic">${ic('plus')}</span><span class="st-b"><span class="st-t">More data (optional)</span><span class="st-s">Water, mood, symptoms, cycle, ECG</span></span><span class="st-chev">${ic('chev_d', { size: 's' })}</span></span></summary>
    ${stGrp(groups.map((g) => {
      const look = GROUP_LOOK[g.id] || { icon: 'info' };
      return stRow({ icon: look.icon, fam: famOf(g.id), title: g.label, sub: g.about, end: html`<label class="switch"><input type="checkbox" name="group" value="${g.id}" role="switch" aria-label="${g.label}"><span class="switch__track"></span></label>` });
    }), 'data-style="margin-top:8px"')}
    ${stNote(`Leave these off unless you want them; you can turn any on later in Me, Connections. ${ALWAYS_PRIVATE}`)}
  </details>`;
}
export const pickedGroups = (root) => [...root.querySelectorAll('input[name="group"]:checked')].map((x) => x.value);
