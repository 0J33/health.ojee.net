/* ============================================================
   health.ojee.net — personal API keys: the person's own data, from
   their own scripts, apps and AI assistants (docs/DEVELOPERS.md).

   A key is `hak_` and 43 characters, shown once; only its SHA-256 is
   kept. It stands for the person on the same API the site uses
   (`Authorization: Bearer hak_...`), and on the MCP server (/mcp).

   Two scopes:
     read   GET of the person's data: everything the site shows them.
     write  read, and logging: entries (water, food, mood...), weigh-ins,
            workouts and routines, pins, a sync.
   Never, with any key: the account (password, deletion), keys of any
   kind, connections to other services, push, admin, the AI chat,
   posting or anything social that others would see.
   ============================================================ */

import { randomBytes } from 'node:crypto';
import { sha256, shortId } from './secrets.js';

export const SCOPES = ['read', 'write', 'widget'];
export const MAX_KEYS = 10;
export const KEY_RE = /^hak_[A-Za-z0-9_-]{43}$/;
const str = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));

/** The person's keys, never the secret. */
export function listKeys(app, userId) {
  return app.all('SELECT * FROM api_key WHERE user_id = ? ORDER BY created_ms', String(userId))
    .map((r) => ({ id: r.id, label: r.label, scope: r.scope, last4: r.last4, createdAt: r.created_ms, lastUsedAt: r.last_seen_ms, uses: r.uses }));
}

/** Make a key: the plain key is returned this once. */
export function createKey(app, userId, { label, scope } = {}, now = Date.now()) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error('scope must be "read" or "write".'), { status: 400, code: 'bad_request' });
  const name = str(typeof label === 'string' ? label.trim() : '', 60);
  if (!name) throw Object.assign(new Error('Give the key a name, such as the app it is for.'), { status: 400, code: 'bad_request' });
  if (listKeys(app, userId).length >= MAX_KEYS) throw Object.assign(new Error(`You already have ${MAX_KEYS} API keys. Remove one first.`), { status: 409, code: 'conflict' });
  const key = `hak_${randomBytes(32).toString('base64url')}`;
  const id = shortId('ak');
  app.run('INSERT INTO api_key (id, user_id, hash, last4, label, scope, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', id, String(userId), sha256(key), key.slice(-4), name, scope, now);
  return { id, key };
}

export function deleteKey(app, userId, id) { return app.run('DELETE FROM api_key WHERE id = ? AND user_id = ?', String(id), String(userId)).changes > 0; }

/** The key a bearer token is, or null. Its use is counted, the time kept at most once a minute. */
export function keyFor(app, bearer, now = Date.now()) {
  if (typeof bearer !== 'string' || !KEY_RE.test(bearer)) return null;
  const r = app.get('SELECT * FROM api_key WHERE hash = ?', sha256(bearer));
  if (!r) return null;
  if (!r.last_seen_ms || now - r.last_seen_ms >= 60_000) app.run('UPDATE api_key SET last_seen_ms = ?, uses = uses + 1 WHERE id = ?', now, r.id);
  else app.run('UPDATE api_key SET uses = uses + 1 WHERE id = ?', r.id);
  return { id: r.id, userId: r.user_id, scope: r.scope, label: r.label };
}

/* ── what a key may do ─────────────────────────────────────────────── */

// Never with a key, read or write.
const NEVER = [/^\/api\/admin(\/|$)/, /^\/api\/account(\/|$)/, /^\/api\/keys(\/|$)/, /^\/api\/link(\/|$)/, /^\/api\/push(\/|$)/,
  /^\/api\/ai(\/|$)/, /^\/api\/events$/, /^\/api\/live\/(claim|hr|relay)$/, /^\/api\/presence$/];
// Writes a write key may make: the person's own records, nothing others see, no connections.
const WRITES = [
  ['POST', /^\/api\/entries$/], ['PATCH', /^\/api\/entries\/[A-Za-z0-9_-]{1,80}$/], ['DELETE', /^\/api\/entries\/[A-Za-z0-9_-]{1,80}$/],
  ['POST', /^\/api\/weight$/],
  ['POST', /^\/api\/pins$/], ['PUT', /^\/api\/shown$/],
  ['POST', /^\/api\/sync$/],
  ['POST', /^\/api\/workouts\/log$/], ['POST', /^\/api\/workouts\/import\/gpx$/],
  ['PATCH', /^\/api\/workouts\/[A-Za-z0-9_-]{1,120}$/], ['DELETE', /^\/api\/workouts\/[A-Za-z0-9_-]{1,120}$/],
  ['PUT', /^\/api\/workouts\/[A-Za-z0-9_-]{1,120}\/sets$/],
  ['POST', /^\/api\/routines(\/[A-Za-z0-9_/-]{1,120})?$/], ['PATCH', /^\/api\/routines(\/[A-Za-z0-9_/-]{1,120})?$/], ['DELETE', /^\/api\/routines\/[A-Za-z0-9_-]{1,120}$/],
];

/** Whether a key of `scope` may make this request: null when it may, else why not. */
export function refusal(scope, method, path) {
  if (scope === 'widget') return method === 'GET' && path === '/api/widget' ? null : 'A widget key only reads the widget.';
  if (!path.startsWith('/api/')) return 'An API key works on /api/ and /mcp only.';
  if (NEVER.some((re) => re.test(path))) return 'An API key cannot be used for this. Do it on the site.';
  if (method === 'GET' || method === 'HEAD') return null;
  if (scope !== 'write') return 'This key can only read. Make a key with write access to log things.';
  if (WRITES.some(([m, re]) => m === method && re.test(path))) return null;
  return 'An API key cannot change this. Do it on the site.';
}
