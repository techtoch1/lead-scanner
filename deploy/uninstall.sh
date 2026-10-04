#!/usr/bin/env bash
# Removes everything install.sh added. Leaves other sites alone.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
DOMAIN="${DOMAIN:-leads.aligned-tech.com}"
systemctl disable --now lead-scanner 2>/dev/null || true
rm -f /etc/systemd/system/lead-scanner.service && systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/lead-scanner.conf /etc/nginx/sites-available/lead-scanner.conf /etc/nginx/lead-scanner.htpasswd /etc/lead-scanner.env
nginx -t && systemctl reload nginx
command -v certbot >/dev/null && certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || true
echo "CRM data was kept in /var/lib/lead-scanner (delete it yourself if you don't need it)."
echo "Lead Scanner removed. The code folder is still there; delete it yourself if you want."
