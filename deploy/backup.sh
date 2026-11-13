#!/usr/bin/env bash
# Backs up everything rep. holds that cannot be read again from Google, Garmin, Hevy or Strava:
# every SQLite database (copied consistently while the server runs, then checked), the
# per-person files beside them (connections, media), and the account list in MongoDB
# (shared with mtg and dnd: only its users collection). One archive per run, kept here and
# copied to the HP box's NAS disk, so losing this machine loses nothing.
#
#   deploy/backup.sh            run by health-backup.timer (deploy/health-backup.*), every 6 hours
#
# The archives are encrypted (AES-256, openssl) with the key in ~/.config/rep-backup.key, so a
# copy on the NAS, or a lost disk, cannot be read. The key is also on the laptop
# (~/.config/ojee-health/rep-backup.key). Without the key the archives are useless: keep a copy.
#
# Restore: stop health.service, decrypt and unpack an archive over an empty ~/health-server/data
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$HOME/.config/rep-backup.key \
#     -in rep-YYYYmmdd-HHMM.tgz.enc | tar -xz -C /tmp/r && cp -a /tmp/r/data/. ~/health-server/data/
#   mongorestore --uri "$MONGODB_URI" --gzip --archive=/tmp/r/mongo-users.archive.gz --nsInclude 'mtg.users'
# then start the service. Caches (map tiles, exercise images) are not kept: they fill back in.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)               # ~/health-server
cd "$HERE"
KEEP_HERE=28                                          # a week, at four a day
KEEP_THERE=120                                        # a month on the NAS
OUT="$HOME/health-backups/auto"
REMOTE='ojee@100.117.98.52'
REMOTE_DIR='nas-storage/backups/rep'
SSH=(ssh -i "$HOME/.ssh/id_ed25519_hp" -o BatchMode=yes -o ConnectTimeout=15)

# data/ is the encrypted vault. If it did not unlock at boot, data/ is an empty folder: back up
# nothing rather than an empty archive that would push a real one out of the rotation.
if [ ! -s data/app.sqlite ]; then
  echo "backup: data/ is not mounted (no data/app.sqlite), nothing backed up" >&2; exit 1
fi

stamp=$(date -u +%Y%m%d-%H%M)
mkdir -p "$OUT"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. Every database, copied with SQLite's own backup (safe while it is being written), then checked.
n=0
while IFS= read -r -d '' f; do
  mkdir -p "$tmp/$(dirname "$f")"
  sqlite3 "$f" ".timeout 20000" ".backup '$tmp/$f'"
  check=$(sqlite3 "$tmp/$f" 'PRAGMA integrity_check;')
  if [ "$check" != "ok" ]; then echo "backup: $f failed its integrity check: $check" >&2; exit 1; fi
  n=$((n + 1))
done < <(find data \( -path data/lost+found -o -path data/.replica -o -path 'data/predeploy-*' -o -path 'data/merge-backup-*' \) -prune -o -name '*.sqlite' -not -path 'data/tiles/*' -not -path 'data/basemap/*' -print0)

# 2. The rest of data/ that is not a cache: connections, photos and videos, settings files.
rsync -a --exclude '/lost+found' --exclude '/.replica/' --exclude '/.replica-stamp' --exclude '/predeploy-*/' --exclude '/merge-backup-*/' --exclude '*.sqlite' --exclude '*.sqlite-wal' --exclude '*.sqlite-shm' \
  --exclude 'tiles/' --exclude 'basemap/' --exclude 'exercise-img/' data/ "$tmp/data/"

# 3. The accounts: usernames and password hashes live in MongoDB, shared with mtg and dnd.
uri=$(grep -E '^MONGODB_URI=' .env | head -1 | cut -d= -f2- || true)
if [ -n "$uri" ]; then
  mongodump --quiet --uri "$uri" --collection users --gzip --archive="$tmp/mongo-users.archive.gz"
fi

KEY="$HOME/.config/rep-backup.key"
if [ -s "$KEY" ]; then
  archive="$OUT/rep-$stamp.tgz.enc"
  tar -C "$tmp" -cz . | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$KEY" -out "$archive.part"
else
  echo "backup: no key at $KEY, so this archive is NOT encrypted" >&2
  archive="$OUT/rep-$stamp.tgz"
  tar -C "$tmp" -czf "$archive.part" .
fi
mv "$archive.part" "$archive"
size=$(du -h "$archive" | cut -f1)
ls -1t "$OUT"/rep-*.tgz* | tail -n +$((KEEP_HERE + 1)) | xargs -r rm --

# 4. Off this machine.
"${SSH[@]}" "$REMOTE" "mkdir -p $REMOTE_DIR"
rsync -a -e "${SSH[*]}" "$archive" "$REMOTE:$REMOTE_DIR/"
"${SSH[@]}" "$REMOTE" "ls -1t $REMOTE_DIR/rep-*.tgz* | tail -n +$((KEEP_THERE + 1)) | xargs -r rm --"

echo "backup: $n databases, $size, kept in $OUT and on the HP box ($REMOTE_DIR)"
