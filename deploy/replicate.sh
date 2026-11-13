#!/usr/bin/env bash
# health.ojee.net — keep a live copy of rep. on the HP box, so nothing is lost if disinteg goes down.
# Runs ON DISINTEG as the disinteg user, kept alive by pm2 (it comes back after a reboot):
#
#   pm2 start ~/health-server/deploy/replicate.sh --name rep-replica --interpreter bash && pm2 save
#
# Every $EVERY seconds it copies to HP:~/rep-replica/ (over a key that can only write there, rrsync):
#   data/   everybody's data: each SQLite database as a consistent snapshot (sqlite3 .backup, only the
#           ones that changed), every other file as it is (media, sources, map caches);
#   app/    the code and .env, and keys/ the notification keys, so HP can run rep. from the copy
#           (deploy/failover-hp.sh);
#   data/.replica-stamp   when the copy was last complete.
# It never runs when the encrypted data volume is not mounted (an empty folder must not wipe the copy),
# and stops pushing while HP:~/rep-replica/ACTIVE exists (rep. is running from the copy on HP: its
# data is now the newer one and must be brought back first, see failover-hp.sh). Seeing that, it also
# leaves ~/health-server/PASSIVE, which turns this server passive (server/index.js: 503, no syncs, no
# notifications) until HP's data is back here.
#
# Coming back is automatic too (failback). Once this box has been well for STEADY seconds (its data
# volume open, its passive server answering), it asks HP to stop (HP:FAILBACK-REQUEST). HP stops rep.,
# folds every database's WAL into the file and answers HP:FAILBACK-READY (failover-hp.sh watch). Then
# here: the old data kept aside (data/predeploy-failback-*, hard links), HP's data pulled in, the
# snapshot staging cleared (so the next push sends everything fresh), HP:FAILBACK-DONE written, and
# PASSIVE removed: this server starts again in full and HP clears ACTIVE, after which the copying
# resumes. Visitors see the maintenance page for the minute or two it takes.
set -uo pipefail
HP=${REPLICA_HOST:-ojee@100.117.98.52}
KEY=${REPLICA_KEY:-$HOME/.ssh/id_ed25519_rep_replica}
EVERY=${REPLICA_EVERY:-30}
STEADY=${REPLICA_STEADY:-600}       # how long this box must be well before taking rep. back from HP
PORT=${REPLICA_PORT:-5020}
# Tests (deploy/test-failback.sh) run on plain folders: no mounted volume to check.
mounted() { [ -n "${REPLICA_NO_MOUNTCHECK:-}" ] || mountpoint -q "$DATA"; }
SRC=${REPLICA_SRC:-$HOME/health-server}
DATA=$SRC/data
STAGE=$DATA/.replica
SSH=${REPLICA_SSH:-"ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ControlMaster=auto -o ControlPath=$HOME/.ssh/rep-replica-%C -o ControlPersist=300"}
log() { echo "$(date '+%F %T') $*"; }
on_hp() { rsync -e "$SSH" --list-only "$HP:$1" >/dev/null 2>&1; }
well_since=""

# rep. is running on HP: stay passive, and take it back once this box has been well for a while.
while_active() {
  [ -e "$SRC/PASSIVE" ] || { date -u +%FT%TZ > "$SRC/PASSIVE"; log "rep. is running on HP (ACTIVE): this server goes passive, not pushing"; }
  if on_hp FAILBACK-DONE; then log "failback done here: waiting for HP to let go"; return 0; fi
  # Well: the data volume open and the passive server answering.
  if ! { mounted && [ -s "$DATA/app.sqlite" ] && curl -s -m 5 "http://127.0.0.1:$PORT/api/health" | grep -q '"passive"'; }; then
    well_since=""; return 0
  fi
  [ -n "$well_since" ] || well_since=$(date +%s)
  [ $(( $(date +%s) - well_since )) -ge "$STEADY" ] || return 0
  if ! on_hp FAILBACK-READY; then
    on_hp FAILBACK-REQUEST || { date -u +%FT%TZ > "$SRC/.failback-request" && rsync -e "$SSH" "$SRC/.failback-request" "$HP:FAILBACK-REQUEST" && log "well for $((STEADY / 60)) min: asked HP to hand rep. back"; }
    return 0
  fi
  # HP has stopped and its databases are whole files: bring its data here.
  local keep; keep="$DATA/predeploy-failback-$(date -u +%Y%m%d-%H%M)"
  rsync -a --link-dest="$DATA" --exclude '/lost+found/' --exclude '/predeploy-*/' --exclude '/merge-backup-*/' --exclude '/.replica/' "$DATA/" "$keep/" || { log "failback: could not keep the old data aside"; return 1; }
  # By checksum: a database of the same size and time on both sides must still come over.
  if ! rsync -a --checksum --delete -e "$SSH" --exclude '/lost+found/' --exclude '/predeploy-*/' --exclude '/merge-backup-*/' --exclude '/.replica/' --exclude '/.replica-stamp' "$HP:data/" "$DATA/"; then
    log "failback: pulling HP's data failed; staying passive and trying again"; return 1
  fi
  [ -s "$DATA/app.sqlite" ] || { log "failback: no app.sqlite after the pull: staying passive"; return 1; }
  rm -rf "$STAGE"
  date -u +%FT%TZ > "$SRC/.failback-done" && rsync -e "$SSH" "$SRC/.failback-done" "$HP:FAILBACK-DONE" || { log "failback: could not tell HP"; return 1; }
  rm -f "$SRC/PASSIVE" "$SRC/.failback-request" "$SRC/.failback-done"
  # Old failback copies go after two weeks.
  find "$DATA" -maxdepth 1 -name 'predeploy-failback-*' -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
  well_since=""
  log "failback: HP's data is here (the old kept in $keep); this server starts again in full"
}

once() {
  if on_hp ACTIVE; then while_active; return 0; fi
  well_since=
  mounted && [ -s "$DATA/app.sqlite" ] || { log "data volume not mounted: skipped"; return 0; }
  mkdir -p "$STAGE"
  # Consistent snapshots of the databases that changed since their last snapshot (the file or its WAL).
  local n=0
  while IFS= read -r -d '' db; do
    local rel=${db#"$DATA"/} out="$STAGE/${db#"$DATA"/}"
    if [ ! -e "$out" ] || [ "$db" -nt "$out" ] || { [ -e "$db-wal" ] && [ "$db-wal" -nt "$out" ]; }; then
      mkdir -p "$(dirname "$out")"
      sqlite3 "$db" ".timeout 5000" ".backup '$out.tmp'" && mv -f "$out.tmp" "$out" && n=$((n + 1)) || log "snapshot failed: $rel"
    fi
  done < <(find "$DATA" \( -path "$STAGE" -o -path "$DATA/lost+found" -o -path "$DATA/predeploy-*" -o -path "$DATA/merge-backup-*" \) -prune -o -name '*.sqlite' -type f -print0)
  # Snapshots of databases that are gone (a deleted account) go too.
  find "$STAGE" -name '*.sqlite' -type f -print0 | while IFS= read -r -d '' s; do [ -e "$DATA/${s#"$STAGE"/}" ] || rm -f "$s"; done

  # Files: everything but the databases (theirs are the snapshots) and what is only local.
  rsync -a --delete -e "$SSH" \
    --exclude '/.replica/' --exclude '/lost+found/' --exclude '/predeploy-*/' --exclude '*.sqlite' --exclude '*.sqlite-wal' --exclude '*.sqlite-shm' --exclude '*.tmp' --exclude '/.replica-stamp' \
    "$DATA/" "$HP:data/" || { log "files: rsync failed"; return 1; }
  # Databases: the snapshots, deleting copies of ones that are gone (only *.sqlite is in scope).
  rsync -a --delete -e "$SSH" --filter 'P */' --include '*/' --include '*.sqlite' --exclude '*' "$STAGE/" "$HP:data/" || { log "databases: rsync failed"; return 1; }
  # The code and its settings, for running it there.
  rsync -a --delete -e "$SSH" --exclude '/data/' --exclude 'node_modules/' --exclude '.git/' --exclude '*.log' --exclude '.env.bak*' --exclude '/PASSIVE' --exclude '/.failback-*' \
    "$SRC/" "$HP:app/" || { log "app: rsync failed"; return 1; }
  # The notification keys the settings point at (outside the app folder), for the same.
  local keys=() k
  for k in $(grep -E '^(FCM_SERVICE_ACCOUNT|APNS_KEY_FILE)=' "$SRC/.env" | cut -d= -f2-); do [ -f "$k" ] && keys+=("$k"); done
  [ ${#keys[@]} -gt 0 ] && { rsync -a -e "$SSH" "${keys[@]}" "$HP:keys/" || log "keys: rsync failed"; }
  date -u +%FT%TZ > "$STAGE/.stamp" && rsync -a -e "$SSH" "$STAGE/.stamp" "$HP:data/.replica-stamp" >/dev/null 2>&1
  [ "$n" -gt 0 ] && log "copied ($n database snapshot(s))"
  return 0
}

[ "${1:-}" = "--once" ] && { once; exit $?; }
log "rep-replica: every ${EVERY}s to $HP:~/rep-replica"
while true; do once; sleep "$EVERY"; done
