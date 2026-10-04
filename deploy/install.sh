#!/usr/bin/env bash
# Installs Lead Scanner on an Ubuntu server that already runs Nginx.
#
#   git clone https://github.com/techtoch1/lead-scanner.git ~/lead-scanner
#   sudo bash ~/lead-scanner/deploy/install.sh
#
# What it adds (and nothing else):
#   /etc/lead-scanner.env                     Apollo API key, readable by root only
#   /etc/nginx/lead-scanner.htpasswd          site login
#   /etc/systemd/system/lead-scanner.service  runs server/server.js on 127.0.0.1:3010
#   /etc/nginx/sites-available/lead-scanner.conf (+ link in sites-enabled)
#   an HTTPS certificate for the domain, via certbot
# It never edits other Nginx sites. If the Nginx config test fails, it removes
# its own site file again and stops. Safe to re-run.
set -euo pipefail

DOMAIN="${DOMAIN:-leads.aligned-tech.com}"
PORT="${PORT:-3010}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
ENV_FILE=/etc/lead-scanner.env
HTPASSWD=/etc/nginx/lead-scanner.htpasswd
UNIT=/etc/systemd/system/lead-scanner.service
SITE=/etc/nginx/sites-available/lead-scanner.conf
LINK=/etc/nginx/sites-enabled/lead-scanner.conf

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }
ask_yes() { local a; read -rp "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }

[[ $EUID -eq 0 ]] || fail "run it with sudo: sudo bash $0"
[[ -f "$APP_DIR/server/server.js" ]] || fail "can't find server/server.js next to this script."
command -v nginx >/dev/null || fail "Nginx isn't installed."
[[ "$APP_USER" != root ]] || fail "run it with sudo from your normal user, not as root."

say "Checking Node.js"
NODE_BIN="$(sudo -u "$APP_USER" -H bash -lc 'command -v node' 2>/dev/null || true)"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node.js not found."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || fail "Node.js 18 or newer is needed (found $("$NODE_BIN" -v))."
echo "Using $NODE_BIN ($("$NODE_BIN" -v)), running as user '$APP_USER'."

say "Making sure nothing else uses $DOMAIN or port $PORT"
OTHER_SITES="$(grep -rlE "server_name[^;]*[[:space:]]$DOMAIN[[:space:];]" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -v 'lead-scanner.conf' || true)"
[[ -z "$OTHER_SITES" ]] || fail "$DOMAIN is already used by: $OTHER_SITES"
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet lead-scanner; then
  fail "port $PORT is already in use by another program. Re-run with PORT=3011 sudo -E bash $0"
fi
echo "OK."

say "Apollo API key"
if [[ -s "$ENV_FILE" ]] && grep -q '^APOLLO_API_KEY=.' "$ENV_FILE" && ! ask_yes "A key is already saved. Replace it?"; then
  echo "Keeping the saved key."
else
  read -rsp "Paste your Apollo API key (it won't show on screen), then press Enter: " KEY; echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  [[ -n "$KEY" ]] || fail "no key entered."
  ( umask 077; printf 'APOLLO_API_KEY=%s\n' "$KEY" > "$ENV_FILE" )
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
  unset KEY
  echo "Saved to $ENV_FILE (root only)."
fi

say "Site login (protects the page and your Apollo credits)"
if [[ -s "$HTPASSWD" ]] && ! ask_yes "A login already exists. Replace it?"; then
  echo "Keeping the existing login."
else
  read -rp "Username [aligned]: " WEB_USER; WEB_USER="${WEB_USER:-aligned}"
  [[ "$WEB_USER" =~ ^[A-Za-z0-9._-]+$ ]] || fail "username can only use letters, numbers, dot, dash and underscore."
  while true; do
    read -rsp "Password (at least 10 characters): " P1; echo
    read -rsp "Same password again: " P2; echo
    [[ "$P1" == "$P2" ]] || { echo "They don't match, try again."; continue; }
    (( ${#P1} >= 10 )) || { echo "Too short, try again."; continue; }
    break
  done
  HASH="$(printf '%s' "$P1" | openssl passwd -apr1 -stdin)"
  unset P1 P2
  printf '%s:%s\n' "$WEB_USER" "$HASH" > "$HTPASSWD"
  chown root:www-data "$HTPASSWD"; chmod 640 "$HTPASSWD"
  echo "Login saved for '$WEB_USER'."
fi

say "Setting up the background service"
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Lead Scanner (leads.aligned-tech.com)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$ENV_FILE
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
ExecStart=$NODE_BIN $APP_DIR/server/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
UNIT_EOF
systemctl daemon-reload
systemctl enable lead-scanner >/dev/null 2>&1
systemctl restart lead-scanner
for i in {1..20}; do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || { journalctl -u lead-scanner -n 20 --no-pager; fail "the service didn't start (log above)."; }
echo "Running on 127.0.0.1:$PORT."

say "Adding the Nginx site for $DOMAIN"
if [[ -f "$SITE" ]] && grep -q 'ssl_certificate' "$SITE"; then
  echo "Site file already has HTTPS set up; leaving it as is."
else
  cat > "$SITE" <<'SITE_EOF'
# Lead Scanner. Added by lead-scanner/deploy/install.sh
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    auth_basic "Lead Scanner";
    auth_basic_user_file __HTPASSWD__;
    add_header X-Robots-Tag "noindex, nofollow" always;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
SITE_EOF
  sed -i "s#__DOMAIN__#$DOMAIN#; s#__HTPASSWD__#$HTPASSWD#; s#__PORT__#$PORT#" "$SITE"
  # Only listen on IPv6 if Nginx already does (avoids a failed config test on IPv4-only hosts).
  ss -ltnH 'sport = :80' | grep -q '\[' || sed -i '/listen \[::\]:80;/d' "$SITE"
fi
ln -sf "$SITE" "$LINK"
if ! nginx -t 2>/tmp/lead-scanner-nginx-test.txt; then
  cat /tmp/lead-scanner-nginx-test.txt
  rm -f "$LINK"
  fail "Nginx config test failed, so the Lead Scanner site was removed again. Your other sites were not changed."
fi
systemctl reload nginx
echo "Site added."

say "HTTPS certificate"
if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]] && grep -q 'ssl_certificate' "$SITE"; then
  echo "Already set up."
else
  if ! command -v certbot >/dev/null; then
    if ask_yes "certbot (free HTTPS certificates) isn't installed. Install it now?"; then
      apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx
    fi
  fi
  if command -v certbot >/dev/null; then
    certbot --nginx -d "$DOMAIN" --redirect --cert-name "$DOMAIN" || echo "certbot failed; the site still works over http://$DOMAIN. Fix the error above and run: sudo certbot --nginx -d $DOMAIN --redirect"
  else
    echo "Skipped. The site works over http://$DOMAIN for now."
  fi
fi

say "Done"
echo "Open https://$DOMAIN and log in with the username and password you chose."
echo "To update later: bash $APP_DIR/deploy/update.sh"
