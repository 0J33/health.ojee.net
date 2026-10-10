/* A person's public page, /u/<username>. Works signed out. Sections whose
   category is private are simply not there; a private or unknown account
   gets one plain "not available" page, with no hint which it is. */

import { api } from '../api.js';
import { app, signedIn, hasProfile } from '../app.js';
import { html, raw, mount, ic, skeleton, errorState, banner, chart, on } from '../ui.js';
import { heatmap } from '../charts.js';
import * as f from '../format.js';
import { avatar, unitText, typeLabel, legend } from './shared.js';

function topbar() {
  if (hasProfile()) return '';
  return html`<header class="land__bar" data-style="margin-bottom:8px">
    <a class="brand" href="/"><span class="brand__mark">${ic('pulse')}</span>Health</a>
    ${signedIn() ? '' : html`<a class="btn btn--tonal btn--s" href="/signin?next=${encodeURIComponent(location.pathname)}">Sign in</a>`}
  </header>`;
}

function weekBlock(p) {
  const a = p.week?.thisWeek; const b = p.week?.lastWeek;
  if (!a) return '';
  const defs = [['steps', 'Steps', 'steps'], ['activeMinutes', 'Active minutes', 'min'], ['distanceM', 'Distance', 'm'], ['workouts', 'Workouts', 'workouts'], ['workoutMin', 'Workout time', 'min']];
  const rows = defs.filter(([k]) => f.isNum(a[k])).map(([k, label, unit]) => {
    const prev = b?.[k];
    return html`<div class="vs">
      <span class="vs__k">${label}</span>
      <span class="vs__v">${unitText(a[k], unit)}</span>
      <span class="vs__p">${f.isNum(prev) ? `Last week ${unitText(prev, unit)}` : 'Nothing last week'}</span>
    </div>`;
  });
  if (!rows.length) return '';
  return html`<section class="sec"><div class="sec__head"><h2 class="h2">This week</h2><span class="sec__note">so far</span></div><div class="group">${rows}</div></section>`;
}

export default async function profile(ctx) {
  const { root } = ctx;
  const username = ctx.params.username;
  document.title = `${username} · Health`;

  async function load() {
    mount(root, html`${topbar()}${skeleton('page')}`);
    let p;
    try { p = await api.get(`/api/users/${encodeURIComponent(username)}`); } catch (err) {
      if (!ctx.alive()) return;
      if (err.status === 404) {
        document.title = 'Not available · Health';
        mount(root, html`${topbar()}<div class="narrow"><div class="empty" data-style="padding-top:64px">
          <span class="empty__ic">${ic('lock')}</span>
          <h1 class="empty__t" tabindex="-1">This profile is not available</h1>
          <p class="empty__d">There is no public profile at this address.</p>
          <a class="btn btn--tonal btn--s" href="${hasProfile() ? '/ranks' : '/'}">${hasProfile() ? 'Back to ranks' : 'Go to the start'}</a>
        </div></div>`);
      } else mount(root, html`${topbar()}${errorState(err)}`);
      return;
    }
    if (!ctx.alive()) return;
    const name = p.displayName || p.username;
    document.title = `${name} · Health`;
    const s = p.streaks || {};
    const streakItems = [
      s.stepGoal ? [s.stepGoal.current, s.stepGoal.current === 1 ? 'day at step goal' : 'days at step goal', s.stepGoal.best] : null,
      s.workoutWeeks ? [s.workoutWeeks.current, s.workoutWeeks.current === 1 ? 'week with a workout' : 'weeks in a row with a workout', s.workoutWeeks.best] : null,
    ].filter(Boolean);
    const days = p.heatmap || [];
    const activeDays = days.filter((d) => d.level > 0).length;
    const extra = [
      p.sleep ? ['Sleep', [['Average, last 7 nights', f.dur(p.sleep.avgMin7)], ['Consistency', f.isNum(p.sleep.consistency) ? `${f.int(p.sleep.consistency)} of 100` : f.DASH]]] : null,
      p.heart ? ['Heart', [['Resting heart rate', f.isNum(p.heart.restingHr) ? `${f.int(p.heart.restingHr)} bpm` : f.DASH], ['HRV', f.isNum(p.heart.hrv) ? `${f.int(p.heart.hrv)} ms` : f.DASH]]] : null,
      p.body ? ['Body', [['Weight', f.weight(p.body.weightKg)], ['Body fat', f.isNum(p.body.bodyFatPct) ? `${f.dec1(p.body.bodyFatPct)}%` : f.DASH]]] : null,
    ].filter(Boolean);
    const anything = streakItems.length || p.records?.length || p.recentWorkouts?.length || days.some((d) => d.level > 0) || extra.length || weekBlock(p);

    mount(root, html`
      ${topbar()}
      ${hasProfile() ? html`<header class="head head--back"><div class="head__lead"><a class="back" href="/ranks" aria-label="Back to ranks">${ic('left')}</a><span class="muted small">Profile</span></div></header>` : ''}
      <div class="prof">
        ${avatar(p, { large: true })}
        <div>
          <h1 class="prof__n" tabindex="-1">${name}</h1>
          <p class="prof__u">@${p.username}</p>
        </div>
      </div>
      ${p.bio ? html`<p class="prof__bio">${p.bio}</p>` : ''}
      <p class="prof__meta">
        ${p.joinedAt ? html`<span>${ic('calendar', { size: 's' })}Joined ${f.monthYear(f.instDay(p.joinedAt))}</span>` : ''}
        ${p.device ? html`<span>${ic('watch', { size: 's' })}${p.device}</span>` : ''}
      </p>
      <div class="btnrow" data-style="margin-top:16px">
        ${p.me ? html`<a class="btn btn--tonal btn--s" href="/settings/account">Edit profile</a><a class="btn btn--tonal btn--s" href="/settings/privacy">Privacy</a>` : ''}
        ${!p.me && hasProfile() ? html`<a class="btn btn--tonal btn--s" href="/compare?with=${encodeURIComponent(p.username)}">${ic('compare', { size: 's' })}Compare with me</a>` : ''}
      </div>

      <div class="stack" data-style="margin-top:20px">
        ${p.me && p.private ? banner({ iconName: 'lock', title: 'Your account is private', text: 'Nobody else can open this page and you are not on the leaderboards. Below is what people would see if you made it public.' }) : ''}
        ${p.me && !p.private ? banner({ iconName: 'eye', title: 'This is what other people see', text: 'Sections you keep private are left out.' }) : ''}
        ${!anything ? html`<div class="group"><div class="empty"><span class="empty__ic">${ic('eyeoff')}</span><p class="empty__t">Nothing shared yet</p><p class="empty__d">${p.me ? 'Once your data syncs, the categories you share appear here.' : `${name} has no public numbers yet.`}</p></div></div>` : ''}
      </div>

      ${streakItems.length ? html`<section class="sec"><div class="sec__head"><h2 class="h2">Streaks</h2></div>
        <div class="streaks">${streakItems.map(([v, k, best]) => html`<div class="streak"><p class="streak__v">${f.int(v)}</p><p class="streak__k">${k}</p><p class="cap" data-style="margin-top:4px">Best ${f.int(best)}</p></div>`)}</div></section>` : ''}

      ${weekBlock(p)}

      ${days.length && (p.sections?.activity || p.sections?.workouts) ? html`<section class="sec">
        <div class="sec__head"><h2 class="h2">The last year</h2><span class="sec__note">${f.plural(activeDays, 'active day')}</span></div>
        <div class="panel chartbox">
          <p class="chart__read" aria-live="polite">Touch a square to read a day.</p>
          <div class="heat" tabindex="0" role="group" aria-label="Activity over the last year, scrollable">${chart(() => heatmap({
            label: `Activity on each of the last 365 days: ${activeDays} active days.`,
            days: days.map((d) => ({ date: d.date, level: d.level, read: `${f.dayMed(d.date)}: ${[f.isNum(d.steps) ? `${f.int(d.steps)} steps` : null, d.workouts ? f.plural(d.workouts, 'workout') : null].filter(Boolean).join(', ') || 'nothing recorded'}` })),
          }))}</div>
          ${raw(legend([['sw-h0', 'None'], ['sw-h1', ''], ['sw-h2', ''], ['sw-h3', ''], ['sw-h4', 'Most active']]))}
        </div>
      </section>` : ''}

      ${p.records?.length ? html`<section class="sec"><div class="sec__head"><h2 class="h2">Records</h2></div>
        <div class="group">${p.records.map((r) => html`<div class="row"><span class="row__ic">${ic('ranks')}</span><span class="row__body"><span class="row__t">${r.label}</span><span class="row__d">${r.date ? (/week/.test(r.kind) ? `Week of ${f.dayShort(r.date)}` : f.dateFull(r.date)) : ''}</span></span><span class="row__v row__v--strong">${unitText(r.value, r.unit)}</span></div>`)}</div></section>` : ''}

      ${p.recentWorkouts?.length ? html`<section class="sec"><div class="sec__head"><h2 class="h2">Recent workouts</h2></div>
        <div class="group">${p.recentWorkouts.map((w) => html`<div class="wk">
          <span class="wk__date" aria-hidden="true"><span class="wk__dow">${f.dow(w.date)}</span><br><span class="wk__day">${f.dom(w.date)}</span></span>
          <span class="wk__body"><span class="wk__t">${w.title && w.title !== 'Workout' ? w.title : typeLabel(w.type)}</span><br><span class="wk__d"><span class="sr">${f.dayMed(w.date)}, </span>${f.monthShort(w.date)}${w.title && w.title !== 'Workout' ? ` · ${typeLabel(w.type)}` : ''}</span></span>
          <span class="wk__v"><span class="wk__dur">${f.dur(w.durationMin)}</span></span>
        </div>`)}</div></section>` : ''}

      ${extra.map(([title, kv]) => html`<section class="sec"><div class="sec__head"><h2 class="h2">${title}</h2></div><dl class="group kv">${kv.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></section>`)}
    `);
    // The newest days are at the right-hand end.
    const heat = root.querySelector('.heat');
    if (heat) requestAnimationFrame(() => { heat.scrollLeft = heat.scrollWidth; });
  }

  on(root, 'click', '[data-action="retry"]', () => load());
  ctx.onRefresh(load);
  await load();
}
