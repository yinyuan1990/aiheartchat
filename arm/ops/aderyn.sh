#!/usr/bin/env bash
set -e
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
cd /opt/arm/contracts
mkdir -p audit
if ! command -v aderyn >/dev/null; then
  curl -sL https://github.com/Cyfrin/aderyn/releases/download/aderyn-v0.6.8/aderyn-x86_64-unknown-linux-gnu.tar.xz -o /tmp/aderyn.tar.xz
  mkdir -p /tmp/aderyn && tar -xJf /tmp/aderyn.tar.xz -C /tmp/aderyn
  install -m 755 "$(find /tmp/aderyn -type f -name aderyn | head -1)" "$HOME/.local/bin/aderyn"
fi
aderyn --version
aderyn . -o audit/aderyn.md --skip-update-check 2>&1 | tail -n 5 || true
echo "---- summary ----"
grep -E '^# |^## |^### ' audit/aderyn.md | grep -vE 'Table of Contents|Summary|Files Summary|Files Details|Issue Summary|Contents' | head -n 60
echo "---- counts ----"
python3 - <<'PY'
import re
t = open('audit/aderyn.md', encoding='utf-8').read()
for sev in ['Critical', 'High', 'Medium', 'Low']:
    m = re.search(rf'\|\s*{sev}\s*\|\s*(\d+)\s*\|', t)
    if m: print(sev, m.group(1))
PY
