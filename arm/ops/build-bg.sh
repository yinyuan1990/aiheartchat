#!/usr/bin/env bash
# Runs ON the server: build + (re)start the Arm stack in the background, log to /root/arm-build.log.
#   bash /opt/arm/ops/build-bg.sh [services]      (default: web indexer)
# Uses the legacy builder with already-pulled base images: on this host BuildKit's layer fetch stalls forever
# (plain `docker pull` works once /etc/docker/daemon.json turns off the containerd snapshotter).
SVCS="${1:-web indexer}"
cat > /root/arm-build.sh <<EOF
set -e
cd /opt/arm
set -a; . ./.env; set +a
date
docker pull node:24-alpine >/dev/null
docker pull postgres:16-alpine >/dev/null
for s in $SVCS; do
  echo "== build \$s"; DOCKER_BUILDKIT=0 docker build -t arm/\$s:latest ./\$s 2>&1 | grep -E '^Step|Successfully|ERROR|error' || true
done
docker compose up -d --no-build --remove-orphans db $SVCS
sleep 8
echo "web:     \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/)"
echo "indexer: \$(curl -s http://127.0.0.1:3101/api/health)"
docker ps --filter name=arm --format '{{.Names}}  {{.Status}}'
date
echo BUILD_DONE
EOF
pkill -f "compose build" 2>/dev/null
nohup bash /root/arm-build.sh > /root/arm-build.log 2>&1 < /dev/null &
echo "build started (tail /root/arm-build.log)"
