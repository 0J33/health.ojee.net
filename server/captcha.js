/* ============================================================
   health.ojee.net — the code to type when creating an account.

   Five digits drawn as wobbly pen strokes in an SVG made of paths
   only (no <text>, so the answer is not in the page), crossed by a
   few stray lines. Nothing is kept per challenge until it is used:
   the token carries its expiry and a nonce, signed with the answer
   under a key that lives only in this process. Each token works once,
   not before MIN_MS (a person needs a moment to read it) and not
   after TTL_MS. A restart forgets the key, so an open form simply
   asks for the new code.
   ============================================================ */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TTL_MS = 10 * 60_000;
export const MIN_MS = 1_500;
const LEN = 5;
const DIGITS = '23456789'; // no 0 or 1: they read as letters

/* Each digit on a 10 × 16 grid: strokes of points, `s` = straight, else smoothed. */
const GLYPH = {
  2: [{ p: [[1, 3], [4, 0], [8, 1], [9, 4], [7, 8], [0, 16]] }, { s: 1, p: [[0, 16], [10, 16]] }],
  3: [{ p: [[1, 1], [5, 0], [9, 2], [8, 6], [4, 8]] }, { p: [[4, 8], [9, 10], [9, 14], [5, 16], [0, 14]] }],
  4: [{ s: 1, p: [[2, 0], [0, 10], [10, 10]] }, { s: 1, p: [[7, 4], [7, 16]] }],
  5: [{ s: 1, p: [[9, 0], [2, 0], [1, 7]] }, { p: [[1, 7], [5, 6], [9, 8], [9, 13], [5, 16], [0, 14]] }],
  6: [{ p: [[8, 1], [4, 0], [1, 5], [0, 11], [2, 15], [6, 16], [9, 13], [8, 9], [4, 8], [0, 11]] }],
  7: [{ s: 1, p: [[0, 0], [10, 0], [4, 16]] }],
  8: [{ p: [[5, 8], [1, 5], [2, 1], [5, 0], [8, 1], [9, 5], [5, 8], [0, 11], [1, 15], [5, 16], [9, 15], [10, 11], [5, 8]] }],
  9: [{ p: [[9, 5], [6, 8], [2, 7], [1, 3], [4, 0], [8, 1], [9, 5], [9, 11], [6, 16], [2, 15]] }],
};

const rnd = (a, b) => a + (randomInt(0, 1_000_001) / 1_000_000) * (b - a);
const n1 = (v) => Math.round(v * 10) / 10;

/** Catmull-Rom through the points, as cubic Béziers. */
function smooth(pts) {
  let d = `M${n1(pts[0][0])} ${n1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${n1(c1[0])} ${n1(c1[1])} ${n1(c2[0])} ${n1(c2[1])} ${n1(p2[0])} ${n1(p2[1])}`;
  }
  return d;
}
const straight = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n1(x)} ${n1(y)}`).join(' ');

/** The picture of a code: an SVG string, drawn in currentColor. */
export function drawCode(code) {
  const W = 200; const H = 64;
  const paths = [];
  let x = 14;
  for (const ch of code) {
    const s = rnd(2.3, 2.8); const rot = rnd(-0.32, 0.32); const skew = rnd(-0.18, 0.18);
    const ox = x + rnd(-2, 2); const oy = rnd(8, 14);
    const cos = Math.cos(rot); const sin = Math.sin(rot);
    const place = ([px, py]) => {
      const jx = px + rnd(-0.45, 0.45) - 5; const jy = py + rnd(-0.45, 0.45) - 8;
      const sx = (jx + jy * skew) * s; const sy = jy * s;
      return [ox + 12 + sx * cos - sy * sin, oy + 20 + sx * sin + sy * cos];
    };
    for (const st of GLYPH[ch]) {
      const pts = st.p.map(place);
      paths.push(`<path d="${st.s ? straight(pts) : smooth(pts)}" stroke-width="${n1(rnd(2.6, 3.6))}"/>`);
    }
    x += rnd(32, 38);
  }
  // Stray strokes across the digits, thin enough to read through.
  for (let i = 0; i < 4; i += 1) {
    const y0 = rnd(8, H - 8); const y1 = rnd(8, H - 8);
    paths.push(`<path d="M${n1(rnd(0, 20))} ${n1(y0)} C${n1(rnd(40, 90))} ${n1(rnd(0, H))} ${n1(rnd(110, 160))} ${n1(rnd(0, H))} ${n1(rnd(180, W))} ${n1(y1)}" stroke-width="${n1(rnd(1, 1.8))}" opacity="0.75"/>`);
  }
  for (let i = 0; i < 14; i += 1) paths.push(`<circle cx="${n1(rnd(4, W - 4))}" cy="${n1(rnd(4, H - 4))}" r="${n1(rnd(0.8, 1.8))}" fill="currentColor" stroke="none"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths.join('')}</svg>`;
}

export class Captcha {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.key = randomBytes(32);
    this.used = new Map(); // nonce -> expiry
  }
  #sig(exp, nonce, answer) { return createHmac('sha256', this.key).update(`${exp}.${nonce}.${answer}`).digest('base64url'); }

  /** A new challenge: { token, svg }. */
  issue() {
    let code = '';
    for (let i = 0; i < LEN; i += 1) code += DIGITS[randomInt(0, DIGITS.length)];
    const exp = this.now() + TTL_MS;
    const nonce = randomBytes(12).toString('base64url');
    return { token: `${exp}.${nonce}.${this.#sig(exp, nonce, code)}`, svg: drawCode(code), code };
  }

  /** Is this the answer to that token? A token is spent by its first try, right or wrong. */
  check(token, answer) {
    const t = this.now();
    for (const [n, e] of this.used) if (e < t) this.used.delete(n);
    const [expS, nonce, sig] = String(token || '').split('.');
    const exp = Number(expS);
    if (!nonce || !sig || !Number.isFinite(exp) || exp < t || this.used.has(nonce)) return false;
    if (t < exp - TTL_MS + MIN_MS) return false;
    this.used.set(nonce, exp);
    const want = Buffer.from(this.#sig(exp, nonce, String(answer || '').replace(/\s+/g, '')));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
