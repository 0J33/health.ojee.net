/* ============================================================
   health.ojee.net — two accounts of one person made one.

   An admin job, not a screen: data/merge-accounts.json lists
   [{ from: <userId>, into: <userId> }] and the server runs it once at
   start, before it takes a request (nothing is open, nothing races),
   then renames the file *.done with what happened.

   `into` is the account the person uses. From `from` it takes:
     health store   rows of every table `into` has none of (copied as they
                    are, ids kept, as nothing can clash), and meta keys it
                    lacks; Google's connection (token files and the raw
                    source store) when `into` has none.
     app rows       every row of theirs (records, boards, push devices,
                    API keys, friends, circles, posts…) moved over where it
                    does not clash; the rest go with the old profile.
     login          its sessions (and Google and Apple sign-ins) now sign
                    in as `into` (a phone still signed in to the old one
                    carries on as the new one); the old rep. login goes.
                    mtg's and dnd's own copies are not touched.

   Google is never told: both accounts share one Google grant, so revoking
   the old one's token would cut the new one off too.

   Everything touched is copied first to data/merge-backup-<time>/.
   ============================================================ */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const USER_COLS = ['user_id', 'a', 'b', 'reporter_id', 'blocked_id', 'owner_id', 'from_id', 'to_id', 'target_user'];
const META_SKIP = new Set(['schema', 'caps', 'derived', 'measureV', 'gaccounts', 'gprimary', 'rev']);

const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
const colsOf = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;

/** The health store's rows: `from`'s copied into `into` table by table, where `into` has none. */
function mergeStore(fromFile, intoFile, note) {
  const src = new DatabaseSync(fromFile, { readOnly: true });
  const dst = new DatabaseSync(intoFile);
  try {
    const have = new Set(tablesOf(dst));
    dst.exec('BEGIN');
    for (const t of tablesOf(src)) {
      if (t === 'meta' || !have.has(t)) continue;
      const n = count(src, t);
      if (!n) continue;
      if (count(dst, t)) { note(`  store ${t}: both have rows, kept the newer account's (${n} left behind)`); continue; }
      const cols = colsOf(src, t).filter((c) => colsOf(dst, t).includes(c));
      const ins = dst.prepare(`INSERT OR IGNORE INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of src.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}"`).all()) ins.run(...cols.map((c) => r[c]));
      note(`  store ${t}: ${n} rows copied`);
    }
    const mset = dst.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
    const moved = [];
    for (const r of src.prepare('SELECT key, value FROM meta').all()) {
      if (META_SKIP.has(r.key)) continue;
      if (mset.run(r.key, r.value).changes) moved.push(r.key);
    }
    if (moved.length) note(`  store meta: ${moved.join(', ')}`);
    dst.exec('COMMIT');
  } catch (e) { try { dst.exec('ROLLBACK'); } catch { /* none */ } throw e; } finally { src.close(); dst.close(); }
}

/** One merge. `app` is the AppDb (logins and sessions too), `usersDir` data/users. */
export async function mergeAccount({ app, usersDir, backupDir, from, into, log }) {
  const out = [];
  const note = (m) => { out.push(m); log(`merge: ${m}`); };
  from = String(from); into = String(into);
  if (from === into) throw new Error('from and into are the same account');
  const pf = app.profile(from); const pi = app.profile(into);
  if (!pi) throw new Error(`no profile for ${into}`);
  note(`${pf?.username || from} → ${pi.username}`);

  // Copies first.
  const bk = join(backupDir, `${from}-into-${into}`);
  mkdirSync(bk, { recursive: true });
  for (const id of [from, into]) if (existsSync(join(usersDir, id))) cpSync(join(usersDir, id), join(bk, id), { recursive: true });
  const login = app.get('SELECT * FROM account WHERE id = ?', from) || null;
  const sessions = app.all('SELECT * FROM session WHERE user_id = ?', from);
  writeFileSync(join(bk, 'login.json'), JSON.stringify({ login, sessions }, null, 1), { mode: 0o600 });

  // The health store, and Google's connection when the account kept has none.
  const fd = join(usersDir, from); const id = join(usersDir, into);
  if (existsSync(join(fd, 'health.sqlite'))) {
    mkdirSync(id, { recursive: true });
    if (existsSync(join(id, 'health.sqlite'))) mergeStore(join(fd, 'health.sqlite'), join(id, 'health.sqlite'), note);
    else { cpSync(join(fd, 'health.sqlite'), join(id, 'health.sqlite')); note('  store: taken whole'); }
    if (existsSync(join(fd, 'google.json')) && !existsSync(join(id, 'google.json'))) {
      for (const f of readdirSync(fd)) if (/^google(-[\w-]+)?\.json$/.test(f) && !existsSync(join(id, f))) { cpSync(join(fd, f), join(id, f)); note(`  ${f} moved`); }
      if (existsSync(join(fd, 'src'))) { rmSync(join(id, 'src'), { recursive: true, force: true }); cpSync(join(fd, 'src'), join(id, 'src'), { recursive: true }); note('  Google source store moved'); }
      // The profile says so too, or the app keeps asking to connect and nothing syncs.
      if (pf?.googleState) app.run('UPDATE profile SET google_state = ?, last_sync_ms = (SELECT last_sync_ms FROM profile WHERE user_id = ?) WHERE user_id = ?', pf.googleState, from, into);
    }
  }

  // The app's rows: moved where they do not clash, then the old profile and the rest go.
  const moved = [];
  app.tx(() => {
    for (const t of tablesOf(app.db)) {
      // Its sessions and sign-ins move with the rest (user_id); the login itself goes below.
      if (t === 'profile' || t === 'account') continue;
      for (const c of colsOf(app.db, t).filter((x) => USER_COLS.includes(x))) {
        const n = app.run(`UPDATE OR IGNORE "${t}" SET "${c}" = ? WHERE "${c}" = ?`, into, from).changes;
        if (n) moved.push(`${t}.${c} ${n}`);
      }
    }
    // A friendship with oneself, made by the move, is none.
    app.run('DELETE FROM friend WHERE a = b');
  });
  if (moved.length) note(`  app rows moved: ${moved.join(', ')}`);
  app.deleteUser(from);

  // The login: its sessions (moved above) sign in as the account kept; the old login goes.
  note(`  ${sessions.length} session(s) now sign in as ${pi.username}`);
  if (login) { app.run('DELETE FROM account WHERE id = ?', from); note(`  login ${login.username} removed`); }

  rmSync(fd, { recursive: true, force: true });
  return out;
}

/** The job file, if there is one: run, then renamed *.done with what happened. */
export async function runMergeJobs({ app, dataDir, log = console.warn }) {
  const file = join(dataDir, 'merge-accounts.json');
  if (!existsSync(file)) return null;
  let jobs;
  try { jobs = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { log(`merge: unreadable job file: ${e.message}`); renameSync(file, `${file}.bad`); return null; }
  const backupDir = join(dataDir, `merge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(backupDir, { recursive: true });
  // The whole app database, as it was, in one file.
  app.db.exec(`VACUUM INTO '${join(backupDir, 'app.sqlite').replace(/'/g, "''")}'`);
  const report = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    try { report.push({ ...j, ok: true, did: await mergeAccount({ app, usersDir: join(dataDir, 'users'), backupDir, from: j.from, into: j.into, log }) }); } catch (e) { log(`merge ${j.from} → ${j.into}: ${e.message}`); report.push({ ...j, ok: false, error: e.message }); }
  }
  writeFileSync(`${file}.done`, JSON.stringify({ at: new Date().toISOString(), backupDir, report }, null, 1));
  rmSync(file);
  return report;
}
