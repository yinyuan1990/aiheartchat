#!/usr/bin/env bash
# Re-run Slither and print the summary (used when contracts-check.sh's silent run is suspected stale).
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
export PYTHONNOUSERSITE=
cd /opt/arm/contracts
mkdir -p audit
rm -f audit/slither.json   # slither refuses to overwrite an existing --json target
slither . --filter-paths 'lib/|test/|script/|vendor/' --exclude-informational --exclude-optimization --json audit/slither.json > audit/slither.txt 2>&1
echo "exit=$?"
python3 - <<'PY'
import json, collections, os, time
p = 'audit/slither.json'
print('mtime', time.strftime('%H:%M:%S', time.gmtime(os.path.getmtime(p))))
try:
    d = json.load(open(p))['results']['detectors']
except Exception as e:
    print('parse error', e); raise SystemExit
print('slither:', dict(collections.Counter(x['impact'] for x in d)))
for x in d:
    if x['impact'] in ('High', 'Medium'):
        el = x['elements'][0]['source_mapping'] if x['elements'] else {}
        print(f"  [{x['impact']}] {x['check']} {el.get('filename_short','?')}:{(el.get('lines') or ['?'])[0]}")
PY
echo "---- last lines of slither.txt ----"
python3 -c "print(''.join(open('audit/slither.txt', errors='replace').readlines()[-8:]))"
