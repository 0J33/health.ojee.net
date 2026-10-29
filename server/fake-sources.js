/* ============================================================
   health.ojee.net — stand-ins for Hevy, Strava and Open Food Facts.

   Each is a `fetch` that answers like the real service (the shapes of
   api.hevyapp.com/docs, developers.strava.com and openfoodfacts.org),
   held in memory. The tests drive them; the demo hands them to the app
   so every Hevy, Strava and food screen can be tried without an account
   anywhere. Not used in production.
   ============================================================ */

const json = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const iso = (t) => new Date(t).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

/* ── Hevy ──────────────────────────────────────────────────────────── */

export const HEVY_TEMPLATES = [
  ['79D0BB3A', 'Bench Press (Barbell)', 'weight_reps', 'chest', ['triceps', 'shoulders'], 'barbell'],
  ['D04AC939', 'Squat (Barbell)', 'weight_reps', 'quadriceps', ['glutes', 'hamstrings'], 'barbell'],
  ['C6272009', 'Deadlift (Barbell)', 'weight_reps', 'lower_back', ['glutes', 'hamstrings'], 'barbell'],
  ['B5D3A742', 'Lat Pulldown (Cable)', 'weight_reps', 'lats', ['biceps'], 'machine'],
  ['073032BB', 'Overhead Press (Barbell)', 'weight_reps', 'shoulders', ['triceps'], 'barbell'],
  ['55E6546F', 'Bent Over Row (Barbell)', 'weight_reps', 'upper_back', ['biceps'], 'barbell'],
  ['A5AC6449', 'Bicep Curl (Dumbbell)', 'weight_reps', 'biceps', [], 'dumbbell'],
  ['94B7239B', 'Triceps Pushdown', 'weight_reps', 'triceps', [], 'machine'],
  ['C7973E0E', 'Leg Press (Machine)', 'weight_reps', 'quadriceps', ['glutes'], 'machine'],
  ['DCF3B31B', 'Plank', 'duration', 'abdominals', [], 'none'],
  ['3BC06AD3', 'Pull Up', 'bodyweight_reps', 'lats', ['biceps'], 'none'],
  ['F1E57334', 'Chest Press (Machine)', 'weight_reps', 'chest', ['triceps'], 'machine'],
].map(([id, title, type, primary, secondary, equipment]) => ({ id, title, type, primary_muscle_group: primary, secondary_muscle_groups: secondary, equipment, is_custom: false }));

/**
 * A Hevy account. `key` is the one API key it accepts; `pro: false`
 * makes every call a 403.
 */
export function fakeHevy({ key = 'hv-test-key-0000-1111-2222', pro = true, username = 'lifter', now = () => Date.now() } = {}) {
  const st = {
    key, pro, user: { id: 'u-1', username, name: 'Test Lifter', url: `https://hevy.com/user/${username}`, weight_unit: 'kg', distance_unit: 'kilometers', is_pro: pro },
    workouts: new Map(), templates: HEVY_TEMPLATES.map((t) => ({ ...t })), routines: [], folders: [{ id: 1, index: 0, title: 'Main', updated_at: iso(now()), created_at: iso(now()) }],
    measurements: new Map(), events: [], calls: [], seq: 1, fail: null,
  };
  const page = (list, url, size = 10) => {
    const p = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const n = Math.max(1, Number(url.searchParams.get('pageSize')) || size);
    const count = Math.max(1, Math.ceil(list.length / n));
    return { page: p, page_count: count, items: list.slice((p - 1) * n, p * n) };
  };
  const workoutOut = (w) => ({ ...w, exercises: w.exercises.map((x, i) => ({ ...x, index: i, title: x.title || st.templates.find((t) => t.id === x.exercise_template_id)?.title || 'Exercise', sets: x.sets.map((s, j) => ({ index: j, type: 'normal', weight_kg: null, reps: null, distance_meters: null, duration_seconds: null, rpe: null, custom_metric: null, ...s })) })) });
  const api = {
    state: st,
    /** A workout done in the Hevy app. */
    addWorkout({ title = 'Push', start, minutes = 60, exercises, description = null } = {}) {
      const id = `hw-${st.seq++}`;
      const t = now();
      const w = {
        id, title, description, routine_id: null, start_time: iso(start), end_time: iso(start + minutes * MIN), updated_at: iso(t), created_at: iso(t),
        exercises: exercises || [{ exercise_template_id: '79D0BB3A', sets: [{ weight_kg: 60, reps: 8 }, { weight_kg: 70, reps: 6 }, { weight_kg: 70, reps: 5 }] }, { exercise_template_id: '94B7239B', sets: [{ weight_kg: 25, reps: 12 }, { weight_kg: 25, reps: 10 }] }],
      };
      st.workouts.set(id, w);
      st.events.push({ at: t, type: 'updated', id });
      return workoutOut(w);
    },
    editWorkout(id, patch) { const w = st.workouts.get(id); Object.assign(w, patch, { updated_at: iso(now()) }); st.events.push({ at: now(), type: 'updated', id }); return workoutOut(w); },
    deleteWorkout(id) { st.workouts.delete(id); st.events.push({ at: now(), type: 'deleted', id }); },
    addRoutine({ title = 'Push day', exercises } = {}) {
      const r = { id: `hr-${st.seq++}`, title, folder_id: 1, updated_at: iso(now()), created_at: iso(now()), exercises: (exercises || [{ exercise_template_id: '79D0BB3A', sets: [{ weight_kg: 60, reps: 8 }, { weight_kg: 60, reps: 8 }] }]).map((x, i) => ({ index: i, title: st.templates.find((t) => t.id === x.exercise_template_id)?.title, rest_seconds: 90, notes: null, superset_id: null, ...x, sets: x.sets.map((s, j) => ({ index: j, type: 'normal', ...s })) })) };
      st.routines.push(r);
      return r;
    },
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const m = (init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : null;
      st.calls.push(`${m} ${url.pathname}`);
      if (st.fail) { const f = st.fail; if (f.once) st.fail = null; return json(f.status, { error: f.message || 'failed' }); }
      if (init.headers?.['api-key'] !== st.key) return json(401, { error: 'Unauthorized' });
      if (!st.pro) return json(403, { error: 'Hevy Pro required' });
      const p = url.pathname;
      let mm;
      if (m === 'GET' && p === '/v1/user/info') return json(200, { data: st.user });
      if (p === '/v1/workouts' && m === 'GET') {
        const list = [...st.workouts.values()].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).map(workoutOut);
        const pg = page(list, url);
        return json(200, { page: pg.page, page_count: pg.page_count, workouts: pg.items });
      }
      if (p === '/v1/workouts' && m === 'POST') {
        const w = body.workout;
        if (!w?.title || !w.start_time || !Array.isArray(w.exercises)) return json(400, { error: 'Invalid request body' });
        if (w.exercises.some((x) => !st.templates.some((t) => t.id === x.exercise_template_id))) return json(400, { error: 'Unknown exercise template' });
        const id = `hw-${st.seq++}`;
        const row = { id, title: w.title, description: w.description || null, routine_id: null, start_time: w.start_time, end_time: w.end_time, updated_at: iso(now()), created_at: iso(now()), exercises: w.exercises };
        st.workouts.set(id, row);
        st.events.push({ at: now(), type: 'updated', id });
        return json(201, { workout: [workoutOut(row)] });
      }
      if (m === 'GET' && p === '/v1/workouts/count') return json(200, { workout_count: st.workouts.size });
      if (m === 'GET' && p === '/v1/workouts/events') {
        const since = Date.parse(url.searchParams.get('since') || '1970-01-01T00:00:00Z');
        const evs = st.events.filter((e) => e.at > since).map((e) => (e.type === 'deleted' ? { type: 'deleted', id: e.id, deleted_at: iso(e.at) } : st.workouts.has(e.id) ? { type: 'updated', workout: workoutOut(st.workouts.get(e.id)) } : null)).filter(Boolean);
        const pg = page(evs, url);
        return json(200, { page: pg.page, page_count: pg.page_count, events: pg.items });
      }
      if ((mm = /^\/v1\/workouts\/([^/]+)$/.exec(p))) {
        const w = st.workouts.get(decodeURIComponent(mm[1]));
        if (!w) return json(404, { error: 'Workout not found' });
        if (m === 'GET') return json(200, workoutOut(w));
        if (m === 'PUT') { Object.assign(w, body.workout, { updated_at: iso(now()) }); st.events.push({ at: now(), type: 'updated', id: w.id }); return json(200, workoutOut(w)); }
      }
      if (p === '/v1/exercise_templates' && m === 'GET') { const pg = page(st.templates, url, 100); return json(200, { page: pg.page, page_count: pg.page_count, exercise_templates: pg.items }); }
      if (p === '/v1/exercise_templates' && m === 'POST') {
        const x = body.exercise;
        if (!x?.title) return json(400, { error: 'Invalid request body' });
        const id = String(1000 + st.seq++);
        st.templates.push({ id, title: x.title, type: x.exercise_type, primary_muscle_group: x.muscle_group, secondary_muscle_groups: x.other_muscles || [], equipment: x.equipment_category, is_custom: true });
        return json(200, { id: Number(id) });
      }
      if (p === '/v1/routines' && m === 'GET') { const pg = page(st.routines, url); return json(200, { page: pg.page, page_count: pg.page_count, routines: pg.items }); }
      if (p === '/v1/routines' && m === 'POST') { const r = api.addRoutine({ title: body.routine.title, exercises: body.routine.exercises }); return json(201, { routine: [r] }); }
      if (p === '/v1/routine_folders' && m === 'GET') { const pg = page(st.folders, url); return json(200, { page: pg.page, page_count: pg.page_count, routine_folders: pg.items }); }
      if (p === '/v1/body_measurements' && m === 'GET') { const pg = page([...st.measurements.values()].sort((a, b) => (a.date < b.date ? 1 : -1)), url); return json(200, { page: pg.page, page_count: pg.page_count, body_measurements: pg.items }); }
      if (p === '/v1/body_measurements' && m === 'POST') {
        if (!body?.date) return json(400, { error: 'date is required' });
        if (st.measurements.has(body.date)) return json(409, { error: 'A measurement for this date already exists' });
        st.measurements.set(body.date, { ...body });
        return json(201);
      }
      if ((mm = /^\/v1\/body_measurements\/(\d{4}-\d{2}-\d{2})$/.exec(p))) {
        if (m === 'GET') return st.measurements.has(mm[1]) ? json(200, st.measurements.get(mm[1])) : json(404, { error: 'Not found' });
        if (m === 'PUT') { if (!st.measurements.has(mm[1])) return json(404, { error: 'No measurement found for the given date' }); st.measurements.set(mm[1], { date: mm[1], ...body }); return json(200); }
      }
      return json(404, { error: `No route ${m} ${p}` });
    },
  };
  api.fetch = api.fetch.bind(api);
  return api;
}

/* ── Strava ────────────────────────────────────────────────────────── */

export const STRAVA_TEST_URLS = { auth: 'https://strava.test/oauth/authorize', token: 'https://strava.test/oauth/token', deauth: 'https://strava.test/oauth/deauthorize', api: 'https://strava.test/api/v3' };

export function fakeStrava({ athleteId = 4242, now = () => Date.now() } = {}) {
  const st = { athlete: { id: athleteId, firstname: 'Tess', lastname: 'Runner', city: 'Cairo' }, activities: new Map(), seq: 900, codes: new Map(), tokens: new Map(), calls: [], subs: [], usage: [0, 0], deauthorized: 0 };
  const api = {
    state: st,
    /** Approve the site: a code the callback can swap for tokens. */
    approve() { const code = `code-${st.seq++}`; st.codes.set(code, true); return code; },
    addActivity({ name = 'Morning Run', sport = 'Run', start, minutes = 35, distance = 6200, hr = 152, calories = 410, polyline = 'mfp_I~hbE??_@?' } = {}) {
      const id = st.seq++;
      const a = { id, name, sport_type: sport, type: sport, start_date: new Date(start).toISOString(), elapsed_time: minutes * 60, moving_time: minutes * 60 - 60, distance, total_elevation_gain: 24, average_heartrate: hr, max_heartrate: hr + 22, average_speed: distance / (minutes * 60), max_speed: 5.1, map: { summary_polyline: polyline }, manual: false, trainer: false, commute: false, private: false, device_name: 'Garmin Forerunner 265', updated_at: new Date(now()).toISOString(), calories };
      st.activities.set(String(id), a);
      return a;
    },
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const m = (init.method || 'GET').toUpperCase();
      st.calls.push(`${m} ${url.pathname}`);
      st.usage = [st.usage[0] + 1, st.usage[1] + 1];
      // A whole test run is one 15-minute window: limits high enough for it.
      const rl = { 'x-ratelimit-limit': st.limit || '5000,50000', 'x-ratelimit-usage': st.usage.join(',') };
      const body = init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)))) : {};
      const p = url.pathname;
      if (p.endsWith('/oauth/token') && m === 'POST') {
        if (body.grant_type === 'authorization_code') {
          if (!st.codes.delete(body.code)) return json(400, { message: 'Bad Request', errors: [{ field: 'code', code: 'invalid' }] });
          const t = { access: `at-${st.seq++}`, refresh: `rt-${st.seq++}` };
          st.tokens.set(t.access, true);
          return json(200, { token_type: 'Bearer', access_token: t.access, refresh_token: t.refresh, expires_at: Math.floor(now() / 1000) + 21600, expires_in: 21600, athlete: st.athlete });
        }
        if (body.grant_type === 'refresh_token') { const t = `at-${st.seq++}`; st.tokens.set(t, true); return json(200, { access_token: t, refresh_token: body.refresh_token, expires_at: Math.floor(now() / 1000) + 21600 }); }
      }
      if (p.endsWith('/oauth/deauthorize')) { st.deauthorized += 1; return json(200, { access_token: 'x' }); }
      if (p.endsWith('/push_subscriptions')) {
        if (m === 'GET') return json(200, st.subs);
        const s = { id: st.subs.length + 1, callback_url: body.callback_url };
        st.subs.push(s);
        return json(201, { id: s.id });
      }
      const token = /^Bearer (.+)$/.exec(String(init.headers?.authorization || ''))?.[1];
      if (!token || !st.tokens.has(token)) return json(401, { message: 'Authorization Error' }, rl);
      if (m === 'GET' && p.endsWith('/athlete')) return json(200, st.athlete, rl);
      if (m === 'GET' && p.endsWith('/athlete/activities')) {
        const after = Number(url.searchParams.get('after') || 0) * 1000;
        const per = Number(url.searchParams.get('per_page') || 30); const page = Number(url.searchParams.get('page') || 1);
        const list = [...st.activities.values()].filter((a) => Date.parse(a.start_date) > after).sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
        // The summary has no calories: those are in an activity's details only.
        return json(200, list.slice((page - 1) * per, page * per).map(({ calories, ...a }) => a), rl);
      }
      let mm;
      if (m === 'GET' && (mm = /\/activities\/(\d+)$/.exec(p))) { const a = st.activities.get(mm[1]); return a ? json(200, { ...a, description: 'Easy pace.' }, rl) : json(404, { message: 'Record Not Found' }, rl); }
      if (m === 'POST' && p.endsWith('/activities')) {
        if (!body.name || !body.sport_type || !body.start_date_local || !body.elapsed_time) return json(400, { message: 'Bad Request' }, rl);
        const id = st.seq++;
        const a = { id, name: body.name, sport_type: body.sport_type, type: body.sport_type, start_date: `${body.start_date_local}`, elapsed_time: body.elapsed_time, moving_time: body.elapsed_time, distance: body.distance || 0, manual: true, map: { summary_polyline: null }, description: body.description, updated_at: new Date(now()).toISOString() };
        st.activities.set(String(id), a);
        return json(201, a, rl);
      }
      return json(404, { message: `No route ${m} ${p}` }, rl);
    },
  };
  api.fetch = api.fetch.bind(api);
  return api;
}

/* ── Open Food Facts ───────────────────────────────────────────────── */

const PRODUCTS = [
  { code: '0894700010137', product_name: 'Nonfat Greek Yogurt', brands: 'Chobani', serving_size: '150 g', serving_quantity: 150, nutriments: { 'energy-kcal_100g': 52.9, proteins_100g: 9.41, carbohydrates_100g: 3.53, fat_100g: 0 } },
  { code: '3017620422003', product_name: 'Nutella', brands: 'Ferrero', serving_size: '15 g', serving_quantity: 15, nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9 } },
  { code: '5449000000996', product_name: 'Coca-Cola', brands: 'Coca-Cola', serving_size: '330 ml', serving_quantity: 330, nutriments: { 'energy-kcal_100g': 42, proteins_100g: 0, carbohydrates_100g: 10.6, fat_100g: 0 } },
  { code: '6221033120013', product_name: 'Lamar Full Cream Milk', brands: 'Lamar', serving_size: '250 ml', serving_quantity: 250, nutriments: { 'energy-kcal_100g': 62, proteins_100g: 3.1, carbohydrates_100g: 4.7, fat_100g: 3.4 } },
  { code: '8000500310427', product_name: 'Kinder Bueno', brands: 'Ferrero', serving_size: '1 bar (21.5 g)', serving_quantity: 21.5, nutriments: { 'energy-kcal_100g': 571, proteins_100g: 8.6, carbohydrates_100g: 49.5, fat_100g: 37.3 } },
];

export function fakeFood() {
  const st = { calls: [], down: false };
  const api = {
    state: st,
    async fetch(input) {
      const url = new URL(String(input));
      st.calls.push(url.pathname);
      if (st.down) return new Response('<html>Page temporarily unavailable</html>', { status: 503 });
      if (url.pathname === '/search') {
        const q = String(url.searchParams.get('q') || '').toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        return json(200, { hits: PRODUCTS.filter((x) => words.every((w) => `${x.product_name} ${x.brands}`.toLowerCase().includes(w))).map((x) => ({ ...x, brands: [x.brands] })), page: 1 });
      }
      const mm = /\/api\/v2\/product\/(\d+)$/.exec(url.pathname);
      if (mm) { const x = PRODUCTS.find((y) => y.code === mm[1]); return x ? json(200, { status: 1, product: x }) : json(404, { status: 0, status_verbose: 'product not found' }); }
      return json(404, {});
    },
  };
  api.fetch = api.fetch.bind(api);
  return api;
}
export const FOOD_TEST_URLS = { search: 'https://off.test/search', product: 'https://off.test/api/v2/product' };

export { DAY };
