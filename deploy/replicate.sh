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
# data is now the newer one and must be brought back first, see failover-hp.sh).
set -uo pipefail
HP=${REPLICA_HOST:-ojee@100.117.98.52}
KEY=${REPLICA_KEY:-$HOME/.ssh/id_ed25519_rep_replica}
EVERY=${REPLICA_EVERY:-30}
SRC=$HOME/health-server
DATA=$SRC/data
STAGE=$DATA/.replica
SSH="ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ControlMaster=auto -o ControlPath=$HOME/.ssh/rep-replica-%C -o ControlPersist=300"
log() { echo "$(date '+%F %T') $*"; }

once() {
  mountpoint -q "$DATA" && [ -s "$DATA/app.sqlite" ] || { log "data volume not mounted: skipped"; return 0; }
  if rsync -e "$SSH" --list-only "$HP:ACTIVE" >/dev/null 2>&1; then log "rep. is running on HP (ACTIVE): not pushing"; return 0; fi
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
  rsync -a --delete -e "$SSH" --exclude '/data/' --exclude 'node_modules/' --exclude '.git/' --exclude '*.log' --exclude '.env.bak*' \
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
