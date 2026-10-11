/* The optional groups of data ("More data"): nutrition and water, mood,
   symptoms, cycle, ECG. Switching one on or off, the two ways one can be
   on (saved to Google Health too, or kept on this site only), and the
   module that lists them in Me → Connections.

   The server's GroupsView is the contract (docs/API.md, POST
   /api/google/groups): `mode` is 'off' | 'google' | 'local'. */

import { api } from './api.js';
import { app, refreshMe, setMe } from './app.js';
import { html, mount, ic, sheet, toast, toastError, toggle, on } from './ui.js';
import { ib } from './kit.js';
import { platform } from './pwa.js';

/** How each group looks: its family colour and glyph. */
export const GROUP_LOOK = {
  nutrition: { fam: 'water', icon: 'drop' },
  mindfulness: { fam: 'mind', icon: 'mood' },
  symptoms: { fam: 'vitals', icon: 'symptom' },
  cycle: { fam: 'cycle', icon: 'cycle' },
  ecg: { fam: 'heart', icon: 'ecg_trace' },
};

export const ALWAYS_PRIVATE = 'These are always private: never on your profile, the leaderboard or compare.';

export const groupsOf = () => app.me.google?.groups || [];
export const groupOf = (id) => groupsOf().find((g) => g.id === id) || null;

/** A group's state in a few words. */
export function groupState(g) {
  if (g.mode === 'google') return g.readOnly ? 'On: read from Google Health' : 'On: saved to Google Health too';
  if (g.mode === 'local') return 'On: kept on this site only';
  return 'Off';
}

function applyGroups(r) {
  if (r?.groups && app.me.google) setMe({ ...app.me, google: { ...app.me.google, groups: r.groups } });
  refreshMe().catch(() => {});
}

/** Send the browser to Google for one group (or explain Safari, in the Health app). */
async function askGoogle(start, ret) {
  if (platform.native) { const { googleInSafari } = await import('./views/shared.js'); googleInSafari(); return; }
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
      body: html`<div class="stack">
        <p class="prose">${err.message}</p>
        ${g?.note ? html`<p class="muted small">${g.note}</p>` : ''}
        <div class="choices">
          ${connected && d.start ? html`<button type="button" class="choice" data-go="google">
            <span class="choice__ic">${ic('link')}</span>
            <span class="choice__b"><span class="choice__t">Allow in Google</span><span class="choice__d">${d.canLocal === false ? 'Google asks you for this one permission, then brings you back. Readings only ever come from Google Health.' : 'Google asks you for this one permission, then brings you back. What you log is saved to Google Health too.'}</span></span>
            <span class="row__chev">${ic('right', { size: 's' })}</span></button>` : ''}
          ${!connected ? html`<button type="button" class="choice" data-go="connect">
            <span class="choice__ic">${ic('link')}</span>
            <span class="choice__b"><span class="choice__t">Connect Google Health</span><span class="choice__d">These readings are taken on a watch and read from Google Health. Connect it first, then turn this on.</span></span>
            <span class="row__chev">${ic('right', { size: 's' })}</span></button>` : ''}
          ${d.canLocal ? html`<button type="button" class="choice" data-go="local">
            <span class="choice__ic">${ic('lock')}</span>
            <span class="choice__b"><span class="choice__t">Keep on this site only</span><span class="choice__d">Nothing is sent to Google. If you allow it later, what you logged is sent then.</span></span>
            <span class="row__chev">${ic('right', { size: 's' })}</span></button>` : ''}
        </div>
        <p class="muted small">${ALWAYS_PRIVATE}</p>
      </div>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Not now</button>`,
    });
    on(s.el, 'click', '[data-go]', async (e, b) => {
      if (b.dataset.go === 'google') { b.classList.add('is-busy'); s.close('left'); askGoogle(d.start, ret); return; }
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
    body: html`<div class="stack">
      <p class="prose">${g?.readOnly ? 'Its readings disappear from Browse and Today, and are no longer read from Google Health.' : 'Its metrics disappear from Browse, Today and your pins, and nothing more can be logged.'} Turn it on again and everything is back.</p>
      ${canPurge ? html`<label class="check"><input type="checkbox" name="purge"><span><span class="check__t">Also delete what I logged here</span><span class="check__d">Removes those entries from this site for good. Copies in Google Health stay where they are.</span></span></label>` : ''}
      <p class="muted small">To withdraw it at Google too, disconnect and connect again.</p>
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

/**
 * "More data": the five groups with their switches. Paints into `pane` and
 * keeps itself up to date. `changed()` runs after a group goes on or off.
 */
export function groupsModule(pane, { ret = '/settings/connections', changed } = {}) {
  function paint() {
    const groups = groupsOf();
    const share = app.me.aiShare || {};
    if (!groups.length) { mount(pane, ''); return; }
    mount(pane, html`
      <div class="sec__head"><h2 class="h2">More data</h2><span class="sec__note">Optional</span></div>
      <div class="stack">
        <p class="prose small">Things you can log here by hand, and readings a watch takes on request. Each is off until you turn it on.</p>
        <p class="private">${ic('lock', { size: 's' })}<span>${ALWAYS_PRIVATE}</span></p>
        <div class="group">
          ${groups.map((g) => {
            const look = GROUP_LOOK[g.id] || { fam: 'steps', icon: 'info' };
            const isOn = g.mode !== 'off';
            return html`<div class="grp fam fam-${look.fam}" data-group="${g.id}">
              <div class="grp__top">
                ${ib(look.icon)}
                <span class="grp__b"><span class="grp__t">${g.label}</span><span class="grp__d">${g.about}</span></span>
                ${toggle(`grp-${g.id}`, isOn, { label: `${g.label}: ${isOn ? 'on' : 'off'}` })}
              </div>
              <p class="grp__state"><span class="badge ${g.mode === 'google' ? 'badge--ok' : g.mode === 'local' ? 'badge--accent' : ''}">${groupState(g)}</span>${g.readOnly && !isOn ? html`<span class="muted small">Needs Google Health</span>` : ''}</p>
              ${g.note ? html`<p class="grp__note">${g.note}</p>` : ''}
              ${g.mode === 'local' && app.me.google?.state === 'ok' ? html`<button type="button" class="btn btn--tonal btn--s grp__act" data-allow="${g.id}">Allow in Google as well</button>` : ''}
              ${isOn ? html`<div class="grp__sub">
                <span class="grp__b"><span class="grp__t2">Include in summaries</span><span class="grp__d">${share[g.id] ? 'A written summary may read what this group holds. Your notes are never read.' : 'Off: a written summary never reads this group.'}</span></span>
                ${toggle(`ai-${g.id}`, Boolean(share[g.id]), { label: `Include ${g.label.toLowerCase()} in summaries` })}
              </div>` : ''}
            </div>`;
          })}
        </div>
      </div>`);
  }
  on(pane, 'change', 'input[name^="grp-"]', async (e, input) => {
    const id = input.name.slice(4);
    input.disabled = true;
    const ok = input.checked ? await turnOnGroup(id, { ret }) : await turnOffGroup(id);
    paint();
    if (ok) changed?.();
  });
  on(pane, 'change', 'input[name^="ai-"]', async (e, input) => {
    const id = input.name.slice(3);
    try {
      setMe(await api.patch('/api/settings', { aiShare: { [id]: input.checked } }));
      toast(input.checked ? 'Summaries may read this group from now on' : 'Summaries no longer read this group');
    } catch (err) { toastError(err); }
    paint();
  });
  on(pane, 'click', '[data-allow]', (e, b) => {
    const g = groupOf(b.dataset.allow);
    if (!g?.start) return;
    b.classList.add('is-busy');
    askGoogle(g.start, ret);
  });
  paint();
  return { paint };
}

/**
 * The same five groups as optional checkboxes, closed by default, for the
 * connect step of onboarding. Read the choice with pickedGroups(root).
 */
export function groupsPicker() {
  const groups = groupsOf();
  if (!groups.length) return '';
  return html`<details class="more grp-pick"><summary>${ic('right', { size: 's' })}More data (optional)</summary>
    <div class="stack">
      <p class="muted small">Leave these off unless you want them; you can turn any of them on later in Me, Connections. ${ALWAYS_PRIVATE}</p>
      <div class="group">${groups.map((g) => html`<label class="check check--row"><input type="checkbox" name="group" value="${g.id}"><span><span class="check__t">${g.label}</span><span class="check__d">${g.about}</span></span></label>`)}</div>
    </div>
  </details>`;
}
export const pickedGroups = (root) => [...root.querySelectorAll('input[name="group"]:checked')].map((x) => x.value);
