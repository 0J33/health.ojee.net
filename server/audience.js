/* ============================================================
   health.ojee.net — who sees what (docs/CIRCLES.md, part 1).

   There are no public or private accounts. Nobody can find a person
   except by typing their username exactly, and a person is shown only
   to their friends and to the people in a circle with them. Each kind
   of data has its own audience:

     circles   friends and everybody in a circle with you
     friends   friends only
     me        nobody else

   `feed` stays a switch: are workouts posted to friends by themselves.

   A lens is one viewer's view of everybody, made once per request:
   their friends and circle-mates, read with two queries.
   ============================================================ */

import { friendIds } from './friends.js';

export const AUDIENCES = ['circles', 'friends', 'me'];
export const KINDS = ['activity', 'workouts', 'sleep', 'heart', 'body'];
export const PRIVACY_DEFAULT = { activity: 'circles', workouts: 'circles', sleep: 'me', heart: 'me', body: 'me', feed: true };

/** One kind's audience from anything stored or sent: the old true / false too. */
export function audienceOf(v, fallback = 'me') {
  if (v === true) return 'circles';
  if (v === false) return 'me';
  return AUDIENCES.includes(v) ? v : fallback;
}

/**
 * Whatever was stored → { activity, workouts, sleep, heart, body, feed }.
 * The old shape: a shared kind becomes 'circles', an unshared one 'me', and
 * a private account keeps everything to itself ('me'), so nothing becomes
 * visible that was not before.
 */
export function normPrivacy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const priv = r.account === 'private';
  const out = {};
  for (const k of KINDS) out[k] = priv ? 'me' : audienceOf(r[k], PRIVACY_DEFAULT[k]);
  out.feed = r.feed !== false;
  return out;
}

/** Does anybody else see this kind at all? */
export const shown = (p, kind) => !!p && p.privacy?.[kind] !== undefined && p.privacy[kind] !== 'me';

/** The user ids of everybody in a circle with this person (members only, not them). */
export function circleMateIds(app, me) {
  const id = String(me);
  return new Set(app.all(`SELECT DISTINCT b.user_id AS u FROM circle_member a JOIN circle_member b ON a.circle_id = b.circle_id
    WHERE a.user_id = ? AND a.status = 'member' AND b.status = 'member' AND b.user_id != ?`, id, id).map((r) => r.u));
}

/**
 * One viewer's view: { id, friends, mates, knows(p), sees(p, kind), listed(p, kind) }.
 *   knows:  may the viewer see this person at all (self, friend, circle-mate)
 *   sees:   may the viewer see this kind of theirs (their own, always)
 *   listed: on a board for this kind (never a kind kept to oneself, one's own included)
 */
export function lensOf(app, viewerId) {
  const id = String(viewerId || '');
  const friends = id ? friendIds(app, id) : new Set();
  const mates = id ? circleMateIds(app, id) : new Set();
  const knows = (p) => !!p && (p.userId === id || friends.has(p.userId) || mates.has(p.userId));
  const sees = (p, kind) => {
    if (!p) return false;
    if (p.userId === id) return true;
    const a = p.privacy?.[kind];
    if (a === 'circles') return friends.has(p.userId) || mates.has(p.userId);
    if (a === 'friends') return friends.has(p.userId);
    return false;
  };
  // On a board: somebody else the viewer may see, or the viewer while they share it with anybody.
  const listed = (p, kind) => !!p && p.privacy?.[kind] !== 'me' && sees(p, kind);
  return { id, friends, mates, knows, sees, listed };
}

/** May everybody in a circle see this kind of this person's (for the circle's kept winners). */
export const circleWide = (p, kind) => p?.privacy?.[kind] === 'circles';
