/* ============================================================
   health.ojee.net — Apple Push Notification service, for the iPhone app.

   The iPhone app (ojee-health-app) shows this site in a web view, which
   has no Web Push. It registers with Apple through
   @capacitor/push-notifications, and the device token Apple gives it is
   kept beside the browsers' subscriptions and the Android app's tokens
   (push_sub, endpoint "apns:<token>"), so the same switches, quiet hours
   and tests apply.

   Sending is APNs' HTTP/2 API with a token key: a .p8 key made in the
   Apple Developer account (Keys, Apple Push Notifications service),
   whose path is APNS_KEY_FILE, with its APNS_KEY_ID and the account's
   APNS_TEAM_ID. The key signs a short JWT (ES256), renewed every 50
   minutes as Apple asks (no more often than every 20, no older than 60).
   No Firebase on the phone: Apple's own token, Apple's own service.

   Builds from the App Store and TestFlight use Apple's production
   service; one installed from Xcode with a development profile uses the
   sandbox. A token the production service calls BadDeviceToken is tried
   once on the sandbox, so both kinds of build work with one setting.

   A token Apple no longer knows (410 Unregistered, the app removed)
   is thrown as statusCode 410, so notify.js removes the device as it
   does a gone browser.
   ============================================================ */

import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';

export const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The signing key and its ids from the settings, or null when any is missing (APNs off). */
export function loadApnsKey({ keyFile, keyId, teamId, topic } = {}, { read = readFileSync } = {}) {
  if (!keyFile || !keyId || !teamId || !topic) return null;
  try {
    const key = createPrivateKey(read(keyFile, 'utf8'));
    return { key, keyId: String(keyId), teamId: String(teamId), topic: String(topic) };
  } catch { return null; }
}

/** One HTTP/2 request: resolves { status, body }. */
function h2request(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const client = connect(host);
    client.on('error', reject);
    const req = client.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0; let data = '';
    req.setTimeout(15_000, () => { req.close(); reject(Object.assign(new Error('APNs timed out'), { statusCode: 0 })); });
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => { client.close(); resolve({ status, body: data }); });
    req.on('error', (e) => { client.close(); reject(e); });
    req.end(body);
  });
}

export class Apns {
  /**
   * @param {object} o
   * @param {object} o.creds       loadApnsKey's result
   * @param {Function} [o.request] (host, path, headers, body) => Promise<{status, body}>; tests pass their own
   * @param {Function} [o.now]
   */
  constructor({ creds, request = h2request, now = () => Date.now() }) {
    this.#creds = creds;
    this.request = request;
    this.now = now;
  }
  #creds;
  #jwt = null;
  #jwtAt = 0;

  #token() {
    if (this.#jwt && this.now() - this.#jwtAt < 50 * 60_000) return this.#jwt;
    const c = this.#creds;
    const head = b64url({ alg: 'ES256', kid: c.keyId });
    const claims = b64url({ iss: c.teamId, iat: Math.floor(this.now() / 1000) });
    const sig = createSign('SHA256').update(`${head}.${claims}`).sign({ key: c.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.#jwt = `${head}.${claims}.${sig}`;
    this.#jwtAt = this.now();
    return this.#jwt;
  }

  /** One notification to one iPhone: { title, body, tag, url, type }. The url rides along for the tap. */
  async send(token, n, { ttlS = 6 * 3600 } = {}) {
    const body = JSON.stringify({
      aps: { alert: { title: n.title, body: n.body || '' }, sound: 'default', 'thread-id': String(n.tag || n.type || 'health') },
      url: String(n.url || '/'), tag: String(n.tag || n.type || ''), type: String(n.type || ''),
    });
    const headers = {
      authorization: `bearer ${this.#token()}`,
      'apns-topic': this.#creds.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(this.now() / 1000) + ttlS),
      ...(n.tag ? { 'apns-collapse-id': String(n.tag).slice(0, 64) } : {}),
      'content-type': 'application/json',
    };
    const path = `/3/device/${encodeURIComponent(token)}`;
    let r = await this.request(APNS_HOSTS.production, path, headers, body);
    let reason = reasonOf(r.body);
    // A development build's token: the sandbox knows it.
    if (r.status === 400 && reason === 'BadDeviceToken') { r = await this.request(APNS_HOSTS.sandbox, path, headers, body); reason = reasonOf(r.body); }
    if (r.status === 200) return;
    if (r.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') throw Object.assign(new Error('unregistered'), { statusCode: 410 });
    if (r.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(reason)) { this.#jwt = null; this.#jwtAt = 0; }
    throw Object.assign(new Error(`APNs answered ${r.status}${reason ? ` ${reason}` : ''}`), { statusCode: r.status });
  }
}

const reasonOf = (body) => { try { return JSON.parse(body || '{}').reason || ''; } catch { return ''; } };
