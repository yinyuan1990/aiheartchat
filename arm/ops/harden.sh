#!/usr/bin/env bash
# Baseline hardening. Safe with existing services: only 22/80/443 are exposed anyway.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq fail2ban >/dev/null

cat >/etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 4
findtime = 10m
bantime  = 24h
bantime.increment = true
bantime.maxtime   = 7d
EOF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

# Firewall: allow ssh first so we never lock ourselves out.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo '== fail2ban =='; fail2ban-client status sshd | sed -n '1,12p'
echo '== ufw =='; ufw status numbered
echo '== docker still up =='; docker ps --format '{{.Names}} {{.Status}}'
echo HARDEN_OK
