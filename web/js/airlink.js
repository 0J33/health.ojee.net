/* A Fitbit Air made to vibrate, over its own Bluetooth channel.

   The Air has no Bluetooth alert service. Its tracker channel (service ABBAFF00) carries Fitbit's
   Golden Gate stack, all public (github.com/Fitbit/golden-gate, Apache-2.0):

     Gattlink (a reliable byte stream over one write and one notify characteristic)
       → IPv4 + UDP, 169.254.0.2 (this phone) ↔ 169.254.0.3 (the Air), port 5684
       → DTLS 1.2 with a pre-shared key; the Air is the client, this phone the server
       → CoAP

   Besides the key Google Health keeps for it, the Air accepts Golden Gate's public "BOOTSTRAP"
   key, and in that session it lets one setting be read and written: the strength of its
   vibration (/settings). Changing the strength makes it vibrate once; asking for the other
   strength and then its own in one message is felt as one pulse at its own strength, and leaves
   the setting as it was. Found and verified on firmware 67.20001.253.2 by
   github.com/ThoreKoritzius/fitbit-air (MIT), whose findings this follows.

   The channel is shared with Google Health on the same phone, and only one of them can hold the
   Air's secure session: each buzz takes it over for a few seconds, then hands it back (a refused
   handshake makes the Air reset the link, and Google Health starts again at once).

   pulse(link, { count }) is all there is to use. `link` is the channel, as live.js gives it:
     write(Uint8Array)  a write without response to ABBAFF01
     listen(fn)         fn(Uint8Array) for every notification of ABBAFF02; returns a stop function
     mtu                the most bytes one write may carry (20 when unknown) */

export const TRACKER_SERVICE = 'abbaff00-e56a-484c-b832-8b17cf6cbfe8';
export const TRACKER_TX = 'abbaff01-e56a-484c-b832-8b17cf6cbfe8';   // phone → Air
export const TRACKER_RX = 'abbaff02-e56a-484c-b832-8b17cf6cbfe8';   // Air → phone

const BOOTSTRAP_ID = 'BOOTSTRAP';
const BOOTSTRAP_KEY = new Uint8Array([0x81, 0x06, 0x54, 0xE3, 0x36, 0xAD, 0xCA, 0xB0, 0xA0, 0x3C, 0x60, 0xF7, 0x4A, 0xA0, 0xB6, 0xFB]);

const subtle = () => globalThis.crypto?.subtle;
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u16 = (n) => new Uint8Array([(n >> 8) & 255, n & 255]);
const u24 = (n) => new Uint8Array([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
const rd16 = (b, o) => (b[o] << 8) | b[o + 1];
const rd24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ascii = (s) => new TextEncoder().encode(s);
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Can this browser or app do it at all (the session needs AES-GCM and HMAC from WebCrypto)? */
export const possible = () => Boolean(subtle()?.importKey);

/* ---------------------------------------------------------------- Gattlink */

/** Golden Gate's Gattlink: a reliable byte stream in small numbered packets (gg_gattlink.c). */
class Gattlink {
  constructor(send, max, { onReady, onData, onReset }) {
    this.sendRaw = send; this.max = Math.max(20, Math.min(max || 20, 512));
    this.onReady = onReady; this.onData = onData; this.onReset = onReset;
    this.state = 'init';
    this.win = 8;                // our windows, both ways, as Golden Gate's generic client asks
    this.tx = 8;
    this.timer = null; this.ackTimer = null;
    this.clear();
  }
  clear() {
    this.out = [];               // bytes waiting to go
    this.flight = [];            // { psn, data } sent, not yet acknowledged
    this.nextPsn = 0; this.expect = 0; this.ackWith = 0; this.owed = 0;
    clearTimeout(this.timer); clearTimeout(this.ackTimer); this.timer = null; this.ackTimer = null;
  }
  stop() { this.state = 'stopped'; this.clear(); }
  start() { this.reset(); }
  reset() {
    if (this.state === 'stopped') return;
    const was = this.state === 'ready';
    this.clear();
    this.state = 'self';
    if (was) this.onReset?.();
    this.sendRaw(new Uint8Array([0x80]));
    this.timer = setTimeout(() => this.reset(), 1000);
  }
  complete() { this.sendRaw(new Uint8Array([0x81, 0, 0, this.win, this.win])); }
  receive(b) {
    if (this.state === 'stopped' || !b?.length) return;
    if (b[0] & 0x80) {
      const type = b[0] & 0x7f;
      if (type === 0) {          // reset request: answer, and wait for theirs
        const was = this.state === 'ready';
        this.clear();
        this.state = 'remote';
        if (was) this.onReset?.();
        this.complete();
        this.timer = setTimeout(() => this.reset(), 2000);
      } else if (type === 1 && (this.state === 'self' || this.state === 'remote') && b.length >= 5) {
        this.tx = Math.min(this.win, b[3]);
        if (this.state === 'self') this.complete();
        this.clear();
        this.state = 'ready';
        this.onReady?.();
        this.pump();
      }
      return;
    }
    if (this.state !== 'ready') return;
    let i = 0;
    if (b[0] & 0x40) {           // an acknowledgement, up to and including a packet number
      const psn = b[0] & 0x1f;
      const at = this.flight.findIndex((f) => f.psn === psn);
      if (at >= 0) {
        this.flight.splice(0, at + 1);
        clearTimeout(this.timer); this.timer = null;
        if (this.flight.length) this.timer = setTimeout(() => this.resend(), 4000);
      }
      i = 1;
    }
    if (i < b.length) {
      const psn = b[i] & 0x1f;
      if (psn === this.expect) {
        this.expect = (psn + 1) % 32;
        this.ackWith = psn;
        this.onData?.(b.subarray(i + 1));
      }
      this.owed += 1;
      if (this.owed > this.win / 2) this.ackNow();
      else if (!this.ackTimer) this.ackTimer = setTimeout(() => this.ackNow(), 200);
    }
    this.pump();
  }
  ackNow() {
    clearTimeout(this.ackTimer); this.ackTimer = null;
    if (!this.owed || this.state !== 'ready') return;
    this.owed = 0;
    this.sendRaw(new Uint8Array([0x40 | this.ackWith]));
  }
  write(bytes) { this.out.push(...bytes); this.pump(); }
  pump() {
    if (this.state !== 'ready') return;
    while (this.out.length && this.flight.length < this.tx) {
      const data = new Uint8Array(this.out.splice(0, this.max - 2));
      const psn = this.nextPsn; this.nextPsn = (psn + 1) % 32;
      this.flight.push({ psn, data });
      this.packet(psn, data);
      if (!this.timer) this.timer = setTimeout(() => this.resend(), 4000);
    }
  }
  packet(psn, data) {
    // An acknowledgement owed goes in front of the data.
    if (this.owed) { this.owed = 0; clearTimeout(this.ackTimer); this.ackTimer = null; this.sendRaw(cat(new Uint8Array([0x40 | this.ackWith, psn]), data)); } else this.sendRaw(cat(new Uint8Array([psn]), data));
  }
  resend() {
    this.timer = null;
    if (this.state !== 'ready' || !this.flight.length) return;
    for (const f of this.flight) this.packet(f.psn, f.data);
    this.timer = setTimeout(() => this.resend(), 4000);
  }
}

/* ---------------------------------------------------------------- IPv4 + UDP */

const PHONE_IP = [169, 254, 0, 2];
const AIR_IP = [169, 254, 0, 3];
const PORT = 5684;

function ipChecksum(h) {
  let s = 0;
  for (let i = 0; i < h.length; i += 2) s += (h[i] << 8) | h[i + 1];
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (~s) & 0xffff;
}
let ipId = Math.floor(Math.random() * 65535);
/** One UDP datagram as an IPv4 packet, from this phone to the Air. */
export function ipPacket(payload) {
  const len = 28 + payload.length;
  ipId = (ipId + 1) & 0xffff;
  const h = new Uint8Array([0x45, 0, ...u16(len), ...u16(ipId), 0, 0, 64, 17, 0, 0, ...PHONE_IP, ...AIR_IP]);
  const c = ipChecksum(h); h[10] = c >> 8; h[11] = c & 255;
  return cat(h, u16(PORT), u16(PORT), u16(8 + payload.length), u16(0), payload);
}

/** Bits read off a compressed header (gg_ipv4_protocol.c, GG_Ipv4_DecompressHeaders). */
function compressedHeaderSize(b) {
  const f = rd16(b, 0);
  let bits = 0;
  let ihl = 5;
  if (f & 0x0001) { ihl = b[6] >> 4; bits += 4; }
  if (f & 0x0002) bits += 6;
  if (f & 0x0004) bits += 2;
  if (f & 0x0008) bits += 3;
  if (f & 0x0010) bits += 13;
  if (f & 0x0020) bits += 8;
  const proto = f & 0x00c0;
  let isUdp = proto === 0x0040;
  if (proto === 0x00c0) {
    // The protocol written out: read it to know whether a UDP header follows.
    const at = 6 * 8 + bits; const byte = b[at >> 3]; const next = b[(at >> 3) + 1] || 0;
    const v = ((byte << 8 | next) >> (8 - (at & 7))) & 255;
    isUdp = v === 17; bits += 8;
  }
  if (f & 0x0100) bits += 32;
  if (f & 0x0200) bits += 32;
  bits += 8 * 4 * (ihl - 5);
  if (isUdp) {
    if ((f & 0x0c00) === 0x0c00) bits += 16;
    if ((f & 0x3000) === 0x3000) bits += 16;
    if (f & 0x4000) bits += 16;
  }
  return { size: 6 + Math.ceil(bits / 8), udp: isUdp };
}

/** IP packets out of the Gattlink stream: each starts with its total length in bytes 2–3. */
class Frames {
  constructor(onDatagram) { this.buf = new Uint8Array(0); this.onDatagram = onDatagram; }
  clear() { this.buf = new Uint8Array(0); }
  feed(bytes) {
    this.buf = cat(this.buf, bytes);
    while (this.buf.length >= 4) {
      const len = rd16(this.buf, 2);
      if (len < 6 || len > 1500) { this.buf = new Uint8Array(0); return; }   // lost the thread: a reset will bring it back
      if (this.buf.length < len) return;
      const p = this.buf.slice(0, len);
      this.buf = this.buf.slice(len);
      if ((p[0] >> 4) === 4) {
        const ihl = (p[0] & 15) * 4;
        if (p[9] === 17) this.onDatagram(p.subarray(ihl + 8));
      } else if (p[0] & 0x80) {
        const { size, udp } = compressedHeaderSize(p);
        if (udp) this.onDatagram(p.subarray(size));
      }
    }
  }
}

/* ---------------------------------------------------------------- crypto */

async function hmacKey(secret) { return subtle().importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
async function hmac(key, data) { return new Uint8Array(await subtle().sign('HMAC', key, data)); }
/** TLS 1.2's PRF with SHA-256. */
export async function prf(secret, label, seed, n) {
  const key = await hmacKey(secret);
  const s = cat(ascii(label), seed);
  let a = s; let out = new Uint8Array(0);
  while (out.length < n) {
    a = await hmac(key, a);
    out = cat(out, await hmac(key, cat(a, s)));
  }
  return out.slice(0, n);
}
const sha256 = async (b) => new Uint8Array(await subtle().digest('SHA-256', b));
const gcmKey = (raw) => subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
const randomBytes = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };

/* ---------------------------------------------------------------- DTLS 1.2, PSK, server side */

const SUITE_GCM = 0x00a8;        // TLS_PSK_WITH_AES_128_GCM_SHA256: the Air offers it, and WebCrypto has GCM
const V = [0xfe, 0xfd];          // DTLS 1.2
const T = { ccs: 20, alert: 21, hs: 22, app: 23 };
const HS = { clientHello: 1, serverHello: 2, serverHelloDone: 14, clientKeyExchange: 16, finished: 20 };

class Dtls {
  constructor(sendDatagram, { onOpen, onData, onFail, accept }) {
    this.send = sendDatagram; this.onOpen = onOpen; this.onData = onData; this.onFail = onFail;
    this.accept = accept;        // (identity) → key or null
    this.restart();
  }
  restart() {
    this.state = 'hello';
    this.epoch = 0; this.seq = [0, 0];       // our record sequence numbers, per epoch
    this.hsSeq = 0;                          // our handshake message_seq
    this.transcript = [];
    this.parts = new Map();                  // message_seq → { type, len, body }
    this.nextIn = 0;
    this.keys = null; this.lastFlight = null; this.clientRandom = null;
  }
  record(type, body, epoch = this.epoch) {
    const seq = this.seq[epoch]++;
    return cat(new Uint8Array([type, ...V]), u16(epoch), new Uint8Array([0, 0]), new Uint8Array([(seq >>> 24) & 255, (seq >>> 16) & 255, (seq >>> 8) & 255, seq & 255]), u16(body.length), body);
  }
  hsMessage(type, body) {
    const m = cat(new Uint8Array([type]), u24(body.length), u16(this.hsSeq++), u24(0), u24(body.length), body);
    this.transcript.push(m);
    return m;
  }
  async encrypt(type, plain) {
    const seq = this.seq[1];
    const explicit = cat(u16(1), new Uint8Array([0, 0, (seq >>> 24) & 255, (seq >>> 16) & 255, (seq >>> 8) & 255, seq & 255]));
    const aad = cat(explicit, new Uint8Array([type, ...V]), u16(plain.length));
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: cat(this.keys.sIv, explicit), additionalData: aad, tagLength: 128 }, this.keys.sKey, plain));
    return this.record(type, cat(explicit, ct), 1);
  }
  async decrypt(type, rec, frag) {
    const explicit = frag.subarray(0, 8);
    const ct = frag.subarray(8);
    const aad = cat(rec.subarray(3, 11), new Uint8Array([type, ...V]), u16(ct.length - 16));
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: cat(this.keys.cIv, explicit), additionalData: aad, tagLength: 128 }, this.keys.cKey, ct));
  }
  alert(desc) { try { this.send(this.record(T.alert, new Uint8Array([2, desc]), 0)); } catch { /* gone */ } }
  async datagram(d) {
    for (let o = 0; o + 13 <= d.length;) {
      const len = rd16(d, o + 11);
      const rec = d.subarray(o, o + 13 + len);
      o += 13 + len;
      try { await this.handleRecord(rec); } catch (e) { this.fail(e); return; }
    }
  }
  fail(e) { this.state = 'failed'; this.onFail?.(e); }
  async handleRecord(rec) {
    const type = rec[0]; const epoch = rd16(rec, 3);
    let frag = rec.subarray(13);
    if (type === T.alert && epoch === 0) { if (frag[0] === 2) throw new Error(`The Air ended the session (alert ${frag[1]})`); return; }
    if (epoch === 1) {
      if (!this.keys) return;
      frag = await this.decrypt(type, rec, frag);
    }
    if (type === T.hs) {
      for (let o = 0; o + 12 <= frag.length;) {
        const ht = frag[o]; const total = rd24(frag, o + 1); const mseq = rd16(frag, o + 4);
        const off = rd24(frag, o + 6); const flen = rd24(frag, o + 9);
        const body = frag.subarray(o + 12, o + 12 + flen);
        o += 12 + flen;
        if (ht === HS.clientHello && mseq === 0 && off === 0) {
          // A new ClientHello: a new handshake (the Air starts over after every Gattlink reset).
          const random = body.subarray(2, 34);
          if (this.clientRandom && eq(random, this.clientRandom) && this.lastFlight) { for (const r of this.lastFlight) this.send(r); continue; }
          if (this.state !== 'hello') this.restart();
        }
        // An old message again: our answer to it was lost, so it goes again.
        if (mseq < this.nextIn) { if (this.lastFlight) for (const r of this.lastFlight) this.send(r); continue; }
        let p = this.parts.get(mseq);
        if (!p) { p = { type: ht, len: total, body: new Uint8Array(total), have: 0 }; this.parts.set(mseq, p); }
        p.body.set(body, off); p.have += flen;
        while (this.parts.has(this.nextIn) && this.parts.get(this.nextIn).have >= this.parts.get(this.nextIn).len) {
          const m = this.parts.get(this.nextIn); this.parts.delete(this.nextIn);
          const full = cat(new Uint8Array([m.type]), u24(m.len), u16(this.nextIn), u24(0), u24(m.len), m.body);
          this.nextIn += 1;
          await this.handshake(m.type, m.body, full);
        }
      }
    } else if (type === T.ccs) {
      if (this.state === 'ccs') this.state = 'finished';
    } else if (type === T.app && this.state === 'open') {
      this.onData?.(frag);
    }
  }
  async handshake(type, body, full) {
    if (type === HS.clientHello && this.state === 'hello') {
      this.transcript.push(full);
      this.clientRandom = body.slice(2, 34);
      let o = 34; o += 1 + body[o];          // session id
      o += 1 + body[o];                     // cookie
      const n = rd16(body, o); const suites = [];
      for (let i = 0; i < n; i += 2) suites.push(rd16(body, o + 2 + i));
      if (!suites.includes(SUITE_GCM)) { this.alert(40); throw new Error('The Air offered no cipher suite rep. can use'); }
      this.serverRandom = randomBytes(32);
      const sh = cat(new Uint8Array(V), this.serverRandom, new Uint8Array([0]), u16(SUITE_GCM), new Uint8Array([0]));
      const recs = [this.record(T.hs, this.hsMessage(HS.serverHello, sh)), this.record(T.hs, this.hsMessage(HS.serverHelloDone, new Uint8Array(0)))];
      this.lastFlight = recs;
      for (const r of recs) this.send(r);
      this.state = 'cke';
    } else if (type === HS.clientKeyExchange && this.state === 'cke') {
      this.transcript.push(full);
      const id = new TextDecoder().decode(body.subarray(2, 2 + rd16(body, 0)));
      const psk = this.accept(id);
      if (!psk) { this.alert(115); throw Object.assign(new Error(`The Air asked for key "${id}"`), { identity: id }); }
      const z = new Uint8Array(psk.length);
      const pms = cat(u16(psk.length), z, u16(psk.length), psk);
      this.master = await prf(pms, 'master secret', cat(this.clientRandom, this.serverRandom), 48);
      const kb = await prf(this.master, 'key expansion', cat(this.serverRandom, this.clientRandom), 40);
      this.keys = { cKey: await gcmKey(kb.slice(0, 16)), sKey: await gcmKey(kb.slice(16, 32)), cIv: kb.slice(32, 36), sIv: kb.slice(36, 40) };
      this.state = 'ccs';
    } else if (type === HS.finished && this.state === 'finished') {
      const want = await prf(this.master, 'client finished', await sha256(cat(...this.transcript)), 12);
      if (!eq(body, want)) { this.alert(51); throw new Error('The Air\'s Finished did not check out'); }
      this.transcript.push(full);
      const mine = await prf(this.master, 'server finished', await sha256(cat(...this.transcript)), 12);
      const recs = [this.record(T.ccs, new Uint8Array([1]), 0)];
      this.epoch = 1;
      recs.push(await this.encrypt(T.hs, this.hsMessage(HS.finished, mine)));
      this.lastFlight = recs;
      for (const r of recs) this.send(r);
      this.state = 'open';
      this.onOpen?.();
    }
  }
  async write(data) { if (this.state === 'open') this.send(await this.encrypt(T.app, data)); }
}

/* ---------------------------------------------------------------- CoAP */

const PUT = 3; const POST = 2;
const CON = 0; const ACK = 2;
function coapRequest(method, path, body, mid, token) {
  const opts = [];
  let last = 0;
  for (const seg of path.split('/').filter(Boolean)) {
    const v = ascii(seg); const delta = 11 - last; last = 11;
    opts.push(new Uint8Array([(delta << 4) | Math.min(v.length, 12), ...(v.length > 12 ? [v.length - 13] : [])]), v);
  }
  return cat(new Uint8Array([0x40 | (CON << 4) | token.length, method, ...u16(mid)]), token, ...opts, body?.length ? cat(new Uint8Array([0xff]), body) : new Uint8Array(0));
}
function coapParse(b) {
  if (b.length < 4 || (b[0] >> 6) !== 1) return null;
  const type = (b[0] >> 4) & 3; const tkl = b[0] & 15; const code = b[1]; const mid = rd16(b, 2);
  const token = b.slice(4, 4 + tkl);
  let o = 4 + tkl;
  while (o < b.length && b[o] !== 0xff) {
    let d = b[o] >> 4; let l = b[o] & 15; o += 1;
    if (d === 13) { o += 1; } else if (d === 14) { o += 2; }
    if (l === 13) { l = b[o] + 13; o += 1; } else if (l === 14) { l = rd16(b, o) + 269; o += 2; }
    o += l; d = 0;
  }
  const payload = o < b.length ? b.slice(o + 1) : new Uint8Array(0);
  return { type, code, mid, token, payload };
}

/* ---------------------------------------------------------------- the session */

/* `/settings` (protobuf): read with PUT 0a0101; each entry of a write is 0a040a0208<strength>,
   strength 2 low, 3 high (1 is off). */
const READ = new Uint8Array([0x0a, 0x01, 0x01]);
const entry = (s) => [0x0a, 0x04, 0x0a, 0x02, 0x08, s];
const strengthOf = (p) => (p.length === 6 && p[0] === 0x0a && p[1] === 0x04 && p[2] === 0x0a && p[3] === 0x02 && p[4] === 0x08 ? p[5] : null);

/**
 * Open the Air's secure session over `link` and run `work(session)` in it; then give the channel
 * back to Google Health. session.request(method, path, body) → { code, payload }.
 */
export async function session(link, work, { log = () => {}, deadline = 30_000 } = {}) {
  if (!possible()) throw new Error('This browser cannot do it (no WebCrypto)');
  let finish; let fail;
  const done = new Promise((res, rej) => { finish = res; fail = rej; });
  let stopped = false;
  const sendRaw = (b) => { if (!stopped) Promise.resolve(link.write(b)).catch((e) => log('write failed', e?.message)); };
  let mid = Math.floor(Math.random() * 60000);
  const waiting = new Map();      // token hex → resolve
  let handing = false; let tries = 0;

  const frames = new Frames((d) => dtls.datagram(d));
  const gl = new Gattlink(sendRaw, link.mtu || 20, {
    onReady: () => log('gattlink ready'),
    onData: (b) => frames.feed(b),
    onReset: () => { frames.clear(); dtls.restart(); },
  });
  const dtls = new Dtls((rec) => gl.write(ipPacket(rec)), {
    accept: (id) => (handing ? null : id === BOOTSTRAP_ID ? BOOTSTRAP_KEY : null),
    onOpen: async () => {
      log('session open');
      try { finish(await work(api)); } catch (e) { fail(e); }
    },
    onData: (b) => {
      const m = coapParse(b);
      if (!m) return;
      if (m.code === 0 && m.type === CON) return;    // a ping
      if (m.code >= 1 && m.code < 32) {               // a request from the Air: not ours to answer
        if (m.type === CON) dtls.write(cat(new Uint8Array([0x60 | m.token.length, 0x84, ...u16(m.mid)]), m.token)).catch(() => {});
        return;
      }
      if (m.type === CON) dtls.write(new Uint8Array([0x60, 0, ...u16(m.mid)])).catch(() => {});
      waiting.get(hex(m.token))?.(m);
    },
    onFail: (e) => {
      if (handing) return;
      // The Air offered Google Health's key: refusing it makes the Air start over with the bootstrap key.
      if (e?.identity && tries < 3) { tries += 1; log(`refused key "${e.identity}", waiting for the bootstrap key`); return; }
      fail(e);
    },
  });
  const api = {
    async request(method, path, body) {
      const token = randomBytes(4); mid = (mid + 1) & 0xffff;
      const msg = coapRequest(method, path, body, mid, token);
      return new Promise((resolve, reject) => {
        let n = 0; let t = null;
        const go = () => {
          if (n++ > 4) { waiting.delete(hex(token)); reject(new Error('The Air did not answer')); return; }
          dtls.write(msg).catch(reject);
          t = setTimeout(go, 3000);
        };
        waiting.set(hex(token), (m) => { clearTimeout(t); waiting.delete(hex(token)); resolve(m); });
        go();
      });
    },
  };

  const stop = link.listen((b) => gl.receive(b));
  const timer = setTimeout(() => fail(new Error('The Air did not open a session in time')), deadline);
  gl.start();
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    // Hand back: a fresh link and a refused handshake make the Air reset the channel for everyone,
    // and Google Health picks it up again at once.
    handing = true;
    await handBack(gl, dtls, log);
    stopped = true;
    gl.stop();
    try { stop?.(); } catch { /* already stopped */ }
  }
}

async function handBack(gl, dtls, log) {
  dtls.restart();
  gl.reset();
  for (let i = 0; i < 40 && dtls.state !== 'failed'; i += 1) await wait(200);
  log(dtls.state === 'failed' ? 'channel handed back' : 'hand-back not confirmed');
  await wait(300);
}

/** Read the strength the Air vibrates at: 2 low, 3 high. */
async function readStrength(s) {
  const r = await s.request(PUT, '/settings', READ);
  if ((r.code >> 5) !== 2) throw new Error(`The Air refused to say (${r.code >> 5}.${String(r.code & 31).padStart(2, '0')})`);
  const v = strengthOf(r.payload);
  if (v !== 2 && v !== 3) throw new Error(`The Air's vibration is off or unknown (${hex(r.payload)})`);
  return v;
}

/**
 * Make the Air vibrate `count` times (1 to 3), at its own strength, leaving that as it was.
 * Resolves to { strength } (2 low, 3 high); rejects when it could not.
 */
export async function pulse(link, { count = 1, gap = 1400, log } = {}) {
  return session(link, async (s) => {
    const own = await readStrength(s);
    const other = own === 2 ? 3 : 2;
    for (let i = 0; i < Math.max(1, Math.min(3, count)); i += 1) {
      if (i) await wait(gap);
      const r = await s.request(POST, '/settings', new Uint8Array([...entry(other), ...entry(own)]));
      if ((r.code >> 5) !== 2) throw new Error('The Air refused the change');
    }
    const now = await readStrength(s);
    if (now !== own) await s.request(POST, '/settings', new Uint8Array(entry(own)));
    return { strength: own };
  }, { log });
}

/** Only read the strength (a check that the session works, felt as nothing). */
export async function strength(link, { log } = {}) {
  return session(link, (s) => readStrength(s), { log });
}
