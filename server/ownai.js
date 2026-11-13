/* ============================================================
   health.ojee.net — the person's own AI, instead of the free models.

   Somebody with an account at an AI provider can have their answers
   written there: they paste an API key (made in the provider's own
   console, the official way to let an app use an account), or, for
   OpenRouter, connect with OpenRouter's sign-in, which hands this site a
   key of their own (OAuth with PKCE: openrouter.ai/docs/use-cases/oauth-pkce).
   The key is sealed like every other key (secret `ai`), checked when it is
   saved with the provider's list of models (which costs nothing), and only
   ever sent to that provider. The same prompt, the same rules: only what
   the person allowed, never their name, never Strava (ai.js).

   Providers: OpenCode Go (a monthly subscription) and OpenCode Zen (pay
   as you go), OpenAI, Anthropic (Claude), Google (Gemini), OpenRouter (any
   model it carries), Mistral, Groq, and any other OpenAI-compatible
   address (https only, a local server through a tunnel, LM Studio...).

   OpenCode (opencode.ai/docs/go, /docs/zen; the opencode CLI's own provider
   entries `opencode-go` and `opencode` say the same): one API key from
   opencode.ai/console, sent as `Authorization: Bearer`, OpenAI-compatible
   chat completions at https://opencode.ai/inference/go/openai/v1 (Go) and
   https://opencode.ai/inference/openai/v1 (Zen); every text model answers
   there, the console translating for the ones that speak another API.
   GET …/models lists the models (401 for a key it does not know). Go also
   wants an `x-opencode-session` header on each conversation, and both ask
   for a user agent that names the app. Their free models are for OpenCode
   itself only, so the defaults are paid ones that keep nothing (writer.js GO_ZDR).
   ============================================================ */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GO_ZDR } from './core/writer.js';

/** An OpenCode console key (opencode.ai/console): letters, digits, _ and -. */
const OPENCODE_KEY = /^[A-Za-z0-9_-]{20,200}$/;

export const OWN_AI = {
  'opencode-go': { label: 'OpenCode Go (subscription)', kind: 'openai', opencode: true, base: 'https://opencode.ai/inference/go/openai/v1', model: GO_ZDR[0], models: GO_ZDR, keys: 'opencode.ai/console → Go → API keys', about: 'A monthly OpenCode subscription. Paste its API key from opencode.ai.', keyRe: OPENCODE_KEY },
  'opencode-zen': { label: 'OpenCode Zen (pay as you go)', kind: 'openai', opencode: true, base: 'https://opencode.ai/inference/openai/v1', model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'glm-5.3', 'kimi-k3', 'minimax-m3', 'qwen3.8-max', 'gemini-3.8-flash'], keys: 'opencode.ai/console → API keys (add credit first)', about: 'OpenCode\'s pay-as-you-go credit. Paste its API key from opencode.ai.', keyRe: OPENCODE_KEY },
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', keys: 'console.anthropic.com → API keys', keyRe: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  openai: { label: 'OpenAI (ChatGPT)', kind: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', keys: 'platform.openai.com → API keys', keyRe: /^sk-[A-Za-z0-9_-]{20,}$/ },
  google: { label: 'Google (Gemini)', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keys: 'aistudio.google.com → Get API key', keyRe: /^[A-Za-z0-9_-]{30,}$/ },
  openrouter: { label: 'OpenRouter (any model)', kind: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', keys: 'openrouter.ai → Keys, or Connect with OpenRouter', keyRe: /^sk-or-[A-Za-z0-9_-]{20,}$/ },
  mistral: { label: 'Mistral', kind: 'openai', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keys: 'console.mistral.ai → API keys', keyRe: /^[A-Za-z0-9]{20,}$/ },
  groq: { label: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keys: 'console.groq.com → API keys', keyRe: /^gsk_[A-Za-z0-9]{20,}$/ },
  custom: { label: 'Another (OpenAI-compatible)', kind: 'openai', base: '', model: '', keys: 'the service\'s own console', keyRe: /^.{8,400}$/ },
};

const bad = (message, status = 400, code = 'bad_ai') => Object.assign(new Error(message), { status, expose: true, code, own: true });

/** A provider's address: its own, or (custom) one given, https only and never this machine's own network. */
function baseOf(cfg) {
  const p = OWN_AI[cfg.provider];
  if (!p) throw bad('Pick a provider.');
  if (cfg.provider !== 'custom') return p.base;
  let u;
  try { u = new URL(String(cfg.base || '').trim()); } catch { throw bad('The address must be a full https:// address, such as https://api.example.com/v1.'); }
  if (u.protocol !== 'https:') throw bad('The address must start with https://.');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1|\[?f[cd])/i.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname) || /\.(local|internal|lan)$/i.test(u.hostname)) throw bad('That address is on a private network: use one that is reachable from the internet.');
  return u.toString().replace(/\/+$/, '');
}

const headersOf = (cfg) => (OWN_AI[cfg.provider]?.kind === 'anthropic'
  ? { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  : {
    authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json',
    ...(cfg.provider === 'openrouter' ? { 'http-referer': 'https://rep.ojee.net', 'x-title': 'rep.' } : {}),
    // OpenCode asks clients to name themselves (opencode.ai/docs/go, "Where can I use it").
    ...(OWN_AI[cfg.provider]?.opencode ? { 'user-agent': 'rep. (rep.ojee.net)' } : {}),
  });

async function call(fetchImpl, url, init, { timeout = 90_000, signal = null } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  const off = () => ac.abort();
  signal?.addEventListener('abort', off);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data, text };
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('stopped'), { code: 'stopped' });
    return { ok: false, status: 0, data: null, text: '', error: e.name === 'AbortError' ? 'timed out' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); signal?.removeEventListener('abort', off); }
}

/** Why a provider said no, in words for the person. */
function refusal(cfg, r) {
  const name = OWN_AI[cfg.provider]?.label || 'Your AI';
  const said = String(r.data?.error?.message || r.data?.message || r.data?.error || '').slice(0, 160);
  if (r.status === 401 || r.status === 403) return bad(`${name} did not accept your key. Make a new one and paste it in Settings → API and AI.`, 409, 'ai_key');
  if (r.status === 402 || r.status === 429) return bad(`${name} says your account is out of credit or at its limit${said ? ` (${said})` : ''}.`, 409, 'ai_limit');
  if (r.status === 404) return bad(`${name} does not know the model "${cfg.model}". Pick another in Settings → API and AI.`, 409, 'ai_model');
  if (!r.status) return bad(`${name} could not be reached (${r.error || 'no answer'}).`, 502, 'ai_down');
  return bad(`${name} answered ${r.status}${said ? `: ${said}` : ''}.`, 502, 'ai_down');
}

/**
 * Check a key before keeping it: the provider's list of models (free to ask). Resolves the
 * cleaned settings { provider, key, model, base }; throws with words for the person.
 */
export async function checkOwnAi(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const p = OWN_AI[cfg.provider];
  if (!p) throw bad('Pick a provider.');
  const key = String(cfg.key || '').trim();
  if (!p.keyRe.test(key)) throw bad(`That does not look like a ${p.label} API key. Make one at ${p.keys}.`);
  const out = { provider: cfg.provider, key, model: String(cfg.model || '').trim().slice(0, 120) || p.model, base: cfg.provider === 'custom' ? baseOf(cfg) : null };
  if (!out.model) throw bad('Name the model to use.');
  const r = await call(fetchImpl, `${baseOf(out)}/models`, { headers: headersOf(out) }, { timeout: 20_000 });
  if (!r.ok) throw refusal(out, r);
  // The model, when the list says which there are (OpenRouter's "auto" is not in it).
  const ids = (Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data?.models) ? r.data.models : []).map((m) => String(m.id || m.name || '').replace(/^models\//, ''));
  if (ids.length && out.model !== 'openrouter/auto' && !ids.includes(out.model)) throw bad(`${p.label} has no model called "${out.model}". Some it has: ${ids.slice(0, 6).join(', ')}.`, 400, 'ai_model');
  return out;
}

/** The writer ai.js and aithread.js use, for the person's own provider: one call, the same reply shape. */
export class OwnWriter {
  constructor({ provider, key, model, base = null, fetchImpl = globalThis.fetch }) {
    this.cfg = { provider, key, model, base };
    this.fetch = fetchImpl;
  }

  configured() { return !!(this.cfg.key && OWN_AI[this.cfg.provider]); }

  async write(promptText, { parse, onStep = () => {}, onTry = () => {}, signal = null } = {}) {
    const { cfg } = this;
    const p = OWN_AI[cfg.provider];
    const label = `${cfg.model} (your ${p.label.replace(/ \(.*\)$/, '')})`;
    onStep({ model: label, attempt: 1, of: 1 });
    const body = p.kind === 'anthropic'
      ? { model: cfg.model, max_tokens: 1200, messages: [{ role: 'user', content: promptText }] }
      : { model: cfg.model, temperature: 0.4, messages: [{ role: 'user', content: promptText }] };
    // OpenCode routes a conversation by its session id (Go refuses a request without one): one per answer.
    const headers = { ...headersOf(cfg), ...(p.opencode ? { 'x-opencode-session': randomUUID() } : {}) };
    const r = await call(this.fetch, `${baseOf(cfg)}/${p.kind === 'anthropic' ? 'messages' : 'chat/completions'}`, { method: 'POST', headers, body: JSON.stringify(body) }, { signal });
    if (!r.ok) { onTry({ model: label, kind: 'refused' }); throw refusal(cfg, r); }
    const text = p.kind === 'anthropic'
      ? (r.data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : String(r.data?.choices?.[0]?.message?.content || '');
    const summary = parse(text);
    if (!summary) { onTry({ model: label, kind: 'invalid' }); throw bad(`${p.label} answered, but not in the shape asked for. Try again, or pick a stronger model.`, 502, 'ai_shape'); }
    onTry({ model: label, kind: 'ok' });
    return { summary, model: label, tried: [{ model: label, ok: true }] };
  }
}

/* ── Connect with OpenRouter (OAuth with PKCE) ─────────────────────── */

/** Where to send the person, and the verifier to keep until they come back. */
export function openRouterAuthUrl(callbackUrl) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const u = new URL('https://openrouter.ai/auth');
  u.searchParams.set('callback_url', callbackUrl);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), verifier };
}

/** The code OpenRouter sent back, for a key of the person's own. */
export async function openRouterExchange({ code, verifier, fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, 'https://openrouter.ai/api/v1/auth/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }) }, { timeout: 20_000 });
  if (!r.ok || !r.data?.key) throw bad('OpenRouter did not hand over a key. Try connecting again.', 502, 'ai_down');
  return r.data.key;
}
