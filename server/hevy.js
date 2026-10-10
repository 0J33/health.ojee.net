/* ============================================================
   health.ojee.net — Hevy import.

   Hevy → Settings → Export gives one CSV, one row per SET:

     title, start_time, end_time, description, exercise_title,
     superset_id, exercise_notes, set_index, set_type,
     weight_kg | weight_lbs, reps, distance_km | distance_miles,
     duration_seconds, rpe

   Rows that share a title and a start time are one workout. Times
   are written the way the phone showed them ("9 Oct 2026, 15:10"),
   with no zone: they are read in the person's own time zone.

   What import promises:
     - the same file twice changes nothing (a workout is known by its
       start time + title, even after it was deleted here);
     - a Hevy workout that overlaps one the person already holds by
       half or more is the same session: its sets are attached to
       that workout instead of making a second one;
     - nothing is written to Google unless asked, and then only the
       workouts Google has no overlapping exercise for.
   ============================================================ */

import { localToMs } from './core/util.js';
import { muscleOf } from './muscles.js';

const MIN = 60_000;
const LB = 0.45359237;
const MILE = 1609.344;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/**
 * A Hevy time in a zone → ms, or null. Hevy writes "9 Oct 2026, 15:10";
 * older exports and other locales give "2026-10-09 15:10:00" or an ISO
 * instant, which are accepted too.
 */
export function parseHevyDate(str, tz) {
  const s = String(str || '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\s+([A-Za-z]{3,4})\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  let y; let mo; let d; let h; let mi; let sec = 0;
  if (m) {
    mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    d = Number(m[1]); y = Number(m[3]); h = Number(m[4]); mi = Number(m[5]); sec = Number(m[6] || 0);
    if (m[7]) { const pm = m[7].toLowerCase() === 'pm'; h = (h % 12) + (pm ? 12 : 0); }
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s))) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); h = Number(m[4]); mi = Number(m[5]); sec = Number(m[6] || 0);
  } else if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && sec < 60)) return null;
  const date = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Reject 31 Feb and friends rather than rolling them into March.
  if (new Date(`${date}T00:00:00Z`).getUTCDate() !== d) return null;
  return localToMs(date, h * 60 + mi, tz) + sec * 1000;
}

const numOr = (v) => { if (v === undefined || v === null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const SET_TYPES = { normal: 'normal', warmup: 'warmup', warm_up: 'warmup', dropset: 'dropset', drop_set: 'dropset', failure: 'failure' };

/**
 * The workouts in a Hevy CSV.
 * @returns {{ workouts: Array, errors: string[] }}
 */
export function parseHevy(text, tz) {
  const rows = parseCsv(text);
  if (!rows.length) throw bad('That file is empty.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  for (const need of ['title', 'start_time', 'exercise_title']) {
    if (col(need) < 0) throw bad(`That does not look like a Hevy export: there is no "${need}" column. Use Hevy, Settings, Export.`);
  }
  const at = (r, name) => { const i = col(name); return i >= 0 ? (r[i] ?? '').trim() : ''; };
  const byKey = new Map();
  const errors = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const title = at(r, 'title') || 'Workout';
    const rawStart = at(r, 'start_time');
    const start = parseHevyDate(rawStart, tz);
    if (start === null) { if (errors.length < 20) errors.push(`Row ${i + 1}: could not read the date "${rawStart.slice(0, 40)}"`); continue; }
    const name = at(r, 'exercise_title');
    if (!name) { if (errors.length < 20) errors.push(`Row ${i + 1}: no exercise name`); continue; }
    const key = `${start}|${title}`;
    let w = byKey.get(key);
    if (!w) {
      const end = parseHevyDate(at(r, 'end_time'), tz);
      w = { key, title: title.slice(0, 80), start, end, description: at(r, 'description').slice(0, 2000) || null, exercises: [] };
      byKey.set(key, w);
    }
    // Sets of one exercise are consecutive rows; the same exercise done
    // again later in the session is its own block, as it was in the gym.
    let ex = w.exercises[w.exercises.length - 1];
    const superset = at(r, 'superset_id') || null;
    if (!ex || ex.name !== name) {
      ex = { name: name.slice(0, 80), muscle: muscleOf(name), notes: at(r, 'exercise_notes').slice(0, 500) || null, supersetId: superset, sets: [] };
      w.exercises.push(ex);
    }
    const kg = numOr(at(r, 'weight_kg')) ?? (numOr(at(r, 'weight_lbs')) !== null ? Math.round(numOr(at(r, 'weight_lbs')) * LB * 100) / 100 : null);
    const km = numOr(at(r, 'distance_km'));
    const mi = numOr(at(r, 'distance_miles'));
    ex.sets.push({
      index: numOr(at(r, 'set_index')) ?? ex.sets.length,
      type: SET_TYPES[at(r, 'set_type').toLowerCase()] || 'normal',
      kg: kg !== null && kg >= 0 ? kg : null,
      reps: numOr(at(r, 'reps')) !== null ? Math.max(0, Math.round(numOr(at(r, 'reps')))) : null,
      distanceM: km !== null ? Math.round(km * 1000) : mi !== null ? Math.round(mi * MILE) : null,
      durationS: numOr(at(r, 'duration_seconds')),
      rpe: numOr(at(r, 'rpe')),
    });
  }
  const workouts = [...byKey.values()].sort((a, b) => a.start - b.start);
  for (const w of workouts) {
    // No end, or one before the start: an hour, the length of a session.
    if (!(w.end > w.start)) w.end = w.start + 60 * MIN;
    // A session left running overnight in the app is not a 14-hour workout.
    if (w.end - w.start > 6 * 60 * MIN) w.end = w.start + 6 * 60 * MIN;
    w.sets = w.exercises.reduce((n, e) => n + e.sets.length, 0);
  }
  return { workouts, errors };
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** The same session: they share half or more of the shorter one. */
const sameSession = (a0, a1, b0, b1) => overlap(a0, a1, b0, b1) >= 0.5 * Math.max(MIN, Math.min(a1 - a0, b1 - b0));

/**
 * Import a Hevy CSV into one person's store.
 * @param {object} o
 * @param {object} o.db        the person's Store
 * @param {string} o.text      the CSV
 * @param {string} o.tz        their zone
 * @param {boolean} o.upload   also save to Google Health
 * @param {boolean} o.canWrite the Google write permission is granted
 * @param {boolean} o.dryRun   report only
 */
export function importHevy({ db, text, tz, upload = false, canWrite = false, dryRun = false, now = Date.now() }) {
  const { workouts, errors } = parseHevy(text, tz);
  if (!workouts.length) throw bad(errors.length ? `Nothing could be imported. ${errors[0]}.` : 'That file has no workouts in it.');
  const out = { ok: true, dryRun, found: workouts.length, imported: 0, merged: 0, skipped: 0, toUpload: 0, sets: 0, unknownExercises: [], errors, items: [] };
  const unknown = new Set();
  const first = workouts[0].start;
  // What the person already holds around the file's span, and what Google has.
  const held = db.workoutsSince(first - 12 * 3_600_000).filter((r) => ['done', 'running', 'review', 'ongoing'].includes(r.status));
  const inGoogle = db.exercises(new Date(first - 2 * 86_400_000).toISOString().slice(0, 10));

  const run = () => {
    for (const w of workouts) {
      const item = { title: w.title, start: w.start, end: w.end, sets: w.sets, result: 'imported', id: null, mergedInto: null };
      out.items.push(item);
      const seen = db.hevySeen(w.key);
      if (seen) { item.result = 'skipped'; item.id = seen.workout_id ? String(seen.workout_id) : null; out.skipped += 1; continue; }
      for (const e of w.exercises) if (e.muscle === 'other') unknown.add(e.name);
      out.sets += w.sets;
      const mine = held.find((r) => sameSession(w.start, w.end, r.start, r.end ?? r.lastEnd ?? r.start + MIN));
      if (mine) {
        item.result = 'merged'; item.id = String(mine.id); item.mergedInto = String(mine.id); out.merged += 1;
        if (dryRun) continue;
        db.putSets(mine.id, w.exercises, { append: true });
        const r = db.workoutGet(mine.id);
        if (!r.title) r.title = w.title;
        if (!r.notes && w.description) r.notes = w.description;
        r.hevy = { key: w.key, title: w.title, at: now };
        r.updated = now;
        db.workoutPut(r);
        db.markHevy(w.key, mine.id, now);
        continue;
      }
      // Google already has this session from the watch or another app: the
      // sets attach to a workout that points at Google's own record.
      const theirs = inGoogle.find((x) => sameSession(w.start, w.end, x.startMs, x.endMs));
      const google = theirs ? { state: 'foreign', name: theirs.id }
        : upload ? { state: canWrite ? 'pending' : 'needs_scope' } : { state: 'local' };
      if (google.state === 'pending' || google.state === 'needs_scope') out.toUpload += 1;
      out.imported += 1;
      if (dryRun) continue;
      const rec = {
        status: 'done', source: 'hevy', start: w.start, end: w.end, created: now, updated: now,
        title: w.title, notes: w.description, prompts: {}, google, confirmedAt: now, hevy: { key: w.key, title: w.title, at: now },
      };
      rec.id = db.workoutAdd(rec);
      db.putSets(rec.id, w.exercises);
      db.markHevy(w.key, rec.id, now);
      held.push({ ...rec });
      item.id = String(rec.id);
    }
  };
  if (dryRun) run(); else db.tx(run);
  out.unknownExercises = [...unknown].slice(0, 50);
  return out;
}
