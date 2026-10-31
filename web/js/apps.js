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
import { html, raw, esc, mount, ic, toast, toastError, on, busy, confirm, sheet, toggle, errText, seg } from './ui.js';
import * as f from './format.js';

/* ── the settings row kit (Me and everything under it) ──────────────
   Grouped rows like iOS Settings: a grey label, a rounded group, rows of
   an icon in a soft circle, a title with one grey line, a value or a
   control, a chevron when it goes deeper. CSS: css/b-me.css (.st-*). */

/** A group of rows. */
export const stGrp = (inner, attrs = '') => html`<div class="st-grp" ${raw(attrs)}>${inner}</div>`;
/** The small heading above a group, with an optional note at the right. */
export const stLab = (text, note = '') => html`<p class="st-lab"><span>${text}</span>${note !== '' && note !== null ? html`<span class="st-lab__n">${note}</span>` : ''}</p>`;
/** One short grey sentence under a group. */
export const stNote = (text) => html`<p class="st-note">${text}</p>`;
/** A status: a coloured dot and a word. tone: ok | warn | bad | accent | off. */
export const stDot = (tone, text) => html`<span class="st-dot st-dot--${tone}">${text}</span>`;

/**
 * One row. `href` makes a link, `action` (or `btn`) a button, otherwise a
 * plain row. `end` is a control at the right (a switch); `chev` defaults
 * to true for links and buttons.
 */
export function stRow({ href = '', action = '', btn = false, attrs = '', icon = '', fam = '', media = '', title, sub = '', subBad = false, value = '', end = '', chev = null, danger = false, top = false, external = false }) {
  const tag = href ? 'a' : action || btn ? 'button' : 'div';
  const a = href ? `href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ''}` : tag === 'button' ? `type="button"${action ? ` data-action="${esc(action)}"` : ''}` : '';
  const showChev = chev ?? (tag !== 'div');
  return html`<${raw(tag)} class="st-row ${danger ? 'st-row--danger' : ''} ${top ? 'st-row--top' : ''}" ${raw(a)} ${raw(attrs)}>
    ${media}${icon ? html`<span class="st-ic ${fam ? `st-ic--${fam}` : ''}">${ic(icon)}</span>` : ''}
    <span class="st-b"><span class="st-t">${title}</span>${sub !== '' && sub !== null && sub !== undefined ? html`<span class="st-s ${subBad ? 'st-s--bad' : ''}">${sub}</span>` : ''}</span>
    ${value !== '' && value !== null && value !== undefined ? html`<span class="st-v">${value}</span>` : ''}${end}
    ${showChev ? html`<span class="st-chev">${ic(external ? 'external' : 'chev_r', { size: 's' })}</span>` : ''}
  </${raw(tag)}>`;
}
/** A row with a switch. */
export const stSwitch = (name, isOn, title, sub = '', { icon = '', fam = '', disabled = false, label = '' } = {}) => stRow({ icon, fam, title, sub, end: toggle(name, isOn, { label: label || title, disabled }) });
/** Choose-one rows: a tick at the right of the chosen one. */
export const stRadio = (name, value, checked, title, sub = '', { disabled = false } = {}) => html`<label class="st-row st-radio">
  <span class="st-b"><span class="st-t">${title}</span>${sub ? html`<span class="st-s">${sub}</span>` : ''}</span>
  <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="st-tick" aria-hidden="true">${ic('check')}</span>
</label>`;
/** The top of a brand's page: its icon, then its state big and one line under it (the page title already names it). */
export const stHead = ({ icon, fam = '', title = '', status = '', sub = '' }) => html`<div class="st-head" role="group" aria-label="${title}">
  <span class="st-ic ${fam ? `st-ic--${fam}` : ''}">${ic(icon)}</span>
  <div class="st-b"><p class="st-head__t">${status}</p>${sub ? html`<p class="st-head__s">${sub}</p>` : ''}</div>
</div>`;
/** A sheet that only explains: a title, then the words. */
export const stInfo = (title, body) => sheet({ title, body: html`<div class="st-sheet">${body}</div>` });
/** Words that need more than a line, in a group. */
export const stProse = (inner) => stGrp(html`<div class="st-prose">${inner}</div>`);
/** A choose-one sheet: rows with a tick; picking one saves and closes. Resolves the value, or undefined. */
export function stPick({ title, lead = '', options, current, foot = '' }) {
  const s = sheet({
    title,
    body: html`<div class="st-sheet">${lead ? html`<p class="st-lead">${lead}</p>` : ''}${stGrp(options.map(([v, t, d]) => stRadio('st-pick', v, String(v) === String(current), t, d || '')))}${foot ? stNote(foot) : ''}</div>`,
  });
  s.el.addEventListener('change', (e) => { if (e.target.name === 'st-pick') setTimeout(() => s.close(e.target.value), 160); });
  return s.closed;
}

/** "Last try failed", "Sync" and the like: a calm warning row. */
const warnRow = (title, text) => stRow({ icon: 'alert', fam: 'bad', title, sub: text, top: true });
const sw = (name, on1, label, text, { disabled = false } = {}) => stSwitch(name, on1, label, text, { disabled });
const errSlot = (text) => html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>${text}</span></p>`;

export function appsModule(root, { query, onLeave, only = null } = {}) {
  // `only`: 'hevy' | 'strava' | 'scale' shows one of them (Connections, one screen each).
  const wants = (k) => !only || only === k;
  let hevy = null; let strava = null; let scale = null; let garmin = null;
  let scaleTimer = null; let garminTimer = null;
  const profileName = (pr) => pr?.name || (pr?.owner ? 'The account\'s owner' : 'Someone on the scale');

  function paintHevy() {
    const el = root.querySelector('[data-a="hevy"]');
    if (!el) return;
    if (!hevy) { mount(el, ''); return; }
    const h = hevy;
    const st = h.settings || {};
    const err = h.lastError;
    const refused = err?.code === 'hevy_key' || err?.code === 'hevy_pro';
    mount(el, html`<div class="st-page">
      ${stHead({ icon: 'strength', fam: 'energy', title: 'Hevy', status: h.connected ? stDot('ok', 'Linked') : refused ? stDot('bad', 'Needs a new key') : stDot('off', 'Not linked'), sub: h.connected && h.user?.username ? `@${h.user.username}` : '' })}
      ${!h.connected ? html`
        <p class="st-lead" data-style="margin-top:14px">Your workouts, routines and body measurements, kept the same here and in Hevy. Needs Hevy Pro.</p>
        ${err ? html`<div data-style="margin-top:12px">${stGrp(warnRow(err.code === 'hevy_pro' ? 'Hevy refused the key: the Hevy API needs Hevy Pro' : 'Hevy stopped accepting the key', 'Make a new key in Hevy and link it again. What it brought is kept.'))}</div>` : ''}
        <form novalidate data-hevy-form>
          ${stLab('API key')}
          ${stGrp(html`<div class="st-form"><div class="field">
              <input class="input" id="hv-key" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the key here" aria-label="Hevy API key" required>
              <p class="field__hint">Kept encrypted. Never shown again.</p><div data-err></div></div></div>
            ${stRow({ href: 'https://hevy.com/settings?developer', external: true, icon: 'key', title: 'Where to find it', sub: 'Hevy on the web: Settings, Developer' })}`)}
          <div class="st-cta"><button type="submit" class="btn">${ic('link', { size: 's' })}Link Hevy</button></div>
        </form>` : html`
        ${stLab('Status')}
        ${stGrp(html`
          ${stRow({ icon: 'key', title: 'API key', value: h.last4 ? `•••• ${h.last4}` : 'Set' })}
          ${stRow({ icon: 'refresh', title: 'Last sync', value: h.lastSync ? f.ago(h.lastSync) : h.first?.done ? 'Not yet' : 'First sync running' })}
          ${stRow({ icon: 'strength', title: 'From Hevy', sub: `${f.plural(h.counts.workouts, 'workout')} · ${f.int(h.counts.templates)} exercises · ${f.plural(h.counts.routines, 'routine')}` })}
          ${err ? warnRow('The last sync did not finish', err.message || 'Hevy returned an error. It is tried again at the next sync.') : ''}`)}
        ${stLab('What goes where')}
        ${stGrp(html`
          ${sw('toGoogle', st.toGoogle !== false, 'Hevy workouts to Google Health', 'When Google has nothing for that time.')}
          ${sw('pushWorkouts', st.pushWorkouts !== false, 'Workouts logged here to Hevy', 'Strength workouts, and their edits.')}
          ${sw('pullMeasures', st.pullMeasures !== false, 'Body measurements from Hevy', 'They fill days that have none here.')}
          ${sw('pushMeasures', st.pushMeasures !== false, 'Weigh-ins and measurements to Hevy', 'Weight, body fat and tape measurements.')}
          ${sw('routines', st.routines !== false, 'Routines in both places', 'Made or changed in either, folders too.')}`, 'data-hevy-sw')}
        ${stGrp(stRow({ btn: true, attrs: 'data-hevy-about', icon: 'info', title: 'How syncing with Hevy works' }))}
        ${stGrp(html`
          ${stRow({ btn: true, attrs: 'data-hevy-sync', icon: 'refresh', title: 'Sync now', chev: false })}
          ${stRow({ btn: true, attrs: 'data-hevy-off', icon: 'unlink', title: 'Unlink Hevy', danger: true, chev: false })}`)}`}
    </div>`);
  }

  function paintStrava() {
    const el = root.querySelector('[data-a="strava"]');
    if (!el) return;
    if (!strava) { mount(el, ''); return; }
    const s = strava;
    const st = s.settings || {};
    mount(el, html`<div class="st-page">
      ${stHead({ icon: 'route', fam: 'energy', title: 'Strava', status: s.connected ? stDot('ok', 'Connected') : s.lost ? stDot('bad', 'Stopped sharing') : s.configured ? stDot('off', 'Not connected') : stDot('warn', 'Not available'), sub: s.connected && s.athlete?.name ? s.athlete.name : '' })}
      ${!s.configured ? html`<p class="st-lead" data-style="margin-top:14px">Strava is not set up on this server yet. Ask ojee to finish the setup.</p>` : !s.connected ? html`
        <p class="st-lead" data-style="margin-top:14px">Runs, rides, swims and walks arrive with their pace, heart rate and route as soon as you save them on Strava.</p>
        ${s.lost ? html`<div data-style="margin-top:12px">${stGrp(warnRow('Strava stopped sharing', 'The connection was removed on Strava or has expired. Connect again to carry on. What it brought is kept.'))}</div>` : ''}
        ${stGrp(stRow({ btn: true, attrs: 'data-strava-about', icon: 'info', title: 'What comes from Strava' }), 'data-style="margin-top:16px"')}
        <div class="st-cta"><a class="btn" href="/auth/strava/start?return=/settings/connections/accounts/strava" data-native>${ic('link', { size: 's' })}Connect Strava</a></div>` : html`
        ${stLab('Status')}
        ${stGrp(html`
          ${stRow({ icon: 'refresh', title: 'Last sync', value: s.lastSync ? f.ago(s.lastSync) : 'First sync running' })}
          ${stRow({ icon: 'route', title: 'From Strava', value: f.plural(s.count, 'activity', 'activities') })}
          ${s.lastError ? warnRow('The last sync did not finish', s.lastError.message || 'Strava returned an error. It is tried again at the next sync.') : ''}`)}
        ${stLab('What goes where')}
        ${stGrp(html`
          ${sw('toGoogle', st.toGoogle !== false, 'Strava activities to Google Health', 'When Google has nothing for that time.')}
          ${sw('routesToStrava', st.routesToStrava !== false, 'Routes recorded here to Strava', 'With their map, once.')}
          ${sw('streams', st.streams !== false, 'The whole route of each activity', 'Map, splits and charts here.')}
          ${sw('toStrava', !!st.toStrava, 'Other workouts to Strava', 'Off if Hevy or your watch already posts there.')}`, 'data-strava-sw')}
        ${stGrp(stRow({ btn: true, attrs: 'data-strava-about', icon: 'info', title: 'How syncing with Strava works' }))}
        ${stGrp(html`
          ${stRow({ btn: true, attrs: 'data-strava-sync', icon: 'refresh', title: 'Sync now', chev: false })}
          ${stRow({ btn: true, attrs: 'data-strava-off', icon: 'unlink', title: 'Disconnect Strava', danger: true, chev: false })}`)}`}
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
    const status = x.connected ? (choosing ? stDot('warn', 'Choose who you are') : stDot('ok', 'Connected')) : x.lost ? stDot('bad', 'Signed out') : stDot('off', 'Not connected');
    mount(el, html`<div class="st-page">
      ${stHead({ icon: 'scale', fam: 'body', title: 'Xiaomi S400', status, sub: x.connected && !choosing && x.account ? x.account : '' })}
      ${!x.connected ? html`
        <p class="st-lead" data-style="margin-top:14px">Every weigh-in arrives here with its full body composition. You sign in by scanning a code in Xiaomi Home.</p>
        ${x.lost ? html`<div data-style="margin-top:12px">${stGrp(warnRow('Xiaomi signed this site out', 'The sign-in ended on Xiaomi\'s side or expired. Connect again to carry on. What it brought is kept.'))}</div>` : ''}
        ${q?.state === 'waiting' ? html`
          ${stLab('Scan this in Xiaomi Home')}
          ${stGrp(html`<div class="st-qr"><img src="${q.qr}" alt="Sign-in code for Xiaomi Home" width="200" height="200"></div>
            <div class="st-prose" data-style="padding-top:0"><ol>
              <li>Open Xiaomi Home, signed in to the scale's account.</li>
              <li>Tap the plus at the top, then Scan.</li>
              <li>Confirm. This page carries on by itself.</li>
            </ol></div>`)}
          ${stGrp(html`
            ${stRow({ href: q.loginUrl, external: true, icon: 'phone', title: 'On your phone? Sign in here instead' })}
            ${stRow({ btn: true, attrs: 'data-xm-cancel', icon: 'x', title: 'Cancel', chev: false })}`)}` : html`
          ${q?.state === 'expired' || q?.state === 'error' ? html`<div data-style="margin-top:12px">${stGrp(warnRow(q.state === 'expired' ? 'The code expired' : 'The sign-in did not finish', q.state === 'expired' ? 'Codes last five minutes. Make a new one.' : q.message || 'Xiaomi returned an error. Try again.'))}</div>` : ''}
          ${stGrp(stRow({ btn: true, attrs: 'data-xm-about', icon: 'info', title: 'What the scale sends' }), 'data-style="margin-top:16px"')}
          <div class="st-cta"><button type="button" class="btn" data-xm-start>${ic('scan', { size: 's' })}${q ? 'Make a new code' : 'Connect the scale'}</button></div>`}` : choosing ? html`
        <p class="st-lead" data-style="margin-top:14px">More than one person uses this scale. Which one are you? Only your weigh-ins come here.</p>
        ${stLab('People on the scale')}
        ${stGrp(x.profiles.map((pr) => stRow({ btn: true, attrs: `data-xm-profile="${esc(pr.id)}"`, icon: 'person', title: html`${profileName(pr)}${pr.owner ? html`<span class="st-tag">Owner</span>` : ''}`, sub: `${f.plural(pr.n, 'weigh-in')}${pr.lastAt ? `, last ${f.ago(pr.lastAt)}` : ''}`, value: f.weight(pr.lastKg) })))}
        ${stNote('If you pick again later, the other person\'s weigh-ins are taken away again, here and in Google.')}
        ${stGrp(stRow({ btn: true, attrs: 'data-xm-off', icon: 'unlink', title: 'Disconnect the scale', danger: true, chev: false }), 'data-style="margin-top:16px"')}` : html`
        ${stLab('Status')}
        ${stGrp(html`
          ${x.profiles.length > 1 ? stRow({ icon: 'person', title: 'You are', value: profileName(x.profiles.find((pr) => pr.id === x.profile)) }) : ''}
          ${stRow({ icon: 'refresh', title: 'Last sync', value: x.lastSync ? f.ago(x.lastSync) : 'First sync running' })}
          ${stRow({ icon: 'scale', title: 'From the scale', value: f.plural(x.count, 'weigh-in') })}
          ${x.last ? stRow({ icon: 'history', title: 'Latest', value: `${f.weight(x.last.weightKg)}${f.isNum(x.last.fatPct) ? `, ${f.dec1(x.last.fatPct)}%` : ''}`, sub: f.ago(x.last.t) }) : ''}
          ${x.lastError ? warnRow('The last sync did not finish', x.lastError.message || 'Xiaomi returned an error. It is tried again at the next sync.') : ''}`)}
        ${stLab('What goes where')}
        ${stGrp(sw('toGoogle', st.toGoogle !== false, 'Weigh-ins to Google Health', 'Weight and body fat, when Google has none for that time.'), 'data-xm-sw')}
        ${stNote('With Hevy linked, weigh-ins go to Hevy too. Muscle, water and the rest stay here, under Body composition.')}
        ${stGrp(html`
          ${stRow({ btn: true, attrs: 'data-xm-sync', icon: 'refresh', title: 'Sync now', chev: false })}
          ${x.profiles.length > 1 ? stRow({ btn: true, attrs: 'data-xm-who', icon: 'users', title: 'Not you?', sub: 'Choose who you are on the scale' }) : ''}
          ${stRow({ btn: true, attrs: 'data-xm-off', icon: 'unlink', title: 'Disconnect the scale', danger: true, chev: false })}`, 'data-style="margin-top:16px"')}`}
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
    return html`<form novalidate data-garmin-form>
      ${replacing ? '' : html`
        ${stLab('Make a key')}
        ${stGrp(html`<div class="st-prose"><ol>
            <li>Open Garmin Connect in a browser, signed in with your watch's account.</li>
            <li>Under Personal API key, choose how long it lasts and make it.</li>
            <li>Copy the key. Garmin shows it only once.</li>
          </ol></div>
          ${stRow({ href: KEY_PAGE, external: true, icon: 'key', title: 'Open Garmin Connect\'s key page' })}`)}`}
      ${stLab(replacing ? 'New key' : 'Paste it here')}
      ${stGrp(html`<div class="st-form">
        <div class="field">
          <input class="input" id="gm-key" name="key" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste the key here" aria-label="Garmin key" required>
          <p class="field__hint">Kept encrypted, tested with Garmin at once. Your Garmin password never comes here.</p>
          <div data-err></div></div>
        <div class="field"><span class="field__label" id="gm-days-l">How long it lasts (optional)</span>
          ${seg('gm-days', [['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', 'A year']], '', { label: 'How long the key lasts' })}
          <p class="field__hint">So you are reminded before it runs out.</p></div>
        ${replacing ? '' : html`<div class="field"><span class="field__label">History to bring in</span>
          ${seg('gm-back', BACK, String(g?.settings?.backfill || 30), { label: 'How much history to bring in' })}
          <p class="field__hint">A week at a time, in the background. A year takes most of a day.</p></div>`}
      </div>`)}
      <div class="st-cta"><button type="submit" class="btn">${ic('link', { size: 's' })}${replacing ? 'Test and replace' : 'Test and connect'}</button></div>
    </form>`;
  }
  function paintGarmin() {
    const el = root.querySelector('[data-a="garmin"]');
    if (!el) return;
    if (!garmin) { mount(el, ''); return; }
    const g = garmin;
    const now = Date.now();
    const soon = g.connected && f.isNum(g.keyExpiresAt) && g.keyExpiresAt - now < 7 * 86_400_000;
    const status = g.connected ? (soon ? stDot('warn', 'Key runs out soon') : stDot('ok', 'Connected')) : g.lost ? stDot('bad', 'Needs a new key') : stDot('off', 'Not connected');
    const both = app.me.sources?.google;
    const r = g.lastResult;
    mount(el, html`<div class="st-page">
      ${stHead({ icon: 'watch', fam: 'active', title: 'Garmin', status })}
      ${!g.connected ? html`
        <p class="st-lead" data-style="margin-top:14px">Your Garmin read directly, no Google needed: sleep, HRV, stress, Body Battery and the rest.</p>
        ${g.lost ? html`<div data-style="margin-top:12px">${stGrp(warnRow('Garmin stopped accepting your key', `${g.lost.message || 'It has expired or was deleted.'} Make a new one below. What it brought is kept.`))}</div>` : ''}
        ${g.kept && !g.lost ? stNote('What Garmin brought is still here. Nothing new arrives until you paste a key again.') : ''}
        ${garminKeyForm(g)}
        ${stGrp(stRow({ btn: true, attrs: 'data-gm-about', icon: 'info', title: 'What comes from Garmin' }), 'data-style="margin-top:16px"')}` : html`
        ${stLab('Status')}
        ${stGrp(html`
          ${stRow({ icon: 'key', title: 'Key', value: g.last4 ? `•••• ${g.last4}` : 'Set' })}
          ${stRow({ icon: 'calendar', title: 'Key runs out', value: f.isNum(g.keyExpiresAt) ? f.dateFull(f.instDay(g.keyExpiresAt)) : 'Not known', sub: f.isNum(g.keyExpiresAt) && !g.keyExpiresKnown ? 'As you said' : '' })}
          ${stRow({ icon: 'refresh', title: 'Last sync', value: g.lastSync ? f.ago(g.lastSync) : 'First sync running' })}
          ${r ? stRow({ icon: 'data', title: 'Last read', sub: r.ok ? `${f.plural(r.days, 'day')}, ${f.plural(r.nights, 'night')}, ${f.plural(r.activities, 'activity', 'activities')}` : 'Did not finish' }) : ''}
          ${stRow({ icon: 'watch', title: 'From Garmin', sub: garminCounts(g.counts) })}
          ${soon ? warnRow(`Your key runs out on ${f.dateFull(f.instDay(g.keyExpiresAt))}`, 'Replace it before then and nothing is missed.') : ''}
          ${g.retryAt ? stRow({ icon: 'clock', title: 'Garmin asked this site to slow down', sub: `Reading carries on by itself at ${f.clock(g.retryAt)}.`, top: true })
            : g.lastError ? warnRow('The last sync did not finish', g.lastError.message || 'Garmin returned an error. It is tried again at the next sync.') : ''}
          ${g.unavailable?.length ? stRow({ icon: 'info', title: 'Some of it did not answer', sub: `${g.unavailable.join(', ')}. Asked again tomorrow.`, top: true }) : ''}`)}
        ${stLab('Settings')}
        ${stGrp(html`
          ${both ? stRow({ btn: true, attrs: 'data-gm-prefer', icon: 'balance', title: 'When Google has a number too', value: g.settings.prefer === 'google' ? 'Google first' : 'Garmin first' }) : ''}
          ${stRow({ btn: true, attrs: 'data-gm-history', icon: 'history', title: 'History to bring in', value: (BACK.find(([v]) => v === String(g.settings.backfill)) || [0, `${g.settings.backfill} days`])[1], sub: g.backfill.done ? `In since ${f.dayShort(g.backfill.target)}` : g.backfill.backTo ? `Back to ${f.dayShort(g.backfill.backTo)}, going to ${f.dayShort(g.backfill.target)}` : 'Starting' })}
          ${stRow({ btn: true, attrs: 'data-gm-about', icon: 'info', title: 'What comes from Garmin' })}`)}
        ${stGrp(html`
          ${stRow({ btn: true, attrs: 'data-gm-sync', icon: 'refresh', title: 'Sync now', chev: false })}
          ${stRow({ btn: true, attrs: 'data-gm-replace', icon: 'key', title: 'Replace key' })}
          ${stRow({ btn: true, attrs: 'data-gm-off', icon: 'unlink', title: 'Disconnect Garmin', danger: true, chev: false })}`, 'data-style="margin-top:16px"')}`}
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

  mount(root, html`<div class="st-apps">${['garmin', 'hevy', 'strava', 'scale'].filter((k) => (k === 'garmin' ? only === 'garmin' : wants(k))).map((k) => html`<div data-a="${k}"></div>`)}</div>`);

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
    if (!key) { mount(slot, errSlot('Paste the key from Hevy first.')); return; }
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.post('/api/hevy/connect', { key }));
      if (r === undefined) return;
      hevy = r;
      toast('Hevy linked. Your workouts are on their way; the first sync takes a minute.', { ms: 7000 });
      await refreshMe().catch(() => {});
      await load();
    } catch (err) { mount(slot, errSlot(errText(err))); }
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
    const yes = await confirm({ title: 'Unlink Hevy?', text: 'Nothing more syncs and the key is deleted. What Hevy brought is kept.', yes: 'Unlink', danger: true });
    if (!yes) return;
    try { hevy = await api.post('/api/hevy/disconnect', {}); toast('Hevy unlinked'); await refreshMe().catch(() => {}); paintHevy(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-strava-off]', async () => {
    const yes = await confirm({ title: 'Disconnect Strava?', text: 'Nothing more comes from Strava. The workouts it brought are kept.', yes: 'Disconnect', danger: true });
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
    const yes = await confirm({ title: 'Disconnect the scale?', text: 'Nothing more comes from Xiaomi. The weigh-ins it brought are kept.', yes: 'Disconnect', danger: true });
    if (!yes) return;
    try { scale = await api.post('/api/xiaomi/disconnect', { keepData: true }); toast('Scale disconnected'); await refreshMe().catch(() => {}); paintScale(); } catch (err) { toastError(err); }
  });

  /* ── Garmin ── */
  const segOf = (form, name) => form.querySelector(`[data-seg="${name}"][aria-pressed="true"]`)?.dataset.value ?? '';
  // The key form's choices (on the page, or in the Replace key sheet).
  const pickSeg = (scope, b) => {
    const name = b.dataset.seg;
    // The key's lifetime can be left unsaid: a second tap clears it.
    const off = name === 'gm-days' && b.getAttribute('aria-pressed') === 'true';
    for (const o of scope.querySelectorAll(`[data-seg="${name}"]`)) o.setAttribute('aria-pressed', String(o === b && !off));
  };
  async function submitGarmin(form, { replacing = false } = {}) {
    const key = form.elements.key.value.trim();
    const slot = form.querySelector('[data-err]');
    if (!key) { mount(slot, errSlot('Paste the key from Garmin Connect first.')); return false; }
    const days = segOf(form, 'gm-days'); const back = segOf(form, 'gm-back');
    try {
      const r = await busy(form.querySelector('button[type="submit"]'), () => api.post('/api/garmin/connect', { key, ...(days ? { keyDays: Number(days) } : {}), ...(back ? { backfill: Number(back) } : {}) }));
      if (r === undefined) return false;
      garmin = r;
      toast(replacing ? 'Garmin accepted the new key.' : 'Garmin accepted the key. The last few days are on their way; older ones follow a week at a time.', { ms: 7000 });
      await refreshMe().catch(() => {});
      paintGarmin();
      return true;
    } catch (err) { mount(slot, errSlot(errText(err))); return false; }
  }
  on(root, 'click', '[data-seg^="gm-"]', (e, b) => pickSeg(root, b));
  on(root, 'submit', '[data-garmin-form]', (e, form) => { e.preventDefault(); submitGarmin(form); });
  on(root, 'click', '[data-gm-replace]', () => {
    const s = sheet({ title: 'Replace key', body: html`<div class="st-sheet">${garminKeyForm(garmin, { replacing: true })}</div>` });
    on(s.el, 'click', '[data-seg^="gm-"]', (e, b) => pickSeg(s.el, b));
    on(s.el, 'submit', '[data-garmin-form]', async (e, form) => { e.preventDefault(); if (await submitGarmin(form, { replacing: true })) s.close(); });
  });
  on(root, 'click', '[data-gm-prefer]', async () => {
    const v = await stPick({
      title: 'When Google has a number too',
      options: [['garmin', 'Garmin first', 'Google fills what Garmin does not have.'], ['google', 'Google first', 'Garmin fills what Google does not have.']],
      current: garmin.settings.prefer === 'google' ? 'google' : 'garmin',
      foot: 'Nothing is added up across the two, so nothing counts twice. Stress and Body Battery come from Garmin either way.',
    });
    if (!v || v === (garmin.settings.prefer === 'google' ? 'google' : 'garmin')) return;
    try { garmin = await api.patch('/api/garmin/settings', { prefer: v }); toast(v === 'google' ? 'Google first, Garmin fills the gaps' : 'Garmin first, Google fills the gaps'); await refreshMe().catch(() => {}); paintGarmin(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-gm-history]', async () => {
    const v = await stPick({ title: 'History to bring in', options: BACK, current: String(garmin.settings.backfill), foot: 'It comes in a week at a time, in the background.' });
    if (!v || v === String(garmin.settings.backfill)) return;
    try { garmin = await api.patch('/api/garmin/settings', { backfill: Number(v) }); toast(`History: ${BACK.find(([x]) => x === v)[1].toLowerCase()}. It comes in a week at a time.`); paintGarmin(); } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-gm-about]', () => stInfo('What comes from Garmin', html`
    ${stProse(html`<p>Steps, heart rate, sleep with its stages and Garmin's sleep score, HRV, blood oxygen, breathing, stress, Body Battery, activities and weigh-ins.</p>
      <p>You make a key on your own Garmin Connect account and paste it here. It is kept encrypted and never shown again: only its last four characters.</p>`)}
    ${stLab('With Google Health too')}
    ${stProse(html`<p>Garmin, then Health Connect, then Google Health also works, but that way loses HRV, blood oxygen and stress.</p><p>A night or a workout both recorded is kept once.</p>`)}
    ${stLab('Runs and rides')}
    ${stProse(html`<p>Their routes come in through Strava (Accounts, Strava).</p>`)}`));
  on(root, 'click', '[data-gm-sync]', async (e, b) => {
    await busy(b, async () => {
      try {
        const r = await api.post('/api/garmin/sync', {});
        const x = r.result || {};
        garmin = r.garmin;
        toast(x.ok === false ? `Garmin: ${x.message || 'that did not work'}` : `Read ${f.plural(x.days || 0, 'day')} and ${f.plural(x.nights || 0, 'night')} from Garmin`, { tone: x.ok === false ? 'bad' : '' });
        paintGarmin();
      } catch (err) { toastError(err); }
    });
  });
  on(root, 'click', '[data-gm-off]', () => {
    const s = sheet({
      title: 'Disconnect Garmin?',
      body: html`<div class="st-sheet"><p class="st-lead">The key is deleted and nothing more is read. What Garmin brought can stay, or go too.</p></div>`,
      foot: html`<button type="button" class="btn btn--tonal" data-gm-keep="1">Keep what it brought</button>
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
          paintGarmin();
        } catch (err) { toastError(err); }
      });
    });
  });

  /* ── the explanations, one tap away ── */
  on(root, 'click', '[data-hevy-about]', () => stInfo('Hevy', html`
    ${stProse(html`<p>Link your Hevy account and your workouts, sets, exercise library, routines and body measurements are kept together with this app, both ways. Hevy gives its API key to Pro accounts only.</p>`)}
    ${stLab('Each switch')}
    ${stGrp(html`
      ${stRow({ title: 'Hevy workouts to Google Health', sub: 'After a half-hour wait, and only when Google has nothing for that time already (Hevy may send it there itself through Health Connect).', top: true })}
      ${stRow({ title: 'Workouts logged here to Hevy', sub: 'Strength workouts logged here after linking go to Hevy, and so do their edits. Exercises from this app\'s library are matched to Hevy\'s own, or made in your Hevy library.', top: true })}
      ${stRow({ title: 'Body measurements from Hevy', sub: 'Weight and body fat fill days that have none here; tape measurements show under Body measurements.', top: true })}
      ${stRow({ title: 'Weigh-ins and measurements to Hevy', sub: 'Your weigh-ins, body fat and tape measurements from here, by day.', top: true })}
      ${stRow({ title: 'Routines in both places', sub: 'A routine made or changed in either place appears in the other, folders included. Exercises Hevy does not have are matched to its own, or made in your Hevy library.', top: true })}`)}`));
  on(root, 'click', '[data-strava-about]', () => stInfo('Strava', html`
    ${stProse(html`<p>Connect Strava and your runs, rides, swims and walks arrive here with their distance, pace, heart rate and route, the moment you save them on Strava. A session already here (from your watch) gets the Strava details instead of a second copy.</p>`)}
    ${stLab('Each switch')}
    ${stGrp(html`
      ${stRow({ title: 'Strava activities to Google Health', sub: 'After a half-hour wait, and only when Google has nothing for that time already.', top: true })}
      ${stRow({ title: 'Routes recorded here to Strava', sub: 'Runs, walks, hikes and rides recorded in this app go to Strava with their map, once.', top: true })}
      ${stRow({ title: 'The whole route of each activity', sub: 'The full GPS route, so Strava activities get the map, splits and charts here. A couple a sync, within Strava\'s limits; opening one reads it at once.', top: true })}
      ${stRow({ title: 'Other workouts to Strava', sub: 'Workouts logged here, detected and confirmed, or from Hevy, created on Strava. Off if Hevy or your watch already posts to Strava, or they would appear twice.', top: true })}`)}`));
  on(root, 'click', '[data-xm-about]', () => stInfo('Xiaomi S400', stProse(html`<p>Connect the Xiaomi account your scale (the Body Composition Scale S400) is in, and every weigh-in arrives here: weight, body fat, and the rest the scale works out (muscle, water, bone, protein, visceral fat, resting energy, metabolic age).</p><p>You sign in by scanning a code in Xiaomi Home; your Xiaomi password never comes here.</p><p>Weight and body fat can go on to Google Health. Xiaomi itself only sends them to Apple Health.</p>`)));

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
