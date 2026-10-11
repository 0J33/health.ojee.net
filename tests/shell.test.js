/* The service worker's shell list against the files that exist. A path in
   SHELL that is not on disk is fetched as a 404 at install; a module the
   app loads that is not in SHELL is missing when the phone is offline. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const sw = readFileSync(join(web, 'sw.js'), 'utf8');
const shell = [...sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];', sw.indexOf('const SHELL = ['))).matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('the shell list is read, and its cache name moved on from v9', () => {
  assert.ok(shell.length > 20, 'SHELL was not parsed');
  const v = /const VERSION = 'v(\d+)'/.exec(sw);
  assert.ok(v && Number(v[1]) >= 10, 'VERSION must be v10 or later');
  assert.equal(new Set(shell).size, shell.length, 'a path is listed twice');
});

test('every path in SHELL exists', () => {
  for (const p of shell) {
    if (p === '/') { assert.ok(existsSync(join(web, 'index.html'))); continue; }
    assert.ok(existsSync(join(web, p)), `${p} is in SHELL but not in web/`);
  }
});

test('every script and stylesheet the app loads is in SHELL', () => {
  const index = readFileSync(join(web, 'index.html'), 'utf8');
  for (const m of index.matchAll(/(?:href|src)="(\/(?:css|js)\/[^"]+)"/g)) assert.ok(shell.includes(m[1]), `${m[1]} is loaded by index.html but not in SHELL`);
  const js = (dir) => readdirSync(join(web, dir)).filter((f) => f.endsWith('.js')).map((f) => `/${dir}/${f}`);
  for (const p of [...js('js'), ...js('js/views')]) assert.ok(shell.includes(p), `${p} is a module of the app but not in SHELL`);
});
