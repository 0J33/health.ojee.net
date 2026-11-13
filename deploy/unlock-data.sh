#!/usr/bin/env bash
# health.ojee.net — open the encrypted data volume by hand, over SSH, when the TPM did not at boot.
#   ssh disinteg, then:   cd ~/health-server && sudo bash deploy/unlock-data.sh
# It asks for the recovery passphrase, mounts data/ and starts rep. again.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }
NAME=healthvault
IMG=/home/health-vault.img
DATA=/home/${RUN_USER:-disinteg}/health-server/data
if findmnt -n "$DATA" >/dev/null; then echo "$DATA is already open and mounted."; else
  [[ -e /dev/mapper/$NAME ]] || systemctl start "systemd-cryptsetup@$NAME.service" 2>/dev/null || cryptsetup open "$IMG" "$NAME"
  [[ -e /dev/mapper/$NAME ]] || cryptsetup open "$IMG" "$NAME"
  mount "$DATA"
fi
systemctl restart health.service
sleep 3
systemctl is-active health.service && echo "rep. is up again."
