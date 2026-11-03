/* ============================================================
   health.ojee.net — Firebase Cloud Messaging, for the Android app.

   The Android app (ojee-health-app) shows this site in a web view,
   and a web view has no Web Push. It registers with Firebase
   instead, and its token is kept beside the browsers' subscriptions
   (push_sub, endpoint "fcm:<token>"), so the same switches, quiet
   hours and tests apply.

   Sending is FCM's HTTP v1 API, signed in as a service account: a
   JWT (RS256, the account's private key) swapped for an access
   token, kept until a minute before it runs out. The key file's
   path is FCM_SERVICE_ACCOUNT; it never leaves this file.

   A token Firebase no longer knows (the app uninstalled, its data
   cleared) answers 404 UNREGISTERED: thrown as statusCode 410, so
   notify.js removes the device as it does a gone browser.
   ============================================================ */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The service account from its file, or null when there is none (FCM off). */
export function loadServiceAccount(path, { read = readFileSync } = {}) {
  if (!path) return null;
  try {
    const k = JSON.parse(read(path, 'utf8'));
    if (k?.type !== 'service_account' || !k.private_key || !k.client_email || !k.project_id) return null;
    return k;
  } catch { return null; }
}

export class Fcm {
  /**
   * @param {object} o
   * @param {object} o.account   the service account (loadServiceAccount)
   * @param {Function} o.fetchImpl
   */
  constructor({ account, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.#account = account;
    this.projectId = account.project_id;
    this.fetch = fetchImpl;
    this.now = now;
  }
  #account;
  #token = null;
  #tokenUntil = 0;

  async #accessToken() {
    if (this.#token && this.now() < this.#tokenUntil) return this.#token;
    const a = this.#account;
    const iat = Math.floor(this.now() / 1000);
    const head = b64url({ alg: 'RS256', typ: 'JWT' });
    const claims = b64url({ iss: a.client_email, scope: SCOPE, aud: a.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(a.private_key).toString('base64url');
    const res = await this.fetch(a.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw Object.assign(new Error(`Firebase sign-in failed (${res.status})`), { statusCode: 0 });
    this.#token = j.access_token;
    this.#tokenUntil = this.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000;
    return this.#token;
  }

  /**
   * One notification to one app: { title, body, tag, url, type }.
   * Shown by Android itself (a notification message), on the "health"
   * channel; the url rides along for the tap.
   */
  async send(token, n, { ttlS = 6 * 3600 } = {}) {
    const access = await this.#accessToken();
    const res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: n.title, body: n.body || '' },
          data: { url: String(n.url || '/'), tag: String(n.tag || n.type || ''), type: String(n.type || '') },
          android: {
            priority: 'HIGH',
            ttl: `${ttlS}s`,
            notification: { tag: String(n.tag || n.type || 'health'), channel_id: 'health', icon: 'ic_stat_health', color: '#E5484D' },
          },
        },
      }),
    });
    if (res.ok) return;
    const j = await res.json().catch(() => ({}));
    const code = j?.error?.details?.find?.((d) => d.errorCode)?.errorCode || j?.error?.status || '';
    // The token is gone for good: the app removed, or its data cleared.
    if (res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && /registration token/i.test(j?.error?.message || ''))) throw Object.assign(new Error('unregistered'), { statusCode: 410 });
    if (res.status === 401) { this.#token = null; this.#tokenUntil = 0; }
    throw Object.assign(new Error(`Firebase answered ${res.status}${code ? ` ${code}` : ''}`), { statusCode: res.status });
  }
}
