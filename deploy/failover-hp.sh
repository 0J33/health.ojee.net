#!/usr/bin/env bash
# health.ojee.net — run rep. from the live copy on the HP box (deploy/replicate.sh keeps it, ~40 s behind),
# for when disinteg is down. Run ON HP as ojee:   bash ~/rep-replica/app/deploy/failover-hp.sh <command>
#
#   status   how fresh the copy is, and whether rep. is running from it here
#   start    run rep. here from the copy (systemd user unit rep-standby, 127.0.0.1:5020). It marks the
#            copy ACTIVE first, so disinteg stops pushing over it once it is back: from now on HP's
#            data is the newer one.
#   stop     stop rep. here. The copy stays ACTIVE until it has been brought back (failback).
#   failback when disinteg is up again: stop rep. here (HOLD keeps the watch from starting it again) and
#            print the steps that hand HP's newer data back to disinteg.
#   done     after those steps: clear ACTIVE and HOLD, so the copying resumes.
#   watch    run every minute by rep-standby-watch.timer (install-watch): starts rep. here by itself
#            when rep.ojee.net has been down for 5 checks in a row AND disinteg has stopped pushing the
#            copy for 3 minutes AND this box can reach Cloudflare (so a problem here is not taken for
#            one there). Never while ACTIVE or HOLD.
#   install-watch   the timer for watch.
#
# Public traffic reaches it through the rep-standby Cloudflare tunnel (rep-standby-tunnel.service,
# ~/.cloudflared/rep-standby.yml) and the rep-maintenance Worker (deploy/edge), which sends everyone
# here while rep. answers here. disinteg's own server goes passive by itself when it sees ACTIVE
# (deploy/replicate.sh, server/index.js), so only one of the two ever serves.
set -euo pipefail
R=$HOME/rep-replica
UNIT=rep-standby
# A timer's environment is bare: node from where it is installed (nvm or /usr/local).
NVM_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)
PATH="${NVM_BIN:+$NVM_BIN:}/usr/local/bin:/usr/bin:/bin:$PATH"
NODE=$(command -v node || true)

status() {
  echo "copy last complete: $(cat "$R/data/.replica-stamp" 2>/dev/null || echo never) (now $(date -u +%FT%TZ))"
  [ -e "$R/ACTIVE" ] && echo "ACTIVE since $(cat "$R/ACTIVE"): HP's data is the newer one" || echo "not active: disinteg is the live server"
  systemctl --user is-active "$UNIT" >/dev/null 2>&1 && echo "rep. is running here: $(curl -s -m 5 http://127.0.0.1:5020/api/health)" || echo "rep. is not running here"
}

start() {
  [ -s "$R/data/app.sqlite" ] || { echo "No copy at $R/data." >&2; exit 1; }
  [ -n "$NODE" ] || { echo "node is not installed here." >&2; exit 1; }
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
  [ -e "$R/ACTIVE" ] || { echo "Not active: nothing to bring back."; return 0; }
  date -u +%FT%TZ > "$R/HOLD"
  stop
  # Everything written here into the databases themselves, so the files alone are the whole data.
  find "$R/data" -name '*.sqlite' -type f -exec sqlite3 {} "PRAGMA wal_checkpoint(TRUNCATE);" \; >/dev/null
  cat <<STEPS

rep. is stopped here (visitors see the maintenance page). Bring HP's data back to disinteg. On disinteg
(up, the data volume open; its server is passive, so it holds no database open):
  1. pm2 stop rep-replica
  2. rsync -a --delete -e 'ssh -i ~/.ssh/id_ed25519_hp' --exclude '/lost+found/' --exclude '/predeploy-*/' \\
       --exclude '/merge-backup-*/' --exclude '/.replica/' --exclude '/.replica-stamp' \\
       ojee@100.117.98.52:rep-replica/data/ ~/health-server/data/
  3. rm ~/health-server/PASSIVE          (the server starts again in full within 15 s)
     curl -s localhost:5020/api/health   (ok)
Then here:  bash $0 done
And on disinteg:  pm2 start rep-replica
STEPS
}

done_() { rm -f "$R/ACTIVE" "$R/HOLD" "$R/.watch"; echo "ACTIVE and HOLD cleared: disinteg is the live server again; start rep-replica there."; }

watch() {
  { [ -e "$R/ACTIVE" ] || [ -e "$R/HOLD" ]; } && return 0
  local n; n=$(cat "$R/.watch" 2>/dev/null || echo 0)
  # Only judged when this box itself is online.
  curl -sf -m 10 -o /dev/null https://www.cloudflare.com/cdn-cgi/trace || return 0
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://rep.ojee.net/api/health || true)
  if [ "$code" = 200 ]; then echo 0 > "$R/.watch"; return 0; fi
  # disinteg still pushing the copy means it is up with its data open: it will be back; do not split.
  local stamp age
  stamp=$(cat "$R/data/.replica-stamp" 2>/dev/null || echo 1970-01-01T00:00:00Z)
  age=$(( $(date +%s) - $(date -d "$stamp" +%s 2>/dev/null || echo 0) ))
  if [ "$age" -lt 180 ]; then echo 0 > "$R/.watch"; logger -t rep-standby "rep.ojee.net answered $code, but disinteg pushed the copy ${age}s ago: waiting"; return 0; fi
  n=$((n + 1)); echo "$n" > "$R/.watch"
  logger -t rep-standby "rep.ojee.net answered $code and the copy is ${age}s old: check $n of 5"
  if [ "$n" -ge 5 ]; then
    logger -t rep-standby "rep.ojee.net has been down for 5 checks: starting rep. from the copy on HP"
    start
  fi
}

install_watch() {
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/rep-standby-watch.service" <<UNIT
[Unit]
Description=Start rep. on HP when disinteg is down (failover-hp.sh watch)
[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $R/app/deploy/failover-hp.sh watch
UNIT
  cat > "$HOME/.config/systemd/user/rep-standby-watch.timer" <<UNIT
[Unit]
Description=Check every minute whether rep. should run on HP
[Timer]
OnBootSec=3min
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now rep-standby-watch.timer
  systemctl --user list-timers rep-standby-watch.timer --no-pager | head -2
}

case "${1:-status}" in
  status) status ;; start) start ;; stop) stop ;; failback) failback ;; done) done_ ;; watch) watch ;; install-watch) install_watch ;;
  *) echo "usage: $0 status|start|stop|failback|done|watch|install-watch" >&2; exit 2 ;;
esac
