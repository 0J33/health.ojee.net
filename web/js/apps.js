/* Settings, Connections: the other apps (Hevy, Strava).

   Hevy is linked with the person's own API key (a Hevy Pro feature,
   Hevy -> Settings -> Developer); Strava with Strava's own sign-in. Each
   shows what it brings, what it sends, its switches, when it last synced
   and what went wrong, and a way to sync now or let go. The key itself
   never comes back from the server: only its last four characters. */

import { api } from './api.js';
import { app, refreshMe, listen } from './app.js';
import { html, mount, ic, banner, toast, toastError, on, busy, confirm, sheet, row, toggle, errText } from './ui.js';
import * as f from './format.js';

const sw = (name, on1, label, text, { disabled = false } = {}) => html`<div class="row row--top">
  <span class="row__body"><span class="row__t">${label}</span><span class="row__d">${text}</span></span>
  ${toggle(name, on1, { label, disabled })}
</div>`;

export function appsModule(root, { query, onLeave } = {}) {
  let hevy = null; let strava = null;

  function paintHevy() {
    const el = root.querySelector('[data-a="hevy"]');
    if (!hevy) { mount(el, ''); return; }
    const h = hevy;
    const st = h.settings || {};
    const err = h.lastError;
    mount(el, html`
      <div class="sec__head"><h2 class="h2">Hevy</h2><span class="badge ${h.connected ? 'badge--ok' : err?.code === 'hevy_key' || err?.code === 'hevy_pro' ? 'badge--bad' : ''}">${h.connected ? 'Linked' : err?.code === 'hevy_key' || err?.code === 'hevy_pro' ? 'Needs a new key' : 'Not linked'}</span></div>
      <div class="stack">
        ${!h.connected ? html`<p class="prose small">Link your Hevy account and your workouts, sets, exercise library, routines and body measurements are kept together with this app, both ways. It needs Hevy Pro: Hevy gives its API key to Pro accounts only.</p>
          ${err ? banner({ tone: 'bad', title: err.code === 'hevy_pro' ? 'Hevy refused the key: the Hevy API needs Hevy Pro' : 'Hevy stopped accepting the key', text: 'Make a new key in Hevy and link it again. What it brought is kept.' }) : ''}
          <form class="form hv-form" novalidate data-hevy-form>
            <div class="field"><label class="field__label" for="hv-key">Hevy API key</label>
              <input class="input" id="hv-key" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the key here" required>
              <p class="field__hint">In Hevy on the web: Settings, Developer, make an API key, then copy it. Kept encrypted here and never shown again.</p>
              <div data-err></div></div>
            <div class="btnrow"><button type="submit" class="btn">${ic('link', { size: 's' })}Link Hevy</button><a class="btn btn--ghost btn--s" href="https://hevy.com/settings?developer" target="_blank" rel="noopener">${ic('external', { size: 's' })}Open Hevy settings</a></div>
          </form>` : html`
          <div class="group">
            ${row({ iconName: 'me', title: 'Account', value: h.user?.username ? `@${h.user.username}` : 'Linked' })}
            ${row({ iconName: 'key', title: 'API key', value: h.last4 ? `····${h.last4}` : 'Set' })}
            ${row({ iconName: 'refresh', title: 'Last sync', value: h.lastSync ? f.ago(h.lastSync) : h.first?.done ? 'Not yet' : 'First sync running' })}
            ${row({ iconName: 'strength', title: 'From Hevy', value: `${f.plural(h.counts.workouts, 'workout')} · ${f.int(h.counts.templates)} exercises · ${f.plural(h.counts.routines, 'routine')}` })}
          </div>
          ${err ? banner({ tone: 'warn', title: 'The last sync did not finish', text: err.message || 'Hevy returned an error. It is tried again at the next sync.' }) : ''}
          <div>
            <p class="h3" data-style="margin:4px 4px 8px">What goes where</p>
            <div class="group" data-hevy-sw>
              ${sw('toGoogle', st.toGoogle !== false, 'Save Hevy workouts to Google Health', 'After a half-hour wait, and only when Google has nothing for that time already (Hevy may send it there itself through Health Connect).')}
              ${sw('pushWorkouts', st.pushWorkouts !== false, 'Send workouts logged here to Hevy', 'Strength workouts with exercises from your Hevy library, logged here after linking, go to Hevy, and so do their edits.')}
              ${sw('pullMeasures', st.pullMeasures !== false, 'Read body measurements from Hevy', 'Weight and body fat fill days that have none here; tape measurements show under Body measurements.')}
              ${sw('pushMeasures', st.pushMeasures !== false, 'Send weigh-ins and measurements to Hevy', 'Your weigh-ins, body fat and tape measurements from here, by day.')}
            </div>
          </div>
          <div class="btnrow">
            <button type="button" class="btn btn--tonal btn--s" data-hevy-sync>${ic('refresh', { size: 's' })}Sync now</button>
            <button type="button" class="btn btn--danger btn--s" data-hevy-off>${ic('unlink', { size: 's' })}Unlink</button>
          </div>`}
      </div>`);
  }

  function paintStrava() {
    const el = root.querySelector('[data-a="strava"]');
    if (!strava) { mount(el, ''); return; }
    const s = strava;
    const st = s.settings || {};
    mount(el, html`
      <div class="sec__head"><h2 class="h2">Strava</h2><span class="badge ${s.connected ? 'badge--ok' : s.lost ? 'badge--bad' : ''}">${s.connected ? 'Connected' : s.configured ? 'Not connected' : 'Not available'}</span></div>
      <div class="stack">
        ${!s.configured ? html`<p class="prose small">Strava has not been set up on this server yet. Ask ojee to finish the setup.</p>` : !s.connected ? html`
          <p class="prose small">Connect Strava and your runs, rides, swims and walks arrive here with their distance, pace, heart rate and route, the moment you save them on Strava. A session already here (from your watch) gets the Strava details instead of a second copy.</p>
          ${s.lost ? banner({ tone: 'bad', title: 'Strava stopped sharing', text: 'The connection was removed on Strava or has expired. Connect it again to carry on. What it brought is kept.' }) : ''}
          <div class="btnrow"><a class="btn" href="/auth/strava/start?return=/settings/connections" data-native>${ic('link', { size: 's' })}Connect Strava</a></div>` : html`
          <div class="group">
            ${row({ iconName: 'me', title: 'Athlete', value: s.athlete?.name || 'Connected' })}
            ${row({ iconName: 'refresh', title: 'Last sync', value: s.lastSync ? f.ago(s.lastSync) : 'First sync running' })}
            ${row({ iconName: 'route', title: 'From Strava', value: f.plural(s.count, 'activity', 'activities') })}
          </div>
          ${s.lastError ? banner({ tone: 'warn', title: 'The last sync did not finish', text: s.lastError.message || 'Strava returned an error. It is tried again at the next sync.' }) : ''}
          <div>
            <p class="h3" data-style="margin:4px 4px 8px">What goes where</p>
            <div class="group" data-strava-sw>
              ${sw('toGoogle', st.toGoogle !== false, 'Save Strava activities to Google Health', 'After a half-hour wait, and only when Google has nothing for that time already.')}
              ${sw('toStrava', !!st.toStrava, 'Send workouts finished here to Strava', 'Workouts logged here, detected and confirmed, or from Hevy, created on Strava. Off if Hevy or your watch already posts to Strava, or they would appear twice.')}
            </div>
          </div>
          <div class="btnrow">
            <button type="button" class="btn btn--tonal btn--s" data-strava-sync>${ic('refresh', { size: 's' })}Sync now</button>
            <button type="button" class="btn btn--danger btn--s" data-strava-off>${ic('unlink', { size: 's' })}Disconnect</button>
          </div>`}
      </div>`);
  }

  mount(root, html`<div class="stack stack--l"><div data-a="hevy"></div><div data-a="strava"></div></div>`);

  const load = async () => {
    const [h, s] = await Promise.all([api.get('/api/hevy').catch(() => null), api.get('/api/strava').catch(() => null)]);
    hevy = h; strava = s && { ...s, lost: !!(s.connected === false && s.lastError?.code === 'strava_auth') };
    paintHevy(); paintStrava();
    root.querySelectorAll('[data-style]').forEach((el) => { for (const decl of el.dataset.style.split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } el.removeAttribute('data-style'); });
  };

  on(root, 'submit', '[data-hevy-form]', async (e, form) => {
    e.preventDefault();
    const key = form.elements.key.value.trim();
    const slot = form.querySelector('[data-err]');
    if (!key) { mount(slot, html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>Paste the key from Hevy first.</span></p>`); return; }
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.post('/api/hevy/connect', { key }));
      if (r === undefined) return;
      hevy = r;
      toast('Hevy linked. Your workouts are on their way; the first sync takes a minute.', { ms: 7000 });
      await refreshMe().catch(() => {});
      await load();
    } catch (err) { mount(slot, html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>${errText(err)}</span></p>`); }
  });
  on(root, 'change', '[data-hevy-sw] input[type="checkbox"], [data-strava-sw] input[type="checkbox"]', async (e, input) => {
    const which = input.closest('[data-hevy-sw]') ? 'hevy' : 'strava';
    try {
      const r = await api.patch(`/api/${which}/settings`, { [input.name]: input.checked });
      if (which === 'hevy') hevy = r; else strava = { ...strava, ...r };
      toast('Saved');
    } catch (err) { input.checked = !input.checked; toastError(err); }
  });
  on(root, 'click', '[data-hevy-sync], [data-strava-sync]', async (e, b) => {
    const which = b.hasAttribute('data-hevy-sync') ? 'hevy' : 'strava';
    await busy(b, async () => {
      try {
        const r = await api.post(`/api/${which}/sync`, {});
        const x = r.result || {};
        if (which === 'hevy') hevy = r.hevy; else strava = { ...strava, ...r.strava };
        const n = (x.added || 0) + (x.merged || 0) + (x.updated || 0);
        toast(x.ok === false ? `${which === 'hevy' ? 'Hevy' : 'Strava'}: ${x.message || 'that did not work'}` : n || x.deleted || x.pushed ? `${f.plural(n, 'workout')} in${x.deleted ? `, ${x.deleted} removed` : ''}${x.pushed ? `, ${x.pushed} sent` : ''}` : 'Up to date', { tone: x.ok === false ? 'bad' : '' });
        paintHevy(); paintStrava();
      } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-hevy-off]', async () => {
    const yes = await confirm({ title: 'Unlink Hevy?', text: 'Nothing more comes from Hevy or goes to it, and the key is deleted here. The workouts and measurements it brought are kept. You can link it again any time.', yes: 'Unlink', danger: true });
    if (!yes) return;
    try { hevy = await api.post('/api/hevy/disconnect', {}); toast('Hevy unlinked'); await refreshMe().catch(() => {}); paintHevy(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-strava-off]', async () => {
    const yes = await confirm({ title: 'Disconnect Strava?', text: 'Strava stops sending activities here and this app gives its access back to Strava. The workouts it brought are kept.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    try { strava = await api.post('/api/strava/disconnect', {}); toast('Strava disconnected'); await refreshMe().catch(() => {}); paintStrava(); } catch (err) { toastError(err); }
  });

  // Back from Strava's sign-in.
  const sq = query?.get('strava');
  if (sq) {
    history.replaceState(history.state, '', '/settings/connections');
    if (sq === 'connected') toast('Strava connected. Your recent activities are on their way.', { ms: 7000 });
    else if (sq === 'cancelled') toast('Strava was not connected. You can try again any time.');
    else toast(query.get('message') || 'Strava could not be connected. Try again.', { tone: 'bad', ms: 9000 });
  }
  load();
  // A sync finished somewhere (the first one after linking, the webhook): read again.
  const stop = listen('changed', (what) => { if (what.includes('me') || what.includes('workouts')) load(); });
  onLeave?.(stop);
  return { reload: load };
}

export { sheet };
