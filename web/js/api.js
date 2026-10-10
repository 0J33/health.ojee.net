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

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body: body ?? {} }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body: body ?? {} }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body: body ?? {} }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
  /** A raw body (the Hevy CSV). */
  upload: (path, raw, type) => request(path, { method: 'POST', raw, type }),
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
