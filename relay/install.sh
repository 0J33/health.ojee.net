#!/usr/bin/env bash
# Install the heart-rate relay as a systemd user service on this machine.
# Needs BlueZ, python3-dbus and python3-gi (Debian/Ubuntu: python3-dbus python3-gi).
# The link key goes in ~/.config/health-hr-relay/key (made on the site: Me,
# Connections, Accounts, Console health module, Make a link key).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ~/.local/share/health-hr-relay ~/.config/health-hr-relay ~/.config/systemd/user
install -m 0755 hr-relay.py ~/.local/share/health-hr-relay/hr-relay.py
install -m 0644 health-hr-relay.service ~/.config/systemd/user/health-hr-relay.service
[ -f ~/.config/health-hr-relay/key ] || { echo "Put the link key in ~/.config/health-hr-relay/key, then run this again." >&2; exit 1; }
chmod 600 ~/.config/health-hr-relay/key
systemctl --user daemon-reload
systemctl --user enable --now health-hr-relay.service
systemctl --user --no-pager status health-hr-relay.service | head -5
