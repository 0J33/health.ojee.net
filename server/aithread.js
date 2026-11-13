/* ============================================================
   health.ojee.net — the AI conversation, kept on the server.

   One thread per person, in their own store (meta `aiThread`), so it is
   the same on every device and survives closing the page, the app, or a
   restart. Each turn is one request and its reply:

     { id, at, kind: 'section' | 'question', topic, refId, title, question,
       state: 'queued' | 'reading' | 'asking' | 'done' | 'error' | 'stopped',
       model, attempt, of, tries: [{ model, kind }], seen: [label],
       answer, error, cached, startedAt, doneAt }

   Requests run one at a time per person, in the order asked: one made
   while another is running waits its turn ('queued'). Stop aborts the
   running one (and, with `all`, everything waiting); Clear empties the
   thread. A turn left running when the server stopped is picked up again
   the next time the thread is read.

   `build(userId, turn, history, signal)` reads the person's data and
   returns { prompt, cacheKey, seen }: the app's own (app.js).
   ============================================================ */

import { parseReply } from './ai.js';

const MAX_TURNS = 120;
const RUNNING = new Set(['reading', 'asking']);

export class AiThreads {
  constructor({ writer, writerFor = () => null, worlds, build, cacheFor, onChange = () => {}, log = () => {}, now = Date.now }) {
    this.writer = writer; this.writerFor = writerFor; this.worlds = worlds; this.build = build; this.cacheFor = cacheFor;
    this.onChange = onChange; this.log = log; this.now = now;
    this.running = new Map();   // userId -> { id, ac }
    this.seq = 0;
  }

  #load(w) { const t = w.db.meta('aiThread', null); return Array.isArray(t?.turns) ? t.turns : []; }
  #save(w, turns) { w.db.setMeta('aiThread', { turns: turns.slice(-MAX_TURNS) }); }

  /** Change one turn, in the person's store; the page hears it. */
  async #patch(userId, id, patch) {
    let out = null;
    await this.worlds.hold(userId, (w) => {
      const turns = this.#load(w);
      const t = turns.find((x) => x.id === id);
      if (!t) return;
      Object.assign(t, patch);
      this.#save(w, turns);
      out = { ...t };
    });
    this.onChange(userId);
    return out;
  }

  /** The thread, newest last. A turn left running by a restart goes back in the queue. */
  async thread(userId, { limit = 60 } = {}) {
    let turns = [];
    let revive = false;
    await this.worlds.hold(userId, (w) => {
      turns = this.#load(w);
      if (!this.running.has(userId)) {
        for (const t of turns) if (RUNNING.has(t.state)) { t.state = 'queued'; revive = true; }
        if (revive) this.#save(w, turns);
      }
    });
    if (revive || turns.some((t) => t.state === 'queued')) this.#kick(userId);
    return { turns: turns.slice(-limit), more: turns.length > limit, running: turns.some((t) => t.state === 'queued' || RUNNING.has(t.state)) };
  }

  async turn(userId, id) {
    let t = null;
    await this.worlds.hold(userId, (w) => { t = this.#load(w).find((x) => x.id === id) || null; });
    return t;
  }

  /** Ask: a section's summary or a question. Resolves the new turn (queued, or running at once). */
  async add(userId, { kind, topic, refId = null, title, question = null }) {
    const turn = {
      id: `ai${this.now().toString(36)}${(this.seq += 1).toString(36)}`, at: this.now(), kind, topic, refId, title, question,
      state: 'queued', model: null, attempt: 0, of: 0, tries: [], seen: [], answer: null, error: null, cached: false, startedAt: null, doneAt: null,
    };
    await this.worlds.hold(userId, (w) => { const turns = this.#load(w); turns.push(turn); this.#save(w, turns); });
    this.onChange(userId);
    this.#kick(userId);
    return (await this.turn(userId, turn.id)) || turn;
  }

  /** Stop the running request (with `all`, also everything waiting). */
  async stop(userId, { id = null, all = false } = {}) {
    const r = this.running.get(userId);
    if (r && (all || !id || r.id === id)) r.ac.abort();
    if (all || id) {
      await this.worlds.hold(userId, (w) => {
        const turns = this.#load(w);
        for (const t of turns) if (t.state === 'queued' && (all || t.id === id)) Object.assign(t, { state: 'stopped', doneAt: this.now() });
        this.#save(w, turns);
      });
      this.onChange(userId);
    }
  }

  /** Empty the thread (stopping whatever runs). */
  async clear(userId) {
    const r = this.running.get(userId);
    if (r) r.ac.abort();
    await this.worlds.hold(userId, (w) => this.#save(w, []));
    this.onChange(userId);
  }

  /** The conversation so far, as the model is shown it: the last few settled turns. */
  #history(turns, upTo) {
    const out = [];
    for (const t of turns) {
      if (t.id === upTo) break;
      if (t.state !== 'done' || !t.answer) continue;
      out.push({ role: 'user', text: t.question || `(asked for a summary: ${t.title})` });
      out.push({ role: 'ai', text: [t.answer.headline, t.answer.summary, ...(t.answer.points || [])].filter(Boolean).join(' ') });
    }
    return out.slice(-8);
  }

  /** Who writes this person's answers: their own AI (ownai.js) when connected, else the free models. */
  writerOf(userId) { return this.writerFor(userId) || this.writer; }

  #kick(userId) {
    if (this.running.has(userId)) return;
    this.#next(userId).catch((e) => this.log(`ai thread: ${e.message}`));
  }

  async #next(userId) {
    if (this.running.has(userId)) return;
    let turn = null; let history = [];
    await this.worlds.hold(userId, (w) => {
      const turns = this.#load(w);
      turn = turns.find((t) => t.state === 'queued') || null;
      if (turn) history = this.#history(turns, turn.id);
    });
    if (!turn) return;
    const ac = new AbortController();
    this.running.set(userId, { id: turn.id, ac });
    try {
      await this.#patch(userId, turn.id, { state: 'reading', startedAt: this.now() });
      const { prompt, cacheKey, seen } = await this.build(userId, turn, history, ac.signal);
      if (ac.signal.aborted) throw Object.assign(new Error('stopped'), { code: 'stopped' });
      const cache = cacheKey ? this.cacheFor(userId) : null;
      const hit = cache ? await cache.get(cacheKey) : null;
      if (hit) {
        await this.#patch(userId, turn.id, { state: 'done', answer: hit.answer, model: hit.model, cached: true, seen, doneAt: this.now() });
        return;
      }
      await this.#patch(userId, turn.id, { state: 'asking', seen });
      const writer = this.writerOf(userId);
      if (!writer.configured()) throw Object.assign(new Error('No AI is set up on this server yet.'), { code: 'unconfigured' });
      const tries = [];
      const r = await writer.write(prompt, {
        parse: parseReply,
        signal: ac.signal,
        onStep: (s) => { this.#patch(userId, turn.id, { model: s.model, attempt: s.attempt, of: s.of || 0 }).catch(() => {}); },
        onTry: (x) => { tries.push(x); this.#patch(userId, turn.id, { tries: [...tries] }).catch(() => {}); },
      });
      const model = r.model.replace(/^opencode(-go)?\//, '');
      await this.#patch(userId, turn.id, { state: 'done', answer: r.summary, model, tries, doneAt: this.now() });
      if (cache) await cache.set(cacheKey, { answer: r.summary, model, at: this.now() });
    } catch (e) {
      const stopped = e.code === 'stopped' || ac.signal.aborted;
      if (!stopped) this.log(`ai ${turn.topic}: ${e.message}`);
      await this.#patch(userId, turn.id, stopped
        ? { state: 'stopped', doneAt: this.now() }
        : { state: 'error', doneAt: this.now(), error: e.code === 'unconfigured' ? 'No AI is set up on this server yet.' : e.own ? e.message : (e.tried?.length ? 'Every AI model was busy or refused just now. Try again in a minute.' : 'The AI could not be reached. Try again in a minute.') }).catch(() => {});
    } finally {
      this.running.delete(userId);
      // The next one waiting, if any.
      setImmediate(() => this.#kick(userId));
    }
  }

  /** Try a failed or stopped turn again, in place: the same turn, where it is in the conversation,
      back in the queue with what the last try left cleared. Anything else is left as it is. */
  async retry(userId, id) {
    const t = await this.turn(userId, id);
    if (!t) return null;
    if (t.state !== 'error' && t.state !== 'stopped') return t;
    const out = await this.#patch(userId, id, { state: 'queued', model: null, attempt: 0, of: 0, tries: [], seen: [], answer: null, error: null, cached: false, startedAt: null, doneAt: null });
    this.#kick(userId);
    return out;
  }
}

/** A turn as the old job polling (GET /api/ai/:id) showed one. */
export const jobOf = (t) => ({
  id: t.id, topic: t.topic, title: t.title, state: t.state === 'queued' ? 'reading' : t.state === 'stopped' ? 'error' : t.state,
  model: t.model, attempt: t.attempt, startedAt: t.startedAt || t.at, answer: t.answer, error: t.state === 'stopped' ? 'Stopped.' : t.error, cached: !!t.cached,
});
