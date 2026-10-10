/* ============================================================
   health.ojee.net — who writes the summary's prose: OpenCode Zen,
   with the person's OWN key.

   One HTTPS call per attempt to the OpenAI-compatible endpoint
   (POST …/zen/v1/chat/completions, Authorization: Bearer <key>).
   Free models are tried in order, the zero-retention ones first. A
   model that refuses (quota, rate limit, an empty reply, a reply
   that is not the JSON asked for) is skipped for the next; a
   rejected key stops the run, because no model will accept it.

   Two things are never done:
     - health data is never sent to a model whose terms say prompts
       are logged or used for training (BLOCKED), even if somebody
       puts one in ZEN_MODELS;
     - the key is never logged, never put in an error, never returned.

   Only the computed statistics and the person's own notes go in the
   prompt (insight.js), never raw samples.
   ============================================================ */

import { parseAnswer } from './core/insight.js';

/** Families that log or train on prompts. Never sent anything. */
export const BLOCKED = /^(nemotron|muse)-/i;
export const allowedModels = (list) => [...new Set(list.map((m) => String(m).trim()).filter((m) => m && !BLOCKED.test(m)))];

const QUOTA_RE = /quota|usage limit|rate.?limit|too many|credit|insufficient|exceeded|capacity|overloaded/i;

/** One line for the page: why the summary was written without AI. */
export function reasonFor(err) {
  const tried = err?.tried || [];
  if (err?.code === 'no-key') return 'No OpenCode key saved';
  if (err?.code === 'bad-key') return 'OpenCode rejected the key';
  if (err?.code === 'no-model') return 'No usable free model is configured';
  if (tried.length && tried.every((t) => t.kind === 'unreachable')) return 'OpenCode could not be reached';
  if (tried.length && tried.every((t) => t.kind === 'quota')) return 'The free models are at their limit right now';
  return 'Every free model refused or failed';
}

export class Zen {
  constructor({ url, models, timeoutMs = 45_000, fetchImpl = fetch, log = () => {} }) {
    this.url = url;
    this.models = allowedModels(models || []);
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.log = log;
  }

  /** One model, one prompt. { text } or { kind, why }. */
  async #ask(key, model, content, { maxTokens = 1800 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.4, max_tokens: maxTokens, stream: false }),
        signal: ac.signal,
      });
      const text = await res.text();
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch { j = null; }
      if (res.status === 401 || res.status === 403) return { kind: 'bad-key', why: `HTTP ${res.status}` };
      if (!res.ok) {
        const msg = String(j?.error?.message || j?.error || j?.message || '').slice(0, 120);
        const quota = res.status === 429 || res.status === 402 || QUOTA_RE.test(msg);
        // The message is OpenCode's own words about the model; it never
        // contains the key (which only ever travels in the header).
        return { kind: quota ? 'quota' : 'refused', why: `HTTP ${res.status}${msg ? `: ${msg}` : ''}` };
      }
      const out = j?.choices?.[0]?.message?.content;
      const said = typeof out === 'string' ? out : Array.isArray(out) ? out.map((p) => p?.text || '').join('') : '';
      if (!said.trim()) return { kind: 'refused', why: 'empty reply' };
      return { text: said };
    } catch (e) {
      return { kind: 'unreachable', why: e.name === 'AbortError' ? 'timed out' : `unreachable (${e.cause?.code || e.code || 'network error'})` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask for the summary. Resolves { summary, model, tried } or throws with
   * `.code` and `.tried`.
   */
  async write(key, promptText) {
    if (!key) throw Object.assign(new Error('no key'), { code: 'no-key', tried: [] });
    if (!this.models.length) throw Object.assign(new Error('no model'), { code: 'no-model', tried: [] });
    const tried = [];
    for (const model of this.models) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.#ask(key, model, promptText);
      if (r.kind === 'bad-key') throw Object.assign(new Error('key rejected'), { code: 'bad-key', tried: [...tried, { model, kind: 'bad-key', why: r.why }] });
      if (r.text) {
        const summary = parseAnswer(r.text);
        if (summary) return { summary, model, tried: [...tried, { model, kind: 'ok', why: null }] };
        tried.push({ model, kind: 'invalid', why: 'reply was not the JSON asked for' });
      } else tried.push({ model, kind: r.kind, why: r.why });
      this.log(`summary: ${model}: ${tried[tried.length - 1].why}`);
    }
    throw Object.assign(new Error('every model failed'), { code: 'all-failed', tried });
  }

  /** "Test my key": a few words, no health data. */
  async test(key) {
    const started = Date.now();
    const tried = [];
    if (!this.models.length) return { ok: false, reason: 'No usable free model is configured', tried };
    for (const model of this.models) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.#ask(key, model, 'Reply with the single word: ok', { maxTokens: 20 });
      if (r.text) return { ok: true, model, ms: Date.now() - started };
      tried.push({ model, why: r.why });
      if (r.kind === 'bad-key') return { ok: false, reason: 'OpenCode rejected the key', tried };
    }
    return { ok: false, reason: reasonFor({ tried: tried.map((t) => ({ ...t, kind: /unreachable|timed out/.test(t.why) ? 'unreachable' : QUOTA_RE.test(t.why) || /HTTP (429|402)/.test(t.why) ? 'quota' : 'refused' })) }), tried };
  }
}
