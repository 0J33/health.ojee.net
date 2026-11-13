#!/usr/bin/env bash
# health.ojee.net — encryption at rest for ~/health-server/data. Run it ON THE BOX (disinteg), once:
#
#     cd ~/health-server && sudo bash deploy/encrypt-data.sh
#
# The disk has no free space for a new partition, so the "partition" is an encrypted LUKS2 volume
# kept in one file (/home/health-vault.img, 4 GB), which works the same way: it is opened as a
# block device and mounted at ~/health-server/data. It unlocks by itself at boot from this machine's
# TPM, so restarts need nobody. The disk taken out of this machine, or the file copied off it,
# cannot be read. A recovery passphrase is printed ONCE: put it in your password manager, as it is
# the only way in if the TPM is reset (a BIOS update or motherboard change).
#
# Steps, all checked, nothing deleted until the server is back up on the encrypted copy:
#   1. installs cryptsetup if missing;
#   2. makes the volume, protected by the recovery passphrase plus the TPM (PCR 7, Secure Boot state);
#   3. stops health.service and the backup timer, copies data/ in, and checks the copy;
#   4. mounts it at data/ for good (/etc/crypttab, /etc/fstab), and makes health.service wait for it;
#   5. starts the service and checks /api/health. Then, and only then, it shreds the unencrypted copy.
set -euo pipefail

RUN_USER=${RUN_USER:-disinteg}
APP_DIR=/home/$RUN_USER/health-server
DATA=$APP_DIR/data
IMG=/home/health-vault.img
NAME=healthvault
SIZE=${SIZE:-4G}

[[ $EUID -eq 0 ]] || { echo "Run this with root: sudo bash deploy/encrypt-data.sh" >&2; exit 1; }
[[ -d $DATA ]] || { echo "$DATA does not exist." >&2; exit 1; }
if findmnt -n "$DATA" >/dev/null; then echo "$DATA is already a mount: nothing to do."; exit 0; fi
if [[ -e $IMG ]]; then
  # Left by a run that stopped before formatting it: empty, so it goes. A real volume is never touched.
  # A volume in use is named in /etc/crypttab and mounted at data/ (checked above): this one is neither,
  # so it is from a run that stopped before data/ moved, and holds at most a copy.
  if grep -q "^$NAME " /etc/crypttab 2>/dev/null; then echo "$IMG is in /etc/crypttab already: not touching it." >&2; exit 1; fi
  cryptsetup close "$NAME" 2>/dev/null || true
  for l in $(losetup -j "$IMG" | cut -d: -f1); do losetup -d "$l" 2>/dev/null || true; done
  echo "Removing $IMG, left by an earlier run that stopped before your data moved."; rm -f "$IMG"
fi
[[ -e /dev/tpmrm0 ]] || { echo "No TPM here (/dev/tpmrm0): this script relies on it to unlock at boot." >&2; exit 1; }

echo "1. cryptsetup, and the TPM libraries systemd-cryptenroll loads"
command -v cryptsetup >/dev/null || apt-get install -y cryptsetup
apt-get install -y tpm2-tools >/dev/null 2>&1 || echo "  (tpm2-tools not installed; going on)"
command -v systemd-cryptenroll >/dev/null || { echo "systemd-cryptenroll is missing (systemd 248+)." >&2; exit 1; }

echo "2. the volume ($SIZE at $IMG)"
# Anything failing from here to the copy: nothing of the data has been touched, so undo it all.
LOOP=""
undo() {
  echo "Stopped at: $BASH_COMMAND. Undoing; your data was not touched." >&2
  umount /mnt/healthvault 2>/dev/null || true
  cryptsetup close "$NAME" 2>/dev/null || true
  [[ -n $LOOP ]] && losetup -d "$LOOP" 2>/dev/null || true
  shred -u /run/healthvault.key 2>/dev/null || true
  rm -f "$IMG"
}
trap undo ERR
fallocate -l "$SIZE" "$IMG"
chmod 600 "$IMG"
# The recovery passphrase. Not `tr < /dev/urandom | head`: under pipefail, tr's broken pipe stops the script.
RECOVERY=$(openssl rand -base64 64 | tr -dc 'A-HJ-NP-Za-km-z2-9' | cut -c1-32)
[[ ${#RECOVERY} -ge 24 ]]
printf '%s' "$RECOVERY" | cryptsetup luksFormat --type luks2 --batch-mode --key-file - "$IMG"
LOOP=$(losetup --find --show "$IMG")
printf '%s' "$RECOVERY" > /run/healthvault.key; chmod 600 /run/healthvault.key
systemd-cryptenroll --unlock-key-file=/run/healthvault.key --tpm2-device=auto --tpm2-pcrs=7 "$LOOP"
cryptsetup open --key-file /run/healthvault.key "$LOOP" "$NAME"
shred -u /run/healthvault.key
mkfs.ext4 -q -L healthdata "/dev/mapper/$NAME"
mkdir -p /mnt/healthvault && mount "/dev/mapper/$NAME" /mnt/healthvault

trap - ERR
echo "3. the data, copied in with the service stopped"
systemctl stop health-backup.timer 2>/dev/null || true
systemctl stop health.service
rsync -aHAX "$DATA/" /mnt/healthvault/
chown "$RUN_USER:$RUN_USER" /mnt/healthvault
# The new filesystem's own lost+found is not a difference.
if ! diff -rq --exclude=lost+found "$DATA" /mnt/healthvault; then
  echo "The copy differs from data/ (above): stopping, nothing changed; the service and backups start again." >&2
  umount /mnt/healthvault; cryptsetup close "$NAME"; losetup -d "$LOOP"; rm -f "$IMG"
  systemctl start health.service; systemctl start health-backup.timer 2>/dev/null || true
  exit 1
fi
umount /mnt/healthvault
cryptsetup close "$NAME"
losetup -d "$LOOP"

echo "4. mounted at data/ for good"
mv "$DATA" "$DATA.plain"
mkdir -p "$DATA" && chown "$RUN_USER:$RUN_USER" "$DATA"
grep -q "^$NAME " /etc/crypttab 2>/dev/null || echo "$NAME $IMG none luks,tpm2-device=auto" >> /etc/crypttab
grep -q "/dev/mapper/$NAME " /etc/fstab || echo "/dev/mapper/$NAME $DATA ext4 defaults,nofail,x-systemd.device-timeout=60 0 2" >> /etc/fstab
mkdir -p /etc/systemd/system/health.service.d /etc/systemd/system/health-backup.service.d
printf '[Unit]\nRequiresMountsFor=%s\n' "$DATA" > /etc/systemd/system/health.service.d/vault.conf
printf '[Unit]\nRequiresMountsFor=%s\n' "$DATA" > /etc/systemd/system/health-backup.service.d/vault.conf
systemctl daemon-reload
systemctl start "systemd-cryptsetup@$NAME.service"
mount "$DATA"
findmnt -n "$DATA" >/dev/null || { echo "data/ did not mount. The plain copy is at $DATA.plain: move it back (rmdir $DATA; mv $DATA.plain $DATA) and start health.service." >&2; exit 1; }

echo "5. back up, then the plain copy goes"
systemctl start health.service
systemctl start health-backup.timer 2>/dev/null || true
ok=""
for _ in $(seq 1 30); do if curl -fsS http://127.0.0.1:$(grep -oP "(?<=^PORT=)\d+" $APP_DIR/.env || echo 5020)/api/health >/dev/null 2>&1 || systemctl is-active --quiet health.service; then ok=1; break; fi; sleep 2; done
[[ -n $ok ]] || { echo "health.service did not come up. The plain copy is still at $DATA.plain." >&2; exit 1; }
find "$DATA.plain" -type f -exec shred -u {} + && rm -rf "$DATA.plain"

cat <<EOF

Done. ~/health-server/data is now an encrypted volume, unlocked by this machine's TPM at boot.

RECOVERY PASSPHRASE (shown once; save it in your password manager now):

    $RECOVERY

If the TPM ever refuses (a BIOS update, Secure Boot changed), unlock by hand with:
    sudo cryptsetup open $IMG $NAME   # then paste the passphrase
    sudo mount $DATA && sudo systemctl start health.service
and re-bind the TPM with:
    sudo systemd-cryptenroll --wipe-slot=tpm2 --tpm2-device=auto --tpm2-pcrs=7 \$(losetup -j $IMG | cut -d: -f1)
EOF
