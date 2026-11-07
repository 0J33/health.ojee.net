/* Loading placeholders shaped exactly like the screen they stand in for.

   When a screen has been seen, its outline is kept: the same cards, tiles
   (in their colours), rows and gaps, with every word turned into blanks and
   every picture, chart and map left out, so nothing personal is kept. The
   next time that screen loads, its outline shows at once, shimmering, over
   the screen being built underneath, and fades out the moment the real one
   is ready. Kept per person, in this browser (localStorage), so a cold start
   has it too. A screen never seen has the hand-drawn skeleton as before. */

const MAX = 24;            // screens kept
/** How light a computed colour is (0 dark … 1 light), and how opaque; null when unreadable. */
function lightOf(color) {
  const c = String(color);
  const m = c.match(/[\d.]+%?/g);
  if (!m || m.length < 3) return null;
  const num = (x) => parseFloat(x) / (x.endsWith('%') ? 100 : 1);
  const slash = c.includes('/') ? num(c.split('/')[1].trim()) : null;
  if (/^ok(lab|lch)\(/.test(c)) return { l: num(m[0]), a: slash ?? 1 };
  const k = c.startsWith('color(') ? 1 : 255;
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = m.slice(0, 3).map((x) => lin(num(x) / k));
  const a = slash ?? (m.length > 3 && /^rgba?\(/.test(c) ? num(m[3]) : 1);
  return { l: Math.cbrt(0.2126 * r + 0.7152 * g + 0.0722 * b), a };
}
/** The bar's tint, only for words on a coloured surface that is not a tile (a tile knows
    its own text colour in either theme, --on, and a plain card follows the theme's ink):
    faint black on a light one, faint white on a deep one. Null where the theme decides. */
const seen = new Map();
function tone(el) {
  if (el.closest('[class*="bt--"]')) return null;
  for (let x = el; x && x.nodeType === 1; x = x.parentElement) {
    if (seen.has(x)) return seen.get(x);
    const cs = getComputedStyle(x).backgroundColor;
    const bg = lightOf(cs);
    if (bg && bg.a > 0.5) {
      const ch = (cs.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const neutral = !/^rgb/.test(cs) || Math.max(...ch) - Math.min(...ch) < 24;
      const t = neutral ? null : bg.l > 0.75 ? '#000' : '#fff';
      seen.set(x, t);
      return t;
    }
  }
  return null;
}
const WORDS = new Set(['span', 'b', 'small', 'strong', 'em', 'a', 'label', 'p', 'h1', 'h2', 'h3', 'h4', 'li', 'time']);
const LIMIT = 160_000;     // characters of outline per screen
let who = '';
let store = null;

const key = () => `health.ghosts.${who}`;
function load() {
  if (store) return store;
  try { store = JSON.parse(localStorage.getItem(key()) || '{}') || {}; } catch { store = {}; }
  return store;
}
function save() {
  const s = load();
  const keys = Object.keys(s).sort((a, b) => s[a].at - s[b].at);
  while (keys.length > MAX) delete s[keys.shift()];
  for (let tries = 0; tries < 6; tries += 1) {
    try { localStorage.setItem(key(), JSON.stringify(s)); return; } catch {
      // Full: let the oldest go.
      const k = Object.keys(s).sort((a, b) => s[a].at - s[b].at)[0];
      if (!k) return;
      delete s[k];
    }
  }
}

/** Whose outlines: one person's are never shown to another on the same phone. */
export function ghostsFor(username) {
  if (username === who) return;
  who = username || ''; store = null;
}

/** Still loading: a placeholder, a busy mark, a spinner. */
export const busy = (root) => Boolean(root.querySelector('[aria-busy="true"], .skelstack, .skel, .feed__skel'));

/** Keep the outline of `root` (a screen, fully drawn) for `path`. */
export function capture(path, root) {
  if (!who || !root?.isConnected || !root.childElementCount || busy(root)) return;
  seen.clear();
  const clone = root.cloneNode(true);
  const from = [root, ...root.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  for (let i = to.length - 1; i >= 0; i -= 1) {
    const o = from[i]; const c = to[i];
    const tag = c.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || c.matches('dialog, .toast, .pinned[hidden]')) { c.remove(); continue; }
    // Fields and switches too: a box their size, not an empty field with its border and arrow.
    const field = ['input', 'select', 'textarea'].includes(tag) && o.type !== 'hidden' && !o.closest('.switch');
    if (['img', 'video', 'canvas', 'iframe', 'picture'].includes(tag) || field || c.matches('.map, .chart, .spark, .heat, .switch')) {
      // Pictures, charts and maps: a soft box the same size.
      const r = o.getBoundingClientRect();
      const box = document.createElement('span');
      box.className = `gbox ${c.matches('.avatar__img') ? 'gbox--round' : c.matches('.switch') ? 'gbox--pill' : ''}`;
      const t = tone(o.parentElement || o);
      box.style.cssText = `width:${Math.round(r.width)}px;height:${Math.round(r.height)}px${t ? `;--gk:${t}` : ''}`;
      c.replaceWith(box);
      continue;
    }
    if (tag === 'svg') { const r = o.getBoundingClientRect(); c.innerHTML = ''; c.setAttribute('width', Math.round(r.width)); c.setAttribute('height', Math.round(r.height)); }
    for (const a of [...c.attributes]) {
      const n = a.name;
      if (n === 'id' || n === 'href' || n === 'src' || n === 'srcset' || n === 'poster' || n === 'value' || n === 'name' || n === 'for' || n === 'title'
        || n === 'aria-label' || n === 'alt' || n === 'tabindex' || n.startsWith('on') || (n.startsWith('data-') && n !== 'data-theme')) c.removeAttribute(n);
    }
    if (tag === 'input' || tag === 'textarea') c.setAttribute('placeholder', '');
    // Words become bars tinted from the colour they were written in, so a bar on a
    // coloured tile is a lighter shade of that tile, not a beige (or brown) block.
    if (!c.childElementCount && c.textContent.trim() && WORDS.has(tag)) { const t = tone(o); if (t) c.style.setProperty('--gk', t); }
  }
  // Every word becomes blanks of the same length, so lines break as they did.
  const walk = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(/\S/g, 'x');
  const html = clone.innerHTML;
  if (html.length > LIMIT) return;
  load()[path] = { html, at: Date.now() };
  save();
}

/** The outline kept for `path`, or null. */
export function ghostOf(path) {
  if (!who) return null;
  return load()[path]?.html || null;
}

/** Signed out: nobody's outlines are shown. */
export function dropGhosts() {
  try { localStorage.removeItem(key()); } catch { /* fine */ }
  store = null; who = '';
}
