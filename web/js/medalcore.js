/* ============================================================
   health.ojee.net — what earns a medal. No DOM: the server
   (server/medals.js) and the workout logger in the page use the
   same rules, so a medal seen while lifting is the one kept.

   A medal is for beating yourself, in three widths of the past:
     gold    better than ever before
     silver  the best in a year (but not ever)
     bronze  the best in 90 days (but not in a year)
   Nothing is awarded for a first time: there has to be something
   to beat, inside that window. Each kind of best gives one medal,
   the highest it reaches.

   A "performance" is a flat object: kind -> number, plus `kgReps`
   (each working set's [kg, reps]) for the reps-at-a-weight medal.
   ============================================================ */

export const DAY = 86_400_000;
/** Each tier and how far back it looks (ms). */
export const TIERS = [['gold', Infinity], ['silver', 365 * DAY], ['bronze', 90 * DAY]];
export const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };

/** Every kind of best: what is better, its unit, and what it is called. */
export const KINDS = {
  heaviest: { more: true, unit: 'kg', label: 'Heaviest weight' },
  e1rm: { more: true, unit: 'kg', label: 'Best estimated 1-rep max' },
  reps_at: { more: true, unit: 'reps', label: 'Most reps at a weight' },
  volume: { more: true, unit: 'kg', label: 'Most volume' },
  set_reps: { more: true, unit: 'reps', label: 'Most reps in a set' },
  hold: { more: true, unit: 's', label: 'Longest set' },
  session_volume: { more: true, unit: 'kg', label: 'Most weight lifted in a workout' },
  distance: { more: true, unit: 'm', label: 'Longest distance' },
  duration: { more: true, unit: 's', label: 'Longest time' },
  // Fastest stretch of a distance, from the GPS track (seconds: lower is better).
  effort: { more: false, unit: 's', label: 'Fastest' },
};
const EPS = 1e-6;

/** Estimated one-rep max (Epley), to 0.1 kg; only for 1–12 reps of a real weight. */
export function e1rm(kg, reps) {
  if (!(kg > 0) || !Number.isFinite(reps) || reps < 1 || reps > 12) return null;
  return Math.round(kg * (1 + reps / 30) * 10) / 10;
}

const better = (kind, a, b) => (KINDS[kind.split(':')[0]].more ? a > b + EPS : a < b - EPS);
const fin = Number.isFinite;

/**
 * One session of one exercise, from its sets ({ type, kg, reps, durationS }):
 * its bests and each working set's [kg, reps]. Warm-ups never count.
 */
export function strengthPerf(sets) {
  const p = { kgReps: [] };
  let vol = 0;
  for (const s of sets) {
    if (!s || s.type === 'warmup') continue;
    const kg = Number(s.kg) || 0; const reps = Number(s.reps) || 0;
    if (kg > 0 && reps >= 1) {
      if (!(p.heaviest >= kg)) p.heaviest = kg;
      const e = e1rm(kg, reps);
      if (e !== null && !(p.e1rm >= e)) p.e1rm = e;
      vol += kg * reps;
      p.kgReps.push([kg, reps]);
    } else if (reps >= 1) {
      if (!(p.set_reps >= reps)) p.set_reps = reps;
    }
    if (fin(s.durationS) && s.durationS > 0 && !(reps >= 1) && !(kg > 0)) { if (!(p.hold >= s.durationS)) p.hold = s.durationS; }
  }
  if (vol > 0) p.volume = Math.round(vol * 10) / 10;
  return p;
}

/**
 * The best of earlier sessions inside each tier's window, as of time `t`:
 * { gold: digest | null, silver: …, bronze: … }; null where nothing was done
 * in that window. `priors`: [{ t, p }] (earlier performances).
 */
export function digest(priors, t) {
  const out = {};
  for (const [tier, span] of TIERS) {
    const inW = priors.filter((x) => x.t < t && t - x.t <= span);
    if (!inW.length) { out[tier] = null; continue; }
    const d = { n: inW.length, kgReps: [] };
    for (const { p } of inW) {
      for (const [k, v] of Object.entries(p)) {
        if (k === 'kgReps' || !fin(v)) continue;
        if (d[k] === undefined || better(k, v, d[k])) d[k] = v;
      }
      for (const kr of p.kgReps || []) d.kgReps.push(kr);
    }
    d.kgReps = compactKgReps(d.kgReps);
    out[tier] = d;
  }
  return out;
}

/** [[kg, most reps at exactly that kg]], heaviest first: all that reps-at-a-weight needs. */
export function compactKgReps(list) {
  const m = new Map();
  for (const [kg, reps] of list) if (!(m.get(kg) >= reps)) m.set(kg, reps);
  return [...m.entries()].sort((a, b) => b[0] - a[0]);
}

/** Most reps done before at this weight or heavier, from a compacted list; null if never. */
function repsAtOrAbove(kgReps, kg) {
  let best = null;
  for (const [k, r] of kgReps) { if (k < kg - EPS) break; if (best === null || r > best) best = r; }
  return best;
}

/**
 * The medals a performance earns against a digest: one per kind of best, the
 * highest tier it reaches. [{ tier, kind, value, previous, kg? }].
 */
export function medalsOf(p, dg) {
  const out = [];
  for (const [kind, v] of Object.entries(p)) {
    if (kind === 'kgReps' || !fin(v)) continue;
    for (const [tier] of TIERS) {
      const d = dg[tier];
      if (!d || !fin(d[kind])) continue;
      if (better(kind, v, d[kind])) { out.push({ tier, kind, value: v, previous: d[kind] }); break; }
    }
  }
  // Reps at a weight: the set that beat the most reps ever done at that weight or
  // heavier. The best one: highest tier, then the heaviest.
  // A weight that already has its own heaviest-ever medal is not chosen for this one.
  const heavyKg = out.find((m) => m.kind === 'heaviest')?.value;
  let pick = null;
  for (const [kg, reps] of p.kgReps || []) {
    if (kg === heavyKg) continue;
    for (const [tier] of TIERS) {
      const d = dg[tier];
      if (!d) continue;
      const prev = repsAtOrAbove(d.kgReps, kg);
      if (prev === null || reps <= prev) continue;
      const m = { tier, kind: 'reps_at', value: reps, previous: prev, kg };
      if (!pick || TIER_RANK[tier] > TIER_RANK[pick.tier] || (tier === pick.tier && kg > pick.kg)) pick = m;
      break;
    }
  }
  if (pick) out.push(pick);
  return curate(out).sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
}

/* What one lift is about is said once: a heavier weight than ever, and more reps at
   a (lighter) weight, are two feats; a higher estimated max says the same as either,
   so it counts only without them. A run or ride: the longest by time only when it is
   not the longest by distance too. Many medals for one thing are noise. */
function curate(list) {
  const heavy = list.find((m) => m.kind === 'heaviest');
  const reps = list.find((m) => m.kind === 'reps_at' && !(heavy && heavy.value === m.kg));
  const dist = list.find((m) => m.kind === 'distance');
  return list.filter((m) => (m.kind === 'e1rm' ? !heavy && !reps : m.kind === 'reps_at' ? m === reps : m.kind === 'duration' ? !dist : true));
}

/** Medal counts by tier. */
export function tally(medals) {
  const t = { gold: 0, silver: 0, bronze: 0 };
  for (const m of medals || []) t[m.tier] += 1;
  return t;
}
