/* Two accounts of one person made one (server/merge.js): the one in use keeps its own
   things and gains the old one's health data, Google connection, records and devices;
   the old one's sessions sign in as the new one; the old login and folder go. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rig } from './helpers.mjs';
import { runMergeJobs } from '../server/merge.js';

let r;
before(async () => { r = await rig(); });
after(async () => { await r.close(); });

const rows = (file, t) => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n; } finally { d.close(); } };

test('the old account is folded into the one in use', async () => {
  const old = await r.person('orengi_old', { persona: 'fitbit' });
  const now1 = await r.person('orenji_new');
  const pal = await r.person('pal');
  r.befriend(now1, pal);
  assert.equal((await now1.c.post('/api/routines', { title: 'Mine', exercises: [{ name: 'Bench Press', sets: [{ kg: 50, reps: 5 }] }] })).status, 200);
  const users = r.config.dataDir;
  const oldDir = join(users, 'users', old.id); const newDir = join(users, 'users', now1.id);
  assert.ok(existsSync(join(oldDir, 'google.json')), 'the old one has Google');
  assert.ok(!existsSync(join(newDir, 'google.json')));
  const oldDays = rows(join(oldDir, 'health.sqlite'), 'daily');
  assert.ok(oldDays > 0);
  // The server starts afresh: nothing open.
  r.app.worlds.closeAll();

  writeFileSync(join(users, 'merge-accounts.json'), JSON.stringify([{ from: old.id, into: now1.id }]));
  const report = await runMergeJobs({ app: r.app.app, dataDir: users, log: () => {} });
  assert.equal(report[0].ok, true, JSON.stringify(report));
  assert.ok(!existsSync(join(users, 'merge-accounts.json')) && existsSync(join(users, 'merge-accounts.json.done')), 'run once');
  const done = JSON.parse(readFileSync(join(users, 'merge-accounts.json.done'), 'utf8'));
  assert.ok(existsSync(join(done.backupDir, 'app.sqlite')) && readdirSync(join(done.backupDir, `${old.id}-into-${now1.id}`)).includes(old.id), 'backed up first');

  assert.ok(!existsSync(oldDir), 'the old folder is gone');
  assert.ok(existsSync(join(newDir, 'google.json')), 'Google moved over');
  assert.equal(r.app.app.profile(now1.id).googleState, 'ok', 'and the profile says it is connected');
  assert.equal(rows(join(newDir, 'health.sqlite'), 'daily'), oldDays, 'the days came along');
  assert.equal(rows(join(newDir, 'health.sqlite'), 'routine'), 1, 'its own routine stays');
  assert.equal(r.app.app.profile(old.id), null);
  assert.equal(r.app.app.profile(now1.id).username, 'orenji_new');
  assert.equal(r.app.app.get('SELECT COUNT(*) AS n FROM friend WHERE a = ? OR b = ?', now1.id, now1.id).n, 1, 'friends kept');
  // The login: gone, and its sessions sign in as the account kept.
  assert.equal(await r.app.accounts.byId(old.id), null);
  const s = r.app.app.all('SELECT * FROM session WHERE user_id = ?', now1.id);
  assert.ok(s.length >= 2, `sessions: ${s.length}`);
  assert.equal((await old.c.get('/api/me')).json.user.username, 'orenji_new', 'the old one\'s phone carries on as the new one');
  // A fresh look (as after the restart): the data is there for the account in use.
  const me = await now1.c.get('/api/me');
  assert.equal(me.status, 200);
});

test('a missing or bad job file does nothing', async () => {
  assert.equal(await runMergeJobs({ app: r.app.app, dataDir: r.config.dataDir, log: () => {} }), null);
  writeFileSync(join(r.config.dataDir, 'merge-accounts.json'), '{nope');
  assert.equal(await runMergeJobs({ app: r.app.app, dataDir: r.config.dataDir, log: () => {} }), null);
  assert.ok(existsSync(join(r.config.dataDir, 'merge-accounts.json.bad')));
});
