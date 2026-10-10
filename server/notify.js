/* ============================================================
   health.ojee.net — delivering notifications: Web Push, and the
   open tabs.

   core/alerts.js, core/workouts.js and social.js decide WHEN there
   is something to say. This decides WHERE it goes, per person:

     - the type must be switched on (the person's own switches);
     - an open tab always gets it, as a `notify` event on /api/events;
     - a device gets a push when it is enabled, has not switched the
       type off for itself, and the person is not in quiet hours;
     - a push service answering 404 or 410 means the subscription is
       gone for good (uninstalled, permission withdrawn): the device
       is removed.

   VAPID keys are generated once and kept in app_meta. The private
   key never leaves this file.
   ============================================================ */

import webpush from 'web-push';
import { TYPES, TYPE_IDS, inQuiet } from './core/alerts.js';
import { shortId } from './secrets.js';

export class Notifier {
  /**
   * @param {object} o
   * @param {object} o.app      the AppDb
   * @param {Function} o.sse    (userId, event, data) => void
   * @param {Function} o.send   async (subscription, payloadString, options) => void; throws { statusCode }
   */
  constructor({ app, sse = () => {}, send = null, subject = 'mailto:health@ojee.net', now = () => Date.now(), log = () => {} }) {
    this.app = app; this.sse = sse; this.now = now; this.log = log; this.subject = subject;
    let keys = app.meta('vapid');
    if (!keys?.publicKey || !keys?.privateKey) {
      keys = webpush.generateVAPIDKeys();
      app.setMeta('vapid', keys);
    }
    this.publicKey = keys.publicKey;
    this.#private = keys.privateKey;
    this.send = send || ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
  }
  #private;

  /* ── devices ──────────────────────────────────────────────────── */

  #device(r) {
    let types = null;
    try { types = r.types ? JSON.parse(r.types) : null; } catch { types = null; }
    return { id: r.id, label: r.label, enabled: !!r.enabled, types, createdAt: r.created_ms, lastOkAt: r.last_ok_ms, lastError: r.last_error };
  }
  devices(userId) { return this.app.all('SELECT * FROM push_sub WHERE user_id = ? ORDER BY created_ms', String(userId)).map((r) => this.#device(r)); }
  count(userId) { return this.app.get('SELECT COUNT(*) AS n FROM push_sub WHERE user_id = ?', String(userId)).n; }

  /** Add this browser, or refresh it if it subscribed before. */
  subscribe(userId, sub, label) {
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || ''); const auth = String(sub?.keys?.auth || '');
    if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
      throw Object.assign(new Error('That is not a push subscription. Allow notifications in the browser and try again.'), { status: 400 });
    }
    const had = this.app.get('SELECT * FROM push_sub WHERE endpoint = ?', endpoint);
    const name = String(label || had?.label || 'This device').slice(0, 40);
    if (had) {
      // The same browser, perhaps now signed in as somebody else: it is theirs.
      this.app.run('UPDATE push_sub SET user_id = ?, p256dh = ?, auth = ?, label = ?, last_error = NULL WHERE id = ?', String(userId), p256dh, auth, name, had.id);
      return had.id;
    }
    const id = shortId('d');
    this.app.run('INSERT INTO push_sub (id, user_id, endpoint, p256dh, auth, label, enabled, types, created_ms) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)', id, String(userId), endpoint, p256dh, auth, name, this.now());
    return id;
  }
  patchDevice(userId, id, patch) {
    const r = this.app.get('SELECT * FROM push_sub WHERE id = ? AND user_id = ?', String(id), String(userId));
    if (!r) throw Object.assign(new Error('No such device.'), { status: 404 });
    if (typeof patch.enabled === 'boolean') this.app.run('UPDATE push_sub SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, r.id);
    if (patch.label !== undefined) this.app.run('UPDATE push_sub SET label = ? WHERE id = ?', String(patch.label || 'This device').slice(0, 40), r.id);
    if (patch.types !== undefined) {
      let t = null;
      if (patch.types && typeof patch.types === 'object') { t = {}; for (const k of TYPE_IDS) if (typeof patch.types[k] === 'boolean') t[k] = patch.types[k]; }
      this.app.run('UPDATE push_sub SET types = ? WHERE id = ?', t ? JSON.stringify(t) : null, r.id);
    }
  }
  removeDevice(userId, id) { return this.app.run('DELETE FROM push_sub WHERE id = ? AND user_id = ?', String(id), String(userId)).changes > 0; }
  removeEndpoint(userId, endpoint) { return this.app.run('DELETE FROM push_sub WHERE endpoint = ? AND user_id = ?', String(endpoint), String(userId)).changes > 0; }

  /* ── sending ──────────────────────────────────────────────────── */

  async #push(rows, note) {
    const out = { sent: 0, failed: 0, removed: 0, errors: [] };
    const payload = JSON.stringify(note);
    await Promise.all(rows.map(async (r) => {
      try {
        await this.send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, {
          TTL: 6 * 3600,
          vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.#private },
        });
        this.app.run('UPDATE push_sub SET last_ok_ms = ?, last_error = NULL WHERE id = ?', this.now(), r.id);
        out.sent += 1;
      } catch (e) {
        const code = e?.statusCode || 0;
        if (code === 404 || code === 410) {
          // Gone for good: the browser unsubscribed or the app was removed.
          this.app.run('DELETE FROM push_sub WHERE id = ?', r.id);
          out.removed += 1;
        } else {
          const why = code ? `push service answered ${code}` : 'push service unreachable';
          this.app.run('UPDATE push_sub SET last_error = ? WHERE id = ?', why, r.id);
          out.failed += 1;
          out.errors.push({ deviceId: r.id, error: why });
        }
      }
    }));
    return out;
  }

  /**
   * Say something to one person.
   * @param {object} note   { type, title, body, tag?, url? }
   * @param {object} who    { prefs (mergePrefs shape), tz }
   */
  async notify(userId, note, { prefs, tz } = {}) {
    if (!TYPE_IDS.includes(note.type)) return { sent: 0, skipped: 'unknown type' };
    if (prefs && prefs.types[note.type] === false) return { sent: 0, skipped: 'off' };
    const n = { type: note.type, title: String(note.title).slice(0, 120), body: String(note.body || '').slice(0, 400), tag: note.tag || note.type, url: note.url || '/', at: this.now() };
    this.sse(String(userId), 'notify', n);
    if (prefs && inQuiet(prefs, this.now(), tz)) return { sent: 0, skipped: 'quiet hours' };
    const rows = this.app.all('SELECT * FROM push_sub WHERE user_id = ? AND enabled = 1', String(userId)).filter((r) => {
      try { return !(r.types && JSON.parse(r.types)[note.type] === false); } catch { return true; }
    });
    if (!rows.length) return { sent: 0, skipped: 'no device' };
    const out = await this.#push(rows, n);
    if (out.removed) this.sse(String(userId), 'changed', { what: ['push'], at: this.now() });
    return out;
  }

  /** A test notification: to one device or all, ignoring switches and quiet hours. */
  async test(userId, deviceId = null) {
    const rows = deviceId
      ? this.app.all('SELECT * FROM push_sub WHERE user_id = ? AND id = ?', String(userId), String(deviceId))
      : this.app.all('SELECT * FROM push_sub WHERE user_id = ?', String(userId));
    if (!rows.length) throw Object.assign(new Error(deviceId ? 'No such device.' : 'No device is set up for notifications yet. Turn them on in this browser first.'), { status: deviceId ? 404 : 409 });
    return this.#push(rows, { type: 'test', title: 'Notifications are working', body: 'This is a test from health.ojee.net.', tag: 'test', url: '/settings/notifications', at: this.now() });
  }
}

export { TYPES };
