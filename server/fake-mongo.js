/* ============================================================
   health.ojee.net — an in-memory stand-in for the two Mongo
   collections this app uses (`users`, `sessions`).

   For demo mode and the tests, so neither ever touches the real
   accounts database. It implements only the calls accounts.js makes,
   with the driver's shapes: findOne, insertOne, updateOne, deleteOne,
   deleteMany, countDocuments.
   ============================================================ */

import { ObjectId } from 'mongodb';

const same = (a, b) => (a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b);
function matches(doc, query) {
  for (const [k, want] of Object.entries(query || {})) {
    const have = doc[k];
    if (want instanceof RegExp) { if (!want.test(String(have ?? ''))) return false; }
    else if (want && typeof want === 'object' && !(want instanceof ObjectId) && !(want instanceof Date)) {
      if (want.$regex !== undefined) { const re = want.$regex instanceof RegExp ? want.$regex : new RegExp(want.$regex, want.$options || ''); if (!re.test(String(have ?? ''))) return false; }
      else if (want.$lt !== undefined) { if (!(have < want.$lt)) return false; }
      else return false;
    } else if (!same(have, want)) return false;
  }
  return true;
}

class Collection {
  constructor() { this.docs = []; }
  async findOne(q) { const d = this.docs.find((x) => matches(x, q)); return d ? { ...d } : null; }
  async insertOne(doc) { const d = { _id: new ObjectId(), ...doc }; this.docs.push(d); return { acknowledged: true, insertedId: d._id }; }
  async updateOne(q, u) {
    const d = this.docs.find((x) => matches(x, q));
    if (d && u.$set) Object.assign(d, u.$set);
    return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
  }
  async deleteOne(q) { const i = this.docs.findIndex((x) => matches(x, q)); if (i >= 0) this.docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }
  async deleteMany(q) { const n = this.docs.length; this.docs = this.docs.filter((x) => !matches(x, q)); return { deletedCount: n - this.docs.length }; }
  async countDocuments(q = {}) { return this.docs.filter((x) => matches(x, q)).length; }
}

export class FakeMongo {
  constructor() { this.cols = new Map(); }
  collection(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Collection());
    return this.cols.get(name);
  }
  async command() { return { ok: 1 }; }
}
