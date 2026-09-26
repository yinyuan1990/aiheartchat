#!/usr/bin/env bash
# Relay VPS: sing-box VLESS + Reality inbound on 443. Outbound = direct, or a residential SOCKS5 when
# /etc/sing-box/upstream.env has UP_HOST / UP_PORT / UP_USER / UP_PASS. Re-running keeps the existing keys.
#   bash setup-singbox.sh            # install / re-render config
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SNI=${SNI:-www.microsoft.com}
D=/etc/sing-box
mkdir -p $D

if ! command -v sing-box >/dev/null; then
  apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
  curl -fsSL https://sing-box.app/install.sh | sh
fi

# BBR
grep -q 'tcp_congestion_control=bbr' /etc/sysctl.conf || { echo 'net.core.default_qdisc=fq' >> /etc/sysctl.conf; echo 'net.ipv4.tcp_congestion_control=bbr' >> /etc/sysctl.conf; }
sysctl -p >/dev/null

# keys (generated once)
if [ ! -f $D/keys.env ]; then
  KP=$(sing-box generate reality-keypair)
  {
    echo "UUID=$(sing-box generate uuid)"
    echo "PRIV=$(echo "$KP" | awk '/PrivateKey/{print $2}')"
    echo "PUB=$(echo "$KP" | awk '/PublicKey/{print $2}')"
    echo "SID=$(sing-box generate rand 8 --hex)"
  } > $D/keys.env
  chmod 600 $D/keys.env
fi
. $D/keys.env
[ -f $D/upstream.env ] && . $D/upstream.env

if [ -n "${UP_HOST:-}" ]; then
  OUT="{\"type\":\"socks\",\"tag\":\"out\",\"server\":\"$UP_HOST\",\"server_port\":$UP_PORT,\"version\":\"5\",\"username\":\"${UP_USER:-}\",\"password\":\"${UP_PASS:-}\"}"
else
  OUT='{"type":"direct","tag":"out"}'
fi

cat > $D/config.json <<EOF
{
  "log": { "level": "warn" },
  "dns": { "servers": [ { "type": "https", "tag": "doh", "server": "1.1.1.1" } ] },
  "inbounds": [{
    "type": "vless", "tag": "in", "listen": "::", "listen_port": 443,
    "users": [ { "uuid": "$UUID", "flow": "xtls-rprx-vision" } ],
    "tls": { "enabled": true, "server_name": "$SNI",
      "reality": { "enabled": true, "handshake": { "server": "$SNI", "server_port": 443 }, "private_key": "$PRIV", "short_id": ["$SID"] } }
  }],
  "outbounds": [ $OUT ],
  "route": { "final": "out", "default_domain_resolver": "doh" }
}
EOF
sing-box check -c $D/config.json

if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 443/tcp >/dev/null; fi
systemctl enable sing-box >/dev/null 2>&1
systemctl restart sing-box
sleep 2
systemctl is-active sing-box

IP=$(curl -4 -s https://api.ipify.org)
echo "LINK=vless://$UUID@$IP:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=$SNI&fp=chrome&pbk=$PUB&sid=$SID&type=tcp#proxy-tokyo"
echo "EXIT_IP=$(curl -4 -s --max-time 10 https://ipinfo.io/json | tr -d '\n ')"
echo SETUP_DONE
