/* The one place that talks to the server. Same origin, cookie auth, JSON in
   and out; a failed call throws an ApiError carrying the server's own
   sentence (docs/API.md → Errors), which is fit to show as it is. */

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', detail = null, offline = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.offline = offline;
  }
}

async function request(path, { method = 'GET', body, raw, type, signal } = {}) {
  const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' }, signal };
  if (raw !== undefined) {
    init.body = raw;
    init.headers['content-type'] = type || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server. Check your connection and try again.', { offline: true });
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after')) || data?.detail?.retryAfter || null;
    let message = data?.error || (res.status >= 500 ? 'The server had a problem. Try again in a moment.' : 'That request did not work.');
    if (res.status === 429 && retry && !/\d/.test(message)) message = `${message.replace(/\.$/, '')}. Try again in ${retry < 90 ? `${Math.ceil(retry)} seconds` : `${Math.ceil(retry / 60)} minutes`}.`;
    throw new ApiError(message, { status: res.status, code: data?.code || '', detail: data?.detail ?? null });
  }
  return data;
}

/* ── what was read, kept ──────────────────────────────────────
   So a screen shows at once, as an app does: a GET answered in the last
   ten minutes is given straight back, and read again behind it when it is
   more than 15 seconds old. If that second answer differs, onFresh() is
   told (main.js: the screen reads again, quietly). Anything that changes
   something (POST, PUT, PATCH, DELETE) forgets everything kept, so nothing
   stale is shown after it. Never kept: who you are, AI, live heart rate,
   events, uploads, tiles, searches. */
const KEEP_MS = 10 * 60_000;
const STALE_MS = 15_000;
const NEVER = /^\/api\/(me\b|ai\b|live|events|media|tiles|sync|food|exercises\/(pick|last)|admin|link|push)/;
const kept = new Map();      // path → { text, at }
const reading = new Map();   // path → the request in flight
let fresh = null;

const parse = (text) => (text ? JSON.parse(text) : null);
function remember(path, data) {
  kept.delete(path);
  kept.set(path, { text: JSON.stringify(data), at: Date.now() });
  while (kept.size > 80) kept.delete(kept.keys().next().value);
}
function read(path, opts) {
  let p = reading.get(path);
  if (!p) {
    p = request(path, opts).then((d) => { remember(path, d); return d; }).finally(() => reading.delete(path));
    reading.set(path, p);
  }
  return p;
}
function get(path, opts = {}) {
  if (opts.fresh || opts.signal || NEVER.test(path)) return request(path, opts);
  const hit = kept.get(path);
  if (hit && Date.now() - hit.at < KEEP_MS) {
    if (Date.now() - hit.at > STALE_MS && !reading.has(path)) {
      const before = hit.text;
      read(path).then((d) => { if (JSON.stringify(d) !== before) fresh?.(path); }).catch(() => { /* offline: what was kept stands */ });
    }
    return Promise.resolve(parse(hit.text));
  }
  return read(path, opts).then((d) => parse(JSON.stringify(d)));
}
const change = (p) => p.finally(() => { kept.clear(); });

export const api = {
  get,
  post: (path, body, opts) => change(request(path, { ...opts, method: 'POST', body: body ?? {} })),
  put: (path, body, opts) => change(request(path, { ...opts, method: 'PUT', body: body ?? {} })),
  patch: (path, body, opts) => change(request(path, { ...opts, method: 'PATCH', body: body ?? {} })),
  del: (path, opts) => change(request(path, { ...opts, method: 'DELETE' })),
  /** A raw body (the Hevy CSV). */
  upload: (path, raw, type) => change(request(path, { method: 'POST', raw, type })),
  /** Read ahead, quietly, so the screen that needs it later shows at once. */
  warm: (path) => { if (!kept.has(path) && !NEVER.test(path)) read(path).catch(() => {}); },
  /** Told when something kept turned out to have changed. */
  onFresh: (fn) => { fresh = fn; },
  /** Signed out, or another person: nothing of the last one is kept. */
  forget: () => { kept.clear(); },
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
