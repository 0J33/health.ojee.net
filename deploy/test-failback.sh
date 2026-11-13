#!/usr/bin/env bash
# Tests the automatic failback end to end on plain folders, with no network: deploy/replicate.sh (the
# disinteg side) and deploy/failover-hp.sh watch (the HP side) run as they do on the boxes, and rsync's
# "ssh" is a stand-in that runs the other end in a folder that plays HP's ~/rep-replica.
#
#   bash deploy/test-failback.sh
#
# The story: rep. ran on HP (ACTIVE) and wrote newer data; disinteg is back with older data. disinteg
# goes passive, asks for rep. back, HP stops and makes its databases whole, disinteg pulls HP's data
# (keeping its own aside), HP lets go, and the copying runs again.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
PORT=$((20000 + RANDOM % 20000))
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok  $*"; }
q() { sqlite3 "$1" 'SELECT v FROM t'; }

# Where there is no sqlite3 (a laptop), a stand-in for what the scripts use: SQL, .timeout, .backup.
if ! command -v sqlite3 >/dev/null; then
  mkdir -p "$T/bin"
  cat > "$T/bin/sqlite3" <<'PY'
#!/usr/bin/env python3
import sqlite3, sys, re
db = sqlite3.connect(sys.argv[1], isolation_level=None)
for cmd in sys.argv[2:]:
    if cmd.startswith('.timeout'): db.execute(f'PRAGMA busy_timeout={int(cmd.split()[1])}'); continue
    m = re.match(r"\.backup '(.+)'", cmd)
    if m: out = sqlite3.connect(m.group(1)); db.backup(out); out.close(); continue
    *head, last = [x for x in cmd.split(';') if x.strip()]
    for x in head: db.execute(x)
    for row in db.execute(last): print('|'.join('' if v is None else str(v) for v in row))
db.close()
PY
  chmod +x "$T/bin/sqlite3"; export PATH="$T/bin:$PATH"
fi

export FAKEHP=$T/hp
SRC=$T/disinteg
mkdir -p "$FAKEHP/data/users/u1" "$FAKEHP/data/users/u2" "$FAKEHP/data/media" "$SRC/data/users/u1" "$SRC/data/predeploy-x"
# disinteg: its data from before it went down, a file HP no longer has, and a local snapshot folder.
for db in app.sqlite users/u1/x.sqlite; do sqlite3 "$SRC/data/$db" "CREATE TABLE t(v); INSERT INTO t VALUES('old');"; done
echo gone > "$SRC/data/gone.txt"
echo mine > "$SRC/data/predeploy-x/keep.txt"
# HP: newer data, in WAL mode, a new account and a new photo.
for db in app.sqlite users/u1/x.sqlite users/u2/y.sqlite; do sqlite3 "$FAKEHP/data/$db" "PRAGMA journal_mode=WAL; CREATE TABLE t(v); INSERT INTO t VALUES('new');" >/dev/null; done
echo photo > "$FAKEHP/data/media/p.jpg"
date -u +%FT%TZ > "$FAKEHP/ACTIVE"

# rsync's remote end, run in HP's folder.
cat > "$T/fakessh" <<'EOF'
#!/bin/sh
shift
cd "$FAKEHP" && exec "$@"
EOF
chmod +x "$T/fakessh"
# disinteg's server while passive.
python3 -c "
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        s.send_response(503); s.send_header('content-type','application/json'); s.end_headers(); s.wfile.write(b'{\"code\":\"passive\"}')
    def log_message(*a): pass
http.server.HTTPServer(('127.0.0.1',$PORT),H).serve_forever()" &
PID=$!
sleep 0.5

disinteg() { REPLICA_SRC=$SRC REPLICA_HOST=hp REPLICA_SSH=$T/fakessh REPLICA_STEADY=0 REPLICA_PORT=$PORT REPLICA_NO_MOUNTCHECK=1 bash "$HERE/replicate.sh" --once; }
hp() { REP_REPLICA=$FAKEHP bash "$HERE/failover-hp.sh" watch; }

echo "1. disinteg back while HP is ACTIVE: passive, asks for rep. back"
disinteg
[ -e "$SRC/PASSIVE" ] || fail "PASSIVE not set"; ok "PASSIVE set"
[ -e "$FAKEHP/FAILBACK-REQUEST" ] || fail "no FAILBACK-REQUEST on HP"; ok "FAILBACK-REQUEST on HP"
[ "$(q "$SRC/data/app.sqlite")" = old ] || fail "disinteg's data changed too early"; ok "nothing pulled yet"

echo "2. HP: stops, makes its databases whole, answers"
hp
[ -e "$FAKEHP/FAILBACK-READY" ] && [ -e "$FAKEHP/HOLD" ] || fail "HP did not answer"; ok "FAILBACK-READY and HOLD on HP"
[ ! -s "$FAKEHP/data/app.sqlite-wal" ] || fail "WAL not folded in"; ok "no WAL left"

echo "3. disinteg: keeps its old data aside, pulls HP's, comes out of passive"
disinteg
[ "$(q "$SRC/data/app.sqlite")" = new ] && [ "$(q "$SRC/data/users/u1/x.sqlite")" = new ] || fail "data not pulled"; ok "databases are HP's"
[ "$(q "$SRC/data/users/u2/y.sqlite")" = new ] || fail "new account missing"; ok "new account here"
[ "$(cat "$SRC/data/media/p.jpg")" = photo ] || fail "photo missing"; ok "new photo here"
[ ! -e "$SRC/data/gone.txt" ] || fail "stale file kept"; ok "stale file gone"
[ "$(cat "$SRC/data/predeploy-x/keep.txt")" = mine ] || fail "local snapshot touched"; ok "local snapshot folder untouched"
keep=$(ls -d "$SRC"/data/predeploy-failback-* | head -1)
[ "$(q "$keep/app.sqlite")" = old ] || fail "old data not kept"; ok "old data kept in $(basename "$keep")"
[ ! -e "$SRC/PASSIVE" ] || fail "still passive"; ok "PASSIVE removed"
[ -e "$FAKEHP/FAILBACK-DONE" ] || fail "HP not told"; ok "FAILBACK-DONE on HP"

echo "4. HP lets go"
hp
for f in ACTIVE HOLD FAILBACK-REQUEST FAILBACK-READY FAILBACK-DONE; do [ ! -e "$FAKEHP/$f" ] || fail "$f still on HP"; done; ok "ACTIVE, HOLD and FAILBACK-* cleared"

echo "5. the copying runs again, from disinteg"
sqlite3 "$SRC/data/app.sqlite" "UPDATE t SET v='after'"
disinteg
[ "$(q "$FAKEHP/data/app.sqlite")" = after ] || fail "copying did not resume"; ok "HP has disinteg's newest again"
[ -s "$FAKEHP/data/.replica-stamp" ] || fail "no stamp"; ok "copy stamped"
[ ! -e "$SRC/PASSIVE" ] || fail "went passive again"; ok "disinteg stays live"
echo "failback: all good"
