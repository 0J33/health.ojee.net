/* ============================================================
   health.ojee.net — circles (docs/CIRCLES.md, part 2).

   A circle is a named group with its own boards and a hall of fame.
   One row in `circle`, one per person in `circle_member`:

     status 'member'   in it (the owner is a member too)
     status 'pending'  asked to join; the owner says yes or no
     status 'invited'  the owner asked them; they say yes or no

   A "no", leaving and being removed all delete the row.

   How people get in (`join_mode`): 'request' circles are listed under
   Find a circle and anybody may ask; 'invite' circles are not listed,
   and only the people the owner invites (their friends) can join.

   Being in a circle is choosing to be seen by its members: the kinds
   whose audience is 'circles' (audience.js). Somebody outside sees a
   listed circle's name, about and size, never who is in it.

   Weekly winners: when the shared week (social.sharedWeek) has turned
   over, and two hours more for late syncs, each circle's first place
   on every board is kept in `circle_win`, ties all winning. Only
   members whose audience for that kind is 'circles' count, so every
   winner is somebody the whole circle can see. A week, once kept, is
   noted in `circle_week` and never worked out again: it is a record,
   and it stays when people leave. A new circle has its last
   BACKFILL_WEEKS filled in from its members' history.
   ============================================================ */

import { randomBytes } from 'node:crypto';
import { METRICS, sharedWeek, valueOf, inScope } from './social.js';
import { faceOf, friendIds } from './friends.js';
import { lensOf, circleWide } from './audience.js';
import { addDays } from './core/util.js';

export const LIMITS = { members: 100, owned: 10, joined: 25 };
export const JOIN_MODES = ['request', 'invite'];
const ACCENTS = ['#2E7D5B', '#3E6FB4', '#B4543E', '#7A5BC9', '#C98A2E', '#2E8C9A', '#B43E7A', '#5E6B2E', '#D0612B', '#4A5BD0', '#1F8A70', '#8A4FB4'];
/** The icons a circle can take (web/js/icons.js names): sports, places, times of day. */
export const ICONS = ['groups', 'run', 'bike', 'walk', 'hike', 'swim', 'dumbbell', 'strength', 'rowing', 'yoga', 'sprint', 'steps', 'flame', 'bolt', 'spark', 'target', 'trends', 'heart', 'sun', 'moon', 'landscape', 'globe', 'flag', 'hotel_class'];
const BACKFILL_WEEKS = 4;
/** Late syncs: a week is kept this long after it turned over. */
const SETTLE_MS = 2 * 3_600_000;
const DAY = 86_400_000;

const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => randomBytes(8).toString('base64url');

/* ── reading ─────────────────────────────────────────────────── */

const rowOf = (r) => (r ? { id: r.id, name: r.name, about: r.about || '', accent: r.accent || ACCENTS[0], icon: ICONS.includes(r.icon) ? r.icon : 'groups', join: r.join_mode, ownerId: r.owner_id, createdAt: r.created_ms } : null);
export function circleOf(app, id) { return rowOf(app.get('SELECT * FROM circle WHERE id = ?', String(id))); }
const memberRow = (app, cid, uid) => app.get('SELECT * FROM circle_member WHERE circle_id = ? AND user_id = ?', String(cid), String(uid)) || null;
const count = (app, cid) => app.get("SELECT COUNT(*) AS n FROM circle_member WHERE circle_id = ? AND status = 'member'", cid).n;
/** The ids of a circle's members. */
export const memberIds = (app, cid) => app.all("SELECT user_id FROM circle_member WHERE circle_id = ? AND status = 'member' ORDER BY created_ms, user_id", cid).map((r) => r.user_id);

/** A circle in a list: what anybody may see of it, and where you stand. */
function summary(app, c, me) {
  const m = memberRow(app, c.id, me);
  const status = m?.status || null;
  const owner = c.ownerId === String(me);
  return {
    id: c.id, name: c.name, about: c.about, accent: c.accent, icon: c.icon, join: c.join, members: count(app, c.id), createdAt: c.createdAt,
    status, role: status === 'member' ? (owner ? 'owner' : 'member') : null,
    // For its owner: how many asked to join.
    waiting: owner ? app.get("SELECT COUNT(*) AS n FROM circle_member WHERE circle_id = ? AND status = 'pending'", c.id).n : 0,
  };
}

/** A circle the viewer may look at, or a 404. Every circle can be found (v158); who is in it, only by its members. */
function visibleTo(app, id, me) {
  const c = circleOf(app, id);
  if (!c) throw bad('There is no such circle.', 404, 'not_found');
  const m = memberRow(app, c.id, me);
  return { c, m };
}
function ownerOf(app, id, me) {
  const { c, m } = visibleTo(app, id, me);
  if (c.ownerId !== String(me) || m?.status !== 'member') throw bad('Only the circle\'s owner can do that.', 403, 'not_owner');
  return c;
}

/** GET /api/circles: yours, invitations, and the requests you made. */
export function mine(app, me) {
  const out = { circles: [], invites: [], requests: [] };
  for (const r of app.all('SELECT circle_id, status, by_id, updated_ms FROM circle_member WHERE user_id = ? ORDER BY created_ms', String(me))) {
    const c = circleOf(app, r.circle_id);
    if (!c) continue;
    const s = summary(app, c, me);
    if (r.status === 'member') out.circles.push(s);
    else if (r.status === 'invited') { const by = app.profile(r.by_id); out.invites.push({ ...s, by: by ? faceOf(by) : null, at: r.updated_ms }); }
    else out.requests.push({ ...s, at: r.updated_ms });
  }
  return out;
}

/** GET /api/circles/browse: every circle you are not in (invitation-only ones say so), matching every word of `q`. */
export function browse(app, me, q = '') {
  const words = clean(q, 60).toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const r of app.all('SELECT * FROM circle ORDER BY created_ms DESC LIMIT 500')) {
    const c = rowOf(r);
    const hay = `${c.name} ${c.about}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const s = summary(app, c, me);
    if (s.status === 'member') continue;
    out.push(s);
  }
  return out.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name)).slice(0, 60);
}

/** GET /api/circles/:id. Members (and, for the owner, who asked and who is invited) only for members. */
export function view(app, me, id) {
  const { c, m } = visibleTo(app, id, me);
  const out = { ...summary(app, c, me) };
  if (m?.status !== 'member') return out;
  const friends = friendIds(app, me);
  const face = (r) => { const p = app.profile(r.user_id); return p ? { ...faceOf(p), me: p.userId === String(me), friend: friends.has(p.userId), owner: p.userId === c.ownerId, since: r.created_ms } : null; };
  const rows = (status) => app.all('SELECT * FROM circle_member WHERE circle_id = ? AND status = ? ORDER BY created_ms, user_id', c.id, status);
  out.owner = (() => { const p = app.profile(c.ownerId); return p ? faceOf(p) : null; })();
  out.memberList = rows('member').map(face).filter(Boolean).sort((a, b) => Number(b.owner) - Number(a.owner) || a.since - b.since);
  if (c.ownerId === String(me)) {
    out.pending = rows('pending').map(face).filter(Boolean);
    out.invited = rows('invited').map(face).filter(Boolean);
  }
  return out;
}

/* ── changing ────────────────────────────────────────────────── */

function checkName(v) {
  const name = clean(v, 41);
  if (name.length < 2 || name.length > 40) throw bad('A name needs 2 to 40 characters.');
  return name;
}
const checkAccent = (v) => { if (v === undefined || v === null || v === '') return null; if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw bad('accent must be a colour like #2E7D5B.'); return String(v).toUpperCase(); };
const checkIcon = (v) => { if (v === undefined || v === null || v === '') return null; if (!ICONS.includes(v)) throw bad('Pick one of the icons.'); return v; };
const checkJoin = (v) => { if (v === undefined) return 'request'; if (!JOIN_MODES.includes(v)) throw bad(`join must be one of ${JOIN_MODES.join(', ')}.`); return v; };
const joinedCount = (app, me) => app.get("SELECT COUNT(*) AS n FROM circle_member WHERE user_id = ? AND status = 'member'", String(me)).n;
const full = (app, c) => count(app, c.id) >= LIMITS.members;

/** POST /api/circles: start one; you are its owner and first member. */
export function create(app, me, b = {}, now = Date.now()) {
  const name = checkName(b.name);
  const about = clean(b.about, 160);
  const join = checkJoin(b.join);
  const owned = app.get('SELECT COUNT(*) AS n FROM circle WHERE owner_id = ?', String(me)).n;
  if (owned >= LIMITS.owned) throw bad(`You can start up to ${LIMITS.owned} circles.`, 409, 'limit');
  if (joinedCount(app, me) >= LIMITS.joined) throw bad(`You can be in up to ${LIMITS.joined} circles.`, 409, 'limit');
  const accent = checkAccent(b.accent) || ACCENTS[(owned + Math.floor(now / 1000)) % ACCENTS.length];
  const id = newId();
  app.tx(() => {
    app.run('INSERT INTO circle (id, name, about, accent, icon, join_mode, owner_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, name, about, accent, checkIcon(b.icon) || 'groups', join, String(me), now, now);
    app.run("INSERT INTO circle_member (circle_id, user_id, status, by_id, created_ms, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)", id, String(me), String(me), now, now);
  });
  fillWeeks(app, circleOf(app, id), now);
  return view(app, me, id);
}

/** PATCH /api/circles/:id (owner): name, about, accent, icon, join, and `owner` (a member's username) to hand it over. */
export function patch(app, me, id, b = {}, now = Date.now()) {
  const c = ownerOf(app, id, me);
  const set = {};
  if (b.name !== undefined) set.name = checkName(b.name);
  if (b.about !== undefined) set.about = clean(b.about, 160);
  if (b.accent !== undefined) set.accent = checkAccent(b.accent) || c.accent;
  if (b.icon !== undefined) set.icon = checkIcon(b.icon) || c.icon;
  if (b.join !== undefined) set.join_mode = checkJoin(b.join);
  if (b.owner !== undefined) {
    const p = app.profileByName(String(b.owner || '').trim());
    if (!p || memberRow(app, c.id, p.userId)?.status !== 'member') throw bad('The new owner has to be in the circle.', 404, 'not_found');
    set.owner_id = p.userId;
  }
  const keys = Object.keys(set);
  if (keys.length) app.run(`UPDATE circle SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_ms = ? WHERE id = ?`, ...keys.map((k) => set[k]), now, c.id);
  return view(app, me, c.id);
}

/** DELETE /api/circles/:id (owner): the circle, who was in it, and its hall of fame. */
export function remove(app, me, id) {
  const c = ownerOf(app, id, me);
  const ids = memberIds(app, c.id);
  app.tx(() => { for (const t of ['circle_member', 'circle_win', 'circle_week', 'circle_goal', 'circle_goal_part', 'circle_event', 'circle_event_member']) app.run(`DELETE FROM ${t} WHERE circle_id = ?`, c.id); app.run('DELETE FROM circle WHERE id = ?', c.id); });
  return { ok: true, members: ids };
}

/**
 * POST /api/circles/:id/join: accept an invitation, or ask to join a listed circle.
 * @returns {{ status, tell }} `tell`: the notification owed to the owner.
 */
export function join(app, me, id, now = Date.now(), { code = null } = {}) {
  const { c, m } = visibleTo(app, id, me);
  const self = app.profile(me);
  if (m?.status === 'member') return { status: 'member', tell: null, circle: view(app, me, c.id) };
  if (m?.status === 'pending') return { status: 'pending', tell: null, circle: view(app, me, c.id) };
  if (joinedCount(app, me) >= LIMITS.joined) throw bad(`You can be in up to ${LIMITS.joined} circles.`, 409, 'limit');
  if (full(app, c)) throw bad(`${c.name} is full (${LIMITS.members} people).`, 409, 'full');
  const url = `/circles/${c.id}`;
  if (m?.status === 'invited') {
    app.run("UPDATE circle_member SET status = 'member', updated_ms = ? WHERE circle_id = ? AND user_id = ?", now, c.id, String(me));
    return { status: 'member', circle: view(app, me, c.id), tell: { userId: c.ownerId, type: 'circle', title: `${self?.displayName || 'Someone'} joined ${c.name}`, body: '', tag: `circle:${c.id}`, url } };
  }
  // The circle's invite link: in at once, whatever the circle's way in.
  const linkCode = app.get('SELECT invite_code FROM circle WHERE id = ?', c.id)?.invite_code;
  if (code && linkCode && String(code) === linkCode) {
    app.run('DELETE FROM circle_member WHERE circle_id = ? AND user_id = ?', c.id, String(me));
    app.run("INSERT INTO circle_member (circle_id, user_id, status, by_id, created_ms, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)", c.id, String(me), String(me), now, now);
    return { status: 'member', circle: view(app, me, c.id), tell: { userId: c.ownerId, type: 'circle', title: `${self?.displayName || 'Someone'} joined ${c.name} with its link`, body: '', tag: `circle:${c.id}`, url } };
  }
  if (c.join !== 'request') throw bad('This circle is invitation only. Ask someone in it to invite you, or for its link.', 403, 'invite_only');
  app.run("INSERT INTO circle_member (circle_id, user_id, status, by_id, created_ms, updated_ms) VALUES (?, ?, 'pending', ?, ?, ?)", c.id, String(me), String(me), now, now);
  return { status: 'pending', circle: view(app, me, c.id), tell: { userId: c.ownerId, type: 'circle', title: `${self?.displayName || 'Someone'} asked to join ${c.name}`, body: '', tag: `circle-ask:${c.id}`, url } };
}

/** POST /api/circles/:id/leave: leave, take back a request, or turn down an invitation. The owner hands it over or deletes it first. */
export function leave(app, me, id) {
  const { c, m } = visibleTo(app, id, me);
  if (!m) return { status: null };
  if (m.status === 'member' && c.ownerId === String(me)) throw bad('Hand the circle to someone else first, or delete it.', 409, 'owner');
  app.run('DELETE FROM circle_member WHERE circle_id = ? AND user_id = ?', c.id, String(me));
  return { status: null };
}

function person(app, username) {
  const p = app.profileByName(String(username || '').trim());
  if (!p) throw bad('There is no such profile.', 404, 'not_found');
  return p;
}

/** POST /api/circles/:id/invite (owner): one of your friends. Somebody who already asked is let in. */
export function invite(app, me, id, username, now = Date.now()) {
  // Anyone in the circle invites (v158): friends from a list, anybody else by their exact username.
  const { c, m: mine } = visibleTo(app, id, me);
  if (mine?.status !== 'member') throw bad('Only the people in a circle can invite to it.', 403, 'not_member');
  const p = person(app, username);
  if (p.userId === String(me)) throw bad('That is you.');
  const m = memberRow(app, c.id, p.userId);
  if (m?.status === 'member') return { status: 'member', tell: null, circle: view(app, me, c.id) };
  if (m?.status === 'pending') return c.ownerId === String(me) ? accept(app, me, id, username, now) : { status: 'pending', tell: null, circle: view(app, me, c.id) };
  if (m?.status === 'invited') return { status: 'invited', tell: null, circle: view(app, me, c.id) };
  if (full(app, c)) throw bad(`${c.name} is full (${LIMITS.members} people).`, 409, 'full');
  const self = app.profile(me);
  app.run("INSERT INTO circle_member (circle_id, user_id, status, by_id, created_ms, updated_ms) VALUES (?, ?, 'invited', ?, ?, ?)", c.id, p.userId, String(me), now, now);
  return { status: 'invited', circle: view(app, me, c.id), tell: { userId: p.userId, type: 'circle', title: `${self?.displayName || 'Someone'} invited you to ${c.name}`, body: '', tag: `circle-invite:${c.id}`, url: `/circles/${c.id}` } };
}

/** GET /api/circles/:id/link (members): the circle's invite link, made the first time it is asked for. */
export function inviteLink(app, me, id) {
  const { c, m } = visibleTo(app, id, me);
  if (m?.status !== 'member') throw bad('Only the people in a circle can share its link.', 403, 'not_member');
  let code = app.get('SELECT invite_code FROM circle WHERE id = ?', c.id)?.invite_code;
  if (!code) { code = randomBytes(6).toString('base64url'); app.run('UPDATE circle SET invite_code = ? WHERE id = ?', code, c.id); }
  return { code, path: `/circles/${c.id}?code=${code}` };
}

/** POST /api/circles/:id/members/:username/accept (owner): let somebody who asked in. */
export function accept(app, me, id, username, now = Date.now()) {
  const c = ownerOf(app, id, me);
  const p = person(app, username);
  const m = memberRow(app, c.id, p.userId);
  if (m?.status === 'member') return { status: 'member', tell: null, circle: view(app, me, c.id) };
  if (m?.status !== 'pending') throw bad(`${p.displayName} has not asked to join.`, 404, 'not_found');
  if (full(app, c)) throw bad(`${c.name} is full (${LIMITS.members} people).`, 409, 'full');
  app.run("UPDATE circle_member SET status = 'member', by_id = ?, updated_ms = ? WHERE circle_id = ? AND user_id = ?", String(me), now, c.id, p.userId);
  return { status: 'member', circle: view(app, me, c.id), tell: { userId: p.userId, type: 'circle', title: `You are in ${c.name}`, body: 'Its boards are on People, Ranks.', tag: `circle:${c.id}`, url: `/circles/${c.id}` } };
}

/** POST /api/circles/:id/members/:username/decline (owner): say no to a request, or take back an invitation. */
export function decline(app, me, id, username) {
  const c = ownerOf(app, id, me);
  const p = person(app, username);
  const m = memberRow(app, c.id, p.userId);
  if (m && m.status !== 'member') app.run('DELETE FROM circle_member WHERE circle_id = ? AND user_id = ?', c.id, p.userId);
  return { status: null, circle: view(app, me, c.id) };
}

/** DELETE /api/circles/:id/members/:username (owner): take somebody out. */
export function removeMember(app, me, id, username) {
  const c = ownerOf(app, id, me);
  const p = person(app, username);
  if (p.userId === String(me)) throw bad('Hand the circle to someone else first, or delete it.', 409, 'owner');
  app.run('DELETE FROM circle_member WHERE circle_id = ? AND user_id = ?', c.id, p.userId);
  return { status: null, circle: view(app, me, c.id) };
}

/* ── weekly winners ──────────────────────────────────────────── */

/** The start of the last shared week that is over (and settled) at `now`. */
export const lastClosedWeek = (now) => addDays(sharedWeek(now - SETTLE_MS).from, -7);

/**
 * One week's podium on every board in a circle, from its members now:
 * [{ metric, userId, value, place }], place 1 to 3; ties share a place,
 * and the next place after a tie is the next value down.
 */
function weekWinners(app, c, week) {
  const members = memberIds(app, c.id).map((uid) => app.profile(uid)).filter(Boolean);
  const range = { from: week, to: addDays(week, 6) };
  const out = [];
  for (const [metric, m] of Object.entries(METRICS)) {
    if (m.retired) continue;
    const vals = [];
    for (const p of members) {
      if (!circleWide(p, m.cat)) continue;
      const v = valueOf(app, p.userId, metric, range, 'week')?.value;
      if (v > 0) vals.push({ userId: p.userId, value: v });
    }
    const steps = [...new Set(vals.map((x) => x.value))].sort((a, b) => b - a).slice(0, 3);
    for (const x of vals) { const place = steps.indexOf(x.value) + 1; if (place) out.push({ metric, userId: x.userId, value: x.value, place }); }
  }
  return out;
}

/**
 * Keep every closed week of a circle not kept yet: since it started, and
 * BACKFILL_WEEKS before that. @returns the weeks newly kept, oldest first.
 */
export function fillWeeks(app, c, now = Date.now()) {
  if (!c) return [];
  const last = lastClosedWeek(now);
  const first = addDays(sharedWeek(c.createdAt).from, -7 * BACKFILL_WEEKS);
  const have = new Set(app.all('SELECT week FROM circle_week WHERE circle_id = ?', c.id).map((r) => r.week));
  const todo = [];
  for (let w = last; w >= first; w = addDays(w, -7)) if (!have.has(w)) todo.push(w);
  todo.reverse();
  for (const week of todo) {
    const wins = weekWinners(app, c, week);
    app.tx(() => {
      const ins = app.p('INSERT OR IGNORE INTO circle_win (circle_id, week, metric, user_id, value, place) VALUES (?, ?, ?, ?, ?, ?)');
      for (const x of wins) ins.run(c.id, week, x.metric, x.userId, x.value, x.place);
      app.run('INSERT OR IGNORE INTO circle_week (circle_id, week) VALUES (?, ?)', c.id, week);
    });
  }
  // Weeks kept before podiums (v142) had only their winners: second and third
  // are added once, from the members' numbers as they are now. Winners stay as kept.
  const flag = `circle.podium:${c.id}`;
  if (!app.meta(flag, null)) {
    const old = [...have];
    const rows = old.map((week) => [week, weekWinners(app, c, week).filter((x) => x.place > 1)]);
    app.tx(() => {
      const ins = app.p('INSERT OR IGNORE INTO circle_win (circle_id, week, metric, user_id, value, place) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [week, xs] of rows) {
        const gold = new Map();
        for (const g of app.all('SELECT metric, value FROM circle_win WHERE circle_id = ? AND week = ? AND place = 1', c.id, week)) gold.set(g.metric, g.value);
        for (const x of xs) {
          // Only below what won that week, so the kept winner stays first.
          if (!gold.has(x.metric) || x.value >= gold.get(x.metric)) continue;
          ins.run(c.id, week, x.metric, x.userId, x.value, x.place);
        }
      }
      app.setMeta(flag, 1);
    });
  }
  return todo;
}

/**
 * The minute tick: when a week has just closed, keep it for every circle and
 * say who won. @returns [{ userId, note }] the notifications owed.
 */
export function closeWeeks(app, now = Date.now()) {
  const last = lastClosedWeek(now);
  if (app.meta('circles.closed', null) === last) return [];
  const notes = [];
  for (const r of app.all('SELECT * FROM circle')) {
    const c = rowOf(r);
    const kept = fillWeeks(app, c, now);
    if (!kept.includes(last) || now - c.createdAt < 7 * DAY) continue;   // a circle a few days old: its backfill is not news
    const won = new Map();
    for (const w of app.all('SELECT metric, user_id FROM circle_win WHERE circle_id = ? AND week = ? AND place = 1', c.id, last)) {
      if (!won.has(w.user_id)) won.set(w.user_id, []);
      won.get(w.user_id).push(METRICS[w.metric]?.label || w.metric);
    }
    for (const [userId, labels] of won) {
      notes.push({ userId, note: { type: 'circle', title: `You won the week in ${list(labels)}`, body: `In ${c.name}.`, tag: `circle-week:${c.id}:${last}`, url: `/circles/${c.id}/hall` } });
    }
  }
  app.setMeta('circles.closed', last);
  return notes;
}
const list = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`);

/** GET /api/circles/:id/winners: the hall of fame. Members only. */
export function winners(app, me, id, { weeks = 12, now = Date.now() } = {}) {
  const { c, m } = visibleTo(app, id, me);
  if (m?.status !== 'member') throw bad('There is no such circle.', 404, 'not_found');
  fillWeeks(app, c, now);
  const n = Math.max(1, Math.min(104, Math.round(Number(weeks)) || 12));
  const faces = new Map();
  const face = (uid) => { if (!faces.has(uid)) { const p = app.profile(uid); faces.set(uid, p ? { ...faceOf(p), me: uid === String(me) } : null); } return faces.get(uid); };
  const kept = app.all('SELECT week FROM circle_week WHERE circle_id = ? ORDER BY week DESC', c.id).map((r) => r.week);
  const rows = app.all('SELECT week, metric, user_id, value, place FROM circle_win WHERE circle_id = ? ORDER BY place', c.id);
  const TIER = ['', 'gold', 'silver', 'bronze'];
  const byWeek = new Map();
  const tally = new Map();
  for (const r of rows) {
    if (!face(r.user_id)) continue;   // an account since deleted
    if (!byWeek.has(r.week)) byWeek.set(r.week, new Map());
    const wk = byWeek.get(r.week);
    if (!wk.has(r.metric)) wk.set(r.metric, new Map());
    const pl = wk.get(r.metric);
    if (!pl.has(r.place)) pl.set(r.place, { place: r.place, tier: TIER[r.place], value: r.value, people: [] });
    pl.get(r.place).people.push(face(r.user_id));
    if (!tally.has(r.user_id)) tally.set(r.user_id, { gold: 0, silver: 0, bronze: 0, boards: new Map() });
    const t = tally.get(r.user_id);
    const tier = TIER[r.place];
    if (!tier) continue;
    t[tier] += 1;
    if (!t.boards.has(r.metric)) t.boards.set(r.metric, { gold: 0, silver: 0, bronze: 0 });
    t.boards.get(r.metric)[tier] += 1;
  }
  const order = Object.keys(METRICS);
  const weekView = (week) => ({
    week, to: addDays(week, 6),
    winners: order.filter((k) => byWeek.get(week)?.get(k)?.has(1)).map((k) => {
      const podium = [...byWeek.get(week).get(k).values()].sort((a, b) => a.place - b.place);
      // value and people: the winners, as before podiums.
      return { metric: k, label: METRICS[k].label, unit: METRICS[k].unit, cat: METRICS[k].cat, value: podium[0].value, people: podium[0].people, podium };
    }),
  });
  const score = (t) => t.gold * 1e6 + t.silver * 1e3 + t.bronze;
  const medals = { gold: 0, silver: 0, bronze: 0 };
  for (const r of rows) if (face(r.user_id) && TIER[r.place]) medals[TIER[r.place]] += 1;
  return {
    circle: { id: c.id, name: c.name, accent: c.accent, icon: c.icon },
    medals: { ...medals, total: medals.gold + medals.silver + medals.bronze },
    weeksKept: kept.length,
    current: sharedWeek(now),
    weeks: kept.slice(0, n).map(weekView),
    tally: [...tally].map(([uid, t]) => ({
      ...face(uid), wins: t.gold, gold: t.gold, silver: t.silver, bronze: t.bronze, medals: t.gold + t.silver + t.bronze,
      boards: [...t.boards].map(([k, x]) => ({ metric: k, label: METRICS[k]?.label || k, wins: x.gold, ...x }))
        .sort((a, b) => score(b) - score(a)),
    })).filter((t) => t.medals)
      .sort((a, b) => score(b) - score(a) || a.displayName.localeCompare(b.displayName)),
  };
}

/**
 * A board, with who won last week: kept, for a circle (and each person's
 * wins on this board); worked out now, for Friends.
 */
export function decorateBoard(app, board, { viewerId, scope, now = Date.now() }) {
  const sc = String(scope);
  const m = METRICS[board.metric];
  const week = lastClosedWeek(now);
  if (sc.startsWith('circle:')) {
    const id = sc.slice(7);
    const c = circleOf(app, id);
    if (!c) return board;
    fillWeeks(app, c, now);
    const wins = new Map(app.all('SELECT user_id, COUNT(*) AS n FROM circle_win WHERE circle_id = ? AND metric = ? AND place = 1 GROUP BY user_id', c.id, board.metric).map((r) => [r.user_id, r.n]));
    const byName = new Map(app.all("SELECT p.username, p.user_id FROM circle_member cm JOIN profile p ON p.user_id = cm.user_id WHERE cm.circle_id = ? AND cm.status = 'member'", c.id).map((r) => [r.username, r.user_id]));
    for (const e of board.entries) e.wins = wins.get(byName.get(e.username)) || 0;
    const last = app.all('SELECT user_id, value FROM circle_win WHERE circle_id = ? AND week = ? AND metric = ? AND place = 1', c.id, week, board.metric);
    const people = last.map((r) => app.profile(r.user_id)).filter(Boolean).map((p) => ({ ...faceOf(p), me: p.userId === String(viewerId) }));
    board.circle = { id: c.id, name: c.name, accent: c.accent, icon: c.icon };
    board.lastWeek = people.length ? { week, to: addDays(week, 6), value: last[0].value, people } : { week, to: addDays(week, 6), value: null, people: [] };
    return board;
  }
  // Friends or everyone: the viewer's own view of who was first last week.
  const L = lensOf(app, viewerId);
  const range = { from: week, to: addDays(week, 6) };
  let best = 0; let who = [];
  for (const p of inScope(app, viewerId, sc === 'everyone' ? 'everyone' : 'friends')) {
    if (!L.listed(p, m.cat) || (sc === 'everyone' && p.userId === String(viewerId) && !(p.privacy.account !== 'private' && p.privacy[m.cat] === 'everyone'))) continue;
    const v = valueOf(app, p.userId, board.metric, range, 'week')?.value;
    if (!(v > 0)) continue;
    if (v > best) { best = v; who = [p]; } else if (v === best) who.push(p);
  }
  board.lastWeek = { week, to: addDays(week, 6), value: who.length ? best : null, people: who.map((p) => ({ ...faceOf(p), me: p.userId === String(viewerId) })) };
  return board;
}
