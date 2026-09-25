#!/usr/bin/env bash
# Create the testnet deployer/keeper wallet on the server (idempotent). Prints only the address.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
ENV=/opt/arm/.env
touch "$ENV"; chmod 600 "$ENV"
# drop any half-written entries from a previous run
sed -i '/^PRIVATE_KEY=$/d; /^DEPLOYER=$/d; /^PRIVATE_KEY=0xd4df/d' "$ENV"
if ! grep -q '^PRIVATE_KEY=0x' "$ENV"; then
  json=$(cast wallet new --json 2>/dev/null)
  # cast's JSON shape varies by version ({data:[{address,private_key}]} or [{...}]); dig for the fields.
  read -r addr pk < <(echo "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
def find(o):
    if isinstance(o, dict):
        if "address" in o and "private_key" in o: return o
        for v in o.values():
            r = find(v)
            if r: return r
    if isinstance(o, list):
        for v in o:
            r = find(v)
            if r: return r
w = find(d)
print(w["address"], w["private_key"])')
  {
    echo "PRIVATE_KEY=$pk"
    echo "DEPLOYER=$addr"
  } >> "$ENV"
  grep -q '^ARC_RPC_URL=' "$ENV" || echo "ARC_RPC_URL=https://rpc.testnet.arc.io" >> "$ENV"
  grep -q '^USDC=' "$ENV" || echo "USDC=0x3600000000000000000000000000000000000000" >> "$ENV"
fi
set -a; . "$ENV"; set +a
echo "deployer: $DEPLOYER"
echo "usdc balance (native, 18dp): $(cast balance "$DEPLOYER" --rpc-url "$ARC_RPC_URL")"
echo "usdc balance (erc20, 6dp):   $(cast call "$USDC" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$ARC_RPC_URL")"
