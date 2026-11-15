/* ============================================================
   health.ojee.net — blocking and reporting.

   Block: one person stops another seeing them at all. Both ways, at
   once: the friendship and any request go, neither sees the other's
   posts, comments, cheers, boards rows or profile, and neither can find
   or ask the other again. The blocked person is not told. Rows in
   `block` (user_id blocked blocked_id); undone by unblocking.

   Report: a post, a comment, a photo or video, or a person, with a
   reason, kept in `report` for the admins (the Admin screen lists the
   open ones; they are told by notification). An admin removes what was
   reported (a post is hidden from everyone but its author, a comment or
   a photo deleted) or dismisses it. What was reported is copied into the
   report as it was, so a later edit does not hide it.
   ============================================================ */

import { randomBytes } from 'node:crypto';

const bad = (message, status = 400, code) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });
export const REASONS = {
  spam: 'Spam or scam',
  harassment: 'Harassment or bullying',
  hate: 'Hate or violence',
  sexual: 'Nudity or sexual content',
  self_harm: 'Self-harm or dangerous behaviour',
  false_health: 'Dangerous health claims',
  ip: 'Someone else\'s work or photo',
  privacy: 'Shares someone\'s private information',
  other: 'Something else',
};
export const KINDS = ['post', 'comment', 'media', 'person'];

/* Walled accounts (config.signin.walled: the app reviewers' `demo`): kept apart from everyone
   else, as if each side had blocked the other. A reviewer, or Google's pre-launch robot signed in
   as one, taps "Add" on whoever is suggested; with the wall, nobody real is suggested, found, sent
   a request, shown on a board or in a feed, and nothing of theirs reaches the reviewer. Walled
   accounts still see each other. Set by name, so an account made later is walled too. */
const WALL = new WeakMap();   // app → [usernames]
export function setWalled(app, names = []) { WALL.set(app, [...new Set(names.map((n) => String(n).toLowerCase()).filter(Boolean))]); }
/** The user ids of the walled accounts that exist. */
export function walledIds(app) {
  const out = new Set();
  for (const n of WALL.get(app) || []) { const p = app.profileByName?.(n); if (p) out.add(p.userId); else { const a = app.get?.('SELECT id FROM account WHERE username = ?', n); if (a) out.add(a.id); } }
  return out;
}
/** Are these two on either side of the wall? */
export function walledApart(app, a, b) {
  const w = walledIds(app);
  return w.size > 0 && w.has(String(a)) !== w.has(String(b));
}

/** Everyone this person blocked or was blocked by: they see nothing of each other. Across the wall too. */
export function blockedIds(app, me) {
  const id = String(me || '');
  if (!id) return new Set();
  const out = new Set();
  for (const r of app.all('SELECT user_id, blocked_id FROM block WHERE user_id = ? OR blocked_id = ?', id, id)) out.add(r.user_id === id ? r.blocked_id : r.user_id);
  const w = walledIds(app);
  if (w.size) {
    if (w.has(id)) { for (const r of app.all('SELECT id FROM account')) if (!w.has(r.id)) out.add(r.id); for (const p of app.profiles()) if (!w.has(p.userId)) out.add(p.userId); } else for (const x of w) if (x !== id) out.add(x);
  }
  return out;
}
export const isBlocked = (app, a, b) => walledApart(app, a, b) || !!app.get('SELECT 1 AS x FROM block WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', String(a), String(b), String(b), String(a));

/** What already crossed the wall goes: friendships and requests, and circle places. Returns how many rows. */
export function clearWall(app) {
  const w = [...walledIds(app)];
  if (!w.length) return 0;
  const q = w.map(() => '?').join(', ');
  let n = app.run(`DELETE FROM friend WHERE (a IN (${q})) != (b IN (${q}))`, ...w, ...w).changes || 0;
  // A walled account's place in a circle whose owner is on the other side, and the other way round.
  n += app.run(`DELETE FROM circle_member WHERE rowid IN (SELECT m.rowid FROM circle_member m JOIN circle c ON c.id = m.circle_id WHERE (m.user_id IN (${q})) != (c.owner_id IN (${q})))`, ...w, ...w).changes || 0;
  return n;
}

/** People this person blocked (not those who blocked them: they are never told). */
export function blockedList(app, me) {
  return app.all('SELECT blocked_id, at FROM block WHERE user_id = ? ORDER BY at DESC', String(me))
    .map((r) => { const p = app.profile(r.blocked_id); return p ? { username: p.username, displayName: p.displayName, accent: p.accent, at: r.at } : null; })
    .filter(Boolean);
}

export function block(app, me, username, now = Date.now()) {
  const p = app.profileByName(String(username || '').trim());
  if (!p) throw bad('There is no such profile.', 404, 'not_found');
  if (p.userId === String(me)) throw bad('That is you.');
  const [a, b] = String(me) < p.userId ? [String(me), p.userId] : [p.userId, String(me)];
  app.tx(() => {
    app.run('INSERT OR IGNORE INTO block (user_id, blocked_id, at) VALUES (?, ?, ?)', String(me), p.userId, now);
    app.run('DELETE FROM friend WHERE a = ? AND b = ?', a, b);
    // Their cheers on your posts, and yours on theirs, go; comments stay hidden (lens) and come back on unblocking.
    app.run('DELETE FROM cheer WHERE user_id = ? AND post_id IN (SELECT id FROM post WHERE user_id = ?)', p.userId, String(me));
    app.run('DELETE FROM cheer WHERE user_id = ? AND post_id IN (SELECT id FROM post WHERE user_id = ?)', String(me), p.userId);
  });
  return { blocked: true, userId: p.userId };
}

export function unblock(app, me, username) {
  const p = app.profileByName(String(username || '').trim());
  if (!p) throw bad('There is no such profile.', 404, 'not_found');
  app.run('DELETE FROM block WHERE user_id = ? AND blocked_id = ?', String(me), p.userId);
  return { blocked: false };
}

/** What a report points at: its author and a copy of it as it is now. */
function targetOf(app, kind, id) {
  if (kind === 'post') {
    const r = app.get('SELECT * FROM post WHERE id = ?', String(id));
    if (!r) return null;
    let d = {}; try { d = JSON.parse(r.data); } catch { /* keep {} */ }
    return { user: r.user_id, snapshot: { title: d.title || null, caption: r.caption || null, music: r.music ? 'yes' : null, at: r.end_ms } };
  }
  if (kind === 'comment') {
    const c = app.get('SELECT * FROM comment WHERE id = ?', String(id));
    return c ? { user: c.user_id, snapshot: { text: c.text, postId: c.post_id, at: c.at } } : null;
  }
  if (kind === 'media') {
    const m = app.get('SELECT * FROM media WHERE id = ?', String(id));
    return m ? { user: m.user_id, snapshot: { kind: m.kind, postId: m.post_id } } : null;
  }
  if (kind === 'person') {
    const p = app.profileByName(String(id || '').trim());
    return p ? { user: p.userId, snapshot: { username: p.username, displayName: p.displayName, bio: p.bio || null } } : null;
  }
  return null;
}

/** File a report. `canSee(kind, id)` says whether the reporter may see it (only what you see can be reported). */
export function report(app, { me, kind, id, reason, note = '', now = Date.now(), canSee = () => true }) {
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}.`);
  if (!REASONS[reason]) throw bad(`reason must be one of ${Object.keys(REASONS).join(', ')}.`);
  const t = targetOf(app, kind, id);
  if (!t || !canSee(kind, id, t)) throw bad('That is gone, or you cannot see it.', 404, 'not_found');
  if (t.user === String(me)) throw bad('That is yours.');
  const dup = app.get("SELECT id FROM report WHERE reporter_id = ? AND kind = ? AND target_id = ? AND state = 'open'", String(me), kind, String(id));
  if (dup) return { id: dup.id, again: true, targetUser: t.user };
  const rid = `rp_${randomBytes(6).toString('hex')}`;
  app.run('INSERT INTO report (id, reporter_id, kind, target_id, target_user, reason, note, snapshot, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    rid, String(me), kind, String(id), t.user, reason, String(note || '').trim().slice(0, 500) || null, JSON.stringify(t.snapshot), now, 'open');
  return { id: rid, again: false, targetUser: t.user };
}

/** Suspended people: they cannot use the app, and nobody sees them, until an admin lets them back. */
export const suspendedIds = (app) => new Set(Object.keys(app.meta('suspended', {}) || {}));
export function suspend(app, userId, on, now = Date.now()) {
  const s = { ...(app.meta('suspended', {}) || {}) };
  if (on) s[String(userId)] = now; else delete s[String(userId)];
  app.setMeta('suspended', s);
}

/** The admins' list: open reports first, then the last handled ones. */
export function reportsView(app, { limit = 60 } = {}) {
  const who = (id) => { const p = id && app.profile(id); return p ? { username: p.username, displayName: p.displayName } : null; };
  return app.all("SELECT * FROM report ORDER BY state = 'open' DESC, at DESC LIMIT ?", limit).map((r) => {
    let snap = {}; try { snap = JSON.parse(r.snapshot || '{}'); } catch { /* keep {} */ }
    return {
      id: r.id, kind: r.kind, targetId: r.target_id, reason: r.reason, reasonText: REASONS[r.reason] || r.reason, note: r.note, at: r.at,
      state: r.state, action: r.action || null, handledAt: r.handled_ms || null,
      reporter: who(r.reporter_id), author: who(r.target_user), snapshot: snap,
      mediaUrl: r.kind === 'media' && r.state === 'open' ? `/media/${r.target_id}` : null,
    };
  });
}
export const openReports = (app) => app.get("SELECT COUNT(*) AS n FROM report WHERE state = 'open'").n;

/** An admin's decision: 'remove' what was reported (a person: nothing to remove; see Admin) or 'dismiss'. */
export function resolveReport(app, { id, action, by, now = Date.now() }) {
  const r = app.get('SELECT * FROM report WHERE id = ?', String(id));
  if (!r) throw bad('No such report.', 404, 'not_found');
  if (!['remove', 'dismiss', 'suspend'].includes(action)) throw bad('action must be remove, dismiss or suspend.');
  if (action === 'suspend') suspend(app, r.target_user, true, now);
  if (action === 'remove') {
    if (r.kind === 'post') app.run('UPDATE post SET removed = 1 WHERE id = ?', r.target_id);
    if (r.kind === 'comment') app.run('DELETE FROM comment WHERE id = ?', r.target_id);
    if (r.kind === 'media') app.dropMedia('id = ?', r.target_id);
  }
  // Every open report of the same thing is settled by one decision.
  app.run("UPDATE report SET state = 'done', action = ?, handled_ms = ?, handled_by = ? WHERE kind = ? AND target_id = ? AND state = 'open'", action, now, String(by), r.kind, r.target_id);
  return { ok: true };
}
