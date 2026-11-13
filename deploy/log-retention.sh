#!/usr/bin/env bash
# health.ojee.net — keep server logs 14 days at most, as the privacy policy says. Run it ON THE BOX,
# once, as root:   cd ~/health-server && bash deploy/log-retention.sh   (with root rights)
#
# nginx already rotates daily and keeps 14 (/etc/logrotate.d/nginx). The system journal, which holds
# rep.'s own log (health.service), had no time limit: this caps it at 14 days for the whole box.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/retention.conf <<'CONF'
# health.ojee.net (deploy/log-retention.sh): logs are kept 14 days at most (privacy policy).
[Journal]
MaxRetentionSec=14day
CONF
systemctl restart systemd-journald
journalctl --vacuum-time=14d
grep -q 'rotate 14' /etc/logrotate.d/nginx && echo "nginx: 14 daily logs (unchanged)" || echo "nginx: check /etc/logrotate.d/nginx keeps 14 days or fewer"
echo "Done: the journal now keeps 14 days."
