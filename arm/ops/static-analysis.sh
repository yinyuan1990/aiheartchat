#!/usr/bin/env bash
# Run Aderyn (Cyfrin) + Slither (Trail of Bits) over contracts/src on the server.
set -e
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$HOME/.cyfrin/bin:$PATH"
cd /opt/arm/contracts
mkdir -p audit

echo "== aderyn =="
if ! command -v aderyn >/dev/null; then
  curl -sL https://raw.githubusercontent.com/Cyfrin/aderyn/dev/cyfrinup/install | bash >/dev/null 2>&1 || true
  export PATH="$HOME/.cyfrin/bin:$PATH"
  command -v cyfrinup >/dev/null && cyfrinup >/dev/null 2>&1 || true
fi
if command -v aderyn >/dev/null; then
  aderyn --version
  aderyn . --src src/ -o audit/aderyn.md >/dev/null 2>&1 || aderyn --src src/ -o audit/aderyn.md >/dev/null 2>&1 || true
  [ -f audit/aderyn.md ] && grep -E '^## |^### |^# ' audit/aderyn.md | head -n 60 || echo "aderyn produced no report"
else
  echo "aderyn not installed"
fi

echo; echo "== slither =="
if ! command -v slither >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq python3-pip >/dev/null 2>&1 || true
  pip3 install -q --user slither-analyzer solc-select >/dev/null 2>&1 || pip3 install -q slither-analyzer solc-select >/dev/null 2>&1
fi
export PATH="$HOME/.local/bin:$PATH"
solc-select install 0.8.26 >/dev/null 2>&1 || true
solc-select use 0.8.26 >/dev/null 2>&1 || true
slither --version
# Only our code: exclude libs, tests, scripts, vendor bytecode.
slither . --filter-paths "lib/|test/|script/|vendor/" --exclude-informational --exclude-optimization \
  --json audit/slither.json > audit/slither.txt 2>&1 || true
echo "--- slither summary (high/medium/low) ---"
python3 - <<'PY'
import json, collections
try:
    d = json.load(open('audit/slither.json'))
except Exception as e:
    print("no json:", e); raise SystemExit
dets = d.get('results', {}).get('detectors', [])
by = collections.Counter((x['impact'], x['check']) for x in dets)
for (imp, chk), n in sorted(by.items(), key=lambda kv: (['High','Medium','Low','Informational','Optimization'].index(kv[0][0]) if kv[0][0] in ['High','Medium','Low','Informational','Optimization'] else 9, kv[0][1])):
    print(f"{imp:13} {chk:40} x{n}")
print(f"total findings: {len(dets)}")
print()
for x in dets:
    if x['impact'] in ('High', 'Medium'):
        first = x['elements'][0]['source_mapping'] if x['elements'] else {}
        print(f"[{x['impact']}] {x['check']}: {first.get('filename_short','?')}:{first.get('lines',[None])[0]}")
        print("   ", x['description'].strip().splitlines()[0][:220])
PY
