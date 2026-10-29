/* The Log button and the Log sheet: one place to log anything.

   openLog() reads GET /api/log (every kind, where it goes, today's totals,
   recent entries, Hevy routines) and shows:

     a filter      "What do you want to log?": narrows the tiles, and turns
                   into a food search when it is food you are after
     quick row     water in one tap, and the workout (start, or the one
                   running)
     tiles         every kind, grouped, each with its last entry; a kind
                   whose group is off says so and turns it on
     recent        the last things logged, to change or remove

   The forms are each metric's own entry sheet (entry.js). Food and
   workouts have flows of their own here: food is looked up (your foods,
   common foods, Open Food Facts by name or barcode) and weighed out;
   a workout is started, or logged with exercises from the Hevy library
   and sets, or started from a Hevy routine. */

import { api } from './api.js';
import { app, refreshMe, emit, go } from './app.js';
import { html, raw, mount, ic, sheet, banner, toast, toastError, errText, on, busy, esc } from './ui.js';
import { ib } from './kit.js';
import { addEntry as openEntry, reportSaved, deleteEntry } from './entry.js';
import * as f from './format.js';

const FAMILY = { workout: 'workouts', water: 'water', food: 'nutrition', weight: 'body', bodyfat: 'body', measure: 'body', height: 'body', sleep: 'sleep', mood: 'mind', glucose: 'vitals', bodytemp: 'vitals', symptom: 'vitals', period: 'cycle', ovulation: 'cycle' };
const GLYPH = { workout: 'strength', water: 'drop', food: 'restaurant', weight: 'scale', bodyfat: 'bodyfat', measure: 'straighten', height: 'height', sleep: 'moon', mood: 'mood', glucose: 'glucose', bodytemp: 'thermostat', symptom: 'symptom', period: 'cycle', ovulation: 'science' };
/** Words people type for each kind, so the filter finds it. */
const WORDS = {
  workout: 'workout exercise gym lift training run ride session sets hevy routine',
  water: 'water drink hydration glass bottle',
  food: 'food meal eat calories kcal breakfast lunch dinner snack protein carbs fat barcode',
  weight: 'weight weigh scale kg lb',
  bodyfat: 'body fat percent',
  measure: 'measurements tape waist chest arms biceps thigh hips neck circumference',
  height: 'height tall',
  sleep: 'sleep nap night bed rest',
  mood: 'mood feeling feel emotion mind',
  glucose: 'glucose sugar blood diabetes',
  bodytemp: 'temperature fever thermometer',
  symptom: 'symptom sick headache pain ill',
  period: 'period menstrual cycle',
  ovulation: 'ovulation test lh',
};

const since = (t) => {
  if (!f.isNum(t)) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  const d = Math.round(min / 1440);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
const mealNow = () => { const h = new Date().getHours(); return h < 10.5 ? 'BREAKFAST' : h < 15 ? 'LUNCH' : h < 21 ? 'DINNER' : 'SNACK'; };
const MEALS = [['BREAKFAST', 'Breakfast'], ['LUNCH', 'Lunch'], ['DINNER', 'Dinner'], ['SNACK', 'Snack']];
const done = (what) => { emit('changed', what); refreshMe().catch(() => {}); };

/* ── the sheet ──────────────────────────────────────────────── */

let openNow = null;

export async function openLog({ q = '' } = {}) {
  if (openNow) return openNow;
  let d;
  const s = sheet({
    title: 'Log',
    body: html`<div class="log" data-slot="log"><div class="log__load"><span class="spin" aria-hidden="true"></span><span>Loading</span></div></div>`,
  });
  s.el.classList.add('sheet--log');
  openNow = s;
  s.closed.then(() => { openNow = null; });
  const slot = s.el.querySelector('[data-slot="log"]');
  try { d = await api.get('/api/log'); } catch (err) { mount(slot, banner({ tone: 'bad', title: errText(err, 'The log could not be loaded. Try again.') })); return s; }
  paintLog(s, slot, d, q);
  return s;
}

function tile(k) {
  const fam = FAMILY[k.id] || 'body';
  const off = !k.available;
  const last = k.running ? `Running since ${f.clock(k.running.start)}` : k.last ? `${k.last.text} · ${since(k.last.at)}` : off ? (k.needs ? 'Turn it on to log' : 'Not available') : 'Nothing yet';
  return html`<button type="button" class="ltile fam fam-${fam} ${off ? 'ltile--off' : ''} ${k.running ? 'ltile--live' : ''}" data-kind="${k.id}" data-words="${`${k.label} ${WORDS[k.id] || ''}`.toLowerCase()}">
    ${ib(GLYPH[k.id] || 'plus')}
    <span class="ltile__t">${k.label}</span>
    <span class="ltile__s">${last}</span>
  </button>`;
}

function paintLog(s, slot, d, q) {
  const groups = [];
  for (const k of d.kinds) { let g = groups.find((x) => x.name === k.group); if (!g) groups.push(g = { name: k.group, kinds: [] }); g.kinds.push(k); }
  const water = d.kinds.find((k) => k.id === 'water');
  const workout = d.kinds.find((k) => k.id === 'workout');
  const t = d.today;
  const goal = t.water.goal || 2000;
  mount(slot, html`
    <label class="log__find">
      ${ic('search', { size: 's' })}
      <input class="input" type="search" data-find placeholder="What do you want to log?" aria-label="What do you want to log" autocomplete="off" enterkeyhint="search" value="${q}">
    </label>
    <div class="log__quick" data-quick>
      ${water?.available ? html`<div class="lq fam fam-water">
        <div class="lq__top">${ib('drop', { size: 's' })}<span class="lq__t">Water today</span><b class="lq__v">${f.int(t.water.ml)} <small>of ${f.int(goal)} ml</small></b></div>
        <div class="lq__bar" role="img" aria-label="${f.int(t.water.ml)} of ${f.int(goal)} ml"><span data-style="width:${Math.min(100, Math.round((t.water.ml / goal) * 100))}%"></span></div>
        <div class="lq__btns">${[250, 330, 500].map((ml) => html`<button type="button" class="btn btn--tonal btn--s" data-water="${ml}">${ic('plus', { size: 's' })}${ml} ml</button>`)}<button type="button" class="btn btn--ghost btn--s" data-kind="water">Other</button></div>
      </div>` : ''}
      <div class="lq fam fam-workouts">
        <div class="lq__top">${ib('strength', { size: 's' })}<span class="lq__t">${workout?.running ? 'Workout running' : 'Workout'}</span>${workout?.running ? html`<b class="lq__v" data-since="${workout.running.start}">${f.clock(workout.running.start)}</b>` : ''}</div>
        <div class="lq__btns">
          ${workout?.running
            ? html`<a class="btn btn--s" href="/workouts/${workout.running.id}" data-close>${ic('timer', { size: 's' })}Open it</a>`
            : html`<button type="button" class="btn btn--s" data-start>${ic('play', { size: 's' })}Start now</button>`}
          <button type="button" class="btn btn--tonal btn--s" data-kind="workout">Log one</button>
          ${d.routines?.length ? html`<button type="button" class="btn btn--ghost btn--s" data-routines>${ic('list', { size: 's' })}From a routine</button>` : ''}
        </div>
      </div>
      ${t.food.items ? html`<div class="lq lq--line fam fam-nutrition">${ib('restaurant', { size: 's' })}<span class="lq__t">Food today</span><b class="lq__v">${f.int(t.food.kcal)} kcal</b><span class="lq__s">${[t.food.protein ? `${f.int(t.food.protein)} g protein` : '', t.food.carbs ? `${f.int(t.food.carbs)} g carbs` : '', t.food.fat ? `${f.int(t.food.fat)} g fat` : ''].filter(Boolean).join(' · ')}</span></div>` : ''}
    </div>
    <div class="log__food" data-foodhint hidden></div>
    <div class="log__groups" data-tiles>
      ${groups.map((g) => html`<section class="lgroup" data-group="${g.name}"><h3 class="lgroup__h">${g.name}</h3><div class="ltiles">${g.kinds.map(tile)}</div></section>`)}
      <p class="log__none" data-none hidden>Nothing matches. Try a word like "weight", "sleep" or "protein".</p>
    </div>
    ${d.recent?.length ? html`<section class="lrecent">
      <h3 class="lgroup__h">Logged lately</h3>
      <ul class="lrecent__list">${d.recent.map((e) => html`<li class="lrow fam fam-${FAMILY[e.kind] || 'body'}" data-id="${e.id}">
        ${ib(GLYPH[e.kind] || 'plus', { size: 's' })}
        <span class="lrow__t">${e.text}</span>
        <span class="lrow__s">${since(e.t)}</span>
        ${e.metric ? html`<a class="iconbtn iconbtn--s" href="/metric/${e.metric}" data-close aria-label="See ${e.text} on its page">${ic('right', { size: 's' })}</a>` : ''}
        ${e.deletable ? html`<button type="button" class="iconbtn iconbtn--s" data-del="${e.id}" aria-label="Delete ${e.text}">${ic('trash', { size: 's' })}</button>` : ''}
      </li>`)}</ul>
    </section>` : ''}`);

  const find = slot.querySelector('[data-find]');
  // Typing is the fastest way in on a keyboard; on a phone the keyboard would hide the tiles.
  if (matchMedia('(min-width: 600px) and (hover: hover)').matches && !slot.contains(document.activeElement)) find.focus({ preventScroll: true });
  const filter = () => {
    const v = find.value.trim().toLowerCase();
    let any = false;
    for (const g of slot.querySelectorAll('[data-group]')) {
      let shown = 0;
      for (const t2 of g.querySelectorAll('[data-kind]')) { const hit = !v || v.split(/\s+/).every((w) => t2.dataset.words.includes(w)); t2.hidden = !hit; if (hit) shown += 1; }
      g.hidden = !shown; any ||= shown > 0;
    }
    slot.querySelector('[data-none]').hidden = any || !v;
    slot.querySelector('[data-quick]').hidden = !!v;
    // Whatever was typed can always be looked up as food.
    const hint = slot.querySelector('[data-foodhint]');
    const food = d.kinds.find((k) => k.id === 'food');
    hint.hidden = !(v.length >= 2 && food?.available);
    if (!hint.hidden) mount(hint, html`<button type="button" class="lfood" data-foodq="${find.value.trim()}">${ib('search', { fam: 'nutrition', size: 's' })}<span>Look up "<b>${find.value.trim()}</b>" in foods</span>${ic('right', { size: 's' })}</button>`);
  };
  find.addEventListener('input', filter);
  find.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = slot.querySelector('[data-kind]:not([hidden])');
    if (first && find.value.trim()) first.click();
  });
  if (q) filter();

  on(slot, 'click', '[data-water]', async (e, b) => {
    await busy(b, async () => {
      try {
        const r = await api.post('/api/entries', { kind: 'water', ml: Number(b.dataset.water) });
        reportSaved(r, `${b.dataset.water} ml of water`);
        done(['data']);
        const fresh = await api.get('/api/log');
        Object.assign(d, fresh);
        paintLog(s, slot, d, find.value);
      } catch (err) { toastError(err, 'That was not saved. Try again.'); }
    });
  });
  on(slot, 'click', '[data-start]', async (e, b) => {
    await busy(b, async () => {
      try { await api.post('/api/workouts/start', {}); s.close(); toast('Workout started'); done(['workouts']); go('/workouts'); } catch (err) { toastError(err); }
    });
  });
  on(slot, 'click', '[data-routines]', () => routinePicker(d.routines, () => s.close()));
  on(slot, 'click', '[data-foodq]', (e, b) => { s.close(); foodSheet({ q: b.dataset.foodq }); });
  on(slot, 'click', '[data-kind]', async (e, b) => {
    const k = d.kinds.find((x) => x.id === b.dataset.kind);
    if (!k) return;
    if (k.id === 'workout') { s.close(); workoutSheet({}); return; }
    if (k.id === 'food' && k.available) { s.close(); foodSheet({}); return; }
    s.close();
    await openEntry(k.metric, { onSaved: () => done(['data']) });
  });
  on(slot, 'click', '[data-del]', async (e, b) => {
    const entry = d.recent.find((x) => x.id === b.dataset.del);
    if (!entry) return;
    if (await deleteEntry({ label: entry.kind }, { ...entry, google: entry.google })) {
      d.recent = d.recent.filter((x) => x.id !== entry.id);
      b.closest('li')?.remove();
      done(['data']);
    }
  });
  slot.querySelectorAll('[data-style]').forEach((el) => { for (const decl of el.dataset.style.split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } el.removeAttribute('data-style'); });
}

/* ── food ───────────────────────────────────────────────────── */

const macroLine = (x) => [x.protein ? `${Math.round(x.protein)} g protein` : '', x.carbs ? `${Math.round(x.carbs)} g carbs` : '', x.fat ? `${Math.round(x.fat)} g fat` : ''].filter(Boolean).join(' · ');
const round1 = (v) => (f.isNum(v) ? Math.round(v * 10) / 10 : null);

/**
 * Look a food up and log it.
 *   foodSheet({ q })   q: what to search for first
 */
export function foodSheet({ q = '' } = {}) {
  let results = null; let seq = 0; let timer = null;
  const canScan = 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  const s = sheet({
    title: 'Add food',
    body: html`<div class="food">
      <div class="food__bar">
        <label class="log__find food__find">${ic('search', { size: 's' })}<input class="input" type="search" data-q placeholder="Search foods or a brand" aria-label="Search foods" autocomplete="off" enterkeyhint="search" value="${q}"></label>
        <button type="button" class="btn btn--tonal food__scan" data-scan>${ic('barcode', { size: 's' })}<span>Barcode</span></button>
      </div>
      <div data-slot="scan"></div>
      <div data-slot="results" aria-live="polite"></div>
      <div class="food__manual"><button type="button" class="btn btn--ghost btn--s" data-manual>${ic('edit', { size: 's' })}Enter it yourself</button></div>
    </div>`,
  });
  s.el.classList.add('sheet--log');
  const input = s.el.querySelector('[data-q]');
  const out = s.el.querySelector('[data-slot="results"]');

  const row = (x, i) => {
    const per = x.portion ? `${f.int(x.portion.kcal)} kcal a portion` : x.serving ? `${f.int(x.per100.kcal * x.serving.g / 100)} kcal per ${x.serving.label}` : `${f.int(x.per100.kcal)} kcal per 100 g`;
    const sub = [x.brand, x.source === 'own' ? `logged ${f.plural(x.times, 'time')}` : '', per].filter(Boolean).join(' · ');
    return html`<li><button type="button" class="frow" data-pick="${i}"><span class="frow__t">${x.name}</span><span class="frow__s">${sub}</span>${ic('plus', { size: 's' })}</button></li>`;
  };
  const paint = () => {
    if (!results) { mount(out, html`<p class="muted small food__wait">Searching</p>`); return; }
    const all = [...results.mine, ...results.common, ...results.found];
    let i = 0;
    const part = (title, list, note = '') => (list.length ? html`<section class="fsec"><h3 class="lgroup__h">${title}</h3>${note ? html`<p class="fsec__note">${note}</p>` : ''}<ul class="flist">${list.map((x) => row(x, i++))}</ul></section>` : '');
    mount(out, html`
      ${part(results.q ? 'Your foods' : 'Your usual foods', results.mine)}
      ${part('Common foods', results.common, 'Per 100 g, from public nutrition tables')}
      ${part('Packaged foods', results.found, 'From Open Food Facts')}
      ${results.note ? html`<p class="fsec__note">${results.note}</p>` : ''}
      ${!all.length ? html`<p class="muted food__wait">${results.q ? html`Nothing found for "${results.q}". Enter it yourself below.` : 'Type to search, or scan a barcode.'}</p>` : ''}`);
    out._all = all;
  };
  const search = async () => {
    const my = ++seq;
    try {
      const r = await api.get(`/api/food/search?q=${encodeURIComponent(input.value.trim())}`);
      if (my !== seq) return;
      results = r;
      paint();
    } catch (err) { if (my === seq) mount(out, banner({ tone: 'bad', title: errText(err) })); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 320); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } });
  search();

  on(out, 'click', '[data-pick]', (e, b) => {
    const x = out._all?.[Number(b.dataset.pick)];
    if (x) { s.close(); portionSheet(x); }
  });
  s.el.querySelector('[data-manual]').addEventListener('click', async () => { s.close(); await openEntry('food', { onSaved: () => done(['data']) }); });

  // Barcodes: the camera where the browser can read codes, typed digits everywhere.
  s.el.querySelector('[data-scan]').addEventListener('click', () => scanner(s.el.querySelector('[data-slot="scan"]'), canScan, (food) => { s.close(); portionSheet(food); }));
  s.closed.then(() => { stopCamera(); });
  return s;
}

let stream = null;
const stopCamera = () => { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } };

function scanner(slot, canScan, picked) {
  stopCamera();
  mount(slot, html`<div class="scan">
    ${canScan ? html`<div class="scan__cam"><video playsinline muted aria-label="Camera"></video><span class="scan__box" aria-hidden="true"></span></div><p class="field__hint">Point the camera at the barcode.</p>` : ''}
    <form class="scan__form" novalidate>
      <input class="input" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="14" placeholder="Or type the barcode digits" aria-label="Barcode digits" autocomplete="off">
      <button type="submit" class="btn btn--tonal btn--s">Look up</button>
    </form>
    <div data-slot="said"></div>
  </div>`);
  const said = slot.querySelector('[data-slot="said"]');
  const look = async (code) => {
    mount(said, html`<p class="muted small">Looking up ${code}</p>`);
    try {
      const r = await api.get(`/api/food/barcode/${encodeURIComponent(code)}`);
      stopCamera();
      picked(r.food);
    } catch (err) { mount(said, banner({ tone: err.status === 404 ? 'warn' : 'bad', title: errText(err) })); }
  };
  slot.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = String(new FormData(e.target).get('code') || '').replace(/\D/g, '');
    if (code.length < 8) { mount(said, html`<p class="field__err" role="alert">${ic('alert', { size: 's' })}<span>A barcode is 8 to 14 digits.</span></p>`); return; }
    look(code);
  });
  if (!canScan) { slot.querySelector('input').focus(); return; }
  const video = slot.querySelector('video');
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
      // eslint-disable-next-line no-undef
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      const tick = async () => {
        if (!stream) return;
        try {
          const codes = await det.detect(video);
          if (codes.length) { look(codes[0].rawValue); return; }
        } catch { /* a frame it could not read */ }
        setTimeout(tick, 250);
      };
      tick();
    } catch {
      mount(slot.querySelector('.scan__cam'), html`<p class="field__hint">The camera could not be opened. Type the digits instead.</p>`);
    }
  })();
}

/** How much of a food, which meal, then save it. */
function portionSheet(food) {
  const own = food.source === 'own';
  const serving = food.serving;
  let unit = own ? 'portion' : serving ? 'serving' : 'g';
  let amount = unit === 'g' ? 100 : 1;
  let meal = food.meal || mealNow();
  const calc = () => {
    if (own) { const k = amount; const p = food.portion; return { kcal: round1(p.kcal * k), protein: round1(p.protein * k), carbs: round1(p.carbs * k), fat: round1(p.fat * k) }; }
    const g = unit === 'g' ? amount : amount * (serving?.g || 100);
    const k = g / 100; const p = food.per100;
    return { grams: Math.round(g), kcal: round1(p.kcal * k), protein: round1((p.protein ?? 0) * k) || null, carbs: round1((p.carbs ?? 0) * k) || null, fat: round1((p.fat ?? 0) * k) || null };
  };
  const name = food.brand && !food.name.toLowerCase().includes(food.brand.toLowerCase()) ? `${food.name} (${food.brand})` : food.name;
  const s = sheet({
    title: food.name,
    body: html`<form class="form portion" id="portion-form" novalidate>
      <p class="portion__sub">${[food.brand, own ? 'one of your foods' : food.source === 'common' ? 'common food, per 100 g' : 'Open Food Facts'].filter(Boolean).join(' · ')}</p>
      <div class="portion__amt">
        <button type="button" class="iconbtn" data-step="-1" aria-label="Less">${ic('flat')}</button>
        <input class="input portion__n" name="amount" type="number" inputmode="decimal" step="any" min="0" value="${amount}" aria-label="Amount">
        <button type="button" class="iconbtn" data-step="1" aria-label="More">${ic('plus')}</button>
        <div class="pick portion__units" role="group" aria-label="Unit" data-units>
          ${own ? html`<button type="button" class="chip" aria-pressed="true" data-unit="portion">portion</button>` : html`
            ${serving ? html`<button type="button" class="chip" aria-pressed="${String(unit === 'serving')}" data-unit="serving">${serving.label}</button>` : ''}
            <button type="button" class="chip" aria-pressed="${String(unit === 'g')}" data-unit="g">grams</button>`}
        </div>
      </div>
      <div class="portion__sum" data-sum aria-live="polite"></div>
      <div class="field"><span class="field__label" id="pm-l">Meal</span><div class="pick" role="group" aria-labelledby="pm-l" data-meals>${MEALS.map(([id, label]) => html`<button type="button" class="chip" data-meal="${id}" aria-pressed="${String(id === meal)}">${label}</button>`)}</div></div>
      <div data-slot="error"></div>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="portion-form">Add</button>`,
  });
  s.el.classList.add('sheet--log');
  const form = s.el.querySelector('form');
  const n = form.querySelector('[name="amount"]');
  const sum = form.querySelector('[data-sum]');
  const show = () => {
    const v = Number(String(n.value).replace(',', '.'));
    amount = Number.isFinite(v) && v > 0 ? v : 0;
    const c = calc();
    mount(sum, html`<b class="portion__kcal">${f.int(c.kcal || 0)} <small>kcal</small></b>${c.grams ? html`<span>${f.int(c.grams)} g</span>` : ''}<span>${macroLine(c) || 'no macros listed'}</span>`);
  };
  show();
  n.addEventListener('input', show);
  on(form, 'click', '[data-step]', (e, b) => {
    const step = unit === 'g' ? 10 : unit === 'serving' || unit === 'portion' ? 0.5 : 1;
    n.value = String(Math.max(0, Math.round((amount + Number(b.dataset.step) * step) * 10) / 10));
    show();
  });
  on(form, 'click', '[data-unit]', (e, b) => {
    if (b.dataset.unit === unit) return;
    const c = calc();
    unit = b.dataset.unit;
    // Keep the same amount of food when the unit changes.
    n.value = String(unit === 'g' ? (c.grams || 100) : Math.round(((c.grams || 100) / (serving?.g || 100)) * 10) / 10);
    for (const x of form.querySelectorAll('[data-unit]')) x.setAttribute('aria-pressed', String(x === b));
    show();
  });
  on(form, 'click', '[data-meal]', (e, b) => { meal = b.dataset.meal; for (const x of form.querySelectorAll('[data-meal]')) x.setAttribute('aria-pressed', String(x === b)); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = calc();
    if (!(amount > 0) || !f.isNum(c.kcal)) { mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: 'Enter how much you had.' })); return; }
    const portion = own ? '' : unit === 'g' ? `${f.int(c.grams)} g` : amount === 1 ? serving.label : `${amount} × ${serving.label}`;
    const body = { kind: 'food', name: `${name}${portion ? `, ${portion}` : ''}`.slice(0, 120), meal, kcal: Math.min(10000, Math.round(c.kcal * 10) / 10) };
    for (const k of ['protein', 'carbs', 'fat']) if (f.isNum(c[k]) && c[k] > 0) body[k] = Math.min(1000, c[k]);
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/entries', body));
      if (r === undefined) return;
      s.close();
      reportSaved(r, `${food.name} added`);
      done(['data']);
    } catch (err) { mount(form.querySelector('[data-slot="error"]'), banner({ tone: 'bad', title: errText(err, 'That was not saved. Try again.') })); }
  });
}

/* ── workouts ───────────────────────────────────────────────── */

const TYPES = [
  ['STRENGTH_TRAINING', 'Strength training'], ['WEIGHT_MACHINES', 'Weight machines'], ['FREE_WEIGHTS', 'Free weights'], ['BODY_WEIGHT', 'Bodyweight'],
  ['CIRCUIT_TRAINING', 'Circuit training'], ['HIIT', 'HIIT'], ['RUNNING', 'Running'], ['TREADMILL', 'Treadmill'], ['WALKING', 'Walking'], ['HIKING', 'Hiking'],
  ['BIKING', 'Cycling'], ['STATIONARY_BIKE', 'Indoor cycling'], ['SWIMMING', 'Swimming'], ['ROWING_MACHINE', 'Rowing machine'], ['ELLIPTICAL', 'Elliptical'],
  ['STAIRCLIMBER', 'Stair climber'], ['YOGA', 'Yoga'], ['PILATES', 'Pilates'], ['STRETCHING', 'Stretching'], ['CARDIO_WORKOUT', 'Cardio workout'],
  ['SPORT', 'Sport'], ['WORKOUT', 'Other workout'],
];
const LIFTING = new Set(['STRENGTH_TRAINING', 'WEIGHT_MACHINES', 'FREE_WEIGHTS', 'BODY_WEIGHT', 'CIRCUIT_TRAINING', 'WEIGHTLIFTING', 'FUNCTIONAL_STRENGTH_TRAINING', 'CROSSFIT']);

/**
 * Log a workout: when, what kind, and (for lifting) exercises and sets,
 * picked from the Hevy library or from what you did before.
 *   workoutSheet({ routine })   routine: a Hevy routine to start from
 */
export async function workoutSheet({ routine = null } = {}) {
  const now = Date.now();
  const hevy = !!app.me?.hevy?.connected;
  let type = routine ? 'STRENGTH_TRAINING' : app.me?.workoutType || 'STRENGTH_TRAINING';
  const list = (routine?.exercises || []).map((x) => ({ name: x.name, templateId: x.templateId, muscle: null, sets: x.sets.map((st) => ({ kg: st.kg, reps: st.reps, type: st.type || 'normal' })) }));
  const s = sheet({
    title: routine ? routine.title : 'Log a workout',
    body: html`<form class="form wlog" id="wlog-form" novalidate>
      <div data-slot="error"></div>
      <div class="wlog__when">
        <div class="field"><label class="field__label" for="wl-start">Started</label><input class="input" id="wl-start" name="start" type="datetime-local" step="60" value="${f.toLocalInput(now - 70 * 60_000)}" max="${f.toLocalInput(now)}"></div>
        <div class="field"><label class="field__label" for="wl-min">Minutes</label><input class="input" id="wl-min" name="minutes" type="number" inputmode="numeric" min="5" max="360" step="5" value="60"></div>
      </div>
      <div class="field"><label class="field__label" for="wl-title">Name (optional)</label><input class="input" id="wl-title" name="title" maxlength="80" autocomplete="off" placeholder="${routine ? routine.title : 'Push day'}" value="${routine ? routine.title : ''}"></div>
      <div class="field"><label class="field__label" for="wl-type">Kind</label><select class="select" id="wl-type" name="type">${TYPES.map(([id, label]) => html`<option value="${id}" ${id === type ? 'selected' : ''}>${label}</option>`)}</select></div>
      <div class="wlog__ex" data-slot="ex"></div>
      <p class="entry__note">${ic(hevy ? 'link' : 'lock', { size: 's' })}<span>${hevy ? 'Saved here, to Google Health when it is connected, and to Hevy (exercises from your Hevy library).' : 'Saved here, and to Google Health when it is connected. Link Hevy in Settings to send it there too.'}</span></p>
    </form>`,
    foot: html`<button type="button" class="btn btn--tonal" data-close>Cancel</button><button type="submit" class="btn" form="wlog-form">Save workout</button>`,
  });
  s.el.classList.add('sheet--log', 'sheet--wide');
  const form = s.el.querySelector('form');
  const exSlot = form.querySelector('[data-slot="ex"]');
  const unit = f.weightUnit();
  const shown = (kg) => (f.isNum(kg) ? String(Math.round(f.weightVal(kg) * 100) / 100) : '');

  const drawEx = () => {
    if (!LIFTING.has(type)) { mount(exSlot, ''); return; }
    mount(exSlot, html`
      ${list.map((x, i) => html`<fieldset class="wx" data-x="${i}">
        <legend class="sr">${x.name}</legend>
        <div class="wx__head"><span class="wx__name">${x.name}</span>${x.templateId ? html`<span class="tag">Hevy</span>` : ''}<button type="button" class="iconbtn iconbtn--s" data-wx="del-ex" aria-label="Remove ${x.name}">${ic('trash', { size: 's' })}</button></div>
        <div class="wx__cols" aria-hidden="true"><span>Set</span><span>${unit}</span><span>Reps</span><span></span></div>
        ${x.sets.map((st, j) => html`<div class="wx__s" data-s="${j}">
          <button type="button" class="wx__i ${st.type !== 'normal' ? 'wx__i--k' : ''}" data-wx="kind" aria-label="Set ${j + 1}, ${st.type}. Change the kind">${st.type === 'warmup' ? 'W' : st.type === 'dropset' ? 'D' : st.type === 'failure' ? 'F' : j + 1 - x.sets.slice(0, j).filter((y) => y.type === 'warmup').length}</button>
          <input class="input input--s" type="number" data-f="kg" value="${shown(st.kg)}" inputmode="decimal" min="0" step="any" aria-label="Weight in ${unit}, set ${j + 1}">
          <input class="input input--s" type="number" data-f="reps" value="${f.isNum(st.reps) ? st.reps : ''}" inputmode="numeric" min="0" max="500" step="1" aria-label="Reps, set ${j + 1}">
          <button type="button" class="iconbtn iconbtn--s" data-wx="del-set" aria-label="Remove set ${j + 1}">${ic('x', { size: 's' })}</button>
        </div>`)}
        <button type="button" class="btn btn--ghost btn--s" data-wx="add-set">${ic('plus', { size: 's' })}Add set</button>
      </fieldset>`)}
      <button type="button" class="btn btn--tonal wx__add" data-wx="add-ex">${ic('plus', { size: 's' })}Add exercise</button>`);
  };
  const numOf = (el) => (el && el.value !== '' && Number.isFinite(Number(el.value)) ? Number(el.value) : null);
  const read = () => {
    for (const xe of exSlot.querySelectorAll('[data-x]')) {
      const x = list[Number(xe.dataset.x)];
      for (const se of xe.querySelectorAll('[data-s]')) {
        const st = x.sets[Number(se.dataset.s)];
        const v = numOf(se.querySelector('[data-f="kg"]'));
        if (shown(st.kg) !== (v === null ? '' : String(v))) st.kg = v === null ? null : Math.round(f.toKg(v) * 100) / 100;
        st.reps = numOf(se.querySelector('[data-f="reps"]'));
      }
    }
  };
  drawEx();
  form.querySelector('[name="type"]').addEventListener('change', (e) => { read(); type = e.target.value; drawEx(); });
  on(exSlot, 'click', '[data-wx]', async (e, b) => {
    read();
    const xi = Number(b.closest('[data-x]')?.dataset.x);
    const act = b.dataset.wx;
    if (act === 'add-ex') {
      const picked = await exercisePicker({ hevy });
      if (!picked) return;
      let sets = [];
      try { sets = (await api.get(`/api/exercises/last?name=${encodeURIComponent(picked.name)}`)).sets.map((st) => ({ kg: st.kg, reps: st.reps, type: st.type || 'normal' })); } catch { /* starts empty */ }
      list.push({ name: picked.name, templateId: picked.templateId || null, muscle: null, sets: sets.length ? sets : [{ kg: null, reps: null, type: 'normal' }] });
      drawEx();
      exSlot.querySelector(`[data-x="${list.length - 1}"] [data-f="kg"]`)?.focus();
      return;
    }
    if (act === 'del-ex') list.splice(xi, 1);
    else if (act === 'add-set') { const prev = list[xi].sets[list[xi].sets.length - 1]; list[xi].sets.push(prev ? { kg: prev.kg, reps: prev.reps, type: prev.type === 'warmup' ? 'normal' : prev.type } : { kg: null, reps: null, type: 'normal' }); }
    else if (act === 'del-set') list[xi].sets.splice(Number(b.closest('[data-s]').dataset.s), 1);
    else if (act === 'kind') { const st = list[xi].sets[Number(b.closest('[data-s]').dataset.s)]; const order = ['normal', 'warmup', 'dropset', 'failure']; st.type = order[(order.indexOf(st.type) + 1) % order.length]; }
    drawEx();
    if (act === 'add-set') exSlot.querySelector(`[data-x="${xi}"] [data-s="${list[xi].sets.length - 1}"] [data-f="reps"]`)?.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    read();
    const err = form.querySelector('[data-slot="error"]');
    const start = f.fromLocalInput(form.elements.start.value);
    const minutes = Number(form.elements.minutes.value);
    if (!f.isNum(start)) { mount(err, banner({ tone: 'bad', title: 'Enter when it started.' })); return; }
    if (!(minutes >= 5 && minutes <= 360)) { mount(err, banner({ tone: 'bad', title: 'A workout is 5 minutes to 6 hours long.' })); return; }
    const end = Math.min(Date.now(), start + minutes * 60_000);
    if (end - start < 5 * 60_000) { mount(err, banner({ tone: 'bad', title: 'That would end in the future. Move the start earlier or shorten it.' })); return; }
    const exercises = LIFTING.has(type) ? list.map((x) => ({ name: x.name, ...(x.templateId ? { templateId: x.templateId } : {}), sets: x.sets.filter((st) => f.isNum(st.kg) || f.isNum(st.reps)).map((st) => ({ type: st.type, ...(f.isNum(st.kg) ? { kg: st.kg } : {}), ...(f.isNum(st.reps) ? { reps: Math.round(st.reps) } : {}) })) })).filter((x) => x.sets.length) : undefined;
    const title = form.elements.title.value.trim();
    try {
      const r = await busy(s.el.querySelector('button[type="submit"]'), () => api.post('/api/workouts/log', { start, end, type, ...(title ? { title } : {}), ...(exercises ? { exercises } : {}) }));
      if (r === undefined) return;
      s.close();
      toast(hevy && exercises?.some((x) => x.templateId) ? 'Workout saved. It goes to Hevy in a moment.' : 'Workout saved');
      done(['workouts']);
    } catch (e2) { mount(err, banner({ tone: 'bad', title: errText(e2, 'The workout was not saved. Try again.') })); err.scrollIntoView({ block: 'nearest' }); }
  });
  return s;
}

/** Pick an exercise: the Hevy library and what you did before; make a new one in Hevy. */
function exercisePicker({ hevy }) {
  return new Promise((resolve) => {
    let picked = null; let timer = null; let items = [];
    const s = sheet({
      title: 'Add an exercise',
      body: html`<div class="xpick">
        <label class="log__find">${ic('search', { size: 's' })}<input class="input" type="search" data-q placeholder="${hevy ? 'Search your Hevy library' : 'Search, or type a new name'}" aria-label="Search exercises" autocomplete="off" enterkeyhint="search"></label>
        <ul class="flist" data-slot="list" aria-live="polite"></ul>
        <div data-slot="new"></div>
      </div>`,
    });
    s.el.classList.add('sheet--log');
    const q = s.el.querySelector('[data-q]');
    const ul = s.el.querySelector('[data-slot="list"]');
    const nu = s.el.querySelector('[data-slot="new"]');
    const MUS = { chest: 'Chest', back: 'Back', shoulders: 'Shoulders', arms: 'Arms', legs: 'Legs', core: 'Core', other: 'Other' };
    const load = async () => {
      try { items = (await api.get(`/api/exercises/pick?q=${encodeURIComponent(q.value.trim())}&limit=60`)).exercises; } catch { items = []; }
      const v = q.value.trim();
      mount(ul, items.length ? html`${items.map((x, i) => html`<li><button type="button" class="frow" data-i="${i}">
        <span class="frow__t">${x.name}</span>
        <span class="frow__s">${[x.muscle ? x.muscle.replace(/_/g, ' ') : x.group ? MUS[x.group] : '', x.equipment && x.equipment !== 'none' ? x.equipment.replace(/_/g, ' ') : '', x.lastAt ? `last ${since(x.lastAt)}` : '', x.best ? `best ${Math.round(f.weightVal(x.best.kg) * 10) / 10} ${f.weightUnit()} × ${x.best.reps}` : '', x.templateId ? 'Hevy' : ''].filter(Boolean).join(' · ')}</span>
        ${ic('plus', { size: 's' })}</button></li>`)}` : html`<li class="muted small">${v ? 'Nothing matches.' : hevy ? 'Loading your library.' : 'Type the name of an exercise.'}</li>`);
      const exact = items.some((x) => x.name.toLowerCase() === v.toLowerCase());
      mount(nu, v && !exact ? html`<div class="xpick__new">
        ${hevy ? html`<button type="button" class="btn btn--tonal btn--s" data-new="hevy">${ic('plus', { size: 's' })}Make "${v}" in Hevy</button>` : ''}
        <button type="button" class="btn btn--ghost btn--s" data-new="here">Use "${v}" here only</button>
      </div>` : '');
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    load();
    on(ul, 'click', '[data-i]', (e, b) => { picked = items[Number(b.dataset.i)]; s.close(); });
    on(nu, 'click', '[data-new]', async (e, b) => {
      const v = q.value.trim();
      if (b.dataset.new === 'here') { picked = { name: v, templateId: null }; s.close(); return; }
      await busy(b, async () => {
        try { picked = (await api.post('/api/hevy/templates', { title: v })).exercise; toast(`${v} is in your Hevy library now`); s.close(); } catch (err) { toastError(err); }
      });
    });
    s.closed.then(() => resolve(picked));
  });
}

/** Pick a Hevy routine, then log it as a workout. */
function routinePicker(routines, before) {
  const s = sheet({
    title: 'Start from a routine',
    body: html`<ul class="flist">${routines.map((r) => html`<li><button type="button" class="frow" data-r="${r.id}"><span class="frow__t">${r.title}</span><span class="frow__s">${[r.folder, f.plural(r.exercises, 'exercise'), f.plural(r.sets, 'set')].filter(Boolean).join(' · ')}</span>${ic('right', { size: 's' })}</button></li>`)}</ul>
      <p class="field__hint">Your routines from Hevy. The sets are filled in from the routine; change them to what you did.</p>`,
  });
  s.el.classList.add('sheet--log');
  on(s.el, 'click', '[data-r]', async (e, b) => {
    try {
      const { routine } = await api.get(`/api/hevy/routines/${encodeURIComponent(b.dataset.r)}`);
      s.close(); before?.();
      workoutSheet({ routine });
    } catch (err) { toastError(err); }
  });
}

/* ── the button ─────────────────────────────────────────────── */

/** The Log button's markup, for the shell: a floating button on phones, a
    full-width one at the top of the side rail on wide screens. */
export const logButton = () => html`<button type="button" class="logfab" data-log aria-label="Log something" title="Log something (L)">${ic('plus')}<span class="logfab__t">Log</span></button>`;

document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-log]');
  if (!b) return;
  e.preventDefault();
  openLog({ q: b.dataset.log || '' });
});
// "L" anywhere that is not a text field opens it, on a keyboard.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'l' && e.key !== 'L') return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const t = e.target;
  if (t?.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  if (!app.me?.profile || app.me.profile.onboarding !== 'done') return;
  e.preventDefault();
  openLog();
});

export { esc, raw };
