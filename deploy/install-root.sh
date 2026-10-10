#!/usr/bin/env bash
# health.ojee.net — the one-time, root part of the install. Run it ON THE BOX
# (disinteg), from the deployed folder, once:
#
#     cd ~/health-server && sudo bash deploy/install-root.sh
#
# It does four things, each safe to run again:
#   1. installs the nginx site and enables it;
#   2. adds health.ojee.net to the cloudflared tunnel's ingress
#      (/etc/cloudflared/config.yml), before the final catch-all 404 rule,
#      keeping a dated backup of the file;
#   3. installs and enables the systemd unit;
#   4. reloads nginx and restarts cloudflared.
#
# It does NOT create the DNS record. After it, run once (as the user that owns
# the tunnel's credentials):
#     cloudflared tunnel route dns <tunnel-name> health.ojee.net
# or add a proxied CNAME health -> <tunnel-id>.cfargotunnel.com in Cloudflare.
#
# Nothing here is run by deploy.sh, and nothing in this repo runs it for you.
set -euo pipefail

HOSTNAME_NEW=health.ojee.net
SERVICE_URL=http://localhost:80
RUN_USER=${RUN_USER:-disinteg}
APP_DIR=${APP_DIR:-/home/$RUN_USER/health-server}
CF_CONFIG=${CF_CONFIG:-/etc/cloudflared/config.yml}
NGINX_AVAIL=/etc/nginx/sites-available/$HOSTNAME_NEW
NGINX_ENABLED=/etc/nginx/sites-enabled/$HOSTNAME_NEW
UNIT=/etc/systemd/system/health.service

[[ $EUID -eq 0 ]] || { echo "Run this with root: sudo bash deploy/install-root.sh" >&2; exit 1; }
cd "$APP_DIR" || { echo "$APP_DIR does not exist. Run deploy.sh from the laptop first." >&2; exit 1; }
for f in deploy/nginx-health.conf deploy/health.service server/index.js; do
  [[ -f $f ]] || { echo "$APP_DIR/$f is missing. Run deploy.sh from the laptop first." >&2; exit 1; }
done
if [[ ! -f .env ]]; then
  echo "$APP_DIR/.env is missing. Create it first:" >&2
  echo "    cp deploy/.env.example .env && chmod 600 .env && nano .env" >&2
  exit 1
fi
chown "$RUN_USER":"$RUN_USER" .env && chmod 600 .env

echo "[1/4] nginx site"
install -m 644 deploy/nginx-health.conf "$NGINX_AVAIL"
ln -sfn "$NGINX_AVAIL" "$NGINX_ENABLED"
nginx -t

echo "[2/4] cloudflared ingress"
if [[ ! -f $CF_CONFIG ]]; then
  echo "  $CF_CONFIG not found — skipping. Add this rule to the tunnel's ingress by hand, before the last rule:" >&2
  echo "      - hostname: $HOSTNAME_NEW" >&2
  echo "        service: $SERVICE_URL" >&2
elif grep -Eq "^[[:space:]]*-?[[:space:]]*hostname:[[:space:]]*\"?${HOSTNAME_NEW//./\\.}\"?[[:space:]]*$" "$CF_CONFIG"; then
  echo "  $HOSTNAME_NEW is already in $CF_CONFIG — left as it is"
else
  backup="$CF_CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CF_CONFIG" "$backup"
  echo "  backup: $backup"
  # The catch-all is the last `- service:` list item with no hostname (usually
  # `- service: http_status:404`). The new rule goes right before it, with the
  # same indentation, so it is matched before the catch-all swallows it.
  tmp=$(mktemp)
  awk -v host="$HOSTNAME_NEW" -v svc="$SERVICE_URL" '
    { lines[NR] = $0 }
    /^[[:space:]]*-[[:space:]]*service:[[:space:]]*/ { last = NR }
    END {
      if (!last) exit 3
      match(lines[last], /^[[:space:]]*/); indent = substr(lines[last], 1, RLENGTH)
      for (i = 1; i <= NR; i++) {
        if (i == last) { print indent "- hostname: " host; print indent "  service: " svc }
        print lines[i]
      }
    }' "$CF_CONFIG" > "$tmp" || {
      rm -f "$tmp"
      echo "  Could not find the catch-all rule (a final \"- service: http_status:404\") in $CF_CONFIG." >&2
      echo "  Nothing was changed. Add the rule by hand before the last ingress rule:" >&2
      echo "      - hostname: $HOSTNAME_NEW" >&2
      echo "        service: $SERVICE_URL" >&2
      exit 1
    }
  cat "$tmp" > "$CF_CONFIG" && rm -f "$tmp"
  # Refuse to leave a config the tunnel will not start with.
  if command -v cloudflared >/dev/null 2>&1 && ! cloudflared tunnel --config "$CF_CONFIG" ingress validate >/dev/null 2>&1; then
    cp -p "$backup" "$CF_CONFIG"
    echo "  cloudflared rejected the edited config; the backup was put back. Add the rule by hand." >&2
    exit 1
  fi
  echo "  added $HOSTNAME_NEW -> $SERVICE_URL"
fi

echo "[3/4] systemd unit"
install -m 644 deploy/health.service "$UNIT"
systemctl daemon-reload
systemctl enable health.service
systemctl restart health.service

echo "[4/4] reload nginx, restart cloudflared"
systemctl reload nginx
if systemctl list-unit-files cloudflared.service >/dev/null 2>&1; then
  systemctl restart cloudflared
else
  echo "  no cloudflared.service unit here — restart the tunnel however it is run on this box"
fi

sleep 2
if curl -fsS -m 5 -H "Host: $HOSTNAME_NEW" http://127.0.0.1/api/health >/dev/null; then
  echo "OK: nginx -> the app answers for $HOSTNAME_NEW."
else
  echo "The app did not answer through nginx yet. Check: journalctl -u health.service -n 50" >&2
fi
echo "Next: the DNS record (see the top of this file), then https://$HOSTNAME_NEW/api/health"
