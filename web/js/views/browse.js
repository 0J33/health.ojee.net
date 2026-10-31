/* Health (/trends), the tab's first screen. Glance first: two things
   worth knowing about the last 7 days in words, then one solid tile per
   family (sleep, heart, activity, body, vitals, nutrition, mind when
   there is stress or mood, cycle when that group is on), each opening its category page
   (/trends/<section>). Below the fold, everything Browse always had:
   the analysis overview, search, pins, every metric by category, and
   what the app could also hold.

   Data: GET /api/browse (docs/API.md, "Every metric": each metric with
   its latest value and the last 14 days as a spark) and GET /api/brief
   (today's water and food, the usual bands of the vitals, insights).
   The tiles and insights are worked out from those 14 days: the last 7
   against the 7 before. The search text and the open "No data yet" list
   live in history.state, so coming back from a metric page finds the
   list as it was left. */

import { api } from '../api.js';
import { app, listen } from '../app.js';
import { html, mount, ic, head, errorState, on, toast } from '../ui.js';
import { mod, ib } from '../kit.js';
import { metricRow, metricIcon, matches } from '../metrics.js';
import { addEntry, bindPins } from '../entry.js';
import { turnOnGroup, groupOf, groupGrantToast } from '../groups.js';
import { connectionBanner } from './shared.js';
import * as f from '../format.js';

/* The colour a category's title takes: the family most of it belongs to. */
export const CAT_FAM = { activity: 'steps', heart: 'heart', sleep: 'sleep', body: 'body', vitals: 'vitals', nutrition: 'nutrition', mindfulness: 'mind', cycle: 'cycle', other: '' };
export const CAT_LABEL = { activity: 'Activity', heart: 'Heart', sleep: 'Sleep', body: 'Body', vitals: 'Vitals', nutrition: 'Nutrition', mindfulness: 'Mindfulness', cycle: 'Cycle', other: 'Other' };
const CAT_ORDER = Object.keys(CAT_LABEL);
const MAX_PINS = 8;
const N = f.isNum;

/* The last payload, so coming back paints at once (and the scroll position
   can be put back) while a fresh one is fetched. */
let cache = null;        // { uid, data, brief }
const cached = () => (cache && cache.uid === app.me.user?.id ? cache : null);

const state = () => history.state || {};
const remember = (patch) => history.replaceState({ ...state(), ...patch }, '', location.href);

/* ── numbers from the 14-day sparks ─────────────────────────── */

const mean = (xs) => { const v = xs.filter(N); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sd = (xs) => { const v = xs.filter(N); const m = mean(v); return v.length > 2 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : null; };

/** The last 7 days and the 7 before. A total (steps) leaves today out: it is not over. */
function weeks(m, today) {
  const s = (m?.spark || []).slice();
  if (!s.length) return { now: [], prev: [] };
  if (m.kind === 'total' && m.latest?.date === today) s.pop();
  return { now: s.slice(-7), prev: s.slice(-14, -7) };
}

/* ── the insights ───────────────────────────────────────────── */

const hm = (min) => f.dur(Math.round(min));

/**
 * The last 7 days against the 7 before, said in words, for the things
 * where that is worth saying. Ranked by how far the change is outside
 * the ordinary day-to-day wobble.
 */
function changes(byId, today) {
  const defs = [
    { id: 'resting_hr', fam: 'heart', icon: 'heart', href: '/trends/heart', min: 1,
      say: (a, b) => html`<b>Resting heart rate ${a < b ? 'down' : 'up'} ${f.int(Math.abs(a - b))} to ${f.int(a)},</b> on the week before` },
    { id: 'sleep', fam: 'sleep', icon: 'bed', href: '/trends/sleep', min: 10,
      say: (a, b) => html`<b>Sleep ${a > b ? 'up' : 'down'} ${hm(Math.abs(a - b))} a night</b> on last week` },
    { id: 'steps', fam: 'steps', icon: 'steps', href: '/trends/activity', rel: 0.1,
      say: (a, b) => html`<b>Steps ${a > b ? 'up' : 'down'} ${Math.round(Math.abs(a / b - 1) * 100)}% a day</b> on last week` },
    { id: 'hrv', fam: 'recovery', icon: 'wave', href: '/trends/heart', min: 3,
      say: (a, b) => html`<b>HRV ${a > b ? 'up' : 'down'} ${f.int(Math.abs(a - b))} to ${f.int(a)} ms</b> on the week before` },
    { id: 'weight', fam: 'body', icon: 'scale', href: '/trends/body', min: 0.3,
      say: (a, b) => html`<b>Weight ${a > b ? 'up' : 'down'} ${f.dec1(Math.abs(f.weightVal(a) - f.weightVal(b)))} ${f.weightUnit()}</b> on the week before` },
  ];
  const out = [];
  for (const d of defs) {
    const m = byId.get(d.id);
    if (!m) continue;
    const { now, prev } = weeks(m, today);
    if (now.filter(N).length < 4 || prev.filter(N).length < 4) continue;
    const a = mean(now); const b = mean(prev);
    const diff = Math.abs(a - b);
    if (d.min !== undefined && diff < d.min) continue;
    if (d.rel !== undefined && (!b || diff / b < d.rel)) continue;
    const spread = sd([...now, ...prev]) || 1;
    out.push({ ...d, score: diff / spread, text: d.say(a, b) });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** What in the vitals sits outside its usual band, as rows of the tile and words. */
function vitalRows(byId, b) {
  const bm = b?.metrics || {};
  const defs = [
    { id: 'spo2', label: 'SpO2', short: 'SpO2', band: bm.spo2, fmt: (v) => `${f.dec1(v)} %`, word: 'Blood oxygen' },
    { id: 'resp', label: 'Breathing', short: 'Breath', fmt: (v) => `${f.dec1(v)} /min`, word: 'Breathing rate' },
    { id: 'skin_temp', label: 'Skin temp', short: 'Temp', band: bm.tempDev, fmt: (v) => f.tempDelta(v), word: 'Skin temperature' },
  ];
  return defs.map((d) => {
    const m = byId.get(d.id);
    const v = m?.latest?.value;
    if (!N(v)) return null;
    let lo = d.band?.lo; let hi = d.band?.hi;
    if (!N(lo) || !N(hi)) {
      const past = (m.spark || []).slice(0, -1).filter(N);
      const s = sd(past); const mu = mean(past);
      if (N(s) && N(mu) && past.length >= 5) { lo = mu - 2 * s; hi = mu + 2 * s; }
    }
    const off = N(lo) && N(hi) ? (v > hi ? 'up' : v < lo ? 'down' : '') : '';
    return { ...d, v, off, date: m.latest.date };
  }).filter(Boolean);
}

function insights(byId, data, b, vit) {
  const list = [];
  for (const r of vit.filter((x) => x.off)) {
    list.push({ fam: 'vitals', icon: 'thermostat', href: '/trends/vitals', tone: 'warn',
      text: html`<b>${r.word || r.label} ${r.off === 'up' ? 'above' : 'below'} your usual,</b> ${r.fmt(r.v)} ${f.dayRel(r.date).toLowerCase() === 'today' ? 'last night' : f.dayRel(r.date).toLowerCase()}` });
  }
  list.push(...changes(byId, data.today));
  // Too quiet a week: the brief's own insights fill in.
  for (const i of (b?.insights || [])) {
    if (list.length >= 2) break;
    if (!i?.title) continue;
    list.push({ fam: '', icon: i.icon && i.icon !== 'alert' ? i.icon : 'info', href: i.href || '', text: html`<b>${i.title}</b>` });
  }
  return list.slice(0, 2);
}

function insightCard(list) {
  if (!list.length) return '';
  return html`<section class="hl-ins" aria-label="Worth knowing">${list.map((x) => {
    const body = html`<span class="hl-ins__ic ${x.fam ? `fam fam-${x.fam}` : ''}">${ic(x.icon, { size: 's' })}</span><span class="hl-ins__t">${x.text}</span>`;
    return x.href ? html`<a class="hl-ins__i" href="${x.href}">${body}</a>` : html`<p class="hl-ins__i">${body}</p>`;
  })}</section>`;
}

/* ── the tiles ──────────────────────────────────────────────── */

function tile({ fam, label, icon, href, num = '', sub = '', extra = '', aria = '', cls = '' }) {
  return html`<a class="bt bt--${fam} hl-t ${cls}" href="${href}" ${aria ? html`aria-label="${aria}"` : ''}>
    <div class="bt__row"><span class="bt__lab">${label}</span><span class="bt__ic">${ic(icon)}</span></div>
    <div class="hl-t__b">${num ? html`<p class="n n-m">${num}</p>` : ''}${extra}${sub ? html`<p class="bt__sub">${sub}</p>` : ''}</div>
  </a>`;
}

const scoreBand = (s) => (s >= 90 ? 'Excellent' : s >= 80 ? 'Good' : s >= 60 ? 'Fair' : 'Poor');
const hmBig = (min) => { const h = Math.floor(min / 60); const m = Math.round(min % 60); return html`<span data-count>${h}</span><span class="u">h</span>&thinsp;<span data-count>${m}</span><span class="u">m</span>`; };

function sleepTile(byId, today) {
  const m = byId.get('sleep');
  if (!m) return '';
  const avg = mean(weeks(m, today).now);
  const sc = mean(weeks(byId.get('sleep_score'), today).now);
  if (!N(avg)) return tile({ fam: 'sleep', label: 'Sleep', icon: 'bed', href: '/trends/sleep', sub: 'No nights in the last 7 days' });
  return tile({
    fam: 'sleep', label: 'Sleep', icon: 'bed', href: '/trends/sleep',
    num: hmBig(avg), sub: N(sc) ? `Score ${Math.round(sc)} · ${scoreBand(sc)}` : 'a night, on average',
    aria: `Sleep: ${f.dur(Math.round(avg))} a night on average over the last 7 nights${N(sc) ? `, average score ${Math.round(sc)}, ${scoreBand(sc)}` : ''}`,
  });
}

function heartTile(byId, today) {
  const r = byId.get('resting_hr'); const h = byId.get('hrv');
  if (!r && !h) return '';
  const rhr = mean(weeks(r, today).now); const hrv = mean(weeks(h, today).now);
  if (N(rhr)) {
    return tile({
      fam: 'heart', label: 'Heart', icon: 'heart', href: '/trends/heart',
      num: html`<span data-count>${Math.round(rhr)}</span><span class="u">bpm</span>`, sub: `resting${N(hrv) ? ` · HRV ${Math.round(hrv)} ms` : ''}`,
      aria: `Heart: resting heart rate ${Math.round(rhr)} beats a minute on average over 7 days${N(hrv) ? `, heart rate variability ${Math.round(hrv)} milliseconds` : ''}`,
    });
  }
  if (N(hrv)) return tile({ fam: 'heart', label: 'Heart', icon: 'heart', href: '/trends/heart', num: html`<span data-count>${Math.round(hrv)}</span><span class="u">ms</span>`, sub: 'HRV, 7-day average' });
  return tile({ fam: 'heart', label: 'Heart', icon: 'heart', href: '/trends/heart', sub: 'Nothing in the last 7 days' });
}

function activityTile(byId, today) {
  const m = byId.get('steps');
  if (!m) return '';
  const avg = mean(weeks(m, today).now);
  if (!N(avg)) return tile({ fam: 'steps', label: 'Activity', icon: 'steps', href: '/trends/activity', sub: 'No steps in the last 7 days' });
  return tile({ fam: 'steps', label: 'Activity', icon: 'steps', href: '/trends/activity', num: html`<span data-count>${f.int(avg)}</span>`, sub: 'steps a day, 7-day average' });
}

function bodyTile(byId) {
  const m = byId.get('weight');
  if (!m) {
    const fat = byId.get('body_fat');
    if (!fat) return '';
    return tile({ fam: 'body', label: 'Body', icon: 'scale', href: '/trends/body', num: html`${f.dec1(fat.latest.value)}<span class="u">%</span>`, sub: 'body fat, latest' });
  }
  const s = m.spark || [];
  const first = s.findIndex(N);
  const kg = m.latest?.value;
  const days = first >= 0 ? s.length - 1 - first : 0;
  const ch = first >= 0 && N(kg) && days >= 5 ? f.weightVal(kg) - f.weightVal(s[first]) : null;
  const u = f.weightUnit();
  const span = days >= 12 ? '2 weeks' : `${days} days`;
  const sub = N(ch) ? (Math.abs(ch) < 0.05 ? `steady over ${span}` : `${ch > 0 ? '+' : '−'}${f.dec1(Math.abs(ch))} ${u} in ${span}`) : `latest, ${f.dayRel(m.latest.date).toLowerCase()}`;
  return tile({ fam: 'body', label: 'Body', icon: 'scale', href: '/trends/body', num: html`${f.weightNum(kg)}<span class="u">${u}</span>`, sub });
}

function vitalsTile(rows) {
  if (!rows.length) return '';
  const off = rows.filter((r) => r.off);
  const pill = off.length
    ? html`<span class="hl-pill hl-pill--warn">${off.length === 1 ? `${off[0].short} ${off[0].off === 'up' ? 'high' : 'low'}` : `${off.length} unusual`}</span>`
    : html`<span class="hl-pill">All usual</span>`;
  return html`<a class="bt bt--plain hl-t hl-vit ${off.length ? 'hl-vit--off' : ''}" href="/trends/vitals" aria-label="Vitals: ${off.length ? off.map((r) => `${r.word || r.label} ${r.off === 'up' ? 'above' : 'below'} usual`).join(', ') : 'all within your usual range'}. ${rows.map((r) => `${r.label} ${r.fmt(r.v)}`).join(', ')}.">
    <div class="bt__row"><span class="bt__lab">Vitals ${pill}</span><span class="bt__ic">${ic('ecg_trace')}</span></div>
    <ul class="hl-kv">${rows.map((r) => html`<li class="${r.off ? 'is-off' : ''}"><span>${r.label}</span><b class="n">${r.fmt(r.v)}</b></li>`)}</ul>
  </a>`;
}

function nutritionTile(byId, b) {
  const wm = byId.get('water'); const fm = byId.get('food');
  if (!wm && !fm) return '';
  const w = b?.extra?.water; const fd = b?.extra?.food;
  const ml = N(w?.ml) ? w.ml : null; const goal = N(w?.target) && w.target > 0 ? w.target : app.me.goals?.waterMl || 2000;
  const oz = f.getPrefs().water === 'oz';
  const big = (v) => (oz ? f.int(f.waterVal(v)) : v === 0 ? '0' : f.dec1(v / 1000));
  const unit = oz ? 'fl oz' : 'L';
  const pct = N(ml) ? Math.min(100, (ml / goal) * 100) : 0;
  const kcal = N(fd?.kcal) ? fd.kcal : null;
  const sub = `water today${kcal ? ` · food ${f.int(kcal)} kcal` : ''}`;
  return html`<a class="bt bt--water hl-t hl-nut" href="/trends/nutrition" aria-label="Nutrition: ${N(ml) ? `${big(ml)} of ${big(goal)} ${unit === 'L' ? 'litres' : unit} of water today` : 'no water logged today'}${kcal ? `, food ${f.int(kcal)} kilocalories` : ''}">
    <div class="bt__row"><span class="bt__lab">Nutrition</span><span class="bt__ic">${ic('glass')}</span></div>
    <div class="hl-t__b">
      <p class="n n-m">${N(ml) ? big(ml) : f.DASH}<span class="u">of ${big(goal)} ${unit}</span></p>
      <span class="tbar fillbar"><i style="width:${pct.toFixed(1)}%"></i></span>
      <p class="bt__sub">${sub}</p>
    </div>
  </a>`;
}

/* Mind: stress when there is any (the watch's level, or what was logged),
   otherwise the last mood. The words say which it is. */
const stressBand = (v) => (v <= 25 ? 'Rest' : v <= 50 ? 'Low' : v <= 75 ? 'Medium' : 'High');
function mindTile(byId, data) {
  if (!data.categories.some((c) => c.id === 'mindfulness')) return '';
  const st = byId.get('stress'); const bb = byId.get('body_battery'); const m = byId.get('mood');
  const avg = st ? mean(weeks(st, data.today).now) : null;
  const bbNow = bb && N(bb.latest?.value) ? bb.latest.value : null;
  const head = html`<div class="bt__row"><span class="bt__lab">Mind</span><span class="bt__ic">${ic(st ? 'gauge' : 'mood')}</span></div>`;
  if (N(avg)) {
    return html`<a class="bt bt--plain hl-t hl-soft fam fam-mind" href="/trends/mindfulness" aria-label="Mind: stress ${Math.round(avg)} of 100 on average over 7 days, ${stressBand(avg).toLowerCase()}, from your Garmin${N(bbNow) ? `; Body Battery ${Math.round(bbNow)}` : ''}">
      ${head}
      <div class="hl-t__b"><p class="n n-m"><span data-count>${Math.round(avg)}</span><span class="u">stress</span></p><p class="bt__sub">${stressBand(avg)}, 7-day average${N(bbNow) ? ` · Body Battery ${Math.round(bbNow)}` : ''}</p></div>
    </a>`;
  }
  // Logged stress, unless a mood was logged since.
  if (st?.latest?.logged && !(m?.latest?.at && st.latest.at && m.latest.at > st.latest.at)) {
    return html`<a class="bt bt--plain hl-t hl-soft fam fam-mind" href="/trends/mindfulness" aria-label="Mind: you logged ${st.latest.text.toLowerCase()} ${f.dayRel(st.latest.date).toLowerCase()}">
      ${head}
      <div class="hl-t__b"><p class="bt__word">${st.latest.text}</p><p class="bt__sub">You logged it · ${f.dayRel(st.latest.date).toLowerCase()}</p></div>
    </a>`;
  }
  if (!m) {
    if (!N(bbNow)) return '';
    return html`<a class="bt bt--plain hl-t hl-soft fam fam-mind" href="/trends/mindfulness">${head}<div class="hl-t__b"><p class="n n-m"><span data-count>${Math.round(bbNow)}</span><span class="u">of 100</span></p><p class="bt__sub">Body Battery, ${f.dayRel(bb.latest.date).toLowerCase()}</p></div></a>`;
  }
  const t = String(m.latest?.text || '');
  const word = t.split(/[,(]/)[0].trim() || 'Logged';
  const rest = (t.match(/\(([^)]+)\)/) || [])[1] || '';
  return html`<a class="bt bt--plain hl-t hl-soft fam fam-mind" href="/trends/mindfulness">
    ${head}
    <div class="hl-t__b"><p class="bt__word">${word}</p><p class="bt__sub">${[rest, f.dayRel(m.latest.date).toLowerCase()].filter(Boolean).join(' · ')}</p></div>
  </a>`;
}

function cycleTile(byId, data) {
  const m = byId.get('period');
  if (!data.categories.some((c) => c.id === 'cycle')) return '';
  const latest = m?.latest;
  return html`<a class="bt bt--plain hl-t hl-soft fam fam-cycle" href="/trends/cycle">
    <div class="bt__row"><span class="bt__lab">Cycle</span><span class="bt__ic">${ic('cycle')}</span></div>
    <div class="hl-t__b">${latest && N(latest.value)
      ? html`<p class="n n-m">${f.int(latest.value)}<span class="u">${latest.value === 1 ? 'day' : 'days'}</span></p><p class="bt__sub">last period, from ${f.dayShort(latest.date)}</p>`
      : html`<p class="bt__word">Logged</p><p class="bt__sub">See your entries</p>`}</div>
  </a>`;
}

function top(data, b) {
  const metrics = data.categories.flatMap((c) => c.metrics);
  if (!metrics.length) return '';
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const vit = vitalRows(byId, b);
  const tiles = [
    sleepTile(byId, data.today), heartTile(byId, data.today), activityTile(byId, data.today), bodyTile(byId),
    vitalsTile(vit), nutritionTile(byId, b), mindTile(byId, data), cycleTile(byId, data),
  ].filter((t) => String(t));
  return html`${insightCard(insights(byId, data, b, vit))}
    <div class="bento hl-grid">${tiles}</div>`;
}

/* ── below the fold: every metric (as Browse always had it) ─── */

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

export function emptyList(list) {
  return CAT_ORDER.filter((c) => list.some((e) => e.category === c)).map((c) => html`<div class="part">
    <p class="sub">${CAT_LABEL[c]}</p>
    <ul class="erows">${list.filter((e) => e.category === c).map(emptyRow)}</ul>
  </div>`);
}

function category(c, today) {
  return mod({
    title: c.label, fam: CAT_FAM[c.id] || '', cls: 'br-cat', id: `br-${c.id}`,
    tools: html`<span class="br-count"><span aria-hidden="true">${c.metrics.length}</span><span class="sr">${f.plural(c.metrics.length, 'metric')}</span></span>`,
    body: html`<ul class="mrows">${c.metrics.map((m) => metricRow(m, { today, band: true }))}</ul>`,
  });
}

/* The analysis views, one tap away. */
const SECTIONS = [
  ['overview', 'Overview', 'trends', 'Your averages and patterns, 7 days to a year'],
  ['sleep', 'Sleep', 'bed', 'Time asleep, stages, regularity'],
  ['activity', 'Activity', 'steps', 'Steps, active minutes, goals, best days'],
  ['heart', 'Heart', 'heart', 'Resting heart rate, HRV, oxygen, temperature'],
  ['body', 'Body', 'scale', 'Weight and body fat'],
];

export default async function browse(ctx) {
  const { root } = ctx;
  document.title = 'Health';
  const c0 = cached();
  let data = c0?.data || null; let brief = c0?.brief || null;
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

  const sections = () => html`<div class="bsec"><h2>Trends</h2></div>
    <nav class="blist hl-secs" aria-label="Trends">${SECTIONS.map(([id, label, icon, text]) => html`<a class="hl-sec" href="/trends/${id}">
      <span class="hl-sec__ic">${ic(icon, { size: 's' })}</span>
      <span class="hl-sec__b"><span class="hl-sec__t">${label}</span><span class="hl-sec__d">${text}</span></span>
      <span class="hl-sec__chev">${ic('chev_r', { size: 's' })}</span>
    </a>`)}</nav>`;

  const chrome = (topPart, body) => html`
    ${head({ kick: 'Last 7 days', title: 'Health' })}
    ${connectionBanner('/trends')}
    <div class="hl-top" data-top>${topPart}</div>
    <section class="hl-more" aria-label="Every metric">
      ${sections()}
      <div class="bsec"><h2>Every metric</h2><span class="hl-count" data-count-sub>${sub()}</span></div>
      <div class="br-search">
        <label class="sr" for="br-q">Search your data</label>
        <span class="br-search__ic">${ic('search', { size: 's' })}</span>
        <input class="input" id="br-q" type="search" placeholder="Search: steps, oxygen, water…" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" value="${q}">
        <button type="button" class="iconbtn br-search__x" data-action="clear" aria-label="Clear the search" ${q ? '' : 'hidden'}>${ic('x', { size: 's' })}</button>
      </div>
      <div class="br-body" data-body>${body}</div>
    </section>`;

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
      ${hits.length ? mod({ label: 'Matches', cls: 'br-cat', body: html`<ul class="mrows">${hits.map((m) => metricRow(m, { today: data.today, band: true }))}</ul>` }) : ''}
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
      ${intro}
      ${pinned.length ? mod({
        title: 'Pinned', icon: 'pin', cls: 'br-cat br-pinned',
        tools: html`<span class="br-count">${pinned.length} of ${MAX_PINS}<span class="sr"> pins used</span></span>`,
        body: html`<ul class="mrows mrows--wide">${pinned.map((m) => metricRow(m, { today: data.today, band: true }))}</ul>`,
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
    if (!el) { mount(root, chrome(top(data, brief), body())); return; }
    const y = window.scrollY;
    mount(el, body());
    const hs = root.querySelector('[data-count-sub]'); if (hs) hs.textContent = sub();
    window.scrollTo(0, y);
  }

  /** Everything, in place: the top and the list, the scroll and the search box kept. */
  function paintAll() {
    const t = root.querySelector('[data-top]');
    if (!t) { mount(root, chrome(top(data, brief), body())); return; }
    const y = window.scrollY;
    mount(t, top(data, brief));
    paintBody();
    window.scrollTo(0, y);
  }

  const loadingTop = () => html`<div class="hl-ins hl-ins--skel" aria-hidden="true"><span class="skel"></span><span class="skel"></span></div>
    <div class="bento hl-grid" aria-busy="true" aria-label="Loading">${[0, 1, 2, 3, 4, 5].map(() => html`<div class="bt bt--plain hl-t skel"></div>`)}</div>`;

  async function load({ quiet = false } = {}) {
    const mine = seq += 1;
    if (!data) mount(root, chrome(loadingTop(), html`<div class="skelstack"><div class="skel skel--tall"></div></div>`));
    try {
      const [b, br] = await Promise.all([api.get('/api/browse'), api.get('/api/brief').catch(() => null)]);
      if (!ctx.alive() || mine !== seq) return;
      data = b; brief = br || brief; cache = { uid: app.me.user?.id, data, brief };
      paintAll();
    } catch (err) {
      if (!ctx.alive() || mine !== seq) return;
      if (!data || !quiet) { data = null; cache = null; mount(root, html`${head({ kick: 'Last 7 days', title: 'Health' })}${errorState(err)}`); }
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
  on(root, 'keydown', '#br-q', (e, input) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    // Search on the keyboard: done typing, so the keyboard goes and every match shows.
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
  // On a phone the keyboard covers the lower half: the search box goes to the
  // top of the screen, the matches under it, with room to scroll that far
  // even when there are only a few (browse.css, .br-searching).
  on(root, 'focusin', '#br-q', (e, input) => {
    if (!matchMedia('(pointer: coarse)').matches) return;
    const box = input.closest('.br-search');
    root.querySelector('.hl-more')?.classList.add('br-searching');
    requestAnimationFrame(() => box.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  });
  on(root, 'focusout', '#br-q', () => { if (!q) root.querySelector('.hl-more')?.classList.remove('br-searching'); });
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

  if (data) { mount(root, chrome(top(data, brief), body())); load({ quiet: true }); } else await load();
}
