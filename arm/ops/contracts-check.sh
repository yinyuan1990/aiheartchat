#!/usr/bin/env bash
# Build + test + re-run Slither/Aderyn after contract changes.
set -e
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
cd /opt/arm/contracts
forge build 2>&1 | grep -E 'Error|error|Compiler run|finished' || true
forge test 2>&1 | tail -n 3
mkdir -p audit
rm -f audit/slither.json   # slither refuses to overwrite an existing --json target (stale report otherwise)
slither . --filter-paths 'lib/|test/|script/|vendor/' --exclude-informational --exclude-optimization --json audit/slither.json >/dev/null 2>&1 || true
python3 - <<'PY'
import json, collections
d = json.load(open('audit/slither.json'))['results']['detectors']
print('slither:', dict(collections.Counter(x['impact'] for x in d)))
for x in d:
    if x['impact'] in ('High','Medium'):
        el = x['elements'][0]['source_mapping'] if x['elements'] else {}
        print(f"  [{x['impact']}] {x['check']} {el.get('filename_short','?')}:{(el.get('lines') or ['?'])[0]}")
PY
aderyn . -o audit/aderyn.md --skip-update-check >/dev/null 2>&1 || true
python3 - <<'PY'
import re
t = open('audit/aderyn.md', encoding='utf-8').read()
print('aderyn:', {s: m.group(1) for s in ['Critical','High','Medium','Low'] for m in [re.search(rf'\|\s*{s}\s*\|\s*(\d+)\s*\|', t)] if m})
PY
