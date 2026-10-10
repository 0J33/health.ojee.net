/* ============================================================
   health.ojee.net — who writes the summary's prose, when the person
   has no key of their own: the same writer the console's health
   module uses (ojee-health src/writer.js), talking to an
   `opencode serve` on this box's loopback.

   Why a server and not a plain HTTP call: OpenCode refuses its free
   tier to anything that is not OpenCode itself ("OpenCode's free tier
   can only be used from within OpenCode", HTTP 403). Its own server
   may use them, with no account and no key.

   One throwaway session per summary, deleted afterwards whatever
   happened. What the Assistant learned the hard way, and this keeps:
     - a model that refuses (quota, rate limit, the free tier saying
       no) shows up as a session stuck in `retry`, or as a turn that
       ends with nothing in it. Both mean: abort, ask the next model.
     - permissions are per directory, so every call names one.
     - a permission rule that DENIES a tool makes the free tier refuse
       the request, so tools are set to `ask` (and a model that asks
       anyway is treated as a refusal).

   Different here: only free models, the zero-retention ones first,
   and never one that logs or trains on what it is sent (BLOCKED).
   Nothing is sent but the prompt: the computed stats and the notes.
   ============================================================ */

import { parseAnswer } from './insight.js';

/**
 * A failed turn: is it this model refusing (another may answer), or would
 * every model fail it? The same rules as the Assistant's (ojee-agent
 * src/assistant-logic.js isRefusal), copied so this module stays
 * dependency-free: no error at all means the "200 with an empty message"
 * refusal, quota / rate limit / upstream / free-tier words mean refused.
 */
export function isRefusal(error) {
  if (!error) return true;
  const name = error.name || '';
  if (['MessageAbortedError', 'ContextOverflowError', 'MessageOutputLengthError', 'ContentFilterError', 'StructuredOutputError'].includes(name)) return false;
  if (name === 'ProviderAuthError') return true;
  const status = error.data?.statusCode;
  if (status === 429 || status === 402 || status === 403 || (status >= 500 && status < 600)) return true;
  const t = JSON.stringify(error).toLowerCase();
  return /rate.?limit|quota|capacity|out of|exceeded|too many|temporarily unavailable|no available|credit|global regions|upstream|region not|free tier|model not found|modelnotfound|overloaded|unavailable|timeout|timed out|insufficient|usage limit/.test(t);
}

/** Quota / limit words, for saying WHY there was no AI. */
const QUOTA_RE = /quota|usage limit|rate.?limit|too many|credit|insufficient|exceeded|402|429/i;

/** One line for the page: why the summary was written without AI. */
export function reasonFor(err) {
  const tried = err?.tried || [];
  if (err?.code === 'unconfigured') return 'OpenCode is not configured here';
  if (err?.code === 'unreachable') return 'OpenCode server unreachable';
  if (err?.code === 'no-model') return 'OpenCode offers no usable model';
  if (tried.length && tried.every((t) => t.kind === 'quota')) return 'OpenCode quota reached on every model';
  if (tried.some((t) => t.kind === 'unreachable')) return 'OpenCode server unreachable';
  if (tried.some((t) => t.kind === 'quota')) return 'OpenCode quota reached, and the other models refused';
  return 'every OpenCode model refused or failed';
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Tried in this order when the server has them, before the rest. */
export const PREFERRED = [
  'opencode/space-bunny-free',
  'opencode/longcat-2.5-preview-free',
  'opencode/step-5-preview-free',
  'opencode/big-pickle',
  'opencode/mimo-v2.6-flash-free',
];

/** Described by OpenCode as logged or used for training: never sent health data. */
export const BLOCKED = /(^|\/)(nemotron|muse)-/i;

export class Writer {
  constructor({
    url = '',
    dir = '/tmp',
    models = '',
    providers = 'opencode',
    fetchImpl = fetch,
    attempts = 4,
    turnMs = 120_000,
    pollMs = 1500,
    log = () => {},
  } = {}) {
    this.url = String(url).replace(/\/+$/, '');
    this.dir = dir;
    this.pinned = String(models).split(',').map((s) => s.trim()).filter(Boolean);
    this.providers = String(providers).split(',').map((s) => s.trim()).filter(Boolean);
    this.fetch = fetchImpl;
    this.attempts = attempts;
    this.turnMs = turnMs;
    this.pollMs = pollMs;
    this.log = log;
    this.catalog = { at: 0, keys: null };
  }

  configured() { return !!this.url; }

  async #call(path, { method = 'GET', body, timeout = 20_000 } = {}) {
    const u = new URL(`${this.url}${path}`);
    u.searchParams.set('directory', this.dir);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await this.fetch(u, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
    } finally {
      clearTimeout(t);
    }
  }

  /** provider/model keys the server offers, cached ten minutes. */
  async models() {
    if (this.catalog.keys && Date.now() - this.catalog.at < 600_000) return this.catalog.keys;
    const out = await this.#call('/provider', { timeout: 15_000 });
    if (!out.ok || !Array.isArray(out.data?.all)) {
      throw Object.assign(new Error(out.error ? `OpenCode unreachable (${out.error})` : `OpenCode answered HTTP ${out.status}`), { code: 'unreachable' });
    }
    const keys = [];
    for (const p of out.data.all) {
      if (!this.providers.includes(p.id)) continue;
      for (const m of Object.values(p.models || {})) {
        if (m.status === 'deprecated') continue;
        const key = `${p.id}/${m.id || m.modelID}`;
        if (!BLOCKED.test(key)) keys.push(key);
      }
    }
    this.catalog = { at: Date.now(), keys };
    return keys;
  }

  /** The models to try, best first. A bare id in the pinned list is matched against every provider. */
  async candidates() {
    const have = await this.models();
    const pick = (want) => (want.includes('/') ? have.find((k) => k === want) : have.find((k) => k.endsWith(`/${want}`)));
    // Only models that cost nothing: this server holds no account.
    const free = have.filter((k) => k.startsWith('opencode/') && (/-free$/.test(k) || k === 'opencode/big-pickle'));
    const order = [...this.pinned.map(pick), ...PREFERRED.map(pick), ...free].filter(Boolean);
    return [...new Set(order)].slice(0, this.attempts);
  }

  /**
   * Ask for the summary. Resolves { summary, model, tried } or throws with
   * `.tried` listing what each model did.
   */
  async write(promptText) {
    if (!this.configured()) throw Object.assign(new Error('OPENCODE_URL is not set'), { code: 'unconfigured', tried: [] });
    const list = await this.candidates();
    if (!list.length) throw Object.assign(new Error('OpenCode offers no usable model'), { code: 'no-model', tried: [] });
    const tried = [];
    for (const key of list) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.#once(key, promptText);
      tried.push({ model: key, ok: !!r.summary, why: r.why || null, kind: r.summary ? 'ok' : (r.kind || (QUOTA_RE.test(r.why || '') ? 'quota' : 'refused')) });
      if (r.summary) return { summary: r.summary, model: key, tried };
      this.log(`summary: ${key} — ${r.why}`);
    }
    throw Object.assign(new Error(`every model failed (${tried.map((t) => `${t.model}: ${t.why}`).join('; ')})`), { code: 'all-failed', tried });
  }

  async #once(key, promptText) {
    const [providerID, ...rest] = key.split('/');
    const modelID = rest.join('/');
    const made = await this.#call('/session', {
      method: 'POST',
      body: {
        title: 'Health summary (temporary, deleted when done)',
        permission: ['bash', 'edit', 'write', 'apply_patch', 'webfetch', 'websearch']
          .map((permission) => ({ permission, pattern: '*', action: 'ask' })),
      },
    });
    if (!made.ok || !made.data?.id) return { kind: made.error ? 'unreachable' : 'error', why: made.error ? `unreachable (${made.error})` : `could not open a session (HTTP ${made.status})` };
    const id = encodeURIComponent(made.data.id);
    try {
      const sent = await this.#call(`/session/${id}/prompt_async`, {
        method: 'POST', timeout: 30_000,
        body: { model: { providerID, modelID }, parts: [{ type: 'text', text: promptText }] },
      });
      if (!sent.ok) return { why: `send failed (HTTP ${sent.status || sent.error})` };
      const started = Date.now();
      let seenBusy = false;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(this.pollMs);
        // eslint-disable-next-line no-await-in-loop
        const st = await this.#call('/session/status', { timeout: 10_000 });
        const mine = st.ok && st.data ? st.data[made.data.id] : undefined;
        // opencode retrying on its own = the provider said no (quota, rate limit).
        if (mine?.type === 'retry') return { kind: QUOTA_RE.test(mine.message || '') ? 'quota' : 'refused', why: `refused: ${String(mine.message || 'retrying').slice(0, 120)}` };
        if (mine && mine.type !== 'idle') seenBusy = true;
        // eslint-disable-next-line no-await-in-loop
        const perm = await this.#call('/permission', { timeout: 10_000 });
        if (perm.ok && Array.isArray(perm.data) && perm.data.some((p) => p.sessionID === made.data.id)) return { kind: 'refused', why: 'tried to use a tool' };
        const settled = !mine || mine.type === 'idle';
        if (settled && (seenBusy || Date.now() - started > 4000)) break;
        if (Date.now() - started > this.turnMs) return { kind: 'refused', why: 'timed out' };
      }
      const msgs = await this.#call(`/session/${id}/message`, { timeout: 20_000 });
      const reply = (Array.isArray(msgs.data) ? msgs.data : []).filter((m) => m.info?.role === 'assistant').pop();
      if (!reply) return { kind: 'refused', why: 'no reply (model not available?)' };
      const text = (reply.parts || []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim();
      const err = reply.info?.error || null;
      if (err || !text) {
        // An error, or the "200 with an empty message": a failure either way —
        // never an empty summary. isRefusal() says whether it was the model
        // turning the request away (quota and the like) or a hard error.
        const msg = err ? String(err.data?.message || err.name || 'unknown').slice(0, 160) : 'empty reply';
        return { kind: QUOTA_RE.test(JSON.stringify(err || '')) ? 'quota' : isRefusal(err) ? 'refused' : 'error', why: err ? `error: ${msg}` : msg };
      }
      const summary = parseAnswer(text);
      if (!summary) return { kind: 'invalid', why: 'reply was not the JSON asked for' };
      return { summary };
    } finally {
      // Always gone afterwards, whatever happened above.
      await this.#call(`/session/${id}/abort`, { method: 'POST', timeout: 10_000 });
      await this.#call(`/session/${id}`, { method: 'DELETE', timeout: 10_000 });
    }
  }
}
