/* Naps: every sleep that is not the night's main sleep.

   What is a nap is the device's word, not ours: Google marks each sleep as the main one or a nap
   (core/parse.js `main`, from `mainSleep`/`nap`; a sleep it says nothing about is a nap when it is
   under three hours), and so do Health Connect and WHOOP. The night's numbers (time asleep,
   stages, the score, readiness) are its main sleep's alone: a nap never adds to them or stands in
   for them. Naps are shown and read on their own here: on the Sleep page, the day (GET /api/day),
   GET /api/naps, the MCP tools and what the AI is told.

   A nap belongs to the day it ended on, in the person's time zone (its `date`, as a night's). */

import { addDays, round } from './util.js';

const MIN = 60_000;
/** A nap that starts this late (local, minutes after midnight) is said to be late: it can push bedtime. */
const LATE = 16 * 60;

/** Minutes after local midnight of a time with its offset (seconds). */
const clockMin = (t, off) => { const d = new Date(t + (off || 0) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const fin = (x) => Number.isFinite(x);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** Bedtime as minutes from noon, so 23:30 and 00:30 are an hour apart. */
const fromNoon = (t, off) => (clockMin(t, off) - 720 + 1440) % 1440;

/** Is this sleep a nap? */
export const isNap = (n) => Boolean(n) && n.main === false;

/** One nap as the API gives it. */
export function napView(n) {
  const st = n.summary?.stages || {};
  const asleep = fin(n.asleepMin) ? Math.round(n.asleepMin) : null;
  return {
    id: n.id, date: n.date,
    startMs: n.startMs, endMs: n.endMs, startOff: n.startOff, endOff: n.endOff,
    start: hhmm(clockMin(n.startMs, n.startOff)), end: hhmm(clockMin(n.endMs, n.endOff)),
    asleepMin: asleep,
    periodMin: fin(n.periodMin) ? Math.round(n.periodMin) : Math.round((n.endMs - n.startMs) / MIN),
    stages: Object.keys(st).length ? Object.fromEntries(Object.entries(st).map(([k, v]) => [k, Math.round(v)])) : null,
    late: clockMin(n.startMs, n.startOff) >= LATE,
    source: n.summary?.source || null,
  };
}

/** The naps of one day (the day they ended on), earliest first. */
export function napsOn(db, date) {
  return db.sleeps(addDays(date, -1)).filter((n) => isNap(n) && n.date === date).sort((a, b) => a.startMs - b.startMs).map(napView);
}

/**
 * Naps over the `days` up to `today`, and what they add up to.
 * { from, to, naps: [...newest first], stats, insights: [sentences] }
 */
export function napsReport(db, { today, days = 30 }) {
  const from = addDays(today, -(days - 1));
  // The night after the period's last day may not have happened yet; the nights before `from` are not needed.
  const all = db.sleeps(addDays(from, -1)).filter((n) => n.date <= addDays(today, 1));
  const naps = all.filter((n) => isNap(n) && n.date >= from && n.date <= today && fin(n.startMs) && fin(n.endMs)).sort((a, b) => a.startMs - b.startMs);
  const mains = {};
  for (const n of all) if (n.main && fin(n.asleepMin) && (!mains[n.date] || n.asleepMin > mains[n.date].asleepMin)) mains[n.date] = n;

  const views = naps.map(napView);
  const mins = views.map((v) => v.asleepMin ?? v.periodMin).filter(fin);
  const napDays = new Set(views.map((v) => v.date));
  const starts = naps.map((n) => clockMin(n.startMs, n.startOff));
  const late = views.filter((v) => v.late).length;

  // The night after: on a day with a nap, the main sleep that ends the next morning, against the
  // nights after days without one, in the same period. Only said with three of each.
  const after = { nap: [], none: [] };
  const bed = { nap: [], none: [] };
  for (let d = from; d < today; d = addDays(d, 1)) {
    const night = mains[addDays(d, 1)];
    if (!night) continue;
    const k = napDays.has(d) ? 'nap' : 'none';
    after[k].push(night.asleepMin);
    bed[k].push(fromNoon(night.startMs, night.startOff));
  }
  const enough = after.nap.length >= 3 && after.none.length >= 3;
  const nightAfter = enough ? {
    withNapMin: Math.round(mean(after.nap)), withoutNapMin: Math.round(mean(after.none)),
    diffMin: Math.round(mean(after.nap) - mean(after.none)),
    bedtimeWithNap: hhmm(mean(bed.nap) + 720), bedtimeWithout: hhmm(mean(bed.none) + 720),
    bedtimeDiffMin: Math.round(mean(bed.nap) - mean(bed.none)),
    nights: { withNap: after.nap.length, withoutNap: after.none.length },
  } : null;

  const stats = {
    days, naps: views.length, daysWithNap: napDays.size,
    totalMin: Math.round(mins.reduce((a, b) => a + b, 0)),
    avgMin: mins.length ? Math.round(mean(mins)) : null,
    longestMin: mins.length ? Math.round(Math.max(...mins)) : null,
    usualStart: starts.length ? hhmm(median(starts)) : null,
    late,
    perWeek: round((views.length / days) * 7, 1),
    nightAfter,
  };
  return { from, to: today, naps: [...views].reverse(), stats, insights: napInsights(stats) };
}

const dur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);

/** What the naps say, in plain sentences (the Sleep page, the AI, the MCP tool). */
export function napInsights(s) {
  if (!s.naps) return [`No naps in the last ${s.days} days.`];
  const out = [];
  out.push(`${s.naps} nap${s.naps === 1 ? '' : 's'} in the last ${s.days} days (${s.perWeek} a week), ${dur(s.avgMin ?? 0)} on average${s.naps > 1 ? `, usually around ${s.usualStart}` : ` at ${s.usualStart}`}.`);
  if (s.avgMin !== null && s.avgMin > 60) out.push('They run long: past about half an hour a nap reaches deep sleep, and waking from it can leave you groggy for a while.');
  else if (s.avgMin !== null && s.avgMin <= 30) out.push('Short naps, which is the length that refreshes without grogginess.');
  if (s.late) out.push(`${s.late} started after ${hhmm(LATE)}: late naps make it harder to fall asleep at night.`);
  const n = s.nightAfter;
  if (n) {
    if (Math.abs(n.diffMin) >= 15) out.push(`Nights after a nap you slept ${dur(Math.abs(n.diffMin))} ${n.diffMin < 0 ? 'less' : 'more'} (${dur(n.withNapMin)} against ${dur(n.withoutNapMin)}).`);
    else out.push(`Naps have not cut into your nights: ${dur(n.withNapMin)} asleep after a nap, ${dur(n.withoutNapMin)} without.`);
    if (n.bedtimeDiffMin >= 20) out.push(`On nap days you fell asleep about ${dur(n.bedtimeDiffMin)} later (${n.bedtimeWithNap} against ${n.bedtimeWithout}).`);
  }
  return out;
}
