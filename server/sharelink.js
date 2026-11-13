/* ============================================================
   health.ojee.net — a link to one routine or route, to send to someone.

   Sharing with everyone (sharedlib.js, routelib.js) reaches friends and
   circle-mates only; a link reaches whoever it is sent to. Anyone signed
   in who opens it sees the routine or route as it is now (not a copy made
   when the link was) and can add it to their own. One link per thing,
   made the first time it is asked for and the same after that; turning it
   off makes it stop working, and a new one is made the next time.

   A link stops working when the thing is deleted, when its owner is
   suspended, and between two people where either blocked the other.
   Tokens are 16 random bytes: unguessable, never listed anywhere.
   ============================================================ */

import { randomBytes } from 'node:crypto';
import { isBlocked, suspendedIds } from './safety.js';

export const LINK_KINDS = ['routine', 'route'];
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });

export const linkPath = (token) => `/s/${token}`;

/** The link to something of the person's: the one made before, else (with `make`) a new one. */
export function linkOf(app, userId, kind, ref, { make = true, now = Date.now() } = {}) {
  if (!LINK_KINDS.includes(kind)) throw bad('kind must be routine or route.');
  const row = app.get('SELECT token FROM share_link WHERE user_id = ? AND kind = ? AND ref = ?', String(userId), kind, String(ref));
  if (row) return row.token;
  if (!make) return null;
  const token = randomBytes(16).toString('base64url');
  app.run('INSERT INTO share_link (token, user_id, kind, ref, created_ms) VALUES (?, ?, ?, ?, ?)', token, String(userId), kind, String(ref), now);
  return token;
}

/** Turn a link off: it stops working at once. */
export function linkOff(app, userId, kind, ref) {
  return app.run('DELETE FROM share_link WHERE user_id = ? AND kind = ? AND ref = ?', String(userId), kind, String(ref))?.changes || 0;
}

/** What a link points at, for this viewer: { kind, ref, userId }, or a 404 when it no longer works for them. */
export function linkOpen(app, viewerId, token) {
  const gone = () => bad('This link does not work any more. Ask for a new one.', 404, 'not_found');
  if (!TOKEN_RE.test(String(token || ''))) throw gone();
  const row = app.get('SELECT * FROM share_link WHERE token = ?', String(token));
  if (!row) throw gone();
  if (row.user_id !== String(viewerId)) {
    if (suspendedIds(app).has(row.user_id) || isBlocked(app, viewerId, row.user_id)) throw gone();
  }
  return { kind: row.kind, ref: row.ref, userId: row.user_id, mine: row.user_id === String(viewerId) };
}

/** The thing is gone: its link goes with it. */
export function linkForget(app, userId, kind, ref) { linkOff(app, userId, kind, ref); }

