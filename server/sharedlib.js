/* ============================================================
   health.ojee.net — what people make for everyone: their own exercises,
   and the routines and programmes they share.

   An exercise of your own (one the library lacks) is kept for everybody
   in the app's store (table `cex`): a name, the muscle group and the
   muscles it works, the equipment, how its sets are counted, how to do it
   step by step, and up to six photos. Anyone signed in finds it in the
   exercise picker and the library, credited to its maker, and can put it
   in their routines; only its maker changes it. It shows to others while
   it is public and its maker's account is public, as a route does.

   A routine (routines.js) is kept in its maker's own store. Marked
   public, a copy of it is kept here too (table `pub_routine`), kept the
   same on every change, so others can browse it, see it on the maker's
   profile and add it to their own routines, a programme (a folder of
   routines) all at once.
   ============================================================ */

import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { faceOf } from './friends.js';
import { MUSCLES } from './muscles.js';
import { EQUIPMENT, LIB_MUSCLES } from './library.js';
import { EX_TYPES, routineSummary } from './routines.js';

export const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const bad = (message, status = 400, code = 'bad_request') => Object.assign(new Error(message), { status, code, expose: true });
const str = (v, max) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const isPublicAccount = (app, userId) => app.profile(userId)?.privacy?.account === 'public';

/* ── exercises of your own ─────────────────────────────────── */

/** The fields of an exercise as given, checked. `prev` is the one it changes. */
function cleanCex(b, prev = null) {
  const name = b.name !== undefined ? str(b.name, 80) : prev?.name;
  if (!name) throw bad('Give the exercise a name.');
  const list = (v, allowed, max) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => allowed.includes(x)))].slice(0, max) : null);
  const steps = b.steps !== undefined
    ? (Array.isArray(b.steps) ? b.steps : String(b.steps || '').split('\n')).map((x) => str(x, 400)).filter(Boolean).slice(0, 12)
    : prev?.steps || [];
  return {
    name,
    muscle: b.muscle !== undefined ? (MUSCLES.includes(b.muscle) ? b.muscle : 'other') : prev?.muscle || 'other',
    equipment: b.equipment !== undefined ? (EQUIPMENT.includes(b.equipment) ? b.equipment : null) : prev?.equipment ?? null,
    type: b.type !== undefined ? (EX_TYPES.includes(b.type) ? b.type : 'weight_reps') : prev?.type || 'weight_reps',
    primary: b.primary !== undefined ? list(b.primary, LIB_MUSCLES, 4) || [] : prev?.primary || [],
    secondary: b.secondary !== undefined ? list(b.secondary, LIB_MUSCLES, 6) || [] : prev?.secondary || [],
    steps,
    notes: b.notes !== undefined ? str(b.notes, 500) : prev?.notes ?? null,
    public: b.public !== undefined ? b.public !== false : prev ? prev.public : true,
  };
}

const rowOf = (r) => (r ? {
  id: r.id, userId: r.user_id, name: r.name, muscle: r.muscle, equipment: r.equipment, type: r.type,
  primary: parse(r.primary_m, []), secondary: parse(r.secondary_m, []), steps: parse(r.steps, []), notes: r.notes,
  images: r.images, public: !!r.public, created: r.created_ms, updated: r.updated_ms,
} : null);

const photoUrls = (x) => Array.from({ length: x.images }, (_, i) => `/api/media/cex/${x.id}/${i}.jpg?v=${x.updated}`);

/** An exercise as the library shows one (library.js libView), and who made it. */
export function cexView(app, x, viewerId, { full = false } = {}) {
  const owner = app.profile(x.userId);
  return {
    id: x.id, name: x.name, group: x.muscle, type: x.type, equipment: x.equipment, level: null, mechanic: null, force: null, category: 'strength',
    primary: x.primary, secondary: x.secondary, aka: [], images: photoUrls(x),
    custom: true, mine: x.userId === viewerId, public: x.public, by: owner ? faceOf(owner) : null,
    ...(full ? { steps: x.steps, notes: x.notes } : {}),
  };
}

/** The exercise behind an id, whoever made it (for routines that hold it), or null. */
export function cexGet(app, id) {
  return rowOf(app.get('SELECT * FROM cex WHERE id = ?', String(id)));
}

/** May this person see it: its maker always; others while it is public and so is the maker's account. */
export function cexVisible(app, x, viewerId) {
  return !!x && (x.userId === viewerId || (x.public && isPublicAccount(app, x.userId)));
}

/** As library.js wants an exercise (setCustomSource): its group, type, photos and steps. */
export function cexAsLib(x) {
  return x ? {
    id: x.id, name: x.name, group: x.muscle, type: x.type, equipment: x.equipment, primary: x.primary, secondary: x.secondary,
    steps: x.steps, images: x.images, custom: true, v: x.updated, level: null, mechanic: null, force: null, category: 'strength', aka: [],
  } : null;
}

/** Make one; the same name of yours again changes that one instead. */
export function cexCreate(app, userId, b, now = Date.now()) {
  const v = cleanCex(b);
  const same = app.get('SELECT * FROM cex WHERE user_id = ? AND name = ? COLLATE NOCASE', userId, v.name);
  if (same) return cexPatch(app, userId, same.id, b, now);
  const n = app.get('SELECT COUNT(*) AS n FROM cex WHERE user_id = ?', userId)?.n || 0;
  if (n >= 500) throw bad('You have made 500 exercises, the most one person can keep. Delete one first.', 409, 'conflict');
  const id = `c_${randomBytes(6).toString('hex')}`;
  app.run(`INSERT INTO cex (id, user_id, name, muscle, equipment, type, primary_m, secondary_m, steps, notes, images, public, created_ms, updated_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`, id, userId, v.name, v.muscle, v.equipment, v.type, JSON.stringify(v.primary), JSON.stringify(v.secondary),
  JSON.stringify(v.steps), v.notes, v.public ? 1 : 0, now, now);
  return cexGet(app, id);
}

function ownCex(app, userId, id) {
  const x = cexGet(app, id);
  if (!x || x.userId !== userId) throw bad('There is no such exercise of yours.', 404, 'not_found');
  return x;
}

export function cexPatch(app, userId, id, b, now = Date.now()) {
  const x = ownCex(app, userId, id);
  const v = cleanCex(b, x);
  if (v.name.toLowerCase() !== x.name.toLowerCase() && app.get('SELECT 1 FROM cex WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?', userId, v.name, x.id)) {
    throw bad(`You already have an exercise called "${v.name}".`, 409, 'conflict');
  }
  app.run('UPDATE cex SET name = ?, muscle = ?, equipment = ?, type = ?, primary_m = ?, secondary_m = ?, steps = ?, notes = ?, public = ?, updated_ms = ? WHERE id = ?',
    v.name, v.muscle, v.equipment, v.type, JSON.stringify(v.primary), JSON.stringify(v.secondary), JSON.stringify(v.steps), v.notes, v.public ? 1 : 0, now, x.id);
  return cexGet(app, x.id);
}

/**
 * Exercises people made: yours first, then everyone else's public ones,
 * matching every word of `q` (any order), narrowed by group and equipment.
 */
export function cexSearch(app, viewerId, { q = '', group = null, equipment = null, mineOnly = false, limit = 60 } = {}) {
  const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const rows = app.all(`SELECT cex.* FROM cex LEFT JOIN profile ON profile.user_id = cex.user_id
    WHERE cex.user_id = ? ${mineOnly ? '' : "OR (cex.public = 1 AND json_extract(profile.privacy, '$.account') = 'public')"}
    ORDER BY (cex.user_id = ?) DESC, cex.updated_ms DESC LIMIT 2000`, viewerId, viewerId).map(rowOf);
  return rows.filter((x) => {
    if (group && x.muscle !== group) return false;
    if (equipment && x.equipment !== equipment) return false;
    const n = x.name.toLowerCase();
    return words.every((w) => n.includes(w));
  }).slice(0, limit);
}

/* ── photos of an exercise ─────────────────────────────────── */

export class CexPhotos {
  constructor({ dir = null } = {}) { this.dir = dir; this.mem = new Map(); }
  #file(id, n) { return this.dir ? join(this.dir, id, `${n}.jpg`) : null; }
  get(id, n) {
    const f = this.#file(id, n);
    if (!f) return this.mem.get(`${id}/${n}`) || null;
    return existsSync(f) ? readFileSync(f) : null;
  }
  #put(id, n, buf) {
    const f = this.#file(id, n);
    if (!f) { this.mem.set(`${id}/${n}`, buf); return; }
    mkdirSync(join(this.dir, id), { recursive: true });
    writeFileSync(`${f}.part`, buf);
    renameSync(`${f}.part`, f);
  }
  #move(id, from, to) {
    const a = this.#file(id, from);
    if (!a) { const v = this.mem.get(`${id}/${from}`); this.mem.delete(`${id}/${from}`); if (v) this.mem.set(`${id}/${to}`, v); return; }
    if (existsSync(a)) renameSync(a, this.#file(id, to));
  }
  #drop(id, n) {
    const f = this.#file(id, n);
    if (!f) { this.mem.delete(`${id}/${n}`); return; }
    rmSync(f, { force: true });
  }
  /** Add a photo (JPEG bytes, made small on the phone) at the end. */
  add(app, userId, id, buf, now = Date.now()) {
    const x = ownCex(app, userId, id);
    if (x.images >= MAX_PHOTOS) throw bad(`An exercise can have at most ${MAX_PHOTOS} photos.`, 409, 'conflict');
    if (!buf || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad('Send the photo as a JPEG.');
    if (buf.length > MAX_PHOTO_BYTES) throw bad('That photo is too big (3 MB at most).', 413, 'too_large');
    this.#put(x.id, x.images, buf);
    app.run('UPDATE cex SET images = ?, updated_ms = ? WHERE id = ?', x.images + 1, now, x.id);
    return cexGet(app, x.id);
  }
  /** Take one away; the ones after it move up. */
  remove(app, userId, id, n, now = Date.now()) {
    const x = ownCex(app, userId, id);
    if (!(n >= 0 && n < x.images)) throw bad('There is no such photo.', 404, 'not_found');
    this.#drop(x.id, n);
    for (let i = n + 1; i < x.images; i += 1) this.#move(x.id, i, i - 1);
    app.run('UPDATE cex SET images = ?, updated_ms = ? WHERE id = ?', x.images - 1, now, x.id);
    return cexGet(app, x.id);
  }
  /** Make photo `n` the first (the one shown in lists). */
  first(app, userId, id, n, now = Date.now()) {
    const x = ownCex(app, userId, id);
    if (!(n > 0 && n < x.images)) return x;
    this.#move(x.id, 0, 'tmp'); this.#move(x.id, n, 0); this.#move(x.id, 'tmp', n);
    app.run('UPDATE cex SET updated_ms = ? WHERE id = ?', now, x.id);
    return cexGet(app, x.id);
  }
  removeAll(id) {
    if (!this.dir) { for (const k of [...this.mem.keys()]) if (k.startsWith(`${id}/`)) this.mem.delete(k); return; }
    try { if (readdirSync(join(this.dir, id))) rmSync(join(this.dir, id), { recursive: true, force: true }); } catch { /* none */ }
  }
}

export function cexDelete(app, photos, userId, id) {
  const x = ownCex(app, userId, id);
  app.run('DELETE FROM cex WHERE id = ?', x.id);
  photos.removeAll(x.id);
}

/* ── shared routines ───────────────────────────────────────── */

/** Keep the shared copies of a person's routines the same as their own: the public ones, as they are now. */
export function syncShared(app, userId, routines, now = Date.now()) {
  app.run('DELETE FROM pub_routine WHERE user_id = ?', userId);
  for (const r of routines) {
    if (!r.public) continue;
    const { hevy: _h, lastUsed: _l, uses: _u, ...keep } = r;
    app.run('INSERT INTO pub_routine (id, user_id, folder, title, position, data, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      r.id, userId, r.folder || null, r.title, r.position || 0, JSON.stringify(keep), r.updated || now);
  }
}

const sharedRow = (r) => ({ id: r.id, userId: r.user_id, folder: r.folder, title: r.title, position: r.position, routine: parse(r.data, null), updated: r.updated_ms });

/** A shared routine as a list shows it: its summary, the exercises by name, and who shares it. */
function sharedView(app, s, { full = false } = {}) {
  const owner = app.profile(s.userId);
  const sum = routineSummary(s.routine);
  return {
    id: s.id, title: s.title, folder: s.folder, by: owner ? faceOf(owner) : null, updated: s.updated,
    exercises: sum.exercises, sets: sum.sets, estimateMin: sum.estimateMin, names: sum.names, muscles: sum.muscles, notes: s.routine.notes || null,
    ...(full ? { routine: { title: s.routine.title, folder: s.routine.folder, notes: s.routine.notes, exercises: s.routine.exercises } } : {}),
  };
}

/** Group shared routines into programmes: one per maker and folder, a routine with no folder on its own. */
function programmes(list) {
  const out = [];
  const at = new Map();
  for (const r of list) {
    const k = r.folder ? `${r.by?.username}\u0000${r.folder}` : `\u0001${r.id}`;
    if (!at.has(k)) { at.set(k, out.length); out.push({ key: r.folder ? `${r.by?.username}/${r.folder}` : r.id, by: r.by, folder: r.folder, routines: [] }); }
    out[at.get(k)].routines.push(r);
  }
  return out;
}

/**
 * Everyone's shared routines (but yours), as programmes, newest first;
 * `q` matches a routine's or folder's name or an exercise in it.
 */
export function browseShared(app, viewerId, { q = '', userId = null, limit = 200 } = {}) {
  const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const rows = app.all(`SELECT pub_routine.* FROM pub_routine JOIN profile ON profile.user_id = pub_routine.user_id
    WHERE json_extract(profile.privacy, '$.account') = 'public' ${userId ? 'AND pub_routine.user_id = ?' : 'AND pub_routine.user_id != ?'}
    ORDER BY pub_routine.updated_ms DESC LIMIT 2000`, userId || viewerId || '').map(sharedRow).filter((s) => s.routine);
  const list = rows.map((s) => sharedView(app, s)).filter((r) => {
    if (!words.length) return true;
    const hay = `${r.title} ${r.folder || ''} ${r.names.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // A maker's own order inside a programme.
  const progs = programmes(list).slice(0, limit);
  for (const p of progs) p.routines.sort((a, b) => (rows.find((x) => x.id === a.id)?.position ?? 0) - (rows.find((x) => x.id === b.id)?.position ?? 0));
  return progs;
}

/** One shared routine, whole (to look at before adding it), or a 404. */
export function sharedGet(app, viewerId, id) {
  const r = app.get('SELECT * FROM pub_routine WHERE id = ?', String(id));
  const s = r ? sharedRow(r) : null;
  if (!s || !s.routine || (s.userId !== viewerId && !isPublicAccount(app, s.userId))) throw bad('There is no such shared routine.', 404, 'not_found');
  return { ...sharedView(app, s, { full: true }), mine: s.userId === viewerId };
}

/** The routines to copy for `ids` (a programme's, or one), checked as visible. */
export function sharedForCopy(app, viewerId, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 30) throw bad('ids must list 1 to 30 shared routines.');
  return ids.map((id) => {
    const r = app.get('SELECT * FROM pub_routine WHERE id = ?', String(id));
    const s = r ? sharedRow(r) : null;
    if (!s || !s.routine || !isPublicAccount(app, s.userId)) throw bad('One of those routines is no longer shared.', 404, 'not_found');
    return { ...s, by: app.profile(s.userId)?.username || null };
  });
}
