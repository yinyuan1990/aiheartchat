#!/usr/bin/env bash
# Live smoke test runner. Edit STEP/TOKEN below or generate a variant into ops/.tmp.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /opt/arm/contracts
set -a; . /opt/arm/.env; set +a
export STEP="${STEP:-launch}"
export TOKEN="${TOKEN:-}"
# --skip-simulation: Arc's USDC calls a blocklist precompile (0x18..01) that forge's local EVM lacks.
forge script script/Smoke.s.sol:Smoke --rpc-url "$ARC_RPC_URL" --broadcast --slow --skip-simulation \
  --with-gas-price 25gwei --priority-gas-price 1gwei -vv 2>&1 | grep -vE '^\s*$|Warning|foundry-pp|Compiling|Solc|No files' | tail -n 45
