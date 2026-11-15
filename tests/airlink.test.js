// The pure parts of airlink.js (the Fitbit Air's channel). The whole of it was run against
// Golden Gate's own node stack (gg-stack-tool node DSNG with the bootstrap key) while it was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ipPacket, prf, hex } from '../web/js/airlink.js';

test('an IPv4/UDP packet from 169.254.0.2 to 169.254.0.3, port 5684, with a right header checksum', () => {
  const p = ipPacket(new Uint8Array([1, 2, 3]));
  assert.equal(p.length, 31);
  assert.equal(p[0], 0x45); assert.equal((p[2] << 8) | p[3], 31); assert.equal(p[9], 17);
  assert.deepEqual([...p.subarray(12, 20)], [169, 254, 0, 2, 169, 254, 0, 3]);
  assert.equal((p[20] << 8) | p[21], 5684); assert.equal((p[22] << 8) | p[23], 5684);
  let s = 0; for (let i = 0; i < 20; i += 2) s += (p[i] << 8) | p[i + 1];
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  assert.equal(s, 0xffff, 'the header sums to all ones');
});

test('the TLS 1.2 PRF (SHA-256) gives the published test vector', async () => {
  // From the IETF TLS working group's PRF test vectors (SHA-256).
  const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  const out = await prf(fromHex('9bbe436ba940f017b17652849a71db35'), 'test label', fromHex('a0ba9f936cda311827a6f796ffd5198c'), 100);
  assert.equal(hex(out).slice(0, 64), 'e3f229ba727be17b8d122620557cd453c2aab21d07c3d495329b52d4e61edb5a');
});
