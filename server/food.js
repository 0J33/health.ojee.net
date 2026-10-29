/* ============================================================
   health.ojee.net — looking food up.

   Google Health keeps a food database but lets no write-only caller
   read it (docs/DATA-TYPES.md), so food is looked up elsewhere:

     your foods        what the person logged before, by name, with the
                       numbers they used: first, because people eat the
                       same things.
     common foods      a short built-in list of plain foods (per 100 g,
                       rounded from public nutrition tables), so rice,
                       an egg or a banana answers instantly and offline.
     Open Food Facts   the open product database (openfoodfacts.org,
                       ODbL): packaged food by name or by barcode, with
                       calories and macros per 100 g and per serving.

   Search: search.openfoodfacts.org/search?q=  (the newer search; the
   old cgi/search.pl is often down). Barcode: world.openfoodfacts.org/
   api/v2/product/<code>. Their rules ask for a User-Agent that names
   the app and for few calls: results are cached for a day, at most one
   search per person every two seconds, and a timeout of eight seconds.
   ============================================================ */

const SEARCH = 'https://search.openfoodfacts.org/search';
const PRODUCT = 'https://world.openfoodfacts.org/api/v2/product';
const UA = 'health.ojee.net/1.0 (https://health.ojee.net)';
const FIELDS = 'code,product_name,product_name_en,brands,nutriments,serving_size,serving_quantity,quantity';
const TTL = 24 * 3_600_000;

/** Plain foods per 100 g: [name, kcal, protein, carbs, fat, a usual portion in g, its name]. */
const COMMON = [
  ['Apple', 52, 0.3, 14, 0.2, 180, '1 medium'], ['Banana', 89, 1.1, 23, 0.3, 120, '1 medium'], ['Orange', 47, 0.9, 12, 0.1, 150, '1 medium'],
  ['Dates', 282, 2.5, 75, 0.4, 24, '3 dates'], ['Grapes', 69, 0.7, 18, 0.2, 100, '1 cup'], ['Strawberries', 32, 0.7, 8, 0.3, 150, '1 cup'],
  ['Avocado', 160, 2, 9, 15, 100, 'half'], ['Watermelon', 30, 0.6, 8, 0.2, 280, '1 slice'], ['Mango', 60, 0.8, 15, 0.4, 165, '1 cup'],
  ['Egg, boiled', 155, 13, 1.1, 11, 50, '1 large'], ['Egg, fried', 196, 14, 0.8, 15, 46, '1 large'], ['Egg white', 52, 11, 0.7, 0.2, 33, '1 large'],
  ['Chicken breast, cooked', 165, 31, 0, 3.6, 150, '1 breast'], ['Chicken thigh, cooked', 209, 26, 0, 11, 120, '1 thigh'],
  ['Beef, minced, cooked', 250, 26, 0, 17, 120, '1 portion'], ['Steak, cooked', 271, 25, 0, 19, 180, '1 steak'],
  ['Salmon, cooked', 206, 22, 0, 12, 150, '1 fillet'], ['Tuna, canned in water', 116, 26, 0, 0.8, 120, '1 can'],
  ['Shrimp, cooked', 99, 24, 0.2, 0.3, 100, '1 portion'], ['Turkey breast, cooked', 135, 30, 0, 1, 100, '1 portion'],
  ['White rice, cooked', 130, 2.7, 28, 0.3, 160, '1 cup'], ['Brown rice, cooked', 123, 2.7, 26, 1, 160, '1 cup'],
  ['Pasta, cooked', 158, 5.8, 31, 0.9, 180, '1 cup'], ['Oats, dry', 389, 17, 66, 7, 40, '1/2 cup'], ['Bread, white', 265, 9, 49, 3.2, 30, '1 slice'],
  ['Bread, whole wheat', 247, 13, 41, 3.4, 32, '1 slice'], ['Pita bread', 275, 9, 56, 1.2, 60, '1 pita'], ['Potato, boiled', 87, 1.9, 20, 0.1, 170, '1 medium'],
  ['Sweet potato, baked', 90, 2, 21, 0.2, 130, '1 medium'], ['French fries', 312, 3.4, 41, 15, 117, '1 medium portion'],
  ['Lentils, cooked', 116, 9, 20, 0.4, 200, '1 cup'], ['Chickpeas, cooked', 164, 8.9, 27, 2.6, 160, '1 cup'], ['Fava beans (ful), cooked', 110, 7.6, 20, 0.4, 170, '1 cup'],
  ['Hummus', 166, 7.9, 14, 9.6, 30, '2 tbsp'], ['Falafel', 333, 13, 32, 18, 17, '1 piece'], ['Tahini', 595, 17, 21, 54, 15, '1 tbsp'],
  ['Milk, whole', 61, 3.2, 4.8, 3.3, 244, '1 cup'], ['Milk, skimmed', 34, 3.4, 5, 0.1, 245, '1 cup'], ['Greek yogurt, plain', 97, 9, 3.9, 5, 170, '1 pot'],
  ['Yogurt, low fat', 63, 5.3, 7, 1.6, 170, '1 pot'], ['Cheddar cheese', 403, 25, 1.3, 33, 28, '1 slice'], ['Feta cheese', 264, 14, 4, 21, 30, '1 portion'],
  ['Cottage cheese', 98, 11, 3.4, 4.3, 113, '1/2 cup'], ['Butter', 717, 0.9, 0.1, 81, 14, '1 tbsp'], ['Olive oil', 884, 0, 0, 100, 14, '1 tbsp'],
  ['Peanut butter', 588, 25, 20, 50, 32, '2 tbsp'], ['Almonds', 579, 21, 22, 50, 28, '1 handful'], ['Walnuts', 654, 15, 14, 65, 28, '1 handful'],
  ['Whey protein powder', 400, 80, 8, 6, 30, '1 scoop'], ['Protein bar', 360, 30, 35, 12, 60, '1 bar'],
  ['Broccoli, cooked', 35, 2.4, 7, 0.4, 150, '1 cup'], ['Salad, mixed greens', 17, 1.4, 3, 0.2, 85, '1 bowl'], ['Tomato', 18, 0.9, 3.9, 0.2, 120, '1 medium'],
  ['Cucumber', 15, 0.7, 3.6, 0.1, 150, '1/2 cucumber'], ['Carrot', 41, 0.9, 10, 0.2, 60, '1 medium'], ['Spinach, cooked', 23, 3, 3.8, 0.3, 180, '1 cup'],
  ['Pizza, cheese', 266, 11, 33, 10, 107, '1 slice'], ['Burger, beef', 254, 13, 24, 12, 215, '1 burger'], ['Shawarma, chicken', 220, 15, 20, 9, 280, '1 wrap'],
  ['Koshari', 160, 5, 28, 3, 400, '1 bowl'], ['Sushi roll', 150, 5, 28, 1.8, 200, '6 pieces'], ['Dark chocolate', 546, 4.9, 61, 31, 20, '2 squares'],
  ['Ice cream', 207, 3.5, 24, 11, 66, '1 scoop'], ['Honey', 304, 0.3, 82, 0, 21, '1 tbsp'], ['Sugar', 387, 0, 100, 0, 4, '1 tsp'],
  ['Orange juice', 45, 0.7, 10, 0.2, 248, '1 glass'], ['Cola', 42, 0, 11, 0, 330, '1 can'], ['Coffee, black', 2, 0.3, 0, 0, 240, '1 cup'],
  ['Coffee with milk', 30, 1.6, 2.4, 1.5, 240, '1 cup'], ['Tea with sugar', 16, 0, 4, 0, 240, '1 cup'], ['Beer', 43, 0.5, 3.6, 0, 330, '1 bottle'],
].map(([name, kcal, protein, carbs, fat, g, portion]) => ({ id: `common:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, source: 'common', name, brand: null, per100: { kcal, protein, carbs, fat }, serving: { g, label: portion } }));

const fin = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/** An Open Food Facts product, or null when it has no calories. */
export function fromOff(p) {
  const n = p?.nutriments || {};
  let kcal = fin(n['energy-kcal_100g']);
  if (kcal === null && fin(n['energy-kj_100g']) !== null) kcal = fin(n['energy-kj_100g']) / 4.184;
  if (kcal === null || kcal < 0 || kcal > 1000) return null;
  const name = String(p.product_name || p.product_name_en || '').trim();
  if (!name) return null;
  const brand = Array.isArray(p.brands) ? p.brands[0] : String(p.brands || '').split(',')[0].trim();
  const sq = fin(p.serving_quantity);
  return {
    id: `off:${String(p.code || '').replace(/\D/g, '')}`, source: 'off', code: String(p.code || ''),
    name: name.slice(0, 100), brand: brand ? brand.slice(0, 60) : null,
    per100: { kcal: round1(kcal), protein: round1(fin(n.proteins_100g)), carbs: round1(fin(n.carbohydrates_100g)), fat: round1(fin(n.fat_100g)) },
    serving: sq && sq > 0 && sq < 2000 ? { g: sq, label: String(p.serving_size || `${sq} g`).slice(0, 40) } : null,
    quantity: p.quantity ? String(p.quantity).slice(0, 40) : null,
  };
}

/** The person's own foods: what they logged, newest choice of numbers per name. */
export function ownFoods(db, { q = '', limit = 12 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const rows = db.samples('food', { fromMs: Date.now() - 365 * 86_400_000, limit: 1000 });
  const byName = new Map();
  for (const r of rows) {
    const name = String(r.data?.name || '').trim();
    if (!name || (needle && !name.toLowerCase().includes(needle))) continue;
    const k = name.toLowerCase();
    const e = byName.get(k);
    if (e) { e.times += 1; continue; }
    byName.set(k, {
      id: `own:${k}`, source: 'own', name, brand: null, times: 1, lastAt: r.t,
      // What they logged was one portion: that is its own serving.
      portion: { kcal: r.value, protein: r.data?.protein ?? null, carbs: r.data?.carbs ?? null, fat: r.data?.fat ?? null },
      meal: r.data?.meal || null, food: r.data?.food || null,
    });
  }
  return [...byName.values()].sort((a, b) => b.times - a.times || b.lastAt - a.lastAt).slice(0, limit);
}

export function commonFoods(q, limit = 8) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return COMMON.slice(0, limit);
  const words = needle.split(/\s+/).filter(Boolean);
  return COMMON.filter((f) => words.every((w) => f.name.toLowerCase().includes(w))).slice(0, limit);
}

export class FoodLookup {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, urls = {} } = {}) {
    this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.urls = { search: SEARCH, product: PRODUCT, ...urls };
    this.cache = new Map();
  }
  #cached(key) { const c = this.cache.get(key); if (c && this.now() - c.at < TTL) return c.value; return undefined; }
  #keep(key, value) {
    this.cache.set(key, { at: this.now(), value });
    if (this.cache.size > 2000) for (const [k] of this.cache) { this.cache.delete(k); if (this.cache.size <= 1500) break; }
  }
  async #get(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    t.unref?.();
    try {
      const res = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) throw Object.assign(new Error(`Open Food Facts answered ${res.status}.`), { code: 'upstream', status: res.status });
      return await res.json();
    } catch (e) {
      if (e.code === 'upstream') throw e;
      throw Object.assign(new Error(e.name === 'AbortError' ? 'Open Food Facts did not answer in time.' : 'Open Food Facts could not be reached.'), { code: 'network' });
    } finally { clearTimeout(t); }
  }

  /** Packaged foods by name, from Open Food Facts. */
  async search(q, { limit = 20 } = {}) {
    const needle = String(q || '').trim().slice(0, 80);
    if (needle.length < 2) return [];
    const key = `s:${needle.toLowerCase()}`;
    const hit = this.#cached(key);
    if (hit !== undefined) return hit;
    const j = await this.#get(`${this.urls.search}?${new URLSearchParams({ q: needle, page_size: String(Math.min(40, limit + 10)), fields: FIELDS })}`);
    const seen = new Set();
    const out = [];
    for (const p of j?.hits || j?.products || []) {
      const f = fromOff(p);
      if (!f) continue;
      const k = `${f.name.toLowerCase()}|${(f.brand || '').toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
      if (out.length >= limit) break;
    }
    this.#keep(key, out);
    return out;
  }

  /** One product by barcode, or null when it is not known. */
  async barcode(code) {
    const c = String(code || '').replace(/\D/g, '');
    if (c.length < 6 || c.length > 14) throw Object.assign(new Error('A barcode is 8 to 14 digits.'), { status: 400, expose: true });
    const key = `b:${c}`;
    const hit = this.#cached(key);
    if (hit !== undefined) return hit;
    let j;
    try { j = await this.#get(`${this.urls.product}/${c}?${new URLSearchParams({ fields: FIELDS })}`); } catch (e) { if (e.status === 404) { this.#keep(key, null); return null; } throw e; }
    const f = j?.status === 1 || j?.product ? fromOff({ code: c, ...(j.product || {}) }) : null;
    this.#keep(key, f);
    return f;
  }
}

/** The numbers of an amount of a food: grams of it, or servings of it. */
export function portionOf(food, { grams = null, servings = null } = {}) {
  if (food.portion && grams === null) {
    const k = servings ?? 1;
    const s = (v) => (v === null || v === undefined ? null : round1(v * k));
    return { kcal: s(food.portion.kcal), protein: s(food.portion.protein), carbs: s(food.portion.carbs), fat: s(food.portion.fat) };
  }
  const g = grams ?? (servings ?? 1) * (food.serving?.g || 100);
  const k = g / 100;
  const p = food.per100 || {};
  const s = (v) => (v === null || v === undefined ? null : round1(v * k));
  return { grams: Math.round(g), kcal: s(p.kcal), protein: s(p.protein), carbs: s(p.carbs), fat: s(p.fat) };
}
