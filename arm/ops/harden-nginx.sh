#!/usr/bin/env bash
# One-shot hardening after the 9.20 connection flood (see docs/12 "9.20 晚：DDoS 演示"). Idempotent; safe to re-run.
#  1. nginx.conf: worker_rlimit_nofile / worker_connections / multi_accept, short client timeouts, drop idle conns.
#     (Per-IP limit_req / limit_conn live in the site template ops/deploy/nginx-arm.conf — render with domains.sh.)
#  2. fail2ban: ban IPs that keep sending junk (400) or keep tripping the nginx rate limit (429) — 10 min at the firewall.
# Run on the server:  bash /opt/arm/ops/harden-nginx.sh   (uploaded by deploy.mjs with the rest of ops/)
set -euo pipefail

NGX=/etc/nginx/nginx.conf
if ! grep -q 'worker_rlimit_nofile' "$NGX"; then
  cp -a "$NGX" "$NGX.bak-$(date +%Y%m%d%H%M%S)"
  # main context
  sed -i 's/^worker_processes auto;/worker_processes auto;\nworker_rlimit_nofile 65535;/' "$NGX"
  # events
  sed -i 's/^\(\s*\)worker_connections 768;/\1worker_connections 16384;\n\1multi_accept on;/' "$NGX"
  # http: idle / slowloris budgets (defaults are 60s each)
  sed -i '0,/^http {/s//http {\n\t# 9.20 hardening: drop idle \/ half-open clients fast (defaults 60s)\n\treset_timedout_connection on;\n\tclient_header_timeout 10s;\n\tclient_body_timeout 15s;\n\tsend_timeout 30s;\n\tkeepalive_timeout 30s;\n\tkeepalive_requests 200;/' "$NGX"
  echo "nginx.conf patched"
else
  echo "nginx.conf already patched"
fi

# --- fail2ban ------------------------------------------------------------------------------------------------
cat > /etc/fail2ban/filter.d/nginx-badreq.conf <<'EOF'
# Clients whose requests nginx rejects as malformed (400, e.g. the "PRI * HTTP/2.0" preface flood of 9.20) or
# rate-limits (429 from limit_req / limit_conn). Matches the default combined access log.
[Definition]
failregex = ^<HOST> .*" (400|429) \d+ 
ignoreregex =
EOF

cat > /etc/fail2ban/jail.d/nginx-abuse.conf <<'EOF'
# 9.20: ban repeat abusers for 10 minutes. Both jails watch nginx; ssh jail is separate (jail.local / defaults).
# NOTE: if the site is ever put behind Cloudflare, remote_addr becomes Cloudflare's edge — disable these jails or
# switch nginx to real_ip_header CF-Connecting-IP first, or we ban Cloudflare itself.
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 45.205.17.161

[nginx-badreq]
enabled  = true
port     = http,https
filter   = nginx-badreq
logpath  = /var/log/nginx/access.log
maxretry = 30
findtime = 60
bantime  = 600

[nginx-limit-req]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 20
findtime = 60
bantime  = 600
EOF

# --- apply ---------------------------------------------------------------------------------------------------
bash /opt/arm/ops/domains.sh render     # re-render the site conf from the template, nginx -t, reload
nginx -t
systemctl reload nginx
fail2ban-client reload
sleep 2
fail2ban-client status
fail2ban-client status nginx-badreq | sed -n '1,8p'
echo "== effective nginx settings =="
nginx -T 2>/dev/null | grep -E 'worker_(rlimit_nofile|connections)|multi_accept|limit_(req|conn)(_zone)? |client_header_timeout|reset_timedout' | sed 's/^\s*//' | sort -u
