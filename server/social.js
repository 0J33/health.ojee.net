/* ============================================================
   health.ojee.net — the social side: public rows, leaderboards,
   profiles, compare, records and streaks.

   The rule that makes this safe: nobody's private database is ever
   opened for somebody else. After a person's own sync, recompute()
   copies the numbers they have chosen to share into the global
   tables (`daily_public`, `public_workout`, `records`), and every
   leaderboard and profile is read from those tables alone. The feed's
   posts (feed.js) are written in the same pass, under the same rule.

   Boards are your friends' by default (scope 'friends': you and the
   people you are friends with, friends.js), or everyone's. A friend
   sees no more than anybody else would: the scope only narrows.

   Privacy is enforced twice, on purpose:
     - at write time: a private category is written as NULL, and a
       private account has no rows at all;
     - at read time: every query here checks the person's flags again,
       so a flag switched a second ago hides data even if a stale row
       were still lying around.

   Time is each person's own: "today" is their civil day and a week
   starts on their Monday, in their zone, so somebody in Tokyo and
   somebody in Cairo are both ranked on a full day of their own.
   ============================================================ */

import { addDays, today as todayIn, weekOf, monthOf, daysBetween, stats, round } from './core/util.js';
import { unified, typeLabel, sportOf, sessionType, sessionDistance, isGym } from './history.js';
import { dayValues, standings, groupOf, placeOf, compareSeries, scoreOf, profileExtras } from './social-extra.js';
import { friendIds, relation, relations, avatarUrl } from './friends.js';
import { writePosts } from './feed.js';

const MIN = 60_000;
const HISTORY_DAYS = 400;

export const METRICS = {
  steps: { label: 'Steps', unit: 'steps', cat: 'activity', col: 'steps' },
  active_minutes: { label: 'Active minutes', unit: 'min', cat: 'activity', col: 'active_min' },
  workouts: { label: 'Workouts', unit: 'workouts', cat: 'workouts', col: 'workouts' },
  workout_time: { label: 'Workout time', unit: 'min', cat: 'workouts', col: 'workout_min' },
  // Strength sessions only (history.js GYM): the workouts board counts walks and runs too.
  gym: { label: 'Gym sessions', unit: 'workouts', cat: 'workouts', col: 'gym_n' },
  gym_time: { label: 'Gym time', unit: 'min', cat: 'workouts', col: 'gym_min' },
  distance: { label: 'Distance', unit: 'm', cat: 'activity', col: 'distance_m' },
  // Metres of the sessions of each sport (history.js SPORTS) that have a distance.
  run_distance: { label: 'Running', unit: 'm', cat: 'workouts', col: 'run_m' },
  ride_distance: { label: 'Cycling', unit: 'm', cat: 'workouts', col: 'ride_m' },
  walk_distance: { label: 'Walks and hikes', unit: 'm', cat: 'workouts', col: 'walk_m' },
  sleep_consistency: { label: 'Sleep consistency', unit: 'score', cat: 'sleep', col: null },
};
export const SCOPES = ['friends', 'everyone'];
/** The daily_public column of each sport's metres. */
const SPORT_COL = { run: 'run_m', ride: 'ride_m', walk: 'walk_m' };
export const PERIODS = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' };
const CAT_WORD = { activity: 'activity is', workouts: 'workouts are', sleep: 'sleep is', heart: 'heart data is', body: 'body data is' };

export const RECORDS = {
  best_day_steps: { label: 'Most steps in a day', unit: 'steps', cat: 'activity' },
  best_week_steps: { label: 'Most steps in a week', unit: 'steps', cat: 'activity' },
  longest_workout: { label: 'Longest workout', unit: 'min', cat: 'workouts' },
  most_workouts_week: { label: 'Most workouts in a week', unit: 'workouts', cat: 'workouts' },
};
const STREAKS = { streak_steps_current: 'activity', streak_steps_best: 'activity', streak_weeks_current: 'workouts', streak_weeks_best: 'workouts' };

const isPublic = (p) => p && p.privacy.account === 'public';
const shares = (p, cat) => isPublic(p) && p.privacy[cat] === true;

/* ── writing the public rows ──────────────────────────────────────── */

/** Longest run of consecutive truthy entries, and the run ending at the end. */
function runs(flags) {
  let best = 0; let cur = 0;
  for (const f of flags) { cur = f ? cur + 1 : 0; if (cur > best) best = cur; }
  return { best, current: cur };
}

/**
 * Rewrite one person's public rows from their own store. Called after
 * every sync and whenever their privacy, goals or workouts change.
 * @returns {{ records: Array<{kind, value, date, label, unit}>, passed: Array<{userId, username}> }}
 *   records newly beaten, and the people this person just passed on the
 *   week's steps (for notifications).
 */
export function recompute(app, { profile, db, settings, now = Date.now() }) {
  const uid = profile.userId;
  const p = profile.privacy;
  const result = { records: [], passed: [] };
  if (p.account !== 'public') {
    // A private account has no public rows. None. No posts either.
    app.tx(() => { for (const t of ['daily_public', 'public_workout', 'records']) app.run(`DELETE FROM ${t} WHERE user_id = ?`, uid); app.deletePostsOf(uid); });
    return result;
  }
  const tz = profile.tz;
  const ws = profile.weekStart ?? 1;
  const today = todayIn(now, tz);
  const from = addDays(today, -(HISTORY_DAYS - 1));
  const table = db.dailyTable('0000-00-00');
  const dates = Object.keys(table).sort();

  // Sleep: the main night per date, bedtime measured from noon so 23:30 and
  // 00:30 are an hour apart.
  const nights = {};
  for (const n of db.sleeps(from)) {
    if (!n.main) continue;
    const local = (t, off) => { const d = new Date(t + off * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
    if (!nights[n.date] || n.asleepMin > nights[n.date].asleepMin) nights[n.date] = { asleepMin: n.asleepMin, bed: (local(n.startMs, n.startOff) - 720 + 1440) % 1440, wake: local(n.endMs, n.endOff) };
  }
  const weights = {};
  for (const w of db.weights(Date.parse(`${from}T00:00:00Z`) - 86_400_000)) weights[new Date(w.t + (w.off || 0) * 1000).toISOString().slice(0, 10)] = w.grams / 1000;

  const sessions = unified(db, 0);
  const wByDate = {};
  for (const s of sessions) {
    const d = todayIn(s.start, tz);
    const x = (wByDate[d] ||= { n: 0, min: 0, run_m: 0, ride_m: 0, walk_m: 0, gym_n: 0, gym_min: 0 });
    x.n += 1; x.min += (s.end - s.start) / MIN;
    if (isGym(s)) { x.gym_n += 1; x.gym_min += (s.end - s.start) / MIN; }
    // A run, ride or walk counts on its board only with a distance.
    const sport = sportOf(sessionType(s)); const m = sessionDistance(s);
    if (sport && m) x[SPORT_COL[sport]] += m;
  }

  /* records and streaks: over everything the person has */
  const rec = {};
  const set = (kind, value, date) => { if (Number.isFinite(value) && value > 0) rec[kind] = { value, date }; };
  let bestDay = null;
  const weekSteps = {};
  for (const d of dates) {
    const v = table[d].steps;
    if (!Number.isFinite(v)) continue;
    if (!bestDay || v > bestDay.value) bestDay = { value: v, date: d };
    weekSteps[weekOf(d, ws)] = (weekSteps[weekOf(d, ws)] || 0) + v;
  }
  if (bestDay) set('best_day_steps', bestDay.value, bestDay.date);
  const bw = Object.entries(weekSteps).sort((a, b) => b[1] - a[1])[0];
  if (bw) set('best_week_steps', bw[1], bw[0]);
  let longest = null;
  const weekCount = {};
  for (const s of sessions) {
    const min = Math.round((s.end - s.start) / MIN);
    const d = todayIn(s.start, tz);
    if (!longest || min > longest.value) longest = { value: min, date: d };
    weekCount[weekOf(d, ws)] = (weekCount[weekOf(d, ws)] || 0) + 1;
  }
  if (longest) set('longest_workout', longest.value, longest.date);
  const mw = Object.entries(weekCount).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (mw) set('most_workouts_week', mw[1], mw[0]);

  const goal = settings.stepTarget || 8000;
  if (dates.length) {
    // Step-goal streak: today counts once it is met; until then the streak
    // is the one that ended yesterday (today is not over).
    const flags = [];
    const last = (table[today]?.steps ?? 0) >= goal ? today : addDays(today, -1);
    for (let d = dates[0]; d <= last; d = addDays(d, 1)) flags.push((table[d]?.steps ?? 0) >= goal);
    const r = runs(flags);
    rec.streak_steps_current = { value: r.current, date: last };
    rec.streak_steps_best = { value: r.best, date: null };
  }
  const weeks = Object.keys(weekCount).sort();
  if (weeks.length) {
    const thisWeek = weekOf(today, ws);
    const lastWeek = weekCount[thisWeek] ? thisWeek : addDays(thisWeek, -7);
    const flags = [];
    for (let w = weeks[0]; w <= lastWeek; w = addDays(w, 7)) flags.push(!!weekCount[w]);
    const r = runs(flags);
    rec.streak_weeks_current = { value: r.current, date: lastWeek };
    rec.streak_weeks_best = { value: r.best, date: null };
  }

  const act = p.activity === true; const wk = p.workouts === true; const sl = p.sleep === true; const hr = p.heart === true; const body = p.body === true;
  const catOn = { activity: act, workouts: wk, sleep: sl, heart: hr, body };
  const v = (on, x) => (on && Number.isFinite(x) ? x : null);

  // Who this person is ahead of and behind on the week's steps, before the
  // rewrite: afterwards, anyone they overtook is told.
  const weekFrom = weekOf(today, ws);
  const before = app.get('SELECT SUM(steps) AS s FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?', uid, weekFrom, today)?.s ?? null;
  const old = Object.fromEntries(app.all('SELECT kind, value, date FROM records WHERE user_id = ?', uid).map((r) => [r.kind, r]));

  app.tx(() => {
    app.run('DELETE FROM daily_public WHERE user_id = ?', uid);
    const ins = app.p(`INSERT INTO daily_public (user_id, date, steps, active_min, kcal, distance_m, sleep_min, bed_min, wake_min, rhr, hrv, weight_kg, body_fat, workouts, workout_min, run_m, ride_m, walk_m, gym_n, gym_min)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const metres = (w, col) => (wk && w && w[col] > 0 ? Math.round(w[col]) : null);
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const r = table[d] || {};
      const n = nights[d];
      const w = wByDate[d];
      const row = [
        v(act, r.steps), v(act, r.azm ?? r.active_min), v(act, r.kcal), v(act, r.distance_m),
        v(sl, n?.asleepMin ?? r.sleep_min), v(sl, n?.bed), v(sl, n?.wake),
        v(hr, r.rhr), v(hr, r.hrv), v(body, weights[d]), v(body, r.body_fat),
        wk && w ? w.n : null, wk && w ? Math.round(w.min) : null,
        metres(w, 'run_m'), metres(w, 'ride_m'), metres(w, 'walk_m'),
        wk && w && w.gym_n ? w.gym_n : null, wk && w && w.gym_n ? Math.round(w.gym_min) : null,
      ];
      if (row.some((x) => x !== null)) ins.run(uid, d, ...row);
    }
    app.run('DELETE FROM public_workout WHERE user_id = ?', uid);
    if (wk) {
      const insW = app.p('INSERT OR REPLACE INTO public_workout (user_id, uid, start_ms, date, minutes, title, type) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const s of sessions.slice(-30)) {
        const type = s.local ? (s.local.type || null) : (s.ex.type || null);
        const title = s.local ? (s.local.title || typeLabel(type)) : (s.ex.name || typeLabel(type));
        insW.run(uid, s.local ? s.local.uid : `g-${s.ex.id.split('/').pop()}`, s.start, todayIn(s.start, tz), Math.round((s.end - s.start) / MIN), String(title).slice(0, 80), type);
      }
    }
    app.run('DELETE FROM records WHERE user_id = ?', uid);
    const insR = app.p('INSERT INTO records (user_id, kind, value, date) VALUES (?, ?, ?, ?)');
    for (const [kind, r] of Object.entries(rec)) {
      const cat = RECORDS[kind]?.cat || STREAKS[kind];
      if (catOn[cat]) insR.run(uid, kind, r.value, r.date);
    }
  });
  // The feed's posts, from the same sessions (feed.js checks the switches).
  writePosts(app, { profile, db, sessions, now });

  // New personal records: only where there was one to beat (the first
  // backfill sets records, it does not break them), set on a new day.
  for (const [kind, meta] of Object.entries(RECORDS)) {
    const a = old[kind]; const b = rec[kind];
    if (a && b && catOn[meta.cat] && b.value > a.value && b.date !== a.date) result.records.push({ kind, value: b.value, date: b.date, label: meta.label, unit: meta.unit });
  }
  // Overtakes: this person's week total rose past somebody else's.
  if (act && before !== null) {
    const after = app.get('SELECT SUM(steps) AS s FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?', uid, weekFrom, today)?.s ?? null;
    if (after !== null && after > before) {
      for (const other of app.profiles()) {
        if (other.userId === uid || !shares(other, 'activity')) continue;
        const ot = todayIn(now, other.tz);
        const x = app.get('SELECT SUM(steps) AS s FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?', other.userId, weekOf(ot, other.weekStart ?? 1), ot)?.s;
        if (Number.isFinite(x) && x > 0 && before <= x && after > x) result.passed.push({ userId: other.userId, username: other.username });
      }
    }
  }
  return result;
}

/* ── reading: periods in each person's own zone ───────────────────── */

/** [from, to] civil dates of a period for one person, and the same span
    of the period before it. */
export function periodRange(period, tz, now = Date.now(), ws = 1) {
  const today = todayIn(now, tz);
  if (period === 'today') return { from: today, to: today, prev: { from: addDays(today, -1), to: addDays(today, -1) } };
  if (period === 'week') {
    const from = weekOf(today, ws);
    return { from, to: today, prev: { from: addDays(from, -7), to: addDays(today, -7) } };
  }
  if (period === 'month') {
    const from = monthOf(today);
    const prevFrom = monthOf(addDays(from, -1));
    const span = daysBetween(from, today);
    const prevLast = addDays(from, -1);
    const prevTo = addDays(prevFrom, span) > prevLast ? prevLast : addDays(prevFrom, span);
    return { from, to: today, prev: { from: prevFrom, to: prevTo } };
  }
  return { from: '0000-00-00', to: today, prev: null };
}

function consistencyOf(rows) {
  const r = rows.filter((x) => Number.isFinite(x.bed_min) && Number.isFinite(x.wake_min));
  if (r.length < 3) return null;
  const b = stats(r.map((x) => x.bed_min)); const w = stats(r.map((x) => x.wake_min));
  // 100 = the same bedtime and wake time every night; 0 = spread by an hour
  // and a half or more.
  const score = Math.round(100 - Math.min(100, (((b.sd + w.sd) / 2) / 90) * 100));
  return { value: score, detail: { nights: r.length, bedtimeSdMin: Math.round(b.sd), wakeSdMin: Math.round(w.sd) } };
}

/** One person's value for a metric over a range, from the public table. */
function valueOf(app, userId, metric, range, period) {
  const m = METRICS[metric];
  if (!range) return null;
  if (metric === 'sleep_consistency') {
    // A single day has no consistency: "today" is judged on the last 7 nights.
    const from = period === 'today' ? addDays(range.to, -6) : range.from;
    return consistencyOf(app.all('SELECT bed_min, wake_min FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?', userId, from, range.to));
  }
  const r = app.get(`SELECT SUM(${m.col}) AS s, COUNT(${m.col}) AS n FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?`, userId, range.from, range.to);
  return r && r.n > 0 ? { value: Math.round(r.s), detail: null } : null;
}

const trendOf = (value, previous) => (Number.isFinite(previous) && previous > 0 ? Math.round(((value - previous) / previous) * 100) : null);

/** The people a board is drawn from: everybody, or you and your friends.
    Privacy is not decided here: every caller still checks `shares`. */
function inScope(app, viewerId, scope) {
  const all = app.profiles();
  if (scope !== 'friends') return all;
  const f = friendIds(app, viewerId);
  return all.filter((p) => p.userId === String(viewerId) || f.has(p.userId));
}

export function leaderboard(app, { metric, period, viewerId, scope = 'everyone', now = Date.now() }) {
  const m = METRICS[metric];
  const entries = [];
  for (const p of inScope(app, viewerId, scope)) {
    if (!shares(p, m.cat)) continue;   // read-time privacy
    const range = periodRange(period, p.tz, now, p.weekStart ?? 1);
    const cur = valueOf(app, p.userId, metric, range, period);
    if (!cur || !(cur.value > 0)) continue;
    const prev = range.prev ? valueOf(app, p.userId, metric, range.prev, period) : null;
    entries.push({
      rank: 0, username: p.username, displayName: p.displayName, accent: p.accent, avatar: avatarUrl(p),
      value: cur.value, previous: prev ? prev.value : null, trend: prev ? trendOf(cur.value, prev.value) : null,
      me: p.userId === viewerId, detail: cur.detail,
      // Their last 7 civil days, from the public table: this person shares
      // the category, or the loop would not have come this far.
      spark: m.col ? dayValues(app, p.userId, m.col, addDays(range.to, -6), range.to) : null,
    });
  }
  entries.sort((a, b) => b.value - a.value || a.username.localeCompare(b.username));
  entries.forEach((e, i) => { e.rank = i > 0 && entries[i - 1].value === e.value ? entries[i - 1].rank : i + 1; });
  standings(entries);
  const group = groupOf(entries);
  const mine = entries.find((e) => e.me);
  const vp = app.profile(viewerId);
  let me = null;
  if (vp) {
    me = mine ? { rank: mine.rank, value: mine.value, previous: mine.previous, trend: mine.trend, listed: true, reason: null }
      : { rank: null, value: null, previous: null, trend: null, listed: false,
        reason: !isPublic(vp) ? 'Your account is private' : !vp.privacy[m.cat] ? `Your ${CAT_WORD[m.cat]} private` : 'Nothing yet for this period' };
    // Only ever people on the board: nobody private can be "ahead" or "behind".
    Object.assign(me, placeOf(entries, mine || null, group));
  }
  return { metric, period, scope, unit: m.unit, higherIsBetter: true, label: m.label, periodLabel: PERIODS[period], total: entries.length, group, entries, me };
}

/**
 * Every board at once, for the board picker: who leads each and where you
 * are. Only this period's values are read (no previous period, no
 * sparklines), one sum per person per board.
 */
export function boards(app, { period, viewerId, scope = 'friends', now = Date.now() }) {
  const who = inScope(app, viewerId, scope);
  const out = [];
  for (const [metric, m] of Object.entries(METRICS)) {
    const entries = [];
    for (const p of who) {
      if (!shares(p, m.cat)) continue;   // read-time privacy
      const cur = valueOf(app, p.userId, metric, periodRange(period, p.tz, now, p.weekStart ?? 1), period);
      if (cur && cur.value > 0) entries.push({ p, value: cur.value, me: p.userId === String(viewerId) });
    }
    entries.sort((a, b) => b.value - a.value || a.p.username.localeCompare(b.p.username));
    entries.forEach((e, i) => { e.rank = i > 0 && entries[i - 1].value === e.value ? entries[i - 1].rank : i + 1; });
    const mine = entries.find((e) => e.me);
    const top = entries[0];
    out.push({
      metric, label: m.label, unit: m.unit, cat: m.cat, total: entries.length,
      me: { rank: mine ? mine.rank : null, value: mine ? mine.value : null, listed: !!mine },
      leader: top ? { username: top.p.username, displayName: top.p.displayName, accent: top.p.accent, avatar: avatarUrl(top.p), value: top.value, me: top.me } : null,
    });
  }
  return { period, scope, boards: out };
}

export function people(app, viewerId) {
  const rel = relations(app, viewerId);
  return app.profiles().filter(isPublic).map((p) => ({
    username: p.username, displayName: p.displayName, accent: p.accent, avatar: avatarUrl(p), joinedAt: p.joinedAt, me: p.userId === viewerId,
    friend: p.userId === viewerId ? null : rel.get(p.userId)?.status ?? null,
  }));
}

/** Sum the public columns of a range for one person, honouring their flags. */
function weekTotals(app, p, from, to) {
  const r = app.get(`SELECT SUM(steps) AS steps, SUM(active_min) AS am, SUM(distance_m) AS dist, SUM(kcal) AS kcal, SUM(workouts) AS w, SUM(workout_min) AS wm,
    COUNT(steps) AS ns FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?`, p.userId, from, to) || {};
  const act = p.privacy.activity === true; const wk = p.privacy.workouts === true;
  const n = (on, x) => (on && x !== null && x !== undefined ? Math.round(x) : null);
  return {
    steps: n(act, r.steps), activeMinutes: n(act, r.am), distanceM: n(act, r.dist), kcal: n(act, r.kcal),
    workouts: wk ? Math.round(r.w || 0) : null, workoutMin: wk ? Math.round(r.wm || 0) : null,
  };
}

/**
 * A public profile. Null when there is no such person or their account is
 * private and the viewer is not them: the caller answers 404 for both, so
 * a private account cannot be told apart from a missing one.
 */
export function publicProfile(app, { username, viewerId = null, now = Date.now() }) {
  const p = app.profileByName(username);
  if (!p) return null;
  const me = !!viewerId && p.userId === viewerId;
  if (!isPublic(p) && !me) return null;
  const pv = p.privacy;
  const on = (cat) => pv[cat] === true;
  const today = todayIn(now, p.tz);
  const week = weekOf(today, p.weekStart ?? 1);
  const recs = Object.fromEntries(app.all('SELECT kind, value, date FROM records WHERE user_id = ?', p.userId).map((r) => [r.kind, r]));
  const rv = (kind) => (recs[kind] && on(RECORDS[kind]?.cat || STREAKS[kind]) ? recs[kind].value : null);

  const from = addDays(today, -364);
  const rows = Object.fromEntries(app.all('SELECT date, steps, workouts FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?', p.userId, from, today).map((r) => [r.date, r]));
  const heatmap = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const r = rows[d];
    const steps = on('activity') && r && r.steps !== null ? Math.round(r.steps) : null;
    const w = on('workouts') && r && r.workouts ? r.workouts : 0;
    let level = 0;
    if (steps !== null) { const f = steps / (p.stepGoal || 8000); level = f >= 1 ? 3 : f >= 0.6 ? 2 : f >= 0.25 ? 1 : 0; }
    if (w) level = Math.min(4, Math.max(2, level + 1));
    heatmap.push({ date: d, level, steps, workouts: w });
  }

  const extra = profileExtras(app, p.userId, { today, act: on('activity'), wk: on('workouts'), weekStart: p.weekStart ?? 1 });

  const last7 = app.all('SELECT sleep_min, bed_min, wake_min, rhr, hrv, weight_kg, body_fat FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', p.userId, addDays(today, -13), today);
  const lastOf = (k) => { for (let i = last7.length - 1; i >= 0; i -= 1) if (last7[i][k] !== null) return last7[i][k]; return null; };
  const sleepVals = last7.slice(-7).map((r) => r.sleep_min).filter(Number.isFinite);

  return {
    username: p.username, displayName: p.displayName, bio: p.bio, accent: p.accent, avatar: avatarUrl(p), joinedAt: p.joinedAt,
    me, private: !isPublic(p),
    // Where the viewer stands with them: 'friends' | 'incoming' | 'outgoing' | null.
    friend: viewerId && !me ? relation(app, viewerId, p.userId) : null,
    sections: { activity: on('activity'), workouts: on('workouts'), sleep: on('sleep'), heart: on('heart'), body: on('body') },
    device: on('activity') ? (p.device || null) : null,
    streaks: {
      stepGoal: on('activity') ? { current: rv('streak_steps_current') ?? 0, best: rv('streak_steps_best') ?? 0 } : null,
      workoutWeeks: on('workouts') ? { current: rv('streak_weeks_current') ?? 0, best: rv('streak_weeks_best') ?? 0 } : null,
    },
    week: { thisWeek: weekTotals(app, p, week, today), lastWeek: weekTotals(app, p, addDays(week, -7), addDays(week, -1)) },
    records: Object.entries(RECORDS).filter(([k, m]) => recs[k] && on(m.cat)).map(([k, m]) => ({ kind: k, label: m.label, value: Math.round(recs[k].value), unit: m.unit, date: recs[k].date, daysAgo: recs[k].date ? daysBetween(recs[k].date, today) : null })),
    recentWorkouts: on('workouts') ? app.all('SELECT * FROM public_workout WHERE user_id = ? ORDER BY start_ms DESC LIMIT 10', p.userId)
      .map((w) => ({ date: w.date, start: w.start_ms, durationMin: Math.round(w.minutes), title: w.title, type: w.type })) : [],
    heatmap,
    year: extra.year, weeks: extra.weeks, weekday: extra.weekday,
    sleep: on('sleep') ? { avgMin7: sleepVals.length ? Math.round(stats(sleepVals).mean) : null, consistency: consistencyOf(last7)?.value ?? null } : null,
    heart: on('heart') ? { restingHr: lastOf('rhr') !== null ? Math.round(lastOf('rhr')) : null, hrv: lastOf('hrv') !== null ? Math.round(lastOf('hrv')) : null } : null,
    body: on('body') ? { weightKg: lastOf('weight_kg') !== null ? round(lastOf('weight_kg'), 1) : null, bodyFatPct: lastOf('body_fat') !== null ? round(lastOf('body_fat'), 1) : null } : null,
  };
}

/** You against one other person. Null when they are unknown or private. */
export function compare(app, { viewerId, username, period, now = Date.now() }) {
  const a = app.profile(viewerId);
  const b = app.profileByName(username);
  if (!a || !b || !isPublic(b)) return null;
  const side = (p, metric) => {
    // Only what is public is ever read, your own side included: the table
    // simply has nothing else in it.
    if (!shares(p, METRICS[metric].cat)) return null;
    return valueOf(app, p.userId, metric, periodRange(period, p.tz, now, p.weekStart ?? 1), period)?.value ?? null;
  };
  const who = (p) => ({ username: p.username, displayName: p.displayName, accent: p.accent, avatar: avatarUrl(p) });
  const metrics = Object.entries(METRICS).map(([metric, m]) => ({ metric, label: m.label, unit: m.unit, higherIsBetter: true, a: side(a, metric), b: side(b, metric) }));
  // Day by day, under the same rule as the totals: a side is drawn only
  // where that person shares the category, yours included.
  const days = (p) => ({ userId: p.userId, today: todayIn(now, p.tz), weekStart: p.weekStart ?? 1, on: (metric) => shares(p, METRICS[metric].cat) });
  return {
    period, periodLabel: PERIODS[period], a: who(a), b: who(b),
    metrics,
    score: scoreOf(metrics),
    series: compareSeries(app, period, days(a), days(b)),
  };
}
