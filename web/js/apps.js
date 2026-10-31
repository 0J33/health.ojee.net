/* Settings, Connections: the other apps (Hevy, Strava, a Xiaomi scale,
   Garmin).

   Hevy is linked with the person's own API key (a Hevy Pro feature,
   Hevy -> Settings -> Developer); Strava with Strava's own sign-in; the
   scale with a QR code scanned in Xiaomi Home (no Xiaomi password). Each
   shows what it brings, what it sends, its switches, when it last synced
   and what went wrong, and a way to sync now or let go. The key itself
   never comes back from the server: only its last four characters.
   Garmin is linked with a Personal API key the person makes on their own
   Garmin Connect account (server/garmin.js): tested at once, kept
   encrypted, read every sync, and let go of with or without its data. */

import { api } from './api.js';
import { app, refreshMe, listen } from './app.js';
import { html, mount, ic, banner, toast, toastError, on, busy, confirm, sheet, row, toggle, errText, seg } from './ui.js';
import * as f from './format.js';

const sw = (name, on1, label, text, { disabled = false } = {}) => html`<div class="row row--top">
  <span class="row__body"><span class="row__t">${label}</span><span class="row__d">${text}</span></span>
  ${toggle(name, on1, { label, disabled })}
</div>`;

export function appsModule(root, { query, onLeave, only = null } = {}) {
  // `only`: 'hevy' | 'strava' | 'scale' shows one of them (Connections, one screen each).
  const wants = (k) => !only || only === k;
  let hevy = null; let strava = null; let scale = null; let garmin = null;
  let scaleTimer = null; let garminTimer = null; let garminForm = false;
  const profileName = (pr) => pr?.name || (pr?.owner ? 'The account\'s owner' : 'Someone on the scale');

  function paintHevy() {
    const el = root.querySelector('[data-a="hevy"]');
    if (!el) return;
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
              ${sw('pushWorkouts', st.pushWorkouts !== false, 'Send workouts logged here to Hevy', 'Strength workouts logged here after linking go to Hevy, and so do their edits. Exercises from this app\'s library are matched to Hevy\'s own, or made in your Hevy library.')}
              ${sw('pullMeasures', st.pullMeasures !== false, 'Read body measurements from Hevy', 'Weight and body fat fill days that have none here; tape measurements show under Body measurements.')}
              ${sw('pushMeasures', st.pushMeasures !== false, 'Send weigh-ins and measurements to Hevy', 'Your weigh-ins, body fat and tape measurements from here, by day.')}
              ${sw('routines', st.routines !== false, 'Keep routines the same here and in Hevy', 'A routine made or changed in either place appears in the other, folders included. Exercises Hevy does not have are matched to its own, or made in your Hevy library.')}
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
    if (!el) return;
    if (!strava) { mount(el, ''); return; }
    const s = strava;
    const st = s.settings || {};
    mount(el, html`
      <div class="sec__head"><h2 class="h2">Strava</h2><span class="badge ${s.connected ? 'badge--ok' : s.lost ? 'badge--bad' : ''}">${s.connected ? 'Connected' : s.configured ? 'Not connected' : 'Not available'}</span></div>
      <div class="stack">
        ${!s.configured ? html`<p class="prose small">Strava has not been set up on this server yet. Ask ojee to finish the setup.</p>` : !s.connected ? html`
          <p class="prose small">Connect Strava and your runs, rides, swims and walks arrive here with their distance, pace, heart rate and route, the moment you save them on Strava. A session already here (from your watch) gets the Strava details instead of a second copy.</p>
          ${s.lost ? banner({ tone: 'bad', title: 'Strava stopped sharing', text: 'The connection was removed on Strava or has expired. Connect it again to carry on. What it brought is kept.' }) : ''}
          <div class="btnrow"><a class="btn" href="/auth/strava/start?return=/settings/connections/accounts/strava" data-native>${ic('link', { size: 's' })}Connect Strava</a></div>` : html`
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
              ${sw('routesToStrava', st.routesToStrava !== false, 'Send routes recorded here to Strava', 'Runs, walks, hikes and rides recorded in this app go to Strava with their map, once.')}
              ${sw('streams', st.streams !== false, 'Bring in the whole route of each activity', 'The full GPS route, so Strava activities get the map, splits and charts here. A couple a sync, within Strava\'s limits; opening one reads it at once.')}
              ${sw('toStrava', !!st.toStrava, 'Send other workouts finished here to Strava', 'Workouts logged here, detected and confirmed, or from Hevy, created on Strava. Off if Hevy or your watch already posts to Strava, or they would appear twice.')}
            </div>
          </div>
          <div class="btnrow">
            <button type="button" class="btn btn--tonal btn--s" data-strava-sync>${ic('refresh', { size: 's' })}Sync now</button>
            <button type="button" class="btn btn--danger btn--s" data-strava-off>${ic('unlink', { size: 's' })}Disconnect</button>
          </div>`}
      </div>`);
  }

  function paintScale() {
    const el = root.querySelector('[data-a="scale"]');
    if (!el) return;
    if (!scale) { mount(el, ''); return; }
    const x = scale;
    const st = x.settings || {};
    const q = x.pending;
    const choosing = x.connected && !x.profile && x.profiles.length > 1;
    const badge = x.connected ? (choosing ? ['', 'Choose who you are'] : ['badge--ok', 'Connected']) : x.lost ? ['badge--bad', 'Signed out'] : ['', 'Not connected'];
    mount(el, html`
      <div class="sec__head"><h2 class="h2">Xiaomi scale</h2><span class="badge ${badge[0]}">${badge[1]}</span></div>
      <div class="stack">
        ${!x.connected ? html`
          <p class="prose small">Connect the Xiaomi account your scale (the Body Composition Scale S400) is in, and every weigh-in arrives here: weight, body fat, and the rest the scale works out (muscle, water, bone, protein, visceral fat, resting energy, metabolic age). You sign in by scanning a code in Xiaomi Home; your Xiaomi password never comes here.</p>
          ${x.lost ? banner({ tone: 'bad', title: 'Xiaomi signed this site out', text: 'The sign-in was ended on Xiaomi\'s side or has expired. Connect it again to carry on. What it brought is kept.' }) : ''}
          ${q?.state === 'waiting' ? html`
            <div class="xm-qr">
              <img class="xm-qr__img" src="${q.qr}" alt="Sign-in code for Xiaomi Home" width="220" height="220">
              <ol class="prose small xm-qr__steps">
                <li>Open Xiaomi Home on your phone, signed in to the account the scale is in.</li>
                <li>Tap the plus at the top, then Scan, and scan this code.</li>
                <li>Confirm the sign-in. This page carries on by itself.</li>
              </ol>
            </div>
            <div class="btnrow">
              <a class="btn btn--ghost btn--s" href="${q.loginUrl}" target="_blank" rel="noopener">${ic('external', { size: 's' })}On your phone? Sign in here instead</a>
              <button type="button" class="btn btn--tonal btn--s" data-xm-cancel>${ic('x', { size: 's' })}Cancel</button>
            </div>` : html`
            ${q?.state === 'expired' ? banner({ tone: 'warn', title: 'The code expired', text: 'Codes last five minutes. Make a new one.' }) : ''}
            ${q?.state === 'error' ? banner({ tone: 'bad', title: 'The sign-in did not finish', text: q.message || 'Xiaomi returned an error. Try again.' }) : ''}
            <div class="btnrow"><button type="button" class="btn" data-xm-start>${ic('scan', { size: 's' })}${q ? 'Make a new code' : 'Connect the scale'}</button></div>`}` : choosing ? html`
          <p class="prose small">More than one person uses this scale. Which one are you? Only your weigh-ins come here; if you pick again later, the other person's are taken away again, here and in Google.</p>
          <div class="group">
            ${x.profiles.map((pr) => html`<button type="button" class="row" data-xm-profile="${pr.id}">
              <span class="row__ic">${ic('me')}</span>
              <span class="row__body"><span class="row__t">${profileName(pr)}${pr.owner ? html` <span class="muted">(account owner)</span>` : ''}</span><span class="row__d">${f.plural(pr.n, 'weigh-in')}${pr.lastAt ? `, last ${f.ago(pr.lastAt)}` : ''}</span></span>
              <span class="row__v">${f.weight(pr.lastKg)}</span>
            </button>`)}
          </div>
          <div class="btnrow"><button type="button" class="btn btn--danger btn--s" data-xm-off>${ic('unlink', { size: 's' })}Disconnect</button></div>` : html`
          <div class="group">
            ${row({ iconName: 'me', title: 'Xiaomi account', value: `${x.account || 'Connected'}${x.profiles.length > 1 ? `, ${profileName(x.profiles.find((pr) => pr.id === x.profile))}` : ''}` })}
            ${row({ iconName: 'refresh', title: 'Last sync', value: x.lastSync ? f.ago(x.lastSync) : 'First sync running' })}
            ${row({ iconName: 'scale', title: 'From the scale', value: f.plural(x.count, 'weigh-in') })}
            ${x.last ? row({ iconName: 'history', title: 'Latest', value: `${f.weight(x.last.weightKg)}${f.isNum(x.last.fatPct) ? `, ${f.dec1(x.last.fatPct)}% fat` : ''}, ${f.ago(x.last.t)}` }) : ''}
          </div>
          ${x.lastError ? banner({ tone: 'warn', title: 'The last sync did not finish', text: x.lastError.message || 'Xiaomi returned an error. It is tried again at the next sync.' }) : ''}
          <div>
            <p class="h3" data-style="margin:4px 4px 8px">What goes where</p>
            <div class="group" data-xm-sw>
              ${sw('toGoogle', st.toGoogle !== false, 'Save weigh-ins to Google Health', 'Weight and body fat, when Google has nothing for that time already. Xiaomi itself only sends them to Apple Health.')}
            </div>
            <p class="prose small muted" data-style="margin:8px 4px 0">With Hevy linked, weigh-ins from the scale go to Hevy too. Muscle, water and the rest stay here, under Body composition.</p>
          </div>
          <div class="btnrow">
            <button type="button" class="btn btn--tonal btn--s" data-xm-sync>${ic('refresh', { size: 's' })}Sync now</button>
            ${x.profiles.length > 1 ? html`<button type="button" class="btn btn--ghost btn--s" data-xm-who>${ic('users', { size: 's' })}Not you?</button>` : ''}
            <button type="button" class="btn btn--danger btn--s" data-xm-off>${ic('unlink', { size: 's' })}Disconnect</button>
          </div>`}
      </div>`);
    clearTimeout(scaleTimer);
    // While a code waits to be scanned, look again every few seconds.
    if (q?.state === 'waiting' || (x.connected && !x.lastSync)) scaleTimer = setTimeout(() => loadScale().catch(() => {}), 2500);
  }
  /* ── Garmin ── */
  const KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
  const garminCounts = (c) => [c.days ? f.plural(c.days, 'day') : '', c.nights ? f.plural(c.nights, 'night') : '', c.activities ? f.plural(c.activities, 'activity', 'activities') : '', c.weighIns ? f.plural(c.weighIns, 'weigh-in') : ''].filter(Boolean).join(' · ') || 'Nothing yet';
  const BACK = [['30', '30 days'], ['90', '90 days'], ['365', 'A year']];
  function garminKeyForm(g, { replacing = false } = {}) {
    return html`<form class="form gm-form" novalidate data-garmin-form>
      ${replacing ? '' : html`<ol class="howto gm-steps">
        <li><span>Open Garmin Connect in a browser and sign in with the account your watch uses.</span></li>
        <li><span>Under Personal API key, choose how long the key lasts (30, 90 or 180 days, or a year) and make it.</span></li>
        <li><span>Copy the key. Garmin shows it only once.</span></li>
        <li><span>Paste it here. This page tests it with Garmin straight away.</span></li>
      </ol>
      <div class="btnrow"><a class="btn btn--tonal btn--s" href="${KEY_PAGE}" target="_blank" rel="noopener">${ic('external', { size: 's' })}Open Garmin Connect's key page</a></div>`}
      <div class="field"><label class="field__label" for="gm-key">Garmin key</label>
        <input class="input" id="gm-key" name="key" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste the key here" required>
        <p class="field__hint">Kept encrypted here and never shown again: only its last four characters. Your Garmin password never comes here.</p>
        <div data-err></div></div>
      <div class="field"><span class="field__label" id="gm-days-l">How long did you make it for?</span>
        ${seg('gm-days', [['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', 'A year']], '', { label: 'How long the key lasts' })}
        <p class="field__hint">So this page can remind you before it runs out: Garmin does not say. Not sure? Leave it.</p></div>
      ${replacing ? '' : html`<div class="field"><span class="field__label">History to bring in</span>
        ${seg('gm-back', BACK, String(g?.settings?.backfill || 30), { label: 'How much history to bring in' })}
        <p class="field__hint">A week at a time, gently, in the background. A year takes most of a day.</p></div>`}
      <div class="btnrow"><button type="submit" class="btn">${ic('link', { size: 's' })}${replacing ? 'Test and replace' : 'Test and connect'}</button>${replacing ? html`<button type="button" class="btn btn--ghost btn--s" data-gm-cancel>Cancel</button>` : ''}</div>
    </form>`;
  }
  function paintGarmin() {
    const el = root.querySelector('[data-a="garmin"]');
    if (!el) return;
    if (!garmin) { mount(el, ''); return; }
    const g = garmin;
    const now = Date.now();
    const soon = g.connected && f.isNum(g.keyExpiresAt) && g.keyExpiresAt - now < 7 * 86_400_000;
    const badge = g.connected ? (soon ? ['badge--warn', 'Key runs out soon'] : ['badge--ok', 'Connected']) : g.lost ? ['badge--bad', 'Needs a new key'] : ['', 'Not connected'];
    const both = app.me.sources?.google;
    const r = g.lastResult;
    mount(el, html`
      <div class="sec__head"><h2 class="h2">Garmin</h2><span class="badge ${badge[0]}">${badge[1]}</span></div>
      <div class="stack">
        ${!g.connected ? html`
          <p class="prose small">Read your Garmin watch directly, with no Google account needed: steps, heart rate, sleep with its stages and Garmin's sleep score, HRV, blood oxygen, breathing, stress, Body Battery, activities and weigh-ins. You make a key on your own Garmin Connect account and paste it here.</p>
          ${g.lost ? banner({ tone: 'bad', title: 'Garmin stopped accepting your key', text: `${g.lost.message || 'It has expired or was deleted.'} Make a new one and paste it below. What it brought is kept.` }) : ''}
          ${g.kept && !g.lost ? banner({ iconName: 'info', title: 'What Garmin brought is still here', text: 'Nothing new arrives until you paste a key again.' }) : ''}
          ${garminKeyForm(g)}` : html`
          <div class="group">
            ${row({ iconName: 'key', title: 'Key', value: g.last4 ? `····${g.last4}` : 'Set' })}
            ${row({ iconName: 'calendar', title: 'Key runs out', value: f.isNum(g.keyExpiresAt) ? `${f.dateFull(f.instDay(g.keyExpiresAt))}${g.keyExpiresKnown ? '' : ', as you said'}` : 'Not known' })}
            ${row({ iconName: 'refresh', title: 'Last sync', value: g.lastSync ? f.ago(g.lastSync) : 'First sync running' })}
            ${r ? row({ iconName: 'data', title: 'Last read', value: r.ok ? `${f.plural(r.days, 'day')}, ${f.plural(r.nights, 'night')}, ${f.plural(r.activities, 'activity', 'activities')}` : 'Did not finish' }) : ''}
            ${row({ iconName: 'history', title: 'History', value: g.backfill.done ? `Since ${f.dayShort(g.backfill.target)}` : g.backfill.backTo ? `Back to ${f.dayShort(g.backfill.backTo)}, going to ${f.dayShort(g.backfill.target)}` : 'Starting' })}
            ${row({ iconName: 'watch', title: 'From Garmin', value: garminCounts(g.counts) })}
          </div>
          ${soon ? banner({ tone: 'warn', iconName: 'clock', title: `Your key runs out on ${f.dateFull(f.instDay(g.keyExpiresAt))}`, text: 'Make a new one in Garmin Connect and replace it here before then, and nothing is missed.', actions: html`<button type="button" class="btn btn--s" data-gm-replace>Replace key</button>` }) : ''}
          ${g.retryAt ? banner({ tone: 'warn', iconName: 'clock', title: 'Garmin asked this site to slow down', text: `Reading carries on by itself at ${f.clock(g.retryAt)}. There is nothing you need to do.` })
            : g.lastError ? banner({ tone: 'warn', title: 'The last sync did not finish', text: g.lastError.message || 'Garmin returned an error. It is tried again at the next sync.' }) : ''}
          ${g.unavailable?.length ? html`<p class="muted small" data-style="margin:0 4px">Garmin did not answer for some of it just now (${g.unavailable.join(', ')}). Those are asked again tomorrow; the rest carries on.</p>` : ''}
          ${garminForm ? garminKeyForm(g, { replacing: true }) : ''}
          ${both ? html`<div>
            <p class="h3" data-style="margin:4px 4px 8px">When Google Health has a number too</p>
            <div class="group" role="radiogroup" aria-label="Which source wins">
              <label class="radio"><input type="radio" name="gm-prefer" value="garmin" ${g.settings.prefer !== 'google' ? 'checked' : ''}><span><span class="radio__t">Garmin first</span><br><span class="radio__d">Each day's steps, sleep, heart and the rest come from Garmin; Google fills what Garmin does not have.</span></span></label>
              <label class="radio"><input type="radio" name="gm-prefer" value="google" ${g.settings.prefer === 'google' ? 'checked' : ''}><span><span class="radio__t">Google first</span><br><span class="radio__d">Google's numbers stay; Garmin fills what Google does not have.</span></span></label>
            </div>
            <p class="muted small" data-style="margin:8px 4px 0">Nothing is added up across the two, so nothing counts twice. A night or a workout both recorded is kept once. Stress and Body Battery come from Garmin either way.</p>
          </div>` : ''}
          <div>
            <p class="h3" data-style="margin:4px 4px 8px">History to bring in</p>
            ${seg('gm-history', BACK, String(g.settings.backfill), { label: 'How much history to bring in' })}
          </div>
          <div class="btnrow">
            <button type="button" class="btn btn--tonal btn--s" data-gm-sync>${ic('refresh', { size: 's' })}Sync now</button>
            ${garminForm ? '' : html`<button type="button" class="btn btn--tonal btn--s" data-gm-replace>${ic('key', { size: 's' })}Replace key</button>`}
            <button type="button" class="btn btn--danger btn--s" data-gm-off>${ic('unlink', { size: 's' })}Disconnect</button>
          </div>`}
      </div>`);
    clearTimeout(garminTimer);
    // The first read runs in the background: look again until it is in.
    if (g.connected && !g.lastSync) garminTimer = setTimeout(() => loadGarmin().catch(() => {}), 2500);
  }
  const loadGarmin = async () => {
    garmin = await api.get('/api/garmin').catch(() => garmin);
    paintGarmin();
    tidy();
  };

  const loadScale = async () => {
    scale = await api.get('/api/xiaomi').catch(() => scale);
    paintScale();
    tidy();
  };
  const tidy = () => root.querySelectorAll('[data-style]').forEach((el) => { for (const decl of el.dataset.style.split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } el.removeAttribute('data-style'); });

  mount(root, html`<div class="stack stack--l">${['garmin', 'hevy', 'strava', 'scale'].filter((k) => (k === 'garmin' ? only === 'garmin' : wants(k))).map((k) => html`<div data-a="${k}"></div>`)}</div>`);

  const load = async () => {
    const [h, s, x, g] = await Promise.all([wants('hevy') ? api.get('/api/hevy').catch(() => null) : null, wants('strava') ? api.get('/api/strava').catch(() => null) : null, wants('scale') ? api.get('/api/xiaomi').catch(() => null) : null, only === 'garmin' ? api.get('/api/garmin').catch(() => null) : null]);
    hevy = h; strava = s && { ...s, lost: !!(s.connected === false && s.lastError?.code === 'strava_auth') }; scale = x; garmin = g;
    paintHevy(); paintStrava(); paintScale(); paintGarmin();
    tidy();
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

  /* ── the scale ── */
  on(root, 'click', '[data-xm-start]', async (e, b) => {
    await busy(b, async () => {
      try { scale = await api.post('/api/xiaomi/start', {}); paintScale(); } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-xm-cancel]', async () => {
    try { scale = await api.post('/api/xiaomi/cancel', {}); paintScale(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-xm-profile]', async (e, b) => {
    await busy(b, async () => {
      try {
        const r = await api.post('/api/xiaomi/profile', { profile: b.dataset.xmProfile });
        scale = r.xiaomi;
        toast(r.result?.ok === false ? `Xiaomi: ${r.result.message || 'that did not work'}` : `${f.plural(r.result?.added || 0, 'weigh-in')} in`, { tone: r.result?.ok === false ? 'bad' : '' });
        paintScale(); tidy();
      } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-xm-who]', () => { scale = { ...scale, profile: null }; paintScale(); });
  on(root, 'change', '[data-xm-sw] input[type="checkbox"]', async (e, input) => {
    try { scale = await api.patch('/api/xiaomi/settings', { [input.name]: input.checked }); toast('Saved'); } catch (err) { input.checked = !input.checked; toastError(err); }
  });
  on(root, 'click', '[data-xm-sync]', async (e, b) => {
    await busy(b, async () => {
      try {
        const r = await api.post('/api/xiaomi/sync', {});
        const x = r.result || {};
        scale = r.xiaomi;
        toast(x.ok === false ? `Xiaomi: ${x.message || 'that did not work'}` : x.added ? `${f.plural(x.added, 'weigh-in')} in` : 'Up to date', { tone: x.ok === false ? 'bad' : '' });
        paintScale(); tidy();
      } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-xm-off]', async () => {
    const yes = await confirm({ title: 'Disconnect the scale?', text: 'Nothing more comes from Xiaomi and the sign-in is deleted here. The weigh-ins it brought are kept. You can connect it again any time.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    try { scale = await api.post('/api/xiaomi/disconnect', { keepData: true }); toast('Scale disconnected'); await refreshMe().catch(() => {}); paintScale(); } catch (err) { toastError(err); }
  });

  /* ── Garmin ── */
  const segOf = (form, name) => form.querySelector(`[data-seg="${name}"][aria-pressed="true"]`)?.dataset.value ?? '';
  on(root, 'click', '[data-seg^="gm-"]', async (e, b) => {
    const name = b.dataset.seg;
    // The key's lifetime can be left unsaid: a second tap clears it.
    const off = name === 'gm-days' && b.getAttribute('aria-pressed') === 'true';
    for (const o of root.querySelectorAll(`[data-seg="${name}"]`)) o.setAttribute('aria-pressed', String(o === b && !off));
    if (name !== 'gm-history') return;
    try { garmin = await api.patch('/api/garmin/settings', { backfill: Number(b.dataset.value) }); toast(`History: ${b.textContent.trim().toLowerCase()}. It comes in a week at a time.`); paintGarmin(); tidy(); } catch (err) { toastError(err); }
  });
  on(root, 'submit', '[data-garmin-form]', async (e, form) => {
    e.preventDefault();
    const key = form.elements.key.value.trim();
    const slot = form.querySelector('[data-err]');
    if (!key) { mount(slot, html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>Paste the key from Garmin Connect first.</span></p>`); return; }
    const days = segOf(form, 'gm-days'); const back = segOf(form, 'gm-back');
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.post('/api/garmin/connect', { key, ...(days ? { keyDays: Number(days) } : {}), ...(back ? { backfill: Number(back) } : {}) }));
      if (r === undefined) return;
      garmin = r; garminForm = false;
      toast('Garmin accepted the key. The last few days are on their way; older ones follow a week at a time.', { ms: 7000 });
      await refreshMe().catch(() => {});
      paintGarmin(); tidy();
    } catch (err) { mount(slot, html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>${errText(err)}</span></p>`); }
  });
  on(root, 'click', '[data-gm-replace]', () => { garminForm = true; paintGarmin(); tidy(); root.querySelector('#gm-key')?.focus(); });
  on(root, 'click', '[data-gm-cancel]', () => { garminForm = false; paintGarmin(); tidy(); });
  on(root, 'change', 'input[name="gm-prefer"]', async (e, input) => {
    try { garmin = await api.patch('/api/garmin/settings', { prefer: input.value }); toast(input.value === 'google' ? 'Google first, Garmin fills the gaps' : 'Garmin first, Google fills the gaps'); await refreshMe().catch(() => {}); } catch (err) { toastError(err); paintGarmin(); }
  });
  on(root, 'click', '[data-gm-sync]', async (e, b) => {
    await busy(b, async () => {
      try {
        const r = await api.post('/api/garmin/sync', {});
        const x = r.result || {};
        garmin = r.garmin;
        toast(x.ok === false ? `Garmin: ${x.message || 'that did not work'}` : `Read ${f.plural(x.days || 0, 'day')} and ${f.plural(x.nights || 0, 'night')} from Garmin`, { tone: x.ok === false ? 'bad' : '' });
        paintGarmin(); tidy();
      } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-gm-off]', () => {
    const s = sheet({
      title: 'Disconnect Garmin?',
      body: html`<p class="prose">The key is deleted here and nothing more is read from Garmin. What it already brought can stay, or go with it.</p>`,
      foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button>
        <button type="button" class="btn btn--tonal" data-gm-keep="1">Keep what it brought</button>
        <button type="button" class="btn btn--solid-danger" data-gm-keep="0">Remove it too</button>`,
    });
    s.el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-gm-keep]');
      if (!b) return;
      const keepData = b.dataset.gmKeep === '1';
      await busy(b, async () => {
        try {
          garmin = await api.post('/api/garmin/disconnect', { keepData });
          s.close();
          toast(keepData ? 'Garmin disconnected. What it brought is kept.' : 'Garmin disconnected, and what it brought is removed.');
          await refreshMe().catch(() => {});
          paintGarmin(); tidy();
        } catch (err) { toastError(err); }
      });
    });
  });

  // Back from Strava's sign-in.
  const sq = query?.get('strava');
  if (sq) {
    history.replaceState(history.state, '', location.pathname);
    if (sq === 'connected') toast('Strava connected. Your recent activities are on their way.', { ms: 7000 });
    else if (sq === 'cancelled') toast('Strava was not connected. You can try again any time.');
    else toast(query.get('message') || 'Strava could not be connected. Try again.', { tone: 'bad', ms: 9000 });
  }
  load();
  // A sync finished somewhere (the first one after linking, the webhook): read again.
  const stop = listen('changed', (what) => { if (what.includes('me') || what.includes('workouts')) load(); });
  onLeave?.(() => { stop(); clearTimeout(scaleTimer); clearTimeout(garminTimer); });
  return { reload: load };
}

export { sheet };
