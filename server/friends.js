/* ============================================================
   health.ojee.net — friends: who asked whom, and who said yes.

   One row per pair in `friend` (a < b, so a pair can only be written
   once), with `requester` saying who asked. 'pending' is a request,
   'friends' is both. Removing a friend, declining or cancelling a
   request all delete the row: nothing is kept of a "no".

   Friends decide what you see (the Friends boards, the feed), never
   what is shared: a friend still sees only the kinds whose audience
   includes friends (audience.js), read again at every request. Nobody
   is listed to strangers: a request is made by typing a username
   exactly, and there are no suggestions.
   ============================================================ */

const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const pair = (x, y) => (String(x) < String(y) ? [String(x), String(y)] : [String(y), String(x)]);

/** Where a person's profile photo is served, or null for none. The id
    changes with every new photo, so the address can be cached for good. */
export const avatarUrl = (p) => (p?.avatar ? `/media/${p.avatar}` : null);

/** The public face of a person in any list: P. */
export const faceOf = (p) => ({ username: p.username, displayName: p.displayName, accent: p.accent, avatar: avatarUrl(p), joinedAt: p.joinedAt });

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

/** Requests waiting for this person's answer. */
export function requestCount(app, me) {
  let n = 0;
  for (const [other, r] of relations(app, me)) if (r.status === 'incoming' && app.profile(other)) n += 1;
  return n;
}

/** GET /api/friends: friends and requests both ways. `suggestions` stays, empty:
    suggesting people showed strangers to each other (docs/CIRCLES.md). */
export function friendsView(app, me) {
  const out = { friends: [], incoming: [], outgoing: [], suggestions: [] };
  for (const [other, r] of relations(app, me)) {
    const p = app.profile(other);
    if (!p) continue;
    if (r.status === 'friends') out.friends.push({ ...faceOf(p), since: r.at });
    else out[r.status].push({ ...faceOf(p), at: r.at });
  }
  out.friends.sort((x, y) => x.displayName.localeCompare(y.displayName) || x.username.localeCompare(y.username));
  out.incoming.sort((x, y) => y.at - x.at);
  out.outgoing.sort((x, y) => y.at - x.at);
  return out;
}

/** Somebody by their exact username (any case), for adding them: their face and where you stand. */
export function find(app, me, username) {
  const p = app.profileByName(String(username || '').trim());
  if (!p || p.onboarding !== 'done') return null;
  return { ...faceOf(p), me: p.userId === String(me), friend: relation(app, me, p.userId) };
}

/** The person a request names, by their exact username (any case). */
function target(app, me, username) {
  const p = app.profileByName(String(username || '').trim());
  if (!p) throw bad('There is no such profile.', 404);
  if (p.userId === String(me)) throw bad('That is you.');
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
  const row = rowOf(app, me, p.userId);
  const st = statusOf(row, me);
  if (st === 'friends') return { status: 'friends', tell: null };
  if (st !== 'incoming') throw bad(`${p.displayName} has not asked to be friends.`, 404);
  app.run("UPDATE friend SET status = 'friends', updated_ms = ? WHERE a = ? AND b = ?", now, row.a, row.b);
  return { status: 'friends', tell: { userId: p.userId, type: 'friend', title: `${self.displayName} accepted your request`, body: '', tag: `friend:${self.username}`, url: `/u/${self.username}` } };
}

/** Say no to a request. Nothing is kept: they may ask again. */
export function decline(app, me, username) {
  const p = target(app, me, username);
  const row = rowOf(app, me, p.userId);
  if (statusOf(row, me) === 'incoming') app.run('DELETE FROM friend WHERE a = ? AND b = ?', row.a, row.b);
  return { status: relation(app, me, p.userId) };
}

/** Unfriend, or take back a request you made (or, the same thing from
    the other side, turn one down). Afterwards there is no relation. */
export function remove(app, me, username) {
  const p = target(app, me, username);
  const row = rowOf(app, me, p.userId);
  if (row) app.run('DELETE FROM friend WHERE a = ? AND b = ?', row.a, row.b);
  return { status: null };
}
