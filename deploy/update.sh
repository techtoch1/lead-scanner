#!/usr/bin/env bash
# Pulls the latest Lead Scanner from GitHub and restarts it.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git -C "$APP_DIR" pull --ff-only
if ! sudo grep -q '^LOGIN_HASH=' /etc/lead-scanner.env 2>/dev/null || ! grep -q '^StateDirectory=' /etc/systemd/system/lead-scanner.service 2>/dev/null; then
  echo "This update needs a one-time setup step. Run: sudo bash $APP_DIR/deploy/install.sh"
  exit 0
fi
sudo systemctl restart lead-scanner
sleep 1
systemctl is-active lead-scanner >/dev/null && echo "Updated and running." || { sudo journalctl -u lead-scanner -n 20 --no-pager; exit 1; }
