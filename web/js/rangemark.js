/* Where a value sits on a range bar (ranges.js): kept apart so it can be tested alone. */

const fin = Number.isFinite;

/**
 * Where a value sits along equal-width bands, 0 to 100. Inside its band the
 * dot is in proportion: an open bottom of a count (minutes, steps, cm) runs
 * from 0, else it is given the width of the band next to it; an open top fills
 * smoothly, half way at the width of the band before it.
 */
export function markAt(bands, at, v) {
  const n = bands.length;
  if (!n || at < 0 || at >= n || !fin(v)) return null;
  const b = bands[at];
  let lo = b.lo; let hi = b.hi;
  if (lo === null && hi !== null) {
    if (hi > 0 && v >= 0) lo = 0;
    else {
      const nb = bands[at + 1];
      const w = Math.max(nb && fin(nb.hi) && fin(nb.lo) ? nb.hi - nb.lo : 0, Math.abs(hi) * 0.2);
      lo = Math.min(w > 0 ? hi - w : hi - 1, v);
    }
  }
  if (hi === null && lo !== null) {
    // Open at the top: no end to stretch to, so the band fills by d / (d + w), w the width of the band before it.
    const pb = bands[at - 1];
    const w0 = pb && fin(pb.lo) && fin(pb.hi) ? pb.hi - pb.lo : Math.abs(lo) * 0.25;
    const w = w0 > 0 ? w0 : 1; const d = Math.max(0, v - lo);
    return ((at + Math.min(0.96, Math.max(0.04, d / (d + w)))) / n) * 100;
  }
  if (lo === null && hi === null) return 50;
  const inside = hi > lo ? Math.min(0.96, Math.max(0.04, (v - lo) / (hi - lo))) : 0.5;
  return ((at + inside) / n) * 100;
}
