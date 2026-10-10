/* Trends: Sleep, Activity, Heart, Body over 7, 30 or 90 days. A metric the
   person's device does not report gets a sentence saying so, never an empty
   chart. */

import { api } from '../api.js';
import { app, cap, capText, listen, go } from '../app.js';
import { html, raw, mount, ic, head, skeleton, errorState, chart, on, seg, sheet, field, formValues, fieldError, busy, toast, banner, errText } from '../ui.js';
import { bars, line, sleepTimeline, tableAlt, describe } from '../charts.js';
import * as f from '../format.js';
import { chartbox, legend, connectionBanner } from './shared.js';

const TABS = [['sleep', 'Sleep'], ['activity', 'Activity'], ['heart', 'Heart'], ['body', 'Body']];
const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const RANGE_KEY = 'health.trends.range';

const avg = (vals) => { const v = vals.filter(f.isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = (vals) => vals.filter(f.isNum).reduce((a, b) => a + b, 0);
const lastOf = (vals) => { for (let i = vals.length - 1; i >= 0; i -= 1) if (f.isNum(vals[i])) return vals[i]; return null; };
const count = (vals) => vals.filter(f.isNum).length;

function panel({ k, v, s = '', body, wide = false, action = '' }) {
  return html`<section class="panel ${wide ? 'panel--wide' : ''}">
    <div class="panel__head">
      <div><h2 class="panel__k">${k}</h2><p class="panel__v">${v}</p>${s ? html`<p class="panel__s">${s}</p>` : ''}</div>
      ${action}
    </div>
    ${body}
  </section>`;
}

/** A metric this device does not produce, or produced nothing for in range. */
function absent(title, iconName, capName, fallback, hasCap) {
  return html`<section class="panel"><div class="na">
    ${ic(iconName)}
    <div><h2 class="na__t">${title}</h2>
    <p class="na__d">${hasCap ? 'Nothing was recorded in this range. Try a longer one.' : capText(capName, fallback)}</p></div>
  </div></section>`;
}

const table = (dates, cols) => tableAlt(['Day', ...cols.map((c) => c[0])], dates.map((d, i) => [f.dayMed(d), ...cols.map((c) => (f.isNum(c[1][i]) ? c[2](c[1][i]) : f.DASH))]).reverse());

/* ── sleep ──────────────────────────────────────────────────── */

function sleepTab(t) {
  if (!cap('sleep') && !t.series.some((r) => f.isNum(r.sleepMin))) {
    return html`<div class="group"><div class="empty">
      <span class="empty__ic">${ic('moon')}</span>
      <p class="empty__t">No sleep data</p>
      <p class="empty__d">${capText('sleep', 'Your device does not report sleep. Wear a watch or band at night and link it to Google Health, and your nights appear here.')}</p>
    </div></div>`;
  }
  const dates = t.series.map((r) => r.date);
  const mins = t.series.map((r) => r.sleepMin);
  const goal = t.activity?.sleepTarget || app.me.goals?.sleepMinutes;
  const a = avg(mins);
  const out = [];

  out.push(count(mins)
    ? panel({
      k: 'Time asleep', v: f.dur(a), s: `Average over ${f.plural(count(mins), 'night')}${goal ? ` · goal ${f.dur(goal)}` : ''}`, wide: true,
      body: chartbox(chart((w) => bars({ w, dates, values: mins, goal, fmt: f.dur, tick: (v) => (v ? `${Math.round(v / 60)}h` : '0'), label: `Time asleep per night. ${describe(mins, f.dur)}` })), {
        hint: 'Touch the chart to read a night.',
        legend: goal ? legend([['sw-met', 'Reached your goal'], ['sw-under', 'Under your goal']]) : '',
        table: table(dates, [['Asleep', mins, f.dur]]),
      }),
    })
    : absent('Time asleep', 'moon', 'sleep', '', true));

  const nights = (t.sleep?.nights || []).filter((n) => n.main !== false && f.isNum(n.startMs) && f.isNum(n.endMs));
  const recent = nights.slice().sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 14).map((n) => {
    const anchor = Date.parse(`${n.date}T00:00:00Z`) - 4 * 3600_000;
    return {
      date: n.date, start: n.startMs, end: n.endMs, minutes: n.asleepMin,
      stages: cap('sleepStages') ? n.stages : null,
      bedMin: (n.startMs + (n.startOff || 0) * 1000 - anchor) / 60000,
    };
  });
  const c = t.sleep?.consistency;
  if (recent.length) {
    out.push(panel({
      k: 'Bedtime and wake time',
      v: c?.bedtime && c?.wake ? `${c.bedtime} to ${c.wake}` : `${f.plural(recent.length, 'night')}`,
      s: c?.bedtime ? `Usual times over ${f.plural(c.nights, 'night')}. Bedtime varies by about ${f.dur(c.bedtimeSd)}, wake time by ${f.dur(c.wakeSd)}.` : 'Each row is one night on the same clock.',
      wide: true,
      body: html`${chart((w) => sleepTimeline({ w, nights: recent, label: `The last ${recent.length} nights on a shared clock from 20:00 to 12:00, newest first, with time asleep at the end of each row.` }))}
        ${cap('sleepStages') ? raw(legend([['sw-deep', 'Deep'], ['sw-rem', 'REM'], ['sw-light', 'Light'], ['sw-awake', 'Awake']])) : ''}
        ${raw(tableAlt(['Night', 'Asleep', 'In bed'], recent.map((n) => [f.dayMed(n.date), f.dur(n.minutes), `${clockOff(n.start, nights.find((x) => x.date === n.date)?.startOff)} to ${clockOff(n.end, nights.find((x) => x.date === n.date)?.endOff)}`])))}`,
    }));
  }

  if (cap('sleepStages')) {
    const keys = [['DEEP', 'Deep', 'sw-deep'], ['REM', 'REM', 'sw-rem'], ['LIGHT', 'Light', 'sw-light'], ['AWAKE', 'Awake', 'sw-awake']];
    const st = Object.fromEntries(keys.map(([k]) => [k, avg(nights.map((n) => n.summary?.stages?.[k]))]));
    const total = sum(Object.values(st)) || 1;
    if (keys.some(([k]) => f.isNum(st[k]))) {
      out.push(panel({
        k: 'Sleep stages', v: f.isNum(st.DEEP) ? html`${f.dur(st.DEEP)}<span class="unit">deep a night</span>` : 'Stages', s: 'Average per night in this range',
        body: html`<div class="stack">${keys.map(([k, label]) => (f.isNum(st[k]) ? html`<div class="cmp__r">
          <span class="cmp__who">${label}</span>
          <div class="meter" role="img" aria-label="${label} ${f.dur(st[k])}, ${Math.round((st[k] / total) * 100)}% of the night"><div class="meter__v" data-style="--p:${(st[k] / total).toFixed(3)}"></div></div>
          <span class="cmp__n">${f.dur(st[k])}</span>
        </div>` : ''))}</div>`,
      }));
    }
  } else {
    out.push(html`<section class="panel"><div class="na">${ic('moon')}<div><h2 class="na__t">Sleep stages</h2><p class="na__d">${capText('sleepStages', 'Your device records when you slept, but not deep, light and REM stages.')}</p></div></div></section>`);
  }
  return html`<div class="panels">${out}</div>`;
}

function clockOff(ms, offSec) {
  if (!f.isNum(ms)) return f.DASH;
  if (!f.isNum(offSec)) return f.clock(ms);
  const d = new Date(ms + offSec * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/* ── activity ───────────────────────────────────────────────── */

function activityTab(t) {
  const dates = t.series.map((r) => r.date);
  const out = [];
  const steps = t.series.map((r) => r.steps);
  const goal = t.activity?.stepTarget || app.me.goals?.steps;

  if (count(steps)) {
    const met = goal ? steps.filter((v) => f.isNum(v) && v >= goal).length : null;
    out.push(panel({
      k: 'Steps', v: html`${f.int(avg(steps))}<span class="unit">a day</span>`,
      s: `${f.int(sum(steps))} in total${met !== null ? ` · goal reached on ${f.plural(met, 'day')}` : ''}`, wide: true,
      body: chartbox(chart((w) => bars({ w, dates, values: steps, goal, fmt: f.int, unit: 'steps', label: `Steps per day. ${describe(steps, f.int, 'steps')}` })), {
        legend: goal ? legend([['sw-met', 'Reached your goal'], ['sw-under', 'Under your goal']]) : '',
        table: table(dates, [['Steps', steps, f.int]]),
      }),
    }));
  } else out.push(absent('Steps', 'steps', 'steps', 'Steps appear once your phone or watch has synced to Google Health.', cap('steps')));

  const active = t.series.map((r) => (f.isNum(r.azm) ? r.azm : r.activeMin));
  const agoal = t.activity?.azmTarget || app.me.goals?.activeMinutes;
  if (count(active)) {
    out.push(panel({
      k: 'Active minutes', v: html`${f.int(avg(active))}<span class="unit">min a day</span>`, s: `${f.dur(sum(active))} in total`,
      body: chartbox(chart((w) => bars({ w, dates, values: active, goal: agoal, fmt: f.int, unit: 'min', label: `Active minutes per day. ${describe(active, f.int, 'minutes')}` })), { table: table(dates, [['Active minutes', active, f.int]]) }),
    }));
  } else out.push(absent('Active minutes', 'bolt', 'activeMinutes', 'Your device does not report active minutes.', cap('activeMinutes')));

  const distance = t.series.map((r) => (f.isNum(r.distanceM) ? f.distVal(r.distanceM) : null));
  if (count(distance)) {
    const u = f.distUnit();
    out.push(panel({
      k: 'Distance', v: html`${f.dec(avg(distance), 1)}<span class="unit">${u} a day</span>`, s: `${f.dec(sum(distance), 1)} ${u} in total`,
      body: chartbox(chart((w) => bars({ w, dates, values: distance, fmt: (v) => f.dec(v, 1), tick: (v) => String(Math.round(v * 10) / 10), unit: u, label: `Distance per day. ${describe(distance, (v) => f.dec(v, 1), u)}` })), { table: table(dates, [[`Distance (${u})`, distance, (v) => f.dec(v, 2)]]) }),
    }));
  } else out.push(absent('Distance', 'route', 'distance', 'Your device does not report distance.', cap('distance')));

  const kcal = t.series.map((r) => r.kcal);
  if (count(kcal)) {
    out.push(panel({
      k: 'Calories burned', v: html`${f.int(avg(kcal))}<span class="unit">kcal a day</span>`, s: 'Resting and active together',
      body: chartbox(chart((w) => bars({ w, dates, values: kcal, fmt: f.int, unit: 'kcal', label: `Calories burned per day. ${describe(kcal, f.int, 'kcal')}` })), { table: table(dates, [['Calories', kcal, f.int]]) }),
    }));
  } else out.push(absent('Calories burned', 'flame', 'calories', 'Your device does not report calories burned.', cap('calories')));

  const weeks = (t.weeks || []).slice().reverse();
  if (weeks.length > 1) {
    out.push(html`<section class="panel panel--wide">
      <div class="panel__head"><div><h2 class="panel__k">Week by week</h2></div></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th scope="col">Week</th><th scope="col" class="n">Steps a day</th><th scope="col" class="n">Active min</th><th scope="col" class="n">Workouts</th></tr></thead>
        <tbody>${weeks.map((w) => html`<tr><td class="nw">${f.weekLabel(w.week)}</td><td class="n">${f.int(w.stepsAvg)}</td><td class="n">${f.int(w.activeMinutes)}</td><td class="n">${f.isNum(w.workouts) ? f.int(w.workouts) : f.DASH}</td></tr>`)}</tbody>
      </table></div>
    </section>`);
  }
  return html`<div class="panels">${out}</div>`;
}

/* ── heart ──────────────────────────────────────────────────── */

function heartTab(t) {
  const dates = t.series.map((r) => r.date);
  const out = [];

  const rhr = t.series.map((r) => r.rhr);
  if (count(rhr)) {
    const base = t.series.map((r) => r.rhrBase);
    const now = lastOf(rhr); const usual = lastOf(base);
    out.push(panel({
      k: 'Resting heart rate', v: html`${Math.round(now)}<span class="unit">bpm</span>`,
      s: f.isNum(usual) ? `Your usual is ${Math.round(usual)} bpm. Lower is generally better rested.` : 'A usual value appears after a week of readings.',
      wide: true,
      body: chartbox(chart((w) => line({ w, dates, series: [{ values: rhr, label: 'Resting' }, { values: base, label: 'Usual', quiet: true }], fmt: (v) => String(Math.round(v)), unit: 'bpm', label: `Resting heart rate per day against your 30-day usual. ${describe(rhr, (v) => String(Math.round(v)), 'bpm')}` })), {
        legend: legend([['sw-met', 'Resting heart rate'], ['sw-line2', 'Your 30-day usual']]),
        table: table(dates, [['Resting (bpm)', rhr, (v) => String(Math.round(v))], ['Usual', base, (v) => f.dec1(v)]]),
      }),
    }));
  } else out.push(absent('Resting heart rate', 'heart', 'restingHr', 'Your device does not report resting heart rate.', cap('restingHr')));

  const hrv = t.series.map((r) => r.hrv);
  if (count(hrv)) {
    const base = t.series.map((r) => r.hrvBase);
    const now = lastOf(hrv); const usual = lastOf(base);
    out.push(panel({
      k: 'Heart rate variability', v: html`${Math.round(now)}<span class="unit">ms</span>`,
      s: f.isNum(usual) ? `Your usual is ${Math.round(usual)} ms. Higher than usual tends to mean well recovered.` : 'A usual value appears after a week of readings.',
      body: chartbox(chart((w) => line({ w, dates, series: [{ values: hrv, label: 'HRV' }, { values: base, label: 'Usual', quiet: true }], fmt: (v) => String(Math.round(v)), unit: 'ms', label: `Heart rate variability per night against your 30-day usual. ${describe(hrv, (v) => String(Math.round(v)), 'ms')}` })), {
        legend: legend([['sw-met', 'HRV'], ['sw-line2', 'Your 30-day usual']]),
        table: table(dates, [['HRV (ms)', hrv, (v) => String(Math.round(v))]]),
      }),
    }));
  } else out.push(absent('Heart rate variability', 'wave', 'hrv', 'Your device does not report HRV.', cap('hrv')));

  const spo2 = t.series.map((r) => r.spo2);
  if (count(spo2)) {
    out.push(panel({
      k: 'Blood oxygen', v: html`${f.dec1(lastOf(spo2))}<span class="unit">%</span>`, s: 'Average while asleep',
      body: chartbox(chart((w) => line({ w, dates, series: [{ values: spo2, label: 'SpO2' }], fmt: (v) => f.dec1(v), unit: '%', max: 100, label: `Blood oxygen per night. ${describe(spo2, (v) => f.dec1(v), 'percent')}` })), { table: table(dates, [['SpO2 (%)', spo2, (v) => f.dec1(v)]]) }),
    }));
  } else out.push(absent('Blood oxygen', 'drop', 'spo2', 'Your device does not report blood oxygen.', cap('spo2')));

  const temp = t.series.map((r) => r.tempDev);
  if (count(temp)) {
    const conv = temp.map((v) => (f.isNum(v) ? (f.getPrefs().temp === 'f' ? v * 1.8 : v) : null));
    out.push(panel({
      k: 'Skin temperature', v: f.tempDelta(lastOf(temp)), s: 'Difference from your own usual, at night',
      body: chartbox(chart((w) => line({ w, dates, series: [{ values: conv, label: 'Difference' }], band: { lo: -0.3 * (f.getPrefs().temp === 'f' ? 1.8 : 1), hi: 0.3 * (f.getPrefs().temp === 'f' ? 1.8 : 1) }, fmt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.dec1(Math.abs(v))}`, unit: f.tempUnit(), label: `Skin temperature difference from your usual per night. ${describe(conv, (v) => f.dec1(v), 'degrees')}` })), {
        note: 'The shaded band is the normal night-to-night wobble.',
        table: table(dates, [[`Difference (${f.tempUnit()})`, conv, (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.dec1(Math.abs(v))}`]]),
      }),
    }));
  } else out.push(absent('Skin temperature', 'temp', 'skinTemp', 'Your device does not report skin temperature.', cap('skinTemp')));

  return html`<div class="panels">${out}</div>`;
}

/* ── body ───────────────────────────────────────────────────── */

function bodyTab(t) {
  const out = [];
  const trend = t.weight?.trend || [];
  const dates = trend.map((r) => r.date);
  const kg = trend.map((r) => (f.isNum(r.kg) ? f.weightVal(r.kg) : null));
  const avg7 = trend.map((r) => (f.isNum(r.avg7) ? f.weightVal(r.avg7) : null));
  const u = f.weightUnit();
  const addBtn = html`<button type="button" class="btn btn--tonal btn--s" data-action="add-weight">${ic('plus', { size: 's' })}Add weight</button>`;

  if (count(kg) || count(avg7)) {
    const latest = t.weight.latest?.avg7 ?? lastOfRaw(trend);
    const ch = t.weight.change30;
    out.push(panel({
      k: 'Weight', v: html`${f.weightNum(latest)}<span class="unit">${u}</span>`,
      s: f.isNum(ch) ? `7-day average. ${Math.abs(f.weightVal(ch)) < 0.05 ? 'Steady' : `${ch > 0 ? 'Up' : 'Down'} ${f.dec1(Math.abs(f.weightVal(ch)))} ${u}`} over 30 days.` : '7-day average',
      wide: true, action: addBtn,
      body: chartbox(chart((w) => line({ w, dates, series: [{ values: avg7, label: 'Average' }, { values: kg, label: 'Weigh-in', quiet: true, pointsOnly: true }], fmt: (v) => f.dec1(v), unit: u, label: `Weight: the 7-day average and each day's weigh-in. ${describe(kg, (v) => f.dec1(v), u)}` })), {
        legend: legend([['sw-met', '7-day average'], ['sw-dot', 'Each weigh-in']]),
        table: table(dates.filter((_, i) => f.isNum(kg[i])), [[`Weight (${u})`, kg.filter(f.isNum), (v) => f.dec1(v)]]),
      }),
    }));
  } else {
    out.push(html`<section class="panel panel--wide"><div class="empty">
      <span class="empty__ic">${ic('scale')}</span>
      <h2 class="empty__t">No weigh-ins ${cap('weight') ? 'in this range' : 'yet'}</h2>
      <p class="empty__d">${cap('weight') ? 'Try a longer range, or add one now.' : 'Add your weight here, or use a smart scale that sends it to Google Health. Either way it is saved to Google Health too.'}</p>
      ${addBtn}
    </div></section>`);
  }

  const sdates = t.series.map((r) => r.date);
  const fat = t.series.map((r) => r.bodyFat);
  if (count(fat)) {
    out.push(panel({
      k: 'Body fat', v: html`${f.dec1(lastOf(fat))}<span class="unit">%</span>`, s: 'Latest reading',
      body: chartbox(chart((w) => line({ w, dates: sdates, series: [{ values: fat, label: 'Body fat', dots: true, connect: true }], fmt: (v) => f.dec1(v), unit: '%', label: `Body fat percentage. ${describe(fat, (v) => f.dec1(v), 'percent')}` })), { table: table(sdates.filter((_, i) => f.isNum(fat[i])), [['Body fat (%)', fat.filter(f.isNum), (v) => f.dec1(v)]]) }),
    }));
  } else out.push(absent('Body fat', 'scale', 'bodyFat', 'Body fat comes from a smart scale linked to Google Health. Yours does not report it.', cap('bodyFat')));

  return html`<div class="panels">${out}</div>`;
}
const lastOfRaw = (trend) => { for (let i = trend.length - 1; i >= 0; i -= 1) if (f.isNum(trend[i].avg7 ?? trend[i].kg)) return trend[i].avg7 ?? trend[i].kg; return null; };

function addWeight(onSaved) {
  const u = f.weightUnit();
  const canWrite = app.me.google?.canWriteWeight !== false;
  const s = sheet({
    title: 'Add weight',
    body: html`<form class="form" id="weight-form" novalidate>
      ${!canWrite ? banner({ tone: 'warn', title: 'Saving is not allowed yet', text: 'Reconnect to allow saving your weight.', actions: html`<button type="button" class="btn btn--s" data-action="connect-google" data-return="/trends/body">Reconnect Google</button>` }) : ''}
      <div data-slot="error"></div>
      ${field({ label: `Weight (${u})`, name: 'weight', type: 'number', attrs: `inputmode="decimal" step="0.1" min="${u === 'lb' ? 44 : 20}" max="${u === 'lb' ? 880 : 400}" required autofocus placeholder="${u === 'lb' ? '170.0' : '77.0'}"` })}
      ${field({ label: 'When', name: 'at', type: 'datetime-local', value: f.toLocalInput(Date.now()), attrs: 'step="60"', hint: 'Now, or any time in the last 30 days.' })}
      ${field({ label: 'Note (optional)', name: 'note', attrs: 'maxlength="80" autocomplete="off"' })}
      <p class="field__hint">It is saved to Google Health as well, so your other apps see it.</p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="weight-form">Save</button>`,
  });
  const form = s.el.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    fieldError(form, 'weight', ''); fieldError(form, 'at', '');
    const kg = f.toKg(v.weight);
    if (!f.isNum(kg) || kg < 20 || kg > 400) { fieldError(form, 'weight', `Enter a weight between ${u === 'lb' ? '44 and 880 lb' : '20 and 400 kg'}.`); return; }
    const at = v.at ? f.fromLocalInput(v.at) : Date.now();
    if (at > Date.now() + 60000) { fieldError(form, 'at', 'That time is in the future.'); return; }
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/weight', { kg: Math.round(kg * 100) / 100, at, ...(v.note ? { note: v.note } : {}) }));
      if (r === undefined) return;
      s.close();
      toast('Weight saved');
      onSaved();
    } catch (err) {
      mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err, 'Could not save your weight. Try again.') }));
    }
  });
}

/* ── the page ───────────────────────────────────────────────── */

export default async function trends(ctx) {
  const { root } = ctx;
  const tab = TABS.some(([id]) => id === ctx.params.tab) ? ctx.params.tab : 'sleep';
  if (ctx.params.tab && ctx.params.tab !== tab) { go('/trends', { replace: true }); return; }
  let days = 30;
  try { const s = Number(localStorage.getItem(RANGE_KEY)); if ([7, 30, 90].includes(s)) days = s; } catch { /* default */ }
  let data = null;
  document.title = `${TABS.find(([id]) => id === tab)[1]} trends · Health`;

  const chrome = (body) => html`
    ${head({ title: 'Trends' })}
    <nav class="seg subnav" aria-label="Trends">
      ${TABS.map(([id, label]) => html`<a class="seg__opt" href="/trends/${id}" ${raw(id === tab ? 'aria-current="page"' : '')}>${label}</a>`)}
    </nav>
    <div class="toolbar toolbar--end">
      ${seg('range', RANGES, days, { fit: true, label: 'Range' })}
    </div>
    <div class="stack">${connectionBanner(`/trends/${tab}`)}${body}</div>`;

  function paint() {
    const t = data;
    const g = app.me.google?.state;
    let body;
    if (g !== 'ok' && !t.series?.some((r) => Object.entries(r).some(([k, v]) => k !== 'date' && f.isNum(v)))) {
      body = html`<div class="group"><div class="empty"><span class="empty__ic">${ic('trends')}</span><p class="empty__t">No history yet</p><p class="empty__d">Trends are drawn from your Google Health history. Connect Google and up to 90 days fill in.</p></div></div>`;
    } else {
      body = tab === 'sleep' ? sleepTab(t) : tab === 'activity' ? activityTab(t) : tab === 'heart' ? heartTab(t) : bodyTab(t);
    }
    mount(root, chrome(body));
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(root, chrome(skeleton('chart')));
    try {
      data = await api.get(`/api/trends?days=${days}`);
      if (ctx.alive()) paint();
    } catch (err) {
      if (ctx.alive() && !quiet) mount(root, chrome(errorState(err)));
    }
  }

  on(root, 'click', '[data-seg="range"]', (e, b) => {
    days = Number(b.dataset.value);
    try { localStorage.setItem(RANGE_KEY, String(days)); } catch { /* fine */ }
    load();
  });
  on(root, 'click', '[data-action="retry"]', () => load());
  on(root, 'click', '[data-action="add-weight"]', () => addWeight(() => load({ quiet: true })));
  ctx.onLeave(listen('changed', (what) => { if (what.includes('data')) load({ quiet: true }); }));
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
}
