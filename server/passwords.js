/* ============================================================
   health.ojee.net — getting back in without email (docs/CIRCLES.md,
   part 3).

   An account is a username and a password, shared with mtg and dnd,
   and nothing else: there is no address to send a link to. So:

     recovery code   made by the person (with their password), shown
                     once, kept by them. It sets a new password from the
                     sign-in page, and is then used up: a new one is
                     made and shown in its place.
     reset link      made by an admin for a username, good for 24 hours
                     and once, sent by the admin however they talk to
                     the person.

   Only hashes are stored: sha-256 of the code (16 random characters,
   80 bits, so a fast hash is enough) and of the link's token.
   ============================================================ */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I
export const LINK_MS = 24 * 3_600_000;
const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** A code as typed: upper case, without spaces or dashes. */
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A new code, like K7QF-2MPD-9XWA-H4TC. */
export function makeCode() {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i += 1) s += ALPHABET[b[i] % ALPHABET.length];
  return s.match(/.{4}/g).join('-');
}

/** Make (or replace) a person's recovery code. @returns the code, the only time it is seen. */
export function newRecovery(app, userId, now = Date.now()) {
  const code = makeCode();
  app.run('INSERT INTO recovery (user_id, hash, created_ms) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, created_ms = excluded.created_ms', String(userId), sha(norm(code)), now);
  return code;
}
/** When the person's code was made, or null for none. */
export const recoveryAt = (app, userId) => app.get('SELECT created_ms FROM recovery WHERE user_id = ?', String(userId))?.created_ms ?? null;

/** Is this the person's code? Compared in constant time. */
export function checkRecovery(app, userId, code) {
  const r = app.get('SELECT hash FROM recovery WHERE user_id = ?', String(userId));
  if (!r || norm(code).length !== 16) return false;
  const a = Buffer.from(r.hash, 'hex'); const b = Buffer.from(sha(norm(code)), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** An admin's one-time link for a person: the token (only now), and when it stops working. */
export function newResetLink(app, { userId, username, byId, now = Date.now() }) {
  const token = randomBytes(24).toString('base64url');
  // One live link per person: a new one replaces any that was not used.
  app.run('DELETE FROM pw_reset WHERE user_id = ? AND used_ms IS NULL', String(userId));
  app.run('INSERT INTO pw_reset (token_hash, user_id, username, by_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?)', sha(token), String(userId), username, byId ? String(byId) : null, now, now + LINK_MS);
  return { token, expiresAt: now + LINK_MS };
}

/** The link a token names, if it may still be used: { userId, username, expiresAt } or null. */
export function resetLink(app, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 80) return null;
  const r = app.get('SELECT * FROM pw_reset WHERE token_hash = ?', sha(token));
  if (!r || r.used_ms || r.expires_ms < now) return null;
  return { userId: r.user_id, username: r.username, expiresAt: r.expires_ms };
}
export const useResetLink = (app, token, now = Date.now()) => app.run('UPDATE pw_reset SET used_ms = ? WHERE token_hash = ?', now, sha(token));

/** The links an admin made that are still open, newest first (no tokens: those were shown once). */
export const openLinks = (app, now = Date.now()) => app.all('SELECT username, created_ms, expires_ms FROM pw_reset WHERE used_ms IS NULL AND expires_ms > ? ORDER BY created_ms DESC', now)
  .map((r) => ({ username: r.username, createdAt: r.created_ms, expiresAt: r.expires_ms }));

export { bad as passwordError };
