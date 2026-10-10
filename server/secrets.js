/* ============================================================
   health.ojee.net — secrets at rest, and link keys.

   A person's OpenCode key is stored encrypted: AES-256-GCM under a
   key derived from APP_SECRET, with the person's id and the secret's
   name as associated data, so a row copied onto another person does
   not decrypt. Nothing here returns a stored secret to a caller that
   is not about to use it, and the API only ever says
   { keySet: true, last4 }.

   Link keys (for the console module) are bearer tokens: stored as a
   SHA-256 hash, shown once when made.
   ============================================================ */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export class Vault {
  constructor(appSecret) {
    this.key = appSecret ? Buffer.from(hkdfSync('sha256', String(appSecret), 'health.ojee.net', 'secret-v1', 32)) : null;
  }
  ready() { return !!this.key; }

  seal(plain, aad) {
    if (!this.key) throw Object.assign(new Error('The server has no APP_SECRET set, so it cannot store keys. Ask the admin to set it.'), { status: 503, code: 'server_error' });
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(String(aad)));
    const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  /** The plain value, or null when it cannot be read (APP_SECRET changed). */
  open(row, aad) {
    if (!this.key || !row) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
      d.setAAD(Buffer.from(String(aad)));
      d.setAuthTag(Buffer.from(row.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(row.data, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
  }
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newLinkKey = () => `hlk_${randomBytes(32).toString('base64url')}`;
export const shortId = (prefix) => `${prefix}_${randomBytes(5).toString('hex')}`;
export const sameHash = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
