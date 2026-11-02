/* ============================================================
   health.ojee.net — Hevy and the things made here: exercises and routines.

   Exercises. Hevy only takes an exercise it knows (a template). An
   exercise picked here from the library, or typed in, is matched to
   Hevy's own library first, so the sets land on the exercise people
   already have in Hevy (with its history): by the exact name, then by
   what the library says the Hevy title is ("Bench Press (Barbell)" is
   the library's Barbell Bench Press), then by the same words in any
   order. Only an exercise Hevy has nothing like becomes a custom one in
   the person's Hevy library, with the right kind of sets, equipment and
   muscle. Once matched, the template is written back onto the sets and
   the routine, so it is worked out once.

   Routines, both ways. Each routine here remembers the Hevy routine it
   is and a fingerprint of the two as they were when they last agreed.
   On each pass the fingerprints of both sides are compared with it:
     only Hevy's changed     Hevy's version comes here
     only this one changed   it goes to Hevy (PUT)
     both changed            the one edited last wins
     neither                 nothing
   so an edit is never sent back where it came from, and nothing loops.
   A routine made here goes to Hevy (in a folder of the same name,
   made when missing); a routine made in Hevy comes here. Hevy's API
   cannot delete a routine: one deleted here is left in Hevy and not
   brought back; one deleted in Hevy stops syncing and stays here.
   ============================================================ */

import { createHash } from 'node:crypto';
import { libById, libMatch } from './library.js';
import { cleanRoutine } from './routines.js';

/* ── exercises ─────────────────────────────────────────────────────── */

const words = (s) => String(s || '').toLowerCase().replace(/\(([^)]*)\)/g, ' $1 ').replace(/\bdb\b/g, 'dumbbell').split(/[^a-z0-9]+/).filter((w) => w.length > 1).map((w) => w.replace(/s$/, '')).sort().join(' ');

const HEVY_EQUIP = { barbell: 'barbell', dumbbell: 'dumbbell', machine: 'machine', cable: 'machine', kettlebells: 'kettlebell', bands: 'resistance_band', 'body only': 'none', 'e-z curl bar': 'barbell', 'medicine ball': 'other', 'exercise ball': 'other', 'foam roll': 'other', other: 'other' };
const HEVY_MUSCLE = { abdominals: 'abdominals', hamstrings: 'hamstrings', quadriceps: 'quadriceps', adductors: 'adductors', abductors: 'abductors', glutes: 'glutes', calves: 'calves', biceps: 'biceps', triceps: 'triceps', forearms: 'forearms', shoulders: 'shoulders', traps: 'traps', neck: 'neck', chest: 'chest', 'middle back': 'upper_back', lats: 'lats', 'lower back': 'lower_back' };
const GROUP_MUSCLE = { chest: 'chest', back: 'upper_back', shoulders: 'shoulders', arms: 'biceps', legs: 'quadriceps', core: 'abdominals', other: 'other' };
const HEVY_TYPE = { weight_reps: 'weight_reps', bodyweight_reps: 'reps_only', duration: 'duration', distance_duration: 'distance_duration' };

/** The template index: by exact title, by library exercise, by words. Built once per pass. */
function indexOf(db) {
  const list = db.hevyTemplates();
  const byTitle = new Map(); const byLib = new Map(); const byWords = new Map();
  for (const t of list) {
    byTitle.set(t.title.toLowerCase(), t.id);
    const w = words(t.title);
    if (!byWords.has(w)) byWords.set(w, t.id);
    const l = libMatch(t.title);
    // Hevy's own exercise first: a custom one of the same lift only when there is no other.
    if (l && (!byLib.has(l.id) || !t.custom)) byLib.set(l.id, t.id);
  }
  return { byTitle, byLib, byWords, n: list.length };
}

/**
 * Give every exercise a Hevy template: matched, or made. Returns
 * { exercises, made, missing } (exercises with templateId filled in where
 * one was found; `missing` the names that could not get one).
 */
export async function resolveTemplates({ db, api, exercises, createTemplate, now = Date.now(), make = true, idx = null }) {
  const ix = idx || indexOf(db);
  const memo = db.meta('hevyTplMemo', {}) || {};
  let made = 0; const missing = [];
  const out = [];
  for (const x of exercises) {
    if (x.templateId) { out.push(x); continue; }
    const key = (x.libId ? `lib:${x.libId}` : `n:${x.name.toLowerCase()}`);
    const lib = x.libId ? libById(x.libId) : libMatch(x.name);
    let id = memo[key] && ix.n ? memo[key] : null;
    id ||= ix.byTitle.get(x.name.toLowerCase()) || (lib && ix.byLib.get(lib.id)) || ix.byWords.get(words(x.name)) || null;
    if (!id && make && createTemplate) {
      try {
        const t = await createTemplate({
          db, api, title: x.name, now,
          muscle: (lib && HEVY_MUSCLE[lib.primary[0]]) || GROUP_MUSCLE[x.muscle] || 'other',
          equipment: HEVY_EQUIP[lib?.equipment || 'other'] || 'other',
          type: HEVY_TYPE[x.type || lib?.type] || 'weight_reps',
        });
        id = t?.id || null;
        if (id) { made += 1; ix.byTitle.set(x.name.toLowerCase(), id); }
      } catch (e) {
        if (['hevy_key', 'hevy_pro', 'rate_limited', 'network'].includes(e.code)) throw e;
        id = null;   // a limit of the Hevy account: left out, said so
      }
    }
    if (id) memo[key] = id; else missing.push(x.name);
    out.push(id ? { ...x, templateId: id } : x);
  }
  db.setMeta('hevyTplMemo', memo);
  return { exercises: out, made, missing };
}

/* ── routines ──────────────────────────────────────────────────────── */

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
/** What a routine is, for comparing: the same on both sides when they agree. */
function shapeOf({ title, notes, exercises }) {
  return JSON.stringify({
    t: String(title || '').trim(), n: String(notes || '').trim(),
    x: (exercises || []).map((x) => ({
      k: x.templateId || String(x.name || '').toLowerCase(), r: n(x.restS) ?? 0, n: String(x.notes || '').trim(),
      s: (x.sets || []).map((s) => [s.type || 'normal', n(s.kg), n(s.reps), n(s.repsMax), n(s.durationS), n(s.distanceM)]),
    })),
  });
}
export const fingerprint = (r) => createHash('sha1').update(shapeOf(r)).digest('base64url').slice(0, 16);

/** A Hevy routine (as hevysync keeps it) in this site's terms. */
export function fromHevyRoutine(h) {
  return {
    title: h.title, notes: h.notes || null, folder: h.folder || null,
    exercises: (h.exercises || []).map((x) => ({
      name: x.name, templateId: x.templateId || null, libId: libMatch(x.name)?.id || null, restS: x.restS ?? 90, notes: x.notes || null,
      sets: (x.sets || []).map((s) => ({ type: s.type || 'normal', kg: s.kg ?? null, reps: s.repRange?.start ?? s.reps ?? null, repsMax: s.repRange?.end && s.repRange.end > (s.repRange.start ?? 0) ? s.repRange.end : null, durationS: s.durationS ?? null, distanceM: s.distanceM ?? null })),
    })),
  };
}

/** A routine here in Hevy's terms (every exercise with a template). */
function toHevyRoutine(r, { folderId } = {}) {
  return {
    title: r.title, notes: r.notes || '',
    ...(folderId !== undefined ? { folder_id: folderId } : {}),
    exercises: r.exercises.filter((x) => x.templateId).map((x) => ({
      exercise_template_id: x.templateId, superset_id: null, rest_seconds: x.restS ?? 90, notes: x.notes || null,
      // An exercise planned without sets (a routine of exercises only): Hevy wants one.
      sets: (x.sets.length ? x.sets : [{ type: 'normal' }]).map((s) => ({
        type: s.type || 'normal', weight_kg: s.kg ?? null,
        ...(s.repsMax && s.reps ? { reps: null, rep_range: { start: s.reps, end: s.repsMax } } : { reps: s.reps ?? null }),
        distance_meters: s.distanceM ? Math.round(s.distanceM) : null, duration_seconds: s.durationS ? Math.round(s.durationS) : null,
      })),
    })),
  };
}

/** The local routine that is a given Hevy routine, if any. */
export function routineOfHevy(db, hevyId) {
  if (!hevyId) return null;
  return db.routines().find((r) => r.hevy?.id === String(hevyId)) || null;
}

/**
 * One pass of routines both ways. `fresh` says the Hevy list was just
 * read (only then can a routine missing from it be taken as deleted).
 * Returns { pulled, pushed, made, imported, missing }.
 */
export async function syncRoutines({ db, api, createTemplate, folders = [], fresh = false, now = Date.now(), log = () => {} }) {
  const out = { pulled: 0, pushed: 0, made: 0, imported: 0, templates: 0, blocked: [] };
  const theirs = new Map(db.hevyRoutines().map((h) => [h.id, h]));
  const ignored = new Set(db.meta('hevyRoutineIgnored', []) || []);
  const linked = new Set();
  const idx = indexOf(db);
  let folderMap = new Map(folders.map((f) => [String(f.title).toLowerCase(), f.id]));
  let changedHevy = false;

  const pushReady = async (r) => {
    const res = await resolveTemplates({ db, api, exercises: r.exercises, createTemplate, now, idx });
    out.templates += res.made;
    if (res.made || res.exercises.some((x, i) => x.templateId !== r.exercises[i].templateId)) r.exercises = res.exercises;
    return res.missing;
  };
  const folderIdFor = async (name) => {
    if (!name) return null;
    const k = name.toLowerCase();
    if (folderMap.has(k)) return folderMap.get(k);
    const f = await api.createFolder(name);
    if (f?.id === undefined || f?.id === null) return null;
    folderMap = new Map(folderMap).set(k, f.id);
    return f.id;
  };

  for (const r of db.routines()) {
    // Adopt the Hevy routine it was copied from.
    if (!r.hevy && r.from?.kind === 'hevy' && theirs.has(r.from.id) && !ignored.has(r.from.id)) r.hevy = { id: r.from.id, fp: null };
    if (r.hevy?.off) continue;
    try {
      if (r.hevy?.id) {
        linked.add(r.hevy.id);
        const h = theirs.get(r.hevy.id);
        if (!h) {
          // Gone from Hevy: deleted there. It stays here, unlinked.
          if (fresh) { r.hevy = { off: 'deleted in Hevy', at: now }; db.routinePut(r); }
          continue;
        }
        const mine = fingerprint(r); const there = fingerprint(fromHevyRoutine(h)); const base = r.hevy.fp;
        if (mine === there) { if (base !== mine) { r.hevy = { ...r.hevy, fp: mine }; db.routinePut(r); } continue; }
        const hevyNewer = Date.parse(h.updatedAt || 0) > (r.updated || 0);
        if (base === mine || (base !== there && hevyNewer)) {
          const x = fromHevyRoutine(h);
          const next = cleanRoutine({ title: x.title, notes: x.notes, folder: x.folder ?? r.folder, exercises: x.exercises }, r, now);
          // Rest times and notes that Hevy does not hold stay as they were here.
          next.hevy = { id: h.id, fp: fingerprint(next) };
          db.routinePut(next);
          out.pulled += 1;
        } else {
          const missing = await pushReady(r);
          if (missing.length) { r.hevy = { ...r.hevy, blocked: missing }; db.routinePut(r); out.blocked.push(r.title); continue; }
          const got = await api.updateRoutine(h.id, toHevyRoutine(r));
          r.hevy = { id: h.id, fp: fingerprint(r), at: now, updatedAt: got?.updated_at || null };
          db.routinePut(r);
          changedHevy = true;
          out.pushed += 1;
        }
      } else if (!r.hevy?.off && r.exercises.length) {
        // Made here: made in Hevy too.
        const missing = await pushReady(r);
        if (missing.length) { r.hevy = { blocked: missing }; db.routinePut(r); out.blocked.push(r.title); continue; }
        const folderId = await folderIdFor(r.folder);
        const got = await api.createRoutine(toHevyRoutine(r, { folderId }));
        if (got?.id) {
          r.hevy = { id: String(got.id), fp: fingerprint(r), at: now };
          linked.add(r.hevy.id);
          db.routinePut(r);
          changedHevy = true;
          out.made += 1;
        }
      }
    } catch (e) {
      if (['hevy_key', 'hevy_pro', 'rate_limited', 'network'].includes(e.code)) throw e;
      log(`hevy routine ${r.id}: ${e.message}`);
      r.hevy = { ...(r.hevy || {}), error: String(e.message).slice(0, 200), errorAt: now };
      db.routinePut(r);
    }
  }
  // Made in Hevy: here too.
  let pos = db.routines().length;
  for (const h of theirs.values()) {
    if (linked.has(h.id) || ignored.has(h.id)) continue;
    const x = fromHevyRoutine(h);
    const r = cleanRoutine({ ...x, from: { kind: 'hevy', id: h.id } }, null, now);
    r.position = pos++;
    r.hevy = { id: h.id, fp: fingerprint(r) };
    db.routinePut(r);
    out.imported += 1;
  }
  if (changedHevy) db.setMeta('hevyRoutinesStale', true);
  return out;
}

/** A routine deleted here: Hevy keeps it (its API cannot delete), and it is not brought back. */
export function forgetHevyRoutine(db, r) {
  if (!r?.hevy?.id) return false;
  const ignored = new Set(db.meta('hevyRoutineIgnored', []) || []);
  ignored.add(r.hevy.id);
  db.setMeta('hevyRoutineIgnored', [...ignored].slice(-500));
  return true;
}
