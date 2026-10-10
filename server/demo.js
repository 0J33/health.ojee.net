/* ============================================================
   health.ojee.net — demo mode (`npm run demo`).

   Everything a real deployment talks to is replaced by a stand-in
   that lives in this process:

     Mongo    → FakeMongo (accounts vanish on restart; the real
                accounts database is never opened)
     Google   → core/demo.js, one synthetic Google per fake person,
                each with a different device (PERSONAS), plus a token
                endpoint and a one-click consent page so "Connect
                Google" works end to end for a newly registered account
     data dir → data/demo, wiped on every start

   The seeded people go through the REAL code: registered through
   accounts.js, connected through the OAuth exchange, filled by the
   real poller and parser, published by the real social code. Only
   the far ends are fake.
   ============================================================ */

import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { FakeMongo } from './fake-mongo.js';
import { synthFetch, PERSONAS } from './core/demo.js';
import { pkce, SCOPES } from './core/google.js';
import { addDays, today as todayIn, localToMs } from './core/util.js';
import { importHevy } from './hevy.js';

export const DEMO_ENDPOINTS = { auth: '/demo/google/consent', token: 'http://google.demo/token', revoke: 'http://google.demo/revoke', api: 'http://google.demo' };

export const SEED = [
  { username: 'demo', persona: 'fitbit', tz: 'Africa/Cairo', displayName: 'Demo', bio: 'Lifting three days a week.', accent: null, hevy: true, detect: true,
    notes: 'Desk job. Gym 3 days a week. Trying to sleep before midnight.', what: 'Fitbit Air with everything; Hevy workouts; a detected workout waiting' },
  { username: 'mira', persona: 'pixel', tz: 'Europe/London', displayName: 'Mira', bio: 'Runs on Saturdays.', accent: '#e2574c', goals: { stepTarget: 10000 }, what: 'Pixel Watch: no skin temperature, no body fat; a runner' },
  { username: 'sam', persona: 'phone', tz: 'America/New_York', displayName: 'Sam', bio: '', accent: '#4c8de2', goals: { stepTarget: 6000 }, what: 'phone only: steps and distance' },
  { username: 'noor', persona: 'garmin', tz: 'Asia/Dubai', displayName: 'Noor', bio: 'Garmin, mostly cycling.', accent: '#e2a94c', what: 'Garmin: no HRV, no SpO2, sleep without stages' },
  { username: 'kai', persona: 'fitbit2', tz: 'Asia/Tokyo', displayName: 'Kai', bio: 'Keeps to himself.', accent: '#8a6fe8', privacy: { account: 'private' }, what: 'Fitbit; PRIVATE account (not on leaderboards, profile 404s for others)' },
  { username: 'lena', persona: 'apple', tz: 'Europe/Berlin', displayName: 'Lena', bio: 'Apple Watch via Apple Health.', accent: '#3fb8af', privacy: { sleep: true, heart: true }, what: 'Apple Watch; sleep and heart public' },
  { username: 'ojee', persona: 'fitbit3', tz: 'Africa/Cairo', displayName: 'ojee', bio: '', accent: null, exerciseType: 'WEIGHT_MACHINES', what: 'the admin; Fitbit Air' },
];
export const SEED_PASSWORD = 'demo';

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

/**
 * The stand-ins. `googleFetch(userId)` is handed to createApp.
 */
export function demoParts({ now = () => Date.now(), origin, tzOf = () => 'Africa/Cairo' }) {
  const mongo = new FakeMongo();
  const personaOf = new Map();   // userId -> persona key
  const emailOf = new Map();
  const codes = new Map();       // code -> { challenge }
  const synths = new Map();
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const issue = (challenge) => { const code = randomBytes(8).toString('hex'); codes.set(code, { challenge, at: now() }); return code; };

  const googleFetch = (userId) => async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(DEMO_ENDPOINTS.token)) {
      const f = Object.fromEntries(new URLSearchParams(String(init.body || '')));
      if (f.grant_type === 'authorization_code') {
        const c = codes.get(f.code); codes.delete(f.code);
        // Checked the way Google checks it: the verifier must hash to the challenge.
        if (!c || createHash('sha256').update(f.code_verifier || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'code or verifier mismatch' });
        const idt = `x.${Buffer.from(JSON.stringify({ email: emailOf.get(userId) || 'demo@example.com' })).toString('base64url')}.y`;
        return json(200, { access_token: `demo-at-${now()}`, refresh_token: `demo-rt-${userId}`, expires_in: 3599, token_type: 'Bearer', scope: ['openid', 'email', ...Object.values(SCOPES)].join(' '), id_token: idt });
      }
      if (f.grant_type === 'refresh_token') return json(200, { access_token: `demo-at-${now()}`, expires_in: 3599, token_type: 'Bearer' });
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.startsWith(DEMO_ENDPOINTS.revoke)) return json(200, {});
    if (!synths.has(userId)) synths.set(userId, synthFetch({ now, tz: tzOf(userId), persona: PERSONAS[personaOf.get(userId) || 'fitbit'], backfill: 120 }));
    return synths.get(userId)(input, init);
  };

  /** The consent "screen": everything granted, straight back to the callback. */
  const demoConnect = (url) => {
    const back = new URL(url.searchParams.get('redirect_uri') || `${origin}/auth/google/callback`);
    back.searchParams.set('code', issue(url.searchParams.get('code_challenge')));
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
        if (s.notes) w.db.setMeta('notes', s.notes);
        if (s.exerciseType) w.db.setMeta('exerciseType', s.exerciseType);
        const pk = pkce();
        await w.google.exchange({ code: issue(pk.challenge), verifier: pk.verifier });
        app.app.patchProfile(user.id, { googleState: 'ok' });
      });
      const r = await app.syncUser(user.id);
      app.scheduler.settle(app.app.profile(user.id), r);
      await app.worlds.hold(user.id, async (w) => {
        if (s.hevy) importHevy({ db: w.db, text: demoHevyCsv(s.tz, now()), tz: s.tz, now: now() });
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
  }

  return { mongo, googleFetch, demoConnect, seed, personaOf, emailOf, issue, endpoints: { ...DEMO_ENDPOINTS, auth: `${origin}${DEMO_ENDPOINTS.auth}` } };
}

/** Start from nothing every time: the accounts are in memory, so data left
    from the last run would belong to nobody. */
export function wipeDemoData(dir) {
  if (!/[\\/]demo[\\/]?$/.test(dir) && !dir.includes('health-demo')) throw new Error(`refusing to wipe ${dir}: not a demo directory`);
  rmSync(dir, { recursive: true, force: true });
}

export { localToMs };
