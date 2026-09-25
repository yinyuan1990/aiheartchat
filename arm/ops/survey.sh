#!/usr/bin/env bash
# Read-only survey of the deploy server.
echo '== docker =='
if command -v docker >/dev/null; then docker --version; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | head -30; else echo '- not installed'; fi
echo; echo '== listening =='
ss -tlnpH 2>/dev/null | awk '{print $4, $6}' | sed 's/users:((//; s/,.*//' | sort -u
echo; echo '== running services (non-system) =='
systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}' \
  | grep -viE 'systemd|dbus|cron|ssh|getty|rsyslog|polkit|snapd|networkd|resolved|udev|journald|logind|multipath|unattended|qemu|chrony|irqbalance|ModemManager|accounts|atd|packagekit'
echo; echo '== tools =='
for b in node npm pnpm pm2 nginx caddy psql redis-server solana solana-validator solana-test-validator anchor cargo rustc git ufw fail2ban-client foundryup forge; do
  printf '%-22s %s\n' "$b" "$(command -v $b 2>/dev/null || echo -)"
done
node -v 2>/dev/null; cargo --version 2>/dev/null
echo; echo '== top processes by mem =='
ps aux --sort=-%mem | awk 'NR<=8{printf "%-8s %5s%% %5s%% %s\n", $1, $3, $4, substr($0, index($0,$11), 100)}'
echo; echo '== dirs =='
ls -la /root | grep -v '^total'
echo '-- /home /opt /srv:'; ls /home /opt /srv 2>/dev/null
echo; echo '== crontab =='; crontab -l 2>/dev/null | head; ls /etc/cron.d 2>/dev/null
echo; echo '== ufw =='; ufw status 2>/dev/null | head -5
echo; echo '== failed ssh logins last hour =='; journalctl -u ssh --since '1 hour ago' --no-pager 2>/dev/null | grep -c 'Failed password'
