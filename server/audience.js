/* ============================================================
   health.ojee.net — who sees what (docs/CIRCLES.md, part 1).

   An account is public or private:

     public    as it always was: in the people list and friend
               suggestions, on the Everyone boards, its profile open
               to anybody (signed out too)
     private   found only by typing the username exactly; shown only
               to friends and the people in a circle with it

   Each kind of data has its own audience:

     everyone  anybody who can see the account (a private account's
               'everyone' is its friends and circles)
     circles   friends and everybody in a circle with you
     friends   friends only
     me        nobody else

   `feed` stays a switch: are workouts posted to friends by themselves.

   A lens is one viewer's view of everybody, made once per request:
   their friends and circle-mates, read with two queries.
   ============================================================ */

import { friendIds } from './friends.js';

export const ACCOUNTS = ['public', 'private'];
export const AUDIENCES = ['everyone', 'circles', 'friends', 'me'];
export const KINDS = ['activity', 'workouts', 'sleep', 'heart', 'body'];
export const PRIVACY_DEFAULT = { account: 'public', activity: 'everyone', workouts: 'everyone', sleep: 'me', heart: 'me', body: 'me', feed: true };

/** One kind's audience from anything stored or sent: the old true / false too. */
export function audienceOf(v, fallback = 'me') {
  if (v === true) return 'everyone';
  if (v === false) return 'me';
  return AUDIENCES.includes(v) ? v : fallback;
}

/** Whatever was stored → { account, activity, workouts, sleep, heart, body, feed }. */
export function normPrivacy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { account: r.account === 'private' ? 'private' : 'public' };
  for (const k of KINDS) out[k] = audienceOf(r[k], PRIVACY_DEFAULT[k]);
  out.feed = r.feed !== false;
  // Online and working out now (presence.js): 'auto' until chosen, which is on for a public account.
  out.presence = r.presence === true || r.presence === false ? r.presence : 'auto';
  return out;
}

/** Does this person show others when they are online or working out? */
export const presenceOn = (p) => !!p && (p.privacy?.presence === 'auto' || p.privacy?.presence === undefined ? isPublic(p) : p.privacy.presence === true);

export const isPublic = (p) => !!p && p.privacy?.account !== 'private';
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
 *   knows:  may the viewer see this person at all (self, public, friend, circle-mate)
 *   sees:   may the viewer see this kind of theirs (their own, always)
 *   listed: on a board for this kind (never a kind kept to oneself, one's own included)
 */
export function lensOf(app, viewerId) {
  const id = String(viewerId || '');
  const friends = id ? friendIds(app, id) : new Set();
  const mates = id ? circleMateIds(app, id) : new Set();
  const close = (p) => friends.has(p.userId) || mates.has(p.userId);
  const knows = (p) => !!p && (p.userId === id || isPublic(p) || close(p));
  const sees = (p, kind) => {
    if (!p) return false;
    if (id && p.userId === id) return true;
    const a = p.privacy?.[kind];
    if (a === 'everyone') return isPublic(p) || close(p);
    if (a === 'circles') return close(p);
    if (a === 'friends') return friends.has(p.userId);
    return false;
  };
  const listed = (p, kind) => !!p && p.privacy?.[kind] !== 'me' && sees(p, kind);
  return { id, friends, mates, knows, sees, listed };
}

/** May everybody in a circle see this kind of this person's (for the circle's kept winners). */
export const circleWide = (p, kind) => p?.privacy?.[kind] === 'circles' || p?.privacy?.[kind] === 'everyone';
