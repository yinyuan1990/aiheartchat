#!/usr/bin/env bash
# Build + restart the native Arm services ON the server (after `node ops/deploy.mjs --upload-only`). Run with nohup:
#   nohup bash /opt/arm/ops/native-deploy.sh "indexer web" > /root/arm-build.log 2>&1 &
set -euo pipefail
SVCS="${1:-indexer web}"
export NEXT_TELEMETRY_DISABLED=1
# this host's outbound links drop long downloads now and then: generous timeouts + retries, and re-run the whole
# install (the npm cache keeps what already arrived) until it succeeds
npm config set fetch-retries 10 >/dev/null
npm config set fetch-retry-mintimeout 15000 >/dev/null
npm config set fetch-retry-maxtimeout 120000 >/dev/null
npm config set fetch-timeout 600000 >/dev/null
npm config set maxsockets 6 >/dev/null
npm_install() {
  for i in 1 2 3 4 5 6 7 8; do
    if npm install --no-audit --no-fund --loglevel=error; then return 0; fi
    echo "npm install failed (attempt $i), retrying in 10s"; sleep 10
  done
  return 1
}
date
for s in $SVCS; do
  case "$s" in
    indexer)
      echo "== indexer"
      cd /opt/arm/indexer
      npm_install
      npm run build
      chown -R arm:arm /opt/arm/indexer
      systemctl restart arm-indexer
      ;;
    web)
      echo "== web"
      cd /opt/arm/web
      npm_install
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
