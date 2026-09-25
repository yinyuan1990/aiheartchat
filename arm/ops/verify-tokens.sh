#!/usr/bin/env bash
# Verify every LaunchToken (and the protocol contracts) on Sourcify so wallets / risk scanners stop flagging them as
# "not open source". Sourcify lists Arc mainnet (5042) since 2026-09; arcscan reads verification from it.
# Runs on the server from cron (see docs/12): */5 * * * * flock -n /tmp/verify.lock bash /opt/arm/ops/verify-tokens.sh
# State: /opt/arm/verified.txt (one address per line, lowercase) — addresses already confirmed as verified.
set -u
export PATH="$HOME/.foundry/bin:$PATH"
cd /opt/arm/contracts
STATE=/opt/arm/verified.txt; touch "$STATE"
CHAIN=5042
DEP=deployments/arc-mainnet.json

is_verified() { # Sourcify v2 lookup → "exact_match" / "match" / 404
  curl -s -m 20 "https://sourcify.dev/server/v2/contract/$CHAIN/$1" | python3 -c 'import sys,json
try:
  j=json.load(sys.stdin); print(j.get("match") or "")
except Exception: print("")'
}

verify() { # $1 address, $2 contract path:name
  local a=$1 c=$2 lc
  lc=$(echo "$a" | tr A-F a-f)
  grep -q "$lc" "$STATE" && return 0
  local m; m=$(is_verified "$a")
  if [ -n "$m" ]; then echo "$lc" >> "$STATE"; echo "$(date -u +%FT%TZ) already verified $a ($m)"; return 0; fi
  echo "$(date -u +%FT%TZ) submitting $a as $c"
  forge verify-contract --verifier sourcify --chain-id $CHAIN "$a" "$c" 2>&1 | grep -E 'Job ID|rror' | sed 's/^/    /'
  sleep 8
  m=$(is_verified "$a")
  if [ -n "$m" ]; then echo "$lc" >> "$STATE"; echo "    → $m"; else echo "    → not yet verified (will retry next run)"; fi
}

j() { python3 -c "import json; d=json.load(open('$DEP')); print(d$1)"; }
# protocol contracts of every generation
verify "$(j "['launchFactory']")" src/LaunchFactory.sol:LaunchFactory
verify "$(j "['feeLocker']")" src/FeeLocker.sol:FeeLocker
verify "$(j "['treasury']")" src/Treasury.sol:Treasury
for i in $(python3 -c "import json; print(' '.join(str(i) for i in range(len(json.load(open('$DEP')).get('legacy',[])))))"); do
  verify "$(j "['legacy'][$i]['launchFactory']")" src/LaunchFactory.sol:LaunchFactory
  verify "$(j "['legacy'][$i]['feeLocker']")" src/FeeLocker.sol:FeeLocker
done
# stock generation (pools quoted in tokenized stocks), present once ops/deploy-stock.sh has run and been merged
if python3 -c "import json,sys; sys.exit(0 if 'stock' in json.load(open('$DEP')) else 1)"; then
  verify "$(j "['stock']['launchFactory']")" src/stock/StockLaunchFactory.sol:StockLaunchFactory
  verify "$(j "['stock']['feeLocker']")" src/stock/StockFeeLocker.sol:StockFeeLocker
  verify "$(j "['stock']['quoteOracle']")" src/stock/StockQuoteOracle.sol:StockQuoteOracle
fi
# every launched token (all generations, hidden ones too — holders still deserve a verified contract)
for a in $(docker exec arm-db psql -U arm -d arm -At -c "select address from tokens order by launch_ts"); do
  verify "$a" src/LaunchToken.sol:LaunchToken
done
