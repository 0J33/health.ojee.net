/* ============================================================
   health.ojee.net — what the AI is told about a workout and about recovery,
   worked out here, not left to the model to guess.

   A model reading a one-line summary of a run cannot see that it was
   intervals, that the pace faded, or that last night's bedtime was two hours
   late. So the app measures it and says it in plain facts:

     workoutAnalysis()   the session's structure (steady, intervals with the
                         bouts and recoveries, a tempo, a fade), pacing by
                         kilometre and by half, heart-rate drift, zones, and
                         how it compares with the person's similar sessions
     sleepTiming()       bed and wake times night by night, how regular, late nights
     recoveryDrivers()   for today's recovery and HRV: the candidate causes in
                         their own data (a late or short night, an irregular
                         week, a hard session, several days in a row), each
                         with its evidence and a strength, strongest first
   ============================================================ */

import { addDays, utcOffsetSec } from './core/util.js';

const fin = Number.isFinite;
const avg = (v) => { const x = v.filter(fin); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null; };
const med = (v) => { const x = v.filter(fin).sort((a, b) => a - b); return x.length ? x[Math.floor(x.length / 2)] : null; };
const sd = (v) => { const x = v.filter(fin); if (x.length < 3) return null; const m = avg(x); return Math.sqrt(avg(x.map((y) => (y - m) ** 2))); };
const mmss = (s) => (fin(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '-');
const pace = (kmh) => (fin(kmh) && kmh > 0.5 ? `${mmss(3600 / kmh)}/km` : '-');
const hhmm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

/* ── a workout ──────────────────────────────────────────────────── */

/**
 * Hard and easy stretches of a session, from its speed (a route) or its heart rate: alternating
 * runs of at least 40 s each side of the middle between its quiet and its busy quarter.
 * @param {Array<[number, number]>} pts  [seconds from start, value]
 */
function boutsOf(pts, { minS = 40, spread = 0.18 } = {}) {
  const v = pts.map((p) => p[1]).filter(fin).sort((a, b) => a - b);
  if (v.length < 12) return null;
  const q1 = v[Math.floor(v.length * 0.25)]; const q3 = v[Math.floor(v.length * 0.75)]; const mid = (q1 + q3) / 2;
  if (!(q3 > 0) || (q3 - q1) / mid < spread) return { steady: true };
  // Each sample stands for the time until the next one.
  const step = med(pts.slice(1).map((p, i) => p[0] - pts[i][0])) || 0;
  const segs = [];
  for (const [t, x] of pts) {
    if (!fin(x)) continue;
    const hi = x >= mid;
    const last = segs.at(-1);
    if (last && last.hi === hi) { last.t1 = t; last.v.push(x); } else segs.push({ hi, t0: t, t1: t, v: [x] });
  }
  for (const s of segs) s.t1 += step;
  // Short wobbles join their neighbours.
  const merged = [];
  for (const s of segs) {
    const last = merged.at(-1);
    if (last && (s.t1 - s.t0 < minS || last.hi === s.hi)) { last.t1 = s.t1; last.v.push(...s.v); } else merged.push({ ...s });
  }
  const hard = merged.filter((s) => s.hi && s.t1 - s.t0 >= minS);
  const easy = merged.filter((s) => !s.hi && s.t1 - s.t0 >= minS);
  if (hard.length < 3 || easy.length < 2) return { steady: true };
  return {
    steady: false, n: hard.length,
    hardS: med(hard.map((s) => s.t1 - s.t0)), easyS: med(easy.filter((s) => s.t0 > hard[0].t0 && s.t1 < hard.at(-1).t1).map((s) => s.t1 - s.t0)) ?? med(easy.map((s) => s.t1 - s.t0)),
    hardV: avg(hard.map((s) => avg(s.v))), easyV: avg(easy.map((s) => avg(s.v))),
    first: hard[0], last: hard.at(-1),
  };
}

/**
 * Plain facts about one workout, for the AI's detail section.
 * @param {object} d        views.workoutDetail() of it (trace, track with series and splits, zones)
 * @param {object[]} similar  earlier sessions of the same sport: { start, minutes, distanceM, avgHr, paceSPerKm }
 * @param {string} [tz]       their time zone, so the start time is theirs
 */
export function workoutAnalysis(d, similar = [], tz = null) {
  if (!d) return '';
  const out = [];
  const minutes = Math.round(((d.end ?? d.start) - d.start) / 60_000);
  const tr = d.track;
  const series = Array.isArray(tr?.series) ? tr.series : [];
  const trace = Array.isArray(d.trace) ? d.trace.filter((x) => fin(x[1])) : [];
  const t0 = d.start;

  // Its structure: from speed when there is a route, else from heart rate.
  let shape = null;
  if (series.length > 20) {
    const b = boutsOf(series.map((s) => [s[3], s[2]]));
    if (b && !b.steady) {
      const hrIn = (on) => { const xs = series.filter((s) => fin(s[4]) && (s[2] >= (b.hardV + b.easyV) / 2) === on).map((s) => s[4]); return xs.length ? Math.round(avg(xs)) : null; };
      shape = `INTERVALS: ${b.n} faster bouts of about ${mmss(b.hardS)} at about ${pace(b.hardV)}${hrIn(true) ? ` (HR about ${hrIn(true)})` : ''}, with about ${mmss(b.easyS)} easier between at about ${pace(b.easyV)}${hrIn(false) ? ` (HR about ${hrIn(false)})` : ''}. The pace in the last bout against the first: ${pace(avg(b.last.v))} vs ${pace(avg(b.first.v))}.`;
    } else if (b?.steady) shape = 'STEADY: an even effort, no clear intervals.';
  }
  if (!shape && trace.length > 12) {
    const b = boutsOf(trace.map((x) => [(x[0] - t0) / 1000, x[1]]), { minS: 50, spread: 0.1 });
    if (b && !b.steady) shape = `INTERVALS (from heart rate; no route to measure pace): heart rate rose ${b.n} times to about ${Math.round(b.hardV)} bpm for about ${mmss(b.hardS)}, falling to about ${Math.round(b.easyV)} between, for about ${mmss(b.easyS)}.`;
    else if (b?.steady) shape = 'STEADY by heart rate: an even effort.';
  }
  out.push(`Structure: ${shape || 'not measurable (no route and no minute-by-minute heart rate)'}`);

  // Pacing: kilometres, halves, and how heart rate drifted at the same effort.
  if (tr) {
    out.push(`Distance ${(tr.distanceM / 1000).toFixed(2)} km, moving ${mmss(tr.movingS)} of ${mmss(tr.elapsedS)} (${Math.round(((tr.elapsedS - tr.movingS) / Math.max(1, tr.elapsedS)) * 100)}% stopped), average pace ${mmss(tr.paceSPerKm)}/km${fin(tr.elevGainM) ? `, climb ${tr.elevGainM} m` : ''}.`);
    const sp = (tr.splits || []).filter((s) => !s.partial);
    if (sp.length) out.push(`By kilometre: ${sp.map((s) => `${s.n}: ${mmss(s.paceSPerKm)}${fin(s.hr) ? ` @${s.hr}` : ''}`).join(', ')}.`);
    if (series.length > 20) {
      const half = Math.floor(series.length / 2);
      const a = series.slice(0, half); const b = series.slice(half);
      const pa = avg(a.map((s) => s[2])); const pb = avg(b.map((s) => s[2]));
      const ha = avg(a.map((s) => s[4])); const hb = avg(b.map((s) => s[4]));
      out.push(`First half against second: pace ${pace(pa)} then ${pace(pb)}${fin(ha) && fin(hb) ? `, heart rate ${Math.round(ha)} then ${Math.round(hb)} bpm` : ''}${fin(pa) && fin(pb) ? ` (${pb > pa * 1.03 ? 'a negative split: faster at the end' : pb < pa * 0.97 ? 'it faded: slower at the end' : 'even'})` : ''}.`);
      if (fin(ha) && fin(hb) && fin(pa) && fin(pb) && Math.abs(pb - pa) / pa < 0.05 && hb - ha >= 5) out.push(`Heart-rate drift: +${Math.round(hb - ha)} bpm at the same pace in the second half (heat, too little water, or the effort was above their easy level).`);
    }
  }
  if (trace.length) {
    const hrs = trace.map((x) => x[1]);
    out.push(`Heart rate: average ${Math.round(avg(hrs))}, highest ${Math.max(...hrs)} bpm.`);
  }
  if (d.zones?.minutes) out.push(`Minutes in heart-rate zones (light, moderate, vigorous, peak): ${d.zones.minutes.join(', ')}.`);
  out.push(`Time of day: started ${new Date(d.start + (tz ? utcOffsetSec(d.start, tz) : 0) * 1000).toISOString().slice(11, 16)}${tz ? ' their local time' : ' UTC'}, lasted ${minutes} min.`);

  // Against their own similar sessions.
  const prev = similar.filter((s) => s.start < d.start).slice(-6);
  if (prev.length) {
    const p = avg(prev.map((s) => s.paceSPerKm)); const h = avg(prev.map((s) => s.avgHr)); const km = avg(prev.map((s) => (s.distanceM || 0) / 1000)); const mins = avg(prev.map((s) => s.minutes));
    out.push(`Their last ${prev.length} similar sessions averaged ${fin(km) && km > 0 ? `${km.toFixed(1)} km, ` : ''}${Math.round(mins)} min${fin(p) ? `, pace ${mmss(p)}/km` : ''}${fin(h) ? `, HR ${Math.round(h)}` : ''}.${fin(p) && fin(h) && tr?.paceSPerKm && trace.length ? ` This one: pace ${mmss(tr.paceSPerKm)}/km at HR ${Math.round(avg(trace.map((x) => x[1])))}: ${tr.paceSPerKm < p * 0.98 && avg(trace.map((x) => x[1])) <= h + 3 ? 'faster for the same heart rate, fitter' : tr.paceSPerKm > p * 1.02 && avg(trace.map((x) => x[1])) >= h - 3 ? 'slower for the same heart rate (tired, hot, or a harder route)' : 'about the same efficiency'}.` : ''}`);
  } else out.push('No earlier similar sessions to compare with.');
  return out.join('\n');
}

/* ── sleep timing and what drives recovery ─────────────────────── */

const ofDay = (ms, o) => { const x = new Date(ms + (o || 0) * 1000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
/** Bedtime as minutes from noon, so 23:30 and 01:00 compare the right way round. */
const bedOf = (n) => { const m = ofDay(n.startMs, n.startOff); return m < 12 * 60 ? m + 1440 : m; };

/** Bed and wake times, night by night, and how regular they are. */
export function sleepTiming(nights, today) {
  const by = {}; for (const n of nights) if (n.main && (!by[n.date] || n.asleepMin > by[n.date].asleepMin)) by[n.date] = n;
  const last7 = []; for (let i = 0; i < 7; i += 1) { const d = addDays(today, -i); if (by[d]) last7.push(by[d]); }
  const last30 = Object.values(by).filter((n) => n.date >= addDays(today, -30));
  if (!last7.length) return '';
  const lines = last7.map((n) => `- night ending ${n.date}: bed ${hhmm(bedOf(n))}, up ${hhmm(ofDay(n.endMs, n.endOff))}, asleep ${Math.floor(n.asleepMin / 60)}h${String(Math.round(n.asleepMin % 60)).padStart(2, '0')}m`);
  const s7 = sd(last7.map(bedOf)); const s30 = sd(last30.map(bedOf));
  const late = last7.filter((n) => bedOf(n) >= 1440 + 60).length;
  return `${lines.join('\n')}\nBedtime varies by about ${fin(s7) ? Math.round(s7) : '-'} min this week (usual spread over 30 days: ${fin(s30) ? Math.round(s30) : '-'} min). Nights in bed after 01:00 this week: ${late}. Usual bedtime ${hhmm(med(last30.map(bedOf)))}, usual wake ${hhmm(med(last30.map((n) => ofDay(n.endMs, n.endOff))))}.`;
}

/**
 * Candidate causes of today's recovery and HRV, from their own data, strongest first.
 * @param {object} o  { nights, table (daily by date), today, sessions: [{ start, end, avgHr, minutes, date }], restHr }
 */
export function recoveryDrivers({ nights, table, today, sessions = [], restHr = null }) {
  const by = {}; for (const n of nights) if (n.main && (!by[n.date] || n.asleepMin > by[n.date].asleepMin)) by[n.date] = n;
  const hist = Object.values(by).filter((n) => n.date < today && n.date >= addDays(today, -30));
  const last = by[today] || by[addDays(today, -1)];
  const out = [];
  const add = (strength, text) => out.push({ strength, text });
  const hrvToday = table[today]?.hrv ?? table[addDays(today, -1)]?.hrv;
  const hrv30 = avg(Object.entries(table).filter(([d]) => d < today && d >= addDays(today, -30)).map(([, r]) => r.hrv));
  const rhrToday = table[today]?.rhr; const rhr30 = avg(Object.entries(table).filter(([d]) => d < today && d >= addDays(today, -30)).map(([, r]) => r.rhr));
  const head = [];
  if (fin(hrvToday) && fin(hrv30)) head.push(`HRV ${Math.round(hrvToday)} ms vs usual ${Math.round(hrv30)} (${Math.round(((hrvToday - hrv30) / hrv30) * 100)}%)`);
  if (fin(rhrToday) && fin(rhr30)) head.push(`resting HR ${Math.round(rhrToday)} vs usual ${Math.round(rhr30)}`);
  if (last && hist.length >= 5) {
    const lateBy = bedOf(last) - med(hist.map(bedOf));
    if (lateBy >= 45) add(lateBy >= 90 ? 3 : 2, `Bedtime last night was ${Math.round(lateBy)} min later than usual (${hhmm(bedOf(last))} vs ${hhmm(med(hist.map(bedOf)))}); a late night lowers HRV the next morning.`);
    const short = avg(hist.map((n) => n.asleepMin)) - last.asleepMin;
    if (short >= 45) add(short >= 90 ? 3 : 2, `Last night was ${Math.round(short)} min shorter than usual (${Math.round(last.asleepMin)} min asleep).`);
  }
  const week = []; for (let i = 0; i < 7; i += 1) { const n = by[addDays(today, -i)]; if (n) week.push(n); }
  const s7 = sd(week.map(bedOf)); const s30 = sd(hist.map(bedOf));
  if (fin(s7) && s7 >= 45 && (!fin(s30) || s7 >= s30 * 1.2)) add(s7 >= 75 ? 3 : 2, `An irregular sleep schedule this week: bedtime varied by about ${Math.round(s7)} min (usual ${fin(s30) ? Math.round(s30) : '?'}). Irregular bedtimes alone pull HRV down.`);
  const shortNights = week.filter((n) => n.asleepMin < 6 * 60).length;
  if (shortNights >= 2) add(2, `${shortNights} nights under 6 h this week: a sleep debt.`);
  const recent = sessions.filter((s) => s.date >= addDays(today, -2) && s.date < today);
  const hard = recent.filter((s) => fin(s.avgHr) && fin(restHr) && s.avgHr - restHr >= 70 && s.minutes >= 30);
  if (hard.length) add(hard.length >= 2 ? 2 : 1, `Hard training in the last two days: ${hard.map((s) => `${s.minutes} min at avg HR ${Math.round(s.avgHr)} on ${s.date}`).join('; ')}.`);
  const daysInRow = (() => { let k = 0; for (let i = 1; i <= 7; i += 1) { if (sessions.some((s) => s.date === addDays(today, -i) && s.minutes >= 20)) k += 1; else break; } return k; })();
  if (daysInRow >= 4) add(1, `${daysInRow} training days in a row without a rest day.`);
  out.sort((a, b) => b.strength - a.strength);
  if (!head.length && !out.length) return '';
  return `${head.length ? `${head.join('; ')}.\n` : ''}${out.length ? out.map((x) => `- [${['', 'weak', 'likely', 'strong'][x.strength]}] ${x.text}`).join('\n') : '- nothing in their data stands out: a normal day-to-day dip.'}`;
}
