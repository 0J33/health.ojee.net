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
    // An account from before Google and Apple: the app goes to the step that links one (main.js).
    if (data?.code === 'link_required') window.dispatchEvent(new CustomEvent('rep:link-required'));
    throw new ApiError(message, { status: res.status, code: data?.code || '', detail: data?.detail ?? null });
  }
  return data;
}

/* ── what was read, kept ──────────────────────────────────────
   So a screen shows at once, as an app does: a GET answered in the last
   ten minutes is given straight back, and read again behind it when it is
   more than 15 seconds old. If that second answer differs, onFresh() is
   told (main.js: the screens read again, quietly). Anything that changes
   something (POST, PUT, PATCH, DELETE) forgets everything kept, so nothing
   stale is shown after it. Never kept: who you are, AI, live heart rate,
   events, uploads, tiles, searches.

   What was read is also kept on the device (IndexedDB, per account), so the
   app opened again draws every screen from what it showed last, then reads
   again behind it: kept from earlier today only (a "today" from yesterday is
   not shown), at most a day old. Signing out wipes it. */
const KEEP_MS = 10 * 60_000;
const STALE_MS = 15_000;
const SAVED_MS = 24 * 3600_000;
const NEVER = /^\/api\/(me\b|ai\b|live|events|media|tiles|sync|food|exercises\/(pick|last)|admin|link|push)/;
const kept = new Map();      // path → { text, at, saved?: true }
const reading = new Map();   // path → the request in flight
let fresh = null;

const parse = (text) => (text ? JSON.parse(text) : null);
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/* The copy on the device. */
let owner = null;            // whose copy is in use (a user id)
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const r = indexedDB.open('rep-kept', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('gets');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}
const toWrite = new Map();
let writing = 0;
function save(path, text, at) {
  if (!owner || text.length > 600_000) return;
  toWrite.set(path, { text, at });
  clearTimeout(writing);
  writing = setTimeout(flush, 800);
}
async function flush() {
  const d = await db();
  if (!d || !owner || !toWrite.size) { toWrite.clear(); return; }
  const who = owner;
  try {
    const tx = d.transaction('gets', 'readwrite');
    const st = tx.objectStore('gets');
    for (const [path, v] of toWrite) st.put({ ...v, uid: who }, `${who} ${path}`);
    toWrite.clear();
  } catch { toWrite.clear(); }
}

function remember(path, data) {
  kept.delete(path);
  const text = JSON.stringify(data);
  const at = Date.now();
  kept.set(path, { text, at });
  while (kept.size > 80) kept.delete(kept.keys().next().value);
  if (!NEVER.test(path)) save(path, text, at);
}
function read(path, opts) {
  let p = reading.get(path);
  if (!p) {
    p = request(path, opts).then((d) => { remember(path, d); return d; }).finally(() => reading.delete(path));
    reading.set(path, p);
  }
  return p;
}
function usable(hit) {
  if (!hit) return false;
  const age = Date.now() - hit.at;
  if (hit.saved) return age < SAVED_MS && dayOf(hit.at) === dayOf(Date.now());
  return age < KEEP_MS;
}
function get(path, opts = {}) {
  if (opts.fresh || opts.signal || NEVER.test(path)) return request(path, opts);
  const hit = kept.get(path);
  if (usable(hit)) {
    // From the device (an earlier visit), or more than 15 seconds old: read again behind it.
    if ((hit.saved || Date.now() - hit.at > STALE_MS) && !reading.has(path)) {
      const before = hit.text;
      read(path).then((d) => { if (JSON.stringify(d) !== before) fresh?.(path); }).catch(() => { /* offline: what was kept stands */ });
    }
    return Promise.resolve(parse(hit.text));
  }
  return read(path, opts).then((d) => parse(JSON.stringify(d)));
}
const change = (p) => p.finally(() => { kept.clear(); });

/** Whose copy on the device to use (the account signed in): read back into memory, so the first
    screens draw from it. Resolves once it is in (or at once without one). */
async function useAccount(uid) {
  if (!uid) { owner = null; return; }
  if (owner === uid) return;
  owner = uid;
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    try {
      const tx = d.transaction('gets', 'readonly');
      const st = tx.objectStore('gets');
      const range = IDBKeyRange.bound(`${uid} `, `${uid} \uffff`);
      const req = st.openCursor(range);
      const now = Date.now();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(); return; }
        const v = c.value;
        const path = String(c.key).slice(String(uid).length + 1);
        if (v && v.uid === uid && !kept.has(path) && now - v.at < SAVED_MS && dayOf(v.at) === dayOf(now)) kept.set(path, { text: v.text, at: v.at, saved: true });
        c.continue();
      };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}
/** Everything on the device gone (signing out). */
async function wipe() {
  owner = null; toWrite.clear(); clearTimeout(writing);
  const d = await db();
  if (!d) return;
  try { d.transaction('gets', 'readwrite').objectStore('gets').clear(); } catch { /* fine */ }
}

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
  /** Changed on the server: nothing kept in memory is current. `all`: signed out, the device's copy goes too. */
  forget: ({ all = false } = {}) => { kept.clear(); if (all) wipe(); },
  /** The account signed in: its copy on the device is read back in (and kept from now on). */
  useAccount,
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
