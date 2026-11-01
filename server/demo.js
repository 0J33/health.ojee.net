/* ============================================================
   health.ojee.net — demo mode (`npm run demo`).

   Everything a real deployment talks to is replaced by a stand-in
   that lives in this process:

     Mongo    → FakeMongo (accounts vanish on restart; the real
                accounts database is never opened)
     Google   → core/demo.js, one synthetic Google per fake person,
                each with a different device (PERSONAS), plus a token
                endpoint and a one-click consent page so "Connect
                Google" works end to end for a newly registered account.
                The consent grants exactly the scopes it was asked for
                (on top of what that person already granted), so
                switching an optional group on is a real incremental
                authorization, and a data type whose scope the token
                lacks answers 403 as the real one does
     data dir → data/demo, wiped on every start

   They are friends with one another (SOCIAL), with one request
   waiting for Demo and one person Demo is offered, and they have
   cheered and commented on each other's workouts in the feed. Mira,
   Noor and Lena have profile photos, and two posts have photos
   (server/demo-media: abstract gradients, nobody's face).

   The seeded people go through the REAL code: registered through
   accounts.js, connected through the OAuth exchange, filled by the
   real poller and parser, published by the real social code. Only
   the far ends are fake.
   ============================================================ */

import { createHash, randomBytes } from 'node:crypto';
import { rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeMongo } from './fake-mongo.js';
import { synthFetch, PERSONAS } from './core/demo.js';
import { pkce, SCOPES, groupById, cleanGroups, LOCATION_SCOPE } from './core/google.js';
import { addEntry } from './core/entries.js';
import { addDays, today as todayIn, localToMs } from './core/util.js';
import { importHevy } from './hevy.js';
import { computeCaps } from './caps.js';
import { GARMIN_TEST_KEY, XIAOMI_TEST_CREDS } from './fake-sources.js';
import { setXiaomiMeta } from './xiaomisync.js';
import * as friends from './friends.js';
import * as feed from './feed.js';

export const DEMO_ENDPOINTS = { auth: '/demo/google/consent', token: 'http://google.demo/token', revoke: 'http://google.demo/revoke', api: 'http://google.demo' };

export const SEED = [
  { username: 'demo', persona: 'fitbit', tz: 'Africa/Cairo', displayName: 'Demo', bio: 'Lifting three days a week.', accent: null, hevy: true, detect: true, stress: true,
    groups: ['nutrition', 'mindfulness', 'symptoms', 'cycle', 'ecg'], pins: ['vo2max', 'water', 'resp', 'weight'], goals: { cardioTarget: 180, waterTarget: 2500 },
    notes: 'Desk job. Gym 3 days a week. Trying to sleep before midnight.', body: { sex: 'male', birthYear: 1994 }, scale: true,
    what: 'Fitbit Air with everything; all five optional groups on, with three weeks of water, food, mood, symptoms and cycle entries; four pinned metrics, its own cardio and water targets; Hevy workouts; a detected workout waiting; a Xiaomi scale (Omar on it) with sex and year of birth set for the body ranges' },
  { username: 'mira', persona: 'pixel', tz: 'Europe/London', displayName: 'Mira', bio: 'Runs on Saturdays.', accent: '#e2574c', goals: { stepTarget: 10000 }, groups: ['nutrition', 'mindfulness'], what: 'Pixel Watch: no skin temperature, no body fat; a runner; logs water, food and mood' },
  { username: 'sam', persona: 'phone', tz: 'America/New_York', displayName: 'Sam', bio: '', accent: '#4c8de2', goals: { stepTarget: 6000 }, what: 'phone only: steps and distance' },
  { username: 'noor', persona: null, garmin: true, stress: true, tz: 'Asia/Dubai', displayName: 'Noor', bio: 'Garmin, mostly cycling.', accent: '#e2a94c', what: 'Garmin Venu 2 read directly through Garmin\'s Personal API, no Google account: stress, Body Battery, HRV, SpO2, sleep stages and Garmin\'s sleep score; rides and runs; a few weeks of stress logged by hand' },
  { username: 'kai', persona: 'fitbit2', tz: 'Asia/Tokyo', displayName: 'Kai', bio: 'Keeps to himself.', accent: '#8a6fe8', privacy: { account: 'private' }, what: 'Fitbit; PRIVATE account (not on leaderboards, profile 404s for others)' },
  { username: 'lena', persona: 'apple', tz: 'Europe/Berlin', displayName: 'Lena', bio: 'Apple Watch via Apple Health.', accent: '#3fb8af', privacy: { sleep: true, heart: true }, groups: ['cycle'], walks: true, what: 'Apple Watch; sleep and heart public; cycle tracking on; hikes and walks logged by hand' },
  { username: 'ojee', persona: 'fitbit3', tz: 'Africa/Cairo', displayName: 'ojee', bio: '', accent: null, exerciseType: 'WEIGHT_MACHINES', what: 'the admin; Fitbit Air' },
];
export const SEED_PASSWORD = 'demo';

/** Who is friends with whom; Sam has asked Demo and is waiting; ojee is
    nobody's friend of Demo's but a friend of two of them: a suggestion. */
export const SOCIAL = {
  friends: [['demo', 'mira'], ['demo', 'noor'], ['demo', 'lena'], ['mira', 'noor'], ['mira', 'lena'], ['noor', 'lena'], ['ojee', 'mira'], ['ojee', 'noor']],
  asks: [['sam', 'demo']],
};

/** Hikes on Sundays and walks on Wednesdays, the last three weeks: logged
    by hand, with the distance and climb a route would have given. */
export function demoWalks(tz, now) {
  const today = todayIn(now, tz);
  const out = [];
  for (let k = 21; k >= 1; k -= 1) {
    const date = addDays(today, -k);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0) out.push({ start: localToMs(date, 9 * 60, tz), min: 150 + (k % 3) * 10, type: 'HIKING', title: 'Hike in the Grunewald', distanceM: 9400 + (k % 4) * 600, elevGainM: 380 + (k % 3) * 40 });
    if (dow === 3) out.push({ start: localToMs(date, 7 * 60, tz), min: 45, type: 'WALKING', title: 'Morning walk', distanceM: 4100 + (k % 2) * 300, elevGainM: 25 });
  }
  return out.filter((x) => x.start + x.min * 60_000 <= now);
}

/** A wobbly loop of about the walk's distance through the Grunewald: points [t, lat, lng, alt]. */
export function demoLoop(x, end) {
  const n = 320; const lat0 = 52.4712; const lng0 = 13.2468;
  const r = x.distanceM / (2 * Math.PI * 1.18);   // metres; the wobble makes it longer than a circle
  const seed = (x.start / 60_000) % 97;
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (i / n) * 2 * Math.PI;
    const k = 1 + 0.18 * Math.sin(3 * a + seed) + 0.09 * Math.sin(7 * a + seed * 2);
    const dy = Math.sin(a) * r * k * 0.8; const dx = Math.cos(a) * r * k * 1.15;
    out.push([Math.round(x.start + ((end - x.start) * i) / n), lat0 + dy / 111_320, lng0 + dx / (111_320 * Math.cos((lat0 * Math.PI) / 180)), 60 + 18 * Math.sin(2 * a + seed)]);
  }
  return out;
}

/** A Hevy export for a fake person: three sessions a week for ten weeks,
    at the times their fake watch also logged a session. */
export function demoHevyCsv(tz, now) {
  const plan = {
    1: ['Push Day', [['Bench Press (Barbell)', 70, 8, 4], ['Overhead Press (Dumbbell)', 20, 10, 3], ['Triceps Pushdown', 30, 12, 3], ['Lateral Raise (Dumbbell)', 8, 15, 3]]],
    3: ['Pull Day', [['Bent Over Row (Barbell)', 62.5, 8, 4], ['Lat Pulldown (Cable)', 55, 10, 3], ['Bicep Curl (Dumbbell)', 14, 12, 3], ['Face Pull', 22.5, 15, 3]]],
    5: ['Leg Day', [['Squat (Barbell)', 90, 6, 4], ['Romanian Deadlift (Barbell)', 82.5, 8, 3], ['Leg Extension (Machine)', 50, 12, 3], ['Cable Crunch', 35, 15, 3]]],
  };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (date, min) => { const [y, m, d] = date.split('-').map(Number); return `${d} ${MON[m - 1]} ${y}, ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; };
  const rows = ['"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"'];
  const today = todayIn(now, tz);
  for (let k = 70; k >= 1; k -= 1) {
    const date = addDays(today, -k);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!plan[dow]) continue;
    const [title, exercises] = plan[dow];
    const prog = 1 + 0.01 * ((70 - k) / 7);
    for (const [name, kg, reps, sets] of exercises) {
      rows.push(`"${title}","${fmt(date, 18 * 60 + 10)}","${fmt(date, 19 * 60 + 8)}","","${name}",,"",0,"warmup",${Math.round(kg * 0.5 * 2) / 2},10,,,`);
      for (let i = 1; i <= sets; i += 1) rows.push(`"${title}","${fmt(date, 18 * 60 + 10)}","${fmt(date, 19 * 60 + 8)}","","${name}",,"",${i},"normal",${Math.round(kg * prog * 2) / 2},${reps},,,${i === sets ? 9 : 8}`);
    }
  }
  return rows.join('\n');
}

/** Stress logged by hand (this app's 1 to 5 scale): most evenings for
    three weeks, the same on every start. */
export function demoStress(tz, now) {
  const today = todayIn(now, tz);
  const out = [];
  const LEVELS = [2, 3, 2, 4, 3, 1, 2, 3, 5, 2, 2, 3, 4, 2, 1, 3, 2, 4, 3, 2, 3];
  for (let k = 20; k >= 0; k -= 1) {
    if (k % 4 === 3) continue;
    const at = localToMs(addDays(today, -k), 18 * 60 + 40 + (k % 3) * 25, tz);
    if (at <= now) out.push(['stress', { at, level: LEVELS[k], ...(k === 1 ? { note: 'Deadline at work.' } : {}) }]);
  }
  return out;
}

/**
 * What a fake person with some optional groups on has logged by hand: a
 * few weeks of it, the same on every start. `[kind, fields]` pairs, oldest
 * first, with nothing in the future.
 */
export function demoEntries(groups, tz, now) {
  const on = new Set(groups || []);
  const today = todayIn(now, tz);
  const out = [];
  const at = (date, min) => localToMs(date, min, tz);
  const add = (kind, fields) => { if (fields.at === undefined || fields.at <= now) out.push([kind, fields]); };
  const MEALS = [
    ['BREAKFAST', 8 * 60 + 5, [['Oats with banana', 380, 13, 62, 8], ['Eggs on toast', 420, 24, 30, 21], ['Yoghurt and granola', 340, 16, 44, 10]]],
    ['LUNCH', 13 * 60 + 20, [['Chicken and rice', 640, 46, 70, 16], ['Lentil soup and bread', 520, 26, 78, 9], ['Tuna salad wrap', 560, 34, 48, 22]]],
    ['DINNER', 19 * 60 + 40, [['Salmon, potatoes, greens', 690, 42, 52, 30], ['Beef stir-fry with noodles', 740, 40, 80, 24], ['Pasta with tomato sauce', 660, 22, 104, 14]]],
  ];
  const MOODS = [['CALM', 'CONTENT'], ['HAPPY', 'ENERGIZED'], ['STRESSED', 'FATIGUED'], ['CONTENT'], ['ANXIOUS', 'WORRIED'], ['GRATEFUL', 'PEACEFUL'], ['FATIGUED']];
  const FEEL = ['PLEASANT', 'PLEASANT', 'UNPLEASANT', 'BASELINE', 'UNPLEASANT', 'PLEASANT', 'BASELINE'];
  for (let k = 20; k >= 0; k -= 1) {
    const date = addDays(today, -k);
    if (on.has('nutrition')) {
      // Glasses through the day: more on some days than others.
      const glasses = 4 + ((k * 7) % 4);
      for (let i = 0; i < glasses; i += 1) add('water', { at: at(date, 7 * 60 + 40 + i * 135 + ((k + i) % 3) * 12), ml: i % 3 === 0 ? 500 : 250 });
      for (const [meal, min, dishes] of MEALS) {
        const [name, kcal, protein, carbs, fat] = dishes[(k + meal.length) % dishes.length];
        add('food', { at: at(date, min + (k % 4) * 6), name, meal, kcal, protein, carbs, fat });
      }
      if (k % 3 === 0) add('food', { at: at(date, 16 * 60 + 10), name: 'Apple and almonds', meal: 'SNACK', kcal: 210, protein: 5, carbs: 24, fat: 11 });
    }
    if (on.has('mindfulness')) add('mood', { at: at(date, 21 * 60 + 15), moods: MOODS[k % MOODS.length], valence: FEEL[k % FEEL.length], ...(k === 2 ? { note: 'Long day, short walk helped.' } : {}) });
    if (on.has('symptoms') && [1, 4, 9, 15].includes(k)) add('symptom', { at: at(date, 18 * 60), symptoms: [['HEADACHE'], ['FATIGUE', 'BACK_PAIN'], ['HEADACHE', 'DIZZINESS'], ['BLOATED']][[1, 4, 9, 15].indexOf(k)] });
  }
  if (on.size >= 3) {
    // Tape measurements every other week, the waist coming down slowly.
    for (const [back, waist] of [[42, 86.5], [28, 85.8], [14, 85.1], [1, 84.4]]) {
      add('measure', { at: at(addDays(today, -back), 7 * 60 + 15), waist, chest_cm: 101 + back / 30, hips: 98.5, left_bicep_cm: 35.2 + (42 - back) / 60, right_bicep_cm: 35.6 + (42 - back) / 60, left_thigh: 58.4 });
    }
  }
  if (on.has('cycle')) {
    // Three periods, about four weeks apart, the last one a few days ago.
    for (const [back, len] of [[62, 5], [34, 4], [6, 5]]) add('period', { start: addDays(today, -back), end: addDays(today, -(back - len + 1)), ...(back === 34 ? { note: 'Lighter than usual.' } : {}) });
    add('ovulation', { at: at(addDays(today, -20), 7 * 60 + 30), result: 'LUTEINIZING_HORMONE_SURGE' });
  }
  return out;
}

/**
 * The stand-ins. `googleFetch(userId)` is handed to createApp.
 */
export function demoParts({ now = () => Date.now(), origin, tzOf = () => 'Africa/Cairo' }) {
  const mongo = new FakeMongo();
  const personaOf = new Map();   // userId -> persona key
  const emailOf = new Map();
  const codes = new Map();       // code -> { challenge, scopes }
  const grants = new Map();      // userId -> Set of scopes this fake Google has granted them
  const synths = new Map();
  const CORE = ['openid', 'email', ...Object.values(SCOPES)];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** A code for a consent that granted `scopes` (the core set when none are
      named). `as` signs in as another of the person's Google accounts (a
      second tracker's): its own email, grants, persona and data. */
  const issue = (challenge, scopes = CORE, as = null) => { const code = randomBytes(8).toString('hex'); codes.set(code, { challenge, scopes: [...scopes], at: now(), as }); return code; };
  /** Which Google identity a call is for: the person's own (their user id),
      or `<userId>~<as>` for another account of theirs. */
  const identity = (userId, as) => (as ? `${userId}~${as}` : userId);
  const fromToken = (userId, init) => {
    const h = new Headers(init.headers || {});
    const m = /^Bearer demo-at-(.+)-\d+$/.exec(h.get('authorization') || '');
    return m ? m[1] : userId;
  };
  const emailFor = (userId, ik) => {
    const base = emailOf.get(userId) || 'demo@example.com';
    if (ik === userId) return base;
    const [local, domain] = base.split('@');
    return `${local}+${ik.split('~')[1]}@${domain}`;
  };
  /** The scopes a connect with some optional groups asks for. */
  const scopesFor = (groups = [], { routes = false } = {}) => [...CORE, ...cleanGroups(groups).flatMap((id) => groupById(id).scopes), ...(routes ? [LOCATION_SCOPE] : [])];

  const googleFetch = (userId) => async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(DEMO_ENDPOINTS.token)) {
      const f = Object.fromEntries(new URLSearchParams(String(init.body || '')));
      if (f.grant_type === 'authorization_code') {
        const c = codes.get(f.code); codes.delete(f.code);
        // Checked the way Google checks it: the verifier must hash to the challenge.
        if (!c || createHash('sha256').update(f.code_verifier || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'code or verifier mismatch' });
        const ik = identity(userId, c.as);
        const idt = `x.${Buffer.from(JSON.stringify({ email: emailFor(userId, ik) })).toString('base64url')}.y`;
        // Incremental authorization: what was just granted joins what this
        // person had already granted, and the reply lists the combined scopes.
        const all = new Set([...(grants.get(ik) || []), ...c.scopes]);
        grants.set(ik, all);
        return json(200, { access_token: `demo-at-${ik}-${now()}`, refresh_token: `demo-rt-${ik}`, expires_in: 3599, token_type: 'Bearer', scope: [...all].join(' '), id_token: idt });
      }
      if (f.grant_type === 'refresh_token') return json(200, { access_token: `demo-at-${String(f.refresh_token).replace(/^demo-rt-/, '')}-${now()}`, expires_in: 3599, token_type: 'Bearer' });
      return json(400, { error: 'unsupported_grant_type' });
    }
    // A revoke withdraws everything: the next connect starts from nothing.
    if (url.startsWith(DEMO_ENDPOINTS.revoke)) {
      const tok = new URLSearchParams(String(init.body || '')).get('token') || '';
      grants.delete(tok.startsWith('demo-rt-') ? tok.slice(8) : userId);
      return json(200, {});
    }
    const ik = fromToken(userId, init);
    if (!synths.has(ik)) {
      // Another account of the same person: a second tracker, by default a Pixel Watch.
      const persona = personaOf.get(ik) || (ik === userId ? personaOf.get(userId) || 'fitbit' : 'pixel');
      synths.set(ik, synthFetch({
        now, tz: tzOf(userId), persona: PERSONAS[persona], backfill: 120,
        scopes: () => (grants.has(ik) ? [...grants.get(ik)] : null),
      }));
    }
    return synths.get(ik)(input, init);
  };

  /** The consent "screen": everything that was asked for is granted,
      straight back to the callback. */
  let chosen = 0;
  const demoConnect = (url) => {
    const back = new URL(url.searchParams.get('redirect_uri') || `${origin}/auth/google/callback`);
    const asked = (url.searchParams.get('scope') || '').split(/\s+/).filter(Boolean);
    // The account chooser: `demo_as` picks one (the tests); otherwise adding
    // an account signs in as a new one, and anything else as the person's
    // own, or the account its login hint names.
    const hint = /\+([a-z0-9]+)@/.exec(url.searchParams.get('login_hint') || '')?.[1] || null;
    const as = url.searchParams.get('demo_as') || (/select_account/.test(url.searchParams.get('prompt') || '') ? `work${(chosen += 1) > 1 ? chosen : ''}` : hint);
    back.searchParams.set('code', issue(url.searchParams.get('code_challenge'), asked.length ? asked : CORE, as === 'me' ? null : as));
    back.searchParams.set('state', url.searchParams.get('state') || '');
    return back.href;
  };

  /** Create the seeded people through the real code paths. */
  async function seed(app, { log = () => {} } = {}) {
    for (const s of SEED) {
      const { user } = await app.accounts.register({ username: s.username, password: SEED_PASSWORD });
      personaOf.set(user.id, s.persona);
      emailOf.set(user.id, `${s.username}@example.com`);
      app.app.createProfile({ userId: user.id, username: user.username, tz: s.tz, now: now() - 80 * 86_400_000 });
      const cur = app.app.profile(user.id);
      app.app.patchProfile(user.id, { displayName: s.displayName, bio: s.bio, accent: s.accent, onboarding: 'done', lastSeenAt: now(), privacy: { ...cur.privacy, ...(s.privacy || {}) } });
      await app.worlds.hold(user.id, async (w) => {
        if (s.goals) w.setSettings(s.goals);
        if (s.pins) w.db.setMeta('pins', s.pins);
        if (s.notes) w.db.setMeta('notes', s.notes);
        if (s.exerciseType) w.db.setMeta('exerciseType', s.exerciseType);
        if (s.body) w.db.setMeta('body', s.body);
        if (!s.persona) return;   // no Google account (Garmin only, below)
        const pk = pkce();
        // The optional groups this person switched on were granted with the rest.
        await w.google.exchange({ code: issue(pk.challenge, scopesFor(s.groups, { routes: true })), verifier: pk.verifier });
        if (s.groups?.length) w.setGroups(s.groups);
        app.app.patchProfile(user.id, { googleState: 'ok' });
      });
      // Garmin read directly, with the key the stand-in takes, through the
      // same code the Connections page uses; the first read waits.
      if (s.garmin) {
        await app.connectGarmin(user.id, GARMIN_TEST_KEY, { keyDays: 90, backfill: 30 });
        // The rest of the month, a week a pass, as the scheduler would bring it.
        for (let i = 0; i < 2; i += 1) await app.worlds.hold(user.id, (w) => app.syncExtras(user.id, w, { force: true, only: 'garmin' }));
      }
      // The stand-in Xiaomi scale, connected as if its code had been scanned, its owner picked.
      if (s.scale) {
        app.app.setSecret(user.id, 'xiaomi', app.vault.seal(JSON.stringify(XIAOMI_TEST_CREDS), `${user.id}:xiaomi`), XIAOMI_TEST_CREDS.userId.slice(-3));
        await app.worlds.hold(user.id, async (w) => {
          setXiaomiMeta(w.db, { accountId: XIAOMI_TEST_CREDS.userId, account: `…${XIAOMI_TEST_CREDS.userId.slice(-3)}`, connectedAt: now(), scheme: 2, profile: 'owner', settings: { toGoogle: false } });
          await app.syncExtras(user.id, w, { force: true, only: 'xiaomi' });
        });
      }
      const r = await app.syncUser(user.id);
      app.scheduler.settle(app.app.profile(user.id), r);
      await app.worlds.hold(user.id, async (w) => {
        // What they logged by hand, through the same code a form would use:
        // each entry is written to their fake Google and kept here, so a
        // later sync reads it back onto the same row.
        for (const [kind, fields] of demoEntries(s.groups, s.tz, now())) await addEntry(w, kind, fields);
        if (s.stress) for (const [kind, fields] of demoStress(s.tz, now())) await addEntry(w, kind, fields);
        if (s.groups?.length) computeCaps(w.db, { now: now(), tz: s.tz });
        if (s.hevy) importHevy({ db: w.db, text: demoHevyCsv(s.tz, now()), tz: s.tz, now: now() });
        if (s.walks) {
          for (const x of demoWalks(s.tz, now())) {
            const end = x.start + x.min * 60_000;
            const r = w.workouts.logPast({ start: x.start, end, title: x.title, type: x.type });
            Object.assign(r, { distanceM: x.distanceM, movingS: Math.round((end - x.start) / 1000 * 0.92), elevGainM: x.elevGainM, updated: now() });
            r.route = { type: x.type, distanceM: x.distanceM, movingS: r.movingS, paceSPerKm: Math.round(r.movingS / (x.distanceM / 1000)), avgSpeedKmh: null };
            w.db.workoutPut(r);
            // A made-up loop through the forest, so the feed and the post page have a route to draw.
            w.db.trackPut(r.id, { type: x.type, points: demoLoop(x, end), pauses: [], start: x.start, end });
          }
        }
        if (s.detect) {
          // Opted in to detection: the session their fake watch recorded a
          // little while ago is found and left waiting for an answer.
          w.setDetection({ enabled: true });
          app.app.patchProfile(user.id, { detect: true });
          await w.workouts.tick({ force: true });
        }
      });
      await app.publish(user.id, { announce: false });
      log(`seeded ${s.username}`);
    }
    seedSocial(app.app, { now: now() });
    try { seedMedia(app); } catch (e) { log(`demo media: ${e.message}`); }
    log('seeded friends and the feed');
  }

  /** Profile photos and two posts' photos, through the same upload steps
      the browser takes (in one chunk: they are small). */
  function seedMedia(app) {
    if (!app.media?.dir) return;
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'demo-media');
    const appDb = app.app;
    const put = (userId, file, o, post = null) => {
      const buf = readFileSync(join(dir, file));
      const { id } = app.media.create(userId, { type: 'image/jpeg', size: buf.length, ...o }, post);
      app.media.putChunk(userId, id, 0, buf);
      const th = file.replace(/\.jpg$/, '.thumb.jpg');
      if (o.kind === 'post') { try { app.media.putThumb(userId, id, 'image/jpeg', readFileSync(join(dir, th))); } catch { /* none */ } }
      return app.media.finish(userId, id);
    };
    for (const name of ['mira', 'noor', 'lena']) {
      const p = appDb.profileByName(name);
      if (p) put(p.userId, `avatar-${name}.jpg`, { kind: 'avatar', w: 512, h: 512 });
    }
    const newest = (name, test) => {
      const p = appDb.profileByName(name);
      if (!p) return null;
      return appDb.all('SELECT * FROM post WHERE user_id = ? ORDER BY end_ms DESC', p.userId).find((r) => { try { return test(JSON.parse(r.data)); } catch { return false; } }) || null;
    };
    const run = newest('mira', (x) => x.paceSPerKm);
    if (run) {
      put(run.user_id, 'post-run.jpg', { kind: 'post', postId: run.id, w: 1600, h: 1200 }, run);
      put(run.user_id, 'post-hike.jpg', { kind: 'post', postId: run.id, w: 1080, h: 1350 }, run);
      appDb.run('UPDATE post SET caption = ? WHERE id = ?', 'Sunrise loop by the river.', run.id);
    }
    const hike = newest('lena', (x) => x.type === 'HIKING');
    if (hike) put(hike.user_id, 'post-hike.jpg', { kind: 'post', postId: hike.id, w: 1080, h: 1350 }, hike);
  }

  /** Friends, a request, and the feed's cheers and comments, through the
      same functions the routes call. Nobody is notified. */
  function seedSocial(appDb, { now: t }) {
    const id = (name) => appDb.profileByName(name).userId;
    for (const [a, b] of SOCIAL.friends) { friends.request(appDb, id(a), b, t - 20 * 86_400_000); friends.accept(appDb, id(b), a, t - 20 * 86_400_000); }
    for (const [a, b] of SOCIAL.asks) friends.request(appDb, id(a), b, t - 3 * 3_600_000);
    // The newest post of a kind by a person (in the last week).
    const posts = (name) => appDb.all('SELECT id, end_ms, data FROM post WHERE user_id = ? AND end_ms >= ? ORDER BY end_ms DESC', id(name), t - 7 * 86_400_000)
      .map((r) => ({ ...JSON.parse(r.data), id: r.id, at: r.end_ms }));
    const pick = (name, test) => posts(name).find(test) || null;
    const said = (name, post, fn) => { if (post) fn(id(name), post); };
    const cheer = (name, post) => said(name, post, (uid, x) => feed.cheer(appDb, { viewerId: uid, id: x.id, now: Math.min(t, x.at + 40 * 60_000) }));
    const comment = (name, post, text, after = 50) => said(name, post, (uid, x) => feed.addComment(appDb, { viewerId: uid, id: x.id, text, now: Math.min(t, x.at + after * 60_000) }));
    const lift = pick('demo', (x) => x.sets > 0);
    const ride = pick('noor', (x) => x.avgSpeedKmh);
    const run = pick('mira', (x) => x.paceSPerKm);
    const hike = pick('lena', (x) => x.type === 'HIKING' || x.type === 'WALKING');
    for (const who of ['mira', 'noor', 'lena']) cheer(who, lift);
    comment('mira', lift, 'That bench is moving up every week.');
    comment('demo', lift, 'Slowly! Legs on Friday.', 75);
    for (const who of ['demo', 'mira']) cheer(who, ride);
    comment('lena', ride, 'How do you keep that pace in this heat?');
    cheer('noor', run); cheer('lena', run);
    cheer('mira', hike);
  }

  return { mongo, googleFetch, demoConnect, seed, personaOf, emailOf, issue, scopesFor, grants, endpoints: { ...DEMO_ENDPOINTS, auth: `${origin}${DEMO_ENDPOINTS.auth}` } };
}

/** Start from nothing every time: the accounts are in memory, so data left
    from the last run would belong to nobody. */
export function wipeDemoData(dir) {
  if (!/[\\/]demo[\\/]?$/.test(dir) && !dir.includes('health-demo')) throw new Error(`refusing to wipe ${dir}: not a demo directory`);
  rmSync(dir, { recursive: true, force: true });
}

export { localToMs };
