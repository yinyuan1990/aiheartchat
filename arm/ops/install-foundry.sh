#!/usr/bin/env bash
set -e
export PATH="$HOME/.foundry/bin:$PATH"
if ! command -v foundryup >/dev/null; then
  curl -sSL https://foundry.paradigm.xyz -o /tmp/foundry-install.sh
  bash /tmp/foundry-install.sh 2>&1 | tail -n 3
fi
export PATH="$HOME/.foundry/bin:$PATH"
foundryup 2>&1 | tail -n 5
ls -la "$HOME/.foundry/bin"
"$HOME/.foundry/bin/forge" --version
"$HOME/.foundry/bin/cast" --version | head -1
