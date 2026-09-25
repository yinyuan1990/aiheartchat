#!/usr/bin/env bash
# Deploy Uniswap V3 (official bytecode) + Arm contracts from the server.
# Network = whatever ARC_RPC_URL in /opt/arm/.env points at; the output file follows the chain id
# (Deploy.s.sol: 5042 → deployments/arc-mainnet.json, otherwise arc-testnet.json; OUT_FILE overrides).
# ECO_FUND / BUYBACK_FUND / DEV_FUND come from .env too — they are immutable, so on mainnet they MUST be set.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /opt/arm/contracts
set -a; . /opt/arm/.env; set +a
CHAIN=$(cast chain-id --rpc-url "$ARC_RPC_URL")
echo "chain:    $CHAIN"
echo "deployer: $DEPLOYER"
echo "balance:  $(cast balance "$DEPLOYER" --rpc-url "$ARC_RPC_URL" --ether) USDC"
echo "ECO_FUND=${ECO_FUND:-<deployer>}  BUYBACK_FUND=${BUYBACK_FUND:-<placeholder>}  DEV_FUND=${DEV_FUND:-<default>}"
if [ "$CHAIN" = "5042" ] && { [ -z "$ECO_FUND" ] || [ -z "$BUYBACK_FUND" ]; }; then
  echo "refusing to deploy to mainnet without ECO_FUND and BUYBACK_FUND"; exit 1
fi
OUT=${OUT_FILE:-$([ "$CHAIN" = "5042" ] && echo deployments/arc-mainnet.json || echo deployments/arc-testnet.json)}
echo "UNI_FACTORY=${UNI_FACTORY:-<deploy own V3>}  TREASURY=${TREASURY:-<deploy new>}  OUT=$OUT"
echo "gas price now: $(cast gas-price --rpc-url "$ARC_RPC_URL") wei"
mkdir -p deployments
# no fixed gas price: mainnet base fee moves 20 → 170+ gwei within a day; forge prices from eth_feeHistory.
# GAS_FLAGS can still pin it, e.g. GAS_FLAGS="--with-gas-price 25gwei --priority-gas-price 1gwei".
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARC_RPC_URL" \
  --broadcast \
  --slow \
  ${GAS_FLAGS:-} \
  -vv 2>&1 | grep -vE '^\s*$' | tail -n 40
echo "---- $OUT ----"
cat "$OUT"
echo
echo "balance after: $(cast balance "$DEPLOYER" --rpc-url "$ARC_RPC_URL" --ether) USDC"
