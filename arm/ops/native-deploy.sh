#!/usr/bin/env bash
# Build + restart the native Arm services ON the server (after `node ops/deploy.mjs --upload-only`). Run with nohup:
#   nohup bash /opt/arm/ops/native-deploy.sh "indexer web" > /root/arm-build.log 2>&1 &
set -euo pipefail
SVCS="${1:-indexer web}"
export NEXT_TELEMETRY_DISABLED=1
date
for s in $SVCS; do
  case "$s" in
    indexer)
      echo "== indexer"
      cd /opt/arm/indexer
      npm install --no-audit --no-fund --loglevel=error
      npm run build
      chown -R arm:arm /opt/arm/indexer
      systemctl restart arm-indexer
      ;;
    web)
      echo "== web"
      cd /opt/arm/web
      npm install --no-audit --no-fund --loglevel=error
      npm run build
      # standalone server needs the static assets and public/ next to it (same as the old Dockerfile)
      rm -rf .next/standalone/.next/static .next/standalone/public
      cp -r .next/static .next/standalone/.next/static
      cp -r public .next/standalone/public
      chown -R arm:arm /opt/arm/web
      systemctl restart arm-web
      ;;
  esac
done
sleep 8
echo "web:     $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/)"
echo "indexer: $(curl -s http://127.0.0.1:3101/api/health)"
systemctl is-active arm-indexer arm-web || true
date
echo BUILD_DONE
