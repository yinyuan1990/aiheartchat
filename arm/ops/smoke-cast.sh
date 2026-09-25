#!/usr/bin/env bash
# Live smoke test with `cast send` (forge script cannot simulate Arc's USDC blocklist precompile).
#   STEP=launch | trade TOKEN=0x.. | fees TOKEN=0x..
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /opt/arm/contracts
set -a; . /opt/arm/.env; set +a
DEP=${DEP:-deployments/arc-mainnet.json}
j() { python3 -c "import json,sys; print(json.load(open('$DEP'))['$1'])"; }
FACTORY=$(j launchFactory); LOCKER=$(j feeLocker); ROUTER=$(j swapRouter); TREASURY=$(j treasury)
RPC="$ARC_RPC_URL"
# LAUNCH_KEY lets a one-off run use another wallet (boss's launch wallet) instead of the server key
if [ -n "${LAUNCH_KEY:-}" ]; then PRIVATE_KEY="$LAUNCH_KEY"; DEPLOYER=$(cast wallet address --private-key "$LAUNCH_KEY"); fi
# no fixed gas price (mainnet base fee swings 20 → 170+ gwei); cast prices each tx from the node
SEND="cast send --rpc-url $RPC --private-key $PRIVATE_KEY --json"
CALL="cast call --rpc-url $RPC"
STEP="${STEP:-launch}"

bal() { $CALL "$USDC" 'balanceOf(address)(uint256)' "$1" | awk '{print $1}'; }
echo "me: $DEPLOYER  usdc: $(bal "$DEPLOYER")"

if [ "$STEP" = "launch" ]; then
  FIRST=${FIRST_BUY:-3000000}
  echo "platform start mcap (usdc6): $($CALL "$FACTORY" 'startMcapUsdc()(uint256)' | awk '{print $1}')  (token address is CREATE2 w/ prev blockhash — not predictable ahead of time)"
  FEE=$($CALL "$FACTORY" 'creationFee()(uint256)' | awk '{print $1}')
  NEED=$((FEE + FIRST))
  HAVE=$(bal "$DEPLOYER")
  if [ "$HAVE" -lt "$((NEED + 300000))" ]; then echo "insufficient USDC: have $HAVE, need fee $FEE + first buy $FIRST + gas; lower FIRST_BUY or top up"; exit 1; fi
  $SEND "$USDC" 'approve(address,uint256)' "$FACTORY" "$NEED" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("approve", r["status"], r["transactionHash"])'
  NAME="${NAME:-Arc Cat}"; SYMBOL="${SYMBOL:-ACAT}"
  # tax mode via env: BUY_TAX / SELL_TAX in bps, MARKETING / TEAM wallets (0 = deployer), MARKETING_BPS share
  ZERO=0x0000000000000000000000000000000000000000
  BUY_TAX=${BUY_TAX:-0}; SELL_TAX=${SELL_TAX:-0}; MARKETING=${MARKETING:-$ZERO}; TEAM=${TEAM:-$ZERO}; MARKETING_BPS=${MARKETING_BPS:-5000}
  # LOGO / DESC overridable; default to a neutral emoji logo — never the ARK brand (9.16 lesson: test tokens get traded)
  LOGO="${LOGO:-emoji:🧪}"; DESC="${DESC:-Smoke test token.}"
  ARGS="(\"$NAME\",\"$SYMBOL\",\"$LOGO\",\"$DESC\",(\"${WEBSITE:-}\",\"${TWITTER:-}\",\"${TELEGRAM:-}\",\"\",\"\"),$ZERO,$BUY_TAX,$SELL_TAX,$MARKETING,$TEAM,$MARKETING_BPS,$FIRST,0)"
  # explicit limit: the CREATE2 salt includes the previous block hash, so an estimate made one block earlier can be ~5% short
  $SEND --gas-limit 11000000 "$FACTORY" 'launch((string,string,string,string,(string,string,string,string,string),address,uint16,uint16,address,address,uint16,uint256,uint256))' "$ARGS" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); print("launch", r["status"], r["transactionHash"], "gas", int(r["gasUsed"],16))'
  N=$($CALL "$FACTORY" 'totalLaunches()(uint256)' | awk '{print $1}')
  TOKEN=$($CALL "$FACTORY" 'allTokens(uint256)(address)' $((N-1)))
  POOL=$($CALL "$FACTORY" 'launches(address)(address,address,address,uint256,bool,uint256,uint256,uint256,uint256,bool,bool)' "$TOKEN" | sed -n '3p')
  echo "TOKEN=$TOKEN"
  echo "POOL=$POOL"
  echo "creator tokens: $($CALL "$TOKEN" 'balanceOf(address)(uint256)' "$DEPLOYER")"
  echo "pool tokens:    $($CALL "$TOKEN" 'balanceOf(address)(uint256)' "$POOL")"
  echo "pool usdc:      $(bal "$POOL")"
  echo "treasury usdc:  $(bal "$TREASURY")"
  echo "slot0:          $($CALL "$POOL" 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)' | head -2 | tr '\n' ' ')"

elif [ "$STEP" = "trade" ]; then
  : "${TOKEN:?TOKEN required}"; BUY=${BUY_USDC:-2000000}
  $SEND "$USDC" 'approve(address,uint256)' "$ROUTER" "$BUY" >/dev/null
  DL=$(( $(date +%s) + 600 ))
  $SEND "$ROUTER" 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))' "($USDC,$TOKEN,10000,$DEPLOYER,$DL,$BUY,0,0)" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); print("buy", r["status"], r["transactionHash"])'
  TB=$($CALL "$TOKEN" 'balanceOf(address)(uint256)' "$DEPLOYER" | awk '{print $1}')
  HALF=$(python3 -c "print($TB // 2)")
  $SEND "$TOKEN" 'approve(address,uint256)' "$ROUTER" "$HALF" >/dev/null
  $SEND "$ROUTER" 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))' "($TOKEN,$USDC,10000,$DEPLOYER,$DL,$HALF,0,0)" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); print("sell", r["status"], r["transactionHash"])'
  echo "my tokens now: $($CALL "$TOKEN" 'balanceOf(address)(uint256)' "$DEPLOYER")"
  echo "graduation (paired, threshold, graduated): $($CALL "$FACTORY" 'graduationStatus(address)(uint256,uint256,bool)' "$TOKEN" | tr '\n' ' ')"

elif [ "$STEP" = "fees" ]; then
  : "${TOKEN:?TOKEN required}"
  echo "pendingOwed (token, usdc): $($CALL "$LOCKER" 'pendingOwed(address)(uint256,uint256)' "$TOKEN" | tr '\n' ' ')"
  ME0=$(bal "$DEPLOYER"); TR0=$(bal "$TREASURY")
  # minUsdcOut=0 is fine for a manual smoke run; the keeper passes a quote-based guard
  $SEND "$LOCKER" 'distribute(address,uint256)(uint256,uint256)' "$TOKEN" 0 | python3 -c 'import sys,json; r=json.load(sys.stdin); print("distribute", r["status"], r["transactionHash"], "logs", len(r["logs"]))'
  echo "creator  +usdc: $(( $(bal "$DEPLOYER") - ME0 ))"
  echo "treasury +usdc: $(( $(bal "$TREASURY") - TR0 ))"
  echo "claimable(creator, usdc): $($CALL "$LOCKER" 'claimable(address,address)(uint256)' "$DEPLOYER" "$USDC")"
  echo "unconverted token fees:   $($CALL "$LOCKER" 'unconvertedTokenFees(address)(uint256)' "$TOKEN")"

elif [ "$STEP" = "execute" ]; then
  # v2.10: weekly settlement = three plain USDC transfers (76% eco / 20% buyback fund / 4% dev), no swap
  ECO=$($CALL "$TREASURY" 'ecoFund()(address)'); BB=$($CALL "$TREASURY" 'buybackFund()(address)'); DEV=$($CALL "$TREASURY" 'devFund()(address)')
  echo "pending: $($CALL "$TREASURY" 'pendingRevenue()(uint256)')  nextExecuteAt: $($CALL "$TREASURY" 'nextExecuteAt()(uint256)')"
  E0=$(bal "$ECO"); B0=$(bal "$BB"); D0=$(bal "$DEV")
  $SEND "$TREASURY" 'execute()' | python3 -c 'import sys,json; r=json.load(sys.stdin); print("execute", r["status"], r["transactionHash"])'
  echo "eco     +usdc: $(( $(bal "$ECO") - E0 ))  ($ECO)"
  echo "buyback +usdc: $(( $(bal "$BB") - B0 ))  ($BB)"
  echo "dev     +usdc: $(( $(bal "$DEV") - D0 ))  ($DEV)"
  echo "treasury left: $(bal "$TREASURY")"
fi
echo "usdc left: $(bal "$DEPLOYER")"
