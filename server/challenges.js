/* ============================================================
   health.ojee.net — circle goals and events (docs/CHALLENGES.md).

   Goals: every circle has one for the shared week (Friday 12:00 UTC to
   the next) and a bigger one for the calendar month. Each is one
   measure (steps, distance, active minutes, gym time or weight lifted,
   in turn), with a target set when it starts from what the members
   usually do, pushed further (STRETCH). Everybody's numbers add up.
   At 50, 75, 100 and 150 per cent the circle earns a bronze, silver,
   gold or platinum trophy; when it closes, the three who gave most are
   its top contributors. Who counts: members whose audience for that
   kind takes in the circle (audience.circleWide), as on its boards.

   Events: a member starts one (a marathon, a hybrid race, triathlon
   distances up to the full iron distance, a century ride), for 7, 14
   or 28 days. A race: each person on their own, first to finish every
   leg wins. Together: the legs once for each person in it, pooled.
   Progress is read from the public daily table (run_m, ride_m, swim_m,
   gym_min), so only workouts the circle may see count.

   Both close the way a week of winners does: the day after their last
   date at 12:00 UTC, two hours on for late syncs. What they ended as is
   kept (circle_goal.total and tier, circle_goal_part; circle_event_member)
   and never worked out again.
   ============================================================ */

import { randomBytes } from 'node:crypto';
import { METRICS, sharedWeek } from './social.js';
import { faceOf } from './friends.js';
import { circleWide } from './audience.js';
import { circleOf, memberIds } from './circles.js';
import { addDays, daysBetween, monthOf, today as todayIn } from './core/util.js';

const DAY = 86_400_000;
const SETTLE_MS = 2 * 3_600_000;
const newId = () => randomBytes(8).toString('base64url');
const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });

/* ── goals ───────────────────────────────────────────────────── */

export const GOAL_TIERS = [
  { tier: 'bronze', pct: 50 }, { tier: 'silver', pct: 75 }, { tier: 'gold', pct: 100 }, { tier: 'platinum', pct: 150 },
];
const TIER_WORD = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
/** The measure of each goal, in turn. */
const ROTATION = { week: ['steps', 'distance', 'active_minutes', 'gym_time', 'lifted'], month: ['distance', 'steps', 'active_minutes'] };
/** The least a goal asks, a member a day: a new circle, or quiet weeks, still get one worth reaching. */
const FLOOR = { steps: 6000, distance: 4500, active_minutes: 20, gym_time: 8, lifted: 800 };
/** How far past what the members usually do. */
const STRETCH = { week: 1.25, month: 1.35 };
const EPOCH = '2026-01-02';   // a Friday: weeks are counted from it for the rotation

/** When a run of dates is over and settled: the next day at 12:00 UTC, two hours on. */
export const closesAt = (end) => Date.parse(`${addDays(end, 1)}T12:00:00Z`) + SETTLE_MS;
/** When it stops counting, as people are told: the next day at 12:00 UTC. */
const endsAt = (end) => Date.parse(`${addDays(end, 1)}T12:00:00Z`);

/** The dates of this week's or this month's goal. */
export function periodOf(kind, now = Date.now()) {
  if (kind === 'week') { const w = sharedWeek(now); return { start: w.from, end: w.to }; }
  const d = new Date(now - 12 * 3_600_000).toISOString().slice(0, 10);
  const start = monthOf(d);
  return { start, end: addDays(monthOf(addDays(start, 32)), -1) };
}

const sumOf = (app, uid, col, from, to) => app.get(`SELECT SUM(${col}) AS s FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ?`, uid, from, to)?.s || 0;
/** Two significant figures, up: 412,345 steps becomes 420,000. */
const nice = (x) => { if (!(x > 0)) return 0; const p = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1); return Math.ceil(x / p) * p; };
const profilesOf = (app, cid) => memberIds(app, cid).map((uid) => app.profile(uid)).filter(Boolean);

/** Which measure a goal starting on `start` takes: the next in turn, skipping weight lifted where nobody logs sets. */
function metricFor(app, kind, start, members) {
  const list = ROTATION[kind];
  const i = kind === 'week' ? Math.floor(daysBetween(EPOCH, start) / 7) : Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7));
  for (let k = 0; k < list.length; k += 1) {
    const metric = list[((i + k) % list.length + list.length) % list.length];
    if (metric !== 'lifted') return metric;
    const lifts = members.some((p) => sumOf(app, p.userId, 'lift_kg', addDays(start, -28), addDays(start, -1)) > 0);
    if (lifts) return metric;
  }
  return 'steps';
}

/** The target: what the members counted did a day over the four weeks before, for the goal's days, stretched. */
export function targetFor(app, metric, kind, start, end, counted) {
  const col = METRICS[metric].col;
  const days = daysBetween(start, end) + 1;
  const usual = counted.reduce((t, p) => t + sumOf(app, p.userId, col, addDays(start, -28), addDays(start, -1)) / 28, 0) * days;
  const floor = FLOOR[metric] * Math.max(1, counted.length) * days;
  return nice(Math.max(usual, floor) * STRETCH[kind]);
}

/** Make this week's and this month's goal for a circle, if not made yet. */
export function ensureGoals(app, c, now = Date.now()) {
  if (!c) return;
  for (const kind of ['week', 'month']) {
    const { start, end } = periodOf(kind, now);
    if (app.get('SELECT 1 AS x FROM circle_goal WHERE circle_id = ? AND kind = ? AND start_date = ?', c.id, kind, start)) continue;
    const members = profilesOf(app, c.id);
    const metric = metricFor(app, kind, start, members);
    const counted = members.filter((p) => circleWide(p, METRICS[metric].cat));
    const target = targetFor(app, metric, kind, start, end, counted);
    app.run('INSERT OR IGNORE INTO circle_goal (id, circle_id, kind, metric, start_date, end_date, target, counted, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), c.id, kind, metric, start, end, target, counted.length, now);
  }
}

const tierAt = (total, target) => { let t = null; for (const x of GOAL_TIERS) if (total >= (target * x.pct) / 100) t = x.tier; return t; };
/** Places 1 to 3 by value, ties sharing; nobody at 0. */
function placed(list) {
  const steps = [...new Set(list.filter((x) => x.value > 0).map((x) => x.value))].sort((a, b) => b - a);
  return list.map((x) => { const i = steps.indexOf(x.value); return { ...x, place: x.value > 0 && i >= 0 && i < 3 ? i + 1 : null }; });
}

/** Each counted member's part of an open goal, from the public table now. */
function liveParts(app, g) {
  const m = METRICS[g.metric];
  return profilesOf(app, g.circle_id).filter((p) => circleWide(p, m.cat))
    .map((p) => ({ userId: p.userId, value: Math.round(sumOf(app, p.userId, m.col, g.start_date, g.end_date)) }))
    .sort((a, b) => b.value - a.value);
}

/** A goal as the circle page draws it. */
export function goalView(app, g, me, now = Date.now()) {
  const m = METRICS[g.metric];
  const closed = !!g.closed_ms;
  const parts = placed(closed
    ? app.all('SELECT user_id, value, place FROM circle_goal_part WHERE goal_id = ? ORDER BY value DESC', g.id).map((r) => ({ userId: r.user_id, value: r.value }))
    : liveParts(app, g));
  const total = closed ? g.total : parts.reduce((t, x) => t + x.value, 0);
  const days = daysBetween(g.start_date, g.end_date) + 1;
  const from = Date.parse(`${g.start_date}T00:00:00Z`);
  const elapsed = Math.min(1, Math.max(0, (now - from) / (days * DAY)));
  const people = parts.map((x) => {
    const p = app.profile(x.userId);
    return p ? { ...faceOf(p), me: x.userId === String(me), value: x.value, share: total > 0 ? x.value / total : 0, place: x.place } : null;
  }).filter(Boolean);
  const tier = closed ? g.tier : tierAt(total, g.target);
  const next = GOAL_TIERS.find((t) => total < (g.target * t.pct) / 100) || null;
  const viewer = app.profile(me);
  return {
    id: g.id, kind: g.kind, metric: g.metric, label: m.label, unit: m.unit, cat: m.cat,
    start: g.start_date, end: g.end_date, endsAt: endsAt(g.end_date), closed, settling: !closed && now >= endsAt(g.end_date),
    target: g.target, total, pct: g.target > 0 ? (total / g.target) * 100 : 0, elapsed,
    // On pace for: what it ends at if the rest goes as it has so far.
    pace: !closed && elapsed > 0.05 && elapsed < 1 ? Math.round(total / elapsed) : null,
    tier, next: next ? { tier: next.tier, pct: next.pct, at: (g.target * next.pct) / 100, left: Math.max(0, (g.target * next.pct) / 100 - total) } : null,
    tiers: GOAL_TIERS.map((t) => ({ ...t, at: (g.target * t.pct) / 100, reached: total >= (g.target * t.pct) / 100 })),
    people, counted: closed ? g.counted : people.length,
    // The viewer is not counted: their audience for this kind leaves the circle out.
    hidden: !!viewer && !circleWide(viewer, m.cat),
  };
}

/** Close every goal whose dates are over: keep the total, the trophy and each part. @returns notifications. */
export function closeGoals(app, now = Date.now()) {
  const notes = [];
  for (const g of app.all('SELECT * FROM circle_goal WHERE closed_ms IS NULL')) {
    if (now < closesAt(g.end_date)) continue;
    const c = circleOf(app, g.circle_id);
    if (!c) { app.run('DELETE FROM circle_goal WHERE id = ?', g.id); continue; }
    const parts = placed(liveParts(app, g));
    const total = parts.reduce((t, x) => t + x.value, 0);
    const tier = tierAt(total, g.target);
    app.tx(() => {
      const ins = app.p('INSERT OR REPLACE INTO circle_goal_part (goal_id, circle_id, user_id, value, place) VALUES (?, ?, ?, ?, ?)');
      for (const x of parts) if (x.value > 0) ins.run(g.id, g.circle_id, x.userId, x.value, x.place);
      app.run('UPDATE circle_goal SET total = ?, tier = ?, counted = ?, closed_ms = ? WHERE id = ?', total, tier, parts.length, now, g.id);
    });
    // Only a goal of a circle older than the goal is news (not the first, half-made one).
    if (c.createdAt > Date.parse(`${g.start_date}T00:00:00Z`) + 2 * DAY) continue;
    const label = METRICS[g.metric].label;
    const pct = g.target > 0 ? Math.floor((total / g.target) * 100) : 0;
    for (const x of parts) {
      if (!(x.value > 0)) continue;
      const top = x.place ? ` You were ${['', 'the top', 'the second', 'the third'][x.place]} contributor.` : '';
      notes.push({ userId: x.userId, note: {
        type: 'circle',
        title: tier ? `${c.name} won a ${TIER_WORD[tier].toLowerCase()} trophy` : `${c.name} reached ${pct}% of its goal`,
        body: `The ${g.kind === 'week' ? 'weekly' : 'monthly'} goal, ${label}: ${pct}%.${top}`,
        tag: `circle-goal:${g.id}`, url: `/circles/${c.id}`,
      } });
    }
  }
  return notes;
}

/* ── events ──────────────────────────────────────────────────── */

export const LEGS = {
  swim: { label: 'Swim', col: 'swim_m', unit: 'm', icon: 'swim' },
  ride: { label: 'Ride', col: 'ride_m', unit: 'm', icon: 'bike' },
  run: { label: 'Run', col: 'run_m', unit: 'm', icon: 'run' },
  gym: { label: 'Gym work', col: 'gym_min', unit: 'min', icon: 'dumbbell' },
};
export const EVENTS = {
  ten_k: { label: '10K', icon: 'run', legs: [['run', 10_000]], say: 'Run 10 km.' },
  half_marathon: { label: 'Half marathon', icon: 'run', legs: [['run', 21_097]], say: 'Run 21.1 km.' },
  marathon: { label: 'Marathon', icon: 'run', legs: [['run', 42_195]], say: 'Run 42.2 km.' },
  hybrid: { label: 'Hybrid race', icon: 'dumbbell', legs: [['run', 8_000], ['gym', 60]], say: 'Like a Hyrox: 8 km of running and an hour of gym work for the eight stations.' },
  sprint_tri: { label: 'Sprint triathlon', icon: 'swim', legs: [['swim', 750], ['ride', 20_000], ['run', 5_000]], say: 'Swim 750 m, ride 20 km, run 5 km.' },
  olympic_tri: { label: 'Olympic triathlon', icon: 'swim', legs: [['swim', 1_500], ['ride', 40_000], ['run', 10_000]], say: 'Swim 1.5 km, ride 40 km, run 10 km.' },
  half_iron: { label: 'Half iron distance', icon: 'swim', legs: [['swim', 1_900], ['ride', 90_000], ['run', 21_097]], say: 'Swim 1.9 km, ride 90 km, run 21.1 km: the 70.3 distances.' },
  iron: { label: 'Full iron distance', icon: 'swim', legs: [['swim', 3_800], ['ride', 180_000], ['run', 42_195]], say: 'Swim 3.8 km, ride 180 km, run 42.2 km: the Ironman distances.' },
  century: { label: 'Century ride', icon: 'bike', legs: [['ride', 160_934]], say: 'Ride 100 miles, 161 km.' },
};
export const EVENT_DAYS = [7, 14, 28];
export const EVENT_MODES = ['race', 'team'];
const MAX_OPEN = 3;

const eventRow = (app, cid, eid) => app.get('SELECT * FROM circle_event WHERE id = ? AND circle_id = ?', String(eid), String(cid)) || null;
function memberOf(app, cid, me) {
  const c = circleOf(app, cid);
  const m = c && app.get('SELECT status FROM circle_member WHERE circle_id = ? AND user_id = ?', c.id, String(me));
  if (!c || m?.status !== 'member') throw bad('There is no such circle.', 404, 'not_found');
  return c;
}
const canRace = (p) => circleWide(p, 'workouts');
const NOT_SHARED = 'Your workouts are kept from your circles. Share them with circles (Privacy) to take part.';

/** Each leg's running total for one person, day by day: the totals, and the day every leg was done (or null). */
function progressOf(app, uid, e, need) {
  const def = EVENTS[e.kind];
  const rows = app.all(`SELECT date, ${def.legs.map(([k]) => LEGS[k].col).join(', ')} FROM daily_public WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`, uid, e.start_date, e.end_date);
  const done = Object.fromEntries(def.legs.map(([k]) => [k, 0]));
  let finished = null;
  for (const r of rows) {
    for (const [k] of def.legs) done[k] += r[LEGS[k].col] || 0;
    if (!finished && def.legs.every(([k], i) => done[k] >= need[i])) finished = r.date;
  }
  return { done, finished };
}
const pctOf = (done, legs, need) => (legs.reduce((t, [k], i) => t + Math.min(1, (done[k] || 0) / need[i]), 0) / legs.length) * 100;

/** An event as its page draws it: who is in it, each leg, and where everybody stands. */
export function eventView(app, e, me, now = Date.now()) {
  const def = EVENTS[e.kind];
  const c = circleOf(app, e.circle_id);
  const rows = app.all('SELECT * FROM circle_event_member WHERE event_id = ? ORDER BY joined_ms', e.id);
  const closed = !!e.closed_ms;
  const viewer = app.profile(me);
  const today = todayIn(now, viewer?.tz);
  const status = closed ? 'done' : today < e.start_date ? 'soon' : now >= endsAt(e.end_date) ? 'settling' : 'live';
  const n = Math.max(1, rows.length);
  const need = def.legs.map(([, amount]) => (e.mode === 'team' ? amount * n : amount));
  const people = [];
  const team = Object.fromEntries(def.legs.map(([k]) => [k, 0]));
  for (const r of rows) {
    const p = app.profile(r.user_id);
    if (!p) continue;
    let done; let finished; let pct;
    if (closed && r.value) {
      done = JSON.parse(r.value); finished = r.finished || null; pct = r.pct ?? 0;
    } else {
      const pr = progressOf(app, r.user_id, e, def.legs.map(([, a]) => a));
      done = pr.done; finished = e.mode === 'race' ? pr.finished : null; pct = pctOf(done, def.legs, def.legs.map(([, a]) => a));
    }
    for (const [k] of def.legs) team[k] += done[k] || 0;
    people.push({ ...faceOf(p), me: r.user_id === String(me), userId: r.user_id, done, finished, pct, place: closed ? r.place : null });
  }
  let teamView = null;
  if (e.mode === 'team') {
    const tpct = pctOf(team, def.legs, need);
    for (const x of people) x.share = def.legs.reduce((t, [k], i) => t + (x.done[k] || 0) / need[i], 0) / def.legs.length;
    people.sort((a, b) => b.share - a.share);
    if (!closed) placed(people.map((x) => ({ ...x, value: x.share }))).forEach((x, i) => { people[i].place = x.place; });
    teamView = { done: team, need, pct: tpct, complete: def.legs.every(([k], i) => team[k] >= need[i]) };
  } else {
    // Finishers first, by the day they finished; then everybody else by how far they are.
    people.sort((a, b) => (a.finished && b.finished ? a.finished.localeCompare(b.finished) : a.finished ? -1 : b.finished ? 1 : b.pct - a.pct));
    if (!closed) {
      const days = [...new Set(people.filter((x) => x.finished).map((x) => x.finished))].sort();
      for (const x of people) x.place = x.finished ? days.indexOf(x.finished) + 1 : null;
    }
  }
  for (const x of people) delete x.userId;
  const by = e.by_id && app.profile(e.by_id);
  const inIt = rows.some((r) => r.user_id === String(me));
  return {
    id: e.id, circle: c ? { id: c.id, name: c.name, accent: c.accent } : null,
    kind: e.kind, label: def.label, say: def.say, icon: def.icon, mode: e.mode,
    start: e.start_date, end: e.end_date, days: daysBetween(e.start_date, e.end_date) + 1, endsAt: endsAt(e.end_date), status,
    legs: def.legs.map(([k, amount], i) => ({ leg: k, label: LEGS[k].label, unit: LEGS[k].unit, icon: LEGS[k].icon, amount, need: need[i] })),
    by: by ? faceOf(by) : null, joined: inIt,
    canJoin: !closed && status !== 'settling' && !inIt && !!viewer && canRace(viewer),
    shareFirst: !closed && !inIt && !!viewer && !canRace(viewer),
    canEnd: !closed && (e.by_id === String(me) || c?.ownerId === String(me)),
    people, team: teamView,
    finishers: e.mode === 'race' ? people.filter((x) => x.finished).length : null,
  };
}

/** GET /api/circles/:id/events: the ones on, and the last ones over. */
export function events(app, me, cid, now = Date.now()) {
  const c = memberOf(app, cid, me);
  const open = app.all('SELECT * FROM circle_event WHERE circle_id = ? AND closed_ms IS NULL ORDER BY start_date, created_ms', c.id);
  const past = app.all('SELECT * FROM circle_event WHERE circle_id = ? AND closed_ms IS NOT NULL ORDER BY end_date DESC LIMIT 12', c.id);
  return { open: open.map((e) => eventView(app, e, me, now)), past: past.map((e) => eventView(app, e, me, now)), kinds: kindsList(), max: MAX_OPEN };
}
export const kindsList = () => Object.entries(EVENTS).map(([id, d]) => ({ id, label: d.label, say: d.say, icon: d.icon, legs: d.legs.map(([k, amount]) => ({ leg: k, label: LEGS[k].label, unit: LEGS[k].unit, amount })) }));

/** GET /api/circles/:id/events/:eid. */
export function event(app, me, cid, eid, now = Date.now()) {
  memberOf(app, cid, me);
  const e = eventRow(app, cid, eid);
  if (!e) throw bad('There is no such event.', 404, 'not_found');
  return eventView(app, e, me, now);
}

/** POST /api/circles/:id/events { kind, mode, days, start: 'today' | 'tomorrow' }: start one, and take part. */
export function createEvent(app, me, cid, b = {}, now = Date.now()) {
  const c = memberOf(app, cid, me);
  if (!EVENTS[b.kind]) throw bad('Pick an event.');
  const mode = b.mode === undefined ? 'race' : b.mode;
  if (!EVENT_MODES.includes(mode)) throw bad('Pick a race or together.');
  const days = Number(b.days ?? 7);
  if (!EVENT_DAYS.includes(days)) throw bad('An event runs for 7, 14 or 28 days.');
  const p = app.profile(me);
  if (!p || !canRace(p)) throw bad(NOT_SHARED, 409, 'not_shared');
  if (app.get('SELECT COUNT(*) AS n FROM circle_event WHERE circle_id = ? AND closed_ms IS NULL', c.id).n >= MAX_OPEN) throw bad(`A circle has at most ${MAX_OPEN} events on at once. One has to finish first.`, 409, 'too_many');
  const start = addDays(todayIn(now, p.tz), b.start === 'tomorrow' ? 1 : 0);
  const id = newId();
  app.tx(() => {
    app.run('INSERT INTO circle_event (id, circle_id, kind, mode, start_date, end_date, by_id, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, c.id, b.kind, mode, start, addDays(start, days - 1), String(me), now);
    app.run('INSERT INTO circle_event_member (event_id, circle_id, user_id, joined_ms) VALUES (?, ?, ?, ?)', id, c.id, String(me), now);
  });
  const view = eventView(app, eventRow(app, c.id, id), me, now);
  const who = p.displayName || p.username;
  const notes = memberIds(app, c.id).filter((uid) => uid !== String(me)).map((userId) => ({ userId, note: {
    type: 'circle', title: `${who} started ${mode === 'race' ? 'a race' : 'an event'}: ${view.label}`,
    body: `In ${c.name}, for ${days} days${mode === 'team' ? ', all of you together' : ''}. Join in from the circle.`,
    tag: `circle-event:${id}`, url: `/circles/${c.id}/events/${id}`,
  } }));
  return { event: view, notes };
}

/** POST /api/circles/:id/events/:eid/join. */
export function joinEvent(app, me, cid, eid, now = Date.now()) {
  const c = memberOf(app, cid, me);
  const e = eventRow(app, cid, eid);
  if (!e) throw bad('There is no such event.', 404, 'not_found');
  if (e.closed_ms || now >= endsAt(e.end_date)) throw bad('This event is over.', 409, 'over');
  const p = app.profile(me);
  if (!p || !canRace(p)) throw bad(NOT_SHARED, 409, 'not_shared');
  app.run('INSERT OR IGNORE INTO circle_event_member (event_id, circle_id, user_id, joined_ms) VALUES (?, ?, ?, ?)', e.id, c.id, String(me), now);
  return eventView(app, e, me, now);
}

/** POST /api/circles/:id/events/:eid/leave. */
export function leaveEvent(app, me, cid, eid, now = Date.now()) {
  memberOf(app, cid, me);
  const e = eventRow(app, cid, eid);
  if (!e) throw bad('There is no such event.', 404, 'not_found');
  if (e.closed_ms) throw bad('This event is over.', 409, 'over');
  app.run('DELETE FROM circle_event_member WHERE event_id = ? AND user_id = ?', e.id, String(me));
  return eventView(app, e, me, now);
}

/** DELETE /api/circles/:id/events/:eid: whoever started it, or the owner, calls it off. */
export function endEvent(app, me, cid, eid) {
  const c = memberOf(app, cid, me);
  const e = eventRow(app, cid, eid);
  if (!e) throw bad('There is no such event.', 404, 'not_found');
  if (e.closed_ms) throw bad('This event is over: it stays in the circle\'s history.', 409, 'over');
  if (e.by_id !== String(me) && c.ownerId !== String(me)) throw bad('Only whoever started it, or the circle\'s owner, can call it off.', 403, 'not_yours');
  app.tx(() => { app.run('DELETE FROM circle_event_member WHERE event_id = ?', e.id); app.run('DELETE FROM circle_event WHERE id = ?', e.id); });
  return { ok: true };
}

/** Close every event whose dates are over: keep each person's result. @returns notifications. */
export function closeEvents(app, now = Date.now()) {
  const notes = [];
  for (const e of app.all('SELECT * FROM circle_event WHERE closed_ms IS NULL')) {
    if (now < closesAt(e.end_date)) continue;
    const v = eventView(app, e, null, now);
    const byName = new Map(app.all('SELECT user_id FROM circle_event_member WHERE event_id = ?', e.id).map((r) => [app.profile(r.user_id)?.username, r.user_id]));
    let done = 0;
    app.tx(() => {
      for (const x of v.people) {
        const uid = byName.get(x.username);
        if (!uid) continue;
        // Medals: a race's first three to finish; together, the three who carried most of a finished event.
        const place = v.mode === 'race' ? (x.finished ? x.place : null) : (v.team.complete ? x.place : null);
        app.run('UPDATE circle_event_member SET place = ?, finished = ?, pct = ?, value = ? WHERE event_id = ? AND user_id = ?',
          place && place <= 3 ? place : null, v.mode === 'race' ? x.finished : (v.team.complete ? e.end_date : null), Math.round(v.mode === 'team' ? x.share * 1000 : x.pct * 10) / 10, JSON.stringify(x.done), e.id, uid);
      }
      done = v.mode === 'race' ? v.finishers : (v.team.complete ? 1 : 0);
      app.run('UPDATE circle_event SET closed_ms = ?, done = ? WHERE id = ?', now, done, e.id);
    });
    if (!v.circle) continue;
    for (const x of v.people) {
      const uid = byName.get(x.username);
      if (!uid) continue;
      const title = v.mode === 'race'
        ? (x.finished ? `You finished the ${v.label}${x.place <= 3 ? `, ${['', 'first', 'second', 'third'][x.place]}` : ''}` : `The ${v.label} is over: you did ${Math.floor(x.pct)}%`)
        : (v.team.complete ? `${v.circle.name} finished the ${v.label} together` : `The ${v.label} is over: ${Math.floor(v.team.pct)}% together`);
      notes.push({ userId: uid, note: { type: 'circle', title, body: `In ${v.circle.name}.`, tag: `circle-event-end:${e.id}`, url: `/circles/${v.circle.id}/events/${e.id}` } });
    }
  }
  return notes;
}

/* ── a circle's goals, trophies and medals; a person's honours ── */

/** The trophy cabinet: goals reached by metal, events finished together, and every weekly medal given. */
export function cabinet(app, cid) {
  const trophies = { bronze: 0, silver: 0, gold: 0, platinum: 0 };
  for (const r of app.all('SELECT tier, COUNT(*) AS n FROM circle_goal WHERE circle_id = ? AND tier IS NOT NULL GROUP BY tier', cid)) trophies[r.tier] = r.n;
  const events = app.get("SELECT COUNT(*) AS n FROM circle_event WHERE circle_id = ? AND closed_ms IS NOT NULL AND mode = 'team' AND done = 1", cid).n;
  const medals = { gold: 0, silver: 0, bronze: 0 };
  for (const r of app.all('SELECT place, COUNT(*) AS n FROM circle_win WHERE circle_id = ? GROUP BY place', cid)) medals[['', 'gold', 'silver', 'bronze'][r.place]] = r.n;
  return { trophies, events, medals: { ...medals, total: medals.gold + medals.silver + medals.bronze } };
}

/** GET /api/circles/:id/goals: this week's and this month's, and the last ones over. */
export function goals(app, me, cid, { past = 12, now = Date.now() } = {}) {
  const c = memberOf(app, cid, me);
  ensureGoals(app, c, now);
  const cur = ['week', 'month'].map((kind) => app.get('SELECT * FROM circle_goal WHERE circle_id = ? AND kind = ? AND start_date = ?', c.id, kind, periodOf(kind, now).start)).filter(Boolean);
  const before = app.all('SELECT * FROM circle_goal WHERE circle_id = ? AND id NOT IN (' + (cur.map(() => '?').join(', ') || "''") + ') ORDER BY end_date DESC, kind LIMIT ?', c.id, ...cur.map((g) => g.id), Math.max(1, Math.min(52, Number(past) || 12)));
  return { current: cur.map((g) => goalView(app, g, me, now)), past: before.map((g) => goalView(app, g, me, now)), cabinet: cabinet(app, c.id), tiers: GOAL_TIERS };
}

/** What a circle page shows of all this at a glance. */
export function circleGlance(app, c, me, now = Date.now()) {
  ensureGoals(app, c, now);
  const cur = ['week', 'month'].map((kind) => app.get('SELECT * FROM circle_goal WHERE circle_id = ? AND kind = ? AND start_date = ?', c.id, kind, periodOf(kind, now).start)).filter(Boolean);
  const open = app.all('SELECT * FROM circle_event WHERE circle_id = ? AND closed_ms IS NULL ORDER BY start_date, created_ms', c.id);
  return { goals: cur.map((g) => goalView(app, g, me, now)), events: open.map((e) => eventView(app, e, me, now)), cabinet: cabinet(app, c.id), pastEvents: app.get('SELECT COUNT(*) AS n FROM circle_event WHERE circle_id = ? AND closed_ms IS NOT NULL', c.id).n };
}

/**
 * A person's honours from their circles, for their profile: trophies they
 * helped win, their places as a contributor, and events finished. A circle's
 * name is given only to a viewer in it.
 */
export function honours(app, uid, viewerId) {
  const mine = new Set(app.all("SELECT circle_id FROM circle_member WHERE user_id = ? AND status = 'member'", String(viewerId || '')).map((r) => r.circle_id));
  const trophies = { bronze: 0, silver: 0, gold: 0, platinum: 0 };
  for (const r of app.all('SELECT g.tier AS tier, COUNT(*) AS n FROM circle_goal_part p JOIN circle_goal g ON g.id = p.goal_id WHERE p.user_id = ? AND p.value > 0 AND g.tier IS NOT NULL GROUP BY g.tier', uid)) trophies[r.tier] = r.n;
  const top = { gold: 0, silver: 0, bronze: 0 };
  for (const r of app.all('SELECT place, COUNT(*) AS n FROM circle_goal_part WHERE user_id = ? AND place IN (1, 2, 3) GROUP BY place', uid)) top[['', 'gold', 'silver', 'bronze'][r.place]] = r.n;
  const eventMedals = { gold: 0, silver: 0, bronze: 0 };
  for (const r of app.all('SELECT place, COUNT(*) AS n FROM circle_event_member WHERE user_id = ? AND place IN (1, 2, 3) GROUP BY place', uid)) eventMedals[['', 'gold', 'silver', 'bronze'][r.place]] = r.n;
  const done = app.all('SELECT e.*, m.place AS place, m.finished AS finished, m.pct AS pct FROM circle_event_member m JOIN circle_event e ON e.id = m.event_id WHERE m.user_id = ? AND e.closed_ms IS NOT NULL ORDER BY e.end_date DESC LIMIT 8', uid);
  const events = done.map((e) => {
    const c = mine.has(e.circle_id) ? circleOf(app, e.circle_id) : null;
    return { id: e.id, kind: e.kind, label: EVENTS[e.kind]?.label || e.kind, icon: EVENTS[e.kind]?.icon || 'medal', mode: e.mode, end: e.end_date, finished: !!e.finished, place: e.place, pct: e.pct, circle: c ? { id: c.id, name: c.name } : null };
  });
  const finishes = app.get('SELECT COUNT(*) AS n FROM circle_event_member WHERE user_id = ? AND finished IS NOT NULL', uid).n;
  const any = Object.values(trophies).some(Boolean) || Object.values(top).some(Boolean) || events.length;
  return any ? { trophies, top, eventMedals, finishes, events } : null;
}

/** The minute tick: make goals for every circle and close what is over. */
export function tick(app, now = Date.now()) {
  for (const r of app.all('SELECT id FROM circle')) ensureGoals(app, circleOf(app, r.id), now);
  return [...closeGoals(app, now), ...closeEvents(app, now)];
}
