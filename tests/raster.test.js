/* The map drawn here for devices without WebGL (server/raster.js): where a tile is, the middle of a
   bigger picture made straight from premultiplied pixels, and a PNG any decoder reads. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { tileCenter, cropMiddle, encodePng } from '../server/raster.js';

test('the centre of a tile', () => {
  assert.deepEqual(tileCenter(1, 0, 0).map((v) => Math.round(v)), [-90, 67]);
  const [lng, lat] = tileCenter(13, 4807, 3385);   // near Cairo
  assert.ok(lng > 31.2 && lng < 31.3 && lat > 29.7 && lat < 30.2, `${lng},${lat}`);
});

test('the middle, unpremultiplied, as a PNG', () => {
  const full = 4; const px = Buffer.alloc(full * full * 4);
  for (let i = 0; i < full * full; i += 1) px.set([64, 32, 0, 128], i * 4);   // half-transparent, premultiplied
  const mid = cropMiddle(px, full, 2);
  assert.equal(mid.length, 16);
  assert.deepEqual([...mid.subarray(0, 4)], [128, 64, 0, 128]);
  const png = encodePng(mid, 2, 2);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 2);
  const idat = png.indexOf('IDAT');
  const len = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
  assert.equal(raw.length, (2 * 4 + 1) * 2);
});
