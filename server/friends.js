/* ============================================================
   health.ojee.net — friends: who asked whom, and who said yes.

   One row per pair in `friend` (a < b, so a pair can only be written
   once), with `requester` saying who asked. 'pending' is a request,
   'friends' is both. Removing a friend, declining or cancelling a
   request all delete the row: nothing is kept of a "no".

   Friends decide what you see (the boards by default, the feed),
   never what is shared: a friend still sees only what the person's
   own privacy switches allow, read again at every request. A private
   account is in nobody's lists, requests included, and cannot ask
   anyone: it has no profile for the other side to look at.
   ============================================================ */

const isPublic = (p) => !!p && p.privacy.account === 'public';
const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const pair = (x, y) => (String(x) < String(y) ? [String(x), String(y)] : [String(y), String(x)]);

/** The public face of a person in any list: P. */
export const faceOf = (p) => ({ username: p.username, displayName: p.displayName, accent: p.accent, joinedAt: p.joinedAt });

function rowOf(app, me, other) {
  const [a, b] = pair(me, other);
  return app.get('SELECT * FROM friend WHERE a = ? AND b = ?', a, b) || null;
}
const statusOf = (row, me) => (!row ? null : row.status === 'friends' ? 'friends' : row.requester === String(me) ? 'outgoing' : 'incoming');

/** Where you stand with one person: 'friends' | 'incoming' | 'outgoing' | null. */
export function relation(app, me, other) {
  if (!me || !other || String(me) === String(other)) return null;
  return statusOf(rowOf(app, me, other), me);
}

/** Every relation of one person: Map<otherUserId, { status, at }>. */
export function relations(app, me) {
  const id = String(me);
  const out = new Map();
  for (const r of app.all('SELECT * FROM friend WHERE a = ? OR b = ?', id, id)) out.set(r.a === id ? r.b : r.a, { status: statusOf(r, id), at: r.updated_ms });
  return out;
}

/** The user ids of a person's accepted friends. */
export function friendIds(app, me) {
  const id = String(me);
  return new Set(app.all("SELECT a, b FROM friend WHERE status = 'friends' AND (a = ? OR b = ?)", id, id).map((r) => (r.a === id ? r.b : r.a)));
}

/** Requests waiting for this person's answer, from people who can be seen. */
export function requestCount(app, me) {
  let n = 0;
  for (const [other, r] of relations(app, me)) if (r.status === 'incoming' && isPublic(app.profile(other))) n += 1;
  return n;
}

/** GET /api/friends: friends, requests both ways, and people you might know. */
export function friendsView(app, me) {
  const id = String(me);
  const rel = relations(app, me);
  const out = { friends: [], incoming: [], outgoing: [], suggestions: [] };
  for (const [other, r] of rel) {
    const p = app.profile(other);
    if (!isPublic(p)) continue;   // a private account is in nobody's lists
    if (r.status === 'friends') out.friends.push({ ...faceOf(p), since: r.at });
    else out[r.status].push({ ...faceOf(p), at: r.at });
  }
  out.friends.sort((x, y) => x.displayName.localeCompare(y.displayName) || x.username.localeCompare(y.username));
  out.incoming.sort((x, y) => y.at - x.at);
  out.outgoing.sort((x, y) => y.at - x.at);

  // Suggestions: public people with no relation to you, friends of your
  // friends first (most friends in common), then the newest.
  const mine = new Set([...rel].filter(([, r]) => r.status === 'friends').map(([o]) => o));
  const adj = new Map();
  for (const r of app.all("SELECT a, b FROM friend WHERE status = 'friends'")) {
    if (!adj.has(r.a)) adj.set(r.a, new Set()); if (!adj.has(r.b)) adj.set(r.b, new Set());
    adj.get(r.a).add(r.b); adj.get(r.b).add(r.a);
  }
  out.suggestions = app.profiles()
    .filter((p) => isPublic(p) && p.userId !== id && !rel.has(p.userId))
    .map((p) => ({ p, mutual: [...(adj.get(p.userId) || [])].filter((x) => mine.has(x)).length }))
    .sort((x, y) => y.mutual - x.mutual || y.p.joinedAt - x.p.joinedAt || x.p.username.localeCompare(y.p.username))
    .slice(0, 12)
    .map(({ p, mutual }) => ({ ...faceOf(p), mutual }));
  return out;
}

/** The person a request names: 404 for nobody and for a private account,
    the same answer, so the two cannot be told apart. */
function target(app, me, username, { allowPrivate = false } = {}) {
  const p = app.profileByName(String(username || '').trim());
  if (!p) throw bad('There is no such profile.', 404);
  if (p.userId === String(me)) throw bad('That is you.');
  // A private account can still be removed or declined by someone who
  // had a relation with it; it cannot be found otherwise.
  if (!isPublic(p) && !(allowPrivate && rowOf(app, me, p.userId))) throw bad('There is no such profile.', 404);
  return p;
}

/**
 * Ask somebody, or accept when they already asked you.
 * @returns {{ status: 'requested' | 'friends', tell: object | null }}
 *   `tell`: the notification owed to the other person, if any.
 */
export function request(app, me, username, now = Date.now()) {
  const self = app.profile(me);
  const p = target(app, me, username);
  if (!isPublic(self)) throw Object.assign(bad('Your account is private. Make it public in Settings, Privacy to add friends.', 409), { code: 'private' });
  const row = rowOf(app, me, p.userId);
  const st = statusOf(row, me);
  if (st === 'friends') return { status: 'friends', tell: null };
  if (st === 'outgoing') return { status: 'requested', tell: null };
  if (st === 'incoming') return accept(app, me, username, now);
  const [a, b] = pair(me, p.userId);
  app.run("INSERT INTO friend (a, b, status, requester, created_ms, updated_ms) VALUES (?, ?, 'pending', ?, ?, ?)", a, b, String(me), now, now);
  return { status: 'requested', tell: { userId: p.userId, type: 'friend', title: `${self.displayName} wants to be friends`, body: '', tag: `friend:${self.username}`, url: '/people/friends' } };
}

/** Say yes to a request. */
export function accept(app, me, username, now = Date.now()) {
  const self = app.profile(me);
  const p = target(app, me, username);
  if (!isPublic(self)) throw Object.assign(bad('Your account is private. Make it public in Settings, Privacy to add friends.', 409), { code: 'private' });
  const row = rowOf(app, me, p.userId);
  const st = statusOf(row, me);
  if (st === 'friends') return { status: 'friends', tell: null };
  if (st !== 'incoming') throw bad(`${p.displayName} has not asked to be friends.`, 404);
  app.run("UPDATE friend SET status = 'friends', updated_ms = ? WHERE a = ? AND b = ?", now, row.a, row.b);
  return { status: 'friends', tell: { userId: p.userId, type: 'friend', title: `${self.displayName} accepted your request`, body: '', tag: `friend:${self.username}`, url: `/u/${self.username}` } };
}

/** Say no to a request. Nothing is kept: they may ask again. */
export function decline(app, me, username) {
  const p = target(app, me, username, { allowPrivate: true });
  const row = rowOf(app, me, p.userId);
  if (statusOf(row, me) === 'incoming') app.run('DELETE FROM friend WHERE a = ? AND b = ?', row.a, row.b);
  return { status: relation(app, me, p.userId) };
}

/** Unfriend, or take back a request you made (or, the same thing from
    the other side, turn one down). Afterwards there is no relation. */
export function remove(app, me, username) {
  const p = target(app, me, username, { allowPrivate: true });
  const row = rowOf(app, me, p.userId);
  if (row) app.run('DELETE FROM friend WHERE a = ? AND b = ?', row.a, row.b);
  return { status: null };
}
