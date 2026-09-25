#!/usr/bin/env bash
# One-time (idempotent) native setup of the Arm stack ON the server — no Docker (this host cannot pull reliably from
# Docker Hub). Installs Node 24 + PostgreSQL, creates the `arm` DB / user, writes systemd units. Run with nohup:
#   nohup bash /opt/arm/ops/native-setup.sh > /root/arm-setup.log 2>&1 &
set -euo pipefail
cd /opt/arm
set -a; . ./.env; set +a
export DEBIAN_FRONTEND=noninteractive

# --- stop anything Docker left behind
pkill -f "docker pull" 2>/dev/null || true
pkill -f "docker compose" 2>/dev/null || true

# --- Node 24 (official tarball; nodejs.org is reachable from here)
if ! /usr/local/bin/node -v 2>/dev/null | grep -q '^v24'; then
  f=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/linux-x64.tar.xz$/ {print $2; exit}')
  echo "installing $f"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$f" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
node -v; npm -v

# --- PostgreSQL (distro 14 is enough for the indexer) + rsync for source sync
apt-get install -y -q postgresql rsync >/dev/null
systemctl enable --now postgresql
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='arm'" | grep -q 1 \
  || sudo -u postgres psql -c "create role arm login password '${POSTGRES_PASSWORD}'"
sudo -u postgres psql -c "alter role arm password '${POSTGRES_PASSWORD}'" >/dev/null
sudo -u postgres psql -tAc "select 1 from pg_database where datname='arm'" | grep -q 1 \
  || sudo -u postgres psql -c "create database arm owner arm"

# --- service user + data dirs
id arm >/dev/null 2>&1 || useradd --system --home /opt/arm --shell /usr/sbin/nologin arm
mkdir -p /opt/arm/data/uploads
chown -R arm:arm /opt/arm/data

# --- indexer environment (what docker-compose.yml used to pass)
cat > /opt/arm/indexer.env <<EOF
NODE_ENV=production
PORT=3101
RPC_URL=${ARC_RPC_URL:-https://rpc.mainnet.arc.io}
RPC_URLS=${RPC_URLS:-}
DATABASE_URL=postgres://arm:${POSTGRES_PASSWORD}@127.0.0.1:5432/arm
DEPLOYMENTS_FILE=/opt/arm/contracts/deployments/${DEPLOYMENTS_JSON:-arc-mainnet.json}
UPLOAD_DIR=/opt/arm/data/uploads
PUBLIC_DOMAINS=${PUBLIC_DOMAINS:-arm.yyheart.com}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}
SERVER_IP=${SERVER_IP:-}
KEEPER_ENABLED=true
KEEPER_PRIVATE_KEY=${PRIVATE_KEY}
KEEPER_INTERVAL_MS=60000
KEEPER_FEE_THRESHOLD=${KEEPER_FEE_THRESHOLD:-10000000}
KEEPER_MAX_AGE_MS=${KEEPER_MAX_AGE_MS:-7200000}
HOTSPOTS_ENABLED=${HOTSPOTS_ENABLED:-true}
X_BEARER_TOKEN=${X_BEARER_TOKEN:-}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
FAL_KEY=${FAL_KEY:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHANNEL=${TELEGRAM_CHANNEL:-}
TELEGRAM_REF=${TELEGRAM_REF:-}
EOF
chmod 600 /opt/arm/indexer.env

cat > /etc/systemd/system/arm-indexer.service <<'EOF'
[Unit]
Description=Arm indexer + API + keeper
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=arm
WorkingDirectory=/opt/arm/indexer
EnvironmentFile=/opt/arm/indexer.env
ExecStart=/usr/local/bin/node dist/main.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/arm-web.service <<'EOF'
[Unit]
Description=Arm web (Next.js standalone)
After=network-online.target

[Service]
User=arm
WorkingDirectory=/opt/arm/web/.next/standalone
Environment=NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=127.0.0.1
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable arm-indexer arm-web >/dev/null 2>&1
echo SETUP_DONE
