/* ============================================================
   health.ojee.net — signing in with Google or Apple.

   The provider is how a person proves who they are; the account is
   still the ojee.net one (accounts.js), with the username they chose.

     identity    (app.sqlite) provider + sub → user_id, and the email the
                 provider gave (Apple's may be a private relay address).
                 One per provider per account; never one sub on two accounts.

   Google: authorization code + PKCE on the same OAuth client as Google
   Health, asking only `openid email profile`. Apple: an identity token,
   from the iPhone app's own sheet, or from Apple's web page (form_post).
   Both ID tokens are checked here against the provider's published keys
   (JWKS, cached): signature, issuer, audience, expiry, and our nonce.

   Inside the apps Google will not sign in, so the browser does it: the
   app asks for a ticket (bound to a random secret only the app holds),
   opens the system browser at the start address, and polls until the
   browser side is done; the poll hands over the session cookie.

   Everything in flight (attempts, tickets, nonces, sign-ups waiting for a
   username) is in memory for ten minutes and used once.
   ============================================================ */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as rsaVerify } from 'node:crypto';

export const PROVIDERS = ['google', 'apple'];
export const PROVIDER_NAME = { google: 'Google', apple: 'Apple' };
/** Where the providers live. Overridable so the tests and the demo stand fakes in. */
export const SIGNIN_URLS = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  googleJwks: 'https://www.googleapis.com/oauth2/v3/certs',
  appleAuth: 'https://appleid.apple.com/auth/authorize',
  appleJwks: 'https://appleid.apple.com/auth/keys',
};
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const GOOGLE_SCOPES = 'openid email profile';
export const FLOW_MS = 10 * 60_000;

const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
export const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (n = 24) => randomBytes(n).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/* ── keys and tokens ───────────────────────────────────────────── */

/** A provider's published signing keys, kept for six hours; read again early for a key id not seen yet (at most once a minute). */
export class Jwks {
  constructor({ url, fetchImpl = fetch, now = () => Date.now(), ttlMs = 6 * 3_600_000 }) {
    Object.assign(this, { url, fetchImpl, now, ttlMs });
    this.keys = null; this.at = 0; this.loading = null;
  }
  async key(kid) {
    const t = this.now();
    if (!this.keys || t - this.at > this.ttlMs || (!this.keys.has(kid) && t - this.at > 60_000)) await this.load();
    return this.keys.get(kid) || null;
  }
  load() {
    if (!this.loading) {
      this.loading = (async () => {
        let j;
        try {
          const r = await this.fetchImpl(this.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          j = await r.json();
        } catch (e) { throw bad(`The sign-in keys could not be read (${e.message}). Try again.`, 502, 'upstream'); }
        const keys = new Map();
        for (const k of Array.isArray(j?.keys) ? j.keys : []) {
          if (k.kty !== 'RSA' || !k.kid) continue;
          try { keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' })); } catch { /* a key we cannot use */ }
        }
        this.keys = keys; this.at = this.now();
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }
}

/**
 * Check an ID token: RS256 by one of the provider's keys, from `iss`, for
 * `aud`, not expired, and carrying `nonce` when one is given. The claims, or a 401.
 */
export async function verifyIdToken(jwt, { jwks, iss, aud, nonce, now = Date.now(), leewayS = 60 }) {
  const no = (why) => bad(`That sign-in could not be checked: ${why}.`, 401, 'bad_token');
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw no('it is not a token');
  let head; let claims;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw no('it is not a token'); }
  if (head.alg !== 'RS256') throw no('an unexpected signature');
  const key = await jwks.key(head.kid);
  if (!key) throw no('an unknown key');
  if (!rsaVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw no('the signature is wrong');
  if (!(Array.isArray(iss) ? iss : [iss]).includes(claims.iss)) throw no('the wrong issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw no('it is for another app');
  const t = now / 1000;
  if (!(Number(claims.exp) > t - leewayS)) throw no('it has expired');
  if (Number(claims.iat) > t + 600) throw no('it is from the future');
  if (nonce !== undefined && !(typeof claims.nonce === 'string' && same(claims.nonce, nonce))) throw no('the nonce does not match');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw no('it names nobody');
  return claims;
}

/* ── identities (app.sqlite) ───────────────────────────────────── */

const cleanEmail = (e) => (typeof e === 'string' && e.length <= 320 && e.includes('@') ? e : null);

/** The sign-in methods of an account, oldest first: { provider, email, linkedAt }. */
export const identitiesOf = (app, userId) => app.all('SELECT provider, email, created_ms FROM identity WHERE user_id = ? ORDER BY created_ms, provider', String(userId))
  .map((r) => ({ provider: r.provider, email: r.email || null, linkedAt: r.created_ms }));
export const hasIdentity = (app, userId) => !!app.get('SELECT 1 AS x FROM identity WHERE user_id = ? LIMIT 1', String(userId));
/** Whose account a provider's sub is, or null. */
export const identityOwner = (app, provider, sub) => app.get('SELECT user_id FROM identity WHERE provider = ? AND sub = ?', provider, String(sub))?.user_id ?? null;
/** The email the account signed in with at Google: Connect Google Health suggests it. */
export const googleEmailOf = (app, userId) => app.get("SELECT email FROM identity WHERE user_id = ? AND provider = 'google'", String(userId))?.email || null;

/**
 * Tie a provider's identity to an account. Refused when it is another
 * account's, or when the account already has a different one at that
 * provider. @returns 'linked' | 'already'
 */
export function linkIdentity(app, { provider, sub, userId, email = null, now = Date.now() }) {
  if (!PROVIDERS.includes(provider)) throw bad('Unknown sign-in method.');
  const name = PROVIDER_NAME[provider];
  return app.tx(() => {
    const owner = identityOwner(app, provider, sub);
    if (owner && owner !== String(userId)) throw bad(`This ${name} account is already used to sign in to another rep. account.`, 409, 'identity_taken');
    if (owner) { app.run('UPDATE identity SET email = COALESCE(?, email) WHERE provider = ? AND sub = ?', cleanEmail(email), provider, String(sub)); return 'already'; }
    if (app.get('SELECT 1 AS x FROM identity WHERE user_id = ? AND provider = ?', String(userId), provider)) throw bad(`This account already signs in with another ${name} account. Unlink that one first.`, 409, 'provider_linked');
    app.run('INSERT INTO identity (provider, sub, user_id, email, created_ms) VALUES (?, ?, ?, ?, ?)', provider, String(sub), String(userId), cleanEmail(email), now);
    return 'linked';
  });
}

/** Remove one provider from an account: only while another stays. */
export function unlinkIdentity(app, userId, provider) {
  if (!PROVIDERS.includes(provider)) throw bad('Unknown sign-in method.');
  return app.tx(() => {
    const all = identitiesOf(app, userId);
    if (!all.some((i) => i.provider === provider)) throw bad(`${PROVIDER_NAME[provider]} is not linked to this account.`, 404, 'not_found');
    if (all.length < 2) throw bad('This is your only way to sign in. Link the other one first.', 409, 'last_method');
    app.run('DELETE FROM identity WHERE user_id = ? AND provider = ?', String(userId), provider);
    return identitiesOf(app, userId);
  });
}

/* ── what is in flight ─────────────────────────────────────────── */

/** Attempts at a provider, app tickets, Apple nonces and sign-ups waiting for a username: ten minutes each, once. */
export class Flows {
  constructor(now = () => Date.now()) { this.now = now; this.maps = { state: new Map(), ticket: new Map(), nonce: new Map(), pending: new Map() }; }
  #sweep() { const t = this.now(); for (const m of Object.values(this.maps)) for (const [k, v] of m) if (t - v.at > FLOW_MS) m.delete(k); }
  put(kind, value, key = randomToken()) {
    this.#sweep();
    if (this.maps[kind].size > 5000) throw bad('Too many sign-ins at once. Try again in a moment.', 429, 'rate_limited');
    this.maps[kind].set(key, { ...value, at: this.now() });
    return key;
  }
  /** The live entry, left in place. */
  peek(kind, key) { const v = typeof key === 'string' ? this.maps[kind].get(key) : null; return v && this.now() - v.at <= FLOW_MS ? v : null; }
  /** The live entry, used up. */
  take(kind, key) { const v = this.peek(kind, key); if (typeof key === 'string') this.maps[kind].delete(key); return v; }
  drop(kind, key) { this.maps[kind].delete(key); }
}

/** The Google consent page for one attempt: only who you are, nothing of your health. */
export function googleAuthUrl({ urls, clientId, redirectUri, state, challenge, nonce }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES,
    code_challenge: challenge, code_challenge_method: 'S256', state, nonce, prompt: 'select_account',
  });
  return `${urls.googleAuth}?${q}`;
}

/** Apple's own page (no script of theirs here): it posts the answer back to the callback. */
export function appleAuthUrl({ urls, servicesId, redirectUri, state, nonceHash }) {
  const q = new URLSearchParams({
    client_id: servicesId, redirect_uri: redirectUri, response_type: 'code id_token', scope: 'name email',
    response_mode: 'form_post', state, nonce: nonceHash,
  });
  return `${urls.appleAuth}?${q.toString().replace(/\+/g, '%20')}`;
}

/** Trade Google's code for its tokens; the ID token is checked by the caller. */
export async function googleExchange({ urls, fetchImpl, clientId, clientSecret, redirectUri, code, verifier }) {
  let r;
  try {
    r = await fetchImpl(urls.googleToken, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }),
    });
  } catch (e) { throw bad(`Google could not be reached (${e.cause?.code || e.message}). Try again.`, 502, 'upstream'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) throw bad(`Google said: ${String(j.error_description || j.error || `HTTP ${r.status}`).slice(0, 120)}`, 502, 'upstream');
  return j;
}

/** Apple's name, sent once, on the first sign-in only. */
export function appleName(user) {
  try {
    const u = typeof user === 'string' ? JSON.parse(user) : user;
    const n = [u?.name?.firstName, u?.name?.lastName].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    return n ? n.slice(0, 40) : null;
  } catch { return null; }
}
