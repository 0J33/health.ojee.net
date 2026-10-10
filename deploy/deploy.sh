#!/usr/bin/env bash
# Deploy health.ojee.net to disinteg. Layout on the box:
#
#   /home/$REMOTE_USER/health-server/         the repo: server/, web/, package*.json
#   /home/$REMOTE_USER/health-server/.env     live secrets (never shipped, never deleted)
#   /home/$REMOTE_USER/health-server/data/    everybody's data (never shipped, never deleted)
#
# run by health.service on 127.0.0.1:5020, behind nginx and the cloudflared tunnel.
# The first time, run deploy/install-root.sh ON THE BOX with root, once.
#
# Required env (put these in deploy/deploy.local.env, which is gitignored):
#   REMOTE_HOST   target machine (Tailscale IP or hostname)
#   REMOTE_USER   ssh login user
#   SSHPASS       ssh password, consumed by `sshpass -e`. Leave unset to use
#                 key-based auth; the sshpass wrapper drops out on its own.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f deploy/deploy.local.env ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source deploy/deploy.local.env
  set +o allexport
fi

: "${REMOTE_HOST:?REMOTE_HOST not set — see deploy/deploy.local.env.example}"
: "${REMOTE_USER:?REMOTE_USER not set — see deploy/deploy.local.env.example}"

# `sshpass -e` reads the password from SSHPASS, so it never appears on a
# command line or in a process listing. With no SSHPASS, plain ssh is used and
# key auth applies.
if [[ -n "${SSHPASS:-}" ]]; then
  export SSHPASS
  SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new "${REMOTE_USER}@${REMOTE_HOST}")
  RSYNC=(sshpass -e rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new")
else
  SSH=(ssh -o StrictHostKeyChecking=accept-new "${REMOTE_USER}@${REMOTE_HOST}")
  RSYNC=(rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new")
fi
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
DEST="/home/${REMOTE_USER}/health-server"

echo "[1/4] tests"
npm test >/dev/null 2>&1 || { echo "  npm test failed — not deploying. Run it to see why." >&2; exit 1; }
[[ -f web/index.html ]] || { echo "  web/index.html is missing — nothing to serve." >&2; exit 1; }
echo "  passed"

echo "[2/4] rsync -> $REMOTE:$DEST/"
# --delete keeps the box equal to the repo, EXCEPT what only exists there:
# everybody's data and the live .env. node_modules is installed on the box so
# its own node build is the one used. Excludes are protected from --delete.
"${RSYNC[@]}" \
  --exclude '/data/' --exclude '/.env' --exclude '/.env.*' --exclude 'node_modules/' --exclude 'web/dev/' \
  --exclude '.git/' --exclude 'tests/' --exclude 'deploy/deploy.local.env' --exclude '*.log' \
  ./ "$REMOTE:$DEST/"

echo "[3/4] install deps + restart health.service"
"${SSH[@]}" bash -s <<'REMOTE_SH'
set -u
cd "$HOME/health-server" || exit 1
PATH=/home/disinteg/.nvm/versions/node/v22.22.2/bin:$PATH
[ -f .env ] || { echo "  FAILED: $PWD/.env is missing. Copy deploy/.env.example there and fill it in." >&2; exit 1; }
chmod 600 .env
npm ci --omit=dev --silent 2>&1 | tail -3

unit=health.service
if ! systemctl cat "$unit" >/dev/null 2>&1; then
  echo "  FAILED: $unit is not installed. Run deploy/install-root.sh on the box with root, once." >&2
  exit 1
fi
before=$(systemctl show "$unit" -p MainPID --value)
# disinteg has no NOPASSWD rule for this unit, and a sudo that falls through to
# a password prompt would fail *after* the files were copied — a deploy that
# looks finished while the old code is still serving. The unit is
# Restart=on-failure, so killing our own process is a restart and needs no
# privilege at all. Same pattern as dnd.ojee.net's and teg.ojee.net's deploy.
if sudo -n systemctl restart "$unit" 2>/dev/null; then
  echo "  restarted via sudo"
else
  echo "  no sudo for $unit; killing pid $before — Restart=on-failure brings it back"
  [ -n "$before" ] && [ "$before" != "0" ] && kill -9 "$before" 2>/dev/null
fi

for _ in $(seq 1 25); do
  sleep 1
  now=$(systemctl show "$unit" -p MainPID --value)
  state=$(systemctl show "$unit" -p ActiveState --value)
  if [ "$state" = "active" ] && [ -n "$now" ] && [ "$now" != "0" ] && [ "$now" != "$before" ]; then
    echo "  up as pid $now"
    exit 0
  fi
done
echo "  FAILED: $unit did not come back. On the box: journalctl -u $unit -n 50" >&2
exit 1
REMOTE_SH

echo "[4/4] health check"
# Through Cloudflare and nginx, not just the socket — that is what a browser
# actually hits. Retried: the service was restarted a second ago, so the first
# request can still land on a closed port and 502 through the proxy.
probe() {  # $1 = url. Prints "<code> <body>"; non-zero if it never reached 200.
  local url="$1" out code body
  for _ in $(seq 1 15); do
    out=$(curl -s -m 20 -w '\n%{http_code}' "$url" || true)
    code=${out##*$'\n'}; body=${out%$'\n'*}
    [[ "$code" == 200 ]] && { echo "$code $body"; return 0; }
    sleep 2
  done
  echo "$code $body"
  return 1
}

want=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
if out=$(probe https://health.ojee.net/api/health); then
  echo "  health.ojee.net/api/health -> $out"
  [[ "$out" == *"\"version\":\"$want\""* ]] || { echo "  it answers, but not as version $want — the old process may still be serving" >&2; exit 1; }
else
  echo "  health.ojee.net/api/health -> $out"; echo "  API is not healthy" >&2; exit 1
fi
if out=$(probe https://health.ojee.net/); then
  echo "  health.ojee.net -> ${out%% *}"
else
  echo "  health.ojee.net -> ${out%% *}"; echo "  the app is not serving" >&2; exit 1
fi

echo
echo "Deployed."
