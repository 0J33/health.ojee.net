#!/usr/bin/env bash
# health.ojee.net — run rep. from the live copy on the HP box (deploy/replicate.sh keeps it, ~40 s behind),
# for when disinteg is down. Run ON HP as ojee:   bash ~/rep-replica/app/deploy/failover-hp.sh <command>
#
#   status   how fresh the copy is, and whether rep. is running from it here
#   start    run rep. here from the copy (systemd user unit rep-standby, 127.0.0.1:5020). It marks the
#            copy ACTIVE first, so disinteg stops pushing over it once it is back: from now on HP's
#            data is the newer one.
#   stop     stop rep. here. The copy stays ACTIVE until it has been brought back (failback).
#   failback when disinteg is up again: stop rep. here, hand HP's newer data back to disinteg, and clear
#            ACTIVE so the copying resumes. Prints the steps for disinteg (they need its own login).
#
# Public traffic reaches it through the rep-standby Cloudflare tunnel when that is set up (see
# docs/RELEASE.md, "Live copy on HP"); without it, rep. runs here but only on HP itself.
set -euo pipefail
R=$HOME/rep-replica
UNIT=rep-standby
NODE=$(command -v node)

status() {
  echo "copy last complete: $(cat "$R/data/.replica-stamp" 2>/dev/null || echo never) (now $(date -u +%FT%TZ))"
  [ -e "$R/ACTIVE" ] && echo "ACTIVE since $(cat "$R/ACTIVE"): HP's data is the newer one" || echo "not active: disinteg is the live server"
  systemctl --user is-active "$UNIT" >/dev/null 2>&1 && echo "rep. is running here: $(curl -s -m 5 http://127.0.0.1:5020/api/health)" || echo "rep. is not running here"
}

start() {
  [ -s "$R/data/app.sqlite" ] || { echo "No copy at $R/data." >&2; exit 1; }
  [ -e "$R/ACTIVE" ] || date -u +%FT%TZ > "$R/ACTIVE"
  (cd "$R/app" && npm ci --omit=dev --silent 2>&1 | tail -3)
  # The settings are disinteg's; only the paths differ here.
  sed -E -e "s|^DATA_DIR=.*||" -e "s|^(FCM_SERVICE_ACCOUNT)=.*/|\1=$R/keys/|" -e "s|^(APNS_KEY_FILE)=.*/|\1=$R/keys/|" "$R/app/.env" > "$R/standby.env"
  echo "DATA_DIR=$R/data" >> "$R/standby.env"; chmod 600 "$R/standby.env"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/$UNIT.service" <<UNIT
[Unit]
Description=rep. from the live copy (disinteg is down)
[Service]
WorkingDirectory=$R/app
EnvironmentFile=$R/standby.env
ExecStart=$NODE --disable-warning=ExperimentalWarning server/index.js
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user restart "$UNIT"
  for _ in $(seq 1 20); do sleep 1; curl -sf -m 3 http://127.0.0.1:5020/api/health >/dev/null && break; done
  status
}

stop() { systemctl --user stop "$UNIT" 2>/dev/null || true; status; }

failback() {
  stop
  [ -e "$R/ACTIVE" ] || { echo "Not active: nothing to bring back."; return 0; }
  # Everything written here into the databases themselves, so the files alone are the whole data.
  find "$R/data" -name '*.sqlite' -type f -exec sqlite3 {} "PRAGMA wal_checkpoint(TRUNCATE);" \; >/dev/null
  cat <<STEPS

Bring HP's data back to disinteg, then let the copying resume. On disinteg (it is up, the volume open):
  1. pm2 stop rep-replica && sudo systemctl stop health.service
  2. rsync -a --delete --exclude '/lost+found/' --exclude '/predeploy-*/' --exclude '/.replica/' \\
       ojee@100.117.98.52:rep-replica/data/ ~/health-server/data/
     (use the disinteg -> HP login, not the rep-replica key: that one can only write to HP)
  3. sudo systemctl start health.service
Then here:  rm $R/ACTIVE      and on disinteg:  pm2 start rep-replica
STEPS
}

case "${1:-status}" in
  status) status ;; start) start ;; stop) stop ;; failback) failback ;;
  *) echo "usage: $0 status|start|stop|failback" >&2; exit 2 ;;
esac
