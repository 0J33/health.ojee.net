#!/usr/bin/env bash
# health.ojee.net — never let the encrypted data volume stop the box from booting. Run it ON THE BOX,
# once, as root, after it is back up:   cd ~/health-server && bash deploy/fix-vault-boot.sh
#
# What went wrong on 12 Nov: /etc/crypttab named the volume without `nofail`, so when the TPM did not
# unlock it at boot, systemd stopped the boot to ask for the passphrase on a console nobody can see,
# before the network came up. This makes it:
#   - headless: never ask on the console;
#   - nofail: boot goes on without it (health.service waits for the mount, so rep. simply stays down
#     until the volume is opened; every other service on the box starts as usual);
#   - still tried with the TPM first.
# If the TPM does not unlock it, open it over SSH:   sudo bash deploy/unlock-data.sh
# It also prints why the TPM did not unlock it on this boot, for fixing that next.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }
NAME=healthvault
IMG=/home/health-vault.img

grep -q "^$NAME " /etc/crypttab || { echo "No $NAME line in /etc/crypttab: nothing to fix." >&2; exit 1; }
cp /etc/crypttab "/etc/crypttab.bak-$(date +%Y%m%d-%H%M%S)"
sed -i "s|^$NAME .*|$NAME $IMG none luks,tpm2-device=auto,nofail,headless=true,x-systemd.device-timeout=30s|" /etc/crypttab
echo "crypttab now:"; grep "^$NAME " /etc/crypttab
grep -q "/dev/mapper/$NAME .*nofail" /etc/fstab && echo "fstab: nofail already" || echo "fstab: CHECK the $NAME line has nofail"
systemctl daemon-reload

echo
echo "Why the TPM did not unlock it on this boot:"
journalctl -b --no-pager -q -u "systemd-cryptsetup@$NAME.service" 2>/dev/null | tail -20 || true
journalctl -b --no-pager -q 2>/dev/null | grep -iE "tpm|tss|cryptsetup|$NAME" | tail -15 || true
echo
echo "TPM token on the volume:"
cryptsetup luksDump "$IMG" | sed -n '/Tokens:/,/Digests:/p' | head -12
echo "Done. A reboot can no longer stop at a passphrase prompt."
